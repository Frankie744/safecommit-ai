import type {
  DeviceTelemetryPayload,
  DeviceTelemetrySnapshot,
} from "./device-types";

async function readTelemetryResponse(
  response: Response,
): Promise<DeviceTelemetrySnapshot> {
  if (!response.ok) {
    throw new Error(
      `SafeFlash device telemetry API ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as {
    telemetry?: DeviceTelemetrySnapshot;
  };
  if (!payload.telemetry) {
    throw new Error("SafeFlash device telemetry API returned no telemetry.");
  }
  return payload.telemetry;
}

export async function getDeviceTelemetry(): Promise<DeviceTelemetrySnapshot> {
  return readTelemetryResponse(
    await fetch("/api/device", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    }),
  );
}

export async function postHttpDeviceTelemetry(
  telemetry: DeviceTelemetryPayload,
): Promise<DeviceTelemetrySnapshot> {
  return readTelemetryResponse(
    await fetch("/api/device", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(telemetry),
    }),
  );
}
