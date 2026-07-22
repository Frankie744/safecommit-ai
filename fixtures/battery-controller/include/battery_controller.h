#ifndef SAFEFLASH_BATTERY_CONTROLLER_H
#define SAFEFLASH_BATTERY_CONTROLLER_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
    BATTERY_TEMP_VALID_MIN_C = 0,
    BATTERY_TEMP_VALID_MAX_C = 45,
    BATTERY_STALE_LIMIT_CYCLES = 3
};

typedef enum BatteryFaultCode {
    BATTERY_FAULT_NONE = 0,
    BATTERY_FAULT_SENSOR_DISCONNECTED = 1,
    BATTERY_FAULT_TEMPERATURE_RANGE = 2,
    BATTERY_FAULT_STALE_SAMPLE = 3
} BatteryFaultCode;

typedef struct BatterySensorSample {
    int32_t temperature_c;
    bool sensor_fault;
    bool sample_fresh;
} BatterySensorSample;

typedef struct BatteryController {
    bool charging_enabled;
    bool fault_latched;
    BatteryFaultCode fault_code;
    uint32_t cycles_without_update;
} BatteryController;

void battery_controller_init(BatteryController *controller);
void battery_controller_update(
    BatteryController *controller,
    BatterySensorSample sample
);
void battery_controller_reset(BatteryController *controller);

#ifdef __cplusplus
}
#endif

#endif
