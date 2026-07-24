import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Daytona, Image } from "@daytona/sdk";

type Sandbox = Awaited<ReturnType<Daytona["create"]>>;
type Snapshot = Awaited<ReturnType<Daytona["snapshot"]["get"]>>;

const DOCKERFILE_PATH = resolve(
  "fixtures/logistics-mysql/Dockerfile.daytona",
);
const SNAPSHOT_INPUTS = [
  DOCKERFILE_PATH,
  resolve("fixtures/logistics-mysql/schema/001_schema.sql"),
  resolve("fixtures/logistics-mysql/seed/002_seed.sql"),
] as const;
const MYSQL_URI = "mysql://root@127.0.0.1:3306/safecommit";
const MYSQL_ENTRYPOINT = [
  "docker-entrypoint.sh",
  "mysqld",
  "--bind-address=127.0.0.1",
  "--character-set-server=utf8mb4",
  "--collation-server=utf8mb4_0900_ai_ci",
  "--default-authentication-plugin=mysql_native_password",
  "--transaction-isolation=READ-COMMITTED",
] as const;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

export async function computeSnapshotName(): Promise<string> {
  const hash = createHash("sha256");
  for (const path of SNAPSHOT_INPUTS) {
    hash.update(await readFile(path));
  }
  hash.update(JSON.stringify(MYSQL_ENTRYPOINT));
  return `safecommit-mysql-8036-${hash.digest("hex").slice(0, 12)}`;
}

function active(snapshot: Snapshot): boolean {
  return snapshot.state.toLowerCase() === "active";
}

async function deleteSandbox(
  client: Daytona,
  sandbox: Sandbox,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await client.delete(sandbox, 90, true);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function findSnapshot(
  client: Daytona,
  name: string,
): Promise<Snapshot | undefined> {
  const page = await client.snapshot.list(1, 100);
  return page.items.find((snapshot) => snapshot.name === name);
}

async function createOrReuseSnapshot(
  client: Daytona,
  name: string,
): Promise<{ snapshot: Snapshot; reused: boolean }> {
  const existing = await findSnapshot(client, name);
  if (existing !== undefined) {
    if (!active(existing)) {
      throw new Error(
        `Daytona snapshot ${name} exists but is ${existing.state}`,
      );
    }
    return { snapshot: existing, reused: true };
  }
  const image = Image.fromDockerfile(DOCKERFILE_PATH);
  const snapshot = await client.snapshot.create(
    {
      name,
      image,
      resources: { cpu: 2, memory: 4, disk: 8 },
      entrypoint: [...MYSQL_ENTRYPOINT],
    },
    { timeout: 900 },
  );
  if (!active(snapshot)) {
    throw new Error(
      `Daytona snapshot ${name} finished in unexpected state ${snapshot.state}`,
    );
  }
  return { snapshot, reused: false };
}

async function verifySnapshot(
  client: Daytona,
  snapshot: Snapshot,
): Promise<{
  sandboxId: string;
  mysqlVersion: string;
  nodeVersion: string;
  tsxVersion: string;
  destroyed: true;
}> {
  let sandbox: Sandbox | undefined;
  let destroyed = false;
  try {
    sandbox = await client.create(
      {
        snapshot: snapshot.name,
        labels: {
          application: "safecommit",
          purpose: "database-snapshot-verification",
        },
        public: false,
        ephemeral: true,
        autoStopInterval: 5,
        ttlMinutes: 10,
        networkBlockAll: true,
      },
      { timeout: 120 },
    );
    const command = [
      "set -eu;",
      "ready=0;",
      "for attempt in $(seq 1 60); do",
      "if mysqladmin ping --protocol=tcp --host=127.0.0.1 --user=root --silent >/dev/null 2>&1; then ready=1; break; fi;",
      "sleep 1;",
      "done;",
      'test "$ready" = "1";',
      'node_version="$(node --version)";',
      'mysql_version="$(mysql --protocol=tcp --host=127.0.0.1 --user=root --batch --skip-column-names --execute=\'SELECT VERSION()\')";',
      'tsx_version="$(/workspace/node_modules/.bin/tsx --version | head -n 1)";',
      'printf "NODE=%s\\nMYSQL=%s\\nTSX=%s\\n" "$node_version" "$mysql_version" "$tsx_version"',
    ].join(" ");
    const result = await sandbox.process.executeCommand(
      command,
      "/workspace",
      undefined,
      90,
    );
    const output = new Map(
      result.result
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => /^(?:MYSQL|NODE|TSX)=/u.test(line))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)] as const;
      }),
    );
    if (
      result.exitCode !== 0 ||
      !output.get("NODE")?.startsWith("v22.") ||
      !output.get("MYSQL")?.startsWith("8.0.") ||
      !output.get("TSX")?.startsWith("tsx v4.")
    ) {
      throw new Error("Daytona database snapshot verification failed");
    }
    await deleteSandbox(client, sandbox);
    destroyed = true;
    return {
      sandboxId: sandbox.id,
      nodeVersion: output.get("NODE")!,
      mysqlVersion: output.get("MYSQL")!,
      tsxVersion: output.get("TSX")!,
      destroyed: true,
    };
  } finally {
    if (sandbox !== undefined && !destroyed) {
      await deleteSandbox(client, sandbox);
    }
  }
}

export async function main(): Promise<void> {
  if (process.env.SAFEFLASH_ALLOW_LIVE !== "true") {
    throw new Error("SAFEFLASH_ALLOW_LIVE must equal true");
  }
  const apiKey = required("DAYTONA_API_KEY");
  const client = new Daytona({ apiKey, otelEnabled: false });
  const name = await computeSnapshotName();
  const { snapshot, reused } = await createOrReuseSnapshot(client, name);
  const verification = await verifySnapshot(client, snapshot);
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        provenance: "live",
        result: "passed",
        snapshot: {
          id: snapshot.id,
          name: snapshot.name,
          state: snapshot.state,
          imageName: snapshot.imageName,
          reused,
        },
        verification,
        requiredLocalEnvironment: {
          DAYTONA_DATABASE_SNAPSHOT: snapshot.name,
          DAYTONA_DATABASE_MYSQL_URL: MYSQL_URI,
        },
      },
      null,
      2,
    )}\n`,
  );
}

const entryPath = process.argv[1];
const isDirectExecution =
  entryPath !== undefined &&
  resolve(entryPath).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isDirectExecution) {
  void main().catch((error: unknown) => {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown Daytona snapshot creation failure";
    process.stderr.write(`Daytona database snapshot failed: ${message}\n`);
    process.exitCode = 1;
  });
}
