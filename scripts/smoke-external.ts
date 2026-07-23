import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import {
  BraintrustAdapter,
  CodeRabbitAdapter,
  DaytonaAdapter,
  FireworksAdapter,
  GitHubAdapter,
  ProviderConfigurationError,
  ProviderModeError,
  isSafeGitHubOwner,
  isSafeGitHubRepository,
  isSafeGitRef,
  createFireworksSourceContext,
  readBraintrustConfig,
  readCodeRabbitConfig,
  readDaytonaConfig,
  readFireworksConfig,
  readGitHubConfig,
  redactProviderError,
  type Environment,
  type ProviderName,
} from "@safeflash/integrations";

type SmokeStatus = "passed" | "blocked" | "failed";

export interface SmokeResult {
  provider: ProviderName;
  status: SmokeStatus;
  provenance?: "live";
  evidence?: unknown;
  reason?: string;
  blockers?: readonly string[];
  nextAction?: string;
  operation: string;
  externalEffects: readonly string[];
}

const ALL_PROVIDERS: readonly ProviderName[] = [
  "fireworks",
  "daytona",
  "braintrust",
  "github",
  "coderabbit",
];

const PROVIDER_OPERATIONS: Readonly<
  Record<
    ProviderName,
    {
      operation: string;
      externalEffects: readonly string[];
      nextAction: string;
    }
  >
> = {
  fireworks: {
    operation: "Generate one structured CandidatePatch using Fireworks inference.",
    externalEffects: ["One metered model inference request; no repository mutation."],
    nextAction:
      "Create a Fireworks API key, choose a structured-output model, then set FIREWORKS_API_KEY and FIREWORKS_MODEL.",
  },
  daytona: {
    operation:
      "Create one private, network-blocked ephemeral sandbox, run an exact local command, and delete it.",
    externalEffects: [
      "One short-lived Daytona sandbox is created and synchronously deleted.",
    ],
    nextAction:
      "Create a Daytona API key and set DAYTONA_API_KEY; leave DAYTONA_API_URL empty or set the official https://app.daytona.io/api endpoint, and optionally set DAYTONA_TARGET.",
  },
  braintrust: {
    operation:
      "Verify the safety dataset and write one smoke trace plus one one-case Experiment.",
    externalEffects: [
      "Test-labelled Dataset rows, one Trace, and one Experiment are written to the configured Braintrust project.",
    ],
    nextAction:
      "Create a Braintrust API key and set BRAINTRUST_API_KEY; optionally choose the smoke project and dataset names.",
  },
  github: {
    operation:
      "Read the authenticated identity and configured repository metadata/permissions.",
    externalEffects: ["Read-only GitHub API calls; no branch, issue, PR, or merge mutation."],
    nextAction:
      "Provide a fine-grained token for the public demo repository and set GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO.",
  },
  coderabbit: {
    operation:
      "Read one existing open PR, its exact-head reviews/comments, and its check runs once.",
    externalEffects: [
      "Read-only GitHub API calls; no review trigger, comment, PR mutation, or merge mutation.",
    ],
    nextAction:
      "Install CodeRabbit on the public demo repository, provide GitHub read credentials, and set an existing PR number plus its exact full head SHA.",
  },
};

const REQUIRED_ENVIRONMENT: Readonly<Record<ProviderName, readonly string[]>> = {
  fireworks: ["FIREWORKS_API_KEY", "FIREWORKS_MODEL"],
  daytona: ["DAYTONA_API_KEY"],
  braintrust: ["BRAINTRUST_API_KEY"],
  github: ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"],
  coderabbit: [
    "GITHUB_TOKEN",
    "GITHUB_OWNER",
    "GITHUB_REPO",
    "SAFEFLASH_SMOKE_PR_NUMBER",
    "SAFEFLASH_SMOKE_PR_HEAD_SHA",
  ],
};

function hasValue(environment: Environment, key: string): boolean {
  return (environment[key]?.trim().length ?? 0) > 0;
}

function optionalUrlBlocker(
  environment: Environment,
  key: string,
  validate: (url: URL) => boolean,
  requirement: string,
): string | undefined {
  const raw = environment[key]?.trim();
  if (!raw) return undefined;
  try {
    return validate(new URL(raw)) ? undefined : `${key} ${requirement}`;
  } catch {
    return `${key} ${requirement}`;
  }
}

/** Pure fail-closed preflight. It never reads or returns secret values. */
export function configurationBlockers(
  provider: ProviderName,
  environment: Environment,
): readonly string[] {
  const blockers: string[] = [];
  if (environment.SAFEFLASH_ALLOW_LIVE !== "true") {
    blockers.push("SAFEFLASH_ALLOW_LIVE must equal true");
  }
  blockers.push(
    ...REQUIRED_ENVIRONMENT[provider]
      .filter((key) => !hasValue(environment, key))
      .map((key) => `${key} is required`),
  );

  if (provider === "fireworks") {
    const blocker = optionalUrlBlocker(
      environment,
      "FIREWORKS_BASE_URL",
      (url) =>
        url.protocol === "https:" &&
        url.hostname.toLowerCase() === "api.fireworks.ai" &&
        url.port === "" &&
        url.username === "" &&
        url.password === "" &&
        ["/inference/v1", "/inference/v1/"].includes(url.pathname) &&
        url.search === "" &&
        url.hash === "",
      "must be the official https://api.fireworks.ai/inference/v1 endpoint",
    );
    if (blocker) blockers.push(blocker);
  }

  if (provider === "daytona") {
    const blocker = optionalUrlBlocker(
      environment,
      "DAYTONA_API_URL",
      (url) =>
        url.protocol === "https:" &&
        url.hostname.toLowerCase() === "app.daytona.io" &&
        url.port === "" &&
        url.username === "" &&
        url.password === "" &&
        ["/api", "/api/"].includes(url.pathname) &&
        url.search === "" &&
        url.hash === "",
      "must be the official https://app.daytona.io/api endpoint",
    );
    if (blocker) blockers.push(blocker);
  }

  if (provider === "coderabbit") {
    const pullNumber = environment.SAFEFLASH_SMOKE_PR_NUMBER?.trim();
    if (
      pullNumber &&
      (!/^\d+$/u.test(pullNumber) ||
        !Number.isSafeInteger(Number(pullNumber)) ||
        Number(pullNumber) <= 0)
    ) {
      blockers.push("SAFEFLASH_SMOKE_PR_NUMBER must be a positive safe integer");
    }
    const headSha = environment.SAFEFLASH_SMOKE_PR_HEAD_SHA?.trim();
    if (headSha && !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(headSha)) {
      blockers.push(
        "SAFEFLASH_SMOKE_PR_HEAD_SHA must be the exact full 40- or 64-character PR head SHA",
      );
    }
    const timeout = environment.CODERABBIT_REVIEW_TIMEOUT_MS?.trim();
    const interval = environment.CODERABBIT_POLL_INTERVAL_MS?.trim();
    const timeoutValue = timeout ? Number(timeout) : 180_000;
    const intervalValue = interval ? Number(interval) : 5_000;
    if (
      !Number.isInteger(timeoutValue) ||
      timeoutValue < 1_000 ||
      timeoutValue > 900_000
    ) {
      blockers.push(
        "CODERABBIT_REVIEW_TIMEOUT_MS must be an integer from 1000 through 900000",
      );
    }
    if (
      !Number.isInteger(intervalValue) ||
      intervalValue < 250 ||
      intervalValue > 60_000 ||
      intervalValue > timeoutValue
    ) {
      blockers.push(
        "CODERABBIT_POLL_INTERVAL_MS must be an integer from 250 through 60000 and not exceed the timeout",
      );
    }
  }

  if (provider === "github" || provider === "coderabbit") {
    const owner = environment.GITHUB_OWNER?.trim();
    const repository = environment.GITHUB_REPO?.trim();
    const baseBranch = environment.GITHUB_BASE_BRANCH?.trim() || "main";
    if (owner && !isSafeGitHubOwner(owner)) {
      blockers.push("GITHUB_OWNER is not a safe GitHub owner name");
    }
    if (repository && !isSafeGitHubRepository(repository)) {
      blockers.push("GITHUB_REPO is not a safe GitHub repository name");
    }
    if (!isSafeGitRef(baseBranch)) {
      blockers.push("GITHUB_BASE_BRANCH is not a safe Git ref");
    }
  }

  return blockers;
}

export function selectedProviders(argv: readonly string[]): readonly ProviderName[] {
  const inline = argv.find((argument) => argument.startsWith("--provider="));
  const provider = inline?.slice("--provider=".length) ?? "all";
  if (provider === "all") return ALL_PROVIDERS;
  if (ALL_PROVIDERS.includes(provider as ProviderName)) {
    return [provider as ProviderName];
  }
  throw new Error(
    `Unknown --provider=${provider}; expected all or ${ALL_PROVIDERS.join(", ")}`,
  );
}

async function smokeFireworks(environment: Environment): Promise<unknown> {
  const result = await new FireworksAdapter(
    readFireworksConfig(environment, "live"),
  ).generateCandidate({
    sessionId: "external-smoke",
    candidateId: "fireworks-contract-smoke",
    strategy: "fail-closed",
    evaluationProfile: "safety-contender",
    incident: {
      title: "External structured-output smoke",
      summary:
        "A missing sensor sample must disable an actuator rather than reuse stale data.",
      evidence: ["sensor_read returned TIMEOUT", "actuator remained enabled"],
    },
    safetyPolicy: {
      policyVersion: "smoke-v1",
      invariants: ["missing safety evidence disables the actuator"],
      allowedPatchPaths: ["fixtures/battery-controller/src/**"],
      protectedPaths: ["fixtures/battery-controller/tests/**", ".github/**"],
      maxChangedFiles: 2,
      maxChangedLines: 60,
    },
    repository: {
      repoUrl: "https://github.com/example/safeflash-smoke.git",
      commitSha: "0000000000000000000000000000000000000000",
    },
    sourceContext: createFireworksSourceContext({
      commitSha: "0000000000000000000000000000000000000000",
      files: [
        {
          path: "fixtures/battery-controller/src/battery_controller.c",
          content:
            "void control_tick(bool sensor_ok) { if (sensor_ok) actuator_enabled = true; }\n",
        },
        {
          path: "fixtures/battery-controller/tests/safety_tests.c",
          content:
            "/* Trusted oracle: sensor timeout must set actuator_enabled=false. */\n",
        },
      ],
    }),
    requestedTests: ["battery_unit_tests", "battery_safety_tests"],
    seed: 20260722,
  });
  return {
    requestId: result.data.requestId,
    model: result.data.model,
    candidateId: result.data.candidate.candidateId,
    strategy: result.data.candidate.strategy,
    latencyMs: result.data.latencyMs,
    finishReason: result.data.finishReason,
    sourceContextDigest: result.data.sourceContextDigest,
    requestDigest: result.data.requestDigest,
    inputTokens: result.data.inputTokens,
    outputTokens: result.data.outputTokens,
    totalTokens: result.data.totalTokens,
    attemptCount: result.data.attemptCount,
  };
}

async function smokeDaytona(environment: Environment): Promise<unknown> {
  const result = await new DaytonaAdapter(
    readDaytonaConfig(environment, "live"),
  ).smoke();
  return result.data;
}

async function smokeBraintrust(environment: Environment): Promise<unknown> {
  const result = await new BraintrustAdapter(
    readBraintrustConfig(environment, "live"),
  ).smoke();
  return result.data;
}

async function smokeGitHub(environment: Environment): Promise<unknown> {
  const result = await new GitHubAdapter(
    readGitHubConfig(environment, "live"),
  ).smokeReadiness();
  return result.data;
}

async function smokeCodeRabbit(environment: Environment): Promise<unknown> {
  const config = readCodeRabbitConfig(environment, "live");
  const base = await new GitHubAdapter(
    readGitHubConfig(environment, "live"),
  ).smokeReadiness();
  const pullNumberText = environment.SAFEFLASH_SMOKE_PR_NUMBER!.trim();
  const headSha = environment.SAFEFLASH_SMOKE_PR_HEAD_SHA!.trim();
  const pullNumber = Number(pullNumberText);
  const result = await new CodeRabbitAdapter(config).inspectReview({
    sessionId: "external-smoke",
    pullNumber,
    headSha,
    expectedBaseRef: base.data.configuredBaseBranch,
    expectedBaseSha: base.data.baseHeadSha,
  });
  return {
    pullNumber: result.data.pullNumber,
    headSha: result.data.headSha,
    expectedBaseRef: result.data.expectedBaseRef,
    expectedBaseSha: result.data.expectedBaseSha,
    observedBaseRef: result.data.observedBaseRef,
    observedBaseSha: result.data.observedBaseSha,
    requiresFullRevalidation: result.data.requiresFullRevalidation,
    status: result.data.status,
    passed: result.data.passed,
    reason: result.data.reason,
    exactHeadEvidenceIds: result.data.exactHeadEvidenceIds,
    staleEvidenceIds: result.data.staleEvidenceIds,
    findingCount: result.data.findings.length,
  };
}

export async function runProvider(
  provider: ProviderName,
  environment: Environment = process.env,
): Promise<SmokeResult> {
  const contract = PROVIDER_OPERATIONS[provider];
  const blockers = configurationBlockers(provider, environment);
  if (blockers.length > 0) {
    return {
      provider,
      status: "blocked",
      operation: contract.operation,
      externalEffects: contract.externalEffects,
      blockers,
      reason: `Configuration preflight blocked before network access: ${blockers.join("; ")}.`,
      nextAction: `${contract.nextAction} Then rerun npm run smoke:external -- --provider=${provider}.`,
    };
  }

  try {
    const evidence = await {
      fireworks: smokeFireworks,
      daytona: smokeDaytona,
      braintrust: smokeBraintrust,
      github: smokeGitHub,
      coderabbit: smokeCodeRabbit,
    }[provider](environment);

    if (
      provider === "coderabbit" &&
      typeof evidence === "object" &&
      evidence !== null &&
      "passed" in evidence &&
      evidence.passed !== true
    ) {
      return {
        provider,
        status: "blocked",
        provenance: "live",
        evidence,
        operation: contract.operation,
        externalEffects: contract.externalEffects,
        reason: "CodeRabbit did not produce a passing exact-head review gate.",
        nextAction:
          "Open the reported exact-head review evidence, resolve blocking findings or wait for the current review, then rerun the CodeRabbit smoke.",
      };
    }
    return {
      provider,
      status: "passed",
      provenance: "live",
      evidence,
      operation: contract.operation,
      externalEffects: contract.externalEffects,
    };
  } catch (error) {
    if (
      error instanceof ProviderConfigurationError ||
      error instanceof ProviderModeError
    ) {
      return {
        provider,
        status: "blocked",
        operation: contract.operation,
        externalEffects: contract.externalEffects,
        reason: redactProviderError(error),
        nextAction: contract.nextAction,
      };
    }
    return {
      provider,
      status: "failed",
      operation: contract.operation,
      externalEffects: contract.externalEffects,
      reason: redactProviderError(error),
      nextAction:
        "Inspect provider availability, account scope, quota, and the redacted adapter error before retrying.",
    };
  }
}

export async function runSelectedProviders(
  requested: readonly ProviderName[],
  environment: Environment = process.env,
  runner: (
    provider: ProviderName,
    environment: Environment,
  ) => Promise<SmokeResult> = runProvider,
): Promise<readonly SmokeResult[]> {
  const preflight = requested.map((provider) => ({
    provider,
    blockers: configurationBlockers(provider, environment),
  }));
  if (preflight.some((item) => item.blockers.length > 0)) {
    return preflight.map(({ provider, blockers }) => {
      const contract = PROVIDER_OPERATIONS[provider];
      const effectiveBlockers =
        blockers.length > 0
          ? blockers
          : [
              "Aggregate preflight aborted because another requested provider is not configured",
            ];
      return {
        provider,
        status: "blocked",
        operation: contract.operation,
        externalEffects: contract.externalEffects,
        blockers: effectiveBlockers,
        reason: `Aggregate configuration preflight blocked before any provider client was constructed: ${effectiveBlockers.join("; ")}.`,
        nextAction: contract.nextAction,
      };
    });
  }

  const results: SmokeResult[] = [];
  for (const provider of requested) {
    results.push(await runner(provider, environment));
  }
  return results;
}

export async function main(): Promise<void> {
  if (existsSync(".env.local")) {
    loadEnvFile(".env.local");
  }
  const requested = selectedProviders(process.argv.slice(2));
  const services = await runSelectedProviders(requested, process.env);
  const result = services.some((service) => service.status === "failed")
    ? "failed"
    : services.some((service) => service.status === "blocked")
      ? "blocked"
      : "passed";
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        provenance: "local-test",
        result,
        services,
        safetyContract: [
          "Configuration preflight completes before any provider client is constructed.",
          "This smoke command never creates, updates, or merges a GitHub pull request.",
          "Provider success is reported only for live evidence returned by the requested bounded operation.",
        ],
        claim:
          result === "passed"
            ? "Every requested provider returned live, verified smoke evidence."
            : "No blocked or failed provider is claimed as successful.",
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = result === "passed" ? 0 : result === "blocked" ? 2 : 1;
}

const entryPath = process.argv[1];
const isDirectExecution =
  entryPath !== undefined &&
  resolve(entryPath).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isDirectExecution) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        provenance: "local-test",
        result: "failed",
        reason: redactProviderError(error),
        claim: "No external integration is claimed as successful.",
      })}\n`,
    );
    process.exitCode = 1;
  });
}
