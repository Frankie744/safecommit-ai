import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import {
  BraintrustAdapter,
  CodeRabbitAdapter,
  DaytonaAdapter,
  FireworksAdapter,
  GitHubAdapter,
  ProviderConfigurationError,
  ProviderModeError,
  readBraintrustConfig,
  readCodeRabbitConfig,
  readDaytonaConfig,
  readFireworksConfig,
  readGitHubConfig,
  redactProviderError,
  type ProviderName,
} from "@safeflash/integrations";

if (existsSync(".env.local")) {
  loadEnvFile(".env.local");
}

type SmokeStatus = "passed" | "blocked" | "failed";

interface SmokeResult {
  provider: ProviderName;
  status: SmokeStatus;
  provenance?: "live";
  evidence?: unknown;
  reason?: string;
}

const ALL_PROVIDERS: readonly ProviderName[] = [
  "fireworks",
  "daytona",
  "braintrust",
  "github",
  "coderabbit",
];

function selectedProviders(argv: readonly string[]): readonly ProviderName[] {
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

async function smokeFireworks(): Promise<unknown> {
  const result = await new FireworksAdapter(
    readFireworksConfig(process.env, "live"),
  ).generateCandidate({
    sessionId: "external-smoke",
    candidateId: "fireworks-contract-smoke",
    strategy: "fail-closed",
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
    inputTokens: result.data.inputTokens,
    outputTokens: result.data.outputTokens,
    totalTokens: result.data.totalTokens,
    attemptCount: result.data.attemptCount,
  };
}

async function smokeDaytona(): Promise<unknown> {
  const result = await new DaytonaAdapter(
    readDaytonaConfig(process.env, "live"),
  ).smoke();
  return result.data;
}

async function smokeBraintrust(): Promise<unknown> {
  const result = await new BraintrustAdapter(
    readBraintrustConfig(process.env, "live"),
  ).smoke();
  return result.data;
}

async function smokeGitHub(): Promise<unknown> {
  const result = await new GitHubAdapter(
    readGitHubConfig(process.env, "live"),
  ).smokeReadiness();
  return result.data;
}

async function smokeCodeRabbit(): Promise<unknown> {
  const config = readCodeRabbitConfig(process.env, "live");
  const pullNumberText = process.env.SAFEFLASH_SMOKE_PR_NUMBER?.trim();
  const headSha = process.env.SAFEFLASH_SMOKE_PR_HEAD_SHA?.trim();
  const missing = [
    ...(pullNumberText ? [] : ["SAFEFLASH_SMOKE_PR_NUMBER"]),
    ...(headSha ? [] : ["SAFEFLASH_SMOKE_PR_HEAD_SHA"]),
  ];
  if (missing.length > 0) {
    throw new ProviderConfigurationError("coderabbit", missing);
  }
  const pullNumber = Number(pullNumberText);
  const result = await new CodeRabbitAdapter(config).inspectReview({
    sessionId: "external-smoke",
    pullNumber,
    headSha: headSha!,
  });
  return {
    pullNumber: result.data.pullNumber,
    headSha: result.data.headSha,
    status: result.data.status,
    passed: result.data.passed,
    reason: result.data.reason,
    exactHeadEvidenceIds: result.data.exactHeadEvidenceIds,
    staleEvidenceIds: result.data.staleEvidenceIds,
    findingCount: result.data.findings.length,
  };
}

async function runProvider(provider: ProviderName): Promise<SmokeResult> {
  try {
    const evidence = await {
      fireworks: smokeFireworks,
      daytona: smokeDaytona,
      braintrust: smokeBraintrust,
      github: smokeGitHub,
      coderabbit: smokeCodeRabbit,
    }[provider]();

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
        reason: "CodeRabbit did not produce a passing exact-head review gate.",
      };
    }
    return { provider, status: "passed", provenance: "live", evidence };
  } catch (error) {
    if (
      error instanceof ProviderConfigurationError ||
      error instanceof ProviderModeError
    ) {
      return {
        provider,
        status: "blocked",
        reason: redactProviderError(error),
      };
    }
    return {
      provider,
      status: "failed",
      reason: redactProviderError(error),
    };
  }
}

async function main(): Promise<void> {
  const requested = selectedProviders(process.argv.slice(2));
  const services: SmokeResult[] = [];
  for (const provider of requested) {
    services.push(await runProvider(provider));
  }
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
