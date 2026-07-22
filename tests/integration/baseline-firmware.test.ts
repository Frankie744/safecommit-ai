import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { buildLocalChildEnvironment } from "../../apps/orchestrator/src/index";

const execFile = promisify(execFileCallback);
const workspaceRoot = resolve(process.cwd());
const allowedBuildRoot = resolve(workspaceRoot, "artifacts", "build", "phase-1");

interface BaselineSummary {
  result: string;
  buildDirectory: string;
  build: { exitCode: number; passed: boolean };
  unitTests: { exitCode: number; passed: boolean };
  safetyTests: {
    exitCode: number;
    passed: boolean;
    expectedFailureObserved: boolean;
    expectedFailingTests: readonly string[];
    log: string;
  };
}

function isPathInside(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return (
    candidate.length > 0 &&
    candidate !== ".." &&
    !candidate.startsWith(`..${sep}`) &&
    !isAbsolute(candidate)
  );
}

it(
  "baseline_builds_but_fails_sensor_disconnect_safety_test",
  async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "safeflash-baseline-"));
    let buildDirectory: string | undefined;

    try {
      const scriptPath = resolve(workspaceRoot, "scripts", "test-firmware.ps1");
      const { stdout } = await execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
          "-EvidenceRoot",
          evidenceRoot,
        ],
        {
          cwd: workspaceRoot,
          env: buildLocalChildEnvironment(),
          maxBuffer: 10 * 1024 * 1024,
          timeout: 120_000,
          windowsHide: true,
        },
      );

      expect(stdout).toContain("PHASE1_RESULT=PASS");
      expect(stdout).toContain("SAFETY_EXIT=8 (EXPECTED_NONZERO)");

      const runId = (await readFile(join(evidenceRoot, "latest-run.txt"), "utf8")).trim();
      expect(runId).toMatch(/^\d{8}T\d{9}Z$/u);

      const runDirectory = join(evidenceRoot, runId);
      const summary = JSON.parse(
        await readFile(join(runDirectory, "summary.json"), "utf8"),
      ) as BaselineSummary;
      buildDirectory = resolve(summary.buildDirectory);

      expect(summary).toMatchObject({
        result: "EXPECTED_UNSAFE_BASELINE_CONFIRMED",
        build: { exitCode: 0, passed: true },
        unitTests: { exitCode: 0, passed: true },
        safetyTests: {
          exitCode: 8,
          passed: false,
          expectedFailureObserved: true,
        },
      });
      expect(summary.safetyTests.expectedFailingTests).toContain(
        "sensor_disconnect_enters_safe_state",
      );

      const safetyLog = await readFile(
        join(runDirectory, summary.safetyTests.log),
        "utf8",
      );
      expect(safetyLog).toContain("[FAIL] sensor_disconnect_enters_safe_state");
      expect(safetyLog).toContain("[SUMMARY] 3 passed, 3 failed");
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
      if (buildDirectory && isPathInside(allowedBuildRoot, buildDirectory)) {
        await rm(buildDirectory, { recursive: true, force: true });
      }
    }
  },
  150_000,
);
