"use client";

import type { DeviceTelemetrySnapshot } from "../lib/device-types";
import type {
  EvidenceProvenance,
  SessionMode,
  SessionView,
} from "../lib/session-types";

function modeLabel(mode: SessionMode): string {
  switch (mode) {
    case "live":
      return "LIVE PROVIDERS";
    case "cached":
      return "RECORDED LIVE";
    case "mock":
      return "MOCK PROVIDERS";
    case "hybrid":
      return "HYBRID SOURCES";
    default:
      return "PROVIDER MODE PENDING";
  }
}

function approvalStatus(session: SessionView): string {
  if (session.approval?.invalidatedAt) return "INVALIDATED";
  if (session.state === "FAILED") return "BLOCKED";
  if (session.approval?.decision === "approved") return "APPROVED";
  if (session.approval?.decision === "rejected") return "REJECTED";
  if (session.approval?.decision === "changes_requested") {
    return "CHANGES REQUESTED";
  }
  return session.state === "AWAITING_HUMAN_APPROVAL"
    ? "AWAITING HUMAN"
    : "NOT REACHED";
}

function verified(provenance: EvidenceProvenance | undefined): string {
  if (provenance === undefined) return "NOT RUN";
  if (provenance.kind === "recorded-live") return "RECORDED";
  return provenance.verified ? "VERIFIED" : "NOT VERIFIED";
}

function readyFreshnessBlocked(session: SessionView): boolean {
  return (
    session.state === "FAILED" &&
    session.failure?.retryAction === "retry-ready-freshness-check"
  );
}

function sanitizedSession(session: SessionView): unknown {
  return {
    ...session,
    approval:
      session.approval === undefined
        ? undefined
        : {
            ...session.approval,
            approverDisplayName: undefined,
          },
    candidates: session.candidates.map((candidate) => ({
      ...candidate,
      diff: candidate.diff === undefined ? undefined : "[available above]",
    })),
  };
}

export function CompetitionStatusRail({
  session,
  device,
}: {
  session: SessionView;
  device: DeviceTelemetrySnapshot | null;
}) {
  const gateFailures = session.candidates.filter(
    (candidate) => candidate.safetyGate.hardGatePassed === false,
  ).length;
  const gatePasses = session.candidates.filter(
    (candidate) => candidate.safetyGate.hardGatePassed === true,
  ).length;
  const gatePending =
    session.candidates.length - gateFailures - gatePasses;
  const gateStatus =
    session.candidates.length === 0
      ? session.state === "FAILED"
        ? "FAIL CLOSED"
        : "PENDING"
      : `${session.state === "FAILED" ? "FAIL CLOSED · " : ""}${gateFailures} REJECTED / ${gatePasses} PASSED / ${gatePending} PENDING`;
  return (
    <section
      aria-label="Competition status"
      className="competition-status"
      data-testid="competition-status"
    >
      <div>
        <span>Mode</span>
        <strong data-testid="competition-mode">{modeLabel(session.mode)}</strong>
      </div>
      <div>
        <span>Agent phase</span>
        <strong data-testid="agent-phase">
          {session.state.replaceAll("_", " ")}
        </strong>
      </div>
      <div>
        <span>Safety gate</span>
        <strong data-testid="hard-gate-summary">{gateStatus}</strong>
      </div>
      <div>
        <span>Human approval</span>
        <strong data-testid="human-approval-status">
          {approvalStatus(session)}
        </strong>
      </div>
      <div>
        <span>GitHub PR</span>
        <strong data-testid="github-pr-status">
          {session.pullRequest
            ? readyFreshnessBlocked(session)
              ? `#${session.pullRequest.number} / READINESS BLOCKED`
              : session.state === "FAILED"
                ? `#${session.pullRequest.number} / WORKFLOW BLOCKED`
              : `#${session.pullRequest.number} ${session.pullRequest.status.toUpperCase()}`
            : "NOT CREATED"}
        </strong>
      </div>
      <div>
        <span>CodeRabbit</span>
        <strong data-testid="coderabbit-status">
          {readyFreshnessBlocked(session)
            ? "BLOCKED / FRESHNESS UNKNOWN"
            : session.review
              ? `${session.review.status.toUpperCase()} / ${verified(
                  session.review.provenance,
                )}`
              : "NOT RUN"}
        </strong>
      </div>
      <div>
        <span>Daytona cleanup</span>
        <strong data-testid="daytona-cleanup-status">
          {session.cleanup?.status.toUpperCase() ?? "NOT RUN"}
        </strong>
      </div>
      <div>
        <span>Device</span>
        <strong data-testid="device-status">
          {device?.displayLabel ?? "SIMULATED DEVICE"}
        </strong>
      </div>
    </section>
  );
}

export function EvidenceDrawer({ session }: { session: SessionView }) {
  return (
    <details className="evidence-drawer" data-testid="evidence-drawer">
      <summary>Open evidence and immutable provider IDs</summary>
      <div className="evidence-drawer__body">
        <section>
          <h2>Incident and safety policy</h2>
          <p>{session.incident.summary}</p>
          <ul>
            {session.incident.evidence.map((evidence) => (
              <li key={evidence}>{evidence}</li>
            ))}
          </ul>
          <dl className="evidence-binding">
            <div>
              <dt>Policy</dt>
              <dd>{session.policy.name}</dd>
            </div>
            <div>
              <dt>Policy version</dt>
              <dd>
                <code>{session.policy.version}</code>
              </dd>
            </div>
          </dl>
          <ol className="evidence-policy-list">
            {session.policy.invariants.map((invariant) => (
              <li key={invariant.id}>
                <strong>
                  {invariant.hardGate ? "HARD GATE" : "ADVISORY"} ·{" "}
                  {invariant.id}
                </strong>
                <span>{invariant.description}</span>
              </li>
            ))}
          </ol>
        </section>

        <section>
          <h2>Binding</h2>
          <dl className="evidence-binding">
            <div>
              <dt>Session ID</dt>
              <dd>
                <code data-testid="session-id">{session.id}</code>
              </dd>
            </div>
            <div>
              <dt>Base commit</dt>
              <dd>
                <code>{session.repository.commitSha}</code>
              </dd>
            </div>
            <div>
              <dt>Current head</dt>
              <dd>
                <code data-testid="commit-sha">{session.currentCommitSha}</code>
              </dd>
            </div>
            <div>
              <dt>Patch digest</dt>
              <dd>
                <code>{session.currentPatchDigest ?? "not available"}</code>
              </dd>
            </div>
            <div>
              <dt>Evidence digest</dt>
              <dd>
                <code>{session.currentEvidenceDigest ?? "not available"}</code>
              </dd>
            </div>
          </dl>
        </section>

        <section>
          <h2>Provider evidence</h2>
          <div className="provider-evidence-grid">
            {(session.providerEvidence ?? []).map((provider) => (
              <article key={provider.provider}>
                <header>
                  <strong>{provider.provider.toUpperCase()}</strong>
                  <span>{provider.status.toUpperCase()}</span>
                </header>
                <p>{provider.operation}</p>
                <span>
                  Provenance: {provider.provenance.kind} /{" "}
                  {provider.provenance.verified ? "verified" : "not verified"}
                </span>
                {(provider.requestIds?.length ?? 0) > 0 ? (
                  <div>
                    <span>Request IDs</span>
                    {provider.requestIds!.map((id) => (
                      <code key={id}>{id}</code>
                    ))}
                  </div>
                ) : provider.requestId ? (
                  <div>
                    <span>Request ID</span>
                    <code>{provider.requestId}</code>
                  </div>
                ) : (
                  <span>Request ID: not available</span>
                )}
                {provider.resourceIds.map((id) => (
                  <code key={id}>{id}</code>
                ))}
                {provider.urls.map((url) => (
                  <a href={url} key={url} rel="noreferrer" target="_blank">
                    {url}
                  </a>
                ))}
              </article>
            ))}
          </div>
        </section>

        <section>
          <h2>Daytona cleanup</h2>
          <p>{session.cleanup?.summary ?? "No cleanup evidence reported."}</p>
          {(session.cleanup?.sandboxIds ?? []).map((id) => (
            <code key={id}>{id}</code>
          ))}
        </section>

        <section>
          <h2>Append-only audit events</h2>
          <ol className="evidence-event-list">
            {[...session.events]
              .sort((left, right) => left.sequence - right.sequence)
              .map((event) => (
                <li key={event.id}>
                  <strong>
                    {String(event.sequence).padStart(2, "0")} · {event.title}
                  </strong>
                  <span>{event.summary}</span>
                  <code>{event.id}</code>
                </li>
              ))}
          </ol>
        </section>

        <section>
          <h2>Sanitized session JSON</h2>
          <pre>{JSON.stringify(sanitizedSession(session), null, 2)}</pre>
        </section>
      </div>
    </details>
  );
}
