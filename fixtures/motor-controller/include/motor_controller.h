#ifndef SAFEFLASH_MOTOR_CONTROLLER_H
#define SAFEFLASH_MOTOR_CONTROLLER_H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MOTOR_TORQUE_MIN_NM (-100.0F)
#define MOTOR_TORQUE_MAX_NM (100.0F)

typedef enum MotorFaultCode {
    MOTOR_FAULT_NONE = 0,
    MOTOR_FAULT_COMMAND_RANGE = 1,
    MOTOR_FAULT_COMMAND_NONFINITE = 2
} MotorFaultCode;

typedef struct MotorController {
    bool pwm_enabled;
    bool fault_latched;
    float applied_torque_nm;
    MotorFaultCode fault_code;
} MotorController;

void motor_controller_init(MotorController *controller);
void motor_controller_update(MotorController *controller, float requested_torque_nm);
void motor_controller_reset(MotorController *controller);

#ifdef __cplusplus
}
#endif

#endif
