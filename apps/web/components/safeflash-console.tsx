"use client";

import {
  ToolCallStatus,
  useAgentContext,
  useHumanInTheLoop,
} from "@copilotkit/react-core/v2";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { z } from "zod";

import {
  createSession,
  getSession,
  listSessions,
  retrySession,
  submitSessionDecision,
} from "../lib/session-api";
import {
  TERMINAL_STATES,
  type CandidateEvidenceView,
  type CandidateView,
  type DecisionAction,
  type EvidenceProvenance,
  type SessionMode,
  type SessionView,
} from "../lib/session-types";

const POLL_INTERVAL_MS = 1_200;

const approvalToolParameters = z.object({
  sessionId: z.string(),
  candidateId: z.string(),
  evidenceDigest: z.string(),
  patchDigest: z.string(),
  commitSha: z.string(),
  policyVersion: z.string(),
  summary: z.string(),
});

type ApprovalToolArguments = z.infer<typeof approvalToolParameters>;

function compactIdentifier(value: string | undefined, visible = 11): string {
  if (!value) return "unreported";
  return value.length <= visible ? value : value.slice(0, visible) + "…";
}

function humanizeState(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatTime(value: string | undefined): string {
  if (!value) return "time unreported";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "time unreported";
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function modeLabel(mode: SessionMode): string {
  switch (mode) {
    case "live":
      return "LIVE API SESSION";
    case "cached":
      return "RECORDED REAL EVIDENCE • NOT LIVE";
    case "mock":
      return "MOCK • NOT PROVIDER-VERIFIED";
    case "hybrid":
      return "HYBRID • CHECK EACH SOURCE";
    default:
      return "UNVERIFIED SESSION MODE";
  }
}

function provenanceLabel(provenance: EvidenceProvenance): string {
  const provider = provenance.provider.toUpperCase();
  switch (provenance.kind) {
    case "mock":
      return "MOCK " + provider + " • NOT PROVIDER-VERIFIED";
    case "local-test":
      return "LOCAL TEST " + provider + " • NOT PROVIDER-VERIFIED";
    case "recorded-live":
      return provenance.verified
        ? "RECORDED REAL " + provider
        : "RECORDED " + provider + " • UNVERIFIED";
    case "live":
      return provenance.verified
        ? "LIVE " + provider + " • PROVIDER-VERIFIED"
        : "LIVE " + provider + " • UNVERIFIED";
    case "manual-verified":
      return "MANUAL VERIFIED • " + provider;
    case "server-owned":
      return provenance.verified
        ? "SERVER EVENT • " + provider
        : "SERVER EVENT • UNVERIFIED " + provider;
    default:
      return "SOURCE UNVERIFIED • " + provider;
  }
}

function ProvenanceBadge({
  provenance,
}: {
  provenance: EvidenceProvenance;
}) {
  const details = [
    provenance.externalId,
    provenance.capturedAt,
    provenance.url,
  ]
    .filter(Boolean)
    .join(" • ");

  return (
    <span
      className={"provenance provenance--" + provenance.kind}
      data-testid="provenance-badge"
      title={details || "No external identifier reported"}
    >
      {provenanceLabel(provenance)}
    </span>
  );
}

function ShieldMark() {
  return (
    <svg
      aria-hidden="true"
      className="shield-mark"
      viewBox="0 0 28 32"
      role="img"
    >
      <path
        d="M14 1.8 25 6v8.4c0 7.2-4.4 12.5-11 15.8C7.4 26.9 3 21.6 3 14.4V6l11-4.2Z"
        fill="currentColor"
      />
      <path
        d="m9.2 15.7 3.1 3.1 6.8-7.1"
        fill="none"
        stroke="#07101a"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.5"
      />
    </svg>
  );
}

function StatusPip({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const tone =
    normalized.includes("pass") ||
    normalized.includes("ready") ||
    normalized.includes("eligible")
      ? "pass"
      : normalized.includes("fail") ||
          normalized.includes("reject") ||
          normalized.includes("block")
        ? "fail"
        : normalized.includes("run") ||
            normalized.includes("build") ||
            normalized.includes("pending")
          ? "active"
          : "neutral";
  return <span aria-hidden="true" className={"status-pip status-pip--" + tone} />;
}

function EvidenceRow({
  label,
  value,
  status,
  evidence,
}: {
  label: string;
  value: ReactNode;
  status: string;
  evidence: Pick<CandidateEvidenceView, "provenance">;
}) {
  return (
    <div className="evidence-row">
      <div className="evidence-row__line">
        <span className="evidence-row__label">
          <StatusPip status={status} />
          {label}
        </span>
        <strong className="evidence-row__value">{value}</strong>
      </div>
      <ProvenanceBadge provenance={evidence.provenance} />
    </div>
  );
}

function CandidateCard({ candidate }: { candidate: CandidateView }) {
  const gate =
    candidate.safetyGate.hardGatePassed === null
      ? "PENDING"
      : candidate.safetyGate.hardGatePassed
        ? "PASS"
        : "FAIL";
  const score =
    candidate.score.weighted === null
      ? "—"
      : (
          candidate.score.weighted <= 1
            ? candidate.score.weighted * 100
            : candidate.score.weighted
        ).toFixed(1);
  const cardState = candidate.selected
    ? "winner"
    : candidate.eliminatedReason
      ? "eliminated"
      : "running";
  const hasVerifiedBraintrustScore =
    candidate.score.provenance.provider.toLowerCase() === "braintrust" &&
    candidate.score.provenance.verified &&
    !["mock", "local-test", "unknown"].includes(
      candidate.score.provenance.kind,
    );

  return (
    <article
      className={"candidate-card candidate-card--" + cardState}
      data-candidate-state={cardState}
      data-testid="candidate-card"
    >
      <header className="candidate-card__header">
        <div>
          <span className="eyebrow">
            {candidate.label}
            {candidate.validationRound === undefined
              ? ""
              : ` · ROUND ${candidate.validationRound}`}
          </span>
          <h3>{candidate.strategy}</h3>
        </div>
        <span className={"decision-tag decision-tag--" + cardState}>
          {candidate.selected
            ? "SELECTED"
            : candidate.eliminatedReason
              ? "INELIGIBLE"
              : "EVALUATING"}
        </span>
      </header>

      {candidate.hypothesis ? (
        <p className="candidate-card__hypothesis">{candidate.hypothesis}</p>
      ) : null}

      {candidate.generation ? (
        <div className="evidence-row" data-testid="candidate-generation">
          <div className="evidence-row__line">
            <span className="evidence-row__label">Fireworks generation</span>
            <strong className="evidence-row__value">
              {candidate.generation.model ??
                candidate.generation.profile ??
                "captured"}
            </strong>
          </div>
          <ProvenanceBadge provenance={candidate.generation.provenance} />
        </div>
      ) : null}

      <div className="candidate-card__evidence">
        <div className="evidence-row">
          <div className="evidence-row__line">
            <span className="evidence-row__label">
              <StatusPip status={candidate.sandbox.status} />
              Sandbox
            </span>
            <strong className="evidence-row__value">
              {candidate.sandbox.id
                ? compactIdentifier(candidate.sandbox.id)
                : candidate.sandbox.status}
            </strong>
          </div>
          <ProvenanceBadge provenance={candidate.sandbox.provenance} />
        </div>
        <EvidenceRow
          evidence={candidate.build}
          label="Build"
          status={candidate.build.status}
          value={candidate.build.status.toUpperCase()}
        />
        <EvidenceRow
          evidence={candidate.tests}
          label="Tests"
          status={candidate.tests.status}
          value={candidate.tests.passed + "/" + candidate.tests.total}
        />
        <EvidenceRow
          evidence={candidate.safetyGate}
          label="Hard safety gate"
          status={gate}
          value={gate}
        />
      </div>

      <div className="candidate-score">
        <div>
          <span>
            {hasVerifiedBraintrustScore
              ? "Braintrust score"
              : "Local evaluation score"}
          </span>
          <strong>{score === "—" ? score : score + "%"}</strong>
        </div>
        <span
          className={
            "eligibility eligibility--" +
            (candidate.score.eligible === null
              ? "pending"
              : candidate.score.eligible
                ? "eligible"
                : "ineligible")
          }
        >
          {candidate.score.eligible === null
            ? "EVALUATING"
            : candidate.score.eligible
              ? "ELIGIBLE"
              : "NOT ELIGIBLE"}
        </span>
        <ProvenanceBadge provenance={candidate.score.provenance} />
      </div>

      {candidate.eliminatedReason ? (
        <div className="rejection-evidence" data-testid="rejection-evidence">
          <span>Rejected with evidence</span>
          <strong>{candidate.eliminatedReason}</strong>
          {candidate.safetyGate.failures.length > 0 ? (
            <ul>
              {candidate.safetyGate.failures.map((failure) => (
                <li key={failure}>{failure}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {candidate.diff ? (
        <details className="candidate-diff">
          <summary>Inspect candidate diff</summary>
          <pre>{candidate.diff}</pre>
        </details>
      ) : null}
    </article>
  );
}

function IncidentPanel({ session }: { session: SessionView }) {
  const danger =
    session.incident.sensorFault && session.incident.chargingEnabled;

  return (
    <section className="panel incident-panel" aria-labelledby="incident-title">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Physical incident</span>
          <h2 id="incident-title">{session.incident.title}</h2>
        </div>
        <span className={"severity severity--" + session.incident.severity}>
          {session.incident.severity.toUpperCase()}
        </span>
      </div>

      <div
        className={"danger-readout " + (danger ? "danger-readout--unsafe" : "")}
        data-testid={danger ? "danger-state" : "incident-state"}
      >
        <div className="temperature-reading">
          <strong>
            {session.incident.temperatureC === null
              ? "—"
              : String(session.incident.temperatureC)}
          </strong>
          <span>°C</span>
        </div>
        <div className="danger-flags">
          <span>
            <StatusPip
              status={session.incident.sensorFault ? "failed" : "passed"}
            />
            SENSOR {session.incident.sensorFault ? "FAULT" : "HEALTHY"}
          </span>
          <span>
            <StatusPip
              status={session.incident.chargingEnabled ? "failed" : "passed"}
            />
            CHARGING {session.incident.chargingEnabled ? "ON" : "OFF"}
          </span>
        </div>
      </div>
      <p className="incident-summary">{session.incident.summary}</p>
      <ProvenanceBadge provenance={session.incident.provenance} />

      <div className="incident-evidence">
        <span className="section-label">Observed evidence</span>
        {session.incident.evidence.length === 0 ? (
          <p className="muted">No incident evidence reported by the API.</p>
        ) : (
          <ul>
            {session.incident.evidence.map((evidence) => (
              <li key={evidence}>{evidence}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="policy-block">
        <div className="section-header">
          <div>
            <span className="section-label">Safety policy</span>
            <strong>{session.policy.name}</strong>
          </div>
          <span className="policy-version">{session.policy.version}</span>
        </div>
        <ProvenanceBadge provenance={session.policy.provenance} />
        <ol className="invariant-list">
          {session.policy.invariants.map((invariant) => (
            <li key={invariant.id}>
              <span aria-hidden="true">{invariant.hardGate ? "◆" : "◇"}</span>
              <span>{invariant.description}</span>
              <small>{invariant.hardGate ? "HARD GATE" : "ADVISORY"}</small>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function TimelinePanel({ session }: { session: SessionView }) {
  const events = [...session.events].sort(
    (left, right) => right.sequence - left.sequence,
  );

  return (
    <section className="panel timeline-panel" aria-labelledby="timeline-title">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Append-only audit</span>
          <h2 id="timeline-title">Agent timeline</h2>
        </div>
        <span className="event-count">{events.length} events</span>
      </div>
      <div className="current-tool">
        <span className="live-dot" aria-hidden="true" />
        <div>
          <span>Current orchestrator state</span>
          <strong>{humanizeState(session.state)}</strong>
        </div>
      </div>
      {session.review ? (
        <div className="current-tool" data-testid="coderabbit-review">
          <div>
            <span>
              CodeRabbit review round {session.review.round} · {session.review.status}
            </span>
            <strong>
              {session.review.findings.length} finding
              {session.review.findings.length === 1 ? "" : "s"}
            </strong>
            {session.review.findings.length > 0 ? (
              <ul className="rejection-list" data-testid="coderabbit-findings">
                {session.review.findings.map((finding) => (
                  <li key={finding.id}>
                    <strong>
                      {finding.severity.toUpperCase()} · {finding.title}
                    </strong>
                    <span>
                      {finding.filePath ?? "Pull request"}
                      {finding.line === undefined ? "" : `:${finding.line}`} · {finding.body}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <ProvenanceBadge provenance={session.review.provenance} />
          </div>
        </div>
      ) : null}
      <ol className="timeline-list" data-testid="timeline">
        {events.length === 0 ? (
          <li className="timeline-empty">
            No audit events have been reported by the API.
          </li>
        ) : (
          events.map((event) => (
            <li className="timeline-event" key={event.id}>
              <div className="timeline-rail">
                <span>{String(event.sequence).padStart(2, "0")}</span>
              </div>
              <div className="timeline-copy">
                <div>
                  <strong>{event.title}</strong>
                  <time dateTime={event.occurredAt}>
                    {formatTime(event.occurredAt)}
                  </time>
                </div>
                <span className="timeline-state">{event.state}</span>
                <p>{event.summary}</p>
                <ProvenanceBadge provenance={event.provenance} />
              </div>
            </li>
          ))
        )}
      </ol>
    </section>
  );
}

interface ApprovalGateProps {
  session: SessionView;
  busyDecision: DecisionAction | null;
  onDecision: (decision: DecisionAction) => Promise<SessionView>;
}

function ApprovalGate({
  session,
  busyDecision,
  onDecision,
}: ApprovalGateProps) {
  const selected = session.candidates.find(
    (candidate) => candidate.id === session.selectedCandidateId,
  );
  const approvalIsCurrent =
    session.approval?.decision === "approved" &&
    !session.approval.invalidatedAt &&
    session.approval.evidenceDigest === session.currentEvidenceDigest;
  const canDecide =
    session.state === "AWAITING_HUMAN_APPROVAL" &&
    selected !== undefined &&
    session.currentEvidenceDigest !== undefined &&
    !approvalIsCurrent;
  const ready = session.state === "READY_TO_MERGE";
  const pullRequestIsContractOnly =
    session.pullRequest?.provenance.kind === "mock" ||
    session.pullRequest?.provenance.kind === "local-test";

  return (
    <footer className="approval-gate" data-testid="approval-gate">
      <div className="approval-copy">
        <div className="approval-title">
          <span className="gate-icon" aria-hidden="true">
            ⛨
          </span>
          <div>
            <span className="eyebrow">Evidence-bound human approval</span>
            <strong>
              {ready
                ? "Ready for human merge"
                : approvalIsCurrent
                  ? session.mode === "live"
                    ? "Approval recorded — backend owns PR transition"
                    : "Approval recorded — live publish remains blocked"
                  : "The agent cannot cross this boundary"}
            </strong>
          </div>
        </div>
        <div className="binding-grid">
          <span>
            Candidate
            <strong>{selected?.label ?? "not selected"}</strong>
          </span>
          <span>
            Evidence
            <strong>
              {compactIdentifier(session.currentEvidenceDigest, 14)}
            </strong>
          </span>
          <span>
            Patch
            <strong>{compactIdentifier(session.currentPatchDigest, 14)}</strong>
          </span>
          <span>
            Policy
            <strong>{session.policy.version}</strong>
          </span>
        </div>
      </div>

      <div className="approval-actions">
        <div className="copilot-assurance">
          <span data-testid="copilot-readable-state">
            COPILOTKIT V2 • STATE SHARED
          </span>
          <span data-testid="copilot-hitl-registration">
            HITL REGISTERED • SERVER ENFORCED
          </span>
        </div>
        <div className="decision-buttons">
          <button
            className="button button--ghost"
            data-testid="request-changes-decision"
            disabled={!canDecide || busyDecision !== null}
            onClick={() => void onDecision("changes_requested")}
            type="button"
          >
            Request changes
          </button>
          <button
            className="button button--danger"
            data-testid="reject-decision"
            disabled={!canDecide || busyDecision !== null}
            onClick={() => void onDecision("rejected")}
            type="button"
          >
            Reject
          </button>
          <button
            className="button button--approve"
            data-testid="approve-decision"
            disabled={!canDecide || busyDecision !== null}
            onClick={() => void onDecision("approved")}
            type="button"
          >
            {busyDecision === "approved"
              ? "Recording…"
              : session.mode === "live"
                ? "Approve PR creation"
                : "Approve evidence (no live PR)"}
          </button>
        </div>
        {session.pullRequest?.url ? (
          <div className="pr-record">
            <a
              className="pr-link"
              data-testid="pull-request-link"
              href={session.pullRequest.url}
              rel="noreferrer"
              target="_blank"
            >
              {pullRequestIsContractOnly ? "TEST CONTRACT PR" : "GitHub PR"} #{
                session.pullRequest.number
              } ↗
            </a>
            <span data-testid="pull-request-provenance">
              <ProvenanceBadge provenance={session.pullRequest.provenance} />
            </span>
          </div>
        ) : (
          <span
            aria-disabled="true"
            className="pr-link pr-link--disabled"
            data-testid="pull-request-link"
          >
            {session.mode === "live" && approvalIsCurrent
              ? "PR publication and independent review in progress"
              : "PR unavailable before valid approval"}
          </span>
        )}
        {ready ? (
          <span className="ready-stamp" data-testid="ready-to-merge">
            READY FOR HUMAN MERGE
          </span>
        ) : null}
      </div>
    </footer>
  );
}

function CopilotSessionBridge({
  session,
  onDecision,
  children,
}: {
  session: SessionView | null;
  onDecision: (decision: DecisionAction) => Promise<SessionView>;
  children: ReactNode;
}) {
  const readableState = useMemo(
    () =>
      JSON.stringify({
        sessionId: session?.id ?? null,
        state: session?.state ?? "NO_SESSION",
        mode: session?.mode ?? "unknown",
        selectedCandidateId: session?.selectedCandidateId ?? null,
        evidenceDigest: session?.currentEvidenceDigest ?? null,
        patchDigest: session?.currentPatchDigest ?? null,
        commitSha: session?.currentCommitSha ?? null,
        policyVersion: session?.policy.version ?? null,
        candidates:
          session?.candidates.map((candidate) => ({
            id: candidate.id,
            strategy: candidate.strategy,
            eligible: candidate.score.eligible,
            hardGatePassed: candidate.safetyGate.hardGatePassed,
            eliminatedReason: candidate.eliminatedReason ?? null,
          })) ?? [],
      }),
    [session],
  );

  useAgentContext({
    description:
      "Current SafeFlash validation snapshot. This context is read-only; only the server may advance safety gates.",
    value: readableState,
  });

  useHumanInTheLoop<ApprovalToolArguments>(
    {
      name: "request_firmware_approval",
      agentId: "safeflash",
      available:
        session?.state === "AWAITING_HUMAN_APPROVAL" &&
        session.currentEvidenceDigest !== undefined,
      description:
        "Pause before PR creation and ask a human to decide against the exact evidence digest.",
      parameters: approvalToolParameters,
      render: (props) => {
        const requestedSession = props.args.sessionId;
        const requestedCandidate = props.args.candidateId;
        const requestedEvidence = props.args.evidenceDigest;
        const requestedPatch = props.args.patchDigest;
        const requestedCommit = props.args.commitSha;
        const requestedPolicy = props.args.policyVersion;
        const bindingMatches =
          session !== null &&
          requestedSession === session.id &&
          requestedCandidate === session.selectedCandidateId &&
          requestedEvidence === session.currentEvidenceDigest &&
          requestedPatch === session.currentPatchDigest &&
          requestedCommit === session.currentCommitSha &&
          requestedPolicy === session.policy.version;

        if (props.status === ToolCallStatus.Executing) {
          const respond = props.respond;
          const decide = async (decision: DecisionAction) => {
            if (!bindingMatches) return;
            const updated = await onDecision(decision);
            await respond({
              decision,
              sessionId: updated.id,
              state: updated.state,
              evidenceDigest: requestedEvidence,
            });
          };

          return (
            <section
              className="copilot-hitl-card"
              data-testid="copilot-hitl-card"
            >
              <strong>CopilotKit human approval interrupt</strong>
              <p>{props.args.summary}</p>
              <code>{compactIdentifier(requestedEvidence, 18)}</code>
              {!bindingMatches ? (
                <span className="binding-error">
                  Evidence changed. This interrupt cannot approve the session.
                </span>
              ) : (
                <div>
                  <button onClick={() => void decide("rejected")} type="button">
                    Reject
                  </button>
                  <button
                    onClick={() => void decide("changes_requested")}
                    type="button"
                  >
                    Request changes
                  </button>
                  <button onClick={() => void decide("approved")} type="button">
                    Approve bound evidence
                  </button>
                </div>
              )}
            </section>
          );
        }

        return (
          <section className="copilot-hitl-card">
            <strong>CopilotKit approval tool</strong>
            <span>{humanizeState(props.status)}</span>
          </section>
        );
      },
    },
    [
      session?.id,
      session?.state,
      session?.selectedCandidateId,
      session?.currentEvidenceDigest,
      session?.currentPatchDigest,
      session?.currentCommitSha,
      session?.policy.version,
      onDecision,
    ],
  );

  return children;
}

export function SafeFlashConsole() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [busyDecision, setBusyDecision] = useState<DecisionAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollWarning, setPollWarning] = useState<string | null>(null);

  const loadInitialSession = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sessions = await listSessions();
      if (sessions.length === 0) {
        setSession(null);
        return;
      }

      const summary = sessions[0];
      try {
        setSession(await getSession(summary.id));
      } catch {
        setSession(summary);
        setPollWarning(
          "Detail endpoint unavailable; showing the API list snapshot without inventing missing evidence.",
        );
      }
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load SafeFlash sessions.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadInitialSession();
  }, [loadInitialSession]);

  useEffect(() => {
    if (!session || TERMINAL_STATES.has(session.state)) return;
    const approvalIsCurrent =
      session.approval?.decision === "approved" &&
      !session.approval.invalidatedAt &&
      session.approval.evidenceDigest === session.currentEvidenceDigest;
    if (approvalIsCurrent && session.mode !== "live") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void getSession(session.id)
        .then((updated) => {
          if (cancelled) return;
          setSession(updated);
          setPollWarning(null);
        })
        .catch((pollError: unknown) => {
          if (cancelled) return;
          setPollWarning(
            pollError instanceof Error
              ? "Live refresh paused: " + pollError.message
              : "Live refresh paused.",
          );
        });
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [session]);

  const handleStart = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      const created = await createSession();
      setSession(created);
    } catch (startError) {
      setError(
        startError instanceof Error
          ? startError.message
          : "Unable to start a validation session.",
      );
    } finally {
      setStarting(false);
    }
  }, []);

  const handleDecision = useCallback(
    async (decision: DecisionAction): Promise<SessionView> => {
      if (!session) throw new Error("No active session to approve.");
      setBusyDecision(decision);
      setError(null);
      try {
        const updated = await submitSessionDecision(session, decision);
        setSession(updated);
        return updated;
      } catch (decisionError) {
        setError(
          decisionError instanceof Error
            ? decisionError.message
            : "The backend rejected the decision.",
        );
        throw decisionError;
      } finally {
        setBusyDecision(null);
      }
    },
    [session],
  );

  const handleRetry = useCallback(async () => {
    if (!session) return;
    setRetrying(true);
    setError(null);
    try {
      setSession(await retrySession(session.id));
    } catch (retryError) {
      setError(
        retryError instanceof Error
          ? retryError.message
          : "The backend rejected the resume request.",
      );
    } finally {
      setRetrying(false);
    }
  }, [session]);

  return (
    <CopilotSessionBridge session={session} onDecision={handleDecision}>
      <main className="console-shell" data-testid="safeflash-console">
        <header className="topbar">
          <div className="brand">
            <ShieldMark />
            <div>
              <strong>SafeFlash</strong>
              <span>The safety gate for AI-generated firmware</span>
            </div>
          </div>

          <div className="session-metadata">
            <span
              className={"mode-badge mode-badge--" + (session?.mode ?? "unknown")}
              data-testid="mode-badge"
            >
              {modeLabel(session?.mode ?? "unknown")}
            </span>
            <span className="metadata-item">
              SESSION
              <strong data-testid="session-id">
                {compactIdentifier(session?.id, 16)}
              </strong>
            </span>
            <span className="metadata-item">
              COMMIT
              <strong data-testid="commit-sha">
                {compactIdentifier(session?.currentCommitSha, 12)}
              </strong>
            </span>
            <span className="metadata-item">
              STATE
              <strong data-testid="workflow-state">
                {humanizeState(session?.state ?? "NO_SESSION")}
              </strong>
            </span>
          </div>
        </header>

        {error ? (
          <div className="error-banner" data-testid="api-error" role="alert">
            <strong>Backend evidence unavailable.</strong>
            <span>{error} No provider success is being claimed.</span>
            <button onClick={() => void loadInitialSession()} type="button">
              Retry
            </button>
          </div>
        ) : null}
        {pollWarning ? (
          <div className="warning-banner" role="status">
            {pollWarning}
          </div>
        ) : null}
        {session?.failure ? (
          <div className="error-banner" data-testid="workflow-failure" role="alert">
            <strong>Workflow failed closed.</strong>
            <span>
              {session.failure.reason} {session.failure.recoverable
                ? `Resume action: ${session.failure.retryAction ?? "available"}.`
                : "This failure is not recoverable from the UI."}
            </span>
            {session.failure.recoverable ? (
              <button
                data-testid="resume-live-workflow"
                disabled={retrying}
                onClick={() => void handleRetry()}
                type="button"
              >
                {retrying ? "Resuming…" : "Resume live workflow"}
              </button>
            ) : null}
          </div>
        ) : null}

        {loading && session === null ? (
          <section className="loading-state" data-testid="loading-state">
            <span className="loading-mark" aria-hidden="true" />
            <strong>Loading session state from the SafeFlash API…</strong>
            <p>No demo animation is playing. The console is awaiting API data.</p>
          </section>
        ) : session === null ? (
          <section className="empty-state" data-testid="empty-state">
            <ShieldMark />
            <span className="eyebrow">No validation session reported</span>
            <h1>Start with executable evidence.</h1>
            <p>
              This creates a server-owned Battery Sensor Disconnect tournament.
              The UI will only display states returned by the API.
            </p>
            <button
              className="button button--approve"
              data-testid="start-tournament"
              disabled={starting}
              onClick={() => void handleStart()}
              type="button"
            >
              {starting ? "Starting…" : "Run Safety Tournament"}
            </button>
          </section>
        ) : (
          <>
            <div className="workspace-grid">
              <IncidentPanel session={session} />

              <section
                className="panel tournament-panel"
                aria-labelledby="tournament-title"
              >
                <div className="panel-heading tournament-heading">
                  <div>
                    <span className="eyebrow">Evidence-based selection</span>
                    <h2 id="tournament-title">Safety tournament</h2>
                  </div>
                  <div className="tournament-legend">
                    <span>
                      <StatusPip status="failed" />
                      hard gate
                    </span>
                    <span>
                      <StatusPip status="passed" />
                      eligible
                    </span>
                  </div>
                </div>
                <div className="candidate-grid" data-testid="candidate-grid">
                  {session.candidates.length === 0 ? (
                    <div className="candidate-empty">
                      Candidate evidence has not been reported by the API.
                    </div>
                  ) : (
                    session.candidates.map((candidate) => (
                      <CandidateCard candidate={candidate} key={candidate.id} />
                    ))
                  )}
                </div>
                <div className="selection-rule">
                  <span aria-hidden="true">◆</span>
                  <strong>Hard gates run before weighted ranking.</strong>
                  <span>
                    A high average score cannot compensate for unsafe firmware.
                  </span>
                </div>
              </section>

              <TimelinePanel session={session} />
            </div>

            <ApprovalGate
              busyDecision={busyDecision}
              onDecision={handleDecision}
              session={session}
            />
          </>
        )}
      </main>
    </CopilotSessionBridge>
  );
}
