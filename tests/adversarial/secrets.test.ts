import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { redactSecrets } from "@safeflash/integrations";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const SERVER_SECRET_NAMES = [
  "DAYTONA_API_KEY",
  "BRAINTRUST_API_KEY",
  "FIREWORKS_API_KEY",
  "GITHUB_TOKEN",
] as const;

const SOURCE_SCAN_EXCLUSIONS = new Set([
  ".next",
  "node_modules",
  "report",
  "results",
]);

function filesBelow(
  directory: string,
  excludedDirectoryNames: ReadonlySet<string> = SOURCE_SCAN_EXCLUSIONS,
): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !excludedDirectoryNames.has(entry.name)) {
      files.push(...filesBelow(path, excludedDirectoryNames));
    }
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function textFiles(paths: readonly string[]): string {
  return paths
    .filter((path) => !/\.(?:png|jpg|jpeg|gif|woff2?|ico)$/iu.test(path))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}

describe("secret boundary", () => {
  it("secrets_are_not_exposed_to_frontend_or_git", () => {
    const sentinel = ["SAFEFLASH", "SENTINEL", "DO_NOT_EXPOSE", "7f52c86a"].join(
      "_",
    );
    const environment = {
      FIREWORKS_API_KEY: sentinel,
      GITHUB_TOKEN: "github" + "_pat_SENTINEL_2b81e1c9",
    };
    const redacted = redactSecrets(
      `Authorization: Bearer ${sentinel}; token=${environment.GITHUB_TOKEN}`,
      environment,
    );
    expect(redacted).not.toContain(sentinel);
    expect(redacted).not.toContain(environment.GITHUB_TOKEN);
    expect(redacted).toContain("[REDACTED]");

    const clientSource = textFiles(filesBelow(join(REPOSITORY_ROOT, "apps/web")));
    for (const secretName of SERVER_SECRET_NAMES) {
      expect(clientSource).not.toMatch(
        new RegExp(`process\\.env(?:\\.${secretName}|\\[.{0,8}${secretName})`, "u"),
      );
    }
    expect(clientSource).not.toContain(sentinel);

    const publicBundle = textFiles(
      filesBelow(join(REPOSITORY_ROOT, "apps/web/.next/static"), new Set()),
    );
    expect(publicBundle).not.toContain(sentinel);
    for (const secretName of SERVER_SECRET_NAMES) {
      expect(publicBundle).not.toContain(secretName);
    }

    const tracked = execFileSync("git", ["ls-files", "-z"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean)
      .map((path) => join(REPOSITORY_ROOT, path));
    const trackedText = textFiles(tracked);
    expect(trackedText).not.toContain(sentinel);
    expect(trackedText).not.toContain(environment.GITHUB_TOKEN);

    const envExample = readFileSync(
      join(REPOSITORY_ROOT, ".env.example"),
      "utf8",
    );
    for (const secretName of SERVER_SECRET_NAMES) {
      expect(envExample).toMatch(new RegExp(`^${secretName}=\\s*$`, "mu"));
    }
    const ignore = readFileSync(join(REPOSITORY_ROOT, ".gitignore"), "utf8");
    expect(ignore).toMatch(/^\.env\.\*$/mu);
    expect(ignore).toMatch(/^!\.env\.example$/mu);

    // Give failures a useful path without including file contents or secrets.
    expect(relative(REPOSITORY_ROOT, join(REPOSITORY_ROOT, "apps/web"))).toBe(
      "apps\\web".replace("\\", process.platform === "win32" ? "\\" : "/"),
    );
  });
});
