import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(
  root,
  "artifacts",
  "evidence",
  "safecommit-database-local",
);
const liveEvidenceRoot = path.join(
  root,
  "artifacts",
  "evidence",
  "safecommit-database-live",
);
const outputRoot = path.join(root, "_site");

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function shortDigest(value) {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function candidateCard(candidate, winnerCandidateId) {
  const selected = candidate.candidateId === winnerCandidateId;
  const gateCopy =
    candidate.failedGateNames.length === 0
      ? "All hard gates passed"
      : candidate.failedGateNames.join(" · ");
  return `
    <article class="candidate ${selected ? "selected" : "rejected"}">
      <div class="candidate-head">
        <div>
          <p class="eyebrow">${selected ? "Selected safe plan" : "Rejected by hard gate"}</p>
          <h3>${escapeHtml(candidate.candidateId)}</h3>
        </div>
        <strong class="score">${candidate.weightedScore.toFixed(4)}</strong>
      </div>
      <div class="status-row">
        <span class="pill ${selected ? "pass" : "fail"}">${selected ? "ELIGIBLE" : "INELIGIBLE"}</span>
        <span>${escapeHtml(gateCopy)}</span>
      </div>
      <dl>
        <div><dt>Affected rows</dt><dd>${candidate.affectedRows}</dd></div>
        <div><dt>Rollback</dt><dd>${candidate.beforeStateDigest === candidate.rollbackStateDigest ? "VERIFIED" : "MISMATCH"}</dd></div>
        <div><dt>Evidence</dt><dd><code>${escapeHtml(shortDigest(candidate.evidenceDigest))}</code></dd></div>
      </dl>
    </article>`;
}

async function build() {
  const runId = (
    await readFile(path.join(evidenceRoot, "latest-run.txt"), "utf8")
  ).trim();
  if (!/^safecommit-mysql-[A-Za-z0-9]+$/u.test(runId)) {
    throw new Error("Invalid SafeCommit evidence run identifier");
  }
  const runRoot = path.join(evidenceRoot, runId);
  const summary = JSON.parse(
    await readFile(path.join(runRoot, "summary.json"), "utf8"),
  );
  const liveRunId = (
    await readFile(path.join(liveEvidenceRoot, "latest-run.txt"), "utf8")
  ).trim();
  if (!/^safecommit-live-\d{8}T\d{9}Z$/u.test(liveRunId)) {
    throw new Error("Invalid SafeCommit live evidence run identifier");
  }
  const liveRunRoot = path.join(liveEvidenceRoot, liveRunId);
  const liveEvidence = JSON.parse(
    await readFile(
      path.join(liveRunRoot, "database-live-evidence.json"),
      "utf8",
    ),
  );
  if (
    summary.status !== "LOCAL_TEST" ||
    summary.liveCertified !== false ||
    summary.liveProviderCalls !== 0 ||
    summary.candidateCount !== 3 ||
    !/^[a-f0-9]{40}$/u.test(summary.sourceCommitSha)
  ) {
    throw new Error(
      "Public evidence must remain an explicit three-candidate LOCAL_TEST result",
    );
  }
  const liveGateCounts = liveEvidence.candidates.map(
    (candidate) => candidate.gates.results.length,
  );
  const liveProviderEvidenceIsComplete =
    liveEvidence.status === "AWAITING_HUMAN_APPROVAL" &&
    liveEvidence.liveCertified === false &&
    liveEvidence.candidates.length === 3 &&
    typeof liveEvidence.winnerCandidateId === "string" &&
    liveGateCounts.every((count) => count === liveGateCounts[0]) &&
    liveEvidence.candidates.every(
      (candidate) =>
        candidate.fireworks.requestId.startsWith("chatcmpl-") &&
        candidate.daytona.destroyed === true &&
        candidate.daytona.networkBlockedBeforeExecution === true,
    ) &&
    liveEvidence.braintrust.dataset.datasetUrl.startsWith(
      "https://www.braintrust.dev/",
    ) &&
    liveEvidence.braintrust.trace.traceUrl.startsWith(
      "https://www.braintrust.dev/",
    ) &&
    liveEvidence.braintrust.experiment.experimentUrl.startsWith(
      "https://www.braintrust.dev/",
    );
  if (!liveProviderEvidenceIsComplete) {
    throw new Error(
      "Public live evidence must be complete, destroyed, network-isolated, and awaiting human approval",
    );
  }

  await mkdir(path.join(outputRoot, "evidence"), { recursive: true });
  await copyFile(
    path.join(runRoot, "summary.json"),
    path.join(outputRoot, "evidence", "summary.json"),
  );
  await copyFile(
    path.join(runRoot, "database-evidence.json"),
    path.join(outputRoot, "evidence", "database-evidence.json"),
  );
  await copyFile(
    path.join(runRoot, "manifest.sha256"),
    path.join(outputRoot, "evidence", "manifest.sha256"),
  );
  await copyFile(
    path.join(liveRunRoot, "database-live-evidence.json"),
    path.join(outputRoot, "evidence", "database-live-evidence.json"),
  );
  await copyFile(
    path.join(liveRunRoot, "manifest.sha256"),
    path.join(outputRoot, "evidence", "live-manifest.sha256"),
  );
  await copyFile(
    path.join(
      root,
      "artifacts",
      "presentation",
      "SafeCommit_Championship_Deck_LOCAL_TEST.pdf",
    ),
    path.join(outputRoot, "SafeCommit_Championship_Deck_LOCAL_TEST.pdf"),
  );

  const candidates = summary.candidates
    .map((candidate) => candidateCard(candidate, summary.winnerCandidateId))
    .join("");
  const liveRequestIds = liveEvidence.candidates
    .map(
      (candidate) =>
        `<code>${escapeHtml(candidate.fireworks.requestId)}</code>`,
    )
    .join("<br>");
  const liveSandboxIds = liveEvidence.candidates
    .map(
      (candidate) =>
        `<code>${escapeHtml(candidate.daytona.sandboxId)}</code>`,
    )
    .join("<br>");
  const hardGateCount = liveGateCounts[0];
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="SafeCommit read-only database safety evidence with live Fireworks, Daytona, and Braintrust provenance.">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23090b0e'/%3E%3Cpath d='M18 33l9 9 20-22' fill='none' stroke='%2374e39a' stroke-width='7' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
  <title>SafeCommit — Public Evidence</title>
  <style>
    :root { color-scheme: dark; --bg:#090b0e; --panel:#12171d; --line:#28313b; --ink:#f5f2e9; --muted:#a9b1ba; --green:#74e39a; --red:#ff6b70; --amber:#f0c76b; }
    * { box-sizing:border-box; }
    html { scroll-behavior:smooth; }
    body { margin:0; background:radial-gradient(circle at 80% 0,rgba(240,199,107,.12),transparent 32rem),radial-gradient(circle at 5% 35%,rgba(116,227,154,.08),transparent 30rem),var(--bg); color:var(--ink); font:16px/1.55 Inter,ui-sans-serif,system-ui,sans-serif; }
    a { color:inherit; }
    .wrap { width:min(1180px,calc(100% - 36px)); margin:auto; }
    nav { display:flex; align-items:center; justify-content:space-between; padding:24px 0; border-bottom:1px solid var(--line); }
    .brand { font-weight:800; letter-spacing:-.03em; font-size:1.18rem; text-decoration:none; }
    .brand span { color:var(--green); }
    .nav-links { display:flex; gap:18px; color:var(--muted); font-size:.9rem; }
    .hero { padding:92px 0 68px; display:grid; grid-template-columns:minmax(0,1.4fr) minmax(280px,.6fr); gap:54px; align-items:end; }
    .eyebrow { margin:0 0 10px; color:var(--amber); font:700 .72rem/1.2 ui-monospace,monospace; letter-spacing:.12em; text-transform:uppercase; }
    h1 { margin:0; max-width:820px; font-size:clamp(3rem,8vw,7.2rem); line-height:.88; letter-spacing:-.075em; }
    h1 em { display:block; color:var(--green); font-style:normal; }
    .lede { margin:28px 0 0; max-width:720px; font-size:clamp(1.05rem,2vw,1.3rem); color:var(--muted); }
    .truth { border-left:2px solid var(--amber); padding:4px 0 4px 22px; color:var(--muted); }
    .truth strong { display:block; margin-bottom:8px; color:var(--ink); }
    .metrics { display:grid; grid-template-columns:repeat(4,1fr); border:1px solid var(--line); border-radius:18px; overflow:hidden; background:rgba(18,23,29,.72); }
    .metric { padding:25px; border-right:1px solid var(--line); }
    .metric:last-child { border:0; }
    .metric b { display:block; font-size:1.55rem; }
    .metric span { color:var(--muted); font-size:.82rem; }
    section { padding:76px 0; }
    .section-head { display:flex; justify-content:space-between; gap:30px; align-items:end; margin-bottom:28px; }
    h2 { margin:0; font-size:clamp(2rem,4vw,3.4rem); letter-spacing:-.055em; line-height:1; }
    .section-head p { margin:0; max-width:510px; color:var(--muted); }
    .candidate-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; }
    .candidate { min-width:0; padding:25px; border:1px solid var(--line); border-radius:18px; background:linear-gradient(145deg,rgba(255,255,255,.035),rgba(255,255,255,.012)); }
    .candidate.selected { border-color:rgba(116,227,154,.62); box-shadow:inset 0 3px var(--green); }
    .candidate.rejected { box-shadow:inset 0 3px var(--red); }
    .candidate-head { display:flex; align-items:start; justify-content:space-between; gap:18px; }
    h3 { margin:0; font-size:1.08rem; word-break:break-all; }
    .score { font:700 1.42rem ui-monospace,monospace; }
    .status-row { min-height:58px; display:flex; align-items:center; gap:10px; margin:24px 0; color:var(--muted); font-size:.78rem; }
    .pill { display:inline-flex; border-radius:999px; padding:5px 9px; font:800 .65rem ui-monospace,monospace; letter-spacing:.06em; }
    .pill.pass { color:var(--green); background:rgba(116,227,154,.1); }
    .pill.fail { color:var(--red); background:rgba(255,107,112,.1); }
    dl { margin:0; }
    dl div { display:flex; justify-content:space-between; gap:12px; padding:10px 0; border-top:1px solid var(--line); }
    dt { color:var(--muted); }
    dd { margin:0; text-align:right; }
    code { color:var(--amber); font-size:.76rem; }
    .boundary { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
    .boundary article { padding:28px; border:1px solid var(--line); border-radius:18px; background:var(--panel); }
    .boundary h3 { margin-bottom:13px; font-size:1.25rem; }
    .boundary ul { margin:0; padding-left:18px; color:var(--muted); }
    .actions { display:flex; flex-wrap:wrap; gap:12px; }
    .button { display:inline-flex; align-items:center; justify-content:center; min-height:48px; padding:0 17px; border:1px solid var(--line); border-radius:10px; text-decoration:none; font-weight:750; }
    .button.primary { color:#06100a; border-color:var(--green); background:var(--green); }
    footer { padding:34px 0 50px; border-top:1px solid var(--line); color:var(--muted); font-size:.82rem; display:flex; justify-content:space-between; gap:20px; }
    @media (max-width:850px) { .hero,.boundary { grid-template-columns:1fr; } .candidate-grid { grid-template-columns:1fr; } .metrics { grid-template-columns:1fr 1fr; } .metric:nth-child(2) { border-right:0; } .metric:nth-child(-n+2) { border-bottom:1px solid var(--line); } }
    @media (max-width:520px) { .nav-links { display:none; } .hero { padding-top:64px; } .metrics { grid-template-columns:1fr; } .metric { border:0; border-bottom:1px solid var(--line)!important; } .section-head,footer { align-items:start; flex-direction:column; } }
  </style>
</head>
<body>
  <div class="wrap">
    <nav>
      <a class="brand" href="#"><span>Safe</span>Commit</a>
      <div class="nav-links"><a href="#result">Result</a><a href="#live">Live proof</a><a href="#boundary">Evidence boundary</a><a href="#artifacts">Artifacts</a></div>
    </nav>
    <main>
      <header class="hero">
        <div>
          <p class="eyebrow">Public · read-only · verifiable evidence</p>
          <h1>Safety before <em>commit.</em></h1>
          <p class="lede">Three database mutation plans entered the same MySQL 8 fixture. The two higher-scoring plans were rejected because hard safety invariants outrank model preference.</p>
        </div>
        <div class="truth"><strong>Live providers verified; human approval pending.</strong>The public page is read-only and contains no operator controls or credentials. The recorded run remains <code>LIVE_CERTIFIED=false</code> until a human approves the evidence-bound winner.</div>
      </header>
      <div class="metrics" aria-label="Run summary">
        <div class="metric"><b>${summary.candidateCount}</b><span>candidate plans</span></div>
        <div class="metric"><b>${hardGateCount}</b><span>database hard gates</span></div>
        <div class="metric"><b>${escapeHtml(summary.mysql)}</b><span>MySQL version</span></div>
        <div class="metric"><b>${liveEvidence.candidates.length}</b><span>live isolated candidates</span></div>
      </div>
      <section id="result">
        <div class="section-head"><div><p class="eyebrow">Tournament result</p><h2>Score never overrides safety.</h2></div><p>Candidate C won despite the lowest numeric score. Candidate A crossed warehouse and tenant boundaries; Candidate B changed protected shipped-order state.</p></div>
        <div class="candidate-grid">${candidates}</div>
      </section>
      <section id="live">
        <div class="section-head"><div><p class="eyebrow">Live sponsor provenance</p><h2>Three providers. One bound run.</h2></div><p>Run <code>${escapeHtml(liveRunId)}</code><br>Status <code>${escapeHtml(liveEvidence.status)}</code></p></div>
        <div class="boundary">
          <article><h3>Fireworks + Daytona</h3><p>Fireworks model <code>${escapeHtml(liveEvidence.candidates[0].fireworks.model)}</code> generated three structured plans. Each ran from the same MySQL snapshot in a network-blocked Daytona sandbox; all sandboxes were destroyed.</p><p>${liveRequestIds}</p><p>${liveSandboxIds}</p></article>
          <article><h3>Braintrust evaluation</h3><p>Dataset version <code>${escapeHtml(liveEvidence.braintrust.dataset.datasetVersion)}</code> contains ${liveEvidence.braintrust.dataset.totalRecords} cases. The deterministic experiment recorded ${liveEvidence.braintrust.experiment.resultCount} candidate results.</p><div class="actions"><a class="button" href="${escapeHtml(liveEvidence.braintrust.dataset.datasetUrl)}">Dataset</a><a class="button" href="${escapeHtml(liveEvidence.braintrust.trace.traceUrl)}">Trace</a><a class="button primary" href="${escapeHtml(liveEvidence.braintrust.experiment.experimentUrl)}">Experiment</a></div></article>
        </div>
      </section>
      <section id="boundary">
        <div class="section-head"><div><p class="eyebrow">Trust boundary</p><h2>Exactly what is proven.</h2></div></div>
        <div class="boundary">
          <article><h3>Verified in these artifacts</h3><ul><li>MySQL ${escapeHtml(summary.mysql)} executable fixture</li><li>Same baseline for all three candidates</li><li>Hard-gate eligibility and deterministic ranking</li><li>Rollback digest equals baseline for every candidate</li><li>Live Fireworks, Daytona, and Braintrust provenance</li><li>SHA-256 manifests for local and live evidence</li></ul></article>
          <article><h3>Not represented as complete</h3><ul><li>No human approval has been recorded</li><li>No production database connection or commit</li><li>No physical HIL evidence</li><li>No public mutation or merge controls</li><li><code>LIVE_CERTIFIED=false</code> until the approval boundary is completed</li></ul></article>
        </div>
      </section>
      <section id="artifacts">
        <div class="section-head"><div><p class="eyebrow">Audit artifacts</p><h2>Inspect the evidence.</h2></div><p>Run <code>${escapeHtml(summary.runId)}</code><br>Tournament <code>${escapeHtml(shortDigest(summary.tournamentDigest))}</code></p></div>
        <div class="actions">
          <a class="button primary" href="SafeCommit_Championship_Deck_LOCAL_TEST.pdf">Open the reviewed PDF deck</a>
          <a class="button" href="evidence/summary.json">Run summary</a>
          <a class="button" href="evidence/database-evidence.json">Full database evidence</a>
          <a class="button" href="evidence/manifest.sha256">SHA-256 manifest</a>
          <a class="button" href="evidence/database-live-evidence.json">Live provider evidence</a>
          <a class="button" href="evidence/live-manifest.sha256">Live SHA-256 manifest</a>
          <a class="button" href="https://github.com/Frankie744/safeflash-ai/commit/${summary.sourceCommitSha}">Inspect evidence source commit</a>
        </div>
      </section>
    </main>
    <footer><span>SafeCommit public evidence · generated from committed artifacts</span><span>Operator policy: public read-only; mutations remain server-only and token-bound.</span></footer>
  </div>
</body>
</html>`;
  await writeFile(path.join(outputRoot, "index.html"), html, "utf8");
  await writeFile(path.join(outputRoot, ".nojekyll"), "", "utf8");
  console.log(`Built ${path.relative(root, outputRoot)} from ${runId}`);
}

await build();
