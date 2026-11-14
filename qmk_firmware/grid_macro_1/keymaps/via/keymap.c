/* keymap.c - Production VIA & Dynamic Keymap for Grid Macro 1 (RP2040-Zero) */
#include QMK_KEYBOARD_H
#include "raw_hid.h"
#include "eeprom.h"
#include "dynamic_keymap.h"

/* Four hardware layers (MAX_HARDWARE_LAYERS = 4) */
enum micro_pad_layers {
    _BASE = 0,
    _MEDIA = 1,
    _NUMPAD = 2,
    _FN = 3
};

#define MP_MAX_PROFILES 4
#define MP_MAX_LAYERS 4
#define MP_HID_PREFIX 0xFD
#define MP_CMD_GET_STATE 0x01
#define MP_CMD_SELECT_PROFILE 0x02
#define MP_CMD_SAVE_PROFILE 0x03
#define MP_CMD_SET_RGB 0x04
#define MP_EVT_LAYER_STATE 0x10
#define MP_EVT_HOST_TRIGGER 0x11

/* Host trigger keycode range: 0x7E00 .. 0x7E3F
 * Bits [5:4] = layer (0..3), Bits [3:0] = slot index (0..11: 0..8 keys, 9 cw, 10 press, 11 ccw)
 */
#define MP_TRIG_BASE 0x7E00
#define MP_TRIG_MAX  0x7E3F

/* Hardware profile switch keycodes: 0x7E40 .. 0x7E43 (Profile 1 .. Profile 4) */
#define MP_PROF_BASE 0x7E40
#define MP_PROF_MAX  0x7E43
#define MP_PROF_1    0x7E40
#define MP_PROF_2    0x7E41
#define MP_PROF_3    0x7E42
#define MP_PROF_4    0x7E43

/* RP2040 EEPROM layout for 4-profile storage & RGB config (above VIA dynamic keymap region 0..1023) */
#define MP_EEPROM_MAGIC_ADDR 1024
#define MP_EEPROM_MAGIC_VAL  0x4D50 /* "MP" */
/* 1026..1047: 1B active_profile, 1B rgb_enabled, 12B layer RGB (4x3), 4B layer mode, 4B layer speed */
#define MP_EEPROM_STATE_ADDR 1026
#define MP_EEPROM_PROFILES_BASE 1056
/* Each profile stores 4 layers * (12 matrix positions + 2 encoder directions) * 2 bytes = 112 bytes */
#define MP_PROFILE_STRIDE 112

#define MP_LED_MODE_OFF     0
#define MP_LED_MODE_SOLID   1
#define MP_LED_MODE_RAINBOW 2
#define MP_LED_MODE_BREATH  3

static uint8_t mp_active_profile = 0;
static uint8_t mp_rgb_enabled = 1;
static uint8_t mp_trigger_seq = 0;
static uint8_t mp_layer_rgb[MP_MAX_LAYERS][3] = {
    { 0, 81, 255 },   /* BASE: Electric Blue */
    { 16, 185, 129 }, /* MEDIA: Emerald Green */
    { 245, 158, 11 }, /* NUMPAD: Amber */
    { 225, 29, 72 }   /* FN: Crimson Red */
};
static uint8_t mp_layer_mode[MP_MAX_LAYERS] = {
    MP_LED_MODE_SOLID,
    MP_LED_MODE_SOLID,
    MP_LED_MODE_SOLID,
    MP_LED_MODE_SOLID
};
static uint8_t mp_layer_speed[MP_MAX_LAYERS] = { 50, 50, 50, 50 };

static uint8_t mp_pulse_active = 0;
static uint32_t mp_pulse_start = 0;
static uint8_t mp_has_drawn_rgb = 0;
static uint8_t mp_last_out_r = 0;
static uint8_t mp_last_out_g = 0;
static uint8_t mp_last_out_b = 0;
static uint32_t mp_last_anim_tick = 0;
static uint8_t mp_anim_phase = 0;

/* Dynamic EEPROM Layers (Configurable live via VIA / Desktop App) */
const uint16_t PROGMEM keymaps[][MATRIX_ROWS][MATRIX_COLS] = {
    [_BASE] = LAYOUT_grid_macro_1(
        KC_MPLY,
        KC_Q,       KC_W,       KC_E,
        KC_A,       KC_S,       KC_D,
        KC_Z,       KC_X,       MO(_FN)
    ),
    [_MEDIA] = LAYOUT_grid_macro_1(
        KC_MUTE,
        KC_MPRV,    KC_MPLY,    KC_MNXT,
        KC_LEFT,    KC_UP,      KC_RGHT,
        KC_HOME,    KC_DOWN,    MO(_FN)
    ),
    [_NUMPAD] = LAYOUT_grid_macro_1(
        KC_EQL,
        KC_P7,      KC_P8,      KC_P9,
        KC_P4,      KC_P5,      KC_P6,
        KC_P1,      KC_P2,      MO(_FN)
    ),
    [_FN] = LAYOUT_grid_macro_1(
        UG_TOGG,
        UG_NEXT,    UG_HUEU,    UG_SATU,
        TO(_BASE),  TO(_MEDIA), TO(_NUMPAD),
        QK_BOOT,    EE_CLR,     _______
    )
};

#if defined(ENCODER_MAP_ENABLE)
const uint16_t PROGMEM encoder_map[][NUM_ENCODERS][NUM_DIRECTIONS] = {
    [_BASE]   = { ENCODER_CCW_CW(KC_VOLD, KC_VOLU) },
    [_MEDIA]  = { ENCODER_CCW_CW(KC_MPRV, KC_MNXT) },
    [_NUMPAD] = { ENCODER_CCW_CW(C(KC_Z), C(KC_Y)) },
    [_FN]     = { ENCODER_CCW_CW(UG_VALD, UG_VALU) },
};
#endif

static void mp_set_ws2812_if_changed(uint8_t r, uint8_t g, uint8_t b) {
    if (!mp_has_drawn_rgb || r != mp_last_out_r || g != mp_last_out_g || b != mp_last_out_b) {
        mp_last_out_r = r;
        mp_last_out_g = g;
        mp_last_out_b = b;
        mp_has_drawn_rgb = 1;
        rgblight_setrgb_at(r, g, b, 0);
    }
}

static void mp_wheel_rgb(uint8_t hue, uint8_t val, uint8_t *out_r, uint8_t *out_g, uint8_t *out_b) {
    uint8_t region = hue / 43;
    uint8_t rem = (uint8_t)((hue - (region * 43)) * 6);
    uint8_t p = 0;
    uint8_t q = (uint8_t)(((uint16_t)val * (255 - rem)) >> 8);
    uint8_t t = (uint8_t)(((uint16_t)val * rem) >> 8);
    switch (region) {
        case 0:  *out_r = val; *out_g = t;   *out_b = p;   break;
        case 1:  *out_r = q;   *out_g = val; *out_b = p;   break;
        case 2:  *out_r = p;   *out_g = val; *out_b = t;   break;
        case 3:  *out_r = p;   *out_g = q;   *out_b = val; break;
        case 4:  *out_r = t;   *out_g = p;   *out_b = val; break;
        default: *out_r = val; *out_g = p;   *out_b = q;   break;
    }
}

static void mp_render_layer_rgb(uint8_t layer) {
    if (mp_pulse_active) {
        if (timer_elapsed32(mp_pulse_start) < 60) {
            if (mp_rgb_enabled) {
                mp_set_ws2812_if_changed(255, 255, 255);
                return;
            }
        } else {
            mp_pulse_active = 0;
        }
    }

    uint8_t idx = (layer < MP_MAX_LAYERS) ? layer : 0;
    uint8_t mode = mp_layer_mode[idx];
    if (!mp_rgb_enabled || mode == MP_LED_MODE_OFF) {
        mp_set_ws2812_if_changed(0, 0, 0);
        return;
    }

    uint8_t r = mp_layer_rgb[idx][0];
    uint8_t g = mp_layer_rgb[idx][1];
    uint8_t b = mp_layer_rgb[idx][2];

    if (mode == MP_LED_MODE_RAINBOW) {
        uint8_t max_val = r;
        if (g > max_val) max_val = g;
        if (b > max_val) max_val = b;
        if (max_val == 0) max_val = 255;
        uint8_t wr = 0, wg = 0, wb = 0;
        mp_wheel_rgb(mp_anim_phase, max_val, &wr, &wg, &wb);
        mp_set_ws2812_if_changed(wr, wg, wb);
        return;
    }

    if (mode == MP_LED_MODE_BREATH) {
        uint8_t tri = (mp_anim_phase < 128)
            ? (uint8_t)(mp_anim_phase * 2)
            : (uint8_t)((255 - mp_anim_phase) * 2);
        uint16_t scale = 26 + (((uint16_t)tri * 229) / 255);
        uint8_t br = (uint8_t)(((uint16_t)r * scale) >> 8);
        uint8_t bg = (uint8_t)(((uint16_t)g * scale) >> 8);
        uint8_t bb = (uint8_t)(((uint16_t)b * scale) >> 8);
        mp_set_ws2812_if_changed(br, bg, bb);
        return;
    }

    mp_set_ws2812_if_changed(r, g, b);
}

static void mp_apply_layer_rgb(uint8_t layer) {
    mp_has_drawn_rgb = 0;
    mp_render_layer_rgb(layer);
}

static void mp_save_profile_to_slot(uint8_t slot) {
    if (slot >= MP_MAX_PROFILES) return;
    uint16_t addr = MP_EEPROM_PROFILES_BASE + ((uint16_t)slot * MP_PROFILE_STRIDE);
    for (uint8_t layer = 0; layer < MP_MAX_LAYERS; layer++) {
        for (uint8_t row = 0; row < MATRIX_ROWS; row++) {
            for (uint8_t col = 0; col < MATRIX_COLS; col++) {
                uint16_t kc = dynamic_keymap_get_keycode(layer, row, col);
                eeprom_update_word((uint16_t *)(uintptr_t)addr, kc);
                addr += 2;
            }
        }
        for (uint8_t dir = 0; dir < 2; dir++) {
            uint16_t ekc = dynamic_keymap_get_encoder(layer, 0, dir == 1);
            eeprom_update_word((uint16_t *)(uintptr_t)addr, ekc);
            addr += 2;
        }
    }
}

static void mp_load_profile_from_slot(uint8_t slot) {
    if (slot >= MP_MAX_PROFILES) return;
    uint16_t addr = MP_EEPROM_PROFILES_BASE + ((uint16_t)slot * MP_PROFILE_STRIDE);
    for (uint8_t layer = 0; layer < MP_MAX_LAYERS; layer++) {
        for (uint8_t row = 0; row < MATRIX_ROWS; row++) {
            for (uint8_t col = 0; col < MATRIX_COLS; col++) {
                uint16_t kc = eeprom_read_word((const uint16_t *)(uintptr_t)addr);
                dynamic_keymap_set_keycode(layer, row, col, kc);
                addr += 2;
            }
        }
        for (uint8_t dir = 0; dir < 2; dir++) {
            uint16_t ekc = eeprom_read_word((const uint16_t *)(uintptr_t)addr);
            dynamic_keymap_set_encoder(layer, 0, dir == 1, ekc);
            addr += 2;
        }
    }
}

static void mp_persist_state_header(void) {
    eeprom_update_byte((uint8_t *)(uintptr_t)(MP_EEPROM_STATE_ADDR + 0), mp_active_profile);
    eeprom_update_byte((uint8_t *)(uintptr_t)(MP_EEPROM_STATE_ADDR + 1), mp_rgb_enabled);
    for (uint8_t i = 0; i < MP_MAX_LAYERS; i++) {
        eeprom_update_byte((uint8_t *)(uintptr_t)(MP_EEPROM_STATE_ADDR + 2 + i * 3 + 0), mp_layer_rgb[i][0]);
        eeprom_update_byte((uint8_t *)(uintptr_t)(MP_EEPROM_STATE_ADDR + 2 + i * 3 + 1), mp_layer_rgb[i][1]);
        eeprom_update_byte((uint8_t *)(uintptr_t)(MP_EEPROM_STATE_ADDR + 2 + i * 3 + 2), mp_layer_rgb[i][2]);
        eeprom_update_byte((uint8_t *)(uintptr_t)(MP_EEPROM_STATE_ADDR + 14 + i), mp_layer_mode[i]);
        eeprom_update_byte((uint8_t *)(uintptr_t)(MP_EEPROM_STATE_ADDR + 18 + i), mp_layer_speed[i]);
    }
}

static void mp_init_eeprom_if_needed(void) {
    uint16_t magic = eeprom_read_word((const uint16_t *)(uintptr_t)MP_EEPROM_MAGIC_ADDR);
    if (magic != MP_EEPROM_MAGIC_VAL) {
        mp_active_profile = 0;
        mp_rgb_enabled = 1;
        mp_persist_state_header();
        for (uint8_t s = 0; s < MP_MAX_PROFILES; s++) {
            mp_save_profile_to_slot(s);
        }
        eeprom_update_word((uint16_t *)(uintptr_t)MP_EEPROM_MAGIC_ADDR, MP_EEPROM_MAGIC_VAL);
        return;
    }
    uint8_t saved_profile = eeprom_read_byte((const uint8_t *)(uintptr_t)(MP_EEPROM_STATE_ADDR + 0));
    mp_active_profile = (saved_profile < MP_MAX_PROFILES) ? saved_profile : 0;
    mp_rgb_enabled = eeprom_read_byte((const uint8_t *)(uintptr_t)(MP_EEPROM_STATE_ADDR + 1)) ? 1 : 0;
    for (uint8_t i = 0; i < MP_MAX_LAYERS; i++) {
        mp_layer_rgb[i][0] = eeprom_read_byte((const uint8_t *)(uintptr_t)(MP_EEPROM_STATE_ADDR + 2 + i * 3 + 0));
        mp_layer_rgb[i][1] = eeprom_read_byte((const uint8_t *)(uintptr_t)(MP_EEPROM_STATE_ADDR + 2 + i * 3 + 1));
        mp_layer_rgb[i][2] = eeprom_read_byte((const uint8_t *)(uintptr_t)(MP_EEPROM_STATE_ADDR + 2 + i * 3 + 2));
        uint8_t saved_mode = eeprom_read_byte((const uint8_t *)(uintptr_t)(MP_EEPROM_STATE_ADDR + 14 + i));
        mp_layer_mode[i] = (saved_mode <= MP_LED_MODE_BREATH)
            ? saved_mode
            : (mp_rgb_enabled ? MP_LED_MODE_SOLID : MP_LED_MODE_OFF);
        uint8_t saved_speed = eeprom_read_byte((const uint8_t *)(uintptr_t)(MP_EEPROM_STATE_ADDR + 18 + i));
        mp_layer_speed[i] = (saved_speed <= 100) ? saved_speed : 50;
    }
    mp_load_profile_from_slot(mp_active_profile);
}

bool process_record_user(uint16_t keycode, keyrecord_t *record) {
    if (keycode >= MP_PROF_BASE && keycode <= MP_PROF_MAX) {
        if (record->event.pressed) {
            uint8_t target_slot = (uint8_t)(keycode - MP_PROF_BASE);
            if (target_slot < MP_MAX_PROFILES && target_slot != mp_active_profile) {
                mp_save_profile_to_slot(mp_active_profile);
                mp_active_profile = target_slot;
                mp_load_profile_from_slot(mp_active_profile);
                eeprom_update_byte((uint8_t *)(uintptr_t)(MP_EEPROM_STATE_ADDR + 0), mp_active_profile);
            }
            /* Non-blocking 60ms white confirmation pulse on GP16 WS2812 LED */
            if (mp_rgb_enabled) {
                mp_pulse_active = 1;
                mp_pulse_start = timer_read32();
                mp_set_ws2812_if_changed(255, 255, 255);
            }
            uint8_t active_layer = get_highest_layer(layer_state);
            uint8_t report[32] = {0};
            report[0] = MP_HID_PREFIX;
            report[1] = MP_EVT_LAYER_STATE;
            report[2] = active_layer;
            report[3] = mp_active_profile;
            raw_hid_send(report, sizeof(report));
        }
        return false;
    }

    if (keycode >= MP_TRIG_BASE && keycode <= MP_TRIG_MAX) {
        uint8_t offset = (uint8_t)(keycode - MP_TRIG_BASE);
        uint8_t trig_layer = (offset >> 4) & 0x03;
        uint8_t slot_index = offset & 0x0F;
        uint8_t pressed = record->event.pressed ? 1 : 0;
        uint8_t report[32] = {0};
        report[0] = MP_HID_PREFIX;
        report[1] = MP_EVT_HOST_TRIGGER;
        report[2] = ++mp_trigger_seq;
        report[3] = mp_active_profile;
        report[4] = trig_layer;
        report[5] = slot_index;
        report[6] = pressed;
        report[7] = (uint8_t)(report[0] ^ report[1] ^ report[2] ^ report[3] ^ report[4] ^ report[5] ^ report[6]);
        raw_hid_send(report, sizeof(report));
        return false;
    }
    return true;
}

#if defined(VIA_ENABLE)
bool via_command_kb(uint8_t *data, uint8_t length) {
    if (length < 2 || data[0] != MP_HID_PREFIX) {
        return false;
    }
    uint8_t subcmd = data[1];
    uint8_t current_layer = get_highest_layer(layer_state);

    if (subcmd == MP_CMD_GET_STATE) {
        data[2] = current_layer;
        data[3] = mp_active_profile;
        data[4] = MP_MAX_LAYERS;
        data[5] = MP_MAX_PROFILES;
        data[6] = mp_rgb_enabled;
        for (uint8_t i = 0; i < MP_MAX_LAYERS; i++) {
            data[7 + i * 3 + 0] = mp_layer_rgb[i][0];
            data[7 + i * 3 + 1] = mp_layer_rgb[i][1];
            data[7 + i * 3 + 2] = mp_layer_rgb[i][2];
            if (length >= 27) {
                data[19 + i] = mp_layer_mode[i];
                data[23 + i] = mp_layer_speed[i];
            }
        }
        raw_hid_send(data, length);
        return true;
    }

    if (subcmd == MP_CMD_SELECT_PROFILE) {
        uint8_t target_slot = data[2];
        uint8_t save_current = data[3];
        if (target_slot < MP_MAX_PROFILES) {
            if (save_current) {
                mp_save_profile_to_slot(mp_active_profile);
            }
            mp_active_profile = target_slot;
            mp_load_profile_from_slot(mp_active_profile);
            eeprom_update_byte((uint8_t *)(uintptr_t)(MP_EEPROM_STATE_ADDR + 0), mp_active_profile);
        }
        data[2] = mp_active_profile;
        data[3] = current_layer;
        raw_hid_send(data, length);
        return true;
    }

    if (subcmd == MP_CMD_SAVE_PROFILE) {
        uint8_t target_slot = data[2];
        if (target_slot < MP_MAX_PROFILES) {
            mp_active_profile = target_slot;
            mp_save_profile_to_slot(mp_active_profile);
            eeprom_update_byte((uint8_t *)(uintptr_t)(MP_EEPROM_STATE_ADDR + 0), mp_active_profile);
        }
        data[2] = mp_active_profile;
        data[3] = current_layer;
        raw_hid_send(data, length);
        return true;
    }

    if (subcmd == MP_CMD_SET_RGB) {
        uint8_t persist = data[2];
        mp_rgb_enabled = data[3] ? 1 : 0;
        for (uint8_t i = 0; i < MP_MAX_LAYERS; i++) {
            mp_layer_rgb[i][0] = data[4 + i * 3 + 0];
            mp_layer_rgb[i][1] = data[4 + i * 3 + 1];
            mp_layer_rgb[i][2] = data[4 + i * 3 + 2];
            if (length >= 20 && data[16 + i] <= MP_LED_MODE_BREATH) {
                mp_layer_mode[i] = data[16 + i];
            } else {
                mp_layer_mode[i] = mp_rgb_enabled ? MP_LED_MODE_SOLID : MP_LED_MODE_OFF;
            }
            if (length >= 24 && data[20 + i] <= 100) {
                mp_layer_speed[i] = data[20 + i];
            }
        }
        mp_apply_layer_rgb(current_layer);
        if (persist) {
            mp_persist_state_header();
        }
        raw_hid_send(data, length);
        return true;
    }

    return false;
}
#endif

layer_state_t layer_state_set_user(layer_state_t state) {
    uint8_t active_layer = get_highest_layer(state);
    mp_apply_layer_rgb(active_layer);
#if defined(RAW_ENABLE)
    uint8_t report[32] = {0};
    report[0] = MP_HID_PREFIX;
    report[1] = MP_EVT_LAYER_STATE;
    report[2] = active_layer;
    report[3] = mp_active_profile;
    raw_hid_send(report, sizeof(report));
#endif
    return state;
}

void housekeeping_task_user(void) {
    if (timer_elapsed32(mp_last_anim_tick) < 20) {
        return;
    }
    mp_last_anim_tick = timer_read32();
    uint8_t active_layer = get_highest_layer(layer_state);
    uint8_t idx = (active_layer < MP_MAX_LAYERS) ? active_layer : 0;
    uint8_t speed = mp_layer_speed[idx];
    uint8_t step = (uint8_t)(1 + (((uint16_t)speed * 4) / 100));
    mp_anim_phase = (uint8_t)(mp_anim_phase + step);
    mp_render_layer_rgb(active_layer);
}

void keyboard_post_init_user(void) {
    rgblight_enable_noeeprom();
    mp_last_anim_tick = timer_read32();
    mp_init_eeprom_if_needed();
    mp_apply_layer_rgb(get_highest_layer(layer_state));
}
