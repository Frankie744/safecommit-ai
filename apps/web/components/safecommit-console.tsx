"use client";

import {
  ToolCallStatus,
  useAgentContext,
  useHumanInTheLoop,
} from "@copilotkit/react-core/v2";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

import {
  createDatabaseSession,
  decideDatabaseSession,
  listDatabaseSessions,
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

function compact(value: string, visible = 13): string {
  return value.length <= visible ? value : `${value.slice(0, visible)}…`;
}

function provenanceLabel(session: DatabaseSessionView | null): string {
  if (session === null) return "NO RUN • READ-ONLY";
  if (session.provenance === "MOCK") return "MOCK • NOT PROVIDER-VERIFIED";
  if (session.provenance === "LOCAL_TEST")
    return "LOCAL TEST • REAL MYSQL • NOT DAYTONA";
  if (session.provenance === "RECORDED_LIVE") return "RECORDED LIVE";
  return session.providerVerified ? "LIVE • PROVIDER-VERIFIED" : "LIVE • BLOCKED";
}

function CandidateCard({
  candidate,
  winner,
}: {
  candidate: DatabaseCandidateView;
  winner: boolean;
}) {
  return (
    <article
      className={[
        styles.candidate,
        candidate.eligible ? "" : styles.candidateFailed,
        winner ? styles.candidateWinner : "",
      ].join(" ")}
      data-testid={`candidate-${candidate.candidateId}`}
    >
      <header className={styles.candidateHeader}>
        <div>
          <span className={styles.micro}>{candidate.strategy}</span>
          <h3>{candidate.candidateId}</h3>
        </div>
        <span className={styles.score}>
          {candidate.weightedScore.toFixed(2)}
        </span>
      </header>
      <div className={styles.candidateBody}>
        <p>{candidate.hypothesis}</p>
        <div className={styles.facts}>
          <span>
            Rows<strong>{candidate.affectedRows}</strong>
          </span>
          <span>
            Warehouses<strong>{candidate.touchedWarehouses.length}</strong>
          </span>
          <span>
            Inventory Δ<strong>{candidate.inventoryDeltaUnits}</strong>
          </span>
        </div>
        <div className={styles.gateList}>
          {candidate.gates.map((gate) => (
            <span
              className={gate.passed ? styles.pass : styles.fail}
              key={gate.name}
              title={gate.explanation}
            >
              {gate.passed ? "✓" : "×"} {gate.name}
            </span>
          ))}
        </div>
        {!candidate.eligible ? (
          <p className={styles.fail} data-testid="eliminated-reason">
            BLOCKED: {candidate.failedGateNames.join(", ")}
          </p>
        ) : winner ? (
          <p className={styles.pass} data-testid="selected-plan">
            SELECTED: every non-negotiable gate passed
          </p>
        ) : null}
      </div>
    </article>
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
        <section data-testid="copilot-hitl-card">
          <strong>CopilotKit blocking database approval</strong>
          <p>{props.args.summary}</p>
          {!bindingMatches ? (
            <span className={styles.fail}>
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
  const [mode, setMode] = useState<"mock" | "local-test">("mock");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void listDatabaseSessions()
      .then((sessions) => setSession(sessions[0] ?? null))
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      );
  }, []);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setSession(await createDatabaseSession(operatorToken, mode));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
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
    if (session === null) return;
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

  return (
    <CopilotBridge session={session} onDecision={decide}>
      <main className={styles.shell}>
        <header className={styles.topbar}>
          <div className={styles.brand}>
            SafeCommit <span>database state gate</span>
          </div>
          <span className={styles.provenance} data-testid="provenance-label">
            {provenanceLabel(session)}
          </span>
        </header>

        <section className={styles.hero}>
          <div>
            <span className={styles.eyebrow}>
              The commit gate for AI database agents
            </span>
            <h1>
              Valid SQL can create an <em>invalid business.</em>
            </h1>
            <p>
              AI may propose a database change. Only a state transition proven
              safe against real business invariants may reach SAFE_TO_COMMIT.
            </p>
          </div>
          <aside className={styles.heroProof}>
            <strong>13</strong>
            <span>non-compensable database hard gates</span>
          </aside>
        </section>

        <section className={styles.control}>
          <input
            aria-label="Operator token"
            onChange={(event) => setOperatorToken(event.target.value)}
            placeholder="Operator token (server-validated, never persisted)"
            type="password"
            value={operatorToken}
          />
          <select
            aria-label="Execution mode"
            onChange={(event) =>
              setMode(event.target.value as "mock" | "local-test")
            }
            value={mode}
          >
            <option value="mock">MOCK contract demo</option>
            <option value="local-test">LOCAL TEST • MySQL 8</option>
          </select>
          <button
            disabled={busy || operatorToken.length === 0}
            onClick={() => void run()}
            type="button"
          >
            {busy ? "Running…" : "Run SafeCommit Tournament"}
          </button>
        </section>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}

        <section className={styles.statusRail}>
          {(["fireworks", "daytona", "braintrust", "copilotKitHitl"] as const).map(
            (provider) => (
              <div key={provider}>
                <span className={styles.micro}>{provider}</span>
                <strong>{session?.liveStatus[provider] ?? "BLOCKED"}</strong>
              </div>
            ),
          )}
        </section>

        {session === null ? (
          <section className={styles.empty}>
            Configure the operator token and start a labelled MOCK or LOCAL TEST
            run. Public visitors remain read-only.
          </section>
        ) : (
          <>
            <section className={styles.sectionHeader}>
              <div>
                <span className={styles.eyebrow}>Safety tournament</span>
                <h2>High score cannot compensate for unsafe state.</h2>
              </div>
              <p>{session.task.naturalLanguageRequest}</p>
            </section>

            <section className={styles.candidates}>
              {session.candidates.map((candidate) => (
                <CandidateCard
                  candidate={candidate}
                  key={candidate.candidateId}
                  winner={candidate.candidateId === session.winnerCandidateId}
                />
              ))}
            </section>

            <section className={styles.sectionHeader}>
              <div>
                <span className={styles.eyebrow}>State evidence</span>
                <h2>What actually changed?</h2>
              </div>
              <p>
                Fixture: {session.fixtureKind}. Commit means qualification for
                an upstream system, never an automatic production write.
              </p>
            </section>

            <section className={styles.delta}>
              <article className={styles.panel}>
                <h3>Selected plan row delta</h3>
                {winner?.rowDelta.map((delta) => (
                  <div className={styles.deltaRow} key={`${delta.table}-${delta.id}`}>
                    <strong>{delta.table}</strong>
                    <code>{delta.id}</code>
                    <span>{delta.summary}</span>
                  </div>
                ))}
              </article>
              <article className={styles.panel}>
                <h3>Approval binding</h3>
                {[
                  ["Evidence", session.currentEvidenceDigest],
                  ["Snapshot", session.snapshotDigest],
                  ["Schema", session.schemaFingerprint],
                  ["Intent", session.intentContractDigest],
                  ["Source", session.sourceCommitSha],
                ].map(([label, value]) => (
                  <div className={styles.bindingRow} key={label}>
                    <strong>{label}</strong>
                    <code>{compact(value ?? "", 18)}</code>
                    <span>{value}</span>
                  </div>
                ))}
                {session.approval?.invalidatedAt ? (
                  <p className={styles.fail} data-testid="approval-invalidated">
                    INVALIDATED — {session.approval.invalidationReason}
                  </p>
                ) : null}
              </article>
            </section>

            <footer className={styles.approval} data-testid="approval-gate">
              <div>
                <span className={styles.eyebrow}>
                  CopilotKit HITL • server enforced
                </span>
                <h3>{session.state}</h3>
                <p>
                  The human can approve only the selected eligible candidate
                  bound to the exact evidence above.
                </p>
                <span data-testid="copilot-readable-state" hidden>
                  CONTEXT REGISTERED
                </span>
                <span data-testid="copilot-hitl-registration" hidden>
                  HITL REGISTERED
                </span>
              </div>
              <div className={styles.actions}>
                {session.state === "AWAITING_HUMAN_APPROVAL" ? (
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
        )}
      </main>
    </CopilotBridge>
  );
}
