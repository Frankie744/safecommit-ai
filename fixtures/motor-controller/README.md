# Motor controller executable safety fixture

This repository-owned C fixture represents a torque-controlled motor drive.
Its intentional baseline defect accepts a non-finite (`NaN`) torque command
because ordinary minimum/maximum comparisons do not reject `NaN`.

The hard safety contract is executable:

- a non-finite torque command must set applied torque to zero;
- PWM must be disabled in the same control update;
- the command fault must latch until an explicit reset;
- an ordinary finite command cannot clear a latched fault.

SafeFlash runs repository-owned candidate patches against the real CMake/CTest
suite in isolated local copies. This fixture is a **simulated device target**,
and its results are **local-test evidence**, never provider-verified evidence.
