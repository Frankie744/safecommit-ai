import { z } from "zod";

import type {
  DeviceTelemetryPayload,
  DeviceTelemetrySnapshot,
  DeviceTelemetrySource,
} from "../lib/device-types";

export const DEFAULT_DEVICE_TELEMETRY_FRESHNESS_MS = 5_000;

const DeviceTelemetryPayloadSchema = z
  .object({
    sensor_temperature: z.number().min(-273.15).max(1_000),
    charger_enabled: z.boolean(),
  })
  .strict();

interface ExternalTelemetryRecord extends DeviceTelemetryPayload {
  readonly source: Exclude<DeviceTelemetrySource, "simulator">;
  readonly receivedAtMs: number;
  readonly deviceIdentifier?: string;
}

export interface DeviceTelemetryServiceOptions {
  readonly freshnessMs?: number;
  readonly now?: () => number;
  readonly simulator?: () => DeviceTelemetryPayload;
}

export interface DeviceTelemetryIngestionPort {
  ingestHttp(input: unknown): DeviceTelemetrySnapshot;
  ingestSerial(
    input: unknown,
    deviceIdentifier?: string,
  ): DeviceTelemetrySnapshot;
  ingestSerialFrame(
    frame: string,
    deviceIdentifier?: string,
  ): DeviceTelemetrySnapshot;
  getSnapshot(): DeviceTelemetrySnapshot;
}

export class DeviceTelemetryInputError extends Error {
  readonly code = "INVALID_DEVICE_TELEMETRY";

  constructor(message: string) {
    super(message);
    this.name = "DeviceTelemetryInputError";
  }
}

function parsePayload(input: unknown): DeviceTelemetryPayload {
  const parsed = DeviceTelemetryPayloadSchema.safeParse(input);
  if (!parsed.success) {
    throw new DeviceTelemetryInputError(
      "Telemetry must contain only finite sensor_temperature and boolean charger_enabled fields.",
    );
  }
  return parsed.data;
}

function normalizeDeviceIdentifier(value: string | undefined): string | undefined {
  const identifier = value?.trim();
  if (!identifier) return undefined;
  if (identifier.length > 128) {
    throw new DeviceTelemetryInputError(
      "A serial device identifier must be 128 characters or fewer.",
    );
  }
  return identifier;
}

/**
 * This in-memory adapter deliberately performs no serial-port discovery or I/O.
 * A user-selected serial bridge can pass newline-delimited JSON frames to
 * ingestSerialFrame, so the web demo never depends on a specific port name.
 */
export class DeviceTelemetryService implements DeviceTelemetryIngestionPort {
  private readonly freshnessMs: number;
  private readonly now: () => number;
  private readonly simulator: () => DeviceTelemetryPayload;
  private latestExternal?: ExternalTelemetryRecord;

  constructor(options: DeviceTelemetryServiceOptions = {}) {
    this.freshnessMs =
      options.freshnessMs ?? DEFAULT_DEVICE_TELEMETRY_FRESHNESS_MS;
    if (!Number.isFinite(this.freshnessMs) || this.freshnessMs < 0) {
      throw new Error("Device telemetry freshnessMs must be non-negative.");
    }
    this.now = options.now ?? Date.now;
    this.simulator =
      options.simulator ??
      (() => ({
        sensor_temperature: 76.4,
        charger_enabled: false,
      }));
  }

  ingestHttp(input: unknown): DeviceTelemetrySnapshot {
    return this.ingestExternal("http", parsePayload(input));
  }

  ingestSerial(
    input: unknown,
    deviceIdentifier?: string,
  ): DeviceTelemetrySnapshot {
    return this.ingestExternal(
      "serial",
      parsePayload(input),
      normalizeDeviceIdentifier(deviceIdentifier),
    );
  }

  ingestSerialFrame(
    frame: string,
    deviceIdentifier?: string,
  ): DeviceTelemetrySnapshot {
    let payload: unknown;
    try {
      payload = JSON.parse(frame) as unknown;
    } catch {
      throw new DeviceTelemetryInputError(
        "A serial telemetry frame must be valid JSON.",
      );
    }
    return this.ingestSerial(payload, deviceIdentifier);
  }

  getSnapshot(): DeviceTelemetrySnapshot {
    const nowMs = this.now();
    if (this.latestExternal) {
      const ageMs = Math.max(0, nowMs - this.latestExternal.receivedAtMs);
      if (ageMs <= this.freshnessMs) {
        return this.externalSnapshot(this.latestExternal, ageMs);
      }
    }

    const simulated = parsePayload(this.simulator());
    return {
      ...simulated,
      source: "simulator",
      displayLabel: "SIMULATED DEVICE",
      connected: false,
      simulated: true,
      receivedAt: new Date(nowMs).toISOString(),
      ageMs: 0,
      fallbackReason: this.latestExternal
        ? "External device telemetry expired; software simulator fallback is active."
        : "No external device telemetry received; software simulator fallback is active.",
    };
  }

  private ingestExternal(
    source: Exclude<DeviceTelemetrySource, "simulator">,
    payload: DeviceTelemetryPayload,
    deviceIdentifier?: string,
  ): DeviceTelemetrySnapshot {
    const receivedAtMs = this.now();
    this.latestExternal = {
      ...payload,
      source,
      receivedAtMs,
      deviceIdentifier,
    };
    return this.externalSnapshot(this.latestExternal, 0);
  }

  private externalSnapshot(
    record: ExternalTelemetryRecord,
    ageMs: number,
  ): DeviceTelemetrySnapshot {
    return {
      sensor_temperature: record.sensor_temperature,
      charger_enabled: record.charger_enabled,
      source: record.source,
      displayLabel:
        record.source === "serial" ? "SERIAL DEVICE" : "HTTP DEVICE",
      connected: true,
      simulated: false,
      receivedAt: new Date(record.receivedAtMs).toISOString(),
      ageMs,
      deviceIdentifier: record.deviceIdentifier,
    };
  }
}

let activeDeviceTelemetryService: DeviceTelemetryService | undefined;

export function getDeviceTelemetryService(): DeviceTelemetryService {
  activeDeviceTelemetryService ??= new DeviceTelemetryService();
  return activeDeviceTelemetryService;
}
