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

/** Deterministic local fixtures. They are never represented as Fireworks output. */
export const LOCAL_TOURNAMENT_CANDIDATES: readonly CandidatePatch[] = Object.freeze([
  candidateA,
  candidateB,
  candidateC,
]);
