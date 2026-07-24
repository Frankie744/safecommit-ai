export interface DeviceTelemetryPayload {
  readonly sensor_temperature: number;
  readonly charger_enabled: boolean;
}

export type DeviceTelemetrySource = "http" | "serial" | "simulator";

export interface DeviceTelemetrySnapshot extends DeviceTelemetryPayload {
  readonly source: DeviceTelemetrySource;
  readonly displayLabel:
    | "HTTP DEVICE"
    | "SERIAL DEVICE"
    | "SIMULATED DEVICE";
  readonly connected: boolean;
  readonly simulated: boolean;
  readonly receivedAt: string;
  readonly ageMs: number;
  readonly deviceIdentifier?: string;
  readonly fallbackReason?: string;
}
