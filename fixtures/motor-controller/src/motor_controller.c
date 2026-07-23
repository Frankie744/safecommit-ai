#include "motor_controller.h"

void motor_controller_init(MotorController *controller)
{
    if (controller == 0) {
        return;
    }

    controller->pwm_enabled = false;
    controller->fault_latched = false;
    controller->applied_torque_nm = 0.0F;
    controller->fault_code = MOTOR_FAULT_NONE;
}

void motor_controller_update(MotorController *controller, float requested_torque_nm)
{
    if (controller == 0) {
        return;
    }

    /*
     * INTENTIONAL BASELINE DEFECTS FOR THE SAFEFLASH FIXTURE:
     *
     * 1. NaN is neither below MOTOR_TORQUE_MIN_NM nor above
     *    MOTOR_TORQUE_MAX_NM, so range checks alone accept it.
     * 2. A later finite command clears an earlier fault without an explicit
     *    reset.
     */
    if ((requested_torque_nm < MOTOR_TORQUE_MIN_NM) ||
        (requested_torque_nm > MOTOR_TORQUE_MAX_NM)) {
        controller->pwm_enabled = false;
        controller->fault_latched = true;
        controller->applied_torque_nm = 0.0F;
        controller->fault_code = MOTOR_FAULT_COMMAND_RANGE;
        return;
    }

    controller->pwm_enabled = true;
    controller->fault_latched = false;
    controller->applied_torque_nm = requested_torque_nm;
    controller->fault_code = MOTOR_FAULT_NONE;
}

void motor_controller_reset(MotorController *controller)
{
    motor_controller_init(controller);
}
