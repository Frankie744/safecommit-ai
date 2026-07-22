#include "battery_controller.h"

#include <stdbool.h>
#include <stdio.h>

typedef bool (*TestFunction)(void);

typedef struct TestCase {
    const char *name;
    TestFunction function;
} TestCase;

static bool sensor_disconnect_enters_safe_state(void)
{
    BatteryController controller;
    const BatterySensorSample disconnected = {
        BATTERY_TEMP_VALID_MIN_C,
        true,
        true
    };

    battery_controller_init(&controller);
    battery_controller_update(&controller, disconnected);

    if (controller.charging_enabled ||
        !controller.fault_latched ||
        controller.fault_code != BATTERY_FAULT_SENSOR_DISCONNECTED) {
        printf(
            "  expected charging=OFF latched=true fault=SENSOR_DISCONNECTED; "
            "observed charging=%s latched=%s fault=%d\n",
            controller.charging_enabled ? "ON" : "OFF",
            controller.fault_latched ? "true" : "false",
            (int)controller.fault_code
        );
        return false;
    }

    return true;
}

static bool below_minimum_temperature_enters_safe_state(void)
{
    BatteryController controller;
    const BatterySensorSample sample = {
        BATTERY_TEMP_VALID_MIN_C - 1,
        false,
        true
    };

    battery_controller_init(&controller);
    battery_controller_update(&controller, sample);

    return !controller.charging_enabled &&
           controller.fault_latched &&
           controller.fault_code == BATTERY_FAULT_TEMPERATURE_RANGE;
}

static bool above_maximum_temperature_enters_safe_state(void)
{
    BatteryController controller;
    const BatterySensorSample sample = {
        BATTERY_TEMP_VALID_MAX_C + 1,
        false,
        true
    };

    battery_controller_init(&controller);
    battery_controller_update(&controller, sample);

    return !controller.charging_enabled &&
           controller.fault_latched &&
           controller.fault_code == BATTERY_FAULT_TEMPERATURE_RANGE;
}

static bool stale_sample_limit_enters_safe_state(void)
{
    BatteryController controller;
    const BatterySensorSample fresh_sample = {25, false, true};
    const BatterySensorSample stale_sample = {25, false, false};
    uint32_t cycle;

    battery_controller_init(&controller);
    battery_controller_update(&controller, fresh_sample);

    for (cycle = 0U; cycle < BATTERY_STALE_LIMIT_CYCLES; ++cycle) {
        battery_controller_update(&controller, stale_sample);
    }

    if (controller.charging_enabled ||
        !controller.fault_latched ||
        controller.fault_code != BATTERY_FAULT_STALE_SAMPLE) {
        printf(
            "  expected charging=OFF latched=true fault=STALE_SAMPLE after %u cycles; "
            "observed charging=%s latched=%s fault=%d cycles=%u\n",
            (unsigned int)BATTERY_STALE_LIMIT_CYCLES,
            controller.charging_enabled ? "ON" : "OFF",
            controller.fault_latched ? "true" : "false",
            (int)controller.fault_code,
            (unsigned int)controller.cycles_without_update
        );
        return false;
    }

    return true;
}

static bool normal_sample_cannot_clear_latched_fault(void)
{
    BatteryController controller;
    const BatterySensorSample invalid_sample = {
        BATTERY_TEMP_VALID_MAX_C + 1,
        false,
        true
    };
    const BatterySensorSample recovered_sample = {25, false, true};

    battery_controller_init(&controller);
    battery_controller_update(&controller, invalid_sample);
    battery_controller_update(&controller, recovered_sample);

    if (controller.charging_enabled ||
        !controller.fault_latched ||
        controller.fault_code == BATTERY_FAULT_NONE) {
        printf(
            "  expected previous fault to remain latched until reset; "
            "observed charging=%s latched=%s fault=%d\n",
            controller.charging_enabled ? "ON" : "OFF",
            controller.fault_latched ? "true" : "false",
            (int)controller.fault_code
        );
        return false;
    }

    return true;
}

static bool explicit_reset_allows_controlled_recovery(void)
{
    BatteryController controller;
    const BatterySensorSample invalid_sample = {
        BATTERY_TEMP_VALID_MAX_C + 1,
        false,
        true
    };
    const BatterySensorSample recovered_sample = {25, false, true};

    battery_controller_init(&controller);
    battery_controller_update(&controller, invalid_sample);

    if (controller.charging_enabled || !controller.fault_latched) {
        return false;
    }

    battery_controller_reset(&controller);
    if (controller.charging_enabled ||
        controller.fault_latched ||
        controller.fault_code != BATTERY_FAULT_NONE) {
        return false;
    }

    battery_controller_update(&controller, recovered_sample);
    return controller.charging_enabled &&
           !controller.fault_latched &&
           controller.fault_code == BATTERY_FAULT_NONE;
}

int main(void)
{
    const TestCase tests[] = {
        {"sensor_disconnect_enters_safe_state", sensor_disconnect_enters_safe_state},
        {"below_minimum_temperature_enters_safe_state", below_minimum_temperature_enters_safe_state},
        {"above_maximum_temperature_enters_safe_state", above_maximum_temperature_enters_safe_state},
        {"stale_sample_limit_enters_safe_state", stale_sample_limit_enters_safe_state},
        {"normal_sample_cannot_clear_latched_fault", normal_sample_cannot_clear_latched_fault},
        {"explicit_reset_allows_controlled_recovery", explicit_reset_allows_controlled_recovery}
    };
    const size_t test_count = sizeof(tests) / sizeof(tests[0]);
    size_t passed = 0U;
    size_t index;

    for (index = 0U; index < test_count; ++index) {
        const bool result = tests[index].function();
        printf("[%s] %s\n", result ? "PASS" : "FAIL", tests[index].name);
        if (result) {
            passed += 1U;
        }
    }

    printf(
        "[SUMMARY] %zu passed, %zu failed\n",
        passed,
        test_count - passed
    );

    return passed == test_count ? 0 : 1;
}
