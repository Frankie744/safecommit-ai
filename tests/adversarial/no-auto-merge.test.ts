import { access, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE_ROOTS = ["apps", "packages", "scripts", ".github"] as const;
const ROOT_FILES = ["package.json"] as const;
const RISKY_MERGE_PATTERNS = [
  /\.pulls\.merge\s*\(/iu,
  /\bgh\s+pr\s+merge\b/iu,
  /pulls\/\{?pull_number\}?\/merge/iu,
  /\benablePullRequestAutoMerge\b/iu,
  /\bmergePullRequest\b/iu,
] as const;

async function sourceFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  try {
    await access(root);
  } catch {
    return files;
  }
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        [".next", "node_modules", "dist", "coverage"].includes(entry.name)
      ) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      if (
        entry.isFile() &&
        /\.(?:ts|tsx|js|mjs|cjs|json|ya?ml|ps1|sh)$/iu.test(entry.name)
      ) {
        files.push(path);
      }
    }
  }
  await visit(root);
  return files.sort();
}

describe("remote merge remains a human-only boundary", () => {
  it("contains no GitHub merge or auto-merge mutation in production source", async () => {
    const workspaceRoot = resolve(process.cwd());
    const files = (
      await Promise.all(
        SOURCE_ROOTS.map((directory) =>
          sourceFiles(join(workspaceRoot, directory)),
        ),
      )
    )
      .flat()
      .concat(ROOT_FILES.map((file) => join(workspaceRoot, file)));
    const violations: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const pattern of RISKY_MERGE_PATTERNS) {
        if (pattern.test(content)) {
          violations.push(`${relative(workspaceRoot, file)}:${pattern.source}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
