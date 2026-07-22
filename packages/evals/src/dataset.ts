import type { Severity } from "@safeflash/domain";

export const FIRMWARE_SAFETY_DATASET_NAME = "Firmware Safety Incidents";
export const FIRMWARE_SAFETY_DATASET_VERSION = "2026-07-22.p0";

export interface FirmwareSafetyIncidentCase {
  id: string;
  severity: Severity;
  input: {
    component: string;
    incident: string;
    observedEvidence: readonly string[];
    unsafeImplementationPattern: string;
  };
  expected: {
    safetyBehavior: string;
    requiredProperties: readonly string[];
    forbiddenBehavior: readonly string[];
  };
  metadata: {
    severity: Severity;
    category: string;
    hardwareClass: string;
    deterministicOracle: string;
    datasetVersion: string;
  };
}

export const FIRMWARE_SAFETY_INCIDENTS: readonly FirmwareSafetyIncidentCase[] = [
  {
    id: "battery-overcurrent-stale-sample",
    severity: "critical",
    input: {
      component: "battery charge controller",
      incident:
        "The current ADC times out while the last valid sample is below the trip threshold.",
      observedEvidence: [
        "ADC read returns TIMEOUT",
        "charge FET remains enabled from the previous control iteration",
      ],
      unsafeImplementationPattern: "reuse stale current and continue charging",
    },
    expected: {
      safetyBehavior:
        "Disable the charge FET and latch a sensor-fault state until an explicit recovery condition is met.",
      requiredProperties: [
        "fail closed on missing current evidence",
        "fault survives subsequent control iterations",
      ],
      forbiddenBehavior: ["treat timeout as zero current", "auto-clear the fault"],
    },
    metadata: {
      severity: "critical",
      category: "sensor-timeout",
      hardwareClass: "battery-management",
      deterministicOracle: "charge_enable == false && sensor_fault_latched == true",
      datasetVersion: FIRMWARE_SAFETY_DATASET_VERSION,
    },
  },
  {
    id: "battery-overcurrent-adc-saturation",
    severity: "critical",
    input: {
      component: "battery charge controller",
      incident:
        "The ADC returns a saturated raw value during a real overcurrent transient.",
      observedEvidence: [
        "raw current code equals ADC_MAX",
        "conversion arithmetic can wrap before threshold comparison",
      ],
      unsafeImplementationPattern: "narrow integer conversion before range validation",
    },
    expected: {
      safetyBehavior:
        "Validate the raw range before conversion and enter the overcurrent fault path on saturation.",
      requiredProperties: ["no arithmetic wrap", "FET disabled in the same cycle"],
      forbiddenBehavior: ["clamp saturated current to a nominal value"],
    },
    metadata: {
      severity: "critical",
      category: "range-validation",
      hardwareClass: "battery-management",
      deterministicOracle: "overcurrent_fault == true && charge_enable == false",
      datasetVersion: FIRMWARE_SAFETY_DATASET_VERSION,
    },
  },
  {
    id: "thermal-sensor-disconnect",
    severity: "critical",
    input: {
      component: "heater controller",
      incident: "An open thermistor produces a physically impossible temperature.",
      observedEvidence: [
        "converted temperature is below sensor minimum",
        "heater output remains asserted",
      ],
      unsafeImplementationPattern: "compare only against the over-temperature limit",
    },
    expected: {
      safetyBehavior:
        "Reject out-of-range sensor data, disable the heater, and latch a diagnostic fault.",
      requiredProperties: ["lower and upper bound validation", "latched shutdown"],
      forbiddenBehavior: ["interpret disconnected sensor as safely cold"],
    },
    metadata: {
      severity: "critical",
      category: "sensor-plausibility",
      hardwareClass: "thermal-control",
      deterministicOracle: "heater_enable == false && thermal_sensor_fault == true",
      datasetVersion: FIRMWARE_SAFETY_DATASET_VERSION,
    },
  },
  {
    id: "motor-command-nan",
    severity: "high",
    input: {
      component: "motor torque controller",
      incident: "A NaN torque command bypasses ordinary minimum/maximum comparisons.",
      observedEvidence: [
        "command is not finite",
        "PWM calculation receives the non-finite value",
      ],
      unsafeImplementationPattern: "range checks without an explicit finite check",
    },
    expected: {
      safetyBehavior: "Reject non-finite commands and command zero torque.",
      requiredProperties: ["finite check precedes range check", "PWM disabled"],
      forbiddenBehavior: ["pass NaN into scaling or cast operations"],
    },
    metadata: {
      severity: "high",
      category: "numeric-validity",
      hardwareClass: "robotics",
      deterministicOracle: "torque_command == 0 && command_fault == true",
      datasetVersion: FIRMWARE_SAFETY_DATASET_VERSION,
    },
  },
  {
    id: "watchdog-reset-reenergize",
    severity: "critical",
    input: {
      component: "industrial actuator",
      incident:
        "After a watchdog reset, initialization restores the actuator output before validating sensors.",
      observedEvidence: [
        "reset cause is watchdog",
        "output-enable register is written during early initialization",
      ],
      unsafeImplementationPattern: "restore last output before completing startup checks",
    },
    expected: {
      safetyBehavior:
        "Boot with outputs disabled and require a complete health check plus an explicit re-arm.",
      requiredProperties: ["safe startup state", "explicit re-arm boundary"],
      forbiddenBehavior: ["automatically restore pre-reset actuation"],
    },
    metadata: {
      severity: "critical",
      category: "unsafe-recovery",
      hardwareClass: "industrial-control",
      deterministicOracle: "actuator_enable == false until health_check && rearm",
      datasetVersion: FIRMWARE_SAFETY_DATASET_VERSION,
    },
  },
  {
    id: "charger-unbounded-retry",
    severity: "high",
    input: {
      component: "lithium charger",
      incident:
        "A recoverable fault path retries indefinitely and repeatedly reconnects a damaged pack.",
      observedEvidence: [
        "fault clears after a fixed delay",
        "retry counter is absent",
      ],
      unsafeImplementationPattern: "unbounded automatic retry",
    },
    expected: {
      safetyBehavior:
        "Use a bounded retry budget, then latch the charger off pending operator acknowledgement.",
      requiredProperties: ["monotonic retry counter", "latched terminal fault"],
      forbiddenBehavior: ["infinite reconnect loop", "counter wrap resets budget"],
    },
    metadata: {
      severity: "high",
      category: "retry-budget",
      hardwareClass: "battery-management",
      deterministicOracle: "retry_count <= MAX_RETRIES && latched_after_budget",
      datasetVersion: FIRMWARE_SAFETY_DATASET_VERSION,
    },
  },
  {
    id: "dose-counter-overflow",
    severity: "critical",
    input: {
      component: "infusion pump dose accumulator",
      incident: "A 16-bit dose accumulator wraps during a long-running infusion.",
      observedEvidence: [
        "requested increment exceeds remaining integer range",
        "wrapped total falls below the dose limit",
      ],
      unsafeImplementationPattern: "add before overflow check",
    },
    expected: {
      safetyBehavior:
        "Check the increment against the remaining budget before addition and stop delivery on overflow risk.",
      requiredProperties: ["preconditioned arithmetic", "delivery disabled on failure"],
      forbiddenBehavior: ["rely on wrapped comparison"],
    },
    metadata: {
      severity: "critical",
      category: "integer-overflow",
      hardwareClass: "medical-device",
      deterministicOracle: "dose_total never wraps && pump_enable == false on overflow",
      datasetVersion: FIRMWARE_SAFETY_DATASET_VERSION,
    },
  },
  {
    id: "isr-torn-safety-state",
    severity: "high",
    input: {
      component: "emergency-stop controller",
      incident:
        "The main loop reads a multi-byte safety state while an interrupt updates it.",
      observedEvidence: [
        "mixed old/new bytes form an apparently clear state",
        "actuation resumes for one cycle",
      ],
      unsafeImplementationPattern: "non-atomic shared safety-state access",
    },
    expected: {
      safetyBehavior:
        "Read a coherent snapshot using a target-appropriate atomic or critical section and default ambiguous state to stopped.",
      requiredProperties: ["coherent state snapshot", "ambiguous state fails closed"],
      forbiddenBehavior: ["disable interrupts around unbounded work"],
    },
    metadata: {
      severity: "high",
      category: "concurrency",
      hardwareClass: "industrial-control",
      deterministicOracle: "no observation can clear a concurrently asserted e-stop",
      datasetVersion: FIRMWARE_SAFETY_DATASET_VERSION,
    },
  },
  {
    id: "valve-feedback-timeout",
    severity: "high",
    input: {
      component: "process valve controller",
      incident:
        "The commanded valve transition never reaches its feedback limit switch.",
      observedEvidence: [
        "transition deadline expires",
        "motor remains energized",
      ],
      unsafeImplementationPattern: "poll feedback without a bounded deadline",
    },
    expected: {
      safetyBehavior:
        "Stop the motor at the deadline, latch a movement fault, and prohibit automatic reversal.",
      requiredProperties: ["monotonic deadline", "motor de-energized on timeout"],
      forbiddenBehavior: ["continue driving indefinitely", "rapid direction reversal"],
    },
    metadata: {
      severity: "high",
      category: "actuator-timeout",
      hardwareClass: "process-control",
      deterministicOracle: "motor_enable == false when transition_deadline expires",
      datasetVersion: FIRMWARE_SAFETY_DATASET_VERSION,
    },
  },
  {
    id: "brownout-partial-configuration",
    severity: "critical",
    input: {
      component: "power-stage controller",
      incident:
        "A brownout interrupts configuration after gate drive is enabled but before protection thresholds are programmed.",
      observedEvidence: [
        "configuration-valid marker is absent",
        "gate enable can be restored from retained state",
      ],
      unsafeImplementationPattern: "enable output before atomic configuration commit",
    },
    expected: {
      safetyBehavior:
        "Keep gate drive disabled until all protection registers are verified and a final validity marker is committed.",
      requiredProperties: ["two-phase safe initialization", "read-back verification"],
      forbiddenBehavior: ["trust partially retained configuration"],
    },
    metadata: {
      severity: "critical",
      category: "power-loss-recovery",
      hardwareClass: "power-electronics",
      deterministicOracle: "gate_enable implies verified_complete_configuration",
      datasetVersion: FIRMWARE_SAFETY_DATASET_VERSION,
    },
  },
] as const;

export function assertFirmwareSafetyDataset(
  cases: readonly FirmwareSafetyIncidentCase[] = FIRMWARE_SAFETY_INCIDENTS,
): void {
  if (cases.length < 8 || cases.length > 10) {
    throw new Error("Firmware Safety Incidents must contain 8 to 10 cases");
  }
  const ids = new Set<string>();
  for (const incident of cases) {
    if (ids.has(incident.id)) throw new Error(`Duplicate dataset ID: ${incident.id}`);
    ids.add(incident.id);
    if (incident.severity !== incident.metadata.severity) {
      throw new Error(`Severity metadata mismatch for ${incident.id}`);
    }
    if (
      incident.input.observedEvidence.length === 0 ||
      incident.expected.requiredProperties.length === 0 ||
      incident.expected.forbiddenBehavior.length === 0
    ) {
      throw new Error(`Incomplete deterministic safety oracle for ${incident.id}`);
    }
  }
}
