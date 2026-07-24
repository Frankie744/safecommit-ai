import { randomUUID } from "node:crypto";

import {
  computeEvidenceDigest,
  createDatabaseApproval,
  invalidateDatabaseApproval,
  type DatabaseApproval,
  type DatabaseApprovalBinding,
} from "@safeflash/domain";
import {
  loadSafeCommitDatabaseProfile,
  runLocalDatabaseTournament,
  type DatabaseTournamentResult,
} from "@safeflash/orchestrator";
import {
  evaluateDatabaseHardGates,
  type DatabaseInvariantContext,
} from "@safeflash/safety-policy";
import { z } from "zod";

import type {
  DatabaseAuditEventView,
  DatabaseCandidateView,
  DatabaseSessionView,
} from "../lib/database-session-types";

export const CreateDatabaseSessionRequestSchema = z
  .object({
    mode: z.enum(["mock", "local-test"]).default("mock"),
  })
  .strict();

export const DatabaseDecisionRequestSchema = z
  .object({
    decision: z.enum(["approved", "rejected", "changes_requested"]),
  })
  .strict();

interface DatabaseSessionRecord {
  view: DatabaseSessionView;
  approval?: DatabaseApproval;
  evidenceRevision: number;
}

export class DatabaseSessionServiceError extends Error {
  constructor(
    readonly code:
      | "NOT_FOUND"
      | "INVALID_STATE"
      | "CONFIGURATION_BLOCKED"
      | "EVIDENCE_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "DatabaseSessionServiceError";
  }
}

function auditEvent(
  events: readonly DatabaseAuditEventView[],
  eventType: string,
  occurredAt: string,
  payload: unknown,
): DatabaseAuditEventView {
  const previous = events.at(-1);
  const sequence = (previous?.sequence ?? 0) + 1;
  const previousEventHash = previous?.eventHash ?? null;
  return {
    sequence,
    eventType,
    occurredAt,
    previousEventHash,
    eventHash: computeEvidenceDigest({
      sequence,
      eventType,
      occurredAt,
      previousEventHash,
      payload,
    }),
  };
}

function passingContext(
  change: Partial<DatabaseInvariantContext> = {},
): DatabaseInvariantContext {
  return {
    executionSucceeded: true,
    planIntegrityPassed: true,
    allowedWarehouses: ["warehouse-la"],
    touchedWarehouses: ["warehouse-la"],
    allowedTenants: ["tenant-demo"],
    touchedTenants: ["tenant-demo"],
    inventoryUnitsBefore: 34,
    inventoryUnitsAfter: 34,
    negativeInventoryRows: 0,
    overAllocatedRows: 0,
    lostLotOrSerialRows: 0,
    referentialIntegrityViolations: 0,
    protectedOrderRowsChanged: 0,
    affectedRows: 2,
    maxAffectedRows: 24,
    beforeStateDigest: computeEvidenceDigest("before"),
    afterStateDigest: computeEvidenceDigest("after"),
    secondRunStateDigest: computeEvidenceDigest("after"),
    rollbackStateDigest: computeEvidenceDigest("before"),
    ...change,
  };
}

function mockCandidate(
  input: Omit<
    DatabaseCandidateView,
    "eligible" | "failedGateNames" | "gates" | "planDigest" | "evidenceDigest"
  > & { gateContext: DatabaseInvariantContext },
): DatabaseCandidateView {
  const gates = evaluateDatabaseHardGates(input.gateContext);
  const planDigest = computeEvidenceDigest({
    candidateId: input.candidateId,
    strategy: input.strategy,
    hypothesis: input.hypothesis,
  });
  const evidenceDigest = computeEvidenceDigest({
    provenance: "MOCK",
    candidateId: input.candidateId,
    gates: gates.results,
    rowDelta: input.rowDelta,
  });
  return {
    candidateId: input.candidateId,
    strategy: input.strategy,
    hypothesis: input.hypothesis,
    eligible: gates.eligible,
    weightedScore: input.weightedScore,
    failedGateNames: gates.failedGateNames,
    affectedRows: input.affectedRows,
    touchedWarehouses: input.touchedWarehouses,
    inventoryDeltaUnits: input.inventoryDeltaUnits,
    planDigest,
    evidenceDigest,
    gates: gates.results.map((gate) => ({
      name: gate.name,
      passed: gate.passed,
      explanation: gate.explanation,
    })),
    rowDelta: input.rowDelta,
  };
}

function mockCandidates(): readonly DatabaseCandidateView[] {
  return [
    mockCandidate({
      candidateId: "candidate-a-aggressive",
      strategy: "aggressive-cleanup",
      hypothesis:
        "Normalize every same-SKU record and release every cancelled allocation.",
      weightedScore: 0.96,
      affectedRows: 5,
      touchedWarehouses: [
        "warehouse-la",
        "warehouse-ny",
        "warehouse-other-la",
      ],
      inventoryDeltaUnits: 0,
      gateContext: passingContext({
        touchedWarehouses: [
          "warehouse-la",
          "warehouse-ny",
          "warehouse-other-la",
        ],
        touchedTenants: ["tenant-demo", "tenant-other"],
        affectedRows: 5,
      }),
      rowDelta: [
        {
          table: "allocation",
          id: "allocation-cancelled-la",
          changeKind: "updated",
          summary: "quantity 3 → 0",
        },
        {
          table: "allocation",
          id: "allocation-cancelled-ny",
          changeKind: "updated",
          summary: "quantity 4 → 0 (outside contract)",
        },
        {
          table: "product",
          id: "product-other-tenant",
          changeKind: "updated",
          summary: "canonical link crossed tenant boundary",
        },
      ],
    }),
    mockCandidate({
      candidateId: "candidate-b-shipped-order",
      strategy: "conservative",
      hypothesis:
        "Rewrite a shipped order as cancelled before releasing its allocation.",
      weightedScore: 0.91,
      affectedRows: 2,
      touchedWarehouses: ["warehouse-la"],
      inventoryDeltaUnits: 0,
      gateContext: passingContext({ protectedOrderRowsChanged: 1 }),
      rowDelta: [
        {
          table: "order_header",
          id: "order-shipped-la",
          changeKind: "updated",
          summary: "SHIPPED → CANCELLED (protected history)",
        },
      ],
    }),
    mockCandidate({
      candidateId: "candidate-c-safe",
      strategy: "relationship-preserving",
      hypothesis:
        "Link only the intended duplicate and release only the cancelled Los Angeles allocation.",
      weightedScore: 0.88,
      affectedRows: 2,
      touchedWarehouses: ["warehouse-la"],
      inventoryDeltaUnits: 0,
      gateContext: passingContext(),
      rowDelta: [
        {
          table: "product",
          id: "product-duplicate",
          changeKind: "updated",
          summary: "canonical_product_id → product-canonical",
        },
        {
          table: "allocation",
          id: "allocation-cancelled-la",
          changeKind: "updated",
          summary: "quantity 3 → 0",
        },
      ],
    }),
  ];
}

function candidateViewsFromTournament(
  tournament: DatabaseTournamentResult,
): readonly DatabaseCandidateView[] {
  return tournament.candidates.map((candidate) => {
    const touchedWarehouses = new Set<string>();
    for (const delta of candidate.evidence.rowDelta) {
      for (const row of [delta.before, delta.after]) {
        if (typeof row?.warehouse_id === "string") {
          touchedWarehouses.add(row.warehouse_id);
        }
      }
    }
    const inventoryGate = candidate.gates.results.find(
      (gate) => gate.name === "InventoryConservation",
    );
    return {
      candidateId: candidate.plan.candidateId,
      strategy: candidate.plan.strategy,
      hypothesis: candidate.plan.hypothesis,
      eligible: candidate.gates.eligible,
      weightedScore: candidate.weightedScore,
      failedGateNames: candidate.gates.failedGateNames,
      affectedRows: candidate.evidence.statementResults.reduce(
        (sum, statement) => sum + statement.affectedRows,
        0,
      ),
      touchedWarehouses: [...touchedWarehouses],
      inventoryDeltaUnits: inventoryGate?.passed ? 0 : -1,
      planDigest: candidate.evidence.planDigest,
      evidenceDigest: computeEvidenceDigest(candidate.evidence),
      gates: candidate.gates.results.map((gate) => ({
        name: gate.name,
        passed: gate.passed,
        explanation: gate.explanation,
      })),
      rowDelta: candidate.evidence.rowDelta.map((delta) => ({
        table: delta.table,
        id: String(delta.primaryKey.id),
        changeKind: delta.changeKind,
        summary: `${delta.changeKind} row ${String(delta.primaryKey.id)}`,
      })),
    };
  });
}

function approvalBinding(
  record: DatabaseSessionRecord,
  at: string,
): DatabaseApprovalBinding {
  const winner = record.view.candidates.find(
    (candidate) => candidate.candidateId === record.view.winnerCandidateId,
  );
  if (winner === undefined || !winner.eligible) {
    throw new DatabaseSessionServiceError(
      "INVALID_STATE",
      "Only an eligible selected plan can be approved",
    );
  }
  return {
    candidateId: winner.candidateId,
    planDigest: winner.planDigest,
    intentContractDigest: record.view.intentContractDigest,
    evidenceDigest: record.view.currentEvidenceDigest,
    snapshotDigest: record.view.snapshotDigest,
    schemaFingerprint: record.view.schemaFingerprint,
    policyVersion: record.view.policyVersion,
    sourceCommitSha: record.view.sourceCommitSha,
    approverId: process.env.SAFECOMMIT_APPROVER_ID?.trim() || "demo-operator",
    timestamp: at,
  };
}

export interface DatabaseSessionServiceOptions {
  now?: () => Date;
  sourceCommitSha?: string;
}

export class DatabaseSessionService {
  private readonly records = new Map<string, DatabaseSessionRecord>();
  private readonly now: () => Date;
  private readonly sourceCommitSha: string;

  constructor(options: DatabaseSessionServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.sourceCommitSha =
      options.sourceCommitSha ??
      process.env.SAFECOMMIT_SOURCE_COMMIT_SHA?.trim() ??
      "local-source-unbound";
  }

  list(): readonly DatabaseSessionView[] {
    return [...this.records.values()]
      .map((record) => structuredClone(record.view))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  get(sessionId: string): DatabaseSessionView {
    const record = this.requireRecord(sessionId);
    return structuredClone(record.view);
  }

  async create(input: unknown): Promise<DatabaseSessionView> {
    const request = CreateDatabaseSessionRequestSchema.parse(input);
    const profile = await loadSafeCommitDatabaseProfile();
    const now = this.now().toISOString();
    const sessionId = `safecommit-${randomUUID()}`;
    let candidates: readonly DatabaseCandidateView[];
    let winnerCandidateId: string | null;
    let provenance: DatabaseSessionView["provenance"];
    let tournamentDigest: string;

    if (request.mode === "local-test") {
      const connectionUri = process.env.SAFECOMMIT_MYSQL_URL?.trim();
      if (!connectionUri) {
        throw new DatabaseSessionServiceError(
          "CONFIGURATION_BLOCKED",
          "LOCAL_TEST requires server-only SAFECOMMIT_MYSQL_URL",
        );
      }
      const tournament = await runLocalDatabaseTournament({
        connectionUri,
        sourceCommitSha: this.sourceCommitSha,
        sessionId,
        profile,
      });
      candidates = candidateViewsFromTournament(tournament);
      winnerCandidateId = tournament.winnerCandidateId;
      provenance = "LOCAL_TEST";
      tournamentDigest = tournament.tournamentDigest;
    } else {
      candidates = mockCandidates();
      winnerCandidateId = "candidate-c-safe";
      provenance = "MOCK";
      tournamentDigest = computeEvidenceDigest({
        provenance,
        candidates,
        winnerCandidateId,
      });
    }

    const firstEvent = auditEvent(
      [],
      "DATABASE_TOURNAMENT_COMPLETED",
      now,
      { provenance, tournamentDigest, winnerCandidateId },
    );
    const view: DatabaseSessionView = {
      sessionId,
      createdAt: now,
      updatedAt: now,
      provenance,
      providerVerified: false,
      fixtureKind: profile.fixtureKind,
      state:
        winnerCandidateId === null ? "BLOCKED" : "AWAITING_HUMAN_APPROVAL",
      task: {
        taskId: profile.intentContract.taskId,
        naturalLanguageRequest:
          profile.intentContract.naturalLanguageRequest,
        allowedWarehouses: profile.intentContract.allowedWarehouses,
        allowedTenants: profile.intentContract.allowedTenants,
        maxAffectedRows: profile.intentContract.maxAffectedRows,
      },
      sourceCommitSha: this.sourceCommitSha,
      snapshotDigest: profile.fixtureSourceDigest,
      schemaFingerprint: profile.schemaFingerprint,
      intentContractDigest: computeEvidenceDigest(profile.intentContract),
      currentEvidenceDigest: computeEvidenceDigest({
        tournamentDigest,
        candidates: candidates.map((candidate) => candidate.evidenceDigest),
      }),
      policyVersion: profile.intentContract.contractVersion,
      candidates,
      winnerCandidateId,
      auditEvents: [firstEvent],
      blockedReason:
        winnerCandidateId === null
          ? "No candidate passed all 13 database hard gates."
          : undefined,
      liveStatus: {
        fireworks: "BLOCKED",
        daytona: "BLOCKED",
        braintrust: "BLOCKED",
        copilotKitHitl: "PASS",
      },
    };
    this.records.set(sessionId, { view, evidenceRevision: 1 });
    return structuredClone(view);
  }

  decide(
    sessionId: string,
    input: unknown,
  ): DatabaseSessionView {
    const request = DatabaseDecisionRequestSchema.parse(input);
    const record = this.requireRecord(sessionId);
    if (record.view.state !== "AWAITING_HUMAN_APPROVAL") {
      throw new DatabaseSessionServiceError(
        "INVALID_STATE",
        "The session is not waiting for a human decision",
      );
    }
    const at = this.now().toISOString();
    const binding = approvalBinding(record, at);
    const approval = createDatabaseApproval({
      approvalId: `database-approval-${randomUUID()}`,
      decision: request.decision,
      binding,
    });
    const nextEvent = auditEvent(
      record.view.auditEvents,
      "DATABASE_APPROVAL_RECORDED",
      at,
      {
        decision: request.decision,
        candidateId: binding.candidateId,
        bindingDigest: approval.bindingDigest,
      },
    );
    record.approval = approval;
    record.view = {
      ...record.view,
      updatedAt: at,
      state: request.decision === "approved" ? "SAFE_TO_COMMIT" : "BLOCKED",
      approval: {
        approvalId: approval.approvalId,
        decision: approval.decision,
        approverId: binding.approverId,
        actedAt: at,
        bindingDigest: approval.bindingDigest,
      },
      auditEvents: [...record.view.auditEvents, nextEvent],
      blockedReason:
        request.decision === "approved"
          ? undefined
          : `Human decision: ${request.decision}`,
    };
    return structuredClone(record.view);
  }

  revalidate(sessionId: string): DatabaseSessionView {
    const record = this.requireRecord(sessionId);
    const winner = record.view.candidates.find(
      (candidate) => candidate.candidateId === record.view.winnerCandidateId,
    );
    if (winner === undefined || !winner.eligible) {
      throw new DatabaseSessionServiceError(
        "INVALID_STATE",
        "Only a session with an eligible selected plan can be revalidated",
      );
    }
    const at = this.now().toISOString();
    record.evidenceRevision += 1;
    const nextEvidenceDigest = computeEvidenceDigest({
      priorEvidenceDigest: record.view.currentEvidenceDigest,
      revision: record.evidenceRevision,
      provenance: record.view.provenance,
    });
    const currentBinding =
      record.approval === undefined
        ? undefined
        : {
            ...record.approval.binding,
            evidenceDigest: nextEvidenceDigest,
          };
    if (currentBinding !== undefined) {
      record.approval = invalidateDatabaseApproval(
        record.approval,
        currentBinding,
        at,
      );
    }
    const nextEvent = auditEvent(
      record.view.auditEvents,
      "DATABASE_EVIDENCE_REVALIDATED",
      at,
      {
        evidenceRevision: record.evidenceRevision,
        evidenceDigest: nextEvidenceDigest,
      },
    );
    record.view = {
      ...record.view,
      updatedAt: at,
      state: "AWAITING_HUMAN_APPROVAL",
      currentEvidenceDigest: nextEvidenceDigest,
      approval:
        record.approval === undefined
          ? undefined
          : {
              approvalId: record.approval.approvalId,
              decision: record.approval.decision,
              approverId: record.approval.binding.approverId,
              actedAt: record.approval.binding.timestamp,
              bindingDigest: record.approval.bindingDigest,
              invalidatedAt: record.approval.invalidatedAt,
              invalidationReason: record.approval.invalidationReason,
            },
      auditEvents: [...record.view.auditEvents, nextEvent],
      blockedReason: undefined,
    };
    return structuredClone(record.view);
  }

  private requireRecord(sessionId: string): DatabaseSessionRecord {
    const record = this.records.get(sessionId);
    if (record === undefined) {
      throw new DatabaseSessionServiceError(
        "NOT_FOUND",
        `Database session ${sessionId} was not found`,
      );
    }
    return record;
  }
}

let singleton: DatabaseSessionService | undefined;

export function getDatabaseSessionService(): DatabaseSessionService {
  singleton ??= new DatabaseSessionService();
  return singleton;
}
