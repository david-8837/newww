/* Grid Macro 1 QMK configuration (RP2040-Zero). */
#pragma once

/* Matrix dimensions: 3 rows for keys + 1 row for encoder press switch. */
#define MATRIX_ROWS 4
#define MATRIX_COLS 3

#define USB_POLLING_INTERVAL_MS 1
#define DEBOUNCE 3

/* EC11 encoder direction is reversed by the board's wiring. */
#define ENCODER_DIRECTION_FLIP

/* RP2040 wear-leveling emulated EEPROM: 4 KB logical (0..4095) partitioned into:
 *   0 .. 1023    : QMK / VIA core + dynamic keymap + dynamic macros
 *   1024 .. 2047 : Micro Pad 4-profile & per-layer RGB persistence
 */
#define WEAR_LEVELING_LOGICAL_SIZE 4096
#define WEAR_LEVELING_BACKING_SIZE (WEAR_LEVELING_LOGICAL_SIZE * 2)
#define DYNAMIC_KEYMAP_EEPROM_MAX_ADDR 1023
#define DYNAMIC_KEYMAP_LAYER_COUNT 4

#define TAPPING_TERM 200

/* One onboard WS2812 indicator on GP16. */
#define WS2812_DI_PIN GP16
#define RGBLIGHT_LIMIT_VAL 220
#define RGBLIGHT_VAL_STEP 10
#define RGBLIGHT_EFFECT_BREATHING
#define RGBLIGHT_EFFECT_RAINBOW_MOOD
#define RGBLIGHT_EFFECT_STATIC_GRADIENT
