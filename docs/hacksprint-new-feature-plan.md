# SafeFlash HackSprint day-of feature plan

## Decision

The official competition-day feature is:

> **Cross-Device Assurance Profiles**
>
> One safety gate, multiple classes of physical devices.

**Pre-event status:** planned only. The executable Motor profile, generic
profile-driven runner, Motor candidate patches, and UI evidence are not
implemented in the pre-event branch. They must not be described as completed.

Implementation may begin only after the official HackSprint hacking window
opens. The resulting source commit, tests, evidence, and screenshots must all
be captured after that boundary.

## Pre-event baseline

The existing verified reference implementation is a simulated Battery
controller backed by real compiled C:

- incident: temperature-sensor disconnect while charging;
- unsafe physical state: charging remains enabled;
- hard-gate result: a higher-scoring unsafe candidate is ineligible;
- safe result: charging is disabled and the fault remains latched;
- device provenance: `SIMULATED DEVICE`;
- firmware provenance: real compiled native C fixture;
- Provider provenance: authoritative `LIVE`, `RECORDED_LIVE`, or `MOCK`
  labels remain separate from device provenance.

The ten-row incident dataset models additional hardware classes, but only the
Battery controller is executable before the HackSprint. Do not claim ten
executable devices.

## Day-of implementation

### 1. Server-owned executable profile

Create a repository-owned profile contract similar to:

```ts
interface ExecutableIncidentProfile {
  targetId: string;
  hardwareClass: string;
  incident: Incident;
  safetyPolicy: ImmutableSafetyPolicy;
  fixtureDirectory: string;
  sourceContextPaths: readonly string[];
  allowedPatchPaths: readonly string[];
  protectedPaths: readonly string[];
  commandPolicyId: string;
  unitTestLabel: string;
  safetyTestLabel: string;
}
```

The model and browser must never provide shell commands. `commandPolicyId`
selects a fixed, server-owned command sequence.

### 2. Executable simulated Motor controller

Add:

```text
fixtures/motor-controller/
  CMakeLists.txt
  README.md
  include/motor_controller.h
  src/motor_controller.c
  tests/test_unit.c
  tests/test_safety.c
```

The incident is `motor-command-nan`:

```text
non-finite torque command
-> unsafe baseline allows the value to reach PWM calculation
-> safe behavior commands zero torque, disables PWM, and latches a fault
```

Normal finite commands and boundary behavior must continue to pass unit tests.
NaN and positive/negative infinity must fail closed.

### 3. Same hard-gate path

Run three Motor candidates through the same eligibility and ranking semantics:

```text
BuildSuccess == 1
SafetyInvariant == 1
PatchIntegrity == 1
UnitTestPassRate >= 0.95
```

At least one candidate should demonstrate that a high weighted score cannot
compensate for a failed Motor safety invariant. Device-specific code must not
introduce a second selector or weaker thresholds.

### 4. Evidence contract

Motor evidence must bind:

- `targetId` and profile version;
- source commit and before/after tree identities;
- patch and evidence digests;
- fixed command-policy identity;
- compiler, build, unit-test, and safety-test results;
- separate sandbox identity;
- provenance of `LOCAL TEST`, `LIVE`, or `RECORDED_LIVE`;
- simulated-device status.

### 5. Competition command and UI

Add a bounded command such as:

```text
npm run demo:cross-device
```

Expected summary:

```text
EXECUTABLE_PROFILES=2
BATTERY_PROFILE=PASS
MOTOR_PROFILE=PASS
SIMULATED_DEVICES=YES
HARD_GATE_BYPASS=0
```

The website should add only a compact cross-device evidence comparison. The
Battery incident remains the three-minute primary story. Detailed Motor diffs,
tests, and provenance stay collapsed in Technical Evidence.

## Required day-of verification

After implementation:

1. run the Motor native build and targeted unit/safety tests;
2. run the profile-driven Battery and Motor integration path;
3. run adversarial tests proving one profile cannot modify another profile's
   protected paths or command policy;
4. run TypeScript, full unit/integration tests, Playwright Chrome, production
   build, secret scan, `npm audit`, `npm run verify:p0`, and `npm run rehearsal`;
5. capture a new evidence directory and SHA-256 manifest;
6. preserve the first post-start implementation commit and final verified head;
7. update the Draft competition PR without merging it;
8. update README, Devpost, slides, and the pitch only after the evidence exists.

## Allowed claims after verification

Only after the day-of evidence passes:

```text
Two executable simulated device profiles
Ten modeled firmware-safety incidents
One non-bypassable hard-gate architecture
```

Do not claim:

- ten executable devices;
- physical hardware or HIL validation;
- universal firmware safety;
- live Provider evidence when the run is local or mock;
- Motor support before the day-of implementation and evidence exist.

## Policy Composer

Safety Policy Composer remains a disabled roadmap item. It is not the official
day-of feature and must not be implemented or presented as an active converter
for this submission.

The product continues to rely on repository-owned, engineer-reviewed safety
policies. An AI-generated policy draft could never activate itself, weaken an
existing hard gate, replace executable tests, or authorize hardware access.
