import { NextResponse } from "next/server";

import {
  DeviceTelemetryInputError,
  getDeviceTelemetryService,
} from "../../../server/device-telemetry";
import { apiErrorResponse, readJsonBody } from "../../../server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStoreHeaders = {
  "Cache-Control": "no-store, max-age=0",
};

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { telemetry: getDeviceTelemetryService().getSnapshot() },
    { headers: noStoreHeaders },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const telemetry = getDeviceTelemetryService().ingestHttp(
      await readJsonBody(request),
    );
    return NextResponse.json(
      { telemetry },
      { status: 202, headers: noStoreHeaders },
    );
  } catch (error) {
    if (error instanceof DeviceTelemetryInputError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: 400, headers: noStoreHeaders },
      );
    }
    return apiErrorResponse(error);
  }
}
