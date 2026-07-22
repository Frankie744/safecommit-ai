#include "battery_controller.h"

#include <stdbool.h>
#include <stdio.h>

typedef bool (*TestFunction)(void);

typedef struct TestCase {
    const char *name;
    TestFunction function;
} TestCase;

static bool initial_state_is_safe(void)
{
    BatteryController controller;

    battery_controller_init(&controller);

    return !controller.charging_enabled &&
           !controller.fault_latched &&
           controller.fault_code == BATTERY_FAULT_NONE &&
           controller.cycles_without_update == 0U;
}

static bool normal_temperature_enables_charging(void)
{
    BatteryController controller;
    const BatterySensorSample sample = {25, false, true};

    battery_controller_init(&controller);
    battery_controller_update(&controller, sample);

    return controller.charging_enabled &&
           !controller.fault_latched &&
           controller.fault_code == BATTERY_FAULT_NONE;
}

static bool minimum_boundary_is_valid(void)
{
    BatteryController controller;
    const BatterySensorSample sample = {
        BATTERY_TEMP_VALID_MIN_C,
        false,
        true
    };

    battery_controller_init(&controller);
    battery_controller_update(&controller, sample);

    return controller.charging_enabled &&
           !controller.fault_latched &&
           controller.fault_code == BATTERY_FAULT_NONE;
}

static bool maximum_boundary_is_valid(void)
{
    BatteryController controller;
    const BatterySensorSample sample = {
        BATTERY_TEMP_VALID_MAX_C,
        false,
        true
    };

    battery_controller_init(&controller);
    battery_controller_update(&controller, sample);

    return controller.charging_enabled &&
           !controller.fault_latched &&
           controller.fault_code == BATTERY_FAULT_NONE;
}

static bool fresh_sample_resets_stale_counter(void)
{
    BatteryController controller;
    const BatterySensorSample stale_sample = {25, false, false};
    const BatterySensorSample fresh_sample = {25, false, true};

    battery_controller_init(&controller);
    battery_controller_update(&controller, stale_sample);
    battery_controller_update(&controller, stale_sample);
    battery_controller_update(&controller, fresh_sample);

    return controller.cycles_without_update == 0U;
}

int main(void)
{
    const TestCase tests[] = {
        {"initial_state_is_safe", initial_state_is_safe},
        {"normal_temperature_enables_charging", normal_temperature_enables_charging},
        {"minimum_boundary_is_valid", minimum_boundary_is_valid},
        {"maximum_boundary_is_valid", maximum_boundary_is_valid},
        {"fresh_sample_resets_stale_counter", fresh_sample_resets_stale_counter}
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
