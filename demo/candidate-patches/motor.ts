import {
  CandidatePatchSchema,
  type CandidatePatch,
} from "@safeflash/domain";

const motorRangeOnly = CandidatePatchSchema.parse({
  candidateId: "motor-a-range-only",
  strategy: "range-validation",
  hypothesis:
    "Clamp torque commands into the documented operating range before enabling PWM.",
  unifiedDiff: `diff --git a/fixtures/motor-controller/src/motor_controller.c b/fixtures/motor-controller/src/motor_controller.c
--- a/fixtures/motor-controller/src/motor_controller.c
+++ b/fixtures/motor-controller/src/motor_controller.c
@@ -18,5 +18,11 @@ void motor_controller_update(MotorController *controller, float requested_torque_nm)
         return;
     }
+
+    if (requested_torque_nm < MOTOR_TORQUE_MIN_NM) {
+        requested_torque_nm = MOTOR_TORQUE_MIN_NM;
+    } else if (requested_torque_nm > MOTOR_TORQUE_MAX_NM) {
+        requested_torque_nm = MOTOR_TORQUE_MAX_NM;
+    }
\u0020
     /*
      * INTENTIONAL BASELINE DEFECTS FOR THE SAFEFLASH FIXTURE:
`,
  expectedSafetyEffect: [
    "Finite torque commands remain inside the documented range.",
  ],
  risks: [
    "NaN bypasses both comparisons, so this high-scoring patch remains physically unsafe.",
  ],
  testsToRun: ["motor_unit_tests", "motor_safety_tests"],
});

const motorBrokenLatch = CandidatePatchSchema.parse({
  candidateId: "motor-b-broken-latch",
  strategy: "retry-and-latch",
  hypothesis:
    "Latch invalid commands before PWM is enabled.",
  unifiedDiff: `diff --git a/fixtures/motor-controller/src/motor_controller.c b/fixtures/motor-controller/src/motor_controller.c
--- a/fixtures/motor-controller/src/motor_controller.c
+++ b/fixtures/motor-controller/src/motor_controller.c
@@ -1,4 +1,5 @@
 #include "motor_controller.h"
+#include <math.h>
\u0020
 void motor_controller_init(MotorController *controller)
 {
@@ -18,5 +19,13 @@ void motor_controller_update(MotorController *controller, float requested_torque_nm)
         return;
     }
+
+    if (!isfinite(requested_torque_nm)) {
+        controller->pwm_enabled = false;
+        controller->fault_latched = true;
+        controller->applied_torque_nm = 0.0F;
+        controller->fault_code = MOTOR_FAULT_COMMAND_NONFINITE
+        return;
+    }
\u0020
     /*
      * INTENTIONAL BASELINE DEFECTS FOR THE SAFEFLASH FIXTURE:
`,
  expectedSafetyEffect: [
    "Non-finite commands should latch a fault and disable PWM.",
  ],
  risks: [
    "The generated patch has a C syntax error and must be rejected by the build gate.",
  ],
  testsToRun: ["motor_unit_tests", "motor_safety_tests"],
});

const motorFailClosed = CandidatePatchSchema.parse({
  candidateId: "motor-c-fail-closed",
  strategy: "fail-closed",
  hypothesis:
    "Treat non-finite commands as missing control evidence, de-energize PWM, and preserve every fault until explicit reset.",
  unifiedDiff: `diff --git a/fixtures/motor-controller/src/motor_controller.c b/fixtures/motor-controller/src/motor_controller.c
--- a/fixtures/motor-controller/src/motor_controller.c
+++ b/fixtures/motor-controller/src/motor_controller.c
@@ -1,4 +1,5 @@
 #include "motor_controller.h"
+#include <math.h>
\u0020
 void motor_controller_init(MotorController *controller)
 {
@@ -18,5 +19,19 @@ void motor_controller_update(MotorController *controller, float requested_torque_nm)
         return;
     }
+
+    if (controller->fault_latched) {
+        controller->pwm_enabled = false;
+        controller->applied_torque_nm = 0.0F;
+        return;
+    }
+
+    if (!isfinite(requested_torque_nm)) {
+        controller->pwm_enabled = false;
+        controller->fault_latched = true;
+        controller->applied_torque_nm = 0.0F;
+        controller->fault_code = MOTOR_FAULT_COMMAND_NONFINITE;
+        return;
+    }
\u0020
     /*
      * INTENTIONAL BASELINE DEFECTS FOR THE SAFEFLASH FIXTURE:
`,
  expectedSafetyEffect: [
    "NaN and infinity disable PWM and apply zero torque in the same update.",
    "The command fault remains latched until explicit reset.",
    "Normal finite commands and inclusive range boundaries remain valid.",
  ],
  risks: [
    "The reset caller must still verify the physical command source before recovery.",
  ],
  testsToRun: ["motor_unit_tests", "motor_safety_tests"],
});

export const MOTOR_TOURNAMENT_CANDIDATES: readonly CandidatePatch[] =
  Object.freeze([motorRangeOnly, motorBrokenLatch, motorFailClosed]);
