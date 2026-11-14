/**
 * Standard QMK/VIA WebHID bridge. It speaks the stock VIA Raw HID commands only;
 * arbitrary profile JSON stays in the configurator's browser storage.
 */

export const VIA_USB_VENDOR_ID = 0xfeed;
export const VIA_USB_PRODUCT_ID = 0x6001;
export const VIA_RAW_USAGE_PAGE = 0xff60;
export const VIA_RAW_USAGE_ID = 0x61;
export const VIA_RAW_REPORT_SIZE = 32;
export const VIA_PROTOCOL_VERSION = 0x000d;

const VIA_COMMAND = {
  getProtocolVersion: 0x01,
  getKeyboardValue: 0x02,
  getDynamicKeycode: 0x04,
  setDynamicKeycode: 0x05,
  getDynamicLayerCount: 0x11,
  getDynamicEncoder: 0x14,
  setDynamicEncoder: 0x15,
  unhandled: 0xff,
} as const;

const VIA_KEYBOARD_VALUE = {
  firmwareVersion: 0x04,
} as const;

export const MP_HID_PREFIX = 0xfd;
export const MP_CMD_GET_STATE = 0x01;
export const MP_CMD_SELECT_PROFILE = 0x02;
export const MP_CMD_SAVE_PROFILE = 0x03;
export const MP_CMD_SET_RGB = 0x04;
export const MP_EVT_LAYER_STATE = 0x10;
export const MP_EVT_HOST_TRIGGER = 0x11;
export const MP_TRIG_BASE = 0x7e00;
export const MP_TRIG_MAX = 0x7e3f;
export const MP_PROF_BASE = 0x7e40;
export const MP_PROF_MAX = 0x7e43;

export const TRIGGER_SLOT_ORDER = [
  'r1c1', 'r1c2', 'r1c3',
  'r2c1', 'r2c2', 'r2c3',
  'r3c1', 'r3c2', 'r3c3',
  'cw', 'press', 'ccw',
] as const;

export type TriggerSlotId = (typeof TRIGGER_SLOT_ORDER)[number];

export interface HardwareTriggerEvent {
  type: 'hardware_trigger';
  seq: number;
  profileSlot: number;
  layer: number;
  slotIndex: number;
  slotId: TriggerSlotId;
  pressed: boolean;
}

export interface DeviceLayerStateEvent {
  type: 'layer_state';
  deviceActiveLayer: number;
  activeProfileSlot: number;
}

export interface LayerRgbColor {
  r: number;
  g: number;
  b: number;
}

export interface DeviceRgbConfig {
  enabled: boolean;
  persist?: boolean;
  layerColors: [LayerRgbColor, LayerRgbColor, LayerRgbColor, LayerRgbColor];
  layerModes?: [number, number, number, number];
  layerSpeeds?: [number, number, number, number];
}

export interface QmkViaStatus {
  state: 'searching' | 'connecting' | 'connected' | 'disconnected' | 'unavailable';
  device?: string;
  fw?: string;
  path?: string;
  error?: string;
  layerCount?: number;
  deviceActiveLayer?: number;
  activeProfileSlot?: number;
  rgbConfig?: DeviceRgbConfig;
}

export interface ViaAction {
  t?: string;
  k?: string[];
  c?: string;
  op?: string;
  n?: number;
  layer?: number;
  slotIndex?: number;
  mod?: string;
  key?: string;
}

interface HidCollectionLike {
  usagePage?: number;
  usage?: number;
}

interface HidInputReportEventLike extends Event {
  device: HidDeviceLike;
  reportId: number;
  data: DataView;
}

export interface HidDeviceLike extends EventTarget {
  vendorId: number;
  productId: number;
  productName?: string;
  opened: boolean;
  collections?: HidCollectionLike[];
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
}

export interface HidApiLike extends EventTarget {
  getDevices(): Promise<HidDeviceLike[]>;
  requestDevice(options: {
    filters: Array<{ vendorId: number; productId: number; usagePage: number; usage: number }>;
  }): Promise<HidDeviceLike[]>;
}

interface PendingReport {
  commandId: number;
  resolve: (data: Uint8Array) => void;
  reject: (error: Error) => void;
}

interface ViaConfigLayer {
  keys?: Record<string, ViaAction>;
  enc?: Record<string, ViaAction>;
}

export interface ViaConfiguration {
  version: number;
  layers: ViaConfigLayer[];
}

export interface ViaKeymapSnapshotLayer {
  keys: Record<string, number>;
  enc: { ccw: number; cw: number; press: number };
}

/** A read-only VIA keymap snapshot. No profile metadata is stored on-device. */
export interface ViaKeymapSnapshot {
  protocolVersion: number;
  layerCount: number;
  capturedLayerCount: number;
  layers: ViaKeymapSnapshotLayer[];
}

export interface BridgeResult {
  ok: boolean;
  error?: string;
  warnings?: string[];
  layerCount?: number;
  localOnly?: boolean;
  snapshot?: ViaKeymapSnapshot;
  changedMappings?: number;
  /** True only when a local pre-restore keymap snapshot was saved before a restore write. */
  preRestoreBackupSaved?: boolean;
  deviceActiveLayer?: number;
  activeProfileSlot?: number;
  rgbConfig?: DeviceRgbConfig;
}

const KEY_SLOTS = [
  ['r1c1', 0, 0], ['r1c2', 0, 1], ['r1c3', 0, 2],
  ['r2c1', 1, 0], ['r2c2', 1, 1], ['r2c3', 1, 2],
  ['r3c1', 2, 0], ['r3c2', 2, 1], ['r3c3', 2, 2],
] as const;

const MODIFIERS: Record<string, { mask: number; keycode: number }> = {
  CONTROL: { mask: 0x01, keycode: 0xe0 },
  SHIFT: { mask: 0x02, keycode: 0xe1 },
  ALT: { mask: 0x04, keycode: 0xe2 },
  GUI: { mask: 0x08, keycode: 0xe3 },
  RIGHT_CONTROL: { mask: 0x10, keycode: 0xe4 },
  RIGHT_SHIFT: { mask: 0x20, keycode: 0xe5 },
  RIGHT_ALT: { mask: 0x40, keycode: 0xe6 },
  RIGHT_GUI: { mask: 0x80, keycode: 0xe7 },
};

const DIGIT_KEYCODES: Record<string, number> = {
  ONE: 0x1e, TWO: 0x1f, THREE: 0x20, FOUR: 0x21, FIVE: 0x22,
  SIX: 0x23, SEVEN: 0x24, EIGHT: 0x25, NINE: 0x26, ZERO: 0x27,
};

const SPECIAL_KEYCODES: Record<string, number> = {
  ENTER: 0x28, RETURN: 0x28, ESCAPE: 0x29, BACKSPACE: 0x2a, TAB: 0x2b,
  SPACEBAR: 0x2c, MINUS: 0x2d, EQUALS: 0x2e, LEFT_BRACKET: 0x2f,
  RIGHT_BRACKET: 0x30, BACKSLASH: 0x31, POUND: 0x32, SEMICOLON: 0x33,
  QUOTE: 0x34, GRAVE_ACCENT: 0x35, COMMA: 0x36, PERIOD: 0x37,
  FORWARD_SLASH: 0x38, CAPS_LOCK: 0x39, PRINT_SCREEN: 0x46,
  SCROLL_LOCK: 0x47, PAUSE: 0x48, INSERT: 0x49, HOME: 0x4a,
  PAGE_UP: 0x4b, DELETE: 0x4c, END: 0x4d, PAGE_DOWN: 0x4e,
  RIGHT_ARROW: 0x4f, LEFT_ARROW: 0x50, DOWN_ARROW: 0x51, UP_ARROW: 0x52,
  KEYPAD_NUMLOCK: 0x53, KEYPAD_SLASH: 0x54, KEYPAD_ASTERISK: 0x55,
  KEYPAD_MINUS: 0x56, KEYPAD_PLUS: 0x57, KEYPAD_ENTER: 0x58,
  KEYPAD_1: 0x59, KEYPAD_2: 0x5a, KEYPAD_3: 0x5b, KEYPAD_4: 0x5c,
  KEYPAD_5: 0x5d, KEYPAD_6: 0x5e, KEYPAD_7: 0x5f, KEYPAD_8: 0x60,
  KEYPAD_9: 0x61, KEYPAD_0: 0x62, KEYPAD_PERIOD: 0x63, KEYPAD_EQUAL: 0x67,
};

const MEDIA_KEYCODES: Record<string, number> = {
  MUTE: 0x00a8,
  VOLUME_INCREMENT: 0x00a9,
  VOLUME_DECREMENT: 0x00aa,
  SCAN_NEXT_TRACK: 0x00ab,
  SCAN_PREVIOUS_TRACK: 0x00ac,
  STOP: 0x00ad,
  PLAY_PAUSE: 0x00ae,
  FAST_FORWARD: 0x00bb,
  REWIND: 0x00bc,
  BRIGHTNESS_INCREMENT: 0x00bd,
  BRIGHTNESS_DECREMENT: 0x00be,
};

function basicKeycode(name: string): number | null {
  const key = name.trim().toUpperCase();
  const modifier = MODIFIERS[key];
  if (modifier) return modifier.keycode;

  if (/^[A-Z]$/.test(key)) return key.charCodeAt(0) - 65 + 0x04;
  if (DIGIT_KEYCODES[key] !== undefined) return DIGIT_KEYCODES[key];
  if (/^[1-9]$/.test(key)) return Number(key) - 1 + 0x1e;
  if (key === '0') return 0x27;

  const functionKey = key.match(/^F(\d{1,2})$/);
  if (functionKey) {
    const number = Number(functionKey[1]);
    if (number >= 1 && number <= 12) return 0x3a + number - 1;
    if (number >= 13 && number <= 24) return 0x68 + number - 13;
  }

  const keypadDigit = key.match(/^KEYPAD_([0-9])$/);
  if (keypadDigit) return keypadDigit[1] === '0' ? 0x62 : 0x58 + Number(keypadDigit[1]);

  return SPECIAL_KEYCODES[key] ?? null;
}

function keycodeForDevice(action: ViaAction | null | undefined, deviceLayerCount: number): number | null {
  if (action?.t === 'layer' && Number.isInteger(action.n) && action.n! >= deviceLayerCount) {
    return null;
  }
  if (action?.t === 'layer_tap' && Number.isInteger(action.layer) && action.layer! >= deviceLayerCount) {
    return null;
  }
  return actionToViaKeycode(action);
}

function unsupportedActionWarning(
  layer: number,
  location: string,
  action: ViaAction | undefined,
  deviceLayerCount: number
): string {
  if (action?.t === 'layer' && Number.isInteger(action.n) && action.n! >= deviceLayerCount) {
    return `Layer ${layer} ${location}: target layer ${action.n! + 1} is not available on this device; action was not synced`;
  }
  if (action?.t === 'layer_tap' && Number.isInteger(action.layer) && action.layer! >= deviceLayerCount) {
    return `Layer ${layer} ${location}: target layer ${action.layer! + 1} is not available on this device; action was not synced`;
  }
  return `Layer ${layer} ${location}: unsupported action was not synced`;
}

/** Convert the renderer's supported key action to a standard 16-bit QMK keycode. */
export function actionToViaKeycode(action: ViaAction | null | undefined): number | null {
  if (!action || action.t === 'none') return 0; // an explicit empty slot is KC_NO

  if (action.t === 'host_trigger') {
    if (
      !Number.isInteger(action.layer) ||
      action.layer! < 0 ||
      action.layer! > 3 ||
      !Number.isInteger(action.slotIndex) ||
      action.slotIndex! < 0 ||
      action.slotIndex! >= TRIGGER_SLOT_ORDER.length
    ) {
      return null;
    }
    return MP_TRIG_BASE | ((action.layer! & 0x03) << 4) | (action.slotIndex! & 0x0f);
  }

  if (action.t === 'profile') {
    if (!Number.isInteger(action.n) || action.n! < 0 || action.n! > 3) return null;
    return MP_PROF_BASE | (action.n! & 0x03);
  }

  if (action.t === 'mod_tap') {
    const modEntry = action.mod ? MODIFIERS[action.mod.trim().toUpperCase()] : undefined;
    const kc = action.key ? basicKeycode(action.key) : null;
    if (!modEntry || kc === null || kc > 0xff || MODIFIERS[action.key!.trim().toUpperCase()]) {
      return null;
    }
    const leftModifiers = modEntry.mask & 0x0f;
    const rightModifiers = (modEntry.mask >> 4) & 0x0f;
    const qmkModifierBits = rightModifiers ? (0x10 | rightModifiers) : leftModifiers;
    return 0x2000 | ((qmkModifierBits & 0x1f) << 8) | (kc & 0xff);
  }

  if (action.t === 'layer_tap') {
    const kc = action.key ? basicKeycode(action.key) : null;
    if (
      !Number.isInteger(action.layer) ||
      action.layer! < 0 ||
      action.layer! > 15 ||
      kc === null ||
      kc > 0xff ||
      MODIFIERS[action.key!.trim().toUpperCase()]
    ) {
      return null;
    }
    return 0x4000 | ((action.layer! & 0x0f) << 8) | (kc & 0xff);
  }

  if (action.t === 'media') {
    return action.c ? MEDIA_KEYCODES[action.c.toUpperCase()] ?? null : null;
  }

  if (action.t === 'layer') {
    if (!Number.isInteger(action.n) || action.n! < 0 || action.n! > 31) return null;
    if (action.op === 'set') return 0x5200 | action.n!; // TO(layer)
    if (action.op === 'hold') return 0x5220 | action.n!; // MO(layer)
    return null; // layer-cycle has no standard single VIA keycode
  }

  if (action.t !== 'keys' || !Array.isArray(action.k) || action.k.length === 0) return null;

  let modifierMask = 0;
  let baseKeycode: number | null = null;
  for (const value of action.k) {
    const name = String(value).trim().toUpperCase();
    const modifier = MODIFIERS[name];
    if (modifier) {
      modifierMask |= modifier.mask;
      continue;
    }
    const keycode = basicKeycode(name);
    if (keycode === null || baseKeycode !== null) return null;
    baseKeycode = keycode;
  }

  if (baseKeycode === null) {
    // QMK can store a modifier as an ordinary keycode when used alone.
    return action.k.length === 1 ? basicKeycode(String(action.k[0])) : null;
  }
  if (modifierMask === 0) return baseKeycode;

  // QK_MODS uses a 4-bit modifier mask plus a high-nibble flag for right-side mods.
  // It cannot distinguish a mixed left/right chord, so decline that mapping safely.
  const leftModifiers = modifierMask & 0x0f;
  const rightModifiers = (modifierMask >> 4) & 0x0f;
  if (leftModifiers && rightModifiers) return null;
  const qmkModifierBits = rightModifiers ? (0x10 | rightModifiers) : leftModifiers;
  return (qmkModifierBits << 8) | baseKeycode;
}

function toReportData(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

export class QmkViaBridge {
  private readonly hid?: HidApiLike;
  private readonly timeoutMs: number;
  private device: HidDeviceLike | null = null;
  private pending: PendingReport | null = null;
  private layerCount = 0;
  private lastTriggerSeq: number | null = null;
  private status: QmkViaStatus;
  private statusListeners = new Set<(status: QmkViaStatus) => void>();
  private eventListeners = new Set<(event: unknown) => void>();

  private readonly onInputReport = (event: Event) => {
    const report = event as HidInputReportEventLike;
    if (report.device !== this.device || report.reportId !== 0) return;
    const bytes = toReportData(report.data);

    // Asynchronous device-originated Raw HID events (layer changes & host action triggers)
    if (bytes[0] === MP_HID_PREFIX && bytes[1] === MP_EVT_LAYER_STATE) {
      const deviceActiveLayer = Math.min(3, Math.max(0, bytes[2] ?? 0));
      const activeProfileSlot = Math.min(3, Math.max(0, bytes[3] ?? 0));
      this.setStatus({
        ...this.status,
        deviceActiveLayer,
        activeProfileSlot,
      });
      this.emit({
        type: 'layer_state',
        deviceActiveLayer,
        activeProfileSlot,
      } satisfies DeviceLayerStateEvent);
      return;
    }

    if (bytes[0] === MP_HID_PREFIX && bytes[1] === MP_EVT_HOST_TRIGGER) {
      const checksum = (bytes[0] ^ bytes[1] ^ bytes[2] ^ bytes[3] ^ bytes[4] ^ bytes[5] ^ bytes[6]) & 0xff;
      const slotIndex = bytes[5] ?? 0xff;
      if (bytes[7] === checksum && slotIndex < TRIGGER_SLOT_ORDER.length) {
        const seq = bytes[2] ?? 0;
        const pressed = bytes[6] === 1;
        // Deduplicate identical consecutive sequence + press state packets
        const dedupKey = (seq << 1) | (pressed ? 1 : 0);
        if (this.lastTriggerSeq !== dedupKey) {
          this.lastTriggerSeq = dedupKey;
          this.emit({
            type: 'hardware_trigger',
            seq,
            profileSlot: (bytes[3] ?? 0) & 0x03,
            layer: (bytes[4] ?? 0) & 0x03,
            slotIndex,
            slotId: TRIGGER_SLOT_ORDER[slotIndex],
            pressed,
          } satisfies HardwareTriggerEvent);
        }
      }
      return;
    }

    if (!this.pending) return;
    if (bytes[0] === VIA_COMMAND.unhandled) {
      this.pending.reject(new Error('The device does not support this VIA command'));
    } else if (bytes[0] === this.pending.commandId) {
      this.pending.resolve(Uint8Array.from(bytes));
    }
  };

  private readonly onHidDisconnect = (event: Event) => {
    const device = (event as Event & { device?: HidDeviceLike }).device;
    if (!device || device !== this.device) return;
    device.removeEventListener('inputreport', this.onInputReport);
    this.device = null;
    this.layerCount = 0;
    this.lastTriggerSeq = null;
    this.pending?.reject(new Error('The QMK/VIA device disconnected'));
    this.pending = null;
    this.setStatus({ state: 'disconnected', error: 'The device was disconnected' });
    this.emit({ type: 'disconnect' });
  };

  constructor(hid?: HidApiLike, options: { timeoutMs?: number } = {}) {
    this.hid = hid;
    this.timeoutMs = options.timeoutMs ?? 1500;
    this.status = { state: hid ? 'disconnected' : 'unavailable' };
    this.hid?.addEventListener('disconnect', this.onHidDisconnect);
  }

  public onStatus(callback: (status: QmkViaStatus) => void): () => void {
    this.statusListeners.add(callback);
    return () => this.statusListeners.delete(callback);
  }

  public onEvent(callback: (event: unknown) => void): () => void {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  public async getStatus(): Promise<QmkViaStatus> {
    if (!this.hid) {
      this.setStatus({ state: 'unavailable', error: 'WebHID is not available in this browser' });
      return this.status;
    }
    if (this.status.state === 'connected' && this.device) return this.status;
    if (this.status.state === 'connecting') return this.status;

    this.setStatus({ state: 'searching' });
    let devices: HidDeviceLike[];
    try {
      devices = await this.hid.getDevices();
    } catch (error) {
      // Do not let a stale silent scan overwrite a user-initiated permission flow.
      if (this.status.state === 'searching') {
        this.setStatus({ state: 'disconnected', error: this.errorMessage(error) });
      }
      return this.status;
    }

    // A user may start the permission flow while this silent scan is pending.
    if (this.status.state !== 'searching') return this.status;
    const device = devices.find((candidate) => this.isTarget(candidate));
    if (!device) {
      this.setStatus({ state: 'disconnected' });
      return this.status;
    }

    try {
      await this.openDevice(device);
    } catch (error) {
      if (this.isStatusState('connecting')) {
        this.setStatus({ state: 'disconnected', error: this.errorMessage(error) });
      }
    }
    return this.status;
  }

  /** Must be called from a user gesture because WebHID prompts for permission. */
  public async connect(): Promise<QmkViaStatus> {
    if (!this.hid) {
      this.setStatus({ state: 'unavailable', error: 'Use a WebHID-capable browser over HTTPS or localhost' });
      return this.status;
    }
    if (this.device && this.status.state === 'connected') return this.status;
    if (this.status.state === 'connecting') return this.status;

    this.setStatus({ state: 'connecting' });
    try {
      const devices = await this.hid.requestDevice({
        filters: [{
          vendorId: VIA_USB_VENDOR_ID,
          productId: VIA_USB_PRODUCT_ID,
          usagePage: VIA_RAW_USAGE_PAGE,
          usage: VIA_RAW_USAGE_ID,
        }],
      });
      const device = devices.find((candidate) => this.isTarget(candidate));
      if (!device) {
        this.setStatus({ state: 'disconnected' });
        return this.status;
      }
      await this.openDevice(device);
    } catch (error) {
      this.setStatus({ state: 'disconnected', error: this.errorMessage(error) });
    }
    return this.status;
  }

  public async disconnect(): Promise<void> {
    const device = this.device;
    this.device = null;
    this.layerCount = 0;
    this.lastTriggerSeq = null;
    this.pending?.reject(new Error('The QMK/VIA device was disconnected by the user'));
    this.pending = null;
    if (device) {
      device.removeEventListener('inputreport', this.onInputReport);
      try {
        if (device.opened) await device.close();
      } catch {}
    }
    this.setStatus({ state: 'disconnected' });
    this.emit({ type: 'disconnect' });
  }

  /**
   * These command names are local renderer APIs, not firmware commands.
   * Reads and restores use the stock VIA keycode/encoder reports plus optional
   * Micro Pad 0xFD extension commands for 4-profile slots, layer telemetry, and RGB.
   */
  public async request(request: {
    cmd?: string;
    config?: ViaConfiguration;
    snapshot?: ViaKeymapSnapshot;
    profileSlot?: number;
    saveCurrentProfile?: boolean;
    rgbConfig?: DeviceRgbConfig;
  }): Promise<BridgeResult> {
    if (
      ![
        'set_config',
        'get_config',
        'restore_config',
        'select_profile',
        'save_profile',
        'get_device_state',
        'set_rgb_config',
      ].includes(request?.cmd ?? '')
    ) {
      return { ok: false, error: 'Unsupported QMK/VIA request' };
    }
    if (!this.device || this.status.state !== 'connected') {
      return { ok: false, error: 'No QMK/VIA device is connected' };
    }

    if (request.cmd === 'get_device_state') {
      try {
        const res = await this.exchange(new Uint8Array([MP_HID_PREFIX, MP_CMD_GET_STATE]));
        const parsed = this.parseDeviceStateReport(res);
        this.setStatus({ ...this.status, ...parsed });
        return { ok: true, ...parsed };
      } catch (error) {
        return { ok: false, error: this.errorMessage(error) };
      }
    }

    if (request.cmd === 'select_profile') {
      const slot = Number(request.profileSlot ?? 0);
      if (!Number.isInteger(slot) || slot < 0 || slot >= 4) {
        return { ok: false, error: 'Profile slot must be between 0 and 3' };
      }
      try {
        const res = await this.exchange(new Uint8Array([
          MP_HID_PREFIX,
          MP_CMD_SELECT_PROFILE,
          slot,
          request.saveCurrentProfile !== false ? 1 : 0,
        ]));
        const activeProfileSlot = Math.min(3, Math.max(0, res[2] ?? slot));
        const deviceActiveLayer = Math.min(3, Math.max(0, res[3] ?? (this.status.deviceActiveLayer ?? 0)));
        this.setStatus({ ...this.status, activeProfileSlot, deviceActiveLayer });
        return { ok: true, activeProfileSlot, deviceActiveLayer };
      } catch (error) {
        return { ok: false, error: this.errorMessage(error) };
      }
    }

    if (request.cmd === 'save_profile') {
      const slot = Number(request.profileSlot ?? 0);
      if (!Number.isInteger(slot) || slot < 0 || slot >= 4) {
        return { ok: false, error: 'Profile slot must be between 0 and 3' };
      }
      try {
        const res = await this.exchange(new Uint8Array([
          MP_HID_PREFIX,
          MP_CMD_SAVE_PROFILE,
          slot,
        ]));
        const activeProfileSlot = Math.min(3, Math.max(0, res[2] ?? slot));
        const deviceActiveLayer = Math.min(3, Math.max(0, res[3] ?? (this.status.deviceActiveLayer ?? 0)));
        this.setStatus({ ...this.status, activeProfileSlot, deviceActiveLayer });
        return { ok: true, activeProfileSlot, deviceActiveLayer };
      } catch (error) {
        return { ok: false, error: this.errorMessage(error) };
      }
    }

    if (request.cmd === 'set_rgb_config') {
      const cfg = request.rgbConfig;
      if (!cfg || !Array.isArray(cfg.layerColors) || cfg.layerColors.length !== 4) {
        return { ok: false, error: 'Invalid RGB configuration payload' };
      }
      try {
        const packet = new Uint8Array(24);
        packet[0] = MP_HID_PREFIX;
        packet[1] = MP_CMD_SET_RGB;
        packet[2] = cfg.persist ? 1 : 0;
        packet[3] = cfg.enabled ? 1 : 0;
        for (let i = 0; i < 4; i++) {
          const color = cfg.layerColors[i];
          packet[4 + i * 3 + 0] = Math.max(0, Math.min(255, Math.round(color.r)));
          packet[4 + i * 3 + 1] = Math.max(0, Math.min(255, Math.round(color.g)));
          packet[4 + i * 3 + 2] = Math.max(0, Math.min(255, Math.round(color.b)));
          const mode = cfg.layerModes?.[i];
          packet[16 + i] = Number.isInteger(mode) && mode! >= 0 && mode! <= 3
            ? mode!
            : (cfg.enabled ? 1 : 0);
          const speed = cfg.layerSpeeds?.[i];
          packet[20 + i] = Number.isFinite(speed)
            ? Math.max(0, Math.min(100, Math.round(speed!)))
            : 50;
        }
        await this.exchange(packet);
        this.setStatus({ ...this.status, rgbConfig: cfg });
        return { ok: true, rgbConfig: cfg };
      } catch (error) {
        return { ok: false, error: this.errorMessage(error) };
      }
    }

    if (request.cmd === 'get_config' || request.cmd === 'restore_config') {
      try {
        const layerCount = await this.readLayerCount();
        if (request.cmd === 'get_config') {
          const snapshot = await this.readDeviceKeymap(layerCount);
          return {
            ok: true,
            layerCount,
            snapshot,
            warnings: layerCount > 8
              ? [`Device has ${layerCount} layers; the snapshot includes only the first 8`]
              : [],
          };
        }
        const restored = await this.restoreDeviceKeymap(request.snapshot, layerCount);
        return {
          ok: true,
          layerCount,
          changedMappings: restored.changedMappings,
          warnings: restored.warnings,
        };
      } catch (error) {
        return { ok: false, error: this.errorMessage(error) };
      }
    }

    if (
      request.config?.version !== 1 ||
      !Array.isArray(request.config.layers) ||
      request.config.layers.length < 1
    ) {
      return { ok: false, error: 'Invalid configurator keymap payload' };
    }

    const warnings: string[] = [];
    try {
      const reportedLayers = await this.readLayerCount();
      const configuredLayers = request.config.layers.length;
      const layersToWrite = Math.min(configuredLayers, reportedLayers, 8);
      if (configuredLayers > reportedLayers) {
        warnings.push(`Device supports ${reportedLayers} layers; extra profile layers were not synced`);
      } else if (configuredLayers < reportedLayers) {
        warnings.push(`Only the first ${configuredLayers} of ${reportedLayers} device layers are controlled by this profile; the rest were left unchanged`);
      }
      if (configuredLayers > 8) {
        warnings.push('The configurator supports at most 8 profile layers; higher profile layers were not synced');
      }
      if (reportedLayers > 8) {
        warnings.push('The configurator supports at most 8 layers; higher device layers were left unchanged');
      }

      for (let layer = 0; layer < layersToWrite; layer++) {
        const layerConfig = request.config.layers[layer];
        if (!layerConfig || typeof layerConfig !== 'object') {
          warnings.push(`Layer ${layer + 1} was invalid and left unchanged`);
          continue;
        }

        for (const [slot, row, col] of KEY_SLOTS) {
          if (!layerConfig.keys || !Object.hasOwn(layerConfig.keys, slot)) continue;
          const action = layerConfig.keys[slot];
          const keycode = keycodeForDevice(action, reportedLayers);
          if (keycode === null) {
            warnings.push(unsupportedActionWarning(layer + 1, slot.toUpperCase(), action, reportedLayers));
            continue;
          }
          const current = await this.readKeycode(layer, row, col);
          if (current !== keycode) await this.setKeycode(layer, row, col, keycode);
        }

        if (layerConfig.enc && Object.hasOwn(layerConfig.enc, 'press')) {
          const pressAction = layerConfig.enc.press;
          const pressKeycode = keycodeForDevice(pressAction, reportedLayers);
          if (pressKeycode === null) {
            warnings.push(unsupportedActionWarning(layer + 1, 'encoder press', pressAction, reportedLayers));
          } else {
            const current = await this.readKeycode(layer, 3, 0);
            if (current !== pressKeycode) await this.setKeycode(layer, 3, 0, pressKeycode);
          }
        }

        for (const direction of [
          { name: 'ccw', clockwise: false },
          { name: 'cw', clockwise: true },
        ]) {
          if (!layerConfig.enc || !Object.hasOwn(layerConfig.enc, direction.name)) continue;
          const action = layerConfig.enc[direction.name];
          const keycode = keycodeForDevice(action, reportedLayers);
          if (keycode === null) {
            warnings.push(unsupportedActionWarning(
              layer + 1,
              `encoder ${direction.name.toUpperCase()}`,
              action,
              reportedLayers
            ));
            continue;
          }
          const current = await this.readEncoder(layer, direction.clockwise);
          if (current !== keycode) await this.setEncoder(layer, direction.clockwise, keycode);
        }
      }

      if (
        request.profileSlot !== undefined &&
        Number.isInteger(request.profileSlot) &&
        request.profileSlot >= 0 &&
        request.profileSlot < 4
      ) {
        try {
          await this.exchange(new Uint8Array([
            MP_HID_PREFIX,
            MP_CMD_SAVE_PROFILE,
            request.profileSlot,
          ]));
          this.setStatus({ ...this.status, activeProfileSlot: request.profileSlot });
        } catch {
          // Stock VIA firmware without the 0xFD extension still retains the active keymap in EEPROM.
        }
      }

      return { ok: true, warnings, layerCount: reportedLayers };
    } catch (error) {
      return { ok: false, error: this.errorMessage(error), warnings };
    }
  }

  /**
   * VIA cannot return profile JSON. Report no device file so the renderer keeps
   * its already-loaded browser profile and performs the initial keymap sync.
   */
  public async getFile(name: string): Promise<{ ok: false; error: string }> {
    if (name !== 'app_state') return { ok: false, error: 'Unsupported local profile file' };
    return { ok: false, error: 'Full profiles are stored in this browser; VIA stores keymaps only' };
  }

  /** The renderer already persists the same profile state to cm2.state.v2. */
  public async putFile(name: string, text: string): Promise<BridgeResult> {
    if (name !== 'app_state' || typeof text !== 'string' || text.length > 2 * 1024 * 1024) {
      return { ok: false, error: 'Invalid local profile state' };
    }
    try {
      const state = JSON.parse(text);
      if (state?.v !== 1 || !Array.isArray(state.profiles)) {
        return { ok: false, error: 'Invalid local profile state' };
      }
      if (typeof localStorage !== 'undefined') localStorage.setItem('cm2.state.v2', text);
      return { ok: true, localOnly: true };
    } catch (error) {
      return { ok: false, error: this.errorMessage(error) };
    }
  }

  private isTarget(device: HidDeviceLike): boolean {
    const hasViaRawCollection = device.collections?.some(
      (collection) => collection.usagePage === VIA_RAW_USAGE_PAGE && collection.usage === VIA_RAW_USAGE_ID
    );
    return device.vendorId === VIA_USB_VENDOR_ID &&
      device.productId === VIA_USB_PRODUCT_ID &&
      (hasViaRawCollection ?? true);
  }

  private async openDevice(device: HidDeviceLike): Promise<void> {
    if (this.device === device && this.status.state === 'connected') return;
    this.setStatus({ state: 'connecting' });
    if (!device.opened) await device.open();
    this.device = device;
    device.addEventListener('inputreport', this.onInputReport);

    try {
      const versionReport = await this.exchange(new Uint8Array([VIA_COMMAND.getProtocolVersion]));
      if (versionReport.length < 3) throw new Error('Invalid VIA protocol-version response');
      const version = (versionReport[1] << 8) | versionReport[2];
      if (version !== VIA_PROTOCOL_VERSION) {
        throw new Error(`Unsupported VIA protocol ${version}; expected ${VIA_PROTOCOL_VERSION}`);
      }

      this.layerCount = await this.readLayerCount();
      let firmware = 'QMK/VIA';
      try {
        const firmwareReport = await this.exchange(new Uint8Array([
          VIA_COMMAND.getKeyboardValue,
          VIA_KEYBOARD_VALUE.firmwareVersion,
        ]));
        const value = new DataView(
          firmwareReport.buffer,
          firmwareReport.byteOffset + 2,
          Math.min(4, firmwareReport.byteLength - 2)
        ).getUint32(0, false);
        if (value) firmware = `VIA ${value.toString(16).padStart(8, '0')}`;
      } catch {
        // The protocol version and layer-count handshake are sufficient to connect.
      }

      let initialState: {
        deviceActiveLayer?: number;
        activeProfileSlot?: number;
        rgbConfig?: DeviceRgbConfig;
      } = {};
      try {
        const stateReport = await this.exchange(new Uint8Array([MP_HID_PREFIX, MP_CMD_GET_STATE]));
        // Only genuine Micro Pad firmware sets MP_MAX_LAYERS (byte 4) and MP_MAX_PROFILES (byte 5).
        if ((stateReport[4] ?? 0) >= 1 && (stateReport[5] ?? 0) >= 1) {
          initialState = this.parseDeviceStateReport(stateReport);
        }
      } catch {
        // Stock VIA firmware without the 0xFD extension remains fully supported.
      }

      this.setStatus({
        state: 'connected',
        device: device.productName || 'Grid Macro 1',
        fw: firmware,
        path: `VIA ${this.layerCount} layers`,
        layerCount: this.layerCount,
        ...initialState,
      });
      this.emit({ type: 'connect', device: device.productName || 'Grid Macro 1' });
    } catch (error) {
      device.removeEventListener('inputreport', this.onInputReport);
      this.device = null;
      this.layerCount = 0;
      try {
        if (device.opened) await device.close();
      } catch {}
      throw error;
    }
  }

  private async readDeviceKeymap(layerCount: number): Promise<ViaKeymapSnapshot> {
    const capturedLayerCount = Math.min(layerCount, 8);
    const layers: ViaKeymapSnapshotLayer[] = [];
    for (let layer = 0; layer < capturedLayerCount; layer += 1) {
      const keys: Record<string, number> = {};
      for (const [slot, row, col] of KEY_SLOTS) {
        keys[slot] = await this.readKeycode(layer, row, col);
      }
      layers.push({
        keys,
        enc: {
          ccw: await this.readEncoder(layer, false),
          cw: await this.readEncoder(layer, true),
          press: await this.readKeycode(layer, 3, 0),
        },
      });
    }
    return {
      protocolVersion: VIA_PROTOCOL_VERSION,
      layerCount,
      capturedLayerCount,
      layers,
    };
  }

  private async restoreDeviceKeymap(
    candidate: ViaKeymapSnapshot | undefined,
    deviceLayerCount: number,
  ): Promise<{ changedMappings: number; warnings: string[] }> {
    const snapshot = this.validateKeymapSnapshot(candidate);
    const warnings: string[] = [];
    const layersToRestore = Math.min(snapshot.capturedLayerCount, deviceLayerCount, 8);
    if (snapshot.layerCount !== deviceLayerCount) {
      warnings.push(`Backup captured ${snapshot.layerCount} layers; this device has ${deviceLayerCount}. Only ${layersToRestore} common layers can be restored`);
    }
    if (deviceLayerCount > 8 || snapshot.capturedLayerCount < snapshot.layerCount) {
      warnings.push('This tool supports at most 8 layers; higher device layers were left unchanged');
    }

    let changedMappings = 0;
    for (let layer = 0; layer < layersToRestore; layer += 1) {
      const source = snapshot.layers[layer];
      for (const [slot, row, col] of KEY_SLOTS) {
        const keycode = source.keys[slot];
        const current = await this.readKeycode(layer, row, col);
        if (current !== keycode) {
          await this.setKeycode(layer, row, col, keycode);
          changedMappings += 1;
        }
      }
      for (const direction of [
        { name: 'ccw', clockwise: false },
        { name: 'cw', clockwise: true },
      ] as const) {
        const keycode = source.enc[direction.name];
        const current = await this.readEncoder(layer, direction.clockwise);
        if (current !== keycode) {
          await this.setEncoder(layer, direction.clockwise, keycode);
          changedMappings += 1;
        }
      }
      const currentPress = await this.readKeycode(layer, 3, 0);
      if (currentPress !== source.enc.press) {
        await this.setKeycode(layer, 3, 0, source.enc.press);
        changedMappings += 1;
      }
    }
    return { changedMappings, warnings };
  }

  private validateKeymapSnapshot(candidate: unknown): ViaKeymapSnapshot {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Invalid device keymap backup');
    }
    const snapshot = candidate as Partial<ViaKeymapSnapshot>;
    if (
      snapshot.protocolVersion !== VIA_PROTOCOL_VERSION ||
      !Number.isInteger(snapshot.layerCount) ||
      (snapshot.layerCount as number) < 1 ||
      (snapshot.layerCount as number) > 32 ||
      !Number.isInteger(snapshot.capturedLayerCount) ||
      snapshot.capturedLayerCount !== Math.min(snapshot.layerCount as number, 8) ||
      !Array.isArray(snapshot.layers) ||
      snapshot.layers.length !== snapshot.capturedLayerCount
    ) {
      throw new Error('Invalid or incomplete device keymap backup');
    }
    for (const layer of snapshot.layers) {
      if (
        layer === null || typeof layer !== 'object' || Array.isArray(layer) ||
        layer.keys === null || typeof layer.keys !== 'object' || Array.isArray(layer.keys) ||
        layer.enc === null || typeof layer.enc !== 'object' || Array.isArray(layer.enc)
      ) {
        throw new Error('Invalid device keymap backup layer');
      }
      for (const [slot] of KEY_SLOTS) {
        const keycode = layer.keys[slot];
        if (!Number.isInteger(keycode) || keycode < 0 || keycode > 0xffff) {
          throw new Error(`Invalid backup keycode for ${slot}`);
        }
      }
      for (const direction of ['ccw', 'cw', 'press'] as const) {
        const keycode = layer.enc[direction];
        if (!Number.isInteger(keycode) || keycode < 0 || keycode > 0xffff) {
          throw new Error(`Invalid backup encoder ${direction.toUpperCase()} keycode`);
        }
      }
    }
    return snapshot as ViaKeymapSnapshot;
  }

  private async readLayerCount(): Promise<number> {
    const response = await this.exchange(new Uint8Array([VIA_COMMAND.getDynamicLayerCount]));
    if (response.length < 2) throw new Error('Invalid VIA layer-count response');
    const count = response[1];
    if (!Number.isInteger(count) || count < 1 || count > 32) {
      throw new Error(`Invalid VIA dynamic layer count: ${count}`);
    }
    return count;
  }

  private async readKeycode(layer: number, row: number, col: number): Promise<number> {
    const response = await this.exchange(new Uint8Array([
      VIA_COMMAND.getDynamicKeycode,
      layer,
      row,
      col,
    ]));
    if (response.length < 6) throw new Error('Invalid VIA keycode response');
    return (response[4] << 8) | response[5];
  }

  private async readEncoder(layer: number, clockwise: boolean): Promise<number> {
    const response = await this.exchange(new Uint8Array([
      VIA_COMMAND.getDynamicEncoder,
      layer,
      0, // one encoder on this board
      clockwise ? 1 : 0,
    ]));
    if (response.length < 6) throw new Error('Invalid VIA encoder response');
    return (response[4] << 8) | response[5];
  }

  private async setKeycode(layer: number, row: number, col: number, keycode: number): Promise<void> {
    await this.exchange(new Uint8Array([
      VIA_COMMAND.setDynamicKeycode,
      layer,
      row,
      col,
      (keycode >> 8) & 0xff,
      keycode & 0xff,
    ]));
  }

  private async setEncoder(layer: number, clockwise: boolean, keycode: number): Promise<void> {
    await this.exchange(new Uint8Array([
      VIA_COMMAND.setDynamicEncoder,
      layer,
      0, // one encoder on this board
      clockwise ? 1 : 0,
      (keycode >> 8) & 0xff,
      keycode & 0xff,
    ]));
  }

  private async exchange(command: Uint8Array): Promise<Uint8Array> {
    const device = this.device;
    if (!device || !device.opened) throw new Error('QMK/VIA device is not open');
    if (this.pending) throw new Error('A VIA Raw HID report is already in flight');
    if (command.length > VIA_RAW_REPORT_SIZE) throw new Error('VIA command exceeds Raw HID report size');

    const report = new Uint8Array(VIA_RAW_REPORT_SIZE);
    report.set(command);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectResponse: ((error: Error) => void) | undefined;
    const response = new Promise<Uint8Array>((resolve, reject) => {
      this.pending = { commandId: command[0], resolve, reject };
      rejectResponse = reject;
      timer = setTimeout(() => reject(new Error(`Timed out waiting for VIA command 0x${command[0].toString(16)}`)), this.timeoutMs);
    });

    try {
      try {
        await device.sendReport(0, report);
      } catch (error) {
        rejectResponse?.(error instanceof Error ? error : new Error(String(error)));
      }
      return await response;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.pending = null;
    }
  }

  private isStatusState(state: QmkViaStatus['state']): boolean {
    return this.status.state === state;
  }

  private setStatus(status: QmkViaStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private emit(event: unknown): void {
    for (const listener of this.eventListeners) listener(event);
  }

  private parseDeviceStateReport(res: Uint8Array): {
    deviceActiveLayer: number;
    activeProfileSlot: number;
    rgbConfig: DeviceRgbConfig;
  } {
    const deviceActiveLayer = Math.min(3, Math.max(0, res[2] ?? 0));
    const activeProfileSlot = Math.min(3, Math.max(0, res[3] ?? 0));
    const enabled = (res[6] ?? 1) !== 0;
    const defaultMode = enabled ? 1 : 0;
    const parseMode = (value: number | undefined) =>
      value !== undefined && value <= 3 ? value : defaultMode;
    const parseSpeed = (value: number | undefined) =>
      value !== undefined && value <= 100 ? value : 50;

    const rgbConfig: DeviceRgbConfig = {
      enabled,
      layerColors: [
        { r: res[7] ?? 0, g: res[8] ?? 81, b: res[9] ?? 255 },
        { r: res[10] ?? 16, g: res[11] ?? 185, b: res[12] ?? 129 },
        { r: res[13] ?? 245, g: res[14] ?? 158, b: res[15] ?? 11 },
        { r: res[16] ?? 225, g: res[17] ?? 29, b: res[18] ?? 72 },
      ],
      layerModes: [
        parseMode(res[19]),
        parseMode(res[20]),
        parseMode(res[21]),
        parseMode(res[22]),
      ],
      layerSpeeds: [
        parseSpeed(res[23]),
        parseSpeed(res[24]),
        parseSpeed(res[25]),
        parseSpeed(res[26]),
      ],
    };
    return { deviceActiveLayer, activeProfileSlot, rgbConfig };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export function installQmkViaBridge(target: Window = window): QmkViaBridge {
  const existing = (target as Window & { macropad?: QmkViaBridge }).macropad;
  if (existing) return existing;
  const hid = (target.navigator as Navigator & { hid?: HidApiLike }).hid;
  const bridge = new QmkViaBridge(hid);
  (target as Window & { macropad?: QmkViaBridge }).macropad = bridge;
  return bridge;
}

declare global {
  interface Window {
    macropad?: QmkViaBridge;
  }
}

if (typeof window !== 'undefined') installQmkViaBridge(window);
