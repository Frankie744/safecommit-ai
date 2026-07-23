#include "motor_controller.h"

#include <stdbool.h>
#include <stdio.h>

typedef bool (*TestFunction)(void);
typedef struct TestCase {
    const char *name;
    TestFunction function;
} TestCase;

static bool initial_state_is_safe(void)
{
    MotorController controller;
    motor_controller_init(&controller);
    return !controller.pwm_enabled &&
           !controller.fault_latched &&
           controller.applied_torque_nm == 0.0F &&
           controller.fault_code == MOTOR_FAULT_NONE;
}

static bool finite_command_enables_pwm(void)
{
    MotorController controller;
    motor_controller_init(&controller);
    motor_controller_update(&controller, 24.0F);
    return controller.pwm_enabled &&
           !controller.fault_latched &&
           controller.applied_torque_nm == 24.0F;
}

static bool minimum_boundary_is_valid(void)
{
    MotorController controller;
    motor_controller_init(&controller);
    motor_controller_update(&controller, MOTOR_TORQUE_MIN_NM);
    return controller.pwm_enabled &&
           controller.applied_torque_nm == MOTOR_TORQUE_MIN_NM;
}

static bool maximum_boundary_is_valid(void)
{
    MotorController controller;
    motor_controller_init(&controller);
    motor_controller_update(&controller, MOTOR_TORQUE_MAX_NM);
    return controller.pwm_enabled &&
           controller.applied_torque_nm == MOTOR_TORQUE_MAX_NM;
}

static bool explicit_reset_returns_safe_idle(void)
{
    MotorController controller;
    motor_controller_init(&controller);
    motor_controller_update(&controller, MOTOR_TORQUE_MAX_NM + 1.0F);
    motor_controller_reset(&controller);
    return !controller.pwm_enabled &&
           !controller.fault_latched &&
           controller.applied_torque_nm == 0.0F &&
           controller.fault_code == MOTOR_FAULT_NONE;
}

int main(void)
{
    const TestCase tests[] = {
        {"initial_state_is_safe", initial_state_is_safe},
        {"finite_command_enables_pwm", finite_command_enables_pwm},
        {"minimum_boundary_is_valid", minimum_boundary_is_valid},
        {"maximum_boundary_is_valid", maximum_boundary_is_valid},
        {"explicit_reset_returns_safe_idle", explicit_reset_returns_safe_idle}
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

    printf("[SUMMARY] %zu passed, %zu failed\n", passed, test_count - passed);
    return passed == test_count ? 0 : 1;
}
