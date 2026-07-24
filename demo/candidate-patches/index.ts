import {
  CandidatePatchSchema,
  type CandidatePatch,
} from "@safeflash/domain";

const candidateA = CandidatePatchSchema.parse({
  candidateId: "candidate-a-range-clamp",
  strategy: "range-validation",
  hypothesis:
    "Clamp implausible temperatures into the configured range before normal control.",
  unifiedDiff: `diff --git a/fixtures/battery-controller/src/battery_controller.c b/fixtures/battery-controller/src/battery_controller.c
--- a/fixtures/battery-controller/src/battery_controller.c
+++ b/fixtures/battery-controller/src/battery_controller.c
@@ -26,6 +26,12 @@ void battery_controller_update(
     } else {
         controller->cycles_without_update += 1U;
     }
+
+    if (sample.temperature_c < BATTERY_TEMP_VALID_MIN_C) {
+        sample.temperature_c = BATTERY_TEMP_VALID_MIN_C;
+    } else if (sample.temperature_c > BATTERY_TEMP_VALID_MAX_C) {
+        sample.temperature_c = BATTERY_TEMP_VALID_MAX_C;
+    }
\u0020
     /*
      * INTENTIONAL BASELINE DEFECTS FOR THE SAFEFLASH FIXTURE:
`,
  expectedSafetyEffect: [
    "The controller never consumes a temperature outside the configured range.",
  ],
  risks: [
    "Clamping destroys fault evidence and cannot distinguish a disconnected sensor from a valid boundary reading.",
  ],
  testsToRun: ["battery_unit_tests", "battery_safety_tests"],
});

const candidateB = CandidatePatchSchema.parse({
  candidateId: "candidate-b-retry-latch",
  strategy: "retry-and-latch",
  hypothesis:
    "Immediately latch an explicit disconnect fault before processing temperature.",
  unifiedDiff: `diff --git a/fixtures/battery-controller/src/battery_controller.c b/fixtures/battery-controller/src/battery_controller.c
--- a/fixtures/battery-controller/src/battery_controller.c
+++ b/fixtures/battery-controller/src/battery_controller.c
@@ -26,6 +26,13 @@ void battery_controller_update(
     } else {
         controller->cycles_without_update += 1U;
     }
+
+    if (sample.sensor_fault) {
+        controller->charging_enabled = false;
+        controller->fault_latched = true;
+        controller->fault_code = BATTERY_FAULT_SENSOR_DISCONNECTED
+        return;
+    }
\u0020
     /*
      * INTENTIONAL BASELINE DEFECTS FOR THE SAFEFLASH FIXTURE:
`,
  expectedSafetyEffect: [
    "A disconnected sensor should immediately disable charging and latch a diagnostic.",
  ],
  risks: [
    "The generated patch contains a C syntax error and must be rejected by the build gate.",
  ],
  testsToRun: ["battery_unit_tests", "battery_safety_tests"],
});

const candidateC = CandidatePatchSchema.parse({
  candidateId: "candidate-c-fail-closed",
  strategy: "fail-closed",
  hypothesis:
    "Fail closed on explicit sensor faults and stale data, while preserving every latched fault until reset.",
  unifiedDiff: `diff --git a/fixtures/battery-controller/src/battery_controller.c b/fixtures/battery-controller/src/battery_controller.c
--- a/fixtures/battery-controller/src/battery_controller.c
+++ b/fixtures/battery-controller/src/battery_controller.c
@@ -26,6 +26,26 @@ void battery_controller_update(
     } else {
         controller->cycles_without_update += 1U;
     }
+
+    if (controller->fault_latched) {
+        controller->charging_enabled = false;
+        return;
+    }
+
+    if (sample.sensor_fault) {
+        controller->charging_enabled = false;
+        controller->fault_latched = true;
+        controller->fault_code = BATTERY_FAULT_SENSOR_DISCONNECTED;
+        return;
+    }
+
+    if ((!sample.sample_fresh) &&
+        (controller->cycles_without_update >= BATTERY_STALE_LIMIT_CYCLES)) {
+        controller->charging_enabled = false;
+        controller->fault_latched = true;
+        controller->fault_code = BATTERY_FAULT_STALE_SAMPLE;
+        return;
+    }
\u0020
     /*
      * INTENTIONAL BASELINE DEFECTS FOR THE SAFEFLASH FIXTURE:
`,
  expectedSafetyEffect: [
    "Sensor disconnects and stale samples disable charging in the same control cycle.",
    "Faults remain latched until battery_controller_reset is called.",
    "Normal in-range behavior and inclusive temperature boundaries are preserved.",
  ],
  risks: [
    "The reset caller remains responsible for verifying that the physical fault has cleared.",
  ],
  testsToRun: ["battery_unit_tests", "battery_safety_tests"],
});

const happyCandidateA = CandidatePatchSchema.parse({
  candidateId: "happy-a-explicit-guards",
  strategy: "range-validation",
  hypothesis:
    "Preserve the existing range validation while adding explicit, named guards for every missing-evidence state.",
  unifiedDiff: `diff --git a/fixtures/battery-controller/src/battery_controller.c b/fixtures/battery-controller/src/battery_controller.c
--- a/fixtures/battery-controller/src/battery_controller.c
+++ b/fixtures/battery-controller/src/battery_controller.c
@@ -26,6 +26,31 @@ void battery_controller_update(
     } else {
         controller->cycles_without_update += 1U;
     }
+
+    const bool prior_fault_is_latched = controller->fault_latched;
+    const bool sensor_is_disconnected = sample.sensor_fault;
+    const bool sensor_evidence_is_missing =
+        (!sample.sample_fresh) &&
+        (controller->cycles_without_update >= BATTERY_STALE_LIMIT_CYCLES);
+
+    if (prior_fault_is_latched) {
+        controller->charging_enabled = false;
+        return;
+    }
+
+    if (sensor_is_disconnected) {
+        controller->charging_enabled = false;
+        controller->fault_latched = true;
+        controller->fault_code = BATTERY_FAULT_SENSOR_DISCONNECTED;
+        return;
+    }
+
+    if (sensor_evidence_is_missing) {
+        controller->charging_enabled = false;
+        controller->fault_latched = true;
+        controller->fault_code = BATTERY_FAULT_STALE_SAMPLE;
+        return;
+    }
\u0020
     /*
      * INTENTIONAL BASELINE DEFECTS FOR THE SAFEFLASH FIXTURE:
`,
  expectedSafetyEffect: [
    "Named guards reject disconnected and stale sensor evidence before the range controller can enable charging.",
    "An existing latched fault remains authoritative until reset.",
  ],
  risks: [
    "The explicit intermediate state is easy to audit but adds more changed lines than the minimal fail-closed repair.",
  ],
  testsToRun: ["battery_unit_tests", "battery_safety_tests"],
});

const happyCandidateB = CandidatePatchSchema.parse({
  candidateId: "happy-b-pending-fault",
  strategy: "retry-and-latch",
  hypothesis:
    "Classify the current sensor failure first, then latch the classified fault in one guarded update.",
  unifiedDiff: `diff --git a/fixtures/battery-controller/src/battery_controller.c b/fixtures/battery-controller/src/battery_controller.c
--- a/fixtures/battery-controller/src/battery_controller.c
+++ b/fixtures/battery-controller/src/battery_controller.c
@@ -26,6 +26,28 @@ void battery_controller_update(
     } else {
         controller->cycles_without_update += 1U;
     }
+
+    if (controller->fault_latched) {
+        controller->charging_enabled = false;
+        return;
+    }
+
+    BatteryFaultCode pending_fault = BATTERY_FAULT_NONE;
+    if (sample.sensor_fault) {
+        pending_fault = BATTERY_FAULT_SENSOR_DISCONNECTED;
+    } else if (
+        (!sample.sample_fresh) &&
+        (controller->cycles_without_update >= BATTERY_STALE_LIMIT_CYCLES)
+    ) {
+        pending_fault = BATTERY_FAULT_STALE_SAMPLE;
+    }
+
+    if (pending_fault != BATTERY_FAULT_NONE) {
+        controller->charging_enabled = false;
+        controller->fault_latched = true;
+        controller->fault_code = pending_fault;
+        return;
+    }
\u0020
     /*
      * INTENTIONAL BASELINE DEFECTS FOR THE SAFEFLASH FIXTURE:
`,
  expectedSafetyEffect: [
    "A classified disconnect or stale-sample fault disables charging and becomes latched.",
    "A prior latched fault remains disabled until explicit reset.",
  ],
  risks: [
    "The temporary classification variable creates a larger patch surface than the direct fail-closed guards.",
  ],
  testsToRun: ["battery_unit_tests", "battery_safety_tests"],
});

/** Deterministic local fixtures. They are never represented as Fireworks output. */
export const LOCAL_TOURNAMENT_CANDIDATES: readonly CandidatePatch[] = Object.freeze([
  candidateA,
  candidateB,
  candidateC,
]);

/**
 * A separate, repository-owned happy-path fixture. All three candidates must
 * pass the real build and safety suites; the selector then chooses the most
 * minimal eligible repair without changing any hard-gate semantics.
 */
export const HAPPY_PATH_TOURNAMENT_CANDIDATES: readonly CandidatePatch[] =
  Object.freeze([happyCandidateA, happyCandidateB, candidateC]);
