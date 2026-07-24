import { describe, expect, it } from "vitest";

import {
  GET,
  POST,
} from "../../apps/web/app/api/device/route";

describe("device telemetry HTTP route", () => {
  it("accepts only the two telemetry fields and reports HTTP provenance honestly", async () => {
    const response = await POST(
      new Request("http://localhost/api/device", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sensor_temperature: 44.5,
          charger_enabled: false,
        }),
      }),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      telemetry: {
        source: "http",
        displayLabel: "HTTP DEVICE",
        connected: true,
        simulated: false,
        sensor_temperature: 44.5,
        charger_enabled: false,
      },
    });
    expect(response.headers.get("cache-control")).toContain("no-store");

    const current = await GET();
    expect(current.status).toBe(200);
    await expect(current.json()).resolves.toMatchObject({
      telemetry: { source: "http", simulated: false },
    });
  });

  it("rejects extra fields without reflecting their values", async () => {
    const response = await POST(
      new Request("http://localhost/api/device", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sensor_temperature: 44.5,
          charger_enabled: false,
          authorization: "sensitive-placeholder",
        }),
      }),
    );
    expect(response.status).toBe(400);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("INVALID_DEVICE_TELEMETRY");
    expect(body).not.toContain("sensitive-placeholder");
  });
});
