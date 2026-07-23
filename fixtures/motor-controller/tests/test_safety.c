#include "motor_controller.h"

#include <math.h>
#include <stdbool.h>
#include <stdio.h>

typedef bool (*TestFunction)(void);
typedef struct TestCase {
    const char *name;
    TestFunction function;
} TestCase;

static bool command_fault_is_safe(
    float command,
    MotorFaultCode expected_fault
)
{
    MotorController controller;
    motor_controller_init(&controller);
    motor_controller_update(&controller, command);
    return !controller.pwm_enabled &&
           controller.fault_latched &&
           controller.applied_torque_nm == 0.0F &&
           controller.fault_code == expected_fault;
}

static bool nan_command_disables_pwm(void)
{
    return command_fault_is_safe(NAN, MOTOR_FAULT_COMMAND_NONFINITE);
}

static bool positive_infinity_disables_pwm(void)
{
    return command_fault_is_safe(INFINITY, MOTOR_FAULT_COMMAND_NONFINITE);
}

static bool negative_infinity_disables_pwm(void)
{
    return command_fault_is_safe(-INFINITY, MOTOR_FAULT_COMMAND_NONFINITE);
}

static bool out_of_range_command_disables_pwm(void)
{
    return command_fault_is_safe(
        MOTOR_TORQUE_MAX_NM + 1.0F,
        MOTOR_FAULT_COMMAND_RANGE
    );
}

static bool finite_command_cannot_clear_latched_fault(void)
{
    MotorController controller;
    motor_controller_init(&controller);
    motor_controller_update(&controller, MOTOR_TORQUE_MAX_NM + 1.0F);
    motor_controller_update(&controller, 10.0F);
    return !controller.pwm_enabled &&
           controller.fault_latched &&
           controller.applied_torque_nm == 0.0F &&
           controller.fault_code == MOTOR_FAULT_COMMAND_RANGE;
}

static bool reset_allows_controlled_recovery(void)
{
    MotorController controller;
    motor_controller_init(&controller);
    motor_controller_update(&controller, NAN);
    motor_controller_reset(&controller);
    motor_controller_update(&controller, 10.0F);
    return controller.pwm_enabled &&
           !controller.fault_latched &&
           controller.applied_torque_nm == 10.0F &&
           controller.fault_code == MOTOR_FAULT_NONE;
}

int main(void)
{
    const TestCase tests[] = {
        {"nan_command_disables_pwm", nan_command_disables_pwm},
        {"positive_infinity_disables_pwm", positive_infinity_disables_pwm},
        {"negative_infinity_disables_pwm", negative_infinity_disables_pwm},
        {"out_of_range_command_disables_pwm", out_of_range_command_disables_pwm},
        {"finite_command_cannot_clear_latched_fault", finite_command_cannot_clear_latched_fault},
        {"reset_allows_controlled_recovery", reset_allows_controlled_recovery}
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
