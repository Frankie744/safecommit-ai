"use client";

import {
  ToolCallStatus,
  useAgentContext,
  useHumanInTheLoop,
} from "@copilotkit/react-core/v2";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { z } from "zod";

import {
  createSession,
  getSessionIndex,
  getSession,
  retrySession,
  submitSessionDecision,
} from "../lib/session-api";
import { getDeviceTelemetry } from "../lib/device-api";
import type { DeviceTelemetrySnapshot } from "../lib/device-types";
import {
  TERMINAL_STATES,
  type CandidateEvidenceView,
  type CandidateView,
  type DecisionAction,
  type DemoScenarioId,
  type EvidenceProvenance,
  type SessionMode,
  type SessionView,
} from "../lib/session-types";
import {
  CompetitionStatusRail,
  EvidenceDrawer,
} from "./competition-panels";

const POLL_INTERVAL_MS = 1_200;
const DEVICE_POLL_INTERVAL_MS = 2_000;
const DEMO_SCENARIOS: readonly {
  id: DemoScenarioId;
  label: string;
  summary: string;
}[] = [
  {
    id: "unsafe-high-score",
    label: "Unsafe high score",
    summary:
      "Default: the top soft score loses because a hard safety invariant fails.",
  },
  {
    id: "happy-path",
    label: "Happy path",
    summary:
      "The eligible fail-closed repair reaches evidence-bound human approval.",
  },
  {
    id: "provider-failure",
    label: "Provider failure",
    summary:
      "A MOCK HTTP 429 fixture proves that missing provider evidence fails closed.",
  },
];

const NARRATIVE_SECTIONS = [
  { id: "incident", label: "Incident" },
  { id: "agent", label: "Agent" },
  { id: "candidates", label: "Candidates" },
  { id: "twin", label: "Twin" },
  { id: "review", label: "Review" },
  { id: "decision", label: "Decision" },
] as const;

const CERTIFIED_REVIEW_BOUNDARY = {
  pullRequestUrl: "https://github.com/Frankie744/safeflash-ai/pull/1",
  certifiedMainSha: "6402e26db834069946aaab4391e8ef2dd224ad5e",
  approvedRepairHead: "5b418b7eeac67e433609d0a0ca5ab6309bd4fe32",
} as const;

function conciseModeLabel(mode: SessionMode): string {
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

function NarrativeNavigation({ refreshKey }: { refreshKey: string }) {
  const [activeSection, setActiveSection] = useState("incident");

  useEffect(() => {
    const sections = NARRATIVE_SECTIONS.map(({ id }) =>
      document.getElementById(id),
    ).filter((section): section is HTMLElement => section !== null);

    const updateActiveSection = () => {
      const nav = document.querySelector<HTMLElement>("[data-testid='section-nav']");
      const marker = (nav?.getBoundingClientRect().bottom ?? 0) + 32;
      let active = sections[0]?.id ?? "incident";

      for (const section of sections) {
        if (section.getBoundingClientRect().top <= marker) {
          active = section.id;
        }
      }
      setActiveSection(active);
    };

    const hashTarget =
      window.location.hash.length > 1
        ? document.getElementById(window.location.hash.slice(1))
        : null;
    if (hashTarget) {
      window.requestAnimationFrame(() => {
        hashTarget.scrollIntoView({ block: "start", behavior: "auto" });
        updateActiveSection();
      });
    } else {
      updateActiveSection();
    }

    window.addEventListener("scroll", updateActiveSection, { passive: true });
    window.addEventListener("hashchange", updateActiveSection);
    window.addEventListener("resize", updateActiveSection);
    return () => {
      window.removeEventListener("scroll", updateActiveSection);
      window.removeEventListener("hashchange", updateActiveSection);
      window.removeEventListener("resize", updateActiveSection);
    };
  }, [refreshKey]);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const links = Array.from(
      event.currentTarget.querySelectorAll<HTMLAnchorElement>("a[href^='#']"),
    );
    const currentIndex = links.indexOf(
      document.activeElement as HTMLAnchorElement,
    );
    if (currentIndex < 0) return;

    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % links.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + links.length) % links.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = links.length - 1;
    }

    if (nextIndex !== null) {
      event.preventDefault();
      links[nextIndex]?.focus();
    }
  };

  return (
    <nav
      aria-label="Section navigation"
      className="section-nav"
      data-testid="section-nav"
      onKeyDown={handleKeyDown}
    >
      <div className="section-nav__inner">
        {NARRATIVE_SECTIONS.map(({ id, label }) => (
          <a
            aria-current={activeSection === id ? "location" : undefined}
            data-testid={`nav-${id}`}
            href={`#${id}`}
            key={id}
            onClick={() => setActiveSection(id)}
          >
            <span aria-hidden="true">
              {String(
                NARRATIVE_SECTIONS.findIndex((section) => section.id === id) + 1,
              ).padStart(2, "0")}
            </span>
            {label}
          </a>
        ))}
      </div>
    </nav>
  );
}

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

      <dl className="candidate-summary-grid">
        <div>
          <dt>Score</dt>
          <dd>{score === "—" ? score : score + "%"}</dd>
        </div>
        <div>
          <dt>Build</dt>
          <dd data-status={candidate.build.status}>
            {candidate.build.status.toUpperCase()}
          </dd>
        </div>
        <div>
          <dt>Safety gate</dt>
          <dd data-status={gate}>{gate}</dd>
        </div>
        <div>
          <dt>Decision</dt>
          <dd>
            {candidate.selected
              ? "SELECTED"
              : candidate.eliminatedReason
                ? "REJECTED"
                : "PENDING"}
          </dd>
        </div>
      </dl>

      <details className="candidate-details" data-testid="candidate-details">
        <summary>Tests, diff &amp; provenance</summary>
        <div className="candidate-details__body">
          {candidate.hypothesis ? (
            <p className="candidate-card__hypothesis">{candidate.hypothesis}</p>
          ) : null}

          {candidate.generation ? (
            <div className="evidence-row" data-testid="candidate-generation">
              <div className="evidence-row__line">
                <span className="evidence-row__label">
                  Fireworks generation
                </span>
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
            <div
              className="rejection-evidence"
              data-testid="rejection-evidence"
            >
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
            <div className="candidate-diff">
              <strong>Candidate diff</strong>
              <pre>{candidate.diff}</pre>
            </div>
          ) : null}
        </div>
      </details>
    </article>
  );
}

function IncidentPanel({
  session,
  mode,
  device,
  starting,
  onStart,
}: {
  session: SessionView | null;
  mode: SessionMode;
  device: DeviceTelemetrySnapshot | null;
  starting: boolean;
  onStart: () => void;
}) {
  const selected = session?.candidates.find(
    (candidate) => candidate.id === session.selectedCandidateId,
  );
  const safeOutcome =
    selected?.selected === true &&
    selected.safetyGate.hardGatePassed === true &&
    session?.state !== "FAILED";
  const recordedReadOnly = session?.mode === "cached";

  return (
    <section
      aria-labelledby="incident-title"
      className="hero-section narrative-section"
      data-testid="section-incident"
      id="incident"
    >
      <div className="hero-brand">
        <ShieldMark />
        <div>
          <h1>SafeFlash</h1>
          <p>The safety gate for AI-generated firmware.</p>
        </div>
      </div>

      <div className="hero-incident" data-testid="pre-run-incident">
        <span className="eyebrow">Physical incident</span>
        <h2 id="incident-title">
          Battery temperature sensor disconnected while charging
        </h2>
        <div className="hero-outcome-comparison">
          <article
            className="hero-outcome hero-outcome--unsafe"
            data-testid="danger-state"
          >
            <span>Original firmware</span>
            <strong>CHARGING ON</strong>
          </article>
          <span className="hero-outcome-arrow" aria-hidden="true">
            →
          </span>
          <article className="hero-outcome hero-outcome--safe">
            <span>SafeFlash outcome</span>
            <strong>
              {safeOutcome ? "CHARGING OFF" : "PENDING HARD GATES"}
            </strong>
          </article>
        </div>
      </div>

      <div className="hero-actions">
        <div className="hero-truth-badges">
          <span
            className={"mode-badge mode-badge--" + (session?.mode ?? mode)}
            data-testid="mode-badge"
          >
            {conciseModeLabel(session?.mode ?? mode)}
          </span>
          <span className="device-badge" data-testid="header-device-status">
            {device?.displayLabel ?? "SIMULATED DEVICE"}
          </span>
        </div>
        <button
          className="button hero-start"
          data-testid="start-tournament"
          disabled={starting || recordedReadOnly}
          onClick={onStart}
          type="button"
        >
          {starting ? "Starting SafeFlash…" : "Start SafeFlash Run"}
        </button>
      </div>
    </section>
  );
}

function TimelinePanel({ session }: { session: SessionView }) {
  const events = [...session.events].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const milestones = events.filter(
    (event) => event.title.trim().toUpperCase() !== "COMMAND COMPLETED",
  );
  const visibleEvents = milestones.length >= 3 ? milestones : events;
  const retainedEventCount = events.length - visibleEvents.length;

  return (
    <div className="panel timeline-panel" aria-labelledby="timeline-title">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Append-only audit</span>
          <h2 id="timeline-title">Agent timeline</h2>
        </div>
        <span className="event-count">
          {visibleEvents.length} milestones · {events.length} events
        </span>
      </div>
      <div className="current-tool">
        <span className="live-dot" aria-hidden="true" />
        <div>
          <span>Current orchestrator state</span>
          <strong>{humanizeState(session.state)}</strong>
        </div>
      </div>
      <ol className="timeline-list" data-testid="timeline">
        {visibleEvents.length === 0 ? (
          <li className="timeline-empty">
            No audit events have been reported by the API.
          </li>
        ) : (
          visibleEvents.map((event) => (
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
      {retainedEventCount > 0 ? (
        <p className="timeline-retained-note">
          {retainedEventCount} low-level command events remain available in
          Technical Evidence.
        </p>
      ) : null}
    </div>
  );
}

function AgentWorkflowSection({
  session,
  scenarioId,
  starting,
  onScenarioChange,
  onStart,
}: {
  session: SessionView | null;
  scenarioId: DemoScenarioId;
  starting: boolean;
  onScenarioChange: (scenario: DemoScenarioId) => void;
  onStart: () => void;
}) {
  const hardGatesComplete =
    session !== null &&
    session.candidates.length > 0 &&
    session.candidates.every(
      (candidate) => candidate.safetyGate.hardGatePassed !== null,
    );
  const workflowSteps = [
    {
      label: "Observe",
      detail: "Physical fault captured",
      complete: session !== null,
    },
    {
      label: "Generate",
      detail: "Three repair strategies",
      complete: (session?.candidates.length ?? 0) >= 3,
    },
    {
      label: "Gate",
      detail: "Hard safety constraints first",
      complete: hardGatesComplete,
    },
    {
      label: "Twin",
      detail: "Build and executable tests",
      complete:
        session?.candidates.some(
          (candidate) =>
            candidate.build.status === "passed" &&
            candidate.tests.status === "passed",
        ) ?? false,
    },
    {
      label: "Approve",
      detail: "Human-bound evidence",
      complete:
        session?.approval?.decision === "approved" &&
        session.approval.invalidatedAt === undefined,
    },
    {
      label: "Review",
      detail: "Exact-head independent review",
      complete: session?.review?.status === "passed",
    },
  ];
  const firstIncomplete = workflowSteps.findIndex((step) => !step.complete);

  return (
    <section
      aria-labelledby="agent-title"
      className="narrative-section content-section"
      data-testid="section-agent"
      id="agent"
    >
      <div className="section-intro">
        <span className="eyebrow">Agent workflow</span>
        <h2 id="agent-title">Evidence moves forward. Claims do not.</h2>
        <p>
          Every phase emits evidence, and any missing provider result closes the
          gate instead of being filled in by the interface.
        </p>
      </div>

      <div className="agent-state-card">
        <span>Current phase</span>
        <strong data-testid="workflow-state">
          {humanizeState(session?.state ?? "NO_SESSION")}
        </strong>
        <small>
          {session?.mode === "cached"
            ? "Immutable recorded replay — no mutations are allowed."
            : "The server owns every transition shown here."}
        </small>
      </div>

      <ol className="workflow-stepper" aria-label="SafeFlash agent phases">
        {workflowSteps.map((step, index) => {
          const status = step.complete
            ? "complete"
            : index === firstIncomplete
              ? "current"
              : "guarded";
          return (
            <li data-status={status} key={step.label}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{step.label}</strong>
              <small>{step.detail}</small>
            </li>
          );
        })}
      </ol>

      {session ? (
        <section className="scenario-banner" data-testid="scenario-banner">
          <span>DEMO SCENARIO</span>
          <strong>{session.scenario?.label ?? "Server-owned validation"}</strong>
          <p>{session.scenario?.summary ?? "Executable evidence only."}</p>
        </section>
      ) : (
        <section className="agent-empty" data-testid="empty-state">
          <strong>No validation session reported.</strong>
          <span>Choose a scenario, then start from the Hero.</span>
        </section>
      )}

      {session?.mode === "cached" ? (
        <section
          className="new-run-control"
          data-testid="recorded-run-read-only"
        >
          <strong>READ-ONLY RECORDED RUN</strong>
          <label>Immutable replay cannot start or mutate a scenario.</label>
        </section>
      ) : (
        <section className="new-run-control" data-testid="new-run-control">
          <label htmlFor="new-run-scenario">
            Competition scenario — unsafe high score is the default
          </label>
          <div>
            <select
              data-testid="new-run-scenario"
              id="new-run-scenario"
              onChange={(event) =>
                onScenarioChange(event.target.value as DemoScenarioId)
              }
              value={scenarioId}
            >
              {DEMO_SCENARIOS.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>
                  {scenario.label}
                </option>
              ))}
            </select>
            <button
              className="button"
              data-testid="start-new-run"
              disabled={starting}
              onClick={onStart}
              type="button"
            >
              {starting ? "Starting…" : "Start selected scenario"}
            </button>
          </div>
        </section>
      )}

      {session === null ? (
        <fieldset className="scenario-picker">
          <legend>Scenario details</legend>
          {DEMO_SCENARIOS.map((scenario) => (
            <label key={scenario.id}>
              <input
                checked={scenarioId === scenario.id}
                data-testid={`scenario-${scenario.id}`}
                name="demo-scenario"
                onChange={() => onScenarioChange(scenario.id)}
                type="radio"
                value={scenario.id}
              />
              <span>
                <strong>{scenario.label}</strong>
                <small>{scenario.summary}</small>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
    </section>
  );
}

function RepairLoopSection({ session }: { session: SessionView | null }) {
  return (
    <section
      aria-labelledby="review-title"
      className="narrative-section content-section"
      data-testid="section-review"
      id="review"
    >
      <div className="section-intro">
        <span className="eyebrow">Real GitHub + CodeRabbit repair loop</span>
        <h2 id="review-title">A second trust boundary reviews the exact head.</h2>
        <p>
          Current-run evidence and prior public review proof are deliberately
          separated. A mock run never inherits a live review claim.
        </p>
      </div>

      <div className="review-grid">
        <article className="review-card review-card--current">
          <header>
            <span>Current run</span>
            <strong>{conciseModeLabel(session?.mode ?? "unknown")}</strong>
          </header>
          <dl>
            <div>
              <dt>GitHub PR</dt>
              <dd>
                {session?.pullRequest
                  ? `#${session.pullRequest.number} ${session.pullRequest.status.toUpperCase()}`
                  : "NOT CREATED"}
              </dd>
            </div>
            <div>
              <dt>Exact head</dt>
              <dd>
                <code>{session?.currentCommitSha ?? "not available"}</code>
              </dd>
            </div>
            <div>
              <dt>CodeRabbit</dt>
              <dd>
                {session?.review
                  ? `${session.review.status.toUpperCase()} · ROUND ${session.review.round}`
                  : "NOT RUN"}
              </dd>
            </div>
            <div>
              <dt>Daytona cleanup</dt>
              <dd>{session?.cleanup?.status.toUpperCase() ?? "NOT RUN"}</dd>
            </div>
          </dl>
          {session?.review ? (
            <div className="review-findings" data-testid="coderabbit-review">
              <strong>
                {session.review.findings.length} exact-head finding
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
                        {finding.line === undefined
                          ? ""
                          : `:${finding.line}`}{" "}
                        · {finding.body}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <ProvenanceBadge provenance={session.review.provenance} />
            </div>
          ) : (
            <p className="review-guardrail">
              No current-run review is claimed before a real PR and exact-head
              CodeRabbit evidence exist.
            </p>
          )}
        </article>

        <article className="review-card review-card--certified">
          <header>
            <span>Real prior public boundary</span>
            <strong>NOT CURRENT LIVE</strong>
          </header>
          <a
            href={CERTIFIED_REVIEW_BOUNDARY.pullRequestUrl}
            rel="noreferrer"
            target="_blank"
          >
            Frankie744/safeflash-ai · PR #1 ↗
          </a>
          <ol className="review-rounds">
            <li>
              <span>Round 1</span>
              <strong>CodeRabbit requested changes</strong>
            </li>
            <li>
              <span>Repair</span>
              <strong>Patch revalidated through safety gates</strong>
            </li>
            <li>
              <span>Round 2</span>
              <strong>Approved repaired head</strong>
            </li>
          </ol>
          <dl className="review-shas">
            <div>
              <dt>Certified main</dt>
              <dd>
                <code>{CERTIFIED_REVIEW_BOUNDARY.certifiedMainSha}</code>
              </dd>
            </div>
            <div>
              <dt>Approved repair head</dt>
              <dd>
                <code>{CERTIFIED_REVIEW_BOUNDARY.approvedRepairHead}</code>
              </dd>
            </div>
          </dl>
          <p>
            This proves the GitHub/CodeRabbit review boundary only. It is not a
            full provider-chain Live run and not a Recorded Live replay.
          </p>
        </article>
      </div>

      <div className="never-merge-callout">
        <strong>NO AUTOMATIC MERGE</strong>
        <span>
          SafeFlash may reach “ready for human merge”; it never presses merge.
        </span>
      </div>
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

const EXECUTABLE_ASSURANCE_PROFILES = [
  {
    id: "battery-sensor-disconnect",
    device: "Battery charger",
    incident: "Temperature sensor disconnected while charging",
    unsafe: "Sensor fault ignored · charging ON",
    safe: "Charging OFF · fault latched",
    fixture: "fixtures/battery-controller",
  },
  {
    id: "motor-command-nonfinite",
    device: "Motor drive",
    incident: "NaN torque command reaches the controller",
    unsafe: "Range checks bypassed · PWM ON",
    safe: "PWM OFF · zero torque · fault latched",
    fixture: "fixtures/motor-controller",
  },
] as const;

function CrossDeviceAssuranceProof() {
  return (
    <section
      aria-labelledby="cross-device-proof-title"
      className="panel cross-device-proof"
      data-testid="cross-device-proof"
    >
      <div className="cross-device-proof__heading">
        <div>
          <span className="eyebrow">Cross-device executable proof</span>
          <h3 id="cross-device-proof-title">
            One safety gate, multiple physical device classes.
          </h3>
        </div>
        <div className="cross-device-proof__badges">
          <span>SIMULATED DEVICES</span>
          <span>LOCAL-TEST · NOT LIVE</span>
        </div>
      </div>
      <div className="cross-device-proof__grid">
        {EXECUTABLE_ASSURANCE_PROFILES.map((profile) => (
          <article data-profile-id={profile.id} key={profile.id}>
            <header>
              <strong>{profile.device}</strong>
              <span>EXECUTABLE C / CTEST</span>
            </header>
            <p>{profile.incident}</p>
            <dl>
              <div>
                <dt>Unsafe baseline</dt>
                <dd>{profile.unsafe}</dd>
              </div>
              <div>
                <dt>Hard-gate outcome</dt>
                <dd>{profile.safe}</dd>
              </div>
              <div>
                <dt>Server-owned fixture</dt>
                <dd>
                  <code>{profile.fixture}</code>
                </dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
      <p className="cross-device-proof__note">
        Both profiles use the same non-compensable selector and fixed command
        policy. Run <code>npm run demo:cross-device</code> to rebuild all six
        isolated candidates without provider calls or hardware.
      </p>
    </section>
  );
}

export function SafeFlashConsole() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [activeMode, setActiveMode] = useState<SessionMode>("unknown");
  const [scenarioId, setScenarioId] =
    useState<DemoScenarioId>("unsafe-high-score");
  const [device, setDevice] = useState<DeviceTelemetrySnapshot | null>(null);
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
      const index = await getSessionIndex();
      const sessions = index.sessions;
      setActiveMode(index.mode);
      if (sessions.length === 0) {
        setSession(null);
        return;
      }

      const summary = sessions[0];
      try {
        setSession(await getSession(summary.id));
      } catch {
        if (
          summary.mode === "live" &&
          summary.state === "READY_TO_MERGE"
        ) {
          const at = new Date().toISOString();
          setSession({
            ...summary,
            state: "FAILED",
            approval:
              summary.approval === undefined
                ? undefined
                : {
                    ...summary.approval,
                    invalidatedAt: at,
                    invalidationReason:
                      "The detail endpoint could not refresh the remote READY claim.",
                  },
            review: undefined,
            failure: {
              reason:
                "The exact remote READY claim could not be refreshed; stale readiness is hidden.",
              recoverable: false,
            },
          });
        } else {
          setSession(summary);
        }
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
    let cancelled = false;
    const refresh = () => {
      void getDeviceTelemetry()
        .then((snapshot) => {
          if (!cancelled) setDevice(snapshot);
        })
        .catch(() => {
          if (!cancelled) setDevice(null);
        });
    };
    refresh();
    const timer = window.setInterval(refresh, DEVICE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    const requiresFreshnessPolling =
      session.mode === "live" &&
      (session.state === "READY_TO_MERGE" ||
        (session.state === "FAILED" &&
          session.failure?.recoverable === true &&
          session.failure.retryAction ===
            "retry-ready-freshness-check"));
    if (TERMINAL_STATES.has(session.state) && !requiresFreshnessPolling) return;
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
          setSession((current) => {
            if (
              current === null ||
              current.mode !== "live" ||
              current.state !== "READY_TO_MERGE"
            ) {
              return current;
            }
            const at = new Date().toISOString();
            return {
              ...current,
              state: "FAILED",
              approval:
                current.approval === undefined
                  ? undefined
                  : {
                      ...current.approval,
                      invalidatedAt: at,
                      invalidationReason:
                        "The client could not refresh the remote READY claim.",
                    },
              review: undefined,
              failure: {
                reason:
                  "The exact remote READY claim could not be refreshed; stale readiness is hidden.",
                recoverable: false,
              },
            };
          });
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
      const created = await createSession(scenarioId);
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
  }, [scenarioId]);

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
        <NarrativeNavigation
          refreshKey={`${session?.id ?? "none"}:${loading ? "loading" : "ready"}`}
        />

        <IncidentPanel
          device={device}
          mode={session?.mode ?? activeMode}
          onStart={() => void handleStart()}
          session={session}
          starting={starting}
        />

        <div className="narrative-alerts">
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
            <div
              className="error-banner"
              data-testid="workflow-failure"
              role="alert"
            >
              <strong>Workflow failed closed.</strong>
              <span>
                {session.failure.reason}{" "}
                {session.failure.recoverable
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
        </div>

        <AgentWorkflowSection
          onScenarioChange={setScenarioId}
          onStart={() => void handleStart()}
          scenarioId={scenarioId}
          session={session}
          starting={starting}
        />

        <section
          aria-labelledby="tournament-title"
          className="narrative-section content-section"
          data-testid="section-candidates"
          id="candidates"
        >
          <div className="section-intro">
            <span className="eyebrow">Candidate safety tournament</span>
            <h2 id="tournament-title">
              The highest score can still lose.
            </h2>
            <p>
              Build, hard safety gate, and final decision stay visible. Tests,
              diffs, and provenance expand only when judges ask.
            </p>
          </div>

          <div className="panel tournament-panel">
            <div className="panel-heading tournament-heading">
              <div>
                <span className="section-label">Evidence-based selection</span>
                <strong>Three persistent repair strategies</strong>
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
              {loading && session === null ? (
                <div className="candidate-empty" data-testid="loading-state">
                  Loading executable session evidence…
                </div>
              ) : session === null || session.candidates.length === 0 ? (
                <div className="candidate-empty">
                  {session?.state === "FAILED"
                    ? "Provider evidence is missing. Candidate selection failed closed."
                    : "Start a run to compare candidate evidence."}
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
          </div>
        </section>

        <section
          aria-labelledby="twin-title"
          className="narrative-section content-section"
          data-testid="section-twin"
          id="twin"
        >
          <div className="section-intro">
            <span className="eyebrow">Digital twin timeline</span>
            <h2 id="twin-title">Every transition remains auditable.</h2>
            <p>
              Events are shown in execution order. The page grows with the
              evidence; the timeline never becomes a scroll box.
            </p>
          </div>
          {session ? (
            <TimelinePanel session={session} />
          ) : (
            <div className="section-placeholder">
              Start a run to populate the append-only digital twin timeline.
            </div>
          )}
        </section>

        <RepairLoopSection session={session} />

        <section
          aria-labelledby="decision-title"
          className="narrative-section content-section decision-section"
          data-testid="section-decision"
          id="decision"
        >
          <div className="section-intro">
            <span className="eyebrow">Human approval and final decision</span>
            <h2 id="decision-title">The agent stops at the human boundary.</h2>
            <p>
              Approval is bound to the candidate, evidence digest, patch digest,
              commit, and policy version. A changed head invalidates old proof.
            </p>
          </div>
          {session ? (
            <ApprovalGate
              busyDecision={busyDecision}
              onDecision={handleDecision}
              session={session}
            />
          ) : (
            <div className="section-placeholder">
              No decision is available before a candidate passes every hard
              gate.
            </div>
          )}
        </section>

        <section
          aria-labelledby="evidence-title"
          className="narrative-section content-section evidence-section"
          data-testid="section-evidence"
          id="evidence"
        >
          <div className="section-intro">
            <span className="eyebrow">Technical evidence</span>
            <h2 id="evidence-title">Raw proof, kept out of the main story.</h2>
            <p>
              Session bindings, complete provider/resource IDs, cleanup proof,
              policy, audit events, and sanitized JSON remain available here.
            </p>
          </div>
          <CrossDeviceAssuranceProof />
          {session ? (
            <>
              <CompetitionStatusRail device={device} session={session} />
              <EvidenceDrawer session={session} />
            </>
          ) : (
            <div className="section-placeholder">
              Technical evidence appears only after the server reports a
              session.
            </div>
          )}
        </section>
      </main>
    </CopilotSessionBridge>
  );
}
