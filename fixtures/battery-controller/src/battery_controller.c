#include "battery_controller.h"

void battery_controller_init(BatteryController *controller)
{
    if (controller == 0) {
        return;
    }

    controller->charging_enabled = false;
    controller->fault_latched = false;
    controller->fault_code = BATTERY_FAULT_NONE;
    controller->cycles_without_update = 0U;
}

void battery_controller_update(
    BatteryController *controller,
    BatterySensorSample sample
)
{
    if (controller == 0) {
        return;
    }

    if (sample.sample_fresh) {
        controller->cycles_without_update = 0U;
    } else {
        controller->cycles_without_update += 1U;
    }

    /*
     * INTENTIONAL BASELINE DEFECTS FOR THE SAFEFLASH FIXTURE:
     *
     * 1. sample.sensor_fault is ignored. A disconnected sensor returns 0 C,
     *    which is accepted as the inclusive lower boundary.
     * 2. cycles_without_update is counted but never enforced.
     * 3. A later in-range value clears an earlier fault without an explicit
     *    reset, so faults are not truly latched.
     *
     * The range check below is valid baseline behavior and ensures this is a
     * realistic partial implementation rather than a controller that always
     * succeeds or always fails.
     */
    if ((sample.temperature_c < BATTERY_TEMP_VALID_MIN_C) ||
        (sample.temperature_c > BATTERY_TEMP_VALID_MAX_C)) {
        controller->charging_enabled = false;
        controller->fault_latched = true;
        controller->fault_code = BATTERY_FAULT_TEMPERATURE_RANGE;
        return;
    }

    controller->charging_enabled = true;
    controller->fault_latched = false;
    controller->fault_code = BATTERY_FAULT_NONE;
}

void battery_controller_reset(BatteryController *controller)
{
    battery_controller_init(controller);
}
