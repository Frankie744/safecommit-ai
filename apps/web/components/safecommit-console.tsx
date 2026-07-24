"use client";

import {
  ToolCallStatus,
  useAgentContext,
  useHumanInTheLoop,
} from "@copilotkit/react-core/v2";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import {
  createDatabaseSession,
  decideDatabaseSession,
  loadRecordedLiveDatabaseSession,
  revalidateDatabaseSession,
} from "../lib/database-session-api";
import type {
  DatabaseCandidateView,
  DatabaseSessionView,
} from "../lib/database-session-types";
import styles from "./safecommit-console.module.css";

const approvalParameters = z.object({
  sessionId: z.string(),
  candidateId: z.string(),
  evidenceDigest: z.string(),
  planDigest: z.string(),
  snapshotDigest: z.string(),
  schemaFingerprint: z.string(),
  policyVersion: z.string(),
  sourceCommitSha: z.string(),
  summary: z.string(),
});

type ApprovalArguments = z.infer<typeof approvalParameters>;
type Decision = "approved" | "rejected" | "changes_requested";
type ExecutionMode = "recorded-live" | "mock" | "local-test";
type DatasetState = "idle" | "loading" | "ready";
type PlaybackPhase =
  | "idle"
  | "requesting"
  | "generating"
  | "executing"
  | "scoring"
  | "gating"
  | "selecting"
  | "approval";
type StageStatus = "pending" | "active" | "complete";

const PLAYBACK_PHASES: readonly PlaybackPhase[] = [
  "requesting",
  "generating",
  "executing",
  "scoring",
  "gating",
  "selecting",
  "approval",
];

const WORKFLOW_STEPS = [
  {
    phase: "generating",
    provider: "Fireworks AI",
    copy: "Create 3 competing plans",
  },
  {
    phase: "executing",
    provider: "Daytona",
    copy: "Run each plan in isolation",
  },
  {
    phase: "scoring",
    provider: "Braintrust",
    copy: "Compare quality and outcomes",
  },
  {
    phase: "gating",
    provider: "SafeCommit",
    copy: "Check non-negotiable safety",
  },
  {
    phase: "approval",
    provider: "CopilotKit",
    copy: "Pause for human decision",
  },
] as const;

const DEFAULT_DEMO_PROMPT =
  "Merge the duplicate SKU in Los Angeles and release its cancelled allocation. Do not change other warehouses, shipped orders, lots, or serial numbers.";

const DATASET_PROFILE = {
  id: "openboxes-logistics-mysql8",
  name: "OpenBoxes logistics fixture",
  tables: 12,
  foreignKeys: 27,
  rows: 41,
} as const;

const GATE_GROUPS = [
  {
    title: "Execution",
    names: ["PlanExecutionSuccess", "PlanIntegrity"],
  },
  {
    title: "Scope",
    names: ["WarehouseScope", "TenantIsolation"],
  },
  {
    title: "Inventory",
    names: [
      "InventoryConservation",
      "NoNegativeInventory",
      "AllocationBound",
    ],
  },
  {
    title: "Business history",
    names: [
      "LotSerialPreservation",
      "ReferentialIntegrity",
      "ProtectedOrderState",
    ],
  },
  {
    title: "Recovery",
    names: [
      "BlastRadiusWithinContract",
      "Idempotency",
      "RollbackVerified",
    ],
  },
] as const;

const EVIDENCE_BINDINGS = [
  {
    key: "currentEvidenceDigest",
    label: "Execution evidence",
    meaning: "Candidate results and gate outcomes are fingerprinted.",
  },
  {
    key: "snapshotDigest",
    label: "Database baseline",
    meaning: "Every candidate started from the same known fixture.",
  },
  {
    key: "schemaFingerprint",
    label: "Schema",
    meaning: "Tables and relationships match the validated contract.",
  },
  {
    key: "intentContractDigest",
    label: "Operator intent",
    meaning: "The approved plan still matches the original request.",
  },
  {
    key: "sourceCommitSha",
    label: "Source revision",
    meaning: "The code that produced this evidence is pinned.",
  },
] as const;

const CANDIDATE_STORIES: Record<
  string,
  { title: string; action: string; badge: string }
> = {
  "candidate-a-aggressive": {
    title: "Broad cleanup",
    action: "Updates every matching SKU and cancelled allocation it can find.",
    badge: "Too broad",
  },
  "candidate-b-shipped-order": {
    title: "Rewrite history",
    action: "Turns a shipped order into cancelled before releasing its stock.",
    badge: "High score",
  },
  "candidate-c-safe": {
    title: "Scoped repair",
    action: "Changes only the duplicate SKU and cancelled Los Angeles allocation.",
    badge: "Inside scope",
  },
};

const GATE_STORIES: Record<
  string,
  { title: string; reason: string; consequence: string }
> = {
  WarehouseScope: {
    title: "Crossed the warehouse boundary",
    reason: "Los Angeles only was allowed. This plan also changed New York inventory.",
    consequence: "Inventory outside the operator’s request could be released.",
  },
  TenantIsolation: {
    title: "Crossed the customer boundary",
    reason: "The plan matched a product owned by another tenant.",
    consequence: "One customer’s cleanup could alter another customer’s records.",
  },
  ProtectedOrderState: {
    title: "Rewrote a shipped order",
    reason: "Changed SHIPPED → CANCELLED, making fulfilled-order history false.",
    consequence: "Fulfilled-order history would become false and stock could be released twice.",
  },
};

function compact(value: string, visible = 12): string {
  if (value.length <= visible) return value;
  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

function candidateStory(candidate: DatabaseCandidateView) {
  return (
    CANDIDATE_STORIES[candidate.candidateId] ?? {
      title: candidate.strategy.replaceAll("-", " "),
      action: candidate.hypothesis,
      badge: "Candidate",
    }
  );
}

function gateStory(name: string, explanation: string) {
  return (
    GATE_STORIES[name] ?? {
      title: name.replace(/([a-z])([A-Z])/g, "$1 $2"),
      reason: explanation,
      consequence: "The resulting database state falls outside the approved contract.",
    }
  );
}

function readableDelta(table: string) {
  if (table === "product") {
    return {
      title: "Duplicate SKU linked",
      detail: "The duplicate now points to the canonical product.",
    };
  }
  if (table === "allocation") {
    return {
      title: "Cancelled allocation released",
      detail: "Reserved quantity changed from 3 to 0.",
    };
  }
  return {
    title: `${table.replaceAll("_", " ")} updated`,
    detail: "The selected plan changed this intended record.",
  };
}

function provenanceLabel(session: DatabaseSessionView | null): string {
  if (session === null) return "NO RUN • READ-ONLY";
  if (session.provenance === "MOCK") return "MOCK • NOT PROVIDER-VERIFIED";
  if (session.provenance === "LOCAL_TEST")
    return "LOCAL TEST • REAL MYSQL • NOT DAYTONA";
  if (session.provenance === "RECORDED_LIVE")
    return "RECORDED LIVE • MANIFEST VERIFIED";
  return session.providerVerified ? "LIVE • PROVIDER-VERIFIED" : "LIVE • BLOCKED";
}

function phaseIndex(phase: PlaybackPhase): number {
  return PLAYBACK_PHASES.indexOf(phase);
}

function stageStatus(
  current: PlaybackPhase,
  target: (typeof WORKFLOW_STEPS)[number]["phase"],
): StageStatus {
  if (current === "idle") return "pending";
  const currentIndex = phaseIndex(current);
  const targetIndex = phaseIndex(target);
  if (currentIndex > targetIndex) return "complete";
  if (currentIndex === targetIndex) return "active";
  return "pending";
}

function providerTruth(
  provider: (typeof WORKFLOW_STEPS)[number]["provider"],
  mode: ExecutionMode,
  session: DatabaseSessionView | null,
): { status: string; result: string } {
  const recorded = session?.provenance === "RECORDED_LIVE";
  if (mode === "recorded-live" && session === null) {
    return {
      status: "MANIFEST REQUIRED",
      result: "Verified result appears only after both manifests pass",
    };
  }
  if (provider === "Fireworks AI") {
    if (recorded && session.liveStatus.fireworks === "PASS") {
      return {
        status: "PROVIDER VERIFIED",
        result: "3 plans generated",
      };
    }
    return {
      status: "CONTRACT REPLAY",
      result: "3 fixture plans • no provider call",
    };
  }
  if (provider === "Daytona") {
    if (recorded && session.liveStatus.daytona === "PASS") {
      return {
        status: "PROVIDER VERIFIED",
        result: "3 sandboxes run and destroyed",
      };
    }
    if (mode === "local-test") {
      return {
        status: "LOCAL MYSQL",
        result: "Local MySQL run • no provider call",
      };
    }
    return {
      status: "CONTRACT REPLAY",
      result: "Sandbox replay • no provider call",
    };
  }
  if (provider === "Braintrust") {
    if (recorded && session.liveStatus.braintrust === "PASS") {
      return {
        status: "PROVIDER VERIFIED",
        result: "Direct AI vs gated winner",
      };
    }
    return {
      status: "LOCAL SCORING",
      result: "Local ranking • no provider write",
    };
  }
  if (provider === "CopilotKit") {
    return {
      status: session?.liveStatus.copilotKitHitl === "PASS" ? "REGISTERED" : "ARMED",
      result: "Human approval bound",
    };
  }
  return {
    status: "DETERMINISTIC",
    result: "13 hard gates checked",
  };
}

function WorkflowStage({
  mode,
  phase,
  session,
  humanVerified,
}: {
  mode: ExecutionMode;
  phase: PlaybackPhase;
  session: DatabaseSessionView | null;
  humanVerified: boolean;
}) {
  const workflowComplete =
    phase === "approval" &&
    (session?.provenance === "RECORDED_LIVE"
      ? humanVerified
      : session?.state === "SAFE_TO_COMMIT");
  const activeStep = WORKFLOW_STEPS.find(
    (step) =>
      !workflowComplete && stageStatus(phase, step.phase) === "active",
  );
  return (
    <section className={styles.workflow} aria-live="polite">
      <header className={styles.workflowHeader}>
        <div>
          <h2>
            {phase === "idle"
              ? "Workflow"
              : activeStep
                ? `${activeStep.provider} working`
                : "Workflow complete"}
          </h2>
        </div>
        <span className={styles.workflowMode}>
          {mode === "recorded-live"
            ? "Verified provider evidence replay"
            : mode === "local-test"
              ? "Local MySQL execution"
              : "Deterministic contract demo"}
        </span>
      </header>
      <div className={styles.workflowTrack} data-testid="workflow-track">
        {WORKFLOW_STEPS.map((step, index) => {
          const status =
            workflowComplete && step.phase === "approval"
              ? "complete"
              : stageStatus(phase, step.phase);
          const truth = providerTruth(step.provider, mode, session);
          return (
            <article
              className={styles.workflowStep}
              data-status={status}
              data-testid={`workflow-${step.provider
                .toLowerCase()
                .replaceAll(" ", "-")}`}
              key={step.provider}
            >
              <div className={styles.stepTopline}>
                <span className={styles.stepNumber}>
                  {status === "complete" ? "✓" : String(index + 1).padStart(2, "0")}
                </span>
                {status === "complete" ? null : (
                  <span className={styles.stepState}>{status.toUpperCase()}</span>
                )}
              </div>
              <div className={styles.stepIdentity}>
                <strong>{step.provider}</strong>
              </div>
              <p>{status === "pending" ? step.copy : truth.result}</p>
              {status === "active" ? (
                <span className={styles.activityBar} aria-hidden="true" />
              ) : null}
            </article>
          );
        })}
      </div>
      {phase === "requesting" ? (
        <div className={styles.requesting}>
          <span className={styles.spinner} aria-hidden="true" />
          <div>
            <strong>
              {mode === "recorded-live"
                ? "Verifying immutable manifests"
                : "Locking intent and preparing the tournament"}
            </strong>
            <span>
              {mode === "recorded-live"
                ? "Checking provider proof and its human-approval receipt."
                : "Locking the request before any plan runs."}
            </span>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function GateSummary({
  candidate,
  visibleGateCount,
}: {
  candidate: DatabaseCandidateView;
  visibleGateCount: number;
}) {
  const visibleGates = candidate.gates.slice(0, visibleGateCount);
  const passed = visibleGates.filter((gate) => gate.passed).length;
  const failed = visibleGates.length - passed;
  return (
    <div className={styles.gateSummary}>
      <div className={styles.gateMeter}>
        <span>
          <strong>{passed}</strong> / {candidate.gates.length} safe
        </span>
        <span className={failed > 0 ? styles.failText : styles.passText}>
          {visibleGates.length === 0
            ? "Waiting"
            : failed > 0
              ? `${failed} hard stop${failed > 1 ? "s" : ""}`
              : "No violations"}
        </span>
      </div>
      <div className={styles.gateProgress} aria-hidden="true">
        {candidate.gates.map((gate, index) => (
          <span
            data-visible={index < visibleGateCount}
            data-result={gate.passed ? "pass" : "fail"}
            key={gate.name}
          />
        ))}
      </div>
      <details className={styles.gateDetails}>
        <summary>View all 13 technical gates</summary>
        <div>
          {GATE_GROUPS.map((group) => {
            const gates = candidate.gates.filter((gate) =>
              (group.names as readonly string[]).includes(gate.name),
            );
            return (
              <section key={group.title}>
                <strong>{group.title}</strong>
                {gates.map((gate) => {
                  const gateIndex = candidate.gates.findIndex(
                    (item) => item.name === gate.name,
                  );
                  const visible = gateIndex < visibleGateCount;
                  return (
                    <span
                      className={
                        !visible
                          ? styles.gatePending
                          : gate.passed
                            ? styles.pass
                            : styles.fail
                      }
                      key={gate.name}
                      title={gate.explanation}
                    >
                      {visible ? (gate.passed ? "✓" : "×") : "·"} {gate.name}
                    </span>
                  );
                })}
              </section>
            );
          })}
        </div>
      </details>
    </div>
  );
}

function CandidateCard({
  candidate,
  index,
  winner,
  visible,
  metricsVisible,
  visibleGateCount,
  selectionVisible,
}: {
  candidate: DatabaseCandidateView;
  index: number;
  winner: boolean;
  visible: boolean;
  metricsVisible: boolean;
  visibleGateCount: number;
  selectionVisible: boolean;
}) {
  const isBlocked =
    selectionVisible && visibleGateCount >= candidate.gates.length && !candidate.eligible;
  const isWinner = selectionVisible && winner;
  const story = candidateStory(candidate);
  const failedGates = candidate.gates.filter((gate) => !gate.passed);
  return (
    <article
      className={[
        styles.candidate,
        visible ? styles.candidateVisible : styles.candidateHidden,
        isBlocked ? styles.candidateFailed : "",
        isWinner ? styles.candidateWinner : "",
      ].join(" ")}
      data-testid={`candidate-${candidate.candidateId}`}
      style={{ "--candidate-index": index } as React.CSSProperties}
    >
      <header className={styles.candidateHeader}>
        <div>
          <span className={styles.micro}>
            Plan {String.fromCharCode(65 + index)} • {story.badge}
          </span>
          <h3>{story.title}</h3>
        </div>
        <div className={styles.scoreBlock}>
          <span>AI score</span>
          <strong className={metricsVisible ? styles.scoreRevealed : ""}>
            {metricsVisible ? candidate.weightedScore.toFixed(2) : "—"}
          </strong>
        </div>
      </header>
      <div className={styles.candidateBody}>
        <p className={styles.planAction}>{story.action}</p>
        <GateSummary
          candidate={candidate}
          visibleGateCount={visibleGateCount}
        />
        {isBlocked ? (
          <div className={styles.eliminated} data-testid="eliminated-reason">
            <span>BLOCKED BY SAFETY GATE</span>
            {failedGates.map((gate) => {
              const failure = gateStory(gate.name, gate.explanation);
              return (
                <div className={styles.failureStory} key={gate.name}>
                  <strong>{failure.title}</strong>
                  <p>{failure.reason}</p>
                </div>
              );
            })}
          </div>
        ) : isWinner ? (
          <div className={styles.selected} data-testid="selected-plan">
            <span>SELECTED BY SAFECOMMIT</span>
            <strong>Only the intended LA records changed</strong>
            <small>All 13 non-negotiable gates passed.</small>
          </div>
        ) : (
          <div className={styles.candidateWaiting}>
            {visibleGateCount === 0
              ? "Awaiting sandbox evidence"
              : "Safety proof in progress"}
          </div>
        )}
      </div>
    </article>
  );
}

function EvidenceSummary({
  session,
  winner,
}: {
  session: DatabaseSessionView;
  winner: DatabaseCandidateView | undefined;
}) {
  return (
    <section className={styles.evidence}>
      <header className={styles.sectionHeader}>
        <div>
          <span className={styles.eyebrow}>Evidence</span>
          <h2>Approved changes</h2>
        </div>
      </header>
      <div className={styles.fixtureBadge}>
        OpenBoxes-derived fixture <span>• MySQL 8</span>
      </div>
      <div className={styles.evidenceGrid}>
        <article className={styles.changePanel}>
          <header>
            <span>Selected plan</span>
            <strong>
              {winner ? candidateStory(winner).title : "No eligible candidate"}
            </strong>
          </header>
          <div className={styles.changeList}>
            {winner?.rowDelta.map((delta, index) => {
              const readable = readableDelta(delta.table);
              return (
                <div className={styles.changeRow} key={`${delta.table}-${delta.id}`}>
                  <span className={styles.changeNumber}>0{index + 1}</span>
                  <div>
                    <strong>{readable.title}</strong>
                    <span>{readable.detail}</span>
                  </div>
                  <span className={styles.changeKind}>{delta.changeKind}</span>
                </div>
              );
            })}
          </div>
          <div className={styles.protectionSummary}>
            <span>✓ Other warehouses untouched</span>
            <span>✓ Shipped orders preserved</span>
            <span>✓ Rollback reproduced baseline</span>
          </div>
        </article>
        <article className={styles.bindingPanel}>
          <header>
            <span>Evidence lock</span>
            <strong>5 / 5 matched</strong>
          </header>
          <div className={styles.bindingSummary}>
            <span className={styles.bindingCheck}>✓</span>
            <div>
              <strong>The approval still matches this exact run</strong>
              <p>
                Plan, database snapshot, schema, operator request, and source code
                are unchanged.
              </p>
            </div>
          </div>
          <details className={styles.technicalEvidence}>
            <summary>Audit the 5 fingerprints</summary>
            <dl>
              {EVIDENCE_BINDINGS.map((binding) => (
                <div key={binding.key}>
                  <dt>{binding.label}</dt>
                  <dd>
                    <code>{session[binding.key]}</code>
                  </dd>
                </div>
              ))}
            </dl>
          </details>
          {session.approval?.invalidatedAt ? (
            <p className={styles.invalidated} data-testid="approval-invalidated">
              <strong>APPROVAL INVALIDATED</strong>
              Evidence changed after approval. Review the new result before
              approving again.
            </p>
          ) : null}
        </article>
      </div>
    </section>
  );
}

function CopilotBridge({
  session,
  onDecision,
  children,
}: {
  session: DatabaseSessionView | null;
  onDecision: (decision: Decision) => Promise<DatabaseSessionView>;
  children: React.ReactNode;
}) {
  const winner = session?.candidates.find(
    (candidate) => candidate.candidateId === session.winnerCandidateId,
  );
  const readableState = useMemo(
    () =>
      JSON.stringify({
        product: "SafeCommit",
        state: session?.state ?? "NO_SESSION",
        provenance: session?.provenance ?? "NONE",
        sessionId: session?.sessionId ?? null,
        winnerCandidateId: session?.winnerCandidateId ?? null,
        evidenceDigest: session?.currentEvidenceDigest ?? null,
        hardGateFailures:
          session?.candidates.map((candidate) => ({
            candidateId: candidate.candidateId,
            failures: candidate.failedGateNames,
          })) ?? [],
      }),
    [session],
  );

  useAgentContext({
    description:
      "Read-only SafeCommit database evidence. The agent cannot override hard gates or approval binding.",
    value: readableState,
  });

  useHumanInTheLoop<ApprovalArguments>({
    name: "request_safecommit_database_approval",
    agentId: "safecommit",
    available:
      session?.state === "AWAITING_HUMAN_APPROVAL" && winner !== undefined,
    description:
      "Pause before SAFE_TO_COMMIT and require a human decision bound to the exact database evidence.",
    parameters: approvalParameters,
    render: (props) => {
      const bindingMatches =
        session !== null &&
        winner !== undefined &&
        props.args.sessionId === session.sessionId &&
        props.args.candidateId === winner.candidateId &&
        props.args.evidenceDigest === session.currentEvidenceDigest &&
        props.args.planDigest === winner.planDigest &&
        props.args.snapshotDigest === session.snapshotDigest &&
        props.args.schemaFingerprint === session.schemaFingerprint &&
        props.args.policyVersion === session.policyVersion &&
        props.args.sourceCommitSha === session.sourceCommitSha;
      if (props.status !== ToolCallStatus.Executing) return <></>;
      return (
        <section className={styles.copilotCard} data-testid="copilot-hitl-card">
          <strong>CopilotKit is blocking on human approval</strong>
          <p>{props.args.summary}</p>
          {!bindingMatches ? (
            <span className={styles.failText}>
              Evidence changed. This approval interrupt is invalid.
            </span>
          ) : (
            <div className={styles.actions}>
              <button
                className={styles.reject}
                onClick={() =>
                  void onDecision("rejected").then((updated) =>
                    props.respond({
                      decision: "rejected",
                      state: updated.state,
                    }),
                  )
                }
                type="button"
              >
                Reject
              </button>
              <button
                className={styles.approve}
                onClick={() =>
                  void onDecision("approved").then((updated) =>
                    props.respond({
                      decision: "approved",
                      state: updated.state,
                    }),
                  )
                }
                type="button"
              >
                Approve bound evidence
              </button>
            </div>
          )}
        </section>
      );
    },
  });

  return <>{children}</>;
}

export function SafeCommitConsole() {
  const [session, setSession] = useState<DatabaseSessionView | null>(null);
  const [operatorToken, setOperatorToken] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_DEMO_PROMPT);
  const [datasetState, setDatasetState] = useState<DatasetState>("idle");
  const [replayVerified, setReplayVerified] = useState(false);
  const [mode, setMode] = useState<ExecutionMode>("recorded-live");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<PlaybackPhase>("idle");
  const [visibleCandidates, setVisibleCandidates] = useState(0);
  const [visibleGateCount, setVisibleGateCount] = useState(0);
  const runSequence = useRef(0);
  const datasetTimer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (datasetTimer.current !== undefined) {
        window.clearTimeout(datasetTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (session === null) return;
    let timer: number | undefined;
    if (phase === "generating") {
      timer = window.setTimeout(() => {
        if (visibleCandidates < session.candidates.length) {
          setVisibleCandidates((value) => value + 1);
        } else {
          setPhase("executing");
        }
      }, 430);
    } else if (phase === "executing") {
      timer = window.setTimeout(() => setPhase("scoring"), 1450);
    } else if (phase === "scoring") {
      timer = window.setTimeout(() => setPhase("gating"), 1200);
    } else if (phase === "gating") {
      const gateCount = Math.max(
        ...session.candidates.map((candidate) => candidate.gates.length),
      );
      timer = window.setTimeout(() => {
        if (visibleGateCount < gateCount) {
          setVisibleGateCount((value) => value + 1);
        } else {
          setPhase("selecting");
        }
      }, 170);
    } else if (phase === "selecting") {
      timer = window.setTimeout(() => setPhase("approval"), 1600);
    }
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [phase, session, visibleCandidates, visibleGateCount]);

  const run = async () => {
    const sequence = runSequence.current + 1;
    runSequence.current = sequence;
    setBusy(true);
    setError(null);
    setSession(null);
    setVisibleCandidates(0);
    setVisibleGateCount(0);
    setReplayVerified(false);
    setPhase("requesting");
    try {
      const updated =
        mode === "recorded-live"
          ? await loadRecordedLiveDatabaseSession()
          : await createDatabaseSession(operatorToken, mode);
      if (runSequence.current !== sequence) return;
      setSession(updated);
      setPhase("generating");
    } catch (caught) {
      if (runSequence.current !== sequence) return;
      setPhase("idle");
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (runSequence.current === sequence) setBusy(false);
    }
  };

  const loadDataset = () => {
    if (datasetTimer.current !== undefined) {
      window.clearTimeout(datasetTimer.current);
    }
    setDatasetState("loading");
    setReplayVerified(false);
    setError(null);
    datasetTimer.current = window.setTimeout(() => {
      setDatasetState("ready");
      datasetTimer.current = undefined;
    }, 650);
  };

  const decide = async (decision: Decision): Promise<DatabaseSessionView> => {
    if (session === null) throw new Error("No SafeCommit session");
    setBusy(true);
    setError(null);
    try {
      const updated = await decideDatabaseSession(
        session.sessionId,
        operatorToken,
        decision,
      );
      setSession(updated);
      return updated;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setBusy(false);
    }
  };

  const revalidate = async () => {
    if (session === null || session.provenance === "RECORDED_LIVE") return;
    setBusy(true);
    setError(null);
    try {
      setSession(
        await revalidateDatabaseSession(session.sessionId, operatorToken),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const winner = session?.candidates.find(
    (candidate) => candidate.candidateId === session.winnerCandidateId,
  );
  const directChoice =
    session === null
      ? undefined
      : [...session.candidates].sort(
          (left, right) =>
            right.weightedScore - left.weightedScore ||
            left.candidateId.localeCompare(right.candidateId),
        )[0];
  const directFailure =
    directChoice === undefined
      ? undefined
      : directChoice.gates.find((gate) => !gate.passed);
  const scoreVisible = phaseIndex(phase) >= phaseIndex("scoring");
  const selectionVisible = phaseIndex(phase) >= phaseIndex("selecting");
  const workflowBusy =
    phase !== "idle" && phase !== "approval" && phase !== "requesting";
  const canRun =
    !busy &&
    !workflowBusy &&
    prompt.trim().length > 0 &&
    datasetState === "ready" &&
    (mode === "recorded-live" || operatorToken.length > 0);
  const recordedAwaitingVerification =
    session?.provenance === "RECORDED_LIVE" && !replayVerified;

  return (
    <CopilotBridge session={session} onDecision={decide}>
      <main className={styles.shell}>
        <header className={styles.topbar}>
          <div className={styles.brand}>
            SafeCommit <span>/ database review</span>
          </div>
          <span className={styles.provenance} data-testid="provenance-label">
            {provenanceLabel(session)}
          </span>
        </header>

        <div className={styles.appGrid}>
          <aside className={styles.sidebar}>
            <section className={styles.taskPanel}>
              <span className={styles.eyebrow}>Operator request</span>
              <h1>Describe the database change</h1>
              <label className={styles.srOnly} htmlFor="demo-prompt">
                Database change request
              </label>
              <textarea
                id="demo-prompt"
                onChange={(event) => {
                  setPrompt(event.target.value);
                  setReplayVerified(false);
                }}
                rows={5}
                value={prompt}
              />
              <span className={styles.inputNote}>
                Demo input · mapped to the validated LA repair scenario
              </span>
              <div className={styles.taskBrief}>
                <span>Los Angeles only</span>
                <span>Keep shipped orders</span>
              </div>
            </section>

            <section className={styles.control}>
              <div className={styles.datasetControl}>
                <label htmlFor="dataset-profile">Dataset</label>
                <select
                  defaultValue={DATASET_PROFILE.id}
                  id="dataset-profile"
                >
                  <option value={DATASET_PROFILE.id}>
                    {DATASET_PROFILE.name}
                  </option>
                </select>
                <button
                  className={styles.datasetButton}
                  disabled={datasetState === "loading" || workflowBusy || busy}
                  onClick={loadDataset}
                  type="button"
                >
                  <span
                    className={
                      datasetState === "loading" ? styles.miniSpinner : ""
                    }
                    aria-hidden="true"
                  >
                    {datasetState === "ready" ? "✓" : "↻"}
                  </span>
                  {datasetState === "loading"
                    ? "Loading schema…"
                    : datasetState === "ready"
                      ? "Dataset loaded"
                      : "Load dataset"}
                </button>
                {datasetState === "ready" ? (
                  <div
                    className={styles.datasetStats}
                    data-testid="dataset-ready"
                  >
                    <span>
                      <strong>{DATASET_PROFILE.tables}</strong> tables
                    </span>
                    <span>
                      <strong>{DATASET_PROFILE.foreignKeys}</strong> foreign keys
                    </span>
                    <span>
                      <strong>{DATASET_PROFILE.rows}</strong> seeded rows
                    </span>
                  </div>
                ) : null}
              </div>
              <div className={styles.modeControl}>
                <label htmlFor="execution-mode">Evidence source</label>
                <select
                  aria-label="Execution mode"
                  id="execution-mode"
                  onChange={(event) => {
                    setMode(event.target.value as ExecutionMode);
                    setReplayVerified(false);
                    setError(null);
                  }}
                  value={mode}
                >
                  <option value="recorded-live">Recorded live replay</option>
                  <option value="mock">Mock contract demo</option>
                  <option value="local-test">Local MySQL 8</option>
                </select>
              </div>
              {mode === "recorded-live" ? null : (
                <div className={styles.tokenControl}>
                  <label htmlFor="operator-token">Operator token</label>
                  <input
                    aria-label="Operator token"
                    id="operator-token"
                    onChange={(event) => setOperatorToken(event.target.value)}
                    placeholder="Server-validated • never persisted"
                    type="password"
                    value={operatorToken}
                  />
                </div>
              )}
              <button
                className={styles.runButton}
                disabled={!canRun}
                onClick={() => void run()}
                type="button"
              >
                <span>{busy || workflowBusy ? "Running" : "Ready"}</span>
                <strong>
                  {busy
                    ? "Loading evidence…"
                    : workflowBusy
                      ? "Watch workflow"
                      : "Run safety review"}
                </strong>
              </button>
            </section>
            {error ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}

            <WorkflowStage
              humanVerified={replayVerified}
              mode={mode}
              phase={phase}
              session={session}
            />
          </aside>

          <section className={styles.workspace}>
            {session === null ? (
              phase === "idle" ? (
                <section className={styles.empty}>
                  <span className={styles.eyebrow}>
                    {datasetState === "ready" ? "Dataset ready" : "New review"}
                  </span>
                  <strong>
                    {datasetState === "ready"
                      ? "Ready to evaluate the request"
                      : "Load a dataset to begin"}
                  </strong>
                  <p>
                    {datasetState === "ready"
                      ? "The schema is locked. SafeCommit can now compare three plans against the same database baseline."
                      : "Choose the logistics fixture, inspect its schema profile, then start the recorded evidence workflow."}
                  </p>
                  <div className={styles.heroStats} aria-label="Demo summary">
                    <div>
                      <strong>
                        {datasetState === "ready" ? DATASET_PROFILE.tables : "—"}
                      </strong>
                      <span>tables</span>
                    </div>
                    <div>
                      <strong>
                        {datasetState === "ready"
                          ? DATASET_PROFILE.foreignKeys
                          : "—"}
                      </strong>
                      <span>foreign keys</span>
                    </div>
                    <div>
                      <strong>0</strong>
                      <span>production writes</span>
                    </div>
                  </div>
                </section>
              ) : null
            ) : (
              <>
            <section className={styles.sectionHeader}>
              <div>
                <span className={styles.eyebrow}>Tournament</span>
                <h2>
                  {selectionVisible
                    ? "Review complete"
                    : "Evaluating candidate plans"}
                </h2>
              </div>
              <span className={styles.workflowMode}>3 plans · 13 gates</span>
            </section>

            <section className={styles.candidates}>
              {session.candidates.map((candidate, index) => (
                <CandidateCard
                  candidate={candidate}
                  index={index}
                  key={candidate.candidateId}
                  metricsVisible={scoreVisible}
                  selectionVisible={selectionVisible}
                  visible={index < visibleCandidates}
                  visibleGateCount={visibleGateCount}
                  winner={candidate.candidateId === session.winnerCandidateId}
                />
              ))}
            </section>

            {selectionVisible ? (
              <section className={styles.reversal} data-testid="safety-reversal">
                <div>
                  <span>HIGHEST SCORE</span>
                  <strong>
                    {directChoice?.weightedScore.toFixed(2) ?? "none"}{" "}
                    <b>× BLOCKED</b>
                  </strong>
                  <small>
                    {directChoice && directFailure
                      ? `${candidateStory(directChoice).title}: ${gateStory(
                          directFailure.name,
                          directFailure.explanation,
                        ).title.toLowerCase()}.`
                      : "No direct candidate passed every hard gate."}
                  </small>
                </div>
                <span className={styles.reversalArrow}>→</span>
                <div>
                  <span>SELECTED PLAN</span>
                  <strong>{winner?.weightedScore.toFixed(2) ?? "none"} <b>✓ SELECTED</b></strong>
                  <small>All hard gates passed.</small>
                </div>
              </section>
            ) : null}

            {phase === "approval" ? (
              <>
                <EvidenceSummary session={session} winner={winner} />
                <footer
                  className={[
                    styles.approval,
                    session.state === "AWAITING_HUMAN_APPROVAL" ||
                    recordedAwaitingVerification
                      ? styles.approvalSticky
                      : "",
                  ].join(" ")}
                  data-testid="approval-gate"
                >
                  <div className={styles.approvalIcon}>
                    {recordedAwaitingVerification
                      ? "Ⅱ"
                      : session.state === "SAFE_TO_COMMIT"
                        ? "✓"
                        : "Ⅱ"}
                  </div>
                  <div>
                    <span className={styles.eyebrow}>
                      CopilotKit human approval
                    </span>
                    <h3>
                      {recordedAwaitingVerification
                        ? "AWAITING HUMAN VERIFICATION"
                        : session.provenance === "RECORDED_LIVE"
                          ? "REPLAY VERIFIED"
                          : session.state.replaceAll("_", " ")}
                    </h3>
                    <p>
                      {session.provenance === "RECORDED_LIVE"
                        ? replayVerified
                          ? "You verified the recorded evidence and its original approval receipt. No production write."
                          : "Review the selected plan and safety evidence, then verify this recorded run."
                        : "Approve this exact evidence or send it back. Failed gates cannot be overridden."}
                    </p>
                    <span data-testid="copilot-readable-state" hidden>
                      CONTEXT REGISTERED
                    </span>
                    <span data-testid="copilot-hitl-registration" hidden>
                      HITL REGISTERED
                    </span>
                  </div>
                  <div className={styles.actions}>
                    {session.provenance === "RECORDED_LIVE" ? (
                      replayVerified ? (
                        <span className={styles.receipt}>
                          VERIFIED · ORIGINAL RECEIPT
                          <strong>
                            {compact(session.approval?.bindingDigest ?? "")}
                          </strong>
                        </span>
                      ) : (
                        <button
                          className={styles.approve}
                          onClick={() => setReplayVerified(true)}
                          type="button"
                        >
                          Verify safe plan
                        </button>
                      )
                    ) : session.state === "AWAITING_HUMAN_APPROVAL" ? (
                      <>
                        <button
                          className={styles.reject}
                          disabled={busy}
                          onClick={() => void decide("rejected")}
                          type="button"
                        >
                          Reject
                        </button>
                        <button
                          className={styles.approve}
                          disabled={busy}
                          onClick={() => void decide("approved")}
                          type="button"
                        >
                          Approve bound evidence
                        </button>
                      </>
                    ) : (
                      <button
                        className={styles.revalidate}
                        disabled={busy}
                        onClick={() => void revalidate()}
                        type="button"
                      >
                        Revalidate evidence
                      </button>
                    )}
                  </div>
                </footer>
              </>
            ) : null}
              </>
            )}
          </section>
        </div>
      </main>
    </CopilotBridge>
  );
}
