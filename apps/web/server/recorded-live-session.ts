import { createHash } from "node:crypto";

import { computeEvidenceDigest } from "@safeflash/domain";

import type {
  DatabaseCandidateView,
  DatabaseRowDeltaView,
  DatabaseSessionView,
} from "../lib/database-session-types";
import {
  approvalArtifactBody,
  approvalArtifactManifest,
  approvalRunId,
  liveArtifactBody,
  liveArtifactManifest,
  liveRunId,
} from "./embedded-recorded-live-evidence.generated";

interface JsonRecord {
  readonly [key: string]: unknown;
}

interface RecordedArtifacts {
  readonly live: JsonRecord;
  readonly approval: JsonRecord;
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Recorded Live evidence is missing ${label}`);
  }
  return value as JsonRecord;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Recorded Live evidence is missing ${label}`);
  }
  return value;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Recorded Live evidence is missing ${label}`);
  }
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Recorded Live evidence is missing ${label}`);
  }
  return value;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Recorded Live evidence is missing ${label}`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function verifiedJson(
  runId: string,
  body: string,
  manifest: string,
  runPrefix: string,
  artifactName: string,
): Promise<{ runId: string; digest: string; value: JsonRecord }> {
  if (!new RegExp(`^${runPrefix}[A-Za-z0-9-]+$`, "u").test(runId)) {
    throw new Error("Recorded Live latest-run pointer is unsafe");
  }
  const digest = sha256(body);
  if (manifest.trim() !== `${digest}  ${artifactName}`) {
    throw new Error(`Recorded Live manifest rejected ${artifactName}`);
  }
  return {
    runId,
    digest,
    value: record(JSON.parse(body) as unknown, artifactName),
  };
}

async function loadArtifacts(): Promise<RecordedArtifacts> {
  const [liveArtifact, approvalArtifact] = await Promise.all([
    verifiedJson(
      liveRunId,
      liveArtifactBody,
      liveArtifactManifest,
      "safecommit-live-",
      "database-live-evidence.json",
    ),
    verifiedJson(
      approvalRunId,
      approvalArtifactBody,
      approvalArtifactManifest,
      "safecommit-approval-",
      "database-approval.json",
    ),
  ]);
  const sourceEvidence = record(
    approvalArtifact.value.sourceEvidence,
    "approval.sourceEvidence",
  );
  if (
    text(sourceEvidence.liveRunId, "approval.sourceEvidence.liveRunId") !==
      liveArtifact.runId ||
    text(
      sourceEvidence.artifactSha256,
      "approval.sourceEvidence.artifactSha256",
    ) !== liveArtifact.digest
  ) {
    throw new Error("Recorded Live approval is not bound to the latest evidence");
  }
  return {
    live: liveArtifact.value,
    approval: approvalArtifact.value,
  };
}

function humanRowDelta(value: unknown): DatabaseRowDeltaView {
  const delta = record(value, "candidate.evidence.rowDelta");
  const primaryKey = record(delta.primaryKey, "rowDelta.primaryKey");
  const before = record(delta.before, "rowDelta.before");
  const after = record(delta.after, "rowDelta.after");
  const table = text(delta.table, "rowDelta.table");
  const id = text(primaryKey.id, "rowDelta.primaryKey.id");
  let summary = "Business row changed and rollback was verified";
  if (
    table === "product" &&
    before.canonical_product_id !== after.canonical_product_id
  ) {
    summary = `Duplicate SKU linked to ${String(after.canonical_product_id)}`;
  } else if (
    table === "allocation" &&
    before.released_at !== after.released_at
  ) {
    summary = `Cancelled allocation released; quantity remained ${String(
      after.quantity,
    )}`;
  } else if (table === "order_header" && before.status !== after.status) {
    summary = `Order status changed ${String(before.status)} → ${String(
      after.status,
    )}`;
  }
  const changeKind = text(delta.changeKind, "rowDelta.changeKind");
  if (
    changeKind !== "inserted" &&
    changeKind !== "updated" &&
    changeKind !== "deleted"
  ) {
    throw new Error("Recorded Live row delta has an unsupported change kind");
  }
  return { table, id, changeKind, summary };
}

function candidateView(value: unknown): DatabaseCandidateView {
  const candidate = record(value, "candidate");
  const plan = record(candidate.plan, "candidate.plan");
  const evidence = record(candidate.evidence, "candidate.evidence");
  const gates = record(candidate.gates, "candidate.gates");
  const strategy = text(plan.strategy, "candidate.plan.strategy");
  if (
    strategy !== "conservative" &&
    strategy !== "relationship-preserving" &&
    strategy !== "aggressive-cleanup"
  ) {
    throw new Error("Recorded Live candidate has an unsupported strategy");
  }
  const gateResults = array(gates.results, "candidate.gates.results").map(
    (value) => {
      const gate = record(value, "candidate.gates.result");
      return {
        name: text(gate.name, "gate.name"),
        passed: bool(gate.passed, "gate.passed"),
        explanation: text(gate.explanation, "gate.explanation"),
      };
    },
  );
  const rowDelta = array(evidence.rowDelta, "candidate.evidence.rowDelta").map(
    humanRowDelta,
  );
  const warehouses = new Set<string>();
  for (const value of array(evidence.rowDelta, "candidate.evidence.rowDelta")) {
    const delta = record(value, "candidate.evidence.rowDelta");
    for (const side of ["before", "after"] as const) {
      const warehouse = record(delta[side], `rowDelta.${side}`).warehouse_id;
      if (typeof warehouse === "string") warehouses.add(warehouse);
    }
  }
  const affectedRows = array(
    evidence.statementResults,
    "candidate.evidence.statementResults",
  ).reduce<number>((total, value) => {
    const result = record(value, "candidate.evidence.statementResult");
    return total + numberValue(result.affectedRows, "statement.affectedRows");
  }, 0);
  const inventoryGate = gateResults.find(
    (gate) => gate.name === "InventoryConservation",
  );
  const failedGateNames = array(
    gates.failedGateNames,
    "candidate.gates.failedGateNames",
  ).map((value) => text(value, "failedGateName"));
  return {
    candidateId: text(plan.candidateId, "candidate.plan.candidateId"),
    strategy,
    hypothesis: text(plan.hypothesis, "candidate.plan.hypothesis"),
    eligible: bool(gates.eligible, "candidate.gates.eligible"),
    weightedScore: numberValue(
      candidate.weightedScore,
      "candidate.weightedScore",
    ),
    failedGateNames,
    affectedRows,
    touchedWarehouses: [...warehouses],
    inventoryDeltaUnits: inventoryGate?.passed === false ? -1 : 0,
    planDigest: text(evidence.planDigest, "candidate.evidence.planDigest"),
    evidenceDigest: computeEvidenceDigest(evidence),
    gates: gateResults,
    rowDelta,
  };
}

export async function loadRecordedLiveSession(): Promise<DatabaseSessionView> {
  const { live, approval } = await loadArtifacts();
  if (
    text(live.provenance, "live.provenance") !== "live" ||
    text(live.status, "live.status") !== "AWAITING_HUMAN_APPROVAL" ||
    bool(live.liveCertified, "live.liveCertified") ||
    text(approval.status, "approval.status") !== "SAFE_TO_COMMIT" ||
    !bool(approval.liveCertified, "approval.liveCertified")
  ) {
    throw new Error("Recorded Live evidence does not satisfy replay contracts");
  }
  const candidates = array(live.candidates, "live.candidates").map(candidateView);
  const approvalRecord = record(approval.approval, "approval.approval");
  const binding = record(approvalRecord.binding, "approval.binding");
  const winnerCandidateId = text(
    live.winnerCandidateId,
    "live.winnerCandidateId",
  );
  const winner = candidates.find(
    (candidate) => candidate.candidateId === winnerCandidateId,
  );
  if (
    winner === undefined ||
    !winner.eligible ||
    text(binding.candidateId, "approval.binding.candidateId") !==
      winnerCandidateId ||
    text(binding.planDigest, "approval.binding.planDigest") !==
      winner.planDigest ||
    text(binding.evidenceDigest, "approval.binding.evidenceDigest") !==
      winner.evidenceDigest ||
    text(binding.sourceCommitSha, "approval.binding.sourceCommitSha") !==
      text(live.sourceCommitSha, "live.sourceCommitSha")
  ) {
    throw new Error("Recorded Live winner is not exactly approval-bound");
  }
  const braintrust = record(live.braintrust, "live.braintrust");
  const comparison = record(braintrust.comparison, "braintrust.comparison");
  if (!bool(comparison.preventedUnsafeDirectSelection, "braintrust.comparison")) {
    throw new Error("Recorded Live evidence lacks the safety reversal");
  }
  for (const value of array(live.candidates, "live.candidates")) {
    const provider = record(value, "candidate");
    const fireworks = record(provider.fireworks, "candidate.fireworks");
    const daytona = record(provider.daytona, "candidate.daytona");
    text(fireworks.requestId, "candidate.fireworks.requestId");
    if (
      !bool(
        daytona.networkBlockedBeforeExecution,
        "candidate.daytona.networkBlockedBeforeExecution",
      ) ||
      !bool(daytona.destroyed, "candidate.daytona.destroyed")
    ) {
      throw new Error("Recorded Live Daytona sandbox did not fail closed");
    }
  }

  return {
    sessionId: `recorded-${text(live.sessionId, "live.sessionId")}`,
    createdAt: text(live.capturedAt, "live.capturedAt"),
    updatedAt: text(approval.capturedAt, "approval.capturedAt"),
    provenance: "RECORDED_LIVE",
    providerVerified: true,
    fixtureKind: "OpenBoxes-derived executable fixture",
    state: "SAFE_TO_COMMIT",
    task: {
      taskId: "merge-duplicate-sku-la",
      naturalLanguageRequest:
        "Merge the duplicate SKU in the Los Angeles warehouse and release inventory allocated to cancelled orders, without affecting other warehouses, shipped orders, lots, serial numbers, or expiration dates.",
      allowedWarehouses: ["warehouse-la"],
      allowedTenants: ["tenant-demo"],
      maxAffectedRows: 24,
    },
    sourceCommitSha: text(binding.sourceCommitSha, "binding.sourceCommitSha"),
    snapshotDigest: text(binding.snapshotDigest, "binding.snapshotDigest"),
    schemaFingerprint: text(
      binding.schemaFingerprint,
      "binding.schemaFingerprint",
    ),
    intentContractDigest: text(
      binding.intentContractDigest,
      "binding.intentContractDigest",
    ),
    currentEvidenceDigest: text(
      binding.evidenceDigest,
      "binding.evidenceDigest",
    ),
    policyVersion: text(binding.policyVersion, "binding.policyVersion"),
    candidates,
    winnerCandidateId,
    approval: {
      approvalId: text(approvalRecord.approvalId, "approval.approvalId"),
      decision: "approved",
      approverId: text(binding.approverId, "approval.binding.approverId"),
      actedAt: text(binding.timestamp, "approval.binding.timestamp"),
      bindingDigest: text(
        approvalRecord.bindingDigest,
        "approval.bindingDigest",
      ),
    },
    auditEvents: [],
    liveStatus: {
      fireworks: "PASS",
      daytona: "PASS",
      braintrust: "PASS",
      copilotKitHitl: "PASS",
    },
  };
}
