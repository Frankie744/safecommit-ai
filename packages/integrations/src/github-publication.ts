import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  canonicalJson,
  parseCandidatePatch,
  sha256,
  type CandidatePatch,
} from "@safeflash/domain";
import { validatePatchIntegrity } from "@safeflash/safety-policy";

import { ProviderResponseError } from "./provider";

const MAX_BASE_FILE_BYTES = 2 * 1024 * 1024;
const COMMIT_AUTHOR = Object.freeze({
  name: "SafeFlash Safety Bot",
  email: "safeflash-safety-bot@users.noreply.github.com",
});

export interface GitHubRecursiveTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

export interface GitHubRecursiveTree {
  sha: string;
  truncated: boolean;
  entries: readonly GitHubRecursiveTreeEntry[];
}

export interface GitHubBlobData {
  sha: string;
  contentBase64: string;
}

export interface PrepareCandidatePublicationRequest {
  sessionId: string;
  candidate: CandidatePatch;
  baseCommitSha: string;
  targetBaseCommitSha: string;
  expectedTreeSha: string;
  /** Server-owned session time; normalized to whole UTC seconds. */
  committedAt: string;
}

export interface PreparedCandidateFile {
  path: string;
  mode: "100644";
  blobSha: string;
  contentBase64: string;
}

export interface PreparedCandidatePublication {
  schemaVersion: 1;
  sessionId: string;
  candidateId: string;
  owner: string;
  repository: string;
  baseBranch: string;
  baseCommitSha: string;
  targetBaseCommitSha: string;
  baseTreeSha: string;
  headBranch: string;
  patchDigest: string;
  unifiedDiff: string;
  treeSha: string;
  commitSha: string;
  commitMessage: string;
  committedAt: string;
  author: typeof COMMIT_AUTHOR;
  changedFiles: readonly PreparedCandidateFile[];
  publicationDigest: string;
}

export interface PrepareCandidatePublicationDataInput {
  request: PrepareCandidatePublicationRequest;
  target: {
    owner: string;
    repository: string;
    baseBranch: string;
  };
  baseTreeSha: string;
  baseTree: GitHubRecursiveTree;
  blobsByPath: Readonly<Record<string, GitHubBlobData>>;
}

interface DiffLine {
  kind: "context" | "remove" | "add";
  content: string;
  hasNewline: boolean;
}

interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

interface DiffFile {
  path: string;
  isNew: boolean;
  hunks: DiffHunk[];
}

interface FileLine {
  content: string;
  hasNewline: boolean;
}

interface TreeLeaf {
  kind: "leaf";
  mode: string;
  type: "blob" | "commit";
  sha: string;
}

interface TreeDirectory {
  kind: "tree";
  children: Map<string, TreeNode>;
  declaredSha?: string;
}

type TreeNode = TreeLeaf | TreeDirectory;

function publicationError(message: string): never {
  throw new ProviderResponseError("github", message, false);
}

function requireGitObjectId(label: string, value: string): void {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value)) {
    publicationError(`${label} must be a lowercase full Git object ID`);
  }
}

function requireSafeId(label: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(value)) {
    publicationError(`${label} is not a safe stable identifier`);
  }
}

function parseHunkHeader(line: string): Omit<DiffHunk, "lines"> {
  const match =
    /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u.exec(line);
  if (match === null) publicationError("Candidate patch contains a malformed hunk header");
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function parseUnifiedDiff(unifiedDiff: string): DiffFile[] {
  if (unifiedDiff.includes("\r")) {
    publicationError("Candidate publication requires canonical LF-only unified diff text");
  }
  const integrity = validatePatchIntegrity(unifiedDiff);
  if (!integrity.valid) {
    publicationError(
      `Candidate publication failed patch integrity: ${integrity.violations
        .map((violation) => violation.code)
        .join(", ")}`,
    );
  }
  const lines = unifiedDiff.split("\n");
  const files: DiffFile[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line === "" && index === lines.length - 1) break;
    const header = /^diff --git a\/([^\s]+) b\/([^\s]+)$/u.exec(line);
    if (header === null || header[1] !== header[2]) {
      publicationError("Candidate patch must contain only same-path Git file diffs");
    }
    const path = header[1]!;
    index += 1;
    let newFileMode: string | undefined;
    while (index < lines.length && !lines[index]!.startsWith("--- ")) {
      const metadata = lines[index]!;
      if (metadata.startsWith("new file mode ")) {
        newFileMode = metadata.slice("new file mode ".length);
      } else if (
        metadata !== "" &&
        !/^index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]{6})?$/iu.test(metadata)
      ) {
        publicationError(`Unsupported Git patch metadata for ${path}`);
      }
      index += 1;
    }
    const oldHeader = lines[index];
    const newHeader = lines[index + 1];
    if (oldHeader === undefined || newHeader === undefined) {
      publicationError(`Candidate patch is missing file headers for ${path}`);
    }
    const oldPath = oldHeader.slice(4);
    const newPath = newHeader.slice(4);
    const isNew = oldPath === "/dev/null";
    if (
      !oldHeader.startsWith("--- ") ||
      !newHeader.startsWith("+++ ") ||
      (!isNew && oldPath !== `a/${path}`) ||
      newPath !== `b/${path}` ||
      (isNew && newFileMode !== "100644") ||
      (!isNew && newFileMode !== undefined)
    ) {
      publicationError(`Candidate patch file headers or mode are unsafe for ${path}`);
    }
    index += 2;
    const hunks: DiffHunk[] = [];
    while (index < lines.length && !lines[index]!.startsWith("diff --git ")) {
      if (lines[index] === "" && index === lines.length - 1) {
        index += 1;
        break;
      }
      const hunkHeader = parseHunkHeader(lines[index]!);
      index += 1;
      const hunkLines: DiffLine[] = [];
      while (
        index < lines.length &&
        !lines[index]!.startsWith("@@ ") &&
        !lines[index]!.startsWith("diff --git ")
      ) {
        const patchLine = lines[index]!;
        if (patchLine === "\\ No newline at end of file") {
          const previous = hunkLines.at(-1);
          if (previous === undefined || !previous.hasNewline) {
            publicationError(`Misplaced no-newline marker in ${path}`);
          }
          previous.hasNewline = false;
          index += 1;
          continue;
        }
        if (patchLine === "" && index === lines.length - 1) break;
        const prefix = patchLine[0];
        const kind =
          prefix === " "
            ? "context"
            : prefix === "-"
              ? "remove"
              : prefix === "+"
                ? "add"
                : undefined;
        if (kind === undefined) break;
        hunkLines.push({ kind, content: patchLine.slice(1), hasNewline: true });
        index += 1;
      }
      const oldCount = hunkLines.filter((item) => item.kind !== "add").length;
      const newCount = hunkLines.filter((item) => item.kind !== "remove").length;
      if (oldCount !== hunkHeader.oldCount || newCount !== hunkHeader.newCount) {
        publicationError(`Candidate patch hunk counts do not match for ${path}`);
      }
      hunks.push({ ...hunkHeader, lines: hunkLines });
    }
    if (hunks.length === 0) publicationError(`Candidate patch has no hunks for ${path}`);
    files.push({ path, isNew, hunks });
  }
  if (files.length === 0 || new Set(files.map((file) => file.path)).size !== files.length) {
    publicationError("Candidate patch must change each non-empty file path exactly once");
  }
  return files;
}

function splitFile(content: string): FileLine[] {
  if (content === "") return [];
  const pieces = content.split("\n");
  const trailingNewline = pieces.at(-1) === "";
  if (trailingNewline) pieces.pop();
  return pieces.map((line, index) => ({
    content: line,
    hasNewline: trailingNewline || index < pieces.length - 1,
  }));
}

function joinFile(lines: readonly FileLine[]): string {
  if (lines.slice(0, -1).some((line) => !line.hasNewline)) {
    publicationError("Candidate patch produced an interior line without a newline");
  }
  return lines.map((line) => `${line.content}${line.hasNewline ? "\n" : ""}`).join("");
}

function applyFilePatch(baseContent: string, file: DiffFile): string {
  const output = splitFile(baseContent);
  let lineDelta = 0;
  for (const hunk of file.hunks) {
    const start = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1 + lineDelta;
    const expectedNewStart = hunk.newStart === 0 ? 0 : hunk.newStart - 1;
    if (start < 0 || start > output.length || expectedNewStart !== start) {
      publicationError(`Candidate patch hunk position does not match ${file.path}`);
    }
    let cursor = start;
    const replacement: FileLine[] = [];
    for (const line of hunk.lines) {
      if (line.kind === "add") {
        replacement.push({ content: line.content, hasNewline: line.hasNewline });
        continue;
      }
      const existing = output[cursor];
      if (
        existing === undefined ||
        existing.content !== line.content ||
        existing.hasNewline !== line.hasNewline
      ) {
        publicationError(`Candidate patch context does not match immutable base file ${file.path}`);
      }
      if (line.kind === "context") replacement.push(existing);
      cursor += 1;
    }
    output.splice(start, cursor - start, ...replacement);
    lineDelta += hunk.newCount - hunk.oldCount;
  }
  return joinFile(output);
}

function objectAlgorithm(objectId: string): "sha1" | "sha256" {
  requireGitObjectId("Git object", objectId);
  return objectId.length === 40 ? "sha1" : "sha256";
}

function gitObjectId(
  type: "blob" | "tree" | "commit",
  content: Uint8Array,
  algorithm: "sha1" | "sha256",
): string {
  const body = Buffer.from(content);
  return createHash(algorithm)
    .update(Buffer.from(`${type} ${body.byteLength}\0`, "utf8"))
    .update(body)
    .digest("hex");
}

/** @internal Decodes only bytes whose Git blob ID matches the immutable tree. */
export function decodeVerifiedGitHubBlob(
  blob: GitHubBlobData,
  expectedSha: string,
  maxBytes = MAX_BASE_FILE_BYTES,
): Buffer {
  if (blob.sha !== expectedSha) {
    publicationError("GitHub blob response does not match its immutable tree entry");
  }
  const compactBase64 = blob.contentBase64.replace(/[\r\n]/gu, "");
  let bytes: Buffer;
  try {
    bytes = Buffer.from(compactBase64, "base64");
    if (bytes.toString("base64") !== compactBase64) throw new Error();
  } catch {
    publicationError("GitHub blob response is not canonical base64");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || bytes.byteLength > maxBytes) {
    publicationError("GitHub blob response exceeds the server-owned size limit");
  }
  if (gitObjectId("blob", bytes, objectAlgorithm(expectedSha)) !== expectedSha) {
    publicationError("GitHub blob bytes do not reproduce their immutable object ID");
  }
  return bytes;
}

function pathSegments(path: string): string[] {
  if (
    path.startsWith("/") ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    publicationError("Git tree returned an unsafe path");
  }
  return path.split("/");
}

function buildTree(entries: readonly GitHubRecursiveTreeEntry[]): TreeDirectory {
  const root: TreeDirectory = { kind: "tree", children: new Map() };
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path, "en"))) {
    requireGitObjectId("Git tree entry", entry.sha);
    const segments = pathSegments(entry.path);
    let directory = root;
    for (const segment of segments.slice(0, -1)) {
      const existing = directory.children.get(segment);
      if (existing?.kind === "leaf") publicationError("Git tree path collides with a file");
      if (existing === undefined) {
        const child: TreeDirectory = { kind: "tree", children: new Map() };
        directory.children.set(segment, child);
        directory = child;
      } else {
        directory = existing;
      }
    }
    const name = segments.at(-1)!;
    const existing = directory.children.get(name);
    if (entry.type === "tree") {
      if (entry.mode !== "040000" && entry.mode !== "40000") {
        publicationError("Git tree directory has an invalid mode");
      }
      if (existing?.kind === "leaf") publicationError("Git tree directory collides with a file");
      const tree = existing ?? { kind: "tree" as const, children: new Map<string, TreeNode>() };
      tree.declaredSha = entry.sha;
      directory.children.set(name, tree);
    } else {
      if (existing !== undefined) publicationError("Git tree contains a duplicate path");
      if (
        (entry.type === "blob" &&
          !["100644", "100755", "120000"].includes(entry.mode)) ||
        (entry.type === "commit" && entry.mode !== "160000")
      ) {
        publicationError("Git tree leaf type and mode are inconsistent");
      }
      directory.children.set(name, {
        kind: "leaf",
        mode: entry.mode,
        type: entry.type,
        sha: entry.sha,
      });
    }
  }
  return root;
}

function compareTreeNames(
  left: readonly [string, TreeNode],
  right: readonly [string, TreeNode],
): number {
  const leftName = Buffer.from(`${left[0]}${left[1].kind === "tree" ? "/" : ""}`, "utf8");
  const rightName = Buffer.from(`${right[0]}${right[1].kind === "tree" ? "/" : ""}`, "utf8");
  return Buffer.compare(leftName, rightName);
}

function computeTreeSha(
  directory: TreeDirectory,
  algorithm: "sha1" | "sha256",
  verifyDeclared: boolean,
): string {
  const chunks: Buffer[] = [];
  for (const [name, node] of [...directory.children.entries()].sort(compareTreeNames)) {
    const sha =
      node.kind === "tree"
        ? computeTreeSha(node, algorithm, verifyDeclared)
        : node.sha;
    if (node.kind === "leaf" && objectAlgorithm(node.sha) !== algorithm) {
      publicationError("Git tree mixes object hash algorithms");
    }
    const mode = node.kind === "tree" ? "40000" : node.mode.replace(/^0+/u, "");
    chunks.push(
      Buffer.from(`${mode} ${name}\0`, "utf8"),
      Buffer.from(sha, "hex"),
    );
  }
  const sha = gitObjectId("tree", Buffer.concat(chunks), algorithm);
  if (verifyDeclared && directory.declaredSha !== undefined && directory.declaredSha !== sha) {
    publicationError("GitHub recursive tree entries do not reproduce their declared tree SHA");
  }
  return sha;
}

function setChangedBlob(
  root: TreeDirectory,
  path: string,
  file: PreparedCandidateFile,
  isNew: boolean,
): void {
  const segments = pathSegments(path);
  let directory = root;
  for (const segment of segments.slice(0, -1)) {
    const node = directory.children.get(segment);
    if (node === undefined) {
      if (!isNew) publicationError(`Git tree omitted patched directory for ${path}`);
      const created: TreeDirectory = { kind: "tree", children: new Map() };
      directory.children.set(segment, created);
      directory = created;
    } else if (node.kind === "leaf") {
      publicationError(`Patched path collides with a Git file: ${path}`);
    } else {
      directory = node;
    }
  }
  const name = segments.at(-1)!;
  const existing = directory.children.get(name);
  if (isNew ? existing !== undefined : existing?.kind !== "leaf" || existing.type !== "blob") {
    publicationError(`Patched path new/existing status does not match Git tree: ${path}`);
  }
  directory.children.set(name, {
    kind: "leaf",
    mode: file.mode,
    type: "blob",
    sha: file.blobSha,
  });
}

function canonicalCommitTime(value: string): { iso: string; seconds: number } {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) publicationError("Commit time must be a valid ISO timestamp");
  const seconds = Math.floor(milliseconds / 1_000);
  const iso = new Date(seconds * 1_000).toISOString().replace(".000Z", "Z");
  return { iso, seconds };
}

function computeCommitSha(input: {
  treeSha: string;
  parentSha: string;
  message: string;
  committedAtSeconds: number;
}): string {
  const algorithm = objectAlgorithm(input.treeSha);
  if (objectAlgorithm(input.parentSha) !== algorithm) {
    publicationError("Git commit parent and tree use different hash algorithms");
  }
  const identity = `${COMMIT_AUTHOR.name} <${COMMIT_AUTHOR.email}> ${input.committedAtSeconds} +0000`;
  const body = Buffer.from(
    `tree ${input.treeSha}\nparent ${input.parentSha}\nauthor ${identity}\ncommitter ${identity}\n\n${input.message}`,
    "utf8",
  );
  return gitObjectId("commit", body, algorithm);
}

function publicationPayload(
  publication: Omit<PreparedCandidatePublication, "publicationDigest">,
): Omit<PreparedCandidatePublication, "publicationDigest"> {
  return publication;
}

export function computeCandidatePublicationDigest(
  publication: Omit<PreparedCandidatePublication, "publicationDigest">,
): string {
  return sha256(canonicalJson(publication));
}

/** @internal Used to scope read-only blob fetches before pure preparation. */
export function candidatePublicationChangedPaths(candidateInput: CandidatePatch): readonly string[] {
  const candidate = parseCandidatePatch(candidateInput);
  return Object.freeze(
    parseUnifiedDiff(candidate.unifiedDiff)
      .map((file) => file.path)
      .sort((left, right) => left.localeCompare(right, "en")),
  );
}

export function prepareCandidatePublicationData(
  input: PrepareCandidatePublicationDataInput,
): PreparedCandidatePublication {
  const candidate = parseCandidatePatch(input.request.candidate);
  requireSafeId("sessionId", input.request.sessionId);
  requireGitObjectId("baseCommitSha", input.request.baseCommitSha);
  requireGitObjectId("targetBaseCommitSha", input.request.targetBaseCommitSha);
  requireGitObjectId("expectedTreeSha", input.request.expectedTreeSha);
  requireGitObjectId("baseTreeSha", input.baseTreeSha);
  if (
    input.baseTree.sha !== input.baseTreeSha ||
    input.baseTree.truncated ||
    objectAlgorithm(input.request.baseCommitSha) !== objectAlgorithm(input.baseTreeSha)
  ) {
    publicationError("GitHub base tree is truncated or does not match the immutable base commit");
  }
  const diffFiles = parseUnifiedDiff(candidate.unifiedDiff);
  const algorithm = objectAlgorithm(input.baseTreeSha);
  const root = buildTree(input.baseTree.entries);
  const computedBaseTreeSha = computeTreeSha(root, algorithm, true);
  if (computedBaseTreeSha !== input.baseTreeSha) {
    publicationError("GitHub recursive tree does not reproduce the immutable base tree");
  }

  const entriesByPath = new Map(
    input.baseTree.entries.map((entry) => [entry.path, entry] as const),
  );
  const changedFiles: PreparedCandidateFile[] = [];
  for (const file of diffFiles) {
    const baseEntry = entriesByPath.get(file.path);
    let baseContent = "";
    const mode = "100644" as const;
    if (file.isNew) {
      if (baseEntry !== undefined || input.blobsByPath[file.path] !== undefined) {
        publicationError(`New candidate path already exists in base tree: ${file.path}`);
      }
    } else {
      if (
        baseEntry === undefined ||
        baseEntry.type !== "blob" ||
        baseEntry.mode !== "100644"
      ) {
        publicationError(`Candidate path is not a regular base-tree file: ${file.path}`);
      }
      const blob = input.blobsByPath[file.path];
      if (blob === undefined || blob.sha !== baseEntry.sha) {
        publicationError(`GitHub blob does not match the base tree for ${file.path}`);
      }
      const bytes = decodeVerifiedGitHubBlob(
        blob,
        baseEntry.sha,
        MAX_BASE_FILE_BYTES,
      );
      try {
        baseContent = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        publicationError(`Candidate path is not valid UTF-8 text: ${file.path}`);
      }
    }
    const content = applyFilePatch(baseContent, file);
    const bytes = Buffer.from(content, "utf8");
    const preparedFile: PreparedCandidateFile = {
      path: file.path,
      mode,
      blobSha: gitObjectId("blob", bytes, algorithm),
      contentBase64: bytes.toString("base64"),
    };
    setChangedBlob(root, file.path, preparedFile, file.isNew);
    changedFiles.push(preparedFile);
  }
  changedFiles.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const treeSha = computeTreeSha(root, algorithm, false);
  if (treeSha !== input.request.expectedTreeSha) {
    publicationError(
      "Server-applied Git tree does not match the exact Daytona-validated tree",
    );
  }
  const committedAt = canonicalCommitTime(input.request.committedAt);
  const commitMessage = `SafeFlash: publish ${candidate.candidateId} for ${input.request.sessionId}\n`;
  const commitSha = computeCommitSha({
    treeSha,
    parentSha: input.request.baseCommitSha,
    message: commitMessage,
    committedAtSeconds: committedAt.seconds,
  });
  const payload = publicationPayload({
    schemaVersion: 1,
    sessionId: input.request.sessionId,
    candidateId: candidate.candidateId,
    owner: input.target.owner,
    repository: input.target.repository,
    baseBranch: input.target.baseBranch,
    baseCommitSha: input.request.baseCommitSha,
    targetBaseCommitSha: input.request.targetBaseCommitSha,
    baseTreeSha: input.baseTreeSha,
    headBranch: `safeflash/${input.request.sessionId}`,
    patchDigest: sha256(candidate.unifiedDiff),
    unifiedDiff: candidate.unifiedDiff,
    treeSha,
    commitSha,
    commitMessage,
    committedAt: committedAt.iso,
    author: COMMIT_AUTHOR,
    changedFiles,
  });
  return Object.freeze({
    ...payload,
    author: Object.freeze({ ...payload.author }),
    changedFiles: Object.freeze(
      payload.changedFiles.map((file) => Object.freeze({ ...file })),
    ),
    publicationDigest: computeCandidatePublicationDigest(payload),
  });
}

export function assertPreparedCandidatePublication(
  publication: PreparedCandidatePublication,
): void {
  const { publicationDigest, ...payload } = publication;
  const diffPaths = candidatePublicationChangedPaths({
    candidateId: publication.candidateId,
    strategy: "fail-closed",
    hypothesis: "Server verification placeholder.",
    unifiedDiff: publication.unifiedDiff,
    expectedSafetyEffect: ["Server verification placeholder."],
    risks: ["Server verification placeholder."],
    testsToRun: ["server-verification"],
  });
  requireGitObjectId("publication.baseCommitSha", publication.baseCommitSha);
  requireGitObjectId(
    "publication.targetBaseCommitSha",
    publication.targetBaseCommitSha,
  );
  requireGitObjectId("publication.baseTreeSha", publication.baseTreeSha);
  requireGitObjectId("publication.treeSha", publication.treeSha);
  requireGitObjectId("publication.commitSha", publication.commitSha);
  if (
    publication.schemaVersion !== 1 ||
    publication.headBranch !== `safeflash/${publication.sessionId}` ||
    sha256(publication.unifiedDiff) !== publication.patchDigest ||
    computeCandidatePublicationDigest(payload) !== publicationDigest ||
    publication.author.name !== COMMIT_AUTHOR.name ||
    publication.author.email !== COMMIT_AUTHOR.email ||
    publication.commitMessage !==
      `SafeFlash: publish ${publication.candidateId} for ${publication.sessionId}\n` ||
    publication.changedFiles.length === 0 ||
    new Set(publication.changedFiles.map((file) => file.path)).size !==
      publication.changedFiles.length ||
    canonicalJson(publication.changedFiles.map((file) => file.path)) !==
      canonicalJson(diffPaths)
  ) {
    publicationError("Prepared candidate publication failed its immutable digest binding");
  }
  const algorithm = objectAlgorithm(publication.treeSha);
  for (const file of publication.changedFiles) {
    const bytes = Buffer.from(file.contentBase64, "base64");
    if (
      file.mode !== "100644" ||
      bytes.byteLength > MAX_BASE_FILE_BYTES ||
      bytes.toString("base64") !== file.contentBase64 ||
      gitObjectId("blob", bytes, algorithm) !== file.blobSha
    ) {
      publicationError(`Prepared candidate blob failed binding: ${file.path}`);
    }
  }
  const committedAt = canonicalCommitTime(publication.committedAt);
  if (
    committedAt.iso !== publication.committedAt ||
    computeCommitSha({
      treeSha: publication.treeSha,
      parentSha: publication.baseCommitSha,
      message: publication.commitMessage,
      committedAtSeconds: committedAt.seconds,
    }) !== publication.commitSha
  ) {
    publicationError("Prepared candidate commit does not reproduce its expected object ID");
  }
}
