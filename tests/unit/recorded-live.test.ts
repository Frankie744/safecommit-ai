import {
  createRecordedLiveArtifact,
  parseRecordedLiveArtifact,
  serializeRecordedLiveArtifact,
  type RecordedLiveCaptureInput,
} from "@safeflash/domain";
import { describe, expect, it } from "vitest";

import {
  RECORDED_LIVE_TEST_SIGNING_KEY,
  recordedLiveCaptureFixture,
} from "../fixtures/recorded-live";

describe("recorded-live artifact boundary", () => {
  it("creates an immutable canonical artifact from complete live evidence", () => {
    const artifact = createRecordedLiveArtifact(
      recordedLiveCaptureFixture(),
      RECORDED_LIVE_TEST_SIGNING_KEY,
    );
    const parsed = parseRecordedLiveArtifact(
      JSON.parse(
        serializeRecordedLiveArtifact(
          artifact,
          RECORDED_LIVE_TEST_SIGNING_KEY,
        ),
      ),
      RECORDED_LIVE_TEST_SIGNING_KEY,
    );

    expect(parsed.digest).toBe(artifact.digest);
    expect(parsed.durationMs).toBe(10_000);
    expect(parsed.providers.map((provider) => provider.provider)).toEqual([
      "fireworks",
      "daytona",
      "braintrust",
      "github",
      "coderabbit",
    ]);
    expect(parsed.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.providers[0])).toBe(true);
  });

  it("rejects incomplete, unverified, sensitive, and unordered captures", () => {
    const missingProvider = recordedLiveCaptureFixture();
    missingProvider.providers.pop();
    expect(() =>
      createRecordedLiveArtifact(
        missingProvider as RecordedLiveCaptureInput,
        RECORDED_LIVE_TEST_SIGNING_KEY,
      ),
    ).toThrow();

    const unverified = recordedLiveCaptureFixture();
    unverified.providers[0]!.provenance.verified = false as true;
    expect(() =>
      createRecordedLiveArtifact(unverified, RECORDED_LIVE_TEST_SIGNING_KEY),
    ).toThrow();

    const sensitive = recordedLiveCaptureFixture();
    sensitive.events[0]!.summary = [
      "Author",
      "ization: ",
      "Bear",
      "er ",
      "test-sensitive-value",
    ].join("");
    expect(() =>
      createRecordedLiveArtifact(sensitive, RECORDED_LIVE_TEST_SIGNING_KEY),
    ).toThrow(
      /sensitive material/iu,
    );

    const unordered = recordedLiveCaptureFixture();
    unordered.events[1]!.sequence = 7;
    expect(() =>
      createRecordedLiveArtifact(unordered, RECORDED_LIVE_TEST_SIGNING_KEY),
    ).toThrow(
      /contiguous/iu,
    );
  });

  it("rejects missing provider resource kinds and incomplete Daytona cleanup", () => {
    const missingTrace = recordedLiveCaptureFixture();
    const braintrust = missingTrace.providers.find(
      (provider) => provider.provider === "braintrust",
    )!;
    braintrust.resources = braintrust.resources.filter(
      (resource) => resource.kind !== "trace",
    );
    expect(() =>
      createRecordedLiveArtifact(missingTrace, RECORDED_LIVE_TEST_SIGNING_KEY),
    ).toThrow(
      /missing trace/iu,
    );

    const missingEvalResult = recordedLiveCaptureFixture();
    const evalProvider = missingEvalResult.providers.find(
      (provider) => provider.provider === "braintrust",
    )!;
    evalProvider.resources = evalProvider.resources.filter(
      (resource) => resource.kind !== "eval-result",
    );
    expect(() =>
      createRecordedLiveArtifact(
        missingEvalResult,
        RECORDED_LIVE_TEST_SIGNING_KEY,
      ),
    ).toThrow(/missing eval-result/iu);

    const incompleteCleanup = recordedLiveCaptureFixture();
    const daytona = incompleteCleanup.providers.find(
      (provider) => provider.provider === "daytona",
    )!;
    daytona.cleanup!.resourceIds = ["another-sandbox"];
    expect(() =>
      createRecordedLiveArtifact(
        incompleteCleanup,
        RECORDED_LIVE_TEST_SIGNING_KEY,
      ),
    ).toThrow(
      /deletion of every sandbox/iu,
    );
  });

  it("detects changes to immutable provider IDs and event timing", () => {
    const artifact = createRecordedLiveArtifact(
      recordedLiveCaptureFixture(),
      RECORDED_LIVE_TEST_SIGNING_KEY,
    );
    const providerTamper = structuredClone(artifact);
    providerTamper.providers[0]!.resources[0]!.id = "changed-response-id";
    expect(() =>
      parseRecordedLiveArtifact(
        providerTamper,
        RECORDED_LIVE_TEST_SIGNING_KEY,
      ),
    ).toThrow(
      /digest mismatch/iu,
    );

    const timingTamper = structuredClone(artifact);
    timingTamper.events[0]!.durationMs += 1;
    expect(() =>
      parseRecordedLiveArtifact(
        timingTamper,
        RECORDED_LIVE_TEST_SIGNING_KEY,
      ),
    ).toThrow(
      /digest mismatch/iu,
    );
  });

  it("binds GitHub and CodeRabbit to the exact PR head", () => {
    const wrongHead = recordedLiveCaptureFixture();
    const coderabbit = wrongHead.providers.find(
      (provider) => provider.provider === "coderabbit",
    )!;
    coderabbit.resources = coderabbit.resources.map((resource) =>
      resource.kind === "head-sha"
        ? { ...resource, id: "9".repeat(40) }
        : resource,
    );
    expect(() =>
      createRecordedLiveArtifact(wrongHead, RECORDED_LIVE_TEST_SIGNING_KEY),
    ).toThrow(
      /exact PR\/base\/head/iu,
    );
  });

  it("binds every candidate to a provider-owned Braintrust Eval result ID", () => {
    const wrongEvalResult = recordedLiveCaptureFixture();
    wrongEvalResult.session.candidates[0]!.score.resultId =
      "unrecorded-eval-result";
    expect(() =>
      createRecordedLiveArtifact(
        wrongEvalResult,
        RECORDED_LIVE_TEST_SIGNING_KEY,
      ),
    ).toThrow(/Eval result IDs/iu);
  });

  it("rejects a structurally valid fixture without the capture authority key", () => {
    const artifact = createRecordedLiveArtifact(
      recordedLiveCaptureFixture(),
      RECORDED_LIVE_TEST_SIGNING_KEY,
    );
    expect(() =>
      parseRecordedLiveArtifact(
        artifact,
        "different-recorded-live-signing-key-0000000000001",
      ),
    ).toThrow(/attestation mismatch/iu);
  });
});
