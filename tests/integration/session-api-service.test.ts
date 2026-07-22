import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  SessionService,
  SessionServiceError,
  type DecisionRequest,
} from "../../apps/web/server/session-service";
import type { SessionView } from "../../apps/web/lib/session-types";

describe("Phase 4 persisted local session API service", () => {
  let temporaryRoot: string;
  let storageDirectory: string;
  let service: SessionService;
  let created: SessionView;

  beforeAll(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "safeflash-session-api-"));
    storageDirectory = join(temporaryRoot, "sessions");
    service = new SessionService({
      workspaceRoot: resolve(process.cwd()),
      storageDirectory,
    });
    created = await service.create({
      incidentKind: "battery-sensor-disconnect",
      runKind: "tournament",
    });
  }, 120_000);

  afterAll(async () => {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  function boundDecision(
    decision: DecisionRequest["decision"] = "approved",
  ): DecisionRequest {
    return {
      decision,
      candidateId: created.selectedCandidateId!,
      evidenceDigest: created.currentEvidenceDigest!,
      patchDigest: created.currentPatchDigest!,
      commitSha: created.repository.commitSha,
      policyVersion: created.policy.version,
      reason: "Local operator reviewed the exact evidence binding.",
    };
  }

  it("creates from real local tournament evidence and recovers after service restart", async () => {
    expect(created).toMatchObject({
      mode: "mock",
      state: "AWAITING_HUMAN_APPROVAL",
      selectedCandidateId: "candidate-c-fail-closed",
    });
    expect(created.candidates).toHaveLength(3);
    expect(created.candidates.every((candidate) => candidate.sandbox.isolated)).toBe(true);
    expect(
      created.candidates.every(
        (candidate) =>
          candidate.sandbox.provenance.kind === "local-test" &&
          candidate.sandbox.provenance.verified === false,
      ),
    ).toBe(true);
    expect(created.pullRequest).toBeUndefined();

    const restarted = new SessionService({
      workspaceRoot: resolve(process.cwd()),
      storageDirectory,
    });
    expect(await restarted.get(created.id)).toEqual(created);
    expect((await restarted.list()).map((session) => session.id)).toContain(created.id);
  });

  it("rejects a decision whose evidence binding was tampered", async () => {
    const tampered = {
      ...boundDecision(),
      evidenceDigest: "0".repeat(64),
    };
    await expect(service.decide(created.id, tampered)).rejects.toMatchObject({
      status: 409,
      code: "STALE_OR_TAMPERED_DECISION",
    } satisfies Partial<SessionServiceError>);
    expect((await service.get(created.id)).approval).toBeUndefined();
  });

  it("requires approval before any PR and never invents provider success", async () => {
    const before = await service.get(created.id);
    expect(before.pullRequest).toBeUndefined();

    const approved = await service.decide(created.id, boundDecision());
    expect(approved.state).toBe("AWAITING_HUMAN_APPROVAL");
    expect(approved.approval).toMatchObject({
      decision: "approved",
      evidenceDigest: created.currentEvidenceDigest,
    });
    expect(approved.approval?.bindingDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(approved.pullRequest).toBeUndefined();
    expect(approved.events.at(-1)).toMatchObject({
      title: "APPROVAL RECORDED - EXTERNAL PUBLISH BLOCKED",
      provenance: { kind: "local-test", verified: false },
    });
    expect(JSON.stringify(approved)).not.toContain('"kind":"live"');
    expect(JSON.stringify(approved)).not.toContain("recorded-live");

    const restarted = new SessionService({
      workspaceRoot: resolve(process.cwd()),
      storageDirectory,
    });
    expect((await restarted.get(created.id)).approval).toEqual(approved.approval);
  });

  it("strictly rejects extra decision fields and unsafe path identifiers", async () => {
    await expect(
      service.decide(created.id, { ...boundDecision(), githubToken: "must-not-pass" }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_DECISION" });
    await expect(service.get("../../outside")).rejects.toMatchObject({
      status: 400,
      code: "INVALID_SESSION_ID",
    });
  });

  it("fails closed when a persisted snapshot no longer matches the event chain", async () => {
    const path = join(storageDirectory, `${created.id}.json`);
    const stored = JSON.parse(await readFile(path, "utf8")) as {
      view: { currentEvidenceDigest?: string };
    };
    stored.view.currentEvidenceDigest = "0".repeat(64);
    await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

    const restarted = new SessionService({
      workspaceRoot: resolve(process.cwd()),
      storageDirectory,
    });
    await expect(restarted.get(created.id)).rejects.toMatchObject({
      status: 500,
      code: "CORRUPT_SESSION",
    });
  });
});
