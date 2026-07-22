import { Buffer } from "node:buffer";

import {
  computeCommandHash,
  parseCandidatePatch,
  sha256,
  type CandidatePatch,
  type CommandEvidence,
  type OperatingMode,
} from "@safeflash/domain";
import { Daytona, type Sandbox } from "@daytona/sdk";
import { validatePatchIntegrity } from "@safeflash/safety-policy";

import {
  ProviderResponseError,
  requireLiveConfiguration,
  transportEnvelope,
  type Environment,
  type ProviderEnvelope,
  type ProviderTransport,
} from "./provider";

const REPOSITORY_PATH = "/workspace/safeflash-repository";
const PATCH_PATH = "/tmp/safeflash-candidate.patch";

export type DaytonaCommandId =
  | "verify-commit"
  | "patch-check"
  | "patch-apply"
  | "configure"
  | "build"
  | "artifact-manifest"
  | "unit-tests"
  | "safety-tests"
  | "staged-diff-whitespace";

export interface DaytonaCommandDefinition {
  id: DaytonaCommandId;
  command: string;
  timeoutSeconds: number;
}

/**
 * This policy is server-owned. CandidatePatch.testsToRun is descriptive input
 * and is never converted into a shell command.
 */
export const DEFAULT_DAYTONA_COMMAND_POLICY: readonly DaytonaCommandDefinition[] =
  [
    { id: "verify-commit", command: "git rev-parse HEAD", timeoutSeconds: 10 },
    {
      id: "patch-check",
      command: `git apply --check ${PATCH_PATH}`,
      timeoutSeconds: 10,
    },
    {
      id: "patch-apply",
      command: `git apply --index ${PATCH_PATH}`,
      timeoutSeconds: 10,
    },
    {
      id: "configure",
      command:
        "cmake -S fixtures/battery-controller -B build -DCMAKE_BUILD_TYPE=Release",
      timeoutSeconds: 60,
    },
    {
      id: "build",
      command: "cmake --build build --parallel 2",
      timeoutSeconds: 90,
    },
    {
      id: "artifact-manifest",
      command:
        "sha256sum build/battery_unit_tests build/battery_safety_tests",
      timeoutSeconds: 10,
    },
    {
      id: "unit-tests",
      command: "ctest --test-dir build --output-on-failure --no-tests=error -L unit",
      timeoutSeconds: 45,
    },
    {
      id: "safety-tests",
      command: "ctest --test-dir build --output-on-failure --no-tests=error -L safety",
      timeoutSeconds: 45,
    },
    {
      id: "staged-diff-whitespace",
      command: "git diff --cached --check",
      timeoutSeconds: 10,
    },
  ];

const REQUIRED_COMMAND_ORDER = DEFAULT_DAYTONA_COMMAND_POLICY.map(
  (definition) => definition.id,
);

export interface DaytonaConfig {
  mode: "live";
  apiKey: string;
  apiUrl?: string;
  target?: string;
  retainSandboxes: boolean;
  createTimeoutSeconds: number;
  deleteTimeoutSeconds: number;
  ttlMinutes: number;
}

export interface DaytonaValidationRequest {
  runId: string;
  sessionId: string;
  candidate: CandidatePatch;
  repository: {
    repoUrl: string;
    commitSha: string;
  };
}

export interface DaytonaSandboxPort {
  id: string;
  git: {
    clone(
      url: string,
      path: string,
      branch?: string,
      commitId?: string,
    ): Promise<void>;
  };
  fs: {
    uploadFile(file: Buffer, remotePath: string, timeout?: number): Promise<void>;
  };
  process: {
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ): Promise<{ exitCode: number; result: string }>;
  };
  updateNetworkSettings(settings: { networkBlockAll: boolean }): Promise<void>;
}

export interface DaytonaClientPort {
  readonly transport: ProviderTransport;
  create(
    params: {
      language: string;
      labels: Record<string, string>;
      public: boolean;
      ephemeral: boolean;
      autoStopInterval: number;
      ttlMinutes: number;
      networkBlockAll?: boolean;
      domainAllowList?: string;
    },
    options: { timeout: number },
  ): Promise<DaytonaSandboxPort>;
  delete(
    sandbox: DaytonaSandboxPort,
    timeoutSeconds: number,
    wait: boolean,
  ): Promise<void>;
}

export interface DaytonaValidationEvidence {
  runId: string;
  sessionId: string;
  candidateId: string;
  sandboxId: string;
  commitSha: string;
  isolatedFilesystem: true;
  networkBlockedBeforePatch: true;
  retained: boolean;
  destroyed: boolean;
  passed: boolean;
  commands: readonly CommandEvidence[];
}

export interface DaytonaSmokeEvidence {
  sandboxId: string;
  command: "node -e";
  exitCode: 0;
  output: "SAFEFLASH_DAYTONA_SMOKE";
  networkBlocked: true;
  destroyed: true;
}

export function readDaytonaConfig(
  environment: Environment = process.env,
  mode: OperatingMode = "live",
): DaytonaConfig {
  const values = requireLiveConfiguration(
    "daytona",
    mode,
    environment,
    ["DAYTONA_API_KEY"] as const,
  );
  const apiUrl = environment.DAYTONA_API_URL?.trim() || undefined;
  if (apiUrl !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(apiUrl);
    } catch {
      throw new ProviderResponseError(
        "daytona",
        "DAYTONA_API_URL must be the official https://app.daytona.io/api endpoint",
        false,
      );
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.toLowerCase() !== "app.daytona.io" ||
      parsed.port !== "" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      !["/api", "/api/"].includes(parsed.pathname) ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new ProviderResponseError(
        "daytona",
        "DAYTONA_API_URL must be the official https://app.daytona.io/api endpoint",
        false,
      );
    }
  }
  return {
    mode: "live",
    apiKey: values.DAYTONA_API_KEY,
    apiUrl,
    target: environment.DAYTONA_TARGET?.trim() || undefined,
    retainSandboxes: environment.SAFEFLASH_RETAIN_SANDBOXES === "true",
    createTimeoutSeconds: 90,
    deleteTimeoutSeconds: 60,
    ttlMinutes: 10,
  };
}

export function createDaytonaClient(config: DaytonaConfig): DaytonaClientPort {
  const sdk = new Daytona({
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    target: config.target,
    // Keep optional SDK OpenTelemetry disabled. The P0 trace source is Braintrust,
    // and this also avoids exposing an inbound Jaeger propagation surface.
    otelEnabled: false,
  });
  return {
    transport: "official-sdk",
    async create(params, options) {
      return (await sdk.create(params, options)) as DaytonaSandboxPort;
    },
    async delete(sandbox, timeoutSeconds, wait) {
      await sdk.delete(sandbox as Sandbox, timeoutSeconds, wait);
    },
  };
}

function validateRepository(repository: DaytonaValidationRequest["repository"]): void {
  const url = new URL(repository.repoUrl);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new ProviderResponseError(
      "daytona",
      "Sandbox repository URL must be public github.com HTTPS without embedded credentials",
      false,
    );
  }
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(repository.commitSha)) {
    throw new ProviderResponseError(
      "daytona",
      "A full 40- or 64-character Git commit SHA is required",
      false,
    );
  }
}

function validateCommandPolicy(
  policy: readonly DaytonaCommandDefinition[],
): void {
  if (
    policy.length !== REQUIRED_COMMAND_ORDER.length ||
    policy.some(
      (definition, index) => definition.id !== REQUIRED_COMMAND_ORDER[index],
    ) ||
    new Set(policy.map((definition) => definition.id)).size !== policy.length
  ) {
    throw new ProviderResponseError(
      "daytona",
      "Daytona command policy must contain the complete validation pipeline in order",
      false,
    );
  }
  for (const definition of policy) {
    if (
      definition.command.trim() === "" ||
      !Number.isInteger(definition.timeoutSeconds) ||
      definition.timeoutSeconds <= 0 ||
      definition.timeoutSeconds > 300
    ) {
      throw new ProviderResponseError(
        "daytona",
        `Invalid trusted command definition: ${definition.id}`,
        false,
      );
    }
  }
}

function outputSummary(output: string): string {
  const normalized = output.replace(/\r\n/gu, "\n");
  return normalized.length <= 4_000
    ? normalized
    : `${normalized.slice(0, 4_000)}\n...[truncated]`;
}

export class DaytonaAdapter {
  constructor(
    private readonly config: DaytonaConfig,
    private readonly client: DaytonaClientPort = createDaytonaClient(config),
    private readonly commandPolicy: readonly DaytonaCommandDefinition[] =
      DEFAULT_DAYTONA_COMMAND_POLICY,
    private readonly clock: () => Date = () => new Date(),
  ) {
    validateCommandPolicy(commandPolicy);
  }

  async smoke(): Promise<ProviderEnvelope<DaytonaSmokeEvidence>> {
    let sandbox: DaytonaSandboxPort | undefined;
    let destroyed = false;
    try {
      sandbox = await this.client.create(
        {
          language: "typescript",
          labels: { application: "safeflash", purpose: "external-smoke" },
          public: false,
          ephemeral: true,
          autoStopInterval: 5,
          ttlMinutes: Math.min(this.config.ttlMinutes, 5),
          networkBlockAll: true,
        },
        { timeout: this.config.createTimeoutSeconds },
      );
      const response = await sandbox.process.executeCommand(
        "node -e \"process.stdout.write('SAFEFLASH_DAYTONA_SMOKE')\"",
        undefined,
        undefined,
        10,
      );
      if (
        response.exitCode !== 0 ||
        response.result !== "SAFEFLASH_DAYTONA_SMOKE"
      ) {
        throw new ProviderResponseError(
          "daytona",
          "Daytona smoke command did not return the exact expected contract",
          false,
        );
      }
      await this.client.delete(
        sandbox,
        this.config.deleteTimeoutSeconds,
        true,
      );
      destroyed = true;
      return transportEnvelope("daytona", this.client.transport, {
        sandboxId: sandbox.id,
        command: "node -e",
        exitCode: 0,
        output: "SAFEFLASH_DAYTONA_SMOKE",
        networkBlocked: true,
        destroyed: true,
      });
    } catch (error) {
      if (sandbox !== undefined && !destroyed) {
        try {
          await this.client.delete(
            sandbox,
            this.config.deleteTimeoutSeconds,
            true,
          );
        } catch (cleanupError) {
          throw new ProviderResponseError(
            "daytona",
            "Daytona smoke failed and sandbox cleanup also failed",
            true,
            { cause: cleanupError },
          );
        }
      }
      if (error instanceof ProviderResponseError) throw error;
      throw new ProviderResponseError(
        "daytona",
        "Daytona smoke failed",
        true,
        { cause: error },
      );
    }
  }

  async validateCandidate(
    request: DaytonaValidationRequest,
  ): Promise<ProviderEnvelope<DaytonaValidationEvidence>> {
    validateRepository(request.repository);
    const candidate = parseCandidatePatch(request.candidate);
    const integrity = validatePatchIntegrity(candidate.unifiedDiff);
    if (!integrity.valid) {
      throw new ProviderResponseError(
        "daytona",
        `Candidate patch failed server-owned integrity policy: ${integrity.violations
          .map((violation) => violation.code)
          .join(", ")}`,
        false,
      );
    }
    let sandbox: DaytonaSandboxPort | undefined;
    let destroyed = false;
    const commands: CommandEvidence[] = [];

    try {
      sandbox = await this.client.create(
        {
          language: "typescript",
          labels: {
            application: "safeflash",
            session: request.sessionId,
            candidate: candidate.candidateId,
            run: request.runId,
          },
          public: false,
          ephemeral: !this.config.retainSandboxes,
          autoStopInterval: 5,
          ttlMinutes: this.config.ttlMinutes,
          domainAllowList: "github.com,*.githubusercontent.com",
        },
        { timeout: this.config.createTimeoutSeconds },
      );

      await sandbox.git.clone(
        request.repository.repoUrl,
        REPOSITORY_PATH,
        undefined,
        request.repository.commitSha,
      );
      await sandbox.updateNetworkSettings({ networkBlockAll: true });
      await sandbox.fs.uploadFile(
        Buffer.from(candidate.unifiedDiff, "utf8"),
        PATCH_PATH,
        30,
      );

      for (const definition of this.commandPolicy) {
        const startedAt = this.clock();
        const response = await sandbox.process.executeCommand(
          definition.command,
          REPOSITORY_PATH,
          undefined,
          definition.timeoutSeconds,
        );
        const finishedAt = this.clock();
        const output = response.result ?? "";
        const evidence: CommandEvidence = {
          id: `${request.runId}:${definition.id}`,
          sessionId: request.sessionId,
          createdAt: startedAt.toISOString(),
          updatedAt: finishedAt.toISOString(),
          source: "daytona",
          sourceVersion: "@daytona/sdk@0.200.1",
          candidateId: candidate.candidateId,
          sandboxId: sandbox.id,
          commitSha: request.repository.commitSha,
          argv: ["/bin/sh", "-lc", definition.command],
          commandHash: computeCommandHash(
            ["/bin/sh", "-lc", definition.command],
            REPOSITORY_PATH,
          ),
          artifactHash:
            definition.id === "artifact-manifest"
              ? sha256(output.trim())
              : undefined,
          exitCode: response.exitCode,
          durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
          stdoutSummary: outputSummary(output),
          stderrSummary:
            "Daytona executeCommand returns a combined result stream; no separate stderr was supplied.",
          stdoutHash: sha256(output),
          timedOut: false,
        };
        commands.push(evidence);

        if (
          definition.id === "verify-commit" &&
          output.trim().toLowerCase() !== request.repository.commitSha.toLowerCase()
        ) {
          throw new ProviderResponseError(
            "daytona",
            "Sandbox HEAD does not match the requested immutable commit",
            false,
          );
        }
        if (response.exitCode !== 0) break;
      }

      const completedAll = commands.length === this.commandPolicy.length;
      const passed =
        completedAll && commands.every((command) => command.exitCode === 0);

      if (!this.config.retainSandboxes) {
        await this.client.delete(
          sandbox,
          this.config.deleteTimeoutSeconds,
          true,
        );
        destroyed = true;
      }

      return transportEnvelope("daytona", this.client.transport, {
        runId: request.runId,
        sessionId: request.sessionId,
        candidateId: candidate.candidateId,
        sandboxId: sandbox.id,
        commitSha: request.repository.commitSha,
        isolatedFilesystem: true,
        networkBlockedBeforePatch: true,
        retained: this.config.retainSandboxes,
        destroyed,
        passed,
        commands,
      });
    } catch (error) {
      if (sandbox !== undefined && !this.config.retainSandboxes && !destroyed) {
        try {
          await this.client.delete(
            sandbox,
            this.config.deleteTimeoutSeconds,
            true,
          );
          destroyed = true;
        } catch (cleanupError) {
          throw new ProviderResponseError(
            "daytona",
            "Daytona validation failed and sandbox cleanup also failed",
            true,
            { cause: cleanupError },
          );
        }
      }
      if (error instanceof ProviderResponseError) throw error;
      throw new ProviderResponseError(
        "daytona",
        "Daytona sandbox validation failed",
        true,
        { cause: error },
      );
    }
  }
}
