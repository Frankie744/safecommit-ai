import { describe, expect, it } from "vitest";

import {
  DeviceTelemetryInputError,
  DeviceTelemetryService,
} from "../../apps/web/server/device-telemetry";

describe("non-blocking optional device telemetry", () => {
  it("returns an honestly labeled software fallback when no device is present", () => {
    const service = new DeviceTelemetryService({
      now: () => Date.parse("2026-07-23T08:00:00.000Z"),
    });

    expect(service.getSnapshot()).toEqual({
      sensor_temperature: 76.4,
      charger_enabled: false,
      source: "simulator",
      displayLabel: "SIMULATED DEVICE",
      connected: false,
      simulated: true,
      receivedAt: "2026-07-23T08:00:00.000Z",
      ageMs: 0,
      fallbackReason:
        "No external device telemetry received; software simulator fallback is active.",
    });
  });

  it("accepts HTTP telemetry, then falls back without blocking after disconnect", () => {
    let nowMs = Date.parse("2026-07-23T08:00:00.000Z");
    const service = new DeviceTelemetryService({
      now: () => nowMs,
      freshnessMs: 1_000,
    });

    expect(
      service.ingestHttp({
        sensor_temperature: 42.25,
        charger_enabled: true,
      }),
    ).toMatchObject({
      source: "http",
      displayLabel: "HTTP DEVICE",
      connected: true,
      simulated: false,
      sensor_temperature: 42.25,
      charger_enabled: true,
    });

    nowMs += 1_001;
    expect(service.getSnapshot()).toMatchObject({
      source: "simulator",
      displayLabel: "SIMULATED DEVICE",
      connected: false,
      simulated: true,
      fallbackReason:
        "External device telemetry expired; software simulator fallback is active.",
    });
  });

  it("accepts a user-routed serial JSON frame without assuming a port name", () => {
    const service = new DeviceTelemetryService({
      now: () => Date.parse("2026-07-23T08:00:00.000Z"),
    });

    expect(
      service.ingestSerialFrame(
        '{"sensor_temperature":38.5,"charger_enabled":false}',
        "bench-bridge-alpha",
      ),
    ).toMatchObject({
      source: "serial",
      displayLabel: "SERIAL DEVICE",
      connected: true,
      simulated: false,
      deviceIdentifier: "bench-bridge-alpha",
    });
  });

  it("strictly rejects malformed, extra, or physically invalid telemetry", () => {
    const service = new DeviceTelemetryService();
    for (const input of [
      { sensor_temperature: 25 },
      { sensor_temperature: Number.NaN, charger_enabled: false },
      {
        sensor_temperature: 25,
        charger_enabled: false,
        authorization: "must-not-be-accepted",
      },
    ]) {
      expect(() => service.ingestHttp(input)).toThrow(
        DeviceTelemetryInputError,
      );
    }
    expect(() => service.ingestSerialFrame("not-json")).toThrow(
      DeviceTelemetryInputError,
    );
  });
});
