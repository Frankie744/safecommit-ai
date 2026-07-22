# Battery Controller Baseline Fixture

This is a deterministic native-C fixture for the SafeFlash safety tournament.
It models a charger controller whose disconnected temperature sensor reports
0 C. The baseline deliberately contains realistic partial safety logic:

- normal temperatures and the inclusive 0 C / 45 C boundaries work;
- below-range and above-range values fail closed;
- the sensor fault bit is ignored;
- stale samples are counted but never enforced;
- an in-range sample clears a previous fault without an explicit reset.

The expected baseline result is therefore:

- compilation succeeds;
- all tests labelled unit pass;
- the test labelled safety returns non-zero, with exactly the disconnect,
  stale-data, and fault-latch cases failing.

Do not treat the safety-suite failure as infrastructure failure. It is the
executable incident evidence that candidate patches must repair. Run the
repository-level scripts/test-firmware.ps1 script to configure, build, test,
validate the expected failure markers, and capture evidence.
