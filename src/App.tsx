import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { AnimatePresence, motion, useMotionValue, useReducedMotion, useSpring } from 'motion/react';
import {
  APP_READY_EVENT,
  getEntranceMotionProps,
  getKeycapEntranceOptions,
  type EntrancePhase,
} from './entranceAnimations';
import {
  GRID_MACRO_ENCODER_SLOT,
  GRID_MACRO_KEY_SLOTS,
  HARDWARE_LAYER_NAMES,
  type GridMacroSlotId,
} from './deviceLayout';
import { clampMacropadOffsetToArea } from './macropadMovement';
import { deviceKeymapFileTools } from './deviceKeymapFiles';
import {
  createHardwareTriggerController,
  requestSimulationMode,
  triggerSimulationAction,
  type DesktopExecutionDefinition,
  type DesktopExecutionStep,
  type MultiGestureKey,
  type SimulationAction,
  type SmartActionSubTab,
} from './actionExecution';
import {
  MAX_LAYER_COUNT,
  MAX_PROFILE_COUNT,
  PROFILE_FILE_STORAGE_KEY,
  profileFileTools,
} from './profileFiles';
import {
  APP_VERSION_FALLBACK,
  createAppSettingsTools,
  readAppSettings,
  saveAppSettings,
  type AppSettingKey,
  type AppSettings,
  type InstalledApplication,
  type SettingsCapabilities,
  type SupportLinkKey,
} from './appSettings';
import type {
  DeviceLayerStateEvent,
  HardwareTriggerEvent,
  QmkViaStatus,
} from './qmkViaBridge';
import { buildViaConfiguration } from './qmkProfileSync';
import type { EmojiCatalogEntry } from './emojiCatalog';
import { PRESET_CATALOG } from './presetCatalog';
import {
  buildIconCatalog,
  findIconMetadata,
  ICON_SEARCH_PAGE_SIZE,
  searchIconCatalog,
  type IconLibrary,
} from './iconCatalog';
import {
  ChevronDown,
  ChevronUp,
  Plus,
  Check,
  X,
  Search,
} from 'lucide-react';

declare const __APP_VERSION__: string;

type KeySlotId = GridMacroSlotId;

type MappingTabId = 'Basic' | 'Action' | 'Multi-A' | 'Smart-A';
type EncoderSubActionId = 'cw' | 'press' | 'ccw';

interface EncoderSubBinding {
  label: string;
  binding: string;
  execution?: DesktopExecutionDefinition;
}

const BLANK_ENCODER_ACTIONS: Record<EncoderSubActionId, EncoderSubBinding> = {
  cw: { label: '', binding: 'blank' },
  press: { label: '', binding: 'blank' },
  ccw: { label: '', binding: 'blank' },
};

interface KeyAssignment {
  label: string;
  actionType:
    | 'Basic input'
    | 'Shortcut'
    | 'Multi-step action'
    | 'Smart Action'
    | 'Layer Cycle';
  binding: string;
  iconId?: string;
  actionId?: string;
  color?: string;
  execution?: DesktopExecutionDefinition;
  encoderActions?: Record<EncoderSubActionId, EncoderSubBinding>;
}

type LayerKeymap = Record<KeySlotId, KeyAssignment> & { presetId?: string };

function formatEncoderShortLabel(text: string): string {
  const clean = text.trim();
  if (!clean) return '—';
  if (clean.length <= 3) return clean;
  return `${clean.slice(0, 2).toLowerCase()}...`;
}

function getEncoderActions(
  assignment: KeyAssignment
): Record<EncoderSubActionId, EncoderSubBinding> {
  return assignment.encoderActions || BLANK_ENCODER_ACTIONS;
}

interface ProfileData {
  id: string;
  name: string;
  color: string;
  layers: LayerKeymap[];
}

function isPresetInstalledInProfile(profile: ProfileData, presetId: string): boolean {
  const preset = PRESET_CATALOG.find((entry) => entry.id === presetId);
  const actionIdPrefix = `preset-${presetId}-`;
  const minimumLegacyKeyMatches = Math.max(
    2,
    (preset?.keys.length ?? GRID_MACRO_KEY_SLOTS.length) - 1
  );

  return profile.layers.some((layer) => {
    if (layer.presetId === presetId) return true;

    const matchingKeyCount = GRID_MACRO_KEY_SLOTS.filter((slot) =>
      layer[slot]?.actionId?.startsWith(actionIdPrefix)
    ).length;
    const hasLegacyDialSignature =
      preset !== undefined &&
      layer[GRID_MACRO_ENCODER_SLOT]?.binding === `${preset.title} Dial`;

    // Pre-marker profiles are recognized by their dial preset binding, or by
    // nearly all preset key IDs if the user has since edited the dial.
    return (
      matchingKeyCount > 0 &&
      (hasLegacyDialSignature || matchingKeyCount >= minimumLegacyKeyMatches)
    );
  });
}

interface PresetItem {
  id: string;
  title: string;
  description: string;
  author: string;
  hasPreview: boolean;
  color: string;
  layerKeymap: LayerKeymap;
  actionItems: CustomItemsByTab;
}

interface BasicTileItem {
  id: string;
  top?: string;
  main: string;
  listLabel?: string;
  macropadLabel: string;
  isClearIcon?: boolean;
  arrowDir?: 'right' | 'left' | 'down' | 'up';
  iconId?: string;
  emoji?: string;
  execution?: DesktopExecutionDefinition;
}

type CustomItemsByTab = Record<Exclude<MappingTabId, 'Basic'>, BasicTileItem[]>;

interface CustomItemGroup {
  id: string;
  title: string;
  presetId?: string;
  presetColor?: string;
  items: BasicTileItem[];
}

function groupCustomItemsByPreset(
  items: BasicTileItem[],
  customGroupTitle: string
): CustomItemGroup[] {
  const groups = new Map<string, CustomItemGroup>();

  items.forEach((item) => {
    const preset = PRESET_CATALOG.find((entry) => item.id.startsWith(`preset-${entry.id}-`));
    const groupId = preset ? `preset-${preset.id}` : 'custom';
    const existingGroup = groups.get(groupId);

    if (existingGroup) {
      existingGroup.items.push(item);
      return;
    }

    groups.set(groupId, {
      id: groupId,
      title: preset?.title ?? customGroupTitle,
      presetId: preset?.id,
      presetColor: preset?.color,
      items: [item],
    });
  });

  return [...groups.values()].sort((left, right) => {
    if (!left.presetId && right.presetId) return -1;
    if (left.presetId && !right.presetId) return 1;
    return 0;
  });
}

interface PersistedAppProfileState {
  profiles: ProfileData[];
  activeProfileIndex: number;
  customItems: CustomItemsByTab;
}


function formatCustomTileText(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) {
    const line1 = words[0].length > 7 ? `${words[0].slice(0, 5)}..` : words[0];
    const rest = words.slice(1).join(' ');
    const line2 = rest.length > 6 ? `${rest.slice(0, 5)}..` : rest;
    return `${line1}\n${line2}`;
  }
  const single = words[0] || 'Action';
  return single.length > 7 ? `${single.slice(0, 5)}..` : single;
}

interface BasicSection {
  title: string;
  listPreview: string;
  items: BasicTileItem[];
}

const BASIC_KEY_SECTIONS: BasicSection[] = [
  {
    title: 'Alphanumerics',
    listPreview: '[ blank, A, B, C, D, E... ]',
    items: [
      { id: 'none', main: '', listLabel: 'blank', macropadLabel: '', isClearIcon: true },
      { id: 'A', main: 'A', macropadLabel: 'A' },
      { id: 'B', main: 'B', macropadLabel: 'B' },
      { id: 'C', main: 'C', macropadLabel: 'C' },
      { id: 'D', main: 'D', macropadLabel: 'D' },
      { id: 'E', main: 'E', macropadLabel: 'E' },
      { id: 'F', main: 'F', macropadLabel: 'F' },
      { id: 'G', main: 'G', macropadLabel: 'G' },
      { id: 'H', main: 'H', macropadLabel: 'H' },
      { id: 'I', main: 'I', macropadLabel: 'I' },
      { id: 'J', main: 'J', macropadLabel: 'J' },
      { id: 'K', main: 'K', macropadLabel: 'K' },
      { id: 'L', main: 'L', macropadLabel: 'L' },
      { id: 'M', main: 'M', macropadLabel: 'M' },
      { id: 'N', main: 'N', macropadLabel: 'N' },
      { id: 'O', main: 'O', macropadLabel: 'O' },
      { id: 'P', main: 'P', macropadLabel: 'P' },
      { id: 'Q', main: 'Q', macropadLabel: 'Q' },
      { id: 'R', main: 'R', macropadLabel: 'R' },
      { id: 'S', main: 'S', macropadLabel: 'S' },
      { id: 'T', main: 'T', macropadLabel: 'T' },
      { id: 'U', main: 'U', macropadLabel: 'U' },
      { id: 'V', main: 'V', macropadLabel: 'V' },
      { id: 'W', main: 'W', macropadLabel: 'W' },
      { id: 'X', main: 'X', macropadLabel: 'X' },
      { id: 'Y', main: 'Y', macropadLabel: 'Y' },
      { id: 'Z', main: 'Z', macropadLabel: 'Z' },
      { id: '1', top: '!', main: '1', listLabel: '1', macropadLabel: '1' },
      { id: '2', top: '@', main: '2', listLabel: '2', macropadLabel: '2' },
      { id: '3', top: '#', main: '3', listLabel: '3', macropadLabel: '3' },
      { id: '4', top: '$', main: '4', listLabel: '4', macropadLabel: '4' },
      { id: '5', top: '%', main: '5', listLabel: '5', macropadLabel: '5' },
      { id: '6', top: '^', main: '6', listLabel: '6', macropadLabel: '6' },
      { id: '7', top: '&', main: '7', listLabel: '7', macropadLabel: '7' },
      { id: '8', top: '*', main: '8', listLabel: '8', macropadLabel: '8' },
      { id: '9', top: '(', main: '9', listLabel: '9', macropadLabel: '9' },
      { id: '0', top: ')', main: '0', listLabel: '0', macropadLabel: '0' },
    ],
  },
  {
    title: 'Glyphs',
    listPreview: '[ -, =, [, ], \\, NUHS... ]',
    items: [
      { id: 'minus', top: '_', main: '-', listLabel: '-', macropadLabel: '-' },
      { id: 'equal', top: '+', main: '=', listLabel: '=', macropadLabel: '=' },
      { id: 'lbracket', top: '{', main: '[', listLabel: '[', macropadLabel: '[' },
      { id: 'rbracket', top: '}', main: ']', listLabel: ']', macropadLabel: ']' },
      { id: 'backslash', top: '|', main: '\\', listLabel: '\\', macropadLabel: '\\' },
      { id: 'nuhs', main: 'NUHS', listLabel: 'NUHS', macropadLabel: '#' },
      { id: 'semicolon', top: ':', main: ';', listLabel: ';', macropadLabel: ';' },
      { id: 'quote', top: '"', main: "'", listLabel: "'", macropadLabel: "'" },
      { id: 'grave', top: '~', main: '`', listLabel: '`', macropadLabel: '`' },
      { id: 'comma', top: '<', main: ',', listLabel: ',', macropadLabel: ',' },
      { id: 'plus-glyph', main: '+', listLabel: '+', macropadLabel: '+' },
      { id: 'hyphen-glyph', main: '-', listLabel: '-', macropadLabel: '-' },
      { id: 'eq-glyph', main: '=', listLabel: '=', macropadLabel: '=' },
      { id: 'ast-glyph', main: '*', listLabel: '*', macropadLabel: '*' },
      { id: 'period', top: '>', main: '.', listLabel: '.', macropadLabel: '.' },
      { id: 'slash', top: '?', main: '/', listLabel: '/', macropadLabel: '/' },
      { id: 'pipe2', top: '|', main: '\\', listLabel: '\\', macropadLabel: '\\' },
    ],
  },
  {
    title: 'Modifiers',
    listPreview: '[ enter, esc, back, tab, space, ctrl... ]',
    items: [
      { id: 'enter', main: 'enter', macropadLabel: 'ent' },
      { id: 'esc', main: 'esc', macropadLabel: 'esc' },
      { id: 'back', main: 'back', macropadLabel: 'bksp' },
      { id: 'tab', main: 'tab', macropadLabel: 'tab' },
      { id: 'space', main: 'space', macropadLabel: 'spc' },
      { id: 'ctrl', main: 'ctrl', macropadLabel: 'ctrl' },
      { id: 'shift', main: 'shift', macropadLabel: 'shft' },
      { id: 'alt', main: 'alt', macropadLabel: 'alt' },
      { id: 'win', main: 'win', macropadLabel: 'win' },
      { id: 'rctrl', main: 'right\nctrl', listLabel: 'right ctrl', macropadLabel: 'rctl' },
      { id: 'rshift', main: 'right\nshift', listLabel: 'right shift', macropadLabel: 'rshf' },
      { id: 'ralt', main: 'right\nalt', listLabel: 'right alt', macropadLabel: 'ralt' },
      { id: 'rwin', main: 'right\nwin', listLabel: 'right win', macropadLabel: 'rwin' },
      { id: 'lock', main: 'lock', macropadLabel: 'lock' },
      { id: 'scrolllock', main: 'scroll lock', macropadLabel: 'scrl' },
      { id: 'numlock', main: 'num lock', macropadLabel: 'num' },
      {
        id: 'lscrolllock',
        main: 'locking\nscroll lock',
        listLabel: 'locking scroll lock',
        macropadLabel: 'lscr',
      },
      { id: 'prtsc', main: 'print\nscreen', listLabel: 'print screen', macropadLabel: 'prts' },
      { id: 'pause', main: 'pause', macropadLabel: 'paus' },
      { id: 'insert', main: 'insert', macropadLabel: 'ins' },
      { id: 'home', main: 'home', macropadLabel: 'home' },
      { id: 'pgup', main: 'page up', macropadLabel: 'pgup' },
      { id: 'pgdn', main: 'page\ndown', listLabel: 'page down', macropadLabel: 'pgdn' },
      { id: 'delete', main: 'delete', macropadLabel: 'del' },
      { id: 'end', main: 'end', macropadLabel: 'end' },
      { id: 'arr-r', main: '→', listLabel: 'right arrow', macropadLabel: '→', arrowDir: 'right' },
      { id: 'arr-l', main: '←', listLabel: 'left arrow', macropadLabel: '←', arrowDir: 'left' },
      { id: 'arr-d', main: '↓', listLabel: 'down arrow', macropadLabel: '↓', arrowDir: 'down' },
      { id: 'arr-u', main: '↑', listLabel: 'up arrow', macropadLabel: '↑', arrowDir: 'up' },
    ],
  },
  {
    title: 'Function keys (F)',
    listPreview: '[ F1, F2, F3, F4, F5, F6... ]',
    items: Array.from({ length: 24 }, (_, i) => ({
      id: `F${i + 1}`,
      main: `F${i + 1}`,
      macropadLabel: `F${i + 1}`,
    })),
  },
  {
    title: 'Number pad',
    listPreview: '[ /, *, -, +, num enter, 1... ]',
    items: [
      { id: 'num-div', main: '/', macropadLabel: '/' },
      { id: 'num-mul', main: '*', macropadLabel: '*' },
      { id: 'num-sub', main: '-', macropadLabel: '-' },
      { id: 'num-add', main: '+', macropadLabel: '+' },
      { id: 'num-ent', main: 'num enter', macropadLabel: 'nent' },
      { id: 'num-1', main: '1', macropadLabel: '1' },
      { id: 'num-2', main: '2', macropadLabel: '2' },
      { id: 'num-3', main: '3', macropadLabel: '3' },
      { id: 'num-4', main: '4', macropadLabel: '4' },
      { id: 'num-5', main: '5', macropadLabel: '5' },
      { id: 'num-6', main: '6', macropadLabel: '6' },
      { id: 'num-7', main: '7', macropadLabel: '7' },
      { id: 'num-8', main: '8', macropadLabel: '8' },
      { id: 'num-9', main: '9', macropadLabel: '9' },
      { id: 'num-0', main: '0', macropadLabel: '0' },
      { id: 'num-dot', main: '.', macropadLabel: '.' },
      { id: 'num-eq', main: '=', macropadLabel: '=' },
      { id: 'num-comma', main: ',', macropadLabel: ',' },
    ],
  },
  {
    title: 'Media keys',
    listPreview: '[ mute, volume +, volume -, next track,...',
    items: [
      { id: 'mute', main: 'mute', macropadLabel: 'mute' },
      { id: 'vol-up', main: 'volume +', macropadLabel: 'vol+' },
      { id: 'vol-dn', main: 'volume -', macropadLabel: 'vol-' },
      { id: 'next-trk', main: 'next track', macropadLabel: 'next' },
      {
        id: 'prev-trk',
        main: 'previous\ntrack',
        listLabel: 'previous track',
        macropadLabel: 'prev',
      },
      { id: 'm-stop', main: 'media stop', macropadLabel: 'stop' },
      { id: 'play', main: 'play', macropadLabel: 'play' },
      {
        id: 'ffwd',
        main: 'fast\nforward',
        listLabel: 'fast forward',
        macropadLabel: 'ffwd',
      },
      { id: 'rwnd', main: 'rewind', macropadLabel: 'rwnd' },
    ],
  },
  {
    title: 'Extra Keys',
    listPreview: '[ power down, sleep, stop, bright up, b...',
    items: [
      {
        id: 'pwr',
        main: 'power\ndown',
        listLabel: 'power down',
        macropadLabel: 'pwr',
      },
      { id: 'slp', main: 'sleep', macropadLabel: 'slp' },
      { id: 'stop-ex', main: 'stop', macropadLabel: 'stop' },
      { id: 'brt-up', main: 'bright up', macropadLabel: 'brt+' },
      {
        id: 'brt-dn',
        main: 'bright\ndown',
        listLabel: 'bright down',
        macropadLabel: 'brt-',
      },
    ],
  },
  {
    title: 'Layer Keys',
    listPreview: '[ Layer 1, Layer 2, Layer 3, Layer 4, La...',
    items: [
      { id: 'lyr-1', main: 'Layer 1', macropadLabel: 'L1' },
      { id: 'lyr-2', main: 'Layer 2', macropadLabel: 'L2' },
      { id: 'lyr-3', main: 'Layer 3', macropadLabel: 'L3' },
      { id: 'lyr-4', main: 'Layer 4', macropadLabel: 'L4' },
      { id: 'lyr-5', main: 'Layer 5', macropadLabel: 'L5' },
      { id: 'lyr-6', main: 'Layer 6', macropadLabel: 'L6' },
      {
        id: 'tlyr-1',
        main: 'Temp Layer\n1',
        listLabel: 'Temp Layer 1',
        macropadLabel: 'TL1',
      },
      {
        id: 'tlyr-2',
        main: 'Temp Layer\n2',
        listLabel: 'Temp Layer 2',
        macropadLabel: 'TL2',
      },
      {
        id: 'tlyr-3',
        main: 'Temp Layer\n3',
        listLabel: 'Temp Layer 3',
        macropadLabel: 'TL3',
      },
      {
        id: 'tlyr-4',
        main: 'Temp Layer\n4',
        listLabel: 'Temp Layer 4',
        macropadLabel: 'TL4',
      },
      {
        id: 'tlyr-5',
        main: 'Temp Layer\n5',
        listLabel: 'Temp Layer 5',
        macropadLabel: 'TL5',
      },
      {
        id: 'tlyr-6',
        main: 'Temp Layer\n6',
        listLabel: 'Temp Layer 6',
        macropadLabel: 'TL6',
      },
    ],
  },
  {
    title: 'Profile Keys',
    listPreview: '[ Profile 1, Profile 2, Profile 3, Profile ...',
    items: [
      { id: 'prf-1', main: 'Profile 1', macropadLabel: 'P1' },
      { id: 'prf-2', main: 'Profile 2', macropadLabel: 'P2' },
      { id: 'prf-3', main: 'Profile 3', macropadLabel: 'P3' },
      { id: 'prf-4', main: 'Profile 4', macropadLabel: 'P4' },
      { id: 'prf-5', main: 'Profile 5', macropadLabel: 'P5' },
      { id: 'prf-6', main: 'Profile 6', macropadLabel: 'P6' },
    ],
  },
  {
    title: 'Internal',
    listPreview: '[ Show Cheat-Sheet, Show Cheat-Sheet ...',
    items: [
      {
        id: 'cs-show',
        main: 'Show\nCheat-\nSheet',
        listLabel: 'Show Cheat-Sheet',
        macropadLabel: 'CS',
      },
      {
        id: 'cs-hold',
        main: 'Show\nCheat-\nSheet Hold',
        listLabel: 'Show Cheat-Sheet Hold',
        macropadLabel: 'CSH',
      },
      {
        id: 'cs-hide',
        main: 'Hide\nCheat-\nSheet',
        listLabel: 'Hide Cheat-Sheet',
        macropadLabel: 'HCS',
      },
      {
        id: 'cs-tog',
        main: 'Toggle\nCheat-\nSheet',
        listLabel: 'Toggle Cheat-Sheet',
        macropadLabel: 'TCS',
      },
    ],
  },
];

export const INITIAL_LAYER_1: LayerKeymap = {
  'dial-tl': {
    label: '',
    actionType: 'Basic input',
    binding: 'blank',
    encoderActions: BLANK_ENCODER_ACTIONS,
  },
  r1c1: { label: '', actionType: 'Basic input', binding: 'blank' },
  r1c2: { label: '', actionType: 'Basic input', binding: 'blank' },
  r1c3: { label: '', actionType: 'Basic input', binding: 'blank' },
  r2c1: { label: '', actionType: 'Basic input', binding: 'blank' },
  r2c2: { label: '', actionType: 'Basic input', binding: 'blank' },
  r2c3: { label: '', actionType: 'Basic input', binding: 'blank' },
  r3c1: { label: '', actionType: 'Basic input', binding: 'blank' },
  r3c2: { label: '', actionType: 'Basic input', binding: 'blank' },
  r3c3: { label: '', actionType: 'Basic input', binding: 'blank' },
};

const PRESET_MACROPAD_LABELS: Record<string, string> = {
  Duplicate: 'Dupl.',
  Rectangle: 'Rect',
  Eyedropper: 'Eyedrop',
  Instructions: 'Instr.',
  Shortcuts: 'Keys',
  Component: 'Comp.',
  Transform: 'Xform',
};

const PRESET_DIAL_LABELS: Record<string, string> = {
  'Scroll Down': 'dn',
  Latest: 'end',
  'Scroll Up': 'up',
  'Zoom In': 'zo+',
  'Zoom Fit': 'fit',
  'Zoom Out': 'zo-',
  Fit: 'fit',
  'Fit Screen': 'fit',
  'Brush +': 'br+',
  'Brush -': 'br-',
  'Next Frame': 'nxt',
  Play: 'ply',
  'Prev Frame': 'prv',
  Redo: 'rdo',
  Undo: 'und',
  'View Selected': 'sel',
};

const PRESET_SINGLE_MODIFIERS = new Set([
  'win', 'ctrl', 'alt', 'shift', 'cmd', 'option', 'command', 'control', 'super',
]);

function formatPresetSequence(sequence: string, os: 'mac' | 'win'): string {
  return sequence
    .split('+')
    .map((key) => key === 'Mod' ? (os === 'mac' ? 'Cmd' : 'Ctrl') : key)
    .join(' + ');
}

function isPresetShortcut(sequence: string): boolean {
  const clean = sequence.trim();
  if (!clean || PRESET_SINGLE_MODIFIERS.has(clean.toLowerCase())) return false;
  return clean.includes('+') || clean.includes(' ') || clean.toLowerCase().includes('mod+');
}

function isPresetSingleKey(value: string): boolean {
  const clean = value.trim().toLowerCase();
  const singleSymbols = new Set([
    '`', '~', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '+', '-', '=',
    '[', ']', '{', '}', '\\', '|', ';', ':', "'", '"', ',', '.', '<', '>', '/', '?',
  ]);
  return Boolean(
    PRESET_SINGLE_MODIFIERS.has(clean) ||
      /^(?:[a-z0-9]|f(?:[1-9]|1[0-2])|numpad (?:[0-9]|\.))$/.test(clean) ||
      /^(?:enter|return|tab|space|space bar|esc|escape|backspace|delete|del|insert|home|end|page up|page down|up|down|left|right|caps lock|num lock|scroll lock|volume up|volume down|media mute|media play \/ pause)$/.test(clean) ||
      (value.trim().length === 1 && singleSymbols.has(value.trim()))
  );
}

function getPresetExecution(sequence: string, os: 'mac' | 'win'): DesktopExecutionDefinition {
  const formatted = formatPresetSequence(sequence, os).trim();
  const keys = formatted.split('+').map((key) => key.trim()).filter(Boolean);
  if (keys.length > 1) {
    const nonModifiers = keys.filter((key) => !PRESET_SINGLE_MODIFIERS.has(key.toLowerCase()));
    if (nonModifiers.length > 1) {
      return {
        kind: 'sequence',
        steps: keys.map((key) => ({ kind: 'key', key, mode: 'press-release' })),
      };
    }
    return { kind: 'shortcut', value: formatted };
  }
  return isPresetSingleKey(sequence)
    ? { kind: 'shortcut', value: formatted }
    : { kind: 'text', value: sequence };
}

function makePresetActionItem(
  id: string,
  name: string,
  binding: string,
  iconId: string,
  execution?: DesktopExecutionDefinition
): BasicTileItem {
  return {
    id,
    main: name,
    listLabel: binding,
    macropadLabel: PRESET_MACROPAD_LABELS[name] ?? name,
    iconId,
    execution,
  };
}

export function buildPresetLibrary(os: 'mac' | 'win'): PresetItem[] {
  return PRESET_CATALOG.map((preset) => {
    const actionItems: CustomItemsByTab = {
      Action: [],
      'Multi-A': [],
      'Smart-A': [],
    };
    const keyAssignments = {} as Pick<LayerKeymap, (typeof GRID_MACRO_KEY_SLOTS)[number]>;

    preset.keys.forEach((action, index) => {
      const slot = GRID_MACRO_KEY_SLOTS[index];
      if (!slot) return;

      const itemId = `preset-${preset.id}-${slot}`;
      const iconId = action.iconId ?? 'sparkles';
      const shortName = PRESET_MACROPAD_LABELS[action.name] ?? action.name;
      let actionType: KeyAssignment['actionType'];
      let label: string;
      let binding: string;
      let execution: DesktopExecutionDefinition;

      if (action.multi) {
        actionType = 'Multi-step action';
        label = shortName;
        const onTap = formatPresetSequence(action.multi.onTap, os);
        const doubleTap = action.multi.doubleTap
          ? formatPresetSequence(action.multi.doubleTap, os)
          : '';
        binding = `${action.name} (onTap: ${onTap}${doubleTap ? `, doubleTap: ${doubleTap}` : ''})`;
        execution = {
          kind: 'multi',
          gestures: {
            onTap,
            ...(doubleTap ? { doubleTap } : {}),
          },
        };
        actionItems['Multi-A'].push(
          makePresetActionItem(itemId, action.name, binding, iconId, execution)
        );
      } else {
        execution = getPresetExecution(action.keys, os);
        if (isPresetShortcut(action.keys)) {
          const lowerName = action.name.toLowerCase();
          const isSmartAction =
            lowerName.includes('prompt') ||
            lowerName.includes('ai') ||
            lowerName.includes('smart') ||
            lowerName.includes('auto') ||
            lowerName.includes('instruction');
          actionType = isSmartAction ? 'Smart Action' : 'Shortcut';
          label = shortName;
          binding = `${action.name} (${formatPresetSequence(action.keys, os)})`;
          actionItems[isSmartAction ? 'Smart-A' : 'Action'].push(
            makePresetActionItem(itemId, action.name, binding, iconId, execution)
          );
        } else {
          actionType = 'Basic input';
          label = action.keys.length <= 3 ? action.keys.toUpperCase() : action.keys;
          binding = `${action.name} (${action.keys})`;
        }
      }

      keyAssignments[slot] = {
        label,
        actionType,
        binding,
        iconId,
        actionId: itemId,
        color: preset.color,
        execution,
      };
    });

    const encoderActions = Object.fromEntries(
      (['cw', 'press', 'ccw'] as const).map((direction) => {
        const action = preset.dial[direction];
        return [direction, {
          label: PRESET_DIAL_LABELS[action.name] ?? formatEncoderShortLabel(action.name),
          binding: `${action.name} (${formatPresetSequence(action.keys, os)})`,
          execution: getPresetExecution(action.keys, os),
        }];
      })
    ) as Record<EncoderSubActionId, EncoderSubBinding>;

    return {
      id: preset.id,
      title: preset.title,
      description: preset.description,
      author: preset.author,
      hasPreview: preset.hasPreview,
      color: preset.color,
      layerKeymap: {
        [GRID_MACRO_ENCODER_SLOT]: {
          label: preset.title,
          actionType: 'Shortcut',
          binding: `${preset.title} Dial`,
          color: preset.color,
          encoderActions,
        },
        ...keyAssignments,
      },
      actionItems,
    };
  });
}

export const PRESET_LIBRARY = buildPresetLibrary('win');

const INITIAL_PROFILES: ProfileData[] = [
  {
    id: 'default',
    name: 'Default Profile',
    color: '#0051ff',
    layers: [INITIAL_LAYER_1],
  },
];

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeProfileForEditor(profile: ProfileData): ProfileData {
  const defaultEncoder = INITIAL_LAYER_1[GRID_MACRO_ENCODER_SLOT];
  const rawLayers = Array.isArray(profile.layers) && profile.layers.length > 0
    ? profile.layers.slice(0, MAX_LAYER_COUNT)
    : [INITIAL_LAYER_1];
  const layers = rawLayers.map((layer) => {
    const normalized = { ...INITIAL_LAYER_1, ...layer } as LayerKeymap;
    for (const slot of GRID_MACRO_KEY_SLOTS) {
      const incoming = layer[slot] as unknown;
      normalized[slot] = {
        ...INITIAL_LAYER_1[slot],
        ...(isRecordValue(incoming) ? incoming : {}),
      } as KeyAssignment;
    }

    const incomingEncoder = layer[GRID_MACRO_ENCODER_SLOT] as unknown;
    const encoder = isRecordValue(incomingEncoder) ? incomingEncoder : {};
    const incomingActions = encoder.encoderActions;
    const encoderActions = isRecordValue(incomingActions) ? incomingActions : {};
    const mergeEncoderAction = (direction: EncoderSubActionId): EncoderSubBinding => {
      const fallback = defaultEncoder.encoderActions![direction];
      const incoming = encoderActions[direction];
      return {
        ...fallback,
        ...(isRecordValue(incoming) ? incoming : {}),
      } as EncoderSubBinding;
    };
    normalized[GRID_MACRO_ENCODER_SLOT] = {
      ...defaultEncoder,
      ...encoder,
      encoderActions: {
        cw: mergeEncoderAction('cw'),
        press: mergeEncoderAction('press'),
        ccw: mergeEncoderAction('ccw'),
      },
    } as KeyAssignment;
    return normalized;
  });

  return { ...profile, layers };
}

function normalizeCustomItemsForEditor(items: CustomItemsByTab): CustomItemsByTab {
  const normalizeTab = (tab: Exclude<MappingTabId, 'Basic'>) =>
    items[tab].map((item) => ({
      ...item,
      macropadLabel: item.macropadLabel?.trim() ? item.macropadLabel : item.main,
    }));

  return {
    Action: normalizeTab('Action'),
    'Multi-A': normalizeTab('Multi-A'),
    'Smart-A': normalizeTab('Smart-A'),
  };
}

function loadSavedProfileState(): PersistedAppProfileState | null {
  if (typeof window === 'undefined' || !profileFileTools) return null;

  try {
    const text = window.localStorage.getItem(PROFILE_FILE_STORAGE_KEY);
    if (!text) return null;

    const saved = JSON.parse(text) as Record<string, unknown>;
    if (!saved || typeof saved !== 'object' || !Array.isArray(saved.profiles)) return null;
    const savedProfiles = saved.profiles.slice(0, MAX_PROFILE_COUNT);

    // New profiles may be saved before the user types a name. Validate the
    // stored state with the same schema as imports, using a temporary display
    // name and restoring the intentional blank name after validation.
    const profilesForValidation = savedProfiles.map((profile) => {
      if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return profile;
      const candidate = profile as Record<string, unknown>;
      const boundedLayers = Array.isArray(candidate.layers)
        ? candidate.layers.slice(0, MAX_LAYER_COUNT)
        : candidate.layers;
      return typeof candidate.name === 'string' && candidate.name.trim()
        ? { ...candidate, layers: boundedLayers }
        : { ...candidate, name: 'Untitled Profile', layers: boundedLayers };
    });
    const parsed = profileFileTools.parse(JSON.stringify({
      ...saved,
      profiles: profilesForValidation,
    }));

    parsed.profiles.forEach((profile, index) => {
      const original = savedProfiles[index];
      if (!original || typeof original !== 'object' || Array.isArray(original)) return;
      const originalName = (original as Record<string, unknown>).name;
      if (typeof originalName === 'string' && !originalName.trim()) {
        profile.name = originalName;
      }
    });

    return {
      profiles: (parsed.profiles as unknown as ProfileData[]).map(normalizeProfileForEditor),
      activeProfileIndex: parsed.activeProfileIndex,
      customItems: normalizeCustomItemsForEditor(
        parsed.customItems as unknown as CustomItemsByTab
      ),
    };
  } catch {
    return null;
  }
}

const TIPS = [
  {
    lines: ['Actions can contain other', 'actions or smart-actions'],
    dot: 0,
  },
  {
    lines: [
      'You can switch to another layer',
      'when holding a key by assigning',
      'a temp-layer to it',
    ],
    dot: 1,
  },
  {
    lines: ['You can open your favorite app', 'with a smart-action'],
    dot: 1,
  },
  {
    lines: ['Multiactions can contain actions', 'and smart-actions'],
    dot: 1,
  },
  {
    lines: ['If you need more layers you can', 'create another profile'],
    dot: 2,
  },
  {
    lines: ['You can assign icons to actions,', 'multiactions and smart-actions'],
    dot: 2,
  },
];

export default function App() {
  const prefersReducedMotion = useReducedMotion();
  const prefersReducedMotionRef = useRef(Boolean(prefersReducedMotion));
  prefersReducedMotionRef.current = Boolean(prefersReducedMotion);
  const [entrancePhase, setEntrancePhase] = useState<EntrancePhase>(() =>
    typeof document !== 'undefined' &&
    document.getElementById('root')?.classList.contains('is-ready')
      ? 'complete'
      : 'waiting'
  );

  useEffect(() => {
    const beginEntrance = () => {
      setEntrancePhase((phase) => {
        if (phase !== 'waiting') return phase;
        return prefersReducedMotionRef.current ? 'complete' : 'entering';
      });
    };

    window.addEventListener(APP_READY_EVENT, beginEntrance);
    if (document.getElementById('root')?.classList.contains('is-ready')) {
      beginEntrance();
    }
    return () => window.removeEventListener(APP_READY_EVENT, beginEntrance);
  }, []);

  useEffect(() => {
    if (entrancePhase !== 'entering') return;
    const completionTimer = window.setTimeout(() => {
      setEntrancePhase('complete');
    }, 1900);
    return () => window.clearTimeout(completionTimer);
  }, [entrancePhase]);

  useEffect(() => {
    if (prefersReducedMotion && entrancePhase === 'entering') {
      setEntrancePhase('complete');
    }
  }, [entrancePhase, prefersReducedMotion]);

  const [activeNav, setActiveNav] = useState<'Keymap' | 'Preset' | 'Settings'>('Keymap');

  useEffect(() => {
    if (activeNav !== 'Keymap' && entrancePhase === 'entering') {
      setEntrancePhase('complete');
    }
  }, [activeNav, entrancePhase]);
  const [savedProfileState] = useState(loadSavedProfileState);
  const [profiles, setProfiles] = useState<ProfileData[]>(
    () => savedProfileState?.profiles ?? INITIAL_PROFILES
  );
  const [activeProfileIndex, setActiveProfileIndex] = useState(
    () => savedProfileState?.activeProfileIndex ?? 0
  );
  const [activeLayerIndex, setActiveLayerIndex] = useState(0);
  const [selectedKey, setSelectedKey] = useState<KeySlotId | null>(null);
  const [selectedEncoderSub, setSelectedEncoderSub] =
    useState<EncoderSubActionId | null>(null);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);

  // Key Mapping states (4-button stack + full-height right sidebar drawer)
  const [mappingStackExpanded, setMappingStackExpanded] = useState(false);
  const [hoveredMappingType, setHoveredMappingType] = useState<
    'Basic Key' | 'Action' | 'Multiaction' | 'Smart Action' | null
  >(null);
  const [mappingDrawerOpen, setMappingDrawerOpen] = useState(false);
  const [mappingTab, setMappingTab] = useState<MappingTabId>('Basic');
  const [mappingSearch, setMappingSearch] = useState('');
  const [mappingViewMode, setMappingViewMode] = useState<'list' | 'grid'>('grid');
  const [expandedListSections, setExpandedListSections] = useState<Record<string, boolean>>({});

  // Custom created items for Action, Multi-A, Smart-A
  const [customItemsByTab, setCustomItemsByTab] = useState<CustomItemsByTab>(
    () => savedProfileState?.customItems ?? { Action: [], 'Multi-A': [], 'Smart-A': [] }
  );
  const [creatorModalTab, setCreatorModalTab] = useState<
    Exclude<MappingTabId, 'Basic'> | null
  >(null);
  const [editingCustomItemId, setEditingCustomItemId] = useState<string | null>(null);
  const [newCustomName, setNewCustomName] = useState('');
  const [newCustomBinding, setNewCustomBinding] = useState('');
  const [selectedIconId, setSelectedIconId] = useState<string | undefined>(undefined);
  const [selectedEmoji, setSelectedEmoji] = useState<string | undefined>(undefined);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [iconPickerTab, setIconPickerTab] = useState<'Icon' | 'Emoji'>('Icon');
  const [iconPickerSearch, setIconPickerSearch] = useState('');
  const [iconPickerShowAll, setIconPickerShowAll] = useState(false);
  const [iconPickerPage, setIconPickerPage] = useState(0);
  const [selectableEmojiList, setSelectableEmojiList] = useState<EmojiCatalogEntry[]>([]);
  const iconCatalog = useMemo(() => buildIconCatalog(getMacroIconLibrary()), []);
  const iconSearchResults = useMemo(
    () =>
      searchIconCatalog(
        iconCatalog,
        iconPickerSearch,
        ICON_SEARCH_PAGE_SIZE,
        iconPickerShowAll,
        iconPickerPage * ICON_SEARCH_PAGE_SIZE
      ),
    [iconCatalog, iconPickerSearch, iconPickerShowAll, iconPickerPage]
  );

  useEffect(() => {
    if (!iconPickerOpen) setIconPickerPage(0);
  }, [iconPickerOpen]);

  // Multiaction editor states
  const [multiGestures, setMultiGestures] = useState<
    Record<MultiGestureKey, string>
  >({
    onTap: '',
    doubleTap: '',
    onHold: '',
    tapHold: '',
  });
  const [tappingTermMs, setTappingTermMs] = useState('250');
  const [activeGestureDropdown, setActiveGestureDropdown] =
    useState<MultiGestureKey | null>(null);
  const [gestureKeySearch, setGestureKeySearch] = useState('');
  const [expandedGestureSection, setExpandedGestureSection] = useState<
    string | null
  >(null);

  // Smart Action editor states
  const [smartSubTab, setSmartSubTab] = useState<SmartActionSubTab>('Text');
  const [smartTextValue, setSmartTextValue] = useState('');
  const [smartCmdValue, setSmartCmdValue] = useState('');
  const [smartWebValue, setSmartWebValue] = useState('');
  const [smartAppValue, setSmartAppValue] = useState('');
  const [smartAppDropdownOpen, setSmartAppDropdownOpen] = useState(false);
  const [selectedSmartApplication, setSelectedSmartApplication] =
    useState<InstalledApplication | null>(null);
  const [installedApplications, setInstalledApplications] = useState<InstalledApplication[]>([]);
  const [installedApplicationsLoading, setInstalledApplicationsLoading] = useState(false);
  const [installedApplicationsError, setInstalledApplicationsError] = useState('');
  const installedApplicationsRequestRef = useRef(0);
  const [enableCommandActions, setEnableCommandActions] = useState(true);

  const loadInstalledApplications = useCallback(async () => {
    const requestId = ++installedApplicationsRequestRef.current;
    const getApplications = window.electronAPI?.getInstalledApplications;
    if (!getApplications) {
      setInstalledApplications([]);
      setInstalledApplicationsError('Installed app search is available in the Windows desktop app.');
      setInstalledApplicationsLoading(false);
      return;
    }
    if (window.electronAPI?.platform && window.electronAPI.platform !== 'win32') {
      setInstalledApplications([]);
      setInstalledApplicationsError('Installed app search is currently available on Windows.');
      setInstalledApplicationsLoading(false);
      return;
    }

    setInstalledApplicationsLoading(true);
    setInstalledApplicationsError('');
    try {
      const result = await getApplications();
      if (requestId !== installedApplicationsRequestRef.current) return;
      if (!result?.ok || !Array.isArray(result.apps)) {
        setInstalledApplications([]);
        setInstalledApplicationsError(result?.error || 'Could not load installed applications.');
        return;
      }
      setInstalledApplications(result.apps.filter((application) =>
        typeof application?.name === 'string' && application.name.trim() &&
        typeof application.shortcutPath === 'string' && application.shortcutPath.trim()
      ));
    } catch (error) {
      if (requestId !== installedApplicationsRequestRef.current) return;
      setInstalledApplications([]);
      setInstalledApplicationsError(
        error instanceof Error ? error.message : 'Could not load installed applications.'
      );
    } finally {
      if (requestId === installedApplicationsRequestRef.current) {
        setInstalledApplicationsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (creatorModalTab !== 'Smart-A' || smartSubTab !== 'App') return;
    setSmartAppDropdownOpen(true);
    void loadInstalledApplications();
    return () => {
      installedApplicationsRequestRef.current += 1;
    };
  }, [creatorModalTab, smartSubTab, loadInstalledApplications]);

  useEffect(() => {
    const selectedName = smartAppValue.trim().toLocaleLowerCase();
    if (smartSubTab !== 'App' || !selectedName) return;
    const matchingApp = installedApplications.find((application) =>
      application.name.toLocaleLowerCase() === selectedName
    );
    if (matchingApp && matchingApp.shortcutPath !== selectedSmartApplication?.shortcutPath) {
      setSelectedSmartApplication(matchingApp);
    }
  }, [smartSubTab, smartAppValue, installedApplications, selectedSmartApplication]);

  const filteredInstalledApplications = useMemo(() => {
    const query = smartAppValue.trim().toLocaleLowerCase();
    return installedApplications
      .filter((application) => application.name.toLocaleLowerCase().includes(query));
  }, [installedApplications, smartAppValue]);

  // Action editor states (Interactive keyboard recorder + Advance mode)
  const [actionAdvanceMode, setActionAdvanceMode] = useState(false);
  const [actionRecordingStatus, setActionRecordingStatus] = useState<
    'idle' | 'recording' | 'confirmed'
  >('idle');
  const [actionTokens, setActionTokens] = useState<
    { id: string; label: string; kind: 'text' | 'modifier' | 'special' }[]
  >([]);
  const [actionAdvanceSteps, setActionAdvanceSteps] = useState<
    {
      id: string;
      keyLabel: string;
      mode: 'press-release' | 'press';
      delayAfterActive?: boolean;
      delayAfterMs?: string;
    }[]
  >([
    {
      id: 'adv-step-1',
      keyLabel: '',
      mode: 'press-release',
      delayAfterActive: false,
      delayAfterMs: '200',
    },
  ]);
  const [activeAdvanceStepDropdown, setActiveAdvanceStepDropdown] = useState<
    string | null
  >(null);
  const [hoveredDelayStepId, setHoveredDelayStepId] = useState<string | null>(
    null
  );
  const [editingDelayStepId, setEditingDelayStepId] = useState<string | null>(
    null
  );
  const [hoveredModeStepId, setHoveredModeStepId] = useState<string | null>(
    null
  );
  const [draggingAdvStep, setDraggingAdvStep] = useState<{
    id: string;
    offsetY: number;
  } | null>(null);
  const advStepDragRef = useRef<{
    id: string;
    startY: number;
  } | null>(null);
  const lastBackspaceTimeRef = useRef<number>(0);

  const [editLayoutModalOpen, setEditLayoutModalOpen] = useState(false);
  const [activeTooltip, setActiveTooltip] = useState<
    'profiles' | 'layers' | 'mapping' | 'drawer-mapping' | null
  >(null);
  const [tipIndex, setTipIndex] = useState(0);

  // Drag-and-drop & Drawer Tile Selection state
  const [selectedDrawerTile, setSelectedDrawerTile] = useState<{
    item: BasicTileItem;
    sourceTab: MappingTabId;
  } | null>(null);
  const [flashedTileId, setFlashedTileId] = useState<string | null>(null);
  const flashTimeoutRef = useRef<number | null>(null);
  const [draggedTile, setDraggedTile] = useState<{
    item: BasicTileItem;
    sourceTab: MappingTabId;
    fromSlotId?: KeySlotId;
    fromSubAction?: EncoderSubActionId;
    x: number;
    y: number;
  } | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<{
    slotId: KeySlotId;
    subAction?: EncoderSubActionId;
  } | null>(null);
  const dragSessionRef = useRef<{
    item: BasicTileItem;
    sourceTab: MappingTabId;
    fromSlotId?: KeySlotId;
    fromSubAction?: EncoderSubActionId;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    isDragging: boolean;
  } | null>(null);
  const suppressNextClickRef = useRef(false);

  // Subtle corner-held circular swing for floating dragged keycap
  const dragRawBobY = useMotionValue(0);
  const dragRawRotate = useMotionValue(0);
  const dragSpringBobY = useSpring(dragRawBobY, {
    stiffness: 300,
    damping: 20,
    mass: 0.6,
  });
  const dragSpringRotate = useSpring(dragRawRotate, {
    stiffness: 260,
    damping: 18,
    mass: 0.65,
  });
  const dragTiltDecayTimeoutRef = useRef<number | null>(null);

  // Refs for outside-click closing of Profiles & Layers popovers and main canvas bounds
  const keymapMainRef = useRef<HTMLElement | null>(null);
  const profileContainerRef = useRef<HTMLDivElement | null>(null);
  const layersContainerRef = useRef<HTMLDivElement | null>(null);

  // Movable Macropad + "Edit layout" unit state (clamped to blank canvas area)
  const [macropadOffset, setMacropadOffset] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  const [isDraggingMacropad, setIsDraggingMacropad] = useState(false);
  const macropadMoveUnitRef = useRef<HTMLDivElement | null>(null);
  const macropadDragRef = useRef<{
    startX: number;
    startY: number;
    initialOffsetX: number;
    initialOffsetY: number;
    isMoving: boolean;
  } | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      setTipIndex((prev) => (prev + 1) % TIPS.length);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // Preset view state
  const [presetSearch, setPresetSearch] = useState('');
  const [presetOs, setPresetOs] = useState<'mac' | 'win'>('win');
  const [previewPreset, setPreviewPreset] = useState<PresetItem | null>(null);
  const [hoveredPreviewSlot, setHoveredPreviewSlot] = useState<KeySlotId | null>(null);
  const [hoveredPreviewDial, setHoveredPreviewDial] = useState<'cw' | 'press' | 'ccw' | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Settings view state
  const [appSettings, setAppSettings] = useState<AppSettings>(() => {
    const saved = readAppSettings();
    return window.electronAPI?.setAppSetting
      ? saved
      : { ...saved, launchAtStartup: false };
  });
  const { launchAtStartup, allowTerminalSmartActions, allowDeviceNotifications } = appSettings;
  const [settingsCapabilities, setSettingsCapabilities] = useState<SettingsCapabilities>({
    launchAtStartup: false,
    firmwareFlash: false,
    externalLinks: true,
  });
  const [appVersion, setAppVersion] = useState(
    typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : APP_VERSION_FALLBACK
  );
  const [firmwareCheckPending, setFirmwareCheckPending] = useState(false);
  const [deviceStatus, setDeviceStatus] = useState<QmkViaStatus>({ state: 'disconnected' });
  const [deviceActiveLayer, setDeviceActiveLayer] = useState<number>(0);
  const [deviceSyncReady, setDeviceSyncReady] = useState(false);
  const lastSyncedConfigKeyRef = useRef('');

  const hydratedRgbConnectionRef = useRef<boolean>(false);

  const applyConnectedStatus = useCallback((status: QmkViaStatus) => {
    setDeviceStatus(status);
    if (typeof status.deviceActiveLayer === 'number') {
      setDeviceActiveLayer(Math.min(MAX_LAYER_COUNT - 1, Math.max(0, status.deviceActiveLayer)));
    }
    if (status.state !== 'connected') {
      hydratedRgbConnectionRef.current = false;
      return;
    }
    if (status.rgbConfig && !hydratedRgbConnectionRef.current) {
      hydratedRgbConnectionRef.current = true;
      const remoteRgb = status.rgbConfig;
      const modeMap = ['Off', 'Solid', 'Rainbow', 'Breath'] as const;
      setLayerLedConfigs((prev) =>
        prev.map((currentCfg, idx) => {
          const c = remoteRgb.layerColors[idx];
          const rawMode = remoteRgb.layerModes?.[idx];
          const preset =
            rawMode !== undefined && rawMode >= 0 && rawMode <= 3
              ? modeMap[rawMode]
              : remoteRgb.enabled
                ? 'Solid'
                : 'Off';
          const rawSpeed = remoteRgb.layerSpeeds?.[idx];
          const speed =
            typeof rawSpeed === 'number' && rawSpeed >= 0 && rawSpeed <= 100
              ? rawSpeed
              : currentCfg.speed;
          if (!c) {
            return { ...currentCfg, preset, speed };
          }
          const maxChannel = Math.max(c.r, c.g, c.b);
          if (maxChannel === 0) {
            return {
              ...currentCfg,
              preset,
              speed,
              light: preset === 'Off' ? currentCfg.light : 0,
            };
          }
          const scale = 255 / maxChannel;
          const nr = Math.min(255, Math.round(c.r * scale));
          const ng = Math.min(255, Math.round(c.g * scale));
          const nb = Math.min(255, Math.round(c.b * scale));
          const colorHex = `#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}`.toUpperCase();
          const rNorm = nr / 255;
          const gNorm = ng / 255;
          const bNorm = nb / 255;
          const cMin = Math.min(rNorm, gNorm, bNorm);
          const delta = 1 - cMin;
          let hue = currentCfg.hue;
          if (delta > 0.0001) {
            if (rNorm === 1) hue = Math.round(((gNorm - bNorm) / delta) * 60);
            else if (gNorm === 1) hue = Math.round((((bNorm - rNorm) / delta) + 2) * 60);
            else hue = Math.round((((rNorm - gNorm) / delta) + 4) * 60);
            if (hue < 0) hue += 360;
          }
          return {
            ...currentCfg,
            preset,
            speed,
            light: Math.round((maxChannel / 255) * 100),
            hue,
            colorHex,
          };
        }) as [LayerLedConfig, LayerLedConfig, LayerLedConfig, LayerLedConfig]
      );
    }
  }, []);

  useEffect(() => {
    const bridge = window.macropad;
    if (!bridge) {
      setDeviceStatus({ state: 'unavailable', error: 'QMK/VIA device bridge is unavailable' });
      return;
    }

    let active = true;
    const unsubscribe = bridge.onStatus((status) => {
      if (!active) return;
      applyConnectedStatus(status);
    });
    void bridge.getStatus().then((status) => {
      if (!active) return;
      applyConnectedStatus(status);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [applyConnectedStatus]);

  useEffect(() => {
    let active = true;
    const settingsTools = window.nodeStudioAppSettings ?? createAppSettingsTools(window);
    void settingsTools.getDesktop().then((result) => {
      if (!active || !result?.ok) return;
      if (result.settings) setAppSettings(result.settings);
      if (result.capabilities) setSettingsCapabilities(result.capabilities);
    });
    const getVersion = window.electronAPI?.getVersion;
    if (getVersion) {
      void getVersion().then((version) => {
        if (active && typeof version === 'string' && version.trim()) setAppVersion(version);
      }).catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    saveAppSettings(appSettings);
  }, [appSettings]);

  useEffect(() => {
    const bridge = window.macropad;
    if (
      !bridge ||
      !allowDeviceNotifications ||
      typeof window.Notification === 'undefined' ||
      window.Notification.permission !== 'granted'
    ) return;

    return bridge.onEvent((event) => {
      if (!isRecordValue(event)) return;
      const type = event.type;
      if (type !== 'connect' && type !== 'disconnect') return;
      const title = type === 'connect' ? 'Device connected' : 'Device disconnected';
      const body = type === 'connect'
        ? `${typeof event.device === 'string' ? event.device : 'Grid Macro 1'} is ready`
        : 'The Grid Macro 1 was disconnected';
      try {
        new window.Notification(title, { body });
      } catch {
        // Notification permission may be revoked by the OS after the setting is enabled.
      }
    });
  }, [allowDeviceNotifications]);

  // Undo / Redo stacks
  const [history, setHistory] = useState<ProfileData[][]>([]);
  const [redoStack, setRedoStack] = useState<ProfileData[][]>([]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        PROFILE_FILE_STORAGE_KEY,
        JSON.stringify({
          v: 1,
          profiles,
          activeProfileIndex,
          customItems: customItemsByTab,
        })
      );
    } catch {
      // Keep in-memory profile editing usable if browser storage is unavailable.
    }
  }, [profiles, activeProfileIndex, customItemsByTab]);

  // Hardware layout and desktop execution mode
  const [encoderAngle, setEncoderAngle] = useState(45);
  const [simulationMode, setSimulationMode] = useState(false);
  const [simulationTransition, setSimulationTransition] = useState(false);

  useEffect(() => {
    const disableSimulationOnPageHide = () => {
      void requestSimulationMode(false, window);
    };
    window.addEventListener('pagehide', disableSimulationOnPageHide);
    return () => window.removeEventListener('pagehide', disableSimulationOnPageHide);
  }, []);

  // Profiles & Layers extended toolbar / lighting / delete confirmation states
  const [deletingProfileId, setDeletingProfileId] = useState<string | null>(null);
  const [layerToolbarOpen, setLayerToolbarOpen] = useState(false);
  const [layerLightingOpen, setLayerLightingOpen] = useState(false);
  const [layerDeleteConfirm, setLayerDeleteConfirm] = useState(false);
  const [customItemDeleteConfirm, setCustomItemDeleteConfirm] = useState(false);
  const [layerNames, setLayerNames] = useState<Record<string, string>>({});
  type LayerLedConfig = {
    preset: 'Off' | 'Solid' | 'Rainbow' | 'Breath';
    light: number;
    speed: number;
    hue: number;
    colorHex: string;
  };

  const DEFAULT_LAYER_LED_CONFIGS: [LayerLedConfig, LayerLedConfig, LayerLedConfig, LayerLedConfig] = [
    { preset: 'Solid', light: 100, speed: 50, hue: 221, colorHex: '#0051FF' },
    { preset: 'Solid', light: 100, speed: 50, hue: 160, colorHex: '#10B981' },
    { preset: 'Solid', light: 100, speed: 50, hue: 38, colorHex: '#F59E0B' },
    { preset: 'Solid', light: 100, speed: 50, hue: 347, colorHex: '#E11D48' },
  ];

  const [layerLedConfigs, setLayerLedConfigs] = useState<
    [LayerLedConfig, LayerLedConfig, LayerLedConfig, LayerLedConfig]
  >(() => {
    try {
      const raw = window.localStorage.getItem('node-studio.layer-led.v1');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length === 4) {
          return parsed.map((item, idx) => ({
            ...DEFAULT_LAYER_LED_CONFIGS[idx],
            ...(item && typeof item === 'object' ? item : {}),
          })) as [LayerLedConfig, LayerLedConfig, LayerLedConfig, LayerLedConfig];
        }
      }
    } catch {
      // Fall back to default per-layer colours
    }
    return DEFAULT_LAYER_LED_CONFIGS;
  });

  const [ledEditingLayerIdx, setLedEditingLayerIdx] = useState<number>(0);

  useEffect(() => {
    setLedEditingLayerIdx(Math.min(3, Math.max(0, activeLayerIndex)));
  }, [activeLayerIndex]);

  useEffect(() => {
    try {
      window.localStorage.setItem('node-studio.layer-led.v1', JSON.stringify(layerLedConfigs));
    } catch {
      // Ignore storage write errors
    }
  }, [layerLedConfigs]);

  const hexToScaledRgb = (hex: string, brightnessPct: number): { r: number; g: number; b: number } => {
    const clean = hex.replace(/^#/, '').trim();
    const valid = /^[0-9a-fA-F]{6}$/.test(clean) ? clean : '0051FF';
    const scale = Math.max(0, Math.min(100, brightnessPct)) / 100;
    return {
      r: Math.round(Number.parseInt(valid.slice(0, 2), 16) * scale),
      g: Math.round(Number.parseInt(valid.slice(2, 4), 16) * scale),
      b: Math.round(Number.parseInt(valid.slice(4, 6), 16) * scale),
    };
  };

  const syncRgbConfigsToDevice = (
    configs: [LayerLedConfig, LayerLedConfig, LayerLedConfig, LayerLedConfig],
    persist: boolean
  ) => {
    const bridge = window.macropad;
    if (!bridge || deviceStatus.state !== 'connected') return;
    const modeLookup: Record<LayerLedConfig['preset'], number> = {
      Off: 0,
      Solid: 1,
      Rainbow: 2,
      Breath: 3,
    };
    const anyEnabled = configs.some((c) => c.preset !== 'Off');
    void bridge
      .request({
        cmd: 'set_rgb_config',
        rgbConfig: {
          enabled: anyEnabled,
          persist,
          layerColors: [
            configs[0].preset === 'Off' ? { r: 0, g: 0, b: 0 } : hexToScaledRgb(configs[0].colorHex, configs[0].light),
            configs[1].preset === 'Off' ? { r: 0, g: 0, b: 0 } : hexToScaledRgb(configs[1].colorHex, configs[1].light),
            configs[2].preset === 'Off' ? { r: 0, g: 0, b: 0 } : hexToScaledRgb(configs[2].colorHex, configs[2].light),
            configs[3].preset === 'Off' ? { r: 0, g: 0, b: 0 } : hexToScaledRgb(configs[3].colorHex, configs[3].light),
          ],
          layerModes: [
            modeLookup[configs[0].preset],
            modeLookup[configs[1].preset],
            modeLookup[configs[2].preset],
            modeLookup[configs[3].preset],
          ],
          layerSpeeds: [
            configs[0].speed,
            configs[1].speed,
            configs[2].speed,
            configs[3].speed,
          ],
        },
      })
      .catch(() => undefined);
  };

  const currentProfile = profiles[activeProfileIndex] || profiles[0];
  const currentLayer =
    currentProfile.layers[activeLayerIndex] || currentProfile.layers[0];
  const currentLayerNameKey = `${currentProfile.id}-${activeLayerIndex}`;
  const currentLayerName = layerNames[currentLayerNameKey] ?? '';

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((current) => (current === msg ? null : current));
    }, 2200);
  };

  const toggleSimulationMode = async () => {
    if (simulationTransition) return;
    const enabled = !simulationMode;
    setSimulationTransition(true);
    if (!enabled) setSimulationMode(false);
    try {
      const result = await requestSimulationMode(enabled, window);
      if (result.ok && result.enabled === enabled) {
        setSimulationMode(enabled);
        showToast(enabled ? 'Simulation enabled — actions affect your desktop' : 'Simulation disabled');
      } else {
        setSimulationMode(false);
        showToast(result.error || 'Could not update Simulation mode');
      }
    } catch (error) {
      setSimulationMode(false);
      showToast(error instanceof Error ? error.message : 'Could not update Simulation mode');
    } finally {
      setSimulationTransition(false);
    }
  };

  useEffect(() => {
    const bridge = window.macropad;
    if (!bridge || deviceStatus.state !== 'connected') {
      lastSyncedConfigKeyRef.current = '';
      setDeviceSyncReady(false);
      return;
    }

    let cancelled = false;
    setDeviceSyncReady(false);
    lastSyncedConfigKeyRef.current = '';

    void (async () => {
      try {
        const remote = await bridge.getFile('app_state') as {
          ok: boolean;
          text?: string;
        };
        if (cancelled) return;
        if (remote.ok && typeof remote.text === 'string' && profileFileTools) {
          try {
            const saved = profileFileTools.parse(remote.text);
            const nextProfiles = saved.profiles.map((profile) =>
              normalizeProfileForEditor(profile as unknown as ProfileData)
            );
            setProfiles(nextProfiles);
            setActiveProfileIndex(saved.activeProfileIndex);
            setActiveLayerIndex(0);
            setCustomItemsByTab(normalizeCustomItemsForEditor(
              saved.customItems as unknown as CustomItemsByTab
            ));
            const selected = nextProfiles[saved.activeProfileIndex] ?? nextProfiles[0];
            lastSyncedConfigKeyRef.current = `slot:${saved.activeProfileIndex}:${JSON.stringify(
              buildViaConfiguration(selected, presetOs, { enableHostTriggers: true }).config
            )}`;
            showToast('Loaded keymap profile from Grid Macro 1');
          } catch {
            // Ignore malformed device metadata; the validated local profile remains authoritative.
          }
        }
      } catch {
        // A stock VIA device stores keymaps, not profile metadata. Sync local profiles below.
      }

      if (!cancelled) setDeviceSyncReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [deviceStatus.state, deviceStatus.device, deviceStatus.fw]);

  // Listen for physical device layer changes and hardware host-action triggers
  useEffect(() => {
    const bridge = window.macropad;
    if (!bridge) return;

    const triggerController = createHardwareTriggerController(
      (targetLayer) => {
        if (targetLayer >= currentProfile.layers.length) return false;
        setDeviceActiveLayer(targetLayer);
      },
      showToast,
      window
    );

    const unsubscribe = bridge.onEvent((rawEvent) => {
      if (!isRecordValue(rawEvent)) return;
      if (rawEvent.type === 'layer_state') {
        const layerEvent = rawEvent as unknown as DeviceLayerStateEvent;
        if (typeof layerEvent.deviceActiveLayer === 'number') {
          setDeviceActiveLayer(Math.min(MAX_LAYER_COUNT - 1, Math.max(0, layerEvent.deviceActiveLayer)));
        }
        if (
          typeof layerEvent.activeProfileSlot === 'number' &&
          layerEvent.activeProfileSlot >= 0 &&
          layerEvent.activeProfileSlot < profiles.length &&
          layerEvent.activeProfileSlot !== activeProfileIndex
        ) {
          const targetSlot = layerEvent.activeProfileSlot;
          const targetProfile = profiles[targetSlot];
          if (targetProfile) {
            const { config: targetConfig } = buildViaConfiguration(targetProfile, presetOs, {
              enableHostTriggers: true,
            });
            lastSyncedConfigKeyRef.current = `slot:${targetSlot}:${JSON.stringify(targetConfig)}`;
          }
          setActiveProfileIndex(targetSlot);
          showToast(
            `Switched to ${profiles[targetSlot]?.name || `Profile ${targetSlot + 1}`} from device`
          );
        }
        return;
      }
      if (rawEvent.type === 'hardware_trigger') {
        const trig = rawEvent as unknown as HardwareTriggerEvent;
        const activeProf = profiles[activeProfileIndex] ?? profiles[0];
        if (!activeProf) return;
        const targetLayer =
          activeProf.layers[trig.layer] ??
          activeProf.layers[deviceActiveLayer] ??
          activeProf.layers[0];
        if (!targetLayer) return;
        let assignment: SimulationAction | undefined;
        if (trig.slotId === 'cw' || trig.slotId === 'press' || trig.slotId === 'ccw') {
          const dial = targetLayer[GRID_MACRO_ENCODER_SLOT];
          assignment = dial?.encoderActions?.[trig.slotId];
        } else {
          const keyEntry = targetLayer[trig.slotId as KeySlotId];
          if (keyEntry) {
            assignment = { ...keyEntry, id: keyEntry.actionId };
          }
        }
        triggerController.handleSlotEvent(trig.slotId, trig.pressed, assignment);
      }
    });

    return () => {
      unsubscribe();
      triggerController.cancelAll();
    };
  }, [profiles, activeProfileIndex, currentProfile, deviceActiveLayer, presetOs]);

  // Listen for native Electron menu hardware actions when running inside desktop shell
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    const offSync = api.onHardwareSync?.(() => {
      lastSyncedConfigKeyRef.current = '';
      setDeviceSyncReady((ready) => ready);
      showToast(
        deviceStatus.state === 'connected'
          ? 'Syncing active profile to RP2040-Zero...'
          : 'Connect Grid Macro 1 via QMK/VIA to sync'
      );
    });
    const offModal = api.onOpenHardwareModal?.(() => {
      setActiveNav('Settings');
    });
    return () => {
      if (typeof offSync === 'function') offSync();
      if (typeof offModal === 'function') offModal();
    };
  }, [deviceStatus.state]);

  useEffect(() => {
    const bridge = window.macropad;
    if (!bridge || deviceStatus.state !== 'connected' || !deviceSyncReady) return;

    const { config, warnings: configWarnings } = buildViaConfiguration(currentProfile, presetOs, {
      enableHostTriggers: true,
    });
    if (config.layers.length === 0) return;
    const configKey = `slot:${activeProfileIndex}:${JSON.stringify(config)}`;
    if (configKey === lastSyncedConfigKeyRef.current) return;

    let cancelled = false;
    const syncTimer = window.setTimeout(() => {
      if (configKey === lastSyncedConfigKeyRef.current) return;
      void (async () => {
        try {
          const current = await bridge.request({ cmd: 'get_config' });
          if (cancelled || configKey === lastSyncedConfigKeyRef.current) return;
          if (!current.ok || !current.snapshot) {
            showToast(
              `Profile saved locally; device sync paused because a pre-sync backup could not be read: ${
                current.error || 'no keymap snapshot returned'
              }`
            );
            return;
          }
          if (!deviceKeymapFileTools) {
            showToast('Profile saved locally; device sync paused because local backup tools are unavailable');
            return;
          }

          const backup = deviceKeymapFileTools.savePreSyncSnapshot(current.snapshot, {
            device: deviceStatus.device,
            firmware: deviceStatus.fw,
          });
          if (!backup.ok) {
            showToast(
              `Profile saved locally; device sync paused because the pre-sync backup could not be saved: ${
                backup.error || 'unknown storage error'
              }`
            );
            return;
          }
          if (cancelled || configKey === lastSyncedConfigKeyRef.current) return;

          const synced = await bridge.request({
            cmd: 'set_config',
            config,
            profileSlot: activeProfileIndex,
          });
          if (cancelled) return;
          if (!synced.ok) {
            showToast(
              `Profile saved locally; device sync failed: ${synced.error || 'unknown error'}. A pre-sync backup was saved locally.`
            );
            return;
          }

          lastSyncedConfigKeyRef.current = configKey;
          const state = JSON.stringify({
            v: 1,
            profiles,
            activeProfileIndex,
            customItems: customItemsByTab,
          });
          const saved = await bridge.putFile('app_state', state);
          if (cancelled) return;
          if (!saved.ok) {
            showToast(`Keymap synced to device; local profile save failed: ${saved.error || 'unknown error'}`);
            return;
          }

          const syncWarnings = [
            ...configWarnings,
            ...(current.warnings ?? []),
            ...(synced.warnings ?? []),
          ];
          showToast(
            syncWarnings.length
              ? `Profile saved locally; ${syncWarnings.length} sync warning${syncWarnings.length === 1 ? '' : 's'}: ${syncWarnings[0]}`
              : 'Profile saved locally; keymap synced to device'
          );
        } catch (error) {
          if (!cancelled) {
            showToast(
              `Profile saved locally; device sync failed: ${error instanceof Error ? error.message : String(error)}. Keymap writes require a locally saved pre-sync backup.`
            );
          }
        }
      })();
    }, 500);

    return () => {
      cancelled = true;
      window.clearTimeout(syncTimer);
    };
  }, [
    deviceSyncReady,
    deviceStatus.state,
    deviceStatus.device,
    deviceStatus.fw,
    profiles,
    activeProfileIndex,
    currentProfile,
    customItemsByTab,
    presetOs,
  ]);

  const ensureEmojiCatalog = async () => {
    if (selectableEmojiList.length > 0) return true;
    try {
      const catalog = await import('./emojiCatalog');
      setSelectableEmojiList(catalog.SELECTABLE_EMOJI_LIST);
      return true;
    } catch {
      showToast('Could not load the emoji choices');
      return false;
    }
  };

  const handleToggleIconPicker = async () => {
    if (iconPickerOpen) {
      setIconPickerOpen(false);
      return;
    }
    if (iconPickerTab === 'Emoji' && !(await ensureEmojiCatalog())) return;
    setIconPickerOpen(true);
  };

  const handleIconPickerTabChange = async (tab: 'Icon' | 'Emoji') => {
    if (tab === 'Emoji' && !(await ensureEmojiCatalog())) return;
    setIconPickerTab(tab);
  };

  const handleAppSettingChange = async (key: AppSettingKey, value: boolean) => {
    const tools = window.nodeStudioAppSettings ?? createAppSettingsTools(window);
    const result = await tools.set(key, value);
    if (!result.ok || !result.settings) {
      showToast(result.error || 'Could not save this setting');
      return;
    }
    setAppSettings(result.settings);
    if (result.capabilities) setSettingsCapabilities(result.capabilities);
    if (key === 'allowTerminalSmartActions') {
      showToast(value
        ? 'Terminal commands enabled. Only run commands you trust.'
        : 'Terminal command execution disabled');
    }
  };

  const handleOpenSupportLink = async (key: SupportLinkKey, label: string) => {
    const tools = window.nodeStudioAppSettings ?? createAppSettingsTools(window);
    const result = await tools.openSupport(key);
    showToast(result.ok ? `Opening ${label}` : result.error || `Could not open ${label}`);
  };

  const handleCheckFirmwareUpdate = async () => {
    setFirmwareCheckPending(true);
    try {
      const tools = window.nodeStudioAppSettings ?? createAppSettingsTools(window);
      const result = await tools.checkFirmware();
      const installedVersion = deviceStatus.state === 'connected'
        ? ` Connected device reports ${deviceStatus.fw || 'an unknown firmware version'}.`
        : '';
      showToast(`${result.message}${installedVersion}`);
    } catch (error) {
      showToast(`Firmware check failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setFirmwareCheckPending(false);
    }
  };

  const handleAdvanceFlash = async () => {
    const tools = window.nodeStudioAppSettings ?? createAppSettingsTools(window);
    const result = await tools.flashFirmware();
    if (result.cancelled) return;
    showToast(result.ok ? result.message || 'Firmware operation completed' : result.error || 'Firmware flashing failed');
  };

  const handleToggleDeviceConnection = async () => {
    const bridge = window.macropad;
    if (!bridge) {
      showToast('QMK/VIA device bridge is unavailable');
      return;
    }

    if (deviceStatus.state === 'connected') {
      await bridge.disconnect();
      setDeviceStatus({ state: 'disconnected' });
      return;
    }

    try {
      const nextStatus = await bridge.connect();
      setDeviceStatus(nextStatus);
      if (nextStatus.state !== 'connected' && nextStatus.error) {
        showToast(nextStatus.error);
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  };

  const pushState = (nextProfiles: ProfileData[]) => {
    setHistory((prev) => [...prev.slice(-19), profiles]);
    setRedoStack([]);
    setProfiles(nextProfiles);
  };

  const handleResetLocalConfig = () => {
    if (!window.confirm('Reset all saved profiles and custom actions? This does not reset the physical device keymap.')) {
      return;
    }
    setProfiles(JSON.parse(JSON.stringify(INITIAL_PROFILES)) as ProfileData[]);
    setActiveProfileIndex(0);
    setActiveLayerIndex(0);
    setCustomItemsByTab({ Action: [], 'Multi-A': [], 'Smart-A': [] });
    setHistory([]);
    setRedoStack([]);
    setLayerNames({});
    showToast('Local profiles and custom actions reset; the physical device keymap was not changed');
  };

  const handleUndo = () => {
    if (history.length === 0) return;
    const previous = history[history.length - 1];
    setRedoStack((prev) => [profiles, ...prev]);
    setHistory((prev) => prev.slice(0, -1));
    setProfiles(previous);
  };

  const handleRedo = () => {
    if (redoStack.length === 0) return;
    const next = redoStack[0];
    setHistory((prev) => [...prev, profiles]);
    setRedoStack((prev) => prev.slice(1));
    setProfiles(next);
  };

  const handleAddLayer = () => {
    if (currentProfile.layers.length >= MAX_LAYER_COUNT) {
      showToast(`A profile can have up to ${MAX_LAYER_COUNT} layers. Remove one first.`);
      return;
    }
    const blankLayer: LayerKeymap = JSON.parse(JSON.stringify(INITIAL_LAYER_1));
    const nextProfiles = profiles.map((p, idx) =>
      idx === activeProfileIndex
        ? { ...p, layers: [...p.layers, blankLayer] }
        : p
    );
    pushState(nextProfiles);
    setActiveLayerIndex(currentProfile.layers.length);
    setLayerToolbarOpen(true);
    setLayerDeleteConfirm(false);
  };

  const handleRemoveLayer = (layerIdx: number) => {
    if (currentProfile.layers.length <= 1) {
      const resetLayer: LayerKeymap = JSON.parse(JSON.stringify(INITIAL_LAYER_1));
      const nextProfiles = profiles.map((p, idx) =>
        idx === activeProfileIndex ? { ...p, layers: [resetLayer] } : p
      );
      pushState(nextProfiles);
      setLayerDeleteConfirm(false);
      setLayerToolbarOpen(false);
      return;
    }
    const nextProfiles = profiles.map((p, idx) =>
      idx === activeProfileIndex
        ? { ...p, layers: p.layers.filter((_, i) => i !== layerIdx) }
        : p
    );
    pushState(nextProfiles);
    setActiveLayerIndex(Math.max(0, activeLayerIndex - 1));
    setLayerDeleteConfirm(false);
  };

  const handleUpdateKeyAssignment = (
    slotId: KeySlotId,
    updates: Partial<KeyAssignment>
  ) => {
    const nextProfiles = profiles.map((p, pIdx) => {
      if (pIdx !== activeProfileIndex) return p;
      const nextLayers = p.layers.map((layer, lIdx) => {
        if (lIdx !== activeLayerIndex) return layer;
        return {
          ...layer,
          [slotId]: {
            ...layer[slotId],
            ...updates,
          },
        };
      });
      return { ...p, layers: nextLayers };
    });
    pushState(nextProfiles);
  };

  const assignItemToSlot = (
    item: BasicTileItem,
    targetSlot: KeySlotId,
    subOverride?: EncoderSubActionId,
    tabOverride?: MappingTabId
  ) => {
    const effectiveTab = tabOverride || mappingTab;
    const actionTypeMap: Record<MappingTabId, KeyAssignment['actionType']> = {
      Basic: 'Basic input',
      Action: 'Shortcut',
      'Multi-A': 'Multi-step action',
      'Smart-A': 'Smart Action',
    };
    const displayBinding =
      item.listLabel || item.main.replace(/\n/g, ' ') || 'blank';

    if (targetSlot === GRID_MACRO_ENCODER_SLOT) {
      const subTarget = subOverride || selectedEncoderSub;
      if (!subTarget) return;
      const existingActions = getEncoderActions(currentLayer[targetSlot]);
      const updatedActions: Record<EncoderSubActionId, EncoderSubBinding> = {
        ...existingActions,
        [subTarget]: {
          label: item.isClearIcon ? '—' : formatEncoderShortLabel(displayBinding),
          binding: item.isClearIcon ? 'blank' : displayBinding,
          execution: item.isClearIcon ? undefined : item.execution,
        },
      };
      handleUpdateKeyAssignment(targetSlot, {
        actionType: actionTypeMap[effectiveTab],
        encoderActions: updatedActions,
      });
      showToast(`Assigned "${displayBinding}" to Encoder (${subTarget.toUpperCase()})`);
      return;
    }

    handleUpdateKeyAssignment(targetSlot, {
      label: item.isClearIcon ? '' : item.macropadLabel,
      binding: item.isClearIcon ? 'blank' : displayBinding,
      actionType: actionTypeMap[effectiveTab],
      iconId: item.isClearIcon ? undefined : item.iconId,
      actionId: item.isClearIcon ? undefined : item.id,
      execution: item.isClearIcon ? undefined : item.execution,
    });
    showToast(`Assigned "${displayBinding}" to ${targetSlot.toUpperCase()}`);
  };

  const swapMacropadSlots = (
    slotA: KeySlotId,
    slotB: KeySlotId,
    subA?: EncoderSubActionId,
    subB?: EncoderSubActionId
  ) => {
    if (slotA === slotB && subA === subB) return;

    const nextProfiles = profiles.map((p, pIdx) => {
      if (pIdx !== activeProfileIndex) return p;
      const nextLayers = p.layers.map((layer, lIdx) => {
        if (lIdx !== activeLayerIndex) return layer;
        const copy: LayerKeymap = JSON.parse(JSON.stringify(layer));

        if (subA && subB) {
          const actionsA = getEncoderActions(copy[slotA]);
          const actionsB = getEncoderActions(copy[slotB]);
          const entryA = { ...actionsA[subA] };
          const entryB = { ...actionsB[subB] };
          if (slotA === slotB) {
            copy[slotA].encoderActions = {
              ...actionsA,
              [subA]: entryB,
              [subB]: entryA,
            };
          } else {
            copy[slotA].encoderActions = { ...actionsA, [subA]: entryB };
            copy[slotB].encoderActions = { ...actionsB, [subB]: entryA };
          }
          return copy;
        }

        if (subA && !subB) {
          const actionsA = getEncoderActions(copy[slotA]);
          const entryA = { ...actionsA[subA] };
          const itemB = { ...copy[slotB] };
          const isBEmpty =
            !itemB.iconId &&
            (!itemB.label || itemB.label === '—' || itemB.binding === 'blank');
          copy[slotA].encoderActions = {
            ...actionsA,
            [subA]: {
              label: isBEmpty
                ? '—'
                : formatEncoderShortLabel(itemB.binding || itemB.label),
              binding: isBEmpty ? 'blank' : itemB.binding,
            },
          };
          copy[slotB] = {
            ...itemB,
            label:
              entryA.binding === 'blank' || entryA.label === '—'
                ? ''
                : entryA.binding,
            binding: entryA.binding,
            iconId: undefined,
          };
          return copy;
        }

        if (!subA && subB) {
          const itemA = { ...copy[slotA] };
          const actionsB = getEncoderActions(copy[slotB]);
          // Moving rectangular key onto encoder popup sub-button sets the encoder sub-button and leaves the source rectangular key empty
          copy[slotA] = {
            ...itemA,
            label: '',
            binding: 'blank',
            iconId: undefined,
          };
          copy[slotB].encoderActions = {
            ...actionsB,
            [subB]: {
              label: formatEncoderShortLabel(itemA.binding || itemA.label),
              binding: itemA.binding || itemA.label,
            },
          };
          return copy;
        }

        const temp = { ...copy[slotA] };
        copy[slotA] = { ...copy[slotB] };
        copy[slotB] = temp;
        return copy;
      });
      return { ...p, layers: nextLayers };
    });

    pushState(nextProfiles);
    const labelA = currentLayer[slotA]?.label || 'empty';
    const labelB = currentLayer[slotB]?.label || 'empty';
    showToast(`Switched "${labelA}" ⇄ "${labelB}"`);
  };

  const clampMacropadOffset = (
    rawOffsetX: number,
    rawOffsetY: number
  ): { x: number; y: number } => {
    const container = keymapMainRef.current;
    const moveUnit = macropadMoveUnitRef.current;
    if (!container || !moveUnit) return { x: rawOffsetX, y: rawOffsetY };

    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return { x: rawOffsetX, y: rawOffsetY };
    }

    const unitRect = moveUnit.getBoundingClientRect();
    const unitWidth = moveUnit.offsetWidth || unitRect.width;
    const unitHeight = moveUnit.offsetHeight || unitRect.height;
    if (unitWidth === 0 || unitHeight === 0) {
      return { x: rawOffsetX, y: rawOffsetY };
    }

    // Match the open canvas shown in the UI: below the toolbar, above the tip,
    // and inside the side edges. Keep the drawer's occupied side out of bounds.
    const movementArea = {
      left: rect.left + 8,
      right: rect.right - (mappingDrawerOpen ? 344 : 8),
      top: rect.top + (layerToolbarOpen ? (layerLightingOpen ? 152 : 148) : 106),
      bottom: rect.bottom - 132,
    };

    const halfUnitWidth = unitWidth / 2;
    const halfUnitHeight = unitHeight / 2;
    const isEncoderPopupOpen = selectedKey === GRID_MACRO_ENCODER_SLOT;

    return clampMacropadOffsetToArea(
      { x: rawOffsetX, y: rawOffsetY },
      rect,
      movementArea,
      {
        left: -Math.max(132, halfUnitWidth),
        right: Math.max(isEncoderPopupOpen ? 300 : 132, halfUnitWidth),
        top: -Math.max(100, halfUnitHeight),
        bottom: Math.max(138, halfUnitHeight),
      }
    );
  };

  // Re-clamp against the visible canvas when its available space changes.
  useEffect(() => {
    const container = keymapMainRef.current;
    if (!container) return;

    const reclampMacropad = () => {
      setMacropadOffset((prev) => {
        const next = clampMacropadOffset(prev.x, prev.y);
        return next.x === prev.x && next.y === prev.y ? prev : next;
      });
    };
    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(reclampMacropad);

    resizeObserver?.observe(container);
    if (macropadMoveUnitRef.current) {
      resizeObserver?.observe(macropadMoveUnitRef.current);
    }
    window.addEventListener('resize', reclampMacropad);
    reclampMacropad();

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', reclampMacropad);
    };
  }, [
    mappingDrawerOpen,
    layerToolbarOpen,
    layerLightingOpen,
    selectedKey,
    activeNav,
  ]);

  // Close Profile dropdown & Layer toolbar when tapping on any blank area outside them
  useEffect(() => {
    const handleDocumentPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;

      if (
        profileMenuOpen &&
        profileContainerRef.current &&
        !profileContainerRef.current.contains(target)
      ) {
        setProfileMenuOpen(false);
        setDeletingProfileId(null);
      }

      if (
        layerToolbarOpen &&
        layersContainerRef.current &&
        !layersContainerRef.current.contains(target)
      ) {
        setLayerToolbarOpen(false);
        setLayerLightingOpen(false);
        setLayerDeleteConfirm(false);
      }
    };

    document.addEventListener('pointerdown', handleDocumentPointerDown);
    return () => {
      document.removeEventListener('pointerdown', handleDocumentPointerDown);
    };
  }, [profileMenuOpen, layerToolbarOpen]);

  // Keyboard recording listener for Action editing when Advance mode is OFF
  useEffect(() => {
    if (
      creatorModalTab !== 'Action' ||
      actionAdvanceMode ||
      actionRecordingStatus !== 'recording'
    ) {
      return;
    }

    const handleActionKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement as HTMLElement | null;
      if (
        activeEl &&
        (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')
      ) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      // Ignore key auto-repeat for modifier/lock keys
      if (
        e.repeat &&
        (e.key === 'Control' ||
          e.key === 'Shift' ||
          e.key === 'Alt' ||
          e.key === 'Meta' ||
          e.key === 'CapsLock' ||
          e.key === 'NumLock')
      ) {
        return;
      }

      // 1. Handle Backspace special rules:
      // - Double-tap Backspace -> deletes the whole thing
      // - Single letter + Backspace -> deletes everything
      // - Two or more letters + Backspace -> deletes the 1 letter just written
      // - Otherwise -> adds a "+" and "backspace" token
      if (e.key === 'Backspace') {
        const now = Date.now();
        const isDoubleTap = now - lastBackspaceTimeRef.current < 420;
        lastBackspaceTimeRef.current = now;

        setActionTokens((prev) => {
          const lastToken = prev[prev.length - 1];
          if (
            isDoubleTap ||
            (lastToken &&
              lastToken.kind === 'special' &&
              lastToken.label === 'backspace')
          ) {
            return [];
          }
          if (lastToken && lastToken.kind === 'text') {
            if (lastToken.label.length <= 1) {
              // Single letter + backspace -> delete everything
              return [];
            }
            // Two or more letters + backspace -> delete the one letter just written
            return [
              ...prev.slice(0, -1),
              {
                ...lastToken,
                label: lastToken.label.slice(0, -1),
              },
            ];
          }
          return [
            ...prev,
            {
              id: `tok-${now}-${Math.random()}`,
              label: 'backspace',
              kind: 'special',
            },
          ];
        });
        return;
      }

      lastBackspaceTimeRef.current = 0;

      // 2. Handle Modifiers (Green pills: ctrl, win, shift, alt)
      if (
        e.key === 'Control' ||
        e.key === 'Meta' ||
        e.key === 'Shift' ||
        e.key === 'Alt'
      ) {
        const modLabel =
          e.key === 'Control'
            ? 'ctrl'
            : e.key === 'Meta'
            ? 'win'
            : e.key === 'Shift'
            ? 'shift'
            : 'alt';

        setActionTokens((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.kind === 'modifier' && last.label === modLabel) {
            return prev;
          }
          return [
            ...prev,
            {
              id: `tok-${Date.now()}-${Math.random()}`,
              label: modLabel,
              kind: 'modifier',
            },
          ];
        });
        return;
      }

      // 3. Handle CapsLock & NumLock
      if (e.code === 'CapsLock' || e.key === 'CapsLock') {
        setActionTokens((prev) => [
          ...prev,
          {
            id: `tok-${Date.now()}-${Math.random()}`,
            label: 'caps lock',
            kind: 'special',
          },
        ]);
        return;
      }
      if (e.code === 'NumLock' || e.key === 'NumLock') {
        setActionTokens((prev) => [
          ...prev,
          {
            id: `tok-${Date.now()}-${Math.random()}`,
            label: 'num lock',
            kind: 'special',
          },
        ]);
        return;
      }

      // 4. Handle Numpad keys
      if (e.code.startsWith('Numpad') || e.location === 3) {
        const numpadMap: Record<string, string> = {
          Numpad0: 'num 0',
          Numpad1: 'num 1',
          Numpad2: 'num 2',
          Numpad3: 'num 3',
          Numpad4: 'num 4',
          Numpad5: 'num 5',
          Numpad6: 'num 6',
          Numpad7: 'num 7',
          Numpad8: 'num 8',
          Numpad9: 'num 9',
          NumpadAdd: 'num +',
          NumpadSubtract: 'num -',
          NumpadMultiply: 'num *',
          NumpadDivide: 'num /',
          NumpadDecimal: 'num .',
          NumpadEnter: 'num enter',
        };
        const npLabel =
          numpadMap[e.code] || `num ${e.key.toLowerCase()}`;
        setActionTokens((prev) => [
          ...prev,
          {
            id: `tok-${Date.now()}-${Math.random()}`,
            label: npLabel,
            kind: 'special',
          },
        ]);
        return;
      }

      // 5. Handle other non-character special keys
      if (e.key.length > 1) {
        const specialMap: Record<string, string> = {
          Enter: 'enter',
          Tab: 'tab',
          Escape: 'esc',
          Delete: 'delete',
          Insert: 'insert',
          Home: 'home',
          End: 'end',
          PageUp: 'page up',
          PageDown: 'page down',
          ArrowUp: 'up',
          ArrowDown: 'down',
          ArrowLeft: 'left',
          ArrowRight: 'right',
        };
        const spLabel = specialMap[e.key] || e.key.toLowerCase();
        setActionTokens((prev) => [
          ...prev,
          {
            id: `tok-${Date.now()}-${Math.random()}`,
            label: spLabel,
            kind: 'special',
          },
        ]);
        return;
      }

      // 6. Handle Space or printable characters (letters/words/digits/symbols)
      if (e.key === ' ') {
        setActionTokens((prev) => {
          const last = prev[prev.length - 1];
          // If typing words, combine into the current text token or add space
          if (last && last.kind === 'text') {
            return prev;
          }
          return [
            ...prev,
            {
              id: `tok-${Date.now()}-${Math.random()}`,
              label: 'space',
              kind: 'special',
            },
          ];
        });
        return;
      }

      const char = e.key;
      setActionTokens((prev) => {
        const last = prev[prev.length - 1];
        // Combine consecutive typed letters/words into a single purple pill,
        // unless preceded by a modifier or special key (e.g. ctrl + v, win + shift + s)
        if (last && last.kind === 'text') {
          const prevBeforeLast = prev[prev.length - 2];
          const isSingleKeyAfterModifier =
            last.label.length === 1 &&
            prevBeforeLast &&
            prevBeforeLast.kind === 'modifier' &&
            (e.ctrlKey || e.metaKey || e.altKey);
          if (!isSingleKeyAfterModifier) {
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                label: last.label + char,
              },
            ];
          }
        }
        return [
          ...prev,
          {
            id: `tok-${Date.now()}-${Math.random()}`,
            label: char,
            kind: 'text',
          },
        ];
      });
    };

    window.addEventListener('keydown', handleActionKeyDown);
    return () => {
      window.removeEventListener('keydown', handleActionKeyDown);
    };
  }, [creatorModalTab, actionAdvanceMode, actionRecordingStatus]);

  useEffect(() => {
    const handleWindowPointerMove = (e: PointerEvent) => {
      // 1. Handle keycap tile drag with subtle corner-held circular swing
      const session = dragSessionRef.current;
      if (session) {
        const dist = Math.hypot(
          e.clientX - session.startX,
          e.clientY - session.startY
        );
        if (!session.isDragging && dist >= 4) {
          session.isDragging = true;
          suppressNextClickRef.current = true;
          dragRawRotate.jump(0);
          dragRawBobY.jump(0);
          dragSpringRotate.jump(0);
          dragSpringBobY.jump(0);
        }
        if (session.isDragging) {
          const vx = e.clientX - session.lastX;
          session.lastX = e.clientX;
          session.lastY = e.clientY;

          // Subtle circular motion as if held at the corner when dragging left/right
          const clampedVx = Math.max(-14, Math.min(14, vx));
          const subtleRotate = clampedVx * 0.45; // max ±6.3 deg
          const subtleArcY = -Math.abs(clampedVx) * 0.16; // gentle 0..2.2px circular lift

          dragRawRotate.set(subtleRotate);
          dragRawBobY.set(subtleArcY);

          if (dragTiltDecayTimeoutRef.current) {
            window.clearTimeout(dragTiltDecayTimeoutRef.current);
          }
          dragTiltDecayTimeoutRef.current = window.setTimeout(() => {
            dragRawRotate.set(0);
            dragRawBobY.set(0);
          }, 55);

          setDraggedTile({
            item: session.item,
            sourceTab: session.sourceTab,
            fromSlotId: session.fromSlotId,
            fromSubAction: session.fromSubAction,
            x: e.clientX,
            y: e.clientY,
          });
          const el = document.elementFromPoint(e.clientX, e.clientY);
          const subEl = el?.closest(
            '[data-drop-encoder-sub]'
          ) as HTMLElement | null;
          if (subEl) {
            const slotId = subEl.getAttribute(
              'data-drop-slot'
            ) as KeySlotId | null;
            const subAction = subEl.getAttribute(
              'data-drop-encoder-sub'
            ) as EncoderSubActionId | null;
            if (slotId && subAction) {
              setDragOverTarget({ slotId, subAction });
              return;
            }
          }
          const slotEl = el?.closest('[data-drop-slot]') as HTMLElement | null;
          if (slotEl) {
            const slotId = slotEl.getAttribute(
              'data-drop-slot'
            ) as KeySlotId | null;
            if (slotId) {
              setDragOverTarget({ slotId });
              return;
            }
          }
          setDragOverTarget(null);
        }
        return;
      }

      // 2. Handle dragging/reordering an Advance Mode "Assign Key" capsule via the 6-dot handle
      const advDrag = advStepDragRef.current;
      if (advDrag) {
        const dy = e.clientY - advDrag.startY;
        const swapThreshold = 54;
        if (Math.abs(dy) >= swapThreshold) {
          const dir = dy > 0 ? 1 : -1;
          let didSwap = false;
          setActionAdvanceSteps((prev) => {
            const idx = prev.findIndex((s) => s.id === advDrag.id);
            const targetIdx = idx + dir;
            if (idx === -1 || targetIdx < 0 || targetIdx >= prev.length) {
              return prev;
            }
            didSwap = true;
            const next = [...prev];
            const [moved] = next.splice(idx, 1);
            next.splice(targetIdx, 0, moved);
            return next;
          });
          if (didSwap) {
            advDrag.startY += dir * swapThreshold;
          }
        }
        setDraggingAdvStep({
          id: advDrag.id,
          offsetY: e.clientY - advDrag.startY,
        });
        return;
      }

      // 3. Handle moving the Macropad + "Edit layout" unit in the blank area
      const padDrag = macropadDragRef.current;
      if (padDrag) {
        const dx = e.clientX - padDrag.startX;
        const dy = e.clientY - padDrag.startY;
        if (!padDrag.isMoving && Math.hypot(dx, dy) >= 4) {
          padDrag.isMoving = true;
          suppressNextClickRef.current = true;
          setIsDraggingMacropad(true);
        }
        if (padDrag.isMoving) {
          const nextClamped = clampMacropadOffset(
            padDrag.initialOffsetX + dx,
            padDrag.initialOffsetY + dy
          );
          setMacropadOffset(nextClamped);
        }
      }
    };

    const handleWindowPointerUp = (e: PointerEvent) => {
      if (advStepDragRef.current) {
        advStepDragRef.current = null;
        setDraggingAdvStep(null);
      }

      if (macropadDragRef.current) {
        if (macropadDragRef.current.isMoving) {
          setTimeout(() => {
            suppressNextClickRef.current = false;
          }, 40);
        }
        macropadDragRef.current = null;
        setIsDraggingMacropad(false);
      }

      const session = dragSessionRef.current;
      if (!session) return;
      if (dragTiltDecayTimeoutRef.current) {
        window.clearTimeout(dragTiltDecayTimeoutRef.current);
      }
      if (session.isDragging) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const subEl = el?.closest('[data-drop-encoder-sub]') as HTMLElement | null;
        if (subEl) {
          const slotId = subEl.getAttribute('data-drop-slot') as KeySlotId | null;
          const subAction = subEl.getAttribute(
            'data-drop-encoder-sub'
          ) as EncoderSubActionId | null;
          if (slotId && subAction) {
            if (session.fromSlotId) {
              swapMacropadSlots(
                session.fromSlotId,
                slotId,
                session.fromSubAction,
                subAction
              );
            } else {
              assignItemToSlot(
                session.item,
                slotId,
                subAction,
                session.sourceTab
              );
            }
          }
        } else {
          const slotEl = el?.closest('[data-drop-slot]') as HTMLElement | null;
          if (slotEl) {
            const slotId = slotEl.getAttribute('data-drop-slot') as KeySlotId | null;
            if (slotId) {
              if (session.fromSlotId) {
                swapMacropadSlots(
                  session.fromSlotId,
                  slotId,
                  session.fromSubAction,
                  undefined
                );
              } else {
                assignItemToSlot(
                  session.item,
                  slotId,
                  undefined,
                  session.sourceTab
                );
              }
            }
          }
        }
        setTimeout(() => {
          suppressNextClickRef.current = false;
        }, 40);
      }
      dragSessionRef.current = null;
      setDraggedTile(null);
      setDragOverTarget(null);
    };

    window.addEventListener('pointermove', handleWindowPointerMove);
    window.addEventListener('pointerup', handleWindowPointerUp);
    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
    };
  });

  const handleStartTileDrag = (
    e: React.PointerEvent,
    item: BasicTileItem,
    sourceTab: MappingTabId = mappingTab
  ) => {
    if (e.button !== 0) return;
    dragSessionRef.current = {
      item,
      sourceTab,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      isDragging: false,
    };
  };

  const handleStartMacropadMove = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Only move the macropad when holding the black outer part (not any key or encoder button)
    if ((e.target as HTMLElement).closest('button')) return;
    if (dragSessionRef.current) return;
    macropadDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initialOffsetX: macropadOffset.x,
      initialOffsetY: macropadOffset.y,
      isMoving: false,
    };
  };

  const handleResetMacropadCenter = (e: React.MouseEvent) => {
    // Double-clicking on the black outer part returns the macropad to the center
    if ((e.target as HTMLElement).closest('button')) return;
    setMacropadOffset(clampMacropadOffset(0, 0));
  };

  const handleStartMacropadKeyDrag = (
    e: React.PointerEvent,
    slotId: KeySlotId,
    subAction?: EncoderSubActionId
  ) => {
    if (e.button !== 0) return;
    // Drag encoder bindings from their CW / Press / CCW capsule, not the knob body.
    if (slotId === GRID_MACRO_ENCODER_SLOT && !subAction) return;

    const assignment = currentLayer[slotId];
    if (
      !subAction &&
      !assignment?.iconId &&
      (!assignment?.label ||
        assignment.label === '—' ||
        assignment.binding === 'blank')
    ) {
      return;
    }

    let displayLabel = assignment?.label || slotId.toUpperCase();
    let displayBinding = assignment?.binding || displayLabel;
    let displayExecution = assignment?.execution;

    if (subAction && slotId === GRID_MACRO_ENCODER_SLOT) {
      const actions = getEncoderActions(assignment);
      const subEntry = actions[subAction];
      if (!subEntry || subEntry.label === '—' || subEntry.binding === 'blank') {
        return;
      }
      displayLabel = subEntry.label || subAction.toUpperCase();
      displayBinding = subEntry.binding || displayLabel;
      displayExecution = subEntry.execution;
    }

    const previewItem: BasicTileItem = {
      id: `macropad-drag-${slotId}-${subAction || 'main'}`,
      main: displayLabel,
      macropadLabel: displayLabel,
      listLabel: displayBinding,
      iconId: subAction ? undefined : assignment?.iconId,
      execution: displayExecution,
    };

    dragSessionRef.current = {
      item: previewItem,
      sourceTab: 'Basic',
      fromSlotId: slotId,
      fromSubAction: subAction,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      isDragging: false,
    };
  };

  const runSimulationAction = (
    assignment: SimulationAction & { actionId?: string },
    gesture?: MultiGestureKey
  ) => {
    triggerSimulationAction(
      { ...assignment, id: assignment.actionId || assignment.id, gesture },
      (targetLayer) => {
        if (targetLayer >= currentProfile.layers.length) {
          showToast(`Layer ${targetLayer + 1} is not available on this profile`);
          return false;
        }
        setActiveLayerIndex(targetLayer);
        setSelectedKey(null);
        setSelectedEncoderSub(null);
        setMappingDrawerOpen(false);
      },
      showToast,
      window
    );
  };

  const handleSelectKey = (slotId: KeySlotId) => {
    if (suppressNextClickRef.current) return;
    if (simulationMode) {
      if (slotId === GRID_MACRO_ENCODER_SLOT) {
        setEncoderAngle((angle) => (angle + 30) % 360);
        runSimulationAction(getEncoderActions(currentLayer[slotId]).cw);
      } else {
        runSimulationAction(currentLayer[slotId]);
      }
      return;
    }
    if (slotId === GRID_MACRO_ENCODER_SLOT) {
      setEncoderAngle((angle) => (angle + 45) % 360);
      if (selectedKey === slotId && !selectedEncoderSub) {
        setSelectedKey(null);
      } else {
        setSelectedKey(slotId);
        setSelectedEncoderSub(null);
      }
      return;
    }
    if (selectedDrawerTile && !selectedKey) {
      assignItemToSlot(
        selectedDrawerTile.item,
        slotId,
        undefined,
        selectedDrawerTile.sourceTab
      );
      setSelectedDrawerTile(null);
      return;
    }
    setSelectedKey(slotId);
    setSelectedEncoderSub(null);
    setMappingDrawerOpen(true);
    setMappingStackExpanded(false);
    setHoveredMappingType(null);
  };

  const handleSelectEncoderSubAction = (
    slotId: typeof GRID_MACRO_ENCODER_SLOT,
    subAction: EncoderSubActionId
  ) => {
    if (suppressNextClickRef.current) return;
    if (simulationMode) {
      if (subAction === 'cw') setEncoderAngle((angle) => (angle + 30) % 360);
      if (subAction === 'ccw') setEncoderAngle((angle) => (angle - 30 + 360) % 360);
      runSimulationAction(getEncoderActions(currentLayer[slotId])[subAction]);
      return;
    }
    if (selectedDrawerTile) {
      assignItemToSlot(
        selectedDrawerTile.item,
        slotId,
        subAction,
        selectedDrawerTile.sourceTab
      );
      setSelectedDrawerTile(null);
      return;
    }
    setSelectedKey(slotId);
    setSelectedEncoderSub(subAction);
    setMappingDrawerOpen(true);
    setMappingStackExpanded(false);
    setHoveredMappingType(null);
  };

  const handleOpenDrawerWithTab = (tab: MappingTabId) => {
    setMappingTab(tab);
    setMappingDrawerOpen(true);
    setMappingStackExpanded(false);
    setHoveredMappingType(null);
  };

  const triggerTileFlash = (tileId: string) => {
    if (flashTimeoutRef.current) {
      window.clearTimeout(flashTimeoutRef.current);
    }
    setFlashedTileId(tileId);
    flashTimeoutRef.current = window.setTimeout(() => {
      setFlashedTileId((prev) => (prev === tileId ? null : prev));
    }, 240);
  };

  const handleAssignTileFromDrawer = (item: BasicTileItem) => {
    if (suppressNextClickRef.current) return;
    triggerTileFlash(item.id);
    setSelectedDrawerTile((prev) =>
      prev?.item.id === item.id ? null : { item, sourceTab: mappingTab }
    );
    if (
      selectedKey &&
      (selectedKey !== GRID_MACRO_ENCODER_SLOT || selectedEncoderSub)
    ) {
      assignItemToSlot(
        item,
        selectedKey,
        selectedEncoderSub || undefined,
        mappingTab
      );
    }
  };

  const toggleListSection = (title: string) => {
    setExpandedListSections((prev) => ({
      ...prev,
      [title]: !prev[title],
    }));
  };

  const handleOpenCreatorEditor = (
    tab: Exclude<MappingTabId, 'Basic'>,
    existingItem?: BasicTileItem
  ) => {
    setCreatorModalTab(tab);
    setIconPickerOpen(false);
    setIconPickerSearch('');
    setActiveGestureDropdown(null);
    setActiveAdvanceStepDropdown(null);
    setGestureKeySearch('');
    setExpandedGestureSection(null);
    setSmartAppDropdownOpen(false);
    setSelectedSmartApplication(null);
    setCustomItemDeleteConfirm(false);

    if (existingItem) {
      setEditingCustomItemId(existingItem.id);
      setNewCustomName(existingItem.main);
      setSelectedIconId(existingItem.iconId);
      setSelectedEmoji(existingItem.emoji);
      setNewCustomBinding(existingItem.listLabel || '');

      if (tab === 'Action') {
        const execution = existingItem.execution;
        const rawSeq = existingItem.listLabel || '';
        const match = rawSeq.match(/\((.+)\)$/);
        const displaySequence = match ? match[1] : '';
        if (
          execution?.kind === 'sequence' &&
          execution.steps.length > 0 &&
          execution.steps.every((step) => step.kind === 'key')
        ) {
          const sequenceSteps = execution.steps as Extract<DesktopExecutionStep, { kind: 'key' }>[];
          setActionAdvanceMode(true);
          setActionTokens([]);
          setActionRecordingStatus('idle');
          setActionAdvanceSteps(sequenceSteps.map((step, index) => ({
            id: `adv-edit-${index}-${Date.now()}`,
            keyLabel: step.key,
            mode: step.mode === 'press' ? 'press' : 'press-release',
            delayAfterActive: Number(step.delayAfterMs || 0) > 0,
            delayAfterMs: String(step.delayAfterMs ?? '200'),
          })));
        } else {
          const shortcut = execution?.kind === 'shortcut'
            ? execution.value
            : displaySequence;
          const parts = shortcut.split(' + ').map((part) => part.trim()).filter(Boolean);
          setActionAdvanceMode(false);
          setActionAdvanceSteps([{
            id: 'adv-edit-1',
            keyLabel: '',
            mode: 'press-release',
            delayAfterActive: false,
            delayAfterMs: '200',
          }]);
          setActionTokens(
            parts.map((lbl, idx) => ({
              id: `tok-init-${idx}`,
              label: lbl,
              kind: ['ctrl', 'control', 'win', 'windows', 'shift', 'alt', 'cmd', 'option'].includes(
                lbl.toLowerCase()
              )
                ? 'modifier'
                : 'text',
            }))
          );
          setActionRecordingStatus(parts.length > 0 ? 'confirmed' : 'idle');
        }
      } else if (tab === 'Multi-A') {
        const execution = existingItem.execution;
        const rawSummary = existingItem.listLabel || '';
        const gestureSummary = rawSummary.match(/\((.*)\)$/)?.[1] || '';
        const fromDisplay = (key: MultiGestureKey) => {
          const match = gestureSummary.match(new RegExp(`(?:^|,\\s*)${key}:\\s*([^,]*)`, 'i'));
          return match?.[1]?.trim() || '';
        };
        setMultiGestures(execution?.kind === 'multi'
          ? {
              onTap: execution.gestures.onTap || '',
              doubleTap: execution.gestures.doubleTap || '',
              onHold: execution.gestures.onHold || '',
              tapHold: execution.gestures.tapHold || '',
            }
          : {
              onTap: fromDisplay('onTap'),
              doubleTap: fromDisplay('doubleTap'),
              onHold: fromDisplay('onHold'),
              tapHold: fromDisplay('tapHold'),
            });
        setTappingTermMs(String(execution?.kind === 'multi' ? execution.tappingTermMs ?? 250 : 250));
      } else if (tab === 'Smart-A') {
        const execution = existingItem.execution;
        const displaySmart = (existingItem.listLabel || '').match(/\((Text|Cmd|Web|App):\s*([\s\S]*)\)$/i);
        const actionType = execution?.kind === 'smart'
          ? execution.actionType
          : displaySmart?.[1] as SmartActionSubTab | undefined;
        const value = execution?.kind === 'smart'
          ? execution.value
          : displaySmart?.[2]?.trim() || (execution?.kind === 'text' ? execution.value : '');
        const safeTab: SmartActionSubTab = actionType || 'Text';
        setSmartSubTab(safeTab);
        setSmartTextValue(safeTab === 'Text' ? value : '');
        setSmartCmdValue(safeTab === 'Cmd' ? value : '');
        setSmartWebValue(safeTab === 'Web' ? value : '');
        setSmartAppValue(safeTab === 'App' ? value : '');
        if (safeTab === 'App' && execution?.kind === 'smart' && execution.applicationShortcutPath) {
          setSelectedSmartApplication({
            name: value,
            shortcutPath: execution.applicationShortcutPath,
          });
        }
      }
    } else {
      setEditingCustomItemId(null);
      setSelectedIconId(undefined);
      setSelectedEmoji(undefined);
      if (tab === 'Multi-A') {
        setNewCustomName('My Multiaction');
        setMultiGestures({
          onTap: '',
          doubleTap: '',
          onHold: '',
          tapHold: '',
        });
        setTappingTermMs('250');
      } else if (tab === 'Smart-A') {
        setNewCustomName('My Smart action');
        setSmartSubTab('Text');
        setSmartTextValue('');
        setSmartCmdValue('');
        setSmartWebValue('');
        setSmartAppValue('');
      } else {
        setNewCustomName('My Action');
        setNewCustomBinding('');
        setActionAdvanceMode(false);
        setActionRecordingStatus('idle');
        setActionTokens([]);
        setActionAdvanceSteps([
          {
            id: 'adv-step-1',
            keyLabel: '',
            mode: 'press-release',
            delayAfterActive: false,
            delayAfterMs: '200',
          },
        ]);
      }
    }
  };

  const handleSaveCustomItem = () => {
    if (!creatorModalTab) return;
    if (creatorModalTab === 'Action') {
      const hasAssignedKeys = actionAdvanceMode
        ? actionAdvanceSteps.some((s) => !!s.keyLabel.trim())
        : actionTokens.length > 0;
      if (!hasAssignedKeys) return;
    } else if (creatorModalTab === 'Multi-A') {
      const hasGesture = Object.values(multiGestures).some((v) => !!v.trim());
      if (!hasGesture) return;
    } else if (creatorModalTab === 'Smart-A') {
      if (smartSubTab === 'App') {
        if (!selectedSmartApplication) return;
      } else {
        const val = smartSubTab === 'Text'
          ? smartTextValue
          : smartSubTab === 'Cmd'
            ? smartCmdValue
            : smartWebValue;
        if (!val.trim()) return;
      }
    }

    const defaultName =
      creatorModalTab === 'Multi-A'
        ? 'My Multiaction'
        : creatorModalTab === 'Smart-A'
        ? 'My Smart action'
        : 'My Action';
    const finalName = newCustomName.trim() || defaultName;

    let summaryBinding = finalName;
    let execution: DesktopExecutionDefinition | undefined;
    if (creatorModalTab === 'Multi-A') {
      const parts = Object.entries(multiGestures)
        .filter(([, value]) => value.trim())
        .map(([gesture, value]) => `${gesture}: ${value.trim()}`);
      summaryBinding = parts.length > 0 ? `${finalName} (${parts.join(', ')})` : finalName;
      execution = {
        kind: 'multi',
        gestures: Object.fromEntries(
          Object.entries(multiGestures)
            .filter(([, value]) => value.trim())
            .map(([gesture, value]) => [gesture, value.trim()])
        ) as Partial<Record<MultiGestureKey, string>>,
        tappingTermMs: Math.max(0, Number.parseInt(tappingTermMs, 10) || 250),
      };
    } else if (creatorModalTab === 'Smart-A') {
      const val = smartSubTab === 'App'
        ? selectedSmartApplication?.name || ''
        : smartSubTab === 'Text'
          ? smartTextValue
          : smartSubTab === 'Cmd'
            ? smartCmdValue
            : smartWebValue;
      summaryBinding = val.trim()
        ? `${finalName} (${smartSubTab}: ${val.trim()})`
        : finalName;
      execution = {
        kind: 'smart',
        actionType: smartSubTab,
        value: val.trim(),
        ...(smartSubTab === 'App' && selectedSmartApplication
          ? { applicationShortcutPath: selectedSmartApplication.shortcutPath }
          : {}),
      };
    } else if (creatorModalTab === 'Action') {
      if (actionAdvanceMode) {
        const advParts: string[] = [];
        const steps: DesktopExecutionStep[] = [];
        actionAdvanceSteps.forEach((step, index) => {
          const key = step.keyLabel.trim();
          if (!key) return;
          advParts.push(key);
          const hasDelay =
            index < actionAdvanceSteps.length - 1 &&
            step.delayAfterActive &&
            Boolean(step.delayAfterMs?.trim());
          if (hasDelay) advParts.push(`${step.delayAfterMs!.trim()}ms`);
          steps.push({
            kind: 'key',
            key,
            mode: step.mode,
            ...(hasDelay ? { delayAfterMs: Number.parseInt(step.delayAfterMs!, 10) } : {}),
          });
        });
        summaryBinding = advParts.length > 0 ? `${finalName} (${advParts.join(' + ')})` : finalName;
        if (steps.length > 0) execution = { kind: 'sequence', steps };
      } else if (actionTokens.length > 0) {
        const tokenCombo = actionTokens.map((token) => token.label).join(' + ');
        summaryBinding = `${finalName} (${tokenCombo})`;
        execution = { kind: 'shortcut', value: tokenCombo };
      } else if (newCustomBinding.trim()) {
        summaryBinding = `${finalName} (${newCustomBinding.trim()})`;
        execution = { kind: 'shortcut', value: newCustomBinding.trim() };
      }
    }

    const created: BasicTileItem = {
      id: editingCustomItemId || `custom-${Date.now()}`,
      main: finalName,
      listLabel: summaryBinding,
      macropadLabel: selectedEmoji ? selectedEmoji : finalName,
      iconId: selectedIconId,
      emoji: selectedEmoji,
      execution,
    };

    setCustomItemsByTab((prev) => {
      const list = prev[creatorModalTab];
      const exists = list.some((i) => i.id === created.id);
      return {
        ...prev,
        [creatorModalTab]: exists
          ? list.map((i) => (i.id === created.id ? created : i))
          : [...list, created],
      };
    });

    setIconPickerOpen(false);
    setActiveGestureDropdown(null);
    setActiveAdvanceStepDropdown(null);
    setCreatorModalTab(null);
    showToast(`Saved "${finalName}"`);
  };

  const handleDiscardCustomItem = () => {
    if (!creatorModalTab) return;
    handleOpenCreatorEditor(creatorModalTab);
    showToast('Discarded unsaved changes');
  };

  const handleDeleteCustomItem = () => {
    if (!creatorModalTab) return;
    if (editingCustomItemId) {
      setCustomItemsByTab((prev) => ({
        ...prev,
        [creatorModalTab]: prev[creatorModalTab].filter(
          (i) => i.id !== editingCustomItemId
        ),
      }));
      showToast('Deleted item');
    }
    setCustomItemDeleteConfirm(false);
    setIconPickerOpen(false);
    setActiveGestureDropdown(null);
    setCreatorModalTab(null);
  };

  const handleInstallPreset = (preset: PresetItem) => {
    if (isPresetInstalledInProfile(currentProfile, preset.id)) {
      showToast(`${preset.title} is already installed in this profile.`);
      return;
    }
    if (currentProfile.layers.length >= MAX_LAYER_COUNT) {
      showToast(`A profile can have up to ${MAX_LAYER_COUNT} layers. Remove one first.`);
      return;
    }

    const clonedLayer: LayerKeymap = JSON.parse(
      JSON.stringify({
        ...preset.layerKeymap,
        presetId: preset.id,
      })
    );
    const nextLayerIndex = currentProfile.layers.length;
    const nextProfiles = profiles.map((profile, index) => {
      if (index !== activeProfileIndex) return profile;
      return { ...profile, layers: [...profile.layers, clonedLayer] };
    });
    const mergePresetItems = (existing: BasicTileItem[], incoming: BasicTileItem[]) => [
      ...existing.filter((item) => !incoming.some((nextItem) => nextItem.id === item.id)),
      ...incoming,
    ];

    setCustomItemsByTab((current) => ({
      Action: mergePresetItems(current.Action, preset.actionItems.Action),
      'Multi-A': mergePresetItems(current['Multi-A'], preset.actionItems['Multi-A']),
      'Smart-A': mergePresetItems(current['Smart-A'], preset.actionItems['Smart-A']),
    }));
    pushState(nextProfiles);
    setActiveLayerIndex(nextLayerIndex);
    setPreviewPreset(null);
    setActiveNav('Keymap');
    const savedActionCount = preset.actionItems.Action.length + preset.actionItems['Multi-A'].length;
    showToast(
      `Installed ${preset.title} preset on Layer ${nextLayerIndex + 1}${
        savedActionCount ? ` and saved ${savedActionCount} actions` : ''
      }`
    );
  };

  const renderCustomItemGroups = (
    tab: Exclude<MappingTabId, 'Basic'>,
    items: BasicTileItem[],
    customGroupTitle: string
  ) => (
    <div className="flex-1 overflow-y-auto pt-[2px] pb-[3px]">
      <div className="text-[11.5px] font-normal text-[#5c5c5c] mb-[10px]">
        {customGroupTitle}
      </div>
      <div className="space-y-[16px]">
        {groupCustomItemsByPreset(items, customGroupTitle).map((group) => (
          <section
            key={group.id}
            data-action-group={group.presetId ?? 'custom'}
            data-preset-action-group={group.presetId}
          >
            {group.presetId && (
              <div className="h-[20px] flex items-center gap-[7px] mb-[9px]">
                <PresetAppIcon id={group.presetId} size={18} />
                <span
                  className="text-[11.5px] font-medium leading-none"
                  style={{ color: group.presetColor }}
                >
                  {group.title}
                </span>
                {group.presetColor && (
                  <span
                    aria-hidden="true"
                    className="flex-1 h-px rounded-full"
                    style={{
                      background: `linear-gradient(90deg, ${group.presetColor}66, transparent)`,
                    }}
                  />
                )}
              </div>
            )}
            <div
              data-action-view={mappingViewMode}
              className={
                mappingViewMode === 'grid'
                  ? 'grid grid-cols-5 gap-[6px] content-start'
                  : 'flex flex-col gap-[6px]'
              }
            >
              {group.items.map((item) => {
                const isBeingDragged = draggedTile?.item.id === item.id;
                const isFlashed = flashedTileId === item.id;
                const presetTileStyle = group.presetColor && !isFlashed && !isBeingDragged
                  ? {
                      borderColor: `${group.presetColor}55`,
                      backgroundColor: `${group.presetColor}0D`,
                    }
                  : undefined;
                const presetIconStyle = group.presetColor
                  ? {
                      color: group.presetColor,
                      backgroundColor: `${group.presetColor}1A`,
                    }
                  : undefined;
                const listIconStyle = group.presetColor
                  ? presetIconStyle
                  : { color: '#666666', backgroundColor: '#f1f1f1' };
                const listDescription = item.listLabel || item.top || item.macropadLabel;
                const layoutClasses = mappingViewMode === 'grid'
                  ? 'h-[54px] rounded-[10px] flex-col justify-center px-1 text-center'
                  : 'w-full min-h-[48px] rounded-[10px] flex-row justify-start gap-[10px] px-[9px] text-left';

                return (
                  <button
                    key={item.id}
                    data-preset-action-item={group.presetId ? item.id : undefined}
                    data-action-list-item={mappingViewMode === 'list' ? item.id : undefined}
                    onPointerDown={(e) => handleStartTileDrag(e, item, tab)}
                    onClick={() => handleAssignTileFromDrawer(item)}
                    onDoubleClick={() => handleOpenCreatorEditor(tab, item)}
                    title={`${item.main} (Click or drag onto key, double-click to edit)`}
                    style={presetTileStyle}
                    className={`border-[1.5px] flex items-center shadow-[0_1px_2px_rgba(0,0,0,0.03)] select-none cursor-grab active:cursor-grabbing ${layoutClasses} ${
                      isFlashed
                        ? 'bg-[#000000] text-white border-[#000000] transition-colors duration-75'
                        : isBeingDragged
                          ? 'bg-[#e8e8e8] text-[#a8a8a8] border-transparent transition-colors duration-200'
                          : 'bg-white hover:bg-[#fafafa] text-[#444444] border-transparent hover:border-[#0051ff] transition-colors duration-500 ease-out'
                    }`}
                  >
                    {mappingViewMode === 'grid' ? (
                      item.iconId ? (
                        <span
                          data-preset-action-icon={group.presetId ?? undefined}
                          className="w-[30px] h-[30px] rounded-[8px] flex items-center justify-center"
                          style={presetIconStyle}
                        >
                          <CustomPickerIcon id={item.iconId} size={20} />
                        </span>
                      ) : item.emoji ? (
                        <span
                          className="text-[20px] leading-none"
                          style={group.presetColor ? { color: group.presetColor } : undefined}
                        >
                          {item.emoji}
                        </span>
                      ) : (
                        <span
                          className="text-[10px] leading-[1.2] whitespace-pre-line"
                          style={group.presetColor ? { color: group.presetColor } : undefined}
                        >
                          {formatCustomTileText(item.main)}
                        </span>
                      )
                    ) : (
                      <>
                        <span
                          className="w-[34px] h-[34px] rounded-[9px] flex items-center justify-center shrink-0"
                          style={listIconStyle}
                        >
                          {item.iconId ? (
                            <span
                              data-preset-action-icon={group.presetId ?? undefined}
                              className="w-[30px] h-[30px] rounded-[8px] flex items-center justify-center"
                              style={presetIconStyle}
                            >
                              <CustomPickerIcon id={item.iconId} size={20} />
                            </span>
                          ) : item.emoji ? (
                            <span className="text-[20px] leading-none">{item.emoji}</span>
                          ) : (
                            <span className="text-[10px] leading-[1.2] whitespace-pre-line">
                              {formatCustomTileText(item.main)}
                            </span>
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span
                            className="block truncate text-[11px] font-medium"
                            style={group.presetColor ? { color: group.presetColor } : undefined}
                          >
                            {item.main}
                          </span>
                          {listDescription && listDescription !== item.main && (
                            <span className="block truncate text-[9.5px] leading-[1.3] text-[#888888]">
                              {listDescription}
                            </span>
                          )}
                        </span>
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );

  const handleDuplicateProfile = (idx: number) => {
    if (profiles.length >= MAX_PROFILE_COUNT) {
      showToast(`A browser can store up to ${MAX_PROFILE_COUNT} profiles. Delete one first.`);
      return;
    }
    const source = profiles[idx];
    if (!source) return;
    const duplicated: ProfileData = {
      id: `prof-${Date.now()}`,
      name: `${source.name} Copy`,
      color: source.color,
      layers: JSON.parse(JSON.stringify(source.layers)),
    };
    const next = [...profiles, duplicated];
    pushState(next);
    setActiveProfileIndex(next.length - 1);
    setActiveLayerIndex(0);
    showToast(`Duplicated "${source.name}"`);
  };

  const handleExportProfile = (idx: number) => {
    const source = profiles[idx];
    if (!source) return;
    if (!profileFileTools) {
      showToast('Profile export tools are unavailable');
      return;
    }

    const result = profileFileTools.download(source, customItemsByTab);
    if (!result.ok) {
      showToast(`Profile export failed: ${result.error || 'unknown error'}`);
      return;
    }
    showToast(`Exported "${source.name || 'Untitled Profile'}"`);
  };

  const handleAddProfile = () => {
    if (profiles.length >= MAX_PROFILE_COUNT) {
      showToast(`A browser can store up to ${MAX_PROFILE_COUNT} profiles. Delete one first.`);
      return;
    }
    const nextProf: ProfileData = {
      id: `prof-${Date.now()}`,
      name: '',
      color: '#0051ff',
      layers: [JSON.parse(JSON.stringify(INITIAL_LAYER_1))],
    };
    const next = [...profiles, nextProf];
    pushState(next);
    setActiveProfileIndex(next.length - 1);
    setActiveLayerIndex(0);
    setDeletingProfileId(null);
  };

  const handleUpdateProfileName = (profileIndex: number, newName: string) => {
    const next = profiles.map((profile, idx) =>
      idx === profileIndex ? { ...profile, name: newName } : profile
    );
    setProfiles(next);
  };

  const handleConfirmDeleteProfile = (idx: number) => {
    if (profiles.length <= 1) {
      const resetProf: ProfileData = {
        id: `prof-${Date.now()}`,
        name: 'Default Profile',
        color: '#0051ff',
        layers: [JSON.parse(JSON.stringify(INITIAL_LAYER_1))],
      };
      pushState([resetProf]);
      setActiveProfileIndex(0);
      setActiveLayerIndex(0);
      setDeletingProfileId(null);
      return;
    }
    const next = profiles.filter((_, i) => i !== idx);
    pushState(next);
    setActiveProfileIndex((prev) =>
      prev >= next.length ? Math.max(0, next.length - 1) : prev
    );
    setActiveLayerIndex(0);
    setDeletingProfileId(null);
  };

  const hueToHex = (h: number): string => {
    const s = 1;
    const l = 0.5;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0;
    let g = 0;
    let b = 0;
    if (h >= 0 && h < 60) {
      r = c;
      g = x;
      b = 0;
    } else if (h >= 60 && h < 120) {
      r = x;
      g = c;
      b = 0;
    } else if (h >= 120 && h < 180) {
      r = 0;
      g = c;
      b = x;
    } else if (h >= 180 && h < 240) {
      r = 0;
      g = x;
      b = c;
    } else if (h >= 240 && h < 300) {
      r = x;
      g = 0;
      b = c;
    } else {
      r = c;
      g = 0;
      b = x;
    }
    const toHex = (n: number) =>
      Math.round((n + m) * 255)
        .toString(16)
        .padStart(2, '0')
        .toUpperCase();
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  };

  const handleImportProfile = async () => {
    if (!profileFileTools) {
      showToast('Profile import tools are unavailable');
      return;
    }

    try {
      const imported = await profileFileTools.pickFile();
      if (!imported) return;

      const merged = profileFileTools.merge(
        {
          profiles: profiles as unknown as Record<string, unknown>[],
          activeProfileIndex,
          customItems: customItemsByTab as unknown as Record<
            'Action' | 'Multi-A' | 'Smart-A',
            Record<string, unknown>[]
          >,
        },
        imported
      );
      pushState(
        (merged.profiles as unknown as ProfileData[]).map(normalizeProfileForEditor)
      );
      setCustomItemsByTab(
        normalizeCustomItemsForEditor(
          merged.customItems as unknown as CustomItemsByTab
        )
      );
      setActiveProfileIndex(merged.activeProfileIndex);
      setActiveLayerIndex(0);
      setProfileMenuOpen(false);
      setDeletingProfileId(null);
      showToast(
        `Imported ${imported.profiles.length} profile${
          imported.profiles.length === 1 ? '' : 's'
        } into this browser`
      );
    } catch (error) {
      showToast(
        `Profile import failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  };

  const filteredPresets = useMemo(
    () => buildPresetLibrary(presetOs).filter(
      (preset) =>
        preset.title.toLowerCase().includes(presetSearch.toLowerCase()) ||
        preset.description.toLowerCase().includes(presetSearch.toLowerCase())
    ),
    [presetOs, presetSearch]
  );
  const previewPresetDetails = previewPreset
    ? PRESET_CATALOG.find((preset) => preset.id === previewPreset.id)
    : undefined;
  const isPreviewPresetInstalled = previewPreset
    ? isPresetInstalledInProfile(currentProfile, previewPreset.id)
    : false;

  const filteredBasicSections = BASIC_KEY_SECTIONS.map((sec) => ({
    ...sec,
    items: sec.items.filter(
      (item) =>
        !mappingSearch.trim() ||
        item.main.toLowerCase().includes(mappingSearch.toLowerCase()) ||
        (item.listLabel &&
          item.listLabel.toLowerCase().includes(mappingSearch.toLowerCase())) ||
        (item.top && item.top.toLowerCase().includes(mappingSearch.toLowerCase())) ||
        sec.title.toLowerCase().includes(mappingSearch.toLowerCase())
    ),
  })).filter((sec) => sec.items.length > 0);

  return (
    <div className="app-shell h-screen w-full bg-[#efefef] flex flex-col select-none relative overflow-hidden">
      {/* TOP NAVIGATION BAR */}
      <motion.header
        {...getEntranceMotionProps(entrancePhase, {
          delay: 0.03,
          duration: 0.44,
          offsetY: -12,
          initialScale: 0.99,
        })}
        className="h-[38px] w-full bg-[#000000] grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center px-[18px] shrink-0 z-40"
      >
        {/* Left Zone: Brand Logo + Undo/Redo */}
        <div className="flex items-center gap-[22px] shrink-0 min-w-[140px]">
          <button
            onClick={() => {
              setPreviewPreset(null);
              setActiveNav('Keymap');
              setSelectedKey(null);
              setMappingDrawerOpen(false);
              setMappingStackExpanded(false);
            }}
            className="flex items-center gap-[3px] text-white hover:opacity-90 transition-opacity focus:outline-none cursor-pointer px-[10px]"
            title="NØDE Studio"
          >
            <span className="font-bold text-[13px] tracking-[0.16em] text-white select-none leading-none">
              NØDE
            </span>
          </button>

          {activeNav === 'Keymap' && (
            <div className="flex items-center gap-[9px]">
              <button
                onClick={handleUndo}
                disabled={history.length === 0}
                title="Undo"
                className={`w-5 h-5 flex items-center justify-center rounded transition-colors cursor-pointer ${
                  history.length > 0
                    ? 'text-[#b0b0b0] hover:text-white'
                    : 'text-[#6c6c6c] hover:text-[#909090]'
                }`}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M5.5 3.5L2.5 6.5L5.5 9.5" />
                  <path d="M2.5 6.5H10C12.2091 6.5 14 8.29086 14 10.5C14 12.7091 12.2091 14.5 10 14.5H6" />
                </svg>
              </button>
              <button
                onClick={handleRedo}
                disabled={redoStack.length === 0}
                title="Redo"
                className={`w-5 h-5 flex items-center justify-center rounded transition-colors cursor-pointer ${
                  redoStack.length > 0
                    ? 'text-[#b0b0b0] hover:text-white'
                    : 'text-[#6c6c6c] hover:text-[#909090]'
                }`}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M10.5 3.5L13.5 6.5L10.5 9.5" />
                  <path d="M13.5 6.5H6C3.79086 6.5 2 8.29086 2 10.5C2 12.7091 3.79086 14.5 6 14.5H10" />
                </svg>
              </button>
            </div>
          )}
        </div>

        {/* Center Zone: Keymap | Preset | Settings */}
        <nav className="justify-self-center flex items-center gap-[28px] text-[12.5px] tracking-[0.01em] whitespace-nowrap shrink-0">
          {(['Keymap', 'Preset', 'Settings'] as const).map((tab) => {
            const isActive = activeNav === tab;
            return (
              <button
                key={tab}
                onClick={() => {
                  setPreviewPreset(null);
                  setActiveNav(tab);
                  setActiveTooltip(null);
                  setProfileMenuOpen(false);
                }}
                className={`transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  isActive
                    ? 'text-white font-semibold'
                    : 'text-[#cecece] hover:text-white font-normal'
                }`}
              >
                {tab}
              </button>
            );
          })}
        </nav>

        {/* Right Zone: Device Connection Status */}
        <button
          type="button"
          onClick={handleToggleDeviceConnection}
          disabled={deviceStatus.state === 'connecting'}
          aria-label={
            deviceStatus.state === 'connected'
              ? 'Disconnect Grid Macro 1'
              : 'Connect Grid Macro 1 via QMK/VIA'
          }
          title={
            deviceStatus.state === 'connected'
              ? `Firmware ${deviceStatus.fw ?? ''} on ${deviceStatus.path ?? 'USB'}`
              : deviceStatus.state === 'unavailable'
                ? 'WebHID unavailable; use Chrome or Edge over HTTPS or localhost'
                : deviceStatus.error ?? 'Connect Grid Macro 1 using VIA Raw HID'
          }
          className={`h-full pl-[12px] pr-[14px] flex items-center gap-[14px] text-white shrink-0 justify-self-end transition-colors cursor-pointer disabled:cursor-wait ${
            deviceStatus.state === 'connected' ? 'bg-[#0051ff]' : 'bg-[#4a4a4a]'
          }`}
        >
          <ChevronDown className="w-[13px] h-[13px] stroke-[2] text-white/95 shrink-0" />
          <span className="text-[12px] font-normal tracking-[0.01em] whitespace-nowrap">
            {deviceStatus.state === 'connected'
              ? deviceStatus.device || 'Grid Macro 1'
              : deviceStatus.state === 'searching'
                ? 'Searching…'
                : deviceStatus.state === 'connecting'
                  ? 'Connecting…'
                  : 'Not connected'}
          </span>
          <div className="h-[15px] w-[1px] bg-white/35" />
          <svg
            width="11"
            height="14"
            viewBox="0 0 12 15"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-label={`USB ${deviceStatus.state === 'connected' ? 'Connected' : 'Not connected'}`}
            className={deviceStatus.state === 'connected' ? 'opacity-100' : 'opacity-50'}
          >
            <path
              d="M6 1.5V12M6 1.5L4.3 3.5H7.7L6 1.5ZM6 9.5L2.8 7.3V4.8M6 8.2L9.2 6V4.2"
              stroke="white"
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="2.8" cy="4.4" r="1.1" fill="white" />
            <rect x="8.1" y="2.8" width="2.1" height="2.1" fill="white" />
            <circle cx="6" cy="12.5" r="1.5" fill="white" />
          </svg>
        </button>
      </motion.header>

      <AnimatePresence mode="wait">
        {/* ===================================================================== */}
        {/* 1. KEYMAP VIEW                                                        */}
        {/* ===================================================================== */}
        {activeNav === 'Keymap' && (
          <motion.main
            ref={keymapMainRef}
            key="keymap-screen"
            initial={{ opacity: 0, scale: 0.985, filter: 'blur(4px)' }}
            animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, scale: 1.01, filter: 'blur(4px)' }}
            transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
            className="flex-1 flex flex-col justify-between relative overflow-hidden"
          >
            {/* Sub-Header Controls Bar: Profiles (left), Layers (center), Key Mapping (right) */}
            <div className="w-full px-[27px] pt-[24px] grid grid-cols-3 items-start z-20 pointer-events-none">
            {/* LEFT: Profiles */}
            <motion.div
              {...getEntranceMotionProps(entrancePhase, { delay: 0.12 })}
              ref={profileContainerRef}
              className="flex flex-col items-start relative pointer-events-auto w-fit"
            >
              <div className="flex items-center gap-[5px] text-[#666666] text-[12.5px] font-normal">
                <span>Profiles</span>
                <button
                  onClick={() =>
                    setActiveTooltip(activeTooltip === 'profiles' ? null : 'profiles')
                  }
                  onMouseEnter={() => setActiveTooltip('profiles')}
                  onMouseLeave={() => setActiveTooltip(null)}
                  className="text-[#666666] hover:text-[#222] transition-colors cursor-pointer"
                  aria-label="Profiles Info"
                >
                  <InfoCircleIcon />
                </button>
              </div>

              <AnimatePresence>
                {activeTooltip === 'profiles' && (
                  <motion.div
                    key="profiles-tooltip"
                    initial={{ opacity: 0, y: -5, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -5, scale: 0.96 }}
                    transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                    className="absolute top-[25px] -left-[20px] w-[262px] bg-[#ececec] rounded-[16px] px-[18px] py-[15px] shadow-[0_3px_10px_rgba(0,0,0,0.06)] border border-black/[0.04] text-left z-40 pointer-events-none"
                  >
                    <div className="text-[13px] font-semibold text-[#666666] mb-[9px]">
                      What are Profiles?
                    </div>
                    <p className="text-[11px] leading-[1.36] text-[#686868]">
                      Profiles let you create different key configurations for different workflows. Each profile stores its own layers, key mappings, and actions. Switch profile to instantly change how your device behaves.
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="mt-[10px] flex items-center gap-[9px] relative">
                <div
                  onClick={() => {
                    if (!profileMenuOpen) setProfileMenuOpen(true);
                  }}
                  className="h-[30px] w-[142px] px-[10px] rounded-full bg-[#e2e2e2] hover:bg-[#dadada] border-[1.5px] border-transparent hover:border-[#0051ff] focus-within:border-[#0051ff] flex items-center gap-[6px] transition-all cursor-pointer"
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    fill="none"
                    className="shrink-0"
                  >
                    <path
                      d="M5 0.5L9.2 5L5 9.5L0.8 5L5 0.5Z"
                      fill={currentProfile.color}
                    />
                  </svg>
                  <span
                    title={currentProfile.name || 'Untitled Profile'}
                    className="w-full text-[#6a6a6a] text-[11.5px] font-medium truncate"
                  >
                    {currentProfile.name || 'Untitled Profile'}
                  </span>
                </div>

                <button
                  onClick={() => {
                    setProfileMenuOpen((o) => !o);
                    setDeletingProfileId(null);
                  }}
                  aria-label="Toggle profile list"
                  className={`w-[26px] h-[26px] rounded-full border-[1.5px] flex items-center justify-center transition-all cursor-pointer ${
                    profileMenuOpen
                      ? 'bg-[#000000] text-white border-[#000000]'
                      : 'bg-white hover:bg-neutral-50 text-[#4a4a4a] border-transparent hover:border-[#0051ff] shadow-[0_1px_2px_rgba(0,0,0,0.05)]'
                  }`}
                >
                  {profileMenuOpen ? (
                    <ChevronUp className="w-[13px] h-[13px] stroke-[2]" />
                  ) : (
                    <ChevronDown className="w-[13px] h-[13px] stroke-[1.8]" />
                  )}
                </button>

                <AnimatePresence>
                  {profileMenuOpen && (
                    <motion.div
                      key="profile-dropdown-tray"
                      initial={{ opacity: 0, scale: 0.95, y: -6 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.95, y: -6 }}
                      transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
                      style={{ transformOrigin: 'top left' }}
                      className="absolute top-[37px] left-0 w-[262px] bg-[#e4e4e4] rounded-[18px] p-[9px] shadow-[0_4px_14px_rgba(0,0,0,0.08)] border border-black/[0.03] z-40 space-y-[7px]"
                    >
                      {profiles.map((prof, idx) => {
                        const isSelected = idx === activeProfileIndex;
                        const isConfirmingDelete =
                          deletingProfileId === prof.id;

                        return (
                          <motion.div
                            key={prof.id}
                            layout
                            transition={{
                              type: 'spring',
                              stiffness: 520,
                              damping: 32,
                              mass: 0.7,
                            }}
                          >
                            <AnimatePresence mode="popLayout" initial={false}>
                              {isConfirmingDelete ? (
                                <motion.div
                                  key="confirm-delete"
                                  layout
                                  initial={{ opacity: 0, scale: 0.9, y: 4 }}
                                  animate={{ opacity: 1, scale: 1, y: 0 }}
                                  exit={{ opacity: 0, scale: 0.9, y: -4 }}
                                  transition={{
                                    type: 'spring',
                                    stiffness: 540,
                                    damping: 30,
                                    mass: 0.65,
                                  }}
                                  className="flex items-center gap-[6px]"
                                >
                                  <motion.button
                                    layout
                                    initial={{ opacity: 0, x: -10, scale: 0.88 }}
                                    animate={{ opacity: 1, x: 0, scale: 1 }}
                                    exit={{ opacity: 0, x: -8, scale: 0.88 }}
                                    whileHover={{ scale: 1.04 }}
                                    whileTap={{ scale: 0.94 }}
                                    transition={{
                                      type: 'spring',
                                      stiffness: 560,
                                      damping: 28,
                                    }}
                                    onClick={() => setDeletingProfileId(null)}
                                    className="h-[28px] px-[12px] rounded-full bg-white hover:bg-neutral-50 border-[1.5px] border-transparent hover:border-[#0051ff] text-[11px] font-medium text-[#444444] shrink-0 shadow-[0_2px_6px_rgba(0,0,0,0.06)] transition-colors cursor-pointer"
                                  >
                                    Cancel
                                  </motion.button>
                                  <motion.button
                                    layout
                                    initial={{ opacity: 0, x: 14, scale: 0.86 }}
                                    animate={{ opacity: 1, x: 0, scale: 1 }}
                                    exit={{ opacity: 0, x: 12, scale: 0.86 }}
                                    whileHover={{
                                      scale: 1.025,
                                      boxShadow: '0 6px 18px rgba(220, 0, 0, 0.36)',
                                    }}
                                    whileTap={{ scale: 0.95 }}
                                    transition={{
                                      type: 'spring',
                                      stiffness: 520,
                                      damping: 26,
                                    }}
                                    onClick={() => handleConfirmDeleteProfile(idx)}
                                    className="flex-1 h-[28px] rounded-full bg-gradient-to-r from-[#e01b24] via-[#ff2934] to-[#c40000] text-white text-[11px] font-semibold flex items-center justify-center gap-[6px] shadow-[0_3px_12px_rgba(220,0,0,0.28)] cursor-pointer overflow-hidden relative group"
                                  >
                                    <motion.svg
                                      width="12"
                                      height="12"
                                      viewBox="0 0 16 16"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="1.6"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      initial={{ rotate: -16, scale: 0.85 }}
                                      animate={{ rotate: [0, -14, 10, -6, 0], scale: 1 }}
                                      transition={{ duration: 0.48, ease: [0.22, 1, 0.36, 1] }}
                                      className="shrink-0"
                                    >
                                      <path d="M2.5 4.2H13.5" />
                                      <path d="M5.8 4.2V2.8C5.8 2.35 6.15 2 6.6 2H9.4C9.85 2 10.2 2.35 10.2 2.8V4.2" />
                                      <path d="M4.2 4.2L4.8 13C4.85 13.55 5.3 14 5.85 14H10.15C10.7 14 11.15 13.55 11.2 13L11.8 4.2" />
                                      <line x1="6.8" y1="7" x2="6.8" y2="11.2" />
                                      <line x1="9.2" y1="7" x2="9.2" y2="11.2" />
                                    </motion.svg>
                                    <span>Click to delete</span>
                                  </motion.button>
                                </motion.div>
                              ) : (
                                <motion.div
                                  key="normal-row"
                                  layout
                                  initial={{ opacity: 0, scale: 0.94, y: -3 }}
                                  animate={{ opacity: 1, scale: 1, y: 0 }}
                                  exit={{ opacity: 0, scale: 0.94, y: 3 }}
                                  transition={{
                                    type: 'spring',
                                    stiffness: 520,
                                    damping: 32,
                                    mass: 0.65,
                                  }}
                                  className="flex items-center gap-[5px]"
                                >
                                  {/* 6-Dot Drag Handle Circle */}
                                  <button
                                    type="button"
                                    title="Reorder profile"
                                    className="w-[27px] h-[27px] rounded-full bg-white hover:bg-neutral-50 border-[1.5px] border-transparent hover:border-[#0051ff] flex items-center justify-center text-[#444444] shrink-0 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-all cursor-grab active:cursor-grabbing"
                                  >
                                    <svg
                                      width="10"
                                      height="12"
                                      viewBox="0 0 10 12"
                                      fill="currentColor"
                                    >
                                      <circle cx="3" cy="2.5" r="1" />
                                      <circle cx="7" cy="2.5" r="1" />
                                      <circle cx="3" cy="6" r="1" />
                                      <circle cx="7" cy="6" r="1" />
                                      <circle cx="3" cy="9.5" r="1" />
                                      <circle cx="7" cy="9.5" r="1" />
                                    </svg>
                                  </button>

                                  {/* Profile Pill (Blue in our theme when active, White when inactive) */}
                                  <div
                                    onClick={() => {
                                      setActiveProfileIndex(idx);
                                      setActiveLayerIndex(0);
                                      setDeletingProfileId(null);
                                    }}
                                    className={`flex-1 h-[27px] min-w-0 px-[10px] rounded-full border-[1.5px] border-transparent hover:border-[#0051ff] flex items-center gap-[6px] text-[11px] font-medium transition-all cursor-text ${
                                      isSelected
                                        ? 'bg-[#0051ff] text-white'
                                        : 'bg-white text-[#444444] hover:bg-neutral-50'
                                    }`}
                                  >
                                    {isSelected && (
                                      <svg
                                        width="9"
                                        height="9"
                                        viewBox="0 0 10 10"
                                        fill="none"
                                        className="shrink-0"
                                      >
                                        <path
                                          d="M5 0.5L9.2 5L5 9.5L0.8 5L5 0.5Z"
                                          fill="#ffffff"
                                        />
                                      </svg>
                                    )}
                                    <input
                                      type="text"
                                      value={prof.name}
                                      onChange={(event) =>
                                        handleUpdateProfileName(idx, event.target.value)
                                      }
                                      onFocus={() => {
                                        setActiveProfileIndex(idx);
                                        setActiveLayerIndex(0);
                                        setDeletingProfileId(null);
                                      }}
                                      aria-label={`Rename profile ${prof.name || idx + 1}`}
                                      placeholder={isSelected ? 'Profile name...' : 'Untitled Profile'}
                                      className={`min-w-0 flex-1 bg-transparent truncate focus:outline-none ${
                                        isSelected
                                          ? 'text-white placeholder:text-white/70'
                                          : 'text-[#444444] placeholder:text-[#9c9c9c]'
                                      }`}
                                    />
                                  </div>

                                  {/* Duplicate Profile */}
                                  <motion.button
                                    whileHover={{ scale: 1.07 }}
                                    whileTap={{ scale: 0.92 }}
                                    onClick={() => handleDuplicateProfile(idx)}
                                    title="Duplicate profile"
                                    className="w-[27px] h-[27px] rounded-full bg-white hover:bg-neutral-50 border-[1.5px] border-transparent hover:border-[#0051ff] flex items-center justify-center text-[#444444] shrink-0 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors cursor-pointer"
                                  >
                                    <svg
                                      width="12"
                                      height="12"
                                      viewBox="0 0 16 16"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="1.4"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    >
                                      <rect
                                        x="5.5"
                                        y="3.5"
                                        width="7.5"
                                        height="9.5"
                                        rx="1.5"
                                      />
                                      <path d="M3 6.5V12.5C3 13.3 3.7 14 4.5 14H10" />
                                    </svg>
                                  </motion.button>

                                  {/* Export Profile */}
                                  <motion.button
                                    whileHover={{ scale: 1.07 }}
                                    whileTap={{ scale: 0.92 }}
                                    onClick={() => handleExportProfile(idx)}
                                    title="Export profile"
                                    className="w-[27px] h-[27px] rounded-full bg-white hover:bg-neutral-50 border-[1.5px] border-transparent hover:border-[#0051ff] flex items-center justify-center text-[#444444] shrink-0 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors cursor-pointer"
                                  >
                                    <svg
                                      width="12"
                                      height="12"
                                      viewBox="0 0 16 16"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="1.4"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    >
                                      <path d="M8 2.5V10.5M8 10.5L5.2 7.7M8 10.5L10.8 7.7" />
                                      <path d="M3 11.5V12.5C3 13.1 3.4 13.5 4 13.5H12C12.6 13.5 13 13.1 13 12.5V11.5" />
                                    </svg>
                                  </motion.button>

                                  {/* Delete Profile (× button only shown when more than 1 profile exists) */}
                                  {profiles.length > 1 && (
                                    <motion.button
                                      whileHover={{ scale: 1.1, rotate: 90 }}
                                      whileTap={{ scale: 0.88 }}
                                      transition={{
                                        type: 'spring',
                                        stiffness: 520,
                                        damping: 24,
                                      }}
                                      onClick={() => setDeletingProfileId(prof.id)}
                                      title="Delete profile"
                                      className="w-[27px] h-[27px] rounded-full bg-white hover:bg-[#dc0000] text-[#444444] hover:text-white flex items-center justify-center shrink-0 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors cursor-pointer"
                                    >
                                      <X className="w-[12px] h-[12px] stroke-[1.8]" />
                                    </motion.button>
                                  )}
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </motion.div>
                        );
                      })}

                      <div className="flex items-center gap-[6px]">
                        <button
                          onClick={handleAddProfile}
                          className="flex-1 h-[28px] rounded-full bg-white hover:bg-neutral-50 border-[1.5px] border-transparent hover:border-[#0051ff] flex items-center justify-center gap-[5px] text-[11px] font-medium text-[#444444] shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-all cursor-pointer"
                        >
                          <Plus className="w-[11px] h-[11px] stroke-[2]" />
                          <span>Add Profile</span>
                        </button>

                        <button
                          onClick={handleImportProfile}
                          className="h-[28px] px-[10px] rounded-full bg-white hover:bg-neutral-50 border-[1.5px] border-transparent hover:border-[#0051ff] flex items-center justify-center gap-[5px] text-[11px] font-medium text-[#444444] shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-all cursor-pointer"
                        >
                          <svg
                            width="10"
                            height="11"
                            viewBox="0 0 12 13"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M2 2H10" />
                            <path d="M6 11V4.5M6 4.5L3.5 7M6 4.5L8.5 7" />
                          </svg>
                          <span>Import</span>
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>

            {/* CENTER: Layers */}
            <motion.div
              {...getEntranceMotionProps(entrancePhase, { delay: 0.19 })}
              ref={layersContainerRef}
              className="flex flex-col items-center relative pointer-events-auto justify-self-center"
            >
              <div className="flex items-center gap-[5px] text-[#666666] text-[12.5px] font-normal">
                <span>Layers</span>
                <button
                  onClick={() =>
                    setActiveTooltip(activeTooltip === 'layers' ? null : 'layers')
                  }
                  onMouseEnter={() => setActiveTooltip('layers')}
                  onMouseLeave={() => setActiveTooltip(null)}
                  className="text-[#666666] hover:text-[#222] transition-colors cursor-pointer"
                  aria-label="Layers Info"
                >
                  <InfoCircleIcon />
                </button>
              </div>

              <AnimatePresence>
                {activeTooltip === 'layers' && (
                  <motion.div
                    key="layers-tooltip"
                    initial={{ opacity: 0, y: -5, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -5, scale: 0.96 }}
                    transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                    className="absolute top-[25px] left-1/2 -translate-x-1/2 w-[262px] bg-[#ececec] rounded-[16px] px-[18px] py-[15px] shadow-[0_3px_10px_rgba(0,0,0,0.06)] border border-black/[0.04] text-left z-40 pointer-events-none"
                  >
                    <div className="text-[13px] font-semibold text-[#666666] mb-[9px]">
                      What is Layers?
                    </div>
                    <p className="text-[11px] leading-[1.36] text-[#686868]">
                      Layers work like programmable overlays. Each layer can contain a different set of key assignments. Activate or toggle layers to expand what a single key can do.
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>

              <motion.div
                layout
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                className="mt-[10px] flex items-center justify-center gap-[8px]"
              >
                <AnimatePresence initial={false}>
                  {currentProfile.layers.map((_, idx) => {
                    const isActive = idx === activeLayerIndex;
                    return (
                      <motion.button
                        key={idx}
                        layout
                        initial={{ opacity: 0, scale: 0.75 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.75 }}
                        whileTap={{ scale: 0.92 }}
                        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                        onClick={() => {
                          if (idx === activeLayerIndex) {
                            setLayerToolbarOpen((open) => {
                              if (open) {
                                setLayerLightingOpen(false);
                                setLayerDeleteConfirm(false);
                              }
                              return !open;
                            });
                          } else {
                            setActiveLayerIndex(idx);
                            setLedEditingLayerIdx(idx);
                            setLayerToolbarOpen(true);
                            setLayerDeleteConfirm(false);
                          }
                        }}
                        title={`Layer ${idx + 1}`}
                        className={`w-[26px] h-[26px] rounded-full border-[1.5px] text-[11.5px] font-medium flex items-center justify-center transition-colors duration-200 tabular-nums cursor-pointer ${
                          isActive
                            ? layerToolbarOpen
                              ? 'bg-[#000000] border-[#000000] text-white'
                              : 'bg-[#0051ff] border-[#0051ff] text-white'
                            : 'bg-white text-[#444444] border-transparent hover:border-[#0051ff] shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
                        }`}
                      >
                        {idx + 1}
                      </motion.button>
                    );
                  })}
                </AnimatePresence>

                {currentProfile.layers.length < MAX_LAYER_COUNT && (
                  <motion.button
                    layout
                    whileTap={{ scale: 0.92 }}
                    onClick={handleAddLayer}
                    title="Add Layer"
                    className="w-[26px] h-[26px] rounded-full border-[1.5px] border-transparent hover:border-[#0051ff] flex items-center justify-center text-[#555555] hover:bg-black/5 transition-all cursor-pointer"
                  >
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 12 12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                    >
                      <path d="M6 1.5V10.5M1.5 6H10.5" />
                    </svg>
                  </motion.button>
                )}
              </motion.div>

              {/* LAYER ACTION TOOLBAR & LED COLOUR POPOVER */}
              <AnimatePresence>
                {layerToolbarOpen && (
                  <motion.div
                    key="layer-action-toolbar"
                    layout
                    initial={{ opacity: 0, y: -6, scale: 0.94 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -6, scale: 0.94 }}
                    transition={{
                      type: 'spring',
                      stiffness: 500,
                      damping: 30,
                      mass: 0.75,
                    }}
                    className="mt-[9px] flex items-center gap-[6px] relative z-30"
                  >
                    <AnimatePresence mode="popLayout" initial={false}>
                      {layerDeleteConfirm ? (
                        <motion.div
                          key="layer-delete-confirm"
                          layout
                          initial={{ opacity: 0, scale: 0.9, y: 4 }}
                          animate={{ opacity: 1, scale: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.9, y: -4 }}
                          transition={{
                            type: 'spring',
                            stiffness: 540,
                            damping: 30,
                            mass: 0.65,
                          }}
                          className="flex items-center gap-[6px]"
                        >
                          <motion.button
                            layout
                            initial={{ opacity: 0, x: -12, scale: 0.88 }}
                            animate={{ opacity: 1, x: 0, scale: 1 }}
                            exit={{ opacity: 0, x: -10, scale: 0.88 }}
                            whileHover={{ scale: 1.04 }}
                            whileTap={{ scale: 0.94 }}
                            transition={{
                              type: 'spring',
                              stiffness: 560,
                              damping: 28,
                            }}
                            onClick={() => setLayerDeleteConfirm(false)}
                            className="h-[28px] px-[13px] rounded-full bg-white hover:bg-neutral-50 border-[1.5px] border-transparent hover:border-[#0051ff] text-[11px] font-medium text-[#555555] shadow-[0_2px_6px_rgba(0,0,0,0.06)] transition-colors cursor-pointer"
                          >
                            Cancel
                          </motion.button>
                          <motion.button
                            layout
                            initial={{ opacity: 0, x: 16, scale: 0.86 }}
                            animate={{ opacity: 1, x: 0, scale: 1 }}
                            exit={{ opacity: 0, x: 14, scale: 0.86 }}
                            whileHover={{
                              scale: 1.03,
                              boxShadow: '0 6px 20px rgba(220, 0, 0, 0.38)',
                            }}
                            whileTap={{ scale: 0.95 }}
                            transition={{
                              type: 'spring',
                              stiffness: 520,
                              damping: 26,
                            }}
                            onClick={() => handleRemoveLayer(activeLayerIndex)}
                            className="h-[28px] w-[184px] rounded-full bg-gradient-to-r from-[#e01b24] via-[#ff2934] to-[#c40000] text-white text-[11px] font-semibold flex items-center justify-center gap-[6px] shadow-[0_3px_12px_rgba(220,0,0,0.28)] cursor-pointer"
                          >
                            <motion.svg
                              width="12"
                              height="12"
                              viewBox="0 0 16 16"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.6"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              initial={{ rotate: -16, scale: 0.85 }}
                              animate={{ rotate: [0, -14, 10, -6, 0], scale: 1 }}
                              transition={{ duration: 0.48, ease: [0.22, 1, 0.36, 1] }}
                              className="shrink-0"
                            >
                              <path d="M2.5 4.2H13.5" />
                              <path d="M5.8 4.2V2.8C5.8 2.35 6.15 2 6.6 2H9.4C9.85 2 10.2 2.35 10.2 2.8V4.2" />
                              <path d="M4.2 4.2L4.8 13C4.85 13.55 5.3 14 5.85 14H10.15C10.7 14 11.15 13.55 11.2 13L11.8 4.2" />
                              <line x1="6.8" y1="7" x2="6.8" y2="11.2" />
                              <line x1="9.2" y1="7" x2="9.2" y2="11.2" />
                            </motion.svg>
                            <span>Click to delete</span>
                          </motion.button>
                        </motion.div>
                      ) : (
                        <motion.div
                          key="layer-normal-controls"
                          layout
                          initial={{ opacity: 0, scale: 0.94, y: -3 }}
                          animate={{ opacity: 1, scale: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.94, y: 3 }}
                          transition={{
                            type: 'spring',
                            stiffness: 520,
                            damping: 32,
                            mass: 0.65,
                          }}
                          className="flex items-center gap-[6px]"
                        >
                          {/* Layer Name Input Pill */}
                          <div className="w-[144px] h-[28px] px-[12px] rounded-full bg-[#e2e2e2] border-[1.5px] border-transparent focus-within:border-[#0051ff] flex items-center transition-colors">
                            <input
                              type="text"
                              value={currentLayerName}
                              onChange={(e) =>
                                setLayerNames((prev) => ({
                                  ...prev,
                                  [currentLayerNameKey]: e.target.value,
                                }))
                              }
                              placeholder={HARDWARE_LAYER_NAMES[activeLayerIndex] ?? 'Layer name...'}
                              className="w-full bg-transparent text-[11px] text-[#555555] placeholder:text-[#9c9c9c] focus:outline-none"
                            />
                          </div>

                          {/* LED Colour Settings Pill Button */}
                          <motion.button
                            whileHover={{ scale: 1.05 }}
                            whileTap={{ scale: 0.94 }}
                            onClick={() => {
                              setLedEditingLayerIdx(Math.min(3, Math.max(0, activeLayerIndex)));
                              setLayerLightingOpen((o) => !o);
                            }}
                            title="Layer LED settings"
                            aria-label="LED colour settings"
                            className={`w-[58px] h-[28px] rounded-full border-[1.5px] flex items-center justify-center transition-colors cursor-pointer ${
                              layerLightingOpen
                                ? 'bg-[#000000] text-white border-[#000000]'
                                : 'bg-white hover:bg-neutral-50 text-[#555555] border-transparent hover:border-[#0051ff] shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
                            }`}
                          >
                            <svg
                              width="16"
                              height="14"
                              viewBox="0 0 18 15"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                            >
                              <line x1="6.2" y1="11.5" x2="11.8" y2="11.5" />
                              <line x1="9" y1="5.0" x2="9" y2="7.2" />
                              <line x1="5.5" y1="6.5" x2="6.9" y2="7.9" />
                              <line x1="12.5" y1="6.5" x2="11.1" y2="7.9" />
                              <line x1="3.8" y1="9.6" x2="5.6" y2="9.6" />
                              <line x1="14.2" y1="9.6" x2="12.4" y2="9.6" />
                            </svg>
                          </motion.button>

                          {/* Delete Layer × Button (only shown when more than 1 layer exists; turns solid red on hover) */}
                          {currentProfile.layers.length > 1 && (
                            <motion.button
                              whileHover={{ scale: 1.1, rotate: 90 }}
                              whileTap={{ scale: 0.88 }}
                              transition={{
                                type: 'spring',
                                stiffness: 520,
                                damping: 24,
                              }}
                              onClick={() => {
                                setLayerLightingOpen(false);
                                setLayerDeleteConfirm(true);
                              }}
                              title="Delete layer"
                              className="w-[28px] h-[28px] rounded-full bg-white hover:bg-[#dc0000] text-[#555555] hover:text-white flex items-center justify-center shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors cursor-pointer"
                            >
                              <X className="w-[13px] h-[13px] stroke-[1.8]" />
                            </motion.button>
                          )}
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* PER-LAYER LED COLOUR POPOVER CARD */}
                    <AnimatePresence>
                      {layerLightingOpen && !layerDeleteConfirm && (
                        <motion.div
                          key="layer-lighting-popover"
                          initial={{ opacity: 0, y: -6, scale: 0.96 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: -6, scale: 0.96 }}
                          transition={{
                            duration: 0.2,
                            ease: [0.32, 0.72, 0, 1],
                          }}
                          style={{ transformOrigin: 'top center' }}
                          className="absolute top-[37px] left-1/2 -translate-x-1/2 w-[236px] bg-[#e2e2e2] rounded-[18px] p-[9px] shadow-[0_8px_24px_rgba(0,0,0,0.12)] border border-black/[0.04] z-50"
                        >
                          {/* 4-Layer Per-Layer LED Selector Card */}
                          <div className="bg-[#eeeeee] rounded-[14px] p-[10px] mb-[8px]">
                            <div className="text-[11px] font-medium text-[#444444] mb-[7px] text-left">
                              Per-Layer LED
                            </div>
                            <div className="grid grid-cols-4 gap-[5px]">
                              {HARDWARE_LAYER_NAMES.map((layerLabel, lIdx) => {
                                const lCfg = layerLedConfigs[lIdx] || DEFAULT_LAYER_LED_CONFIGS[lIdx];
                                const isSelectedLayer = lIdx === ledEditingLayerIdx;
                                const dotColor = lCfg.preset === 'Off' ? '#9ca3af' : lCfg.colorHex;
                                return (
                                  <button
                                    key={layerLabel}
                                    type="button"
                                    onClick={() => {
                                      setLedEditingLayerIdx(lIdx);
                                      if (lIdx < currentProfile.layers.length) {
                                        setActiveLayerIndex(lIdx);
                                      }
                                    }}
                                    className={`h-[26px] rounded-full px-[6px] flex items-center justify-center gap-[4px] text-[10px] font-medium border-[1.5px] transition-all cursor-pointer ${
                                      isSelectedLayer
                                        ? 'bg-[#000000] text-white border-[#000000] shadow-xs'
                                        : 'bg-white text-[#555555] border-transparent hover:border-[#0051ff]'
                                    }`}
                                  >
                                    <span
                                      className="w-[8px] h-[8px] rounded-full shrink-0 border border-black/15"
                                      style={{
                                        backgroundColor: dotColor,
                                        boxShadow:
                                          lCfg.preset === 'Off'
                                            ? 'none'
                                            : `0 0 5px ${dotColor}`,
                                      }}
                                    />
                                    <span>L{lIdx + 1}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          {/* Presets Card (for the selected layer) */}
                          <div className="bg-[#eeeeee] rounded-[14px] p-[10px] mb-[8px]">
                            <div className="text-[11px] font-normal text-[#555555] mb-[7px] text-left">
                              Mode
                            </div>
                            <div className="grid grid-cols-2 gap-[5px]">
                              {(
                                [
                                  'Off',
                                  'Solid',
                                  'Rainbow',
                                  'Breath',
                                ] as const
                              ).map((presetName) => {
                                const currentLedCfg =
                                  layerLedConfigs[ledEditingLayerIdx] ||
                                  DEFAULT_LAYER_LED_CONFIGS[ledEditingLayerIdx];
                                const isActivePreset =
                                  currentLedCfg.preset === presetName;
                                return (
                                  <button
                                    key={presetName}
                                    onClick={() => {
                                      setLayerLedConfigs((prev) => {
                                        const next = [...prev] as [
                                          LayerLedConfig,
                                          LayerLedConfig,
                                          LayerLedConfig,
                                          LayerLedConfig,
                                        ];
                                        next[ledEditingLayerIdx] = {
                                          ...next[ledEditingLayerIdx],
                                          preset: presetName,
                                        };
                                        syncRgbConfigsToDevice(next, true);
                                        return next;
                                      });
                                    }}
                                    className={`h-[24px] rounded-full border-[1.5px] border-transparent hover:border-[#0051ff] text-[10px] font-medium transition-all cursor-pointer ${
                                      isActivePreset
                                        ? 'bg-[#000000] text-white'
                                        : 'bg-white text-[#555555]'
                                    }`}
                                  >
                                    {presetName}
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          {/* Settings Card (for the selected layer) */}
                          <div className="bg-[#eeeeee] rounded-[14px] p-[10px] mb-[8px]">
                            <div className="flex items-center justify-between mb-[8px]">
                              <span className="text-[11px] font-normal text-[#555555]">
                                Layer {ledEditingLayerIdx + 1} Colour
                              </span>
                              <span
                                className="w-[10px] h-[10px] rounded-full border border-black/15"
                                style={{
                                  backgroundColor:
                                    layerLedConfigs[ledEditingLayerIdx]?.colorHex || '#0051FF',
                                }}
                              />
                            </div>

                            {(() => {
                              const cfg =
                                layerLedConfigs[ledEditingLayerIdx] ||
                                DEFAULT_LAYER_LED_CONFIGS[ledEditingLayerIdx];
                              const isOff = cfg.preset === 'Off';
                              const isAnimated =
                                cfg.preset !== 'Off' && cfg.preset !== 'Solid';

                              return (
                                <div className="space-y-[8px]">
                                  {/* Light Slider */}
                                  <div
                                    className={`flex items-center gap-[8px] ${
                                      isOff
                                        ? 'opacity-35 pointer-events-none'
                                        : ''
                                    }`}
                                  >
                                    <span className="w-[38px] text-left text-[10px] text-[#555555] shrink-0">
                                      Light
                                    </span>
                                    <div className="relative flex-1 h-[14px] flex items-center">
                                      <div className="w-full h-[1.5px] bg-[#b5b5b5] rounded-full" />
                                      <input
                                        type="range"
                                        min={0}
                                        max={100}
                                        value={cfg.light}
                                        onChange={(e) => {
                                          const nextLight = Number(e.target.value);
                                          setLayerLedConfigs((prev) => {
                                            const next = [...prev] as [
                                              LayerLedConfig,
                                              LayerLedConfig,
                                              LayerLedConfig,
                                              LayerLedConfig,
                                            ];
                                            next[ledEditingLayerIdx] = {
                                              ...next[ledEditingLayerIdx],
                                              light: nextLight,
                                            };
                                            syncRgbConfigsToDevice(next, false);
                                            return next;
                                          });
                                        }}
                                        onPointerUp={() => syncRgbConfigsToDevice(layerLedConfigs, true)}
                                        onKeyUp={() => syncRgbConfigsToDevice(layerLedConfigs, true)}
                                        className="absolute inset-0 w-full opacity-0 cursor-pointer z-10"
                                      />
                                      <div
                                        style={{
                                          left: `calc(${cfg.light}% - 5.5px)`,
                                        }}
                                        className="absolute w-[11px] h-[11px] rounded-full bg-white border border-[#444444] pointer-events-none"
                                      />
                                    </div>
                                  </div>

                                  {/* Speed Slider */}
                                  <div
                                    className={`flex items-center gap-[8px] ${
                                      !isAnimated
                                        ? 'opacity-30 pointer-events-none'
                                        : ''
                                    }`}
                                  >
                                    <span className="w-[38px] text-left text-[10px] text-[#555555] shrink-0">
                                      Speed
                                    </span>
                                    <div className="relative flex-1 h-[14px] flex items-center">
                                      <div className="w-full h-[1.5px] bg-[#b5b5b5] rounded-full" />
                                      <input
                                        type="range"
                                        min={0}
                                        max={100}
                                        value={cfg.speed}
                                        onChange={(e) => {
                                          const nextSpeed = Number(e.target.value);
                                          setLayerLedConfigs((prev) => {
                                            const next = [...prev] as [
                                              LayerLedConfig,
                                              LayerLedConfig,
                                              LayerLedConfig,
                                              LayerLedConfig,
                                            ];
                                            next[ledEditingLayerIdx] = {
                                              ...next[ledEditingLayerIdx],
                                              speed: nextSpeed,
                                            };
                                            syncRgbConfigsToDevice(next, false);
                                            return next;
                                          });
                                        }}
                                        onPointerUp={() => syncRgbConfigsToDevice(layerLedConfigs, true)}
                                        onKeyUp={() => syncRgbConfigsToDevice(layerLedConfigs, true)}
                                        className="absolute inset-0 w-full opacity-0 cursor-pointer z-10"
                                      />
                                      <div
                                        style={{
                                          left: `calc(${cfg.speed}% - 5.5px)`,
                                        }}
                                        className="absolute w-[11px] h-[11px] rounded-full bg-white border border-[#444444] pointer-events-none"
                                      />
                                    </div>
                                  </div>

                                  {/* Color Rainbow Slider */}
                                  <div
                                    className={`flex items-center gap-[8px] ${
                                      isOff
                                        ? 'opacity-35 pointer-events-none'
                                        : ''
                                    }`}
                                  >
                                    <span className="w-[38px] text-left text-[10px] text-[#555555] shrink-0">
                                      Color
                                    </span>
                                    <div className="relative flex-1 h-[14px] flex items-center">
                                      <div
                                        className="w-full h-[3px] rounded-full"
                                        style={{
                                          background:
                                            'linear-gradient(to right, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)',
                                        }}
                                      />
                                      <input
                                        type="range"
                                        min={0}
                                        max={360}
                                        value={cfg.hue}
                                        onChange={(e) => {
                                          const nextHue = Number(e.target.value);
                                          const nextHex = hueToHex(nextHue);
                                          setLayerLedConfigs((prev) => {
                                            const next = [...prev] as [
                                              LayerLedConfig,
                                              LayerLedConfig,
                                              LayerLedConfig,
                                              LayerLedConfig,
                                            ];
                                            next[ledEditingLayerIdx] = {
                                              ...next[ledEditingLayerIdx],
                                              hue: nextHue,
                                              colorHex: nextHex,
                                            };
                                            syncRgbConfigsToDevice(next, false);
                                            return next;
                                          });
                                        }}
                                        onPointerUp={() => syncRgbConfigsToDevice(layerLedConfigs, true)}
                                        onKeyUp={() => syncRgbConfigsToDevice(layerLedConfigs, true)}
                                        className="absolute inset-0 w-full opacity-0 cursor-pointer z-10"
                                      />
                                      <div
                                        style={{
                                          left: `calc(${
                                            (cfg.hue / 360) * 100
                                          }% - 5.5px)`,
                                        }}
                                        className="absolute w-[11px] h-[11px] rounded-full bg-white border border-[#444444] pointer-events-none"
                                      />
                                    </div>
                                  </div>

                                  {/* Hex Input Pill + Swatch Circle */}
                                  <div
                                    className={`ml-[46px] h-[24px] rounded-full bg-[#e2e2e2] px-[10px] flex items-center justify-between ${
                                      isOff
                                        ? 'opacity-35 pointer-events-none'
                                        : ''
                                    }`}
                                  >
                                    <input
                                      type="text"
                                      value={cfg.colorHex}
                                      onChange={(e) => {
                                        const nextHex = e.target.value;
                                        setLayerLedConfigs((prev) => {
                                          const next = [...prev] as [
                                            LayerLedConfig,
                                            LayerLedConfig,
                                            LayerLedConfig,
                                            LayerLedConfig,
                                          ];
                                          const isValidHex = /^#?[0-9a-fA-F]{6}$/.test(
                                            nextHex.trim()
                                          );
                                          const formattedHex = isValidHex
                                            ? nextHex.startsWith('#')
                                              ? nextHex.toUpperCase()
                                              : `#${nextHex.toUpperCase()}`
                                            : nextHex;
                                          next[ledEditingLayerIdx] = {
                                            ...next[ledEditingLayerIdx],
                                            colorHex: formattedHex,
                                          };
                                          if (isValidHex) {
                                            syncRgbConfigsToDevice(next, true);
                                          }
                                          return next;
                                        });
                                      }}
                                      className="w-[85px] bg-transparent text-[10px] text-[#555555] uppercase focus:outline-none"
                                    />
                                    <span
                                      className="w-[11px] h-[11px] rounded-full shrink-0 border border-black/10"
                                      style={{
                                        backgroundColor: cfg.colorHex,
                                      }}
                                    />
                                  </div>
                                </div>
                              );
                            })()}
                          </div>

                          {/* Apply to all layers button */}
                          <button
                            onClick={() => {
                              const sourceCfg =
                                layerLedConfigs[ledEditingLayerIdx] ||
                                DEFAULT_LAYER_LED_CONFIGS[ledEditingLayerIdx];
                              const nextConfigs: [
                                LayerLedConfig,
                                LayerLedConfig,
                                LayerLedConfig,
                                LayerLedConfig,
                              ] = [
                                { ...sourceCfg },
                                { ...sourceCfg },
                                { ...sourceCfg },
                                { ...sourceCfg },
                              ];
                              setLayerLedConfigs(nextConfigs);
                              syncRgbConfigsToDevice(nextConfigs, true);
                              showToast(
                                `Applied Layer ${ledEditingLayerIdx + 1} LED settings to all 4 layers`
                              );
                            }}
                            className="w-full h-[25px] rounded-full bg-white hover:bg-neutral-50 border-[1.5px] border-transparent hover:border-[#0051ff] text-[10px] font-normal text-[#555555] flex items-center justify-center transition-all cursor-pointer"
                          >
                            Apply to all layers
                          </button>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>

            {/* RIGHT: Key Mapping */}
            {!mappingDrawerOpen ? (
              <motion.div
                {...getEntranceMotionProps(entrancePhase, { delay: 0.26 })}
                className="flex flex-col items-end relative pointer-events-auto justify-self-end"
              >
                <div className="flex items-center gap-[5px] text-[#666666] text-[12.5px] font-normal">
                  <button
                    onClick={() =>
                      setActiveTooltip(activeTooltip === 'mapping' ? null : 'mapping')
                    }
                    onMouseEnter={() => setActiveTooltip('mapping')}
                    onMouseLeave={() => setActiveTooltip(null)}
                    className="text-[#666666] hover:text-[#222] transition-colors cursor-pointer"
                    aria-label="Key Mapping Info"
                  >
                    <InfoCircleIcon />
                  </button>
                  <span>Key Mapping</span>
                </div>

                <AnimatePresence>
                  {activeTooltip === 'mapping' && (
                    <motion.div
                      key="mapping-tooltip"
                      initial={{ opacity: 0, y: -5, scale: 0.96 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -5, scale: 0.96 }}
                      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                      className="absolute top-[25px] right-[68px] w-[235px] bg-[#ececec] rounded-[16px] px-[18px] py-[15px] shadow-[0_3px_10px_rgba(0,0,0,0.06)] border border-black/[0.04] text-left z-40 pointer-events-none"
                    >
                      <div className="text-[13px] font-semibold text-[#666666] mb-[9px]">
                        What is Key Mapping?
                      </div>
                      <p className="text-[11px] leading-[1.36] text-[#686868] mb-[8px]">
                        Assign actions to each physical key. Click a key to define what it does on the selected layer.
                      </p>
                      <div className="text-[11px] text-[#686868] mb-[3px]">
                        Keys can trigger:
                      </div>
                      <ul className="list-disc pl-[16px] text-[11px] leading-[1.36] text-[#686868]">
                        <li>Basic inputs</li>
                        <li>Shortcuts</li>
                        <li>Multi-step actions</li>
                      </ul>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Fixed-height anchor so top row height never changes */}
                <div className="mt-[10px] w-[49px] h-[49px]" />

                {/* Floating action stack overlay — hover boundary is strictly the 49px square buttons column (NOT the text capsule) */}
                <div
                  onMouseLeave={() => {
                    setHoveredMappingType(null);
                    setMappingStackExpanded(false);
                  }}
                  className="absolute top-[28px] right-0 w-[49px] flex flex-col items-end z-30"
                >
                  {!mappingStackExpanded ? (
                    <motion.button
                      key="plus-trigger"
                      initial={{ opacity: 0, scale: 0.92 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                      onMouseEnter={() => setMappingStackExpanded(true)}
                      onClick={() => handleOpenDrawerWithTab('Basic')}
                      title="Open Key Mapping"
                      className="w-[49px] h-[49px] bg-white rounded-[11px] border-[1.5px] border-transparent hover:border-[#0051ff] shadow-[0_1px_3px_rgba(0,0,0,0.04)] hover:shadow-[0_4px_14px_rgba(0,81,255,0.18)] flex items-center justify-center text-[#333333] transition-all cursor-pointer"
                    >
                      <svg
                        width="15"
                        height="15"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                      >
                        <path d="M8 2V14M2 8H14" />
                      </svg>
                    </motion.button>
                  ) : (
                    <motion.div
                      key="action-stack"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.2 }}
                      className="w-[49px] flex flex-col items-end gap-[9px]"
                    >
                        {(
                          [
                            { label: 'Basic Key', tab: 'Basic', icon: 'B' },
                            { label: 'Action', tab: 'Action', icon: 'A' },
                            { label: 'Multiaction', tab: 'Multi-A', icon: 'MA' },
                            { label: 'Smart Action', tab: 'Smart-A', icon: 'S' },
                          ] as const
                        ).map((entry, idx) => {
                          const isHovered = hoveredMappingType === entry.label;
                          return (
                            <motion.div
                              key={entry.label}
                              initial={{ opacity: 0, y: -10, scale: 0.92 }}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              exit={{ opacity: 0, y: -8, scale: 0.92 }}
                              transition={{
                                duration: 0.28,
                                delay: idx * 0.045,
                                ease: [0.22, 1, 0.36, 1],
                              }}
                              className="w-[49px] h-[49px] relative flex items-center justify-end"
                            >
                              <AnimatePresence>
                                {isHovered && (
                                  <motion.div
                                    initial={{ opacity: 0, x: 8, scale: 0.96 }}
                                    animate={{ opacity: 1, x: 0, scale: 1 }}
                                    exit={{ opacity: 0, x: 6, scale: 0.96 }}
                                    transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                                    className="absolute right-[58px] h-[29px] px-[14px] rounded-full bg-white shadow-[0_2px_8px_rgba(0,0,0,0.06)] flex items-center justify-center text-[11px] font-medium text-[#555555] whitespace-nowrap pointer-events-none"
                                  >
                                    {entry.label}
                                  </motion.div>
                                )}
                              </AnimatePresence>
                              <motion.button
                                whileHover={{ scale: 1.04 }}
                                whileTap={{ scale: 0.96 }}
                                onMouseEnter={() => setHoveredMappingType(entry.label)}
                                onClick={() => handleOpenDrawerWithTab(entry.tab)}
                                className={`w-[49px] h-[49px] rounded-[11px] border-[1.5px] flex items-center justify-center transition-all cursor-pointer ${
                                  isHovered
                                    ? 'bg-[#0051ff] border-[#0051ff] text-black shadow-[0_4px_14px_rgba(0,81,255,0.35)]'
                                    : 'bg-white border-transparent hover:border-[#0051ff] text-[#444444] shadow-[0_1px_3px_rgba(0,0,0,0.04)]'
                                }`}
                              >
                                <IsometricKeyIcon
                                  type={entry.icon}
                                  active={isHovered}
                                />
                              </motion.button>
                            </motion.div>
                          );
                        })}
                      </motion.div>
                    )}
                </div>
              </motion.div>
            ) : (
              <div />
            )}
          </div>

          {/* CENTERPIECE: MOVABLE GRID MACRO 1 (3x3 KEYS + ONE ROTARY ENCODER) */}
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-10">
            <motion.div
              ref={macropadMoveUnitRef}
              animate={{ x: macropadOffset.x, y: macropadOffset.y }}
              transition={
                isDraggingMacropad
                  ? { type: 'spring', stiffness: 650, damping: 42, mass: 0.5 }
                  : { type: 'spring', stiffness: 320, damping: 40 }
              }
              className="flex flex-col items-center pointer-events-auto select-none"
            >
              <motion.div
                {...getEntranceMotionProps(entrancePhase, {
                  delay: 0.3,
                  duration: 0.5,
                  fadeOnly: true,
                })}
                onPointerDown={handleStartMacropadMove}
                onDoubleClick={handleResetMacropadCenter}
                className={
                  isDraggingMacropad ? 'cursor-grabbing' : 'cursor-grab'
                }
              >
                <MacropadDevice
                  layer={currentLayer}
                  selectedKey={selectedKey}
                  selectedEncoderSub={selectedEncoderSub}
                  dragOverTarget={dragOverTarget}
                  draggedFromSlot={draggedTile?.fromSlotId || null}
                  encoderAngle={encoderAngle}
                  onSelectKey={handleSelectKey}
                  onSelectEncoderSub={handleSelectEncoderSubAction}
                  onStartKeyDrag={handleStartMacropadKeyDrag}
                  entrancePhase={entrancePhase}
                />
              </motion.div>

              <motion.button
                {...getEntranceMotionProps(entrancePhase, {
                  delay: 1.2,
                  duration: 0.42,
                  offsetY: 8,
                  initialScale: 0.99,
                })}
                onClick={() => void toggleSimulationMode()}
                disabled={simulationTransition}
                className="mt-[15px] h-[28px] w-[124px] justify-center px-[12px] bg-white hover:bg-neutral-50 rounded-full border-[1.5px] border-transparent hover:border-[#0051ff] shadow-[0_1px_3px_rgba(0,0,0,0.06)] flex items-center gap-[6px] text-[#3a3a3a] text-[11px] font-medium transition-all cursor-pointer"
              >
                <span
                  className={`w-[8px] h-[8px] rounded-full transition-colors ${
                    simulationMode ? 'bg-[#0051ff]' : 'bg-[#b5b5b5]'
                  }`}
                />
                <span>{simulationMode ? 'Simulation on' : 'Simulation off'}</span>
              </motion.button>
            </motion.div>
          </div>

          {/* BOTTOM-LEFT TIP WIDGET */}
          <motion.div
            {...getEntranceMotionProps(entrancePhase, {
              delay: 0.35,
              duration: 0.4,
              fadeOnly: true,
            })}
            className="px-[27px] pb-[24px] flex items-start"
          >
            <div
              onClick={() => setTipIndex((i) => (i + 1) % TIPS.length)}
              className="flex items-start gap-[10px] cursor-pointer group h-[54px] shrink-0"
              title="Click for next tip"
            >
              <div className="pt-[3px] flex flex-col gap-[5px]">
                {[0, 1, 2].map((dotIdx) => (
                  <span
                    key={dotIdx}
                    className={`w-[4px] h-[4px] rounded-full transition-colors duration-300 ${
                      TIPS[tipIndex].dot === dotIdx ? 'bg-[#9e9e9e]' : 'bg-[#d0d0d0]'
                    }`}
                  />
                ))}
              </div>

              <div className="text-[#a3a3a3] text-[11px] leading-[1.35] font-normal">
                <div className="mb-[5px]">Tip:</div>
                <AnimatePresence mode="wait">
                  <motion.div
                    key={tipIndex}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.45, ease: 'easeInOut' }}
                  >
                    {TIPS[tipIndex].lines.map((line, idx) => (
                      <div key={idx}>{line}</div>
                    ))}
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
          </motion.div>

          {/* =============================================================== */}
          {/* FULL-HEIGHT RIGHT KEY MAPPING DRAWER (FLUSH TO NAVBAR)          */}
          {/* =============================================================== */}
          <AnimatePresence>
            {mappingDrawerOpen && (
              <motion.aside
                key="key-mapping-drawer"
                initial={{ x: '100%', opacity: 0.6 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: '100%', opacity: 0 }}
                transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
                className="absolute top-0 bottom-0 right-0 w-[332px] bg-[#efefef] rounded-l-[20px] rounded-r-none shadow-[-8px_0_24px_rgba(0,0,0,0.08)] border-l border-black/[0.04] flex flex-col z-30 overflow-hidden"
              >
                <AnimatePresence mode="wait" initial={false}>
                  {creatorModalTab ? (
                    /* =========================================================== */
                    /* IN-DRAWER EDITOR: MULTI ACTION EDITING / ACTION EDITING     */
                    /* =========================================================== */
                    <motion.div
                      key={`creator-editor-${creatorModalTab}`}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.26, ease: 'easeInOut' }}
                      className="flex-1 flex flex-col overflow-y-auto px-[15px] pt-[18px] pb-[16px] relative"
                    >
                      {/* Top Header: <- (left) | Title (i) (center) */}
                    <div className="flex items-center justify-between shrink-0 mb-[16px] relative">
                      <button
                        onClick={() => {
                          setIconPickerOpen(false);
                          setActiveGestureDropdown(null);
                          setCreatorModalTab(null);
                        }}
                        aria-label="Back to Key Mapping"
                        className="w-6 h-6 rounded-full border-[1.5px] border-transparent hover:border-[#0051ff] flex items-center justify-center text-[#555555] hover:text-black transition-all cursor-pointer"
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M13 8H3M3 8L7 4M3 8L7 12" />
                        </svg>
                      </button>

                      <div className="flex items-center gap-[5px] text-[#555555] text-[12.5px] font-medium">
                        <span>
                          {creatorModalTab === 'Multi-A'
                            ? 'Multi Action editing'
                            : 'Action editing'}
                        </span>
                        <button
                          onMouseEnter={() => setActiveTooltip('drawer-mapping')}
                          onMouseLeave={() => setActiveTooltip(null)}
                          onClick={() =>
                            setActiveTooltip(
                              activeTooltip === 'drawer-mapping'
                                ? null
                                : 'drawer-mapping'
                            )
                          }
                          className="text-[#666666] hover:text-[#222] cursor-pointer"
                        >
                          <InfoCircleIcon />
                        </button>
                      </div>

                      <div className="w-6" />

                      <AnimatePresence>
                        {activeTooltip === 'drawer-mapping' && (
                          <motion.div
                            initial={{ opacity: 0, y: -4, scale: 0.96 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: -4, scale: 0.96 }}
                            transition={{ duration: 0.16, ease: [0.32, 0.72, 0, 1] }}
                            className="absolute top-[28px] right-[4px] w-[226px] bg-[#ececec] rounded-[16px] px-[18px] py-[15px] shadow-[0_3px_10px_rgba(0,0,0,0.06)] border border-black/[0.04] text-left z-50 pointer-events-none"
                          >
                            <div className="text-[13px] font-semibold text-[#5e5e5e] mb-[7px]">
                              {creatorModalTab === 'Multi-A'
                                ? 'Multi Action editing'
                                : 'Action editing'}
                            </div>
                            <p className="text-[11px] leading-[1.36] text-[#686868]">
                              {creatorModalTab === 'Multi-A'
                                ? 'Configure up to 4 gesture triggers (On Tap, Double Tap, On Hold, Tap + Hold) and assign an icon.'
                                : 'Create a custom Smart Action or macro, pick an icon or emoji, and save it to your library.'}
                            </p>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                    {/* Identity Row: 62x62 Icon Button + Name Input + Save/Discard/Delete */}
                    <div className="flex items-start gap-[10px] shrink-0 relative">
                      <button
                        onClick={() => void handleToggleIconPicker()}
                        title="Select Icon or Emoji"
                        className="w-[62px] h-[62px] rounded-[12px] bg-[#2f2f2f] hover:bg-[#252525] border-[1.5px] border-transparent hover:border-[#0051ff] flex items-center justify-center text-white shrink-0 transition-all cursor-pointer"
                      >
                        {selectedIconId ? (
                          <CustomPickerIcon id={selectedIconId} size={26} />
                        ) : selectedEmoji ? (
                          <span className="text-[26px] leading-none">
                            {selectedEmoji}
                          </span>
                        ) : (
                          <svg
                            width="26"
                            height="26"
                            viewBox="0 0 26 26"
                            fill="none"
                            stroke="white"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                          >
                            <circle cx="13" cy="13" r="11" />
                            <path d="M13 8.5V17.5M8.5 13H17.5" />
                          </svg>
                        )}
                      </button>

                      <div className="flex-1 flex flex-col gap-[8px] min-w-0">
                        {/* Editable Name Input Pill */}
                        <div className="h-[25px] rounded-full bg-[#e2e2e2] px-[10px] flex items-center gap-[6px]">
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 12 12"
                            fill="none"
                            stroke="#666666"
                            strokeWidth="1.3"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="shrink-0"
                          >
                            <path d="M8.5 1.5L10.5 3.5L4 10H2V8L8.5 1.5Z" />
                          </svg>
                          <input
                            type="text"
                            value={newCustomName}
                            onChange={(e) => setNewCustomName(e.target.value)}
                            placeholder={
                              creatorModalTab === 'Multi-A'
                                ? 'My Multiaction'
                                : creatorModalTab === 'Smart-A'
                                ? 'My Smart action'
                                : 'My Action'
                            }
                            className="w-full bg-transparent text-[11px] text-[#444444] placeholder:text-[#888888] focus:outline-none"
                          />
                        </div>

                        {/* Save (Green Hover) | Discard (Yellow/Orange Hover) | Delete (Red Hover) */}
                        {(() => {
                          const canSave =
                            creatorModalTab === 'Action'
                              ? actionAdvanceMode
                                ? actionAdvanceSteps.some(
                                    (s) => !!s.keyLabel.trim()
                                  )
                                : actionTokens.length > 0
                              : creatorModalTab === 'Multi-A'
                              ? Object.values(multiGestures).some(
                                  (v) => !!v.trim()
                                )
                              : smartSubTab === 'App'
                                ? !!selectedSmartApplication
                                : smartSubTab === 'Text'
                                  ? !!smartTextValue.trim()
                                  : smartSubTab === 'Cmd'
                                    ? !!smartCmdValue.trim()
                                    : !!smartWebValue.trim();
                          const canDelete = !!editingCustomItemId;

                          return (
                            <AnimatePresence mode="popLayout" initial={false}>
                              {customItemDeleteConfirm && canDelete ? (
                                <motion.div
                                  key="creator-delete-confirm"
                                  layout
                                  initial={{ opacity: 0, scale: 0.9, y: 3 }}
                                  animate={{ opacity: 1, scale: 1, y: 0 }}
                                  exit={{ opacity: 0, scale: 0.9, y: -3 }}
                                  transition={{
                                    type: 'spring',
                                    stiffness: 540,
                                    damping: 30,
                                    mass: 0.65,
                                  }}
                                  className="flex items-center gap-[6px]"
                                >
                                  <motion.button
                                    type="button"
                                    layout
                                    initial={{ opacity: 0, x: -10, scale: 0.88 }}
                                    animate={{ opacity: 1, x: 0, scale: 1 }}
                                    exit={{ opacity: 0, x: -8, scale: 0.88 }}
                                    whileHover={{ scale: 1.04 }}
                                    whileTap={{ scale: 0.94 }}
                                    onClick={() => setCustomItemDeleteConfirm(false)}
                                    className="h-[29px] px-[12px] rounded-full bg-white hover:bg-neutral-50 border-[1.5px] border-transparent hover:border-[#0051ff] text-[10.5px] font-medium text-[#444444] shadow-[0_1px_3px_rgba(0,0,0,0.06)] cursor-pointer shrink-0"
                                  >
                                    Cancel
                                  </motion.button>
                                  <motion.button
                                    type="button"
                                    layout
                                    initial={{ opacity: 0, x: 14, scale: 0.86 }}
                                    animate={{ opacity: 1, x: 0, scale: 1 }}
                                    exit={{ opacity: 0, x: 12, scale: 0.86 }}
                                    whileHover={{
                                      scale: 1.03,
                                      boxShadow: '0 5px 16px rgba(220, 0, 0, 0.34)',
                                    }}
                                    whileTap={{ scale: 0.95 }}
                                    onClick={handleDeleteCustomItem}
                                    className="flex-1 h-[29px] rounded-full bg-gradient-to-r from-[#e01b24] via-[#ff2934] to-[#c40000] text-white text-[10.5px] font-semibold flex items-center justify-center gap-[5px] shadow-[0_2px_10px_rgba(220,0,0,0.26)] cursor-pointer"
                                  >
                                    <motion.svg
                                      width="11"
                                      height="11"
                                      viewBox="0 0 16 16"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="1.6"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      initial={{ rotate: -16, scale: 0.85 }}
                                      animate={{ rotate: [0, -14, 10, -6, 0], scale: 1 }}
                                      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                                      className="shrink-0"
                                    >
                                      <path d="M2.5 4.2H13.5" />
                                      <path d="M5.8 4.2V2.8C5.8 2.35 6.15 2 6.6 2H9.4C9.85 2 10.2 2.35 10.2 2.8V4.2" />
                                      <path d="M4.2 4.2L4.8 13C4.85 13.55 5.3 14 5.85 14H10.15C10.7 14 11.15 13.55 11.2 13L11.8 4.2" />
                                    </motion.svg>
                                    <span>Click to delete</span>
                                  </motion.button>
                                </motion.div>
                              ) : (
                                <motion.div
                                  key="creator-normal-actions"
                                  layout
                                  initial={{ opacity: 0, scale: 0.95 }}
                                  animate={{ opacity: 1, scale: 1 }}
                                  exit={{ opacity: 0, scale: 0.95 }}
                                  transition={{
                                    type: 'spring',
                                    stiffness: 520,
                                    damping: 32,
                                    mass: 0.65,
                                  }}
                                  className="grid grid-cols-3 gap-[6px]"
                                >
                                  <motion.button
                                    type="button"
                                    whileHover={canSave ? { scale: 1.03 } : undefined}
                                    whileTap={canSave ? { scale: 0.95 } : undefined}
                                    disabled={!canSave}
                                    onClick={handleSaveCustomItem}
                                    className={`h-[29px] rounded-full text-[10.5px] font-medium transition-colors ${
                                      canSave
                                        ? 'bg-white text-[#444444] hover:bg-[#2ec27e] hover:text-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] cursor-pointer'
                                        : 'bg-[#dadada] text-[#b0b0b0] cursor-not-allowed'
                                    }`}
                                  >
                                    Save
                                  </motion.button>
                                  <motion.button
                                    type="button"
                                    whileHover={canSave ? { scale: 1.03 } : undefined}
                                    whileTap={canSave ? { scale: 0.95 } : undefined}
                                    disabled={!canSave}
                                    onClick={handleDiscardCustomItem}
                                    className={`h-[29px] rounded-full text-[10.5px] font-medium transition-colors ${
                                      canSave
                                        ? 'bg-white text-[#444444] hover:bg-[#f59e0b] hover:text-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] cursor-pointer'
                                        : 'bg-[#dadada] text-[#b0b0b0] cursor-not-allowed'
                                    }`}
                                  >
                                    Discard
                                  </motion.button>
                                  <motion.button
                                    type="button"
                                    whileHover={canDelete ? { scale: 1.04 } : undefined}
                                    whileTap={canDelete ? { scale: 0.94 } : undefined}
                                    disabled={!canDelete}
                                    onClick={() => setCustomItemDeleteConfirm(true)}
                                    className={`h-[29px] rounded-full text-[10.5px] font-medium transition-colors ${
                                      canDelete
                                        ? 'bg-white text-[#444444] hover:bg-[#e01b24] hover:text-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] cursor-pointer'
                                        : 'bg-[#dadada] text-[#b0b0b0] cursor-not-allowed'
                                    }`}
                                  >
                                    Delete
                                  </motion.button>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          );
                        })()}
                      </div>

                      {/* ======================================================= */}
                      {/* SELECT ICON / EMOJI POPOVER DRAWER (Screenshot 2)       */}
                      {/* ======================================================= */}
                      <AnimatePresence>
                        {iconPickerOpen && (
                          <motion.div
                            initial={{ opacity: 0, y: -6, scale: 0.96 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: -6, scale: 0.96 }}
                            transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
                            className="absolute top-[68px] left-0 w-[216px] bg-[#efefef] rounded-[18px] p-[11px] shadow-[0_8px_28px_rgba(0,0,0,0.16)] border border-black/[0.06] z-50"
                          >
                            <div className="flex items-center justify-between mb-[10px]">
                              <button
                                onClick={() => setIconPickerOpen(false)}
                                className="w-[22px] h-[22px] rounded-full border-[1.5px] border-transparent hover:border-[#0051ff] flex items-center justify-center text-[#555555] hover:text-black transition-all cursor-pointer"
                              >
                                <X className="w-[13px] h-[13px] stroke-[1.8]" />
                              </button>
                              <span className="text-[11px] font-medium text-[#555555]">
                                Select Icon
                              </span>
                              <div className="w-5" />
                            </div>

                            {/* Icon | Emoji Segmented Toggle */}
                            <div className="h-[26px] rounded-full bg-white flex overflow-hidden mb-[8px] shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
                              {(['Icon', 'Emoji'] as const).map((t) => (
                                <button
                                  key={t}
                                  onClick={() => void handleIconPickerTabChange(t)}
                                  className={`flex-1 h-full text-[10.5px] font-medium transition-colors cursor-pointer ${
                                    iconPickerTab === t
                                      ? 'bg-[#000000] text-white rounded-full'
                                      : 'text-[#555555] hover:text-black'
                                  }`}
                                >
                                  {t}
                                </button>
                              ))}
                            </div>

                            {/* Search Icon / Emoji */}
                            <div className="h-[25px] rounded-full bg-white px-[9px] flex items-center gap-[5px] mb-[8px] shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
                              <Search className="w-[10px] h-[10px] text-[#666666] stroke-[2] shrink-0" />
                              <input
                                type="text"
                                value={iconPickerSearch}
                                onChange={(e) => {
                                  setIconPickerSearch(e.target.value);
                                  setIconPickerPage(0);
                                }}
                                placeholder={
                                  iconPickerTab === 'Icon'
                                    ? 'Search icon'
                                    : 'Search emoji'
                                }
                                className="w-full bg-transparent text-[10px] text-[#333333] placeholder:text-[#a0a0a0] focus:outline-none"
                              />
                            </div>

                            {/* Grid of Real Icons or Real Emojis */}
                            <div className="bg-white rounded-[14px] p-[8px] h-[196px] overflow-y-auto list-accordion-scroll grid grid-cols-6 gap-[6px] content-start">
                              {iconPickerTab === 'Icon' ? (
                                iconSearchResults.icons.length > 0 ? (
                                  iconSearchResults.icons.map((ic) => {
                                    const isChosen = selectedIconId === ic.id;
                                    return (
                                      <button
                                        key={ic.id}
                                        onClick={() => {
                                          setSelectedIconId(ic.id);
                                          setSelectedEmoji(undefined);
                                          setIconPickerOpen(false);
                                        }}
                                        title={ic.id}
                                        aria-label={`Select icon ${ic.id.replaceAll('-', ' ')}`}
                                        aria-pressed={isChosen}
                                        className={`w-[26px] h-[26px] rounded-full flex items-center justify-center transition-colors cursor-pointer ${
                                          isChosen
                                            ? 'bg-[#0051ff] text-white'
                                            : 'bg-[#dcdcdc] text-[#444444] hover:bg-[#0051ff] hover:text-white'
                                        }`}
                                      >
                                        <CustomPickerIcon id={ic.id} size={13} />
                                      </button>
                                    );
                                  })
                                ) : (
                                  <p className="col-span-6 py-4 text-center text-[10px] text-[#777777]">
                                    No icons found
                                  </p>
                                )
                              ) : (
                                selectableEmojiList
                                  .filter(
                                    (em) =>
                                      !iconPickerSearch.trim() ||
                                      em.keywords
                                        .toLowerCase()
                                        .includes(iconPickerSearch.toLowerCase()) ||
                                      em.emoji.includes(iconPickerSearch)
                                  )
                                  .map((em) => {
                                    const isChosen = selectedEmoji === em.emoji;
                                    return (
                                      <button
                                        key={em.emoji}
                                        onClick={() => {
                                          setSelectedEmoji(em.emoji);
                                          setSelectedIconId(undefined);
                                          setIconPickerOpen(false);
                                        }}
                                        title={em.keywords.split(' ')[0]}
                                        className={`w-[26px] h-[26px] rounded-full flex items-center justify-center text-[14px] transition-colors cursor-pointer ${
                                          isChosen
                                            ? 'bg-[#0051ff] text-white'
                                            : 'bg-[#efefef] hover:bg-[#0051ff]'
                                        }`}
                                      >
                                        {em.emoji}
                                      </button>
                                    );
                                  })
                              )}
                            </div>
                            {iconPickerTab === 'Icon' && (
                              <div className="mt-[7px] flex min-h-[17px] items-center justify-between px-[3px]">
                                {!iconPickerSearch.trim() && !iconPickerShowAll ? (
                                  <button
                                    onClick={() => {
                                      setIconPickerShowAll(true);
                                      setIconPickerPage(0);
                                    }}
                                    className="text-[9px] font-medium text-[#0051ff] hover:underline cursor-pointer"
                                  >
                                    Browse all {iconCatalog.length.toLocaleString()} icons
                                  </button>
                                ) : (
                                  <>
                                    <span className="text-[8px] text-[#777777]" aria-live="polite">
                                      Showing{' '}
                                      {iconSearchResults.total === 0
                                        ? '0'
                                        : `${(iconPickerPage * ICON_SEARCH_PAGE_SIZE + 1).toLocaleString()}–${Math.min(
                                            (iconPickerPage + 1) * ICON_SEARCH_PAGE_SIZE,
                                            iconSearchResults.total
                                          ).toLocaleString()}`}{' '}
                                      of {iconSearchResults.total.toLocaleString()}
                                    </span>
                                    <div className="flex items-center gap-[4px]">
                                      {iconPickerPage > 0 && (
                                        <button
                                          aria-label="Previous icon results"
                                          title="Previous icons"
                                          onClick={() =>
                                            setIconPickerPage((page) => Math.max(0, page - 1))
                                          }
                                          className="w-[18px] h-[18px] rounded-full text-[12px] text-[#555555] hover:bg-[#e8e8e8] cursor-pointer"
                                        >
                                          ‹
                                        </button>
                                      )}
                                      {(iconPickerPage + 1) * ICON_SEARCH_PAGE_SIZE <
                                        iconSearchResults.total && (
                                        <button
                                          aria-label="Next icon results"
                                          title="Next icons"
                                          onClick={() => setIconPickerPage((page) => page + 1)}
                                          className="w-[18px] h-[18px] rounded-full text-[12px] text-[#555555] hover:bg-[#e8e8e8] cursor-pointer"
                                        >
                                          ›
                                        </button>
                                      )}
                                    </div>
                                  </>
                                )}
                              </div>
                            )}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                    {/* Notched Center Horizontal Divider Line */}
                    <div className="my-[12px] w-full shrink-0">
                      <svg
                        width="100%"
                        height="12"
                        viewBox="0 0 302 12"
                        fill="none"
                        preserveAspectRatio="none"
                      >
                        <path
                          d="M 0 1.5 H 136 C 142 1.5 144 10 151 10 C 158 10 160 1.5 166 1.5 H 302"
                          stroke="#dcdcdc"
                          strokeWidth="1.2"
                        />
                      </svg>
                    </div>

                    {/* ========================================================= */}
                    {/* EDITOR BODY: MULTI-A vs SMART-A vs ACTION                 */}
                    {/* ========================================================= */}
                    {creatorModalTab === 'Multi-A' ? (
                      <div className="flex-1 flex flex-col">
                        {/* 4 Gesture Assignment Rows */}
                        <div className="space-y-[7px] mb-[12px]">
                          {(
                            [
                              { key: 'onTap', label: 'On Tap' },
                              { key: 'doubleTap', label: 'Double Tap' },
                              { key: 'onHold', label: 'On Hold' },
                              { key: 'tapHold', label: 'Tap + Hold' },
                            ] as { key: MultiGestureKey; label: string }[]
                          ).map((gesture) => {
                            const isDropdownOpen =
                              activeGestureDropdown === gesture.key;
                            const assignedVal = multiGestures[gesture.key];
                            return (
                              <div
                                key={gesture.key}
                                className="h-[44px] rounded-full border border-[#dedede] bg-transparent pl-[14px] pr-[8px] flex items-center justify-between relative"
                              >
                                <span className="text-[11px] text-[#555555] font-normal">
                                  {gesture.label}
                                </span>

                                <div className="flex items-center gap-[5px] relative">
                                  <button
                                    onClick={() => {
                                      if (isDropdownOpen) {
                                        setActiveGestureDropdown(null);
                                      } else {
                                        setActiveGestureDropdown(gesture.key);
                                        setGestureKeySearch('');
                                      }
                                    }}
                                    className={`w-[126px] h-[25px] rounded-full bg-white px-[11px] flex items-center justify-between text-[10px] text-[#555555] shadow-[0_1px_2px_rgba(0,0,0,0.03)] border transition-colors cursor-pointer ${
                                      isDropdownOpen
                                        ? 'border-[#0051ff]'
                                        : 'border-transparent hover:border-[#0051ff]'
                                    }`}
                                  >
                                    <span className="truncate">
                                      {assignedVal || 'Click to assign'}
                                    </span>
                                    {isDropdownOpen ? (
                                      <ChevronUp className="w-[11px] h-[11px] text-[#444] shrink-0" />
                                    ) : (
                                      <ChevronDown className="w-[11px] h-[11px] text-[#444] shrink-0" />
                                    )}
                                  </button>

                                  <button
                                    onClick={() =>
                                      setMultiGestures((prev) => ({
                                        ...prev,
                                        [gesture.key]: '',
                                      }))
                                    }
                                    title="Clear assignment"
                                    className="w-[24px] h-[24px] rounded-full bg-white hover:bg-neutral-100 border-[1.5px] border-transparent hover:border-[#0051ff] flex items-center justify-center text-[#777777] hover:text-black shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-all cursor-pointer"
                                  >
                                    <X className="w-[11px] h-[11px] stroke-[1.7]" />
                                  </button>

                                  {/* ================================================= */}
                                  {/* CLICK TO ASSIGN KEY DROPDOWN (Screenshots 3-5)    */}
                                  {/* ================================================= */}
                                  <AnimatePresence>
                                    {isDropdownOpen && (
                                      <motion.div
                                        initial={{ opacity: 0, y: -4, scale: 0.96 }}
                                        animate={{ opacity: 1, y: 0, scale: 1 }}
                                        exit={{ opacity: 0, y: -4, scale: 0.96 }}
                                        transition={{
                                          duration: 0.16,
                                          ease: [0.32, 0.72, 0, 1],
                                        }}
                                        className="absolute top-[30px] left-0 w-[154px] bg-white rounded-[16px] shadow-[0_6px_20px_rgba(0,0,0,0.12)] border border-black/[0.05] overflow-hidden z-50"
                                      >
                                        {/* Top Search Bar */}
                                        <div className="h-[30px] bg-[#e6e6e6] px-[10px] flex items-center gap-[6px]">
                                          <Search className="w-[10.5px] h-[10.5px] text-[#555555] stroke-[2] shrink-0" />
                                          <input
                                            type="text"
                                            value={gestureKeySearch}
                                            onChange={(e) =>
                                              setGestureKeySearch(e.target.value)
                                            }
                                            placeholder="Search a key"
                                            className="w-full bg-transparent text-[10px] text-[#333333] placeholder:text-[#9c9c9c] focus:outline-none"
                                          />
                                        </div>

                                        {/* Accordion Categories with Blue Hover & Active */}
                                        <div className="max-h-[268px] overflow-y-auto list-accordion-scroll divide-y divide-[#eeeeee]">
                                          {BASIC_KEY_SECTIONS.map((sec) => {
                                            const matchingItems = sec.items.filter(
                                              (it) => {
                                                if (!gestureKeySearch.trim())
                                                  return true;
                                                const q =
                                                  gestureKeySearch.toLowerCase();
                                                const lbl = (
                                                  it.listLabel ||
                                                  it.main.replace(/\n/g, ' ')
                                                ).toLowerCase();
                                                return lbl.includes(q);
                                              }
                                            );
                                            if (matchingItems.length === 0)
                                              return null;

                                            const isSecOpen =
                                              expandedGestureSection === sec.title ||
                                              !!gestureKeySearch.trim();

                                            return (
                                              <div key={sec.title}>
                                                <button
                                                  onClick={() =>
                                                    setExpandedGestureSection(
                                                      expandedGestureSection ===
                                                        sec.title
                                                        ? null
                                                        : sec.title
                                                    )
                                                  }
                                                  className={`w-full h-[30px] px-[11px] flex items-center justify-between text-[10.5px] font-normal transition-colors cursor-pointer ${
                                                    isSecOpen
                                                      ? 'bg-[#0051ff] text-white'
                                                      : 'bg-white text-[#555555] hover:bg-[#0051ff] hover:text-white'
                                                  }`}
                                                >
                                                  <span className="truncate">
                                                    {sec.title}
                                                  </span>
                                                  {isSecOpen ? (
                                                    <ChevronUp className="w-[11px] h-[11px] shrink-0" />
                                                  ) : (
                                                    <ChevronDown className="w-[11px] h-[11px] shrink-0" />
                                                  )}
                                                </button>

                                                <AnimatePresence initial={false}>
                                                  {isSecOpen && (
                                                    <motion.div
                                                      initial={{ height: 0, opacity: 0 }}
                                                      animate={{ height: 'auto', opacity: 1 }}
                                                      exit={{ height: 0, opacity: 0 }}
                                                      transition={{
                                                        duration: 0.2,
                                                        ease: [0.22, 1, 0.36, 1],
                                                      }}
                                                      className="bg-white py-[2px] overflow-hidden"
                                                    >
                                                      {matchingItems.map((it) => {
                                                        const itemName =
                                                          it.listLabel ||
                                                          it.main.replace(/\n/g, ' ');
                                                        return (
                                                          <button
                                                            key={it.id}
                                                            onClick={() => {
                                                              setMultiGestures(
                                                                (prev) => ({
                                                                  ...prev,
                                                                  [gesture.key]:
                                                                    it.isClearIcon
                                                                      ? ''
                                                                      : itemName,
                                                                })
                                                              );
                                                              setActiveGestureDropdown(
                                                                null
                                                              );
                                                            }}
                                                            className="w-full h-[26px] px-[12px] text-left text-[10.5px] text-[#555555] hover:bg-[#0051ff] hover:text-white transition-colors flex items-center cursor-pointer"
                                                          >
                                                            {itemName}
                                                          </button>
                                                        );
                                                      })}
                                                    </motion.div>
                                                  )}
                                                </AnimatePresence>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      </motion.div>
                                    )}
                                  </AnimatePresence>
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {/* Tapping term (ms) — aligned inside under Click to assign */}
                        <div className="pl-[14px] pr-[8px] flex items-center justify-between mb-[10px]">
                          <span className="text-[10.5px] text-[#555555]">
                            Tapping term (ms)
                          </span>
                          <div className="w-[155px] flex items-center justify-start">
                            <div
                              onClick={(e) => {
                                const inp = e.currentTarget.querySelector(
                                  'input'
                                ) as HTMLInputElement | null;
                                inp?.focus();
                              }}
                              className="h-[25px] px-[11px] rounded-full bg-white flex items-center gap-[12px] text-[10.5px] text-[#555555] shadow-[0_1px_2px_rgba(0,0,0,0.03)] cursor-text"
                            >
                              <input
                                type="text"
                                inputMode="numeric"
                                value={tappingTermMs}
                                onChange={(e) =>
                                  setTappingTermMs(
                                    e.target.value.replace(/[^0-9]/g, '')
                                  )
                                }
                                onBlur={() => {
                                  if (!tappingTermMs.trim()) {
                                    setTappingTermMs('250');
                                  }
                                }}
                                onKeyDown={(e) => {
                                  e.stopPropagation();
                                  if (e.key === 'Enter') {
                                    if (!tappingTermMs.trim()) {
                                      setTappingTermMs('250');
                                    }
                                    e.currentTarget.blur();
                                  }
                                }}
                                style={{
                                  width: `${Math.max(
                                    2,
                                    (tappingTermMs || '250').length
                                  )}ch`,
                                }}
                                className="min-w-[20px] max-w-[44px] bg-transparent text-left text-[10.5px] text-[#444444] focus:outline-none tabular-nums"
                              />
                              <span className="text-[#555555] select-none">
                                ms
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="pl-[6px] text-[10.5px] text-[#555555] mb-[14px]">
                          Hold 1sec to perform the assigned function
                        </div>

                        {/* Dashed Hint Box */}
                        <div className="flex-1 min-h-[190px] rounded-[20px] border border-dashed border-[#cfcfcf] px-[26px] py-[20px] flex flex-col justify-center">
                          <h4 className="text-[14.5px] font-semibold text-[#555555] mb-[8px]">
                            Hint
                          </h4>
                          <p className="text-[10.5px] leading-[1.36] text-[#666666] mb-[22px]">
                            Assign a key or action to each gesture — tap, double-tap, hold, and tap + hold — then bind the multiaction to a button.
                          </p>
                          <button
                            onClick={() =>
                              showToast('Multiactions documentation opened')
                            }
                            className="text-[10.5px] text-[#5c5c5c] underline underline-offset-2 hover:text-black text-center cursor-pointer"
                          >
                            Discover more about Multiactions
                          </button>
                        </div>
                      </div>
                    ) : creatorModalTab === 'Smart-A' ? (
                      /* ========================================================= */
                      /* SMART ACTION EDITOR (Text | Cmd | Web | App)              */
                      /* ========================================================= */
                      <div className="flex-1 flex flex-col">
                        {/* 4 Sub-Tab Pills with Blue Hover */}
                        <div className="grid grid-cols-4 gap-[6px] mb-[10px] shrink-0">
                          {(['Text', 'Cmd', 'Web', 'App'] as const).map((sub) => {
                            const isSubActive = smartSubTab === sub;
                            return (
                              <button
                                key={sub}
                                onClick={() => {
                                  setSmartSubTab(sub);
                                  if (sub === 'App') {
                                    setSmartAppDropdownOpen(true);
                                    if (smartSubTab === 'App') void loadInstalledApplications();
                                  } else {
                                    setSmartAppDropdownOpen(false);
                                  }
                                }}
                                className={`h-[26px] rounded-full text-[10.5px] font-medium border-[1.5px] transition-all cursor-pointer ${
                                  isSubActive
                                    ? 'bg-[#000000] text-white border-[#000000] hover:border-[#0051ff]'
                                    : 'bg-white text-[#444444] border-transparent hover:border-[#0051ff] hover:text-[#0051ff]'
                                }`}
                              >
                                {sub}
                              </button>
                            );
                          })}
                        </div>

                        <AnimatePresence mode="wait" initial={false}>
                          {/* Sub-Tab 1: Text (Screenshot 6) */}
                          {smartSubTab === 'Text' && (
                            <motion.div
                              key="smart-sub-text"
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              exit={{ opacity: 0 }}
                              transition={{ duration: 0.24, ease: 'easeInOut' }}
                              className="flex-1 flex flex-col"
                            >
                              <textarea
                                value={smartTextValue}
                                onChange={(e) => setSmartTextValue(e.target.value)}
                                placeholder="Add your text here..."
                                className="w-full h-[112px] rounded-[14px] bg-[#e2e2e2] p-[12px] text-[10.5px] text-[#333333] placeholder:text-[#9c9c9c] resize-none focus:outline-none focus:ring-1 focus:ring-[#0051ff] mb-[12px] shrink-0"
                              />
                              <div className="flex-1 min-h-[210px] rounded-[20px] border border-dashed border-[#cfcfcf] px-[26px] py-[20px] flex flex-col justify-center">
                                <h4 className="text-[14.5px] font-semibold text-[#555555] mb-[8px]">
                                  Hint
                                </h4>
                                <p className="text-[10.5px] leading-[1.36] text-[#666666] mb-[22px]">
                                  Type or paste any phrase. When you press the assigned key, Input types it out for you.
                                </p>
                                <button
                                  onClick={() =>
                                    showToast('Smart Actions documentation opened')
                                  }
                                  className="text-[10.5px] text-[#5c5c5c] underline underline-offset-2 hover:text-black text-center cursor-pointer"
                                >
                                  Discover more about Smart Actions
                                </button>
                              </div>
                            </motion.div>
                          )}

                          {/* Sub-Tab 2: Cmd (Screenshot 7) */}
                          {smartSubTab === 'Cmd' && (
                            <motion.div
                              key="smart-sub-cmd"
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              exit={{ opacity: 0 }}
                              transition={{ duration: 0.24, ease: 'easeInOut' }}
                              className="flex-1 flex flex-col"
                            >
                              <textarea
                                value={smartCmdValue}
                                onChange={(e) => setSmartCmdValue(e.target.value)}
                                placeholder="Type your command here..."
                                className="w-full h-[112px] rounded-[14px] bg-[#e2e2e2] p-[12px] text-[10.5px] text-[#333333] placeholder:text-[#9c9c9c] resize-y focus:outline-none focus:ring-1 focus:ring-[#0051ff] shrink-0"
                              />
                              <div className="text-[10px] text-[#8e8e8e] text-center mt-[6px]">
                                Type or paste any command you want Input to run
                              </div>
                              <p className="text-[9.5px] leading-[1.3] text-[#9a9a9a] mt-[10px]">
                                This feature can execute arbitrary commands on your system. Only continue if you trust the source and understand the risks.
                              </p>
                              <div className="mt-[8px] mb-[12px] flex items-center justify-between">
                                <span className="text-[10.5px] text-[#555555]">
                                  Enable command actions
                                </span>
                                <SettingsSwitch
                                  checked={enableCommandActions}
                                  onChange={() =>
                                    setEnableCommandActions((v) => !v)
                                  }
                                />
                              </div>
                              <div className="flex-1 min-h-[175px] rounded-[20px] border border-dashed border-[#cfcfcf] px-[26px] py-[20px] flex flex-col justify-center">
                                <h4 className="text-[14.5px] font-semibold text-[#555555] mb-[8px]">
                                  Hint
                                </h4>
                                <p className="text-[10.5px] leading-[1.36] text-[#666666] mb-[22px]">
                                  Type a command to run when you press the assigned key. Only use commands you trust.
                                </p>
                                <button
                                  onClick={() =>
                                    showToast('Smart Actions documentation opened')
                                  }
                                  className="text-[10.5px] text-[#5c5c5c] underline underline-offset-2 hover:text-black text-center cursor-pointer"
                                >
                                  Discover more about Smart Actions
                                </button>
                              </div>
                            </motion.div>
                          )}

                          {/* Sub-Tab 3: Web (Screenshot 8) */}
                          {smartSubTab === 'Web' && (
                            <motion.div
                              key="smart-sub-web"
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              exit={{ opacity: 0 }}
                              transition={{ duration: 0.24, ease: 'easeInOut' }}
                              className="flex-1 flex flex-col"
                            >
                              <input
                                type="text"
                                value={smartWebValue}
                                onChange={(e) => setSmartWebValue(e.target.value)}
                                placeholder="Type here the URL to open"
                                className="w-full h-[38px] rounded-[12px] bg-[#e2e2e2] px-[12px] text-[10.5px] text-[#333333] placeholder:text-[#9c9c9c] focus:outline-none focus:ring-1 focus:ring-[#0051ff] mb-[12px] shrink-0"
                              />
                              <div className="flex-1 min-h-[240px] rounded-[20px] border border-dashed border-[#cfcfcf] px-[26px] py-[20px] flex flex-col justify-center">
                                <h4 className="text-[14.5px] font-semibold text-[#555555] mb-[8px]">
                                  Hint
                                </h4>
                                <p className="text-[10.5px] leading-[1.36] text-[#666666] mb-[22px]">
                                  Enter a URL. Pressing the assigned key opens it in your browser.
                                </p>
                                <button
                                  onClick={() =>
                                    showToast('Smart Actions documentation opened')
                                  }
                                  className="text-[10.5px] text-[#5c5c5c] underline underline-offset-2 hover:text-black text-center cursor-pointer"
                                >
                                  Discover more about Smart Actions
                                </button>
                              </div>
                            </motion.div>
                          )}

                          {/* Sub-Tab 4: App (Screenshot 9) */}
                          {smartSubTab === 'App' && (
                            <motion.div
                              key="smart-sub-app"
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              exit={{ opacity: 0 }}
                              transition={{ duration: 0.24, ease: 'easeInOut' }}
                              className="flex-1 flex flex-col"
                            >
                              <div className="relative mb-[12px] shrink-0">
                                <div className="w-full h-[38px] rounded-[12px] bg-[#e2e2e2] px-[12px] flex items-center justify-between gap-[8px]">
                                  <Search className="w-[11px] h-[11px] text-[#9c9c9c] stroke-[1.8] shrink-0" />
                                  <input
                                    type="text"
                                    value={smartAppValue}
                                    onFocus={() => setSmartAppDropdownOpen(true)}
                                    onChange={(e) => {
                                      setSmartAppValue(e.target.value);
                                      setSelectedSmartApplication(null);
                                      setSmartAppDropdownOpen(true);
                                    }}
                                    placeholder="Search your software..."
                                    aria-label="Search installed applications"
                                    aria-expanded={smartAppDropdownOpen}
                                    aria-controls="installed-app-options"
                                    className="w-full bg-transparent text-[10.5px] text-[#333333] placeholder:text-[#9c9c9c] focus:outline-none"
                                  />
                                  <button
                                    type="button"
                                    aria-label={smartAppDropdownOpen ? 'Hide installed apps' : 'Show installed apps'}
                                    aria-expanded={smartAppDropdownOpen}
                                    onClick={() => {
                                      const shouldOpen = !smartAppDropdownOpen;
                                      setSmartAppDropdownOpen(shouldOpen);
                                      if (shouldOpen && !installedApplicationsLoading) {
                                        void loadInstalledApplications();
                                      }
                                    }}
                                    className="shrink-0 text-[#555555] hover:text-black cursor-pointer"
                                  >
                                    <svg
                                      width="11"
                                      height="11"
                                      viewBox="0 0 12 12"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="1.6"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      className={`transition-transform ${smartAppDropdownOpen ? 'rotate-90' : ''}`}
                                    >
                                      <path d="M4.5 2.5L8 6L4.5 9.5" />
                                    </svg>
                                  </button>
                                </div>

                                <AnimatePresence>
                                  {smartAppDropdownOpen && (
                                    <motion.div
                                      id="installed-app-options"
                                      role="listbox"
                                      aria-label="Installed applications"
                                      initial={{ opacity: 0, y: -4 }}
                                      animate={{ opacity: 1, y: 0 }}
                                      exit={{ opacity: 0, y: -4 }}
                                      className="absolute top-[42px] left-0 right-0 bg-white rounded-[12px] shadow-[0_6px_18px_rgba(0,0,0,0.1)] border border-black/[0.05] max-h-[150px] overflow-y-auto z-40 py-1"
                                    >
                                      {installedApplicationsLoading ? (
                                        <div role="status" className="px-3 py-2 text-[10.5px] text-[#777]">
                                          Scanning installed apps…
                                        </div>
                                      ) : installedApplicationsError ? (
                                        <div className="px-3 py-2 text-[10.5px] text-[#777]">
                                          <p>{installedApplicationsError}</p>
                                          <button
                                            type="button"
                                            onClick={() => void loadInstalledApplications()}
                                            className="mt-1 text-[#0051ff] hover:underline cursor-pointer"
                                          >
                                            Try again
                                          </button>
                                        </div>
                                      ) : filteredInstalledApplications.length > 0 ? (
                                        filteredInstalledApplications.map((application) => (
                                          <button
                                            key={application.shortcutPath}
                                            type="button"
                                            role="option"
                                            aria-selected={selectedSmartApplication?.shortcutPath === application.shortcutPath}
                                            onClick={() => {
                                              setSmartAppValue(application.name);
                                              setSelectedSmartApplication(application);
                                              setSmartAppDropdownOpen(false);
                                            }}
                                            className="w-full px-3 py-1.5 text-left text-[10.5px] text-[#444] hover:bg-[#0051ff] hover:text-white transition-colors cursor-pointer"
                                          >
                                            {application.name}
                                          </button>
                                        ))
                                      ) : smartAppValue.trim() ? (
                                        <div className="px-3 py-2 text-[10.5px] text-[#777]">
                                          No installed apps match “{smartAppValue.trim()}”.
                                        </div>
                                      ) : (
                                        <div className="px-3 py-2 text-[10.5px] text-[#777]">
                                          No apps found in the Start Menu or Desktop. Add an app shortcut, then try again.
                                        </div>
                                      )}
                                    </motion.div>
                                  )}
                                </AnimatePresence>
                              </div>

                              <div className="flex-1 min-h-[240px] rounded-[20px] border border-dashed border-[#cfcfcf] px-[26px] py-[20px] flex flex-col justify-center">
                                <h4 className="text-[14.5px] font-semibold text-[#555555] mb-[8px]">
                                  Hint
                                </h4>
                                <p className="text-[10.5px] leading-[1.36] text-[#666666] mb-[22px]">
                                  Pick an installed app. Pressing the assigned key launches it.
                                </p>
                                <button
                                  onClick={() =>
                                    showToast('Smart Actions documentation opened')
                                  }
                                  className="text-[10.5px] text-[#5c5c5c] underline underline-offset-2 hover:text-black text-center cursor-pointer"
                                >
                                  Discover more about Smart Actions
                                </button>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    ) : (
                      /* ========================================================= */
                      /* ACTION (MACRO) EDITOR — Keyboard Recorder & Advance Mode  */
                      /* ========================================================= */
                      <div className="flex-1 flex flex-col">
                        {/* Advance mode row */}
                        <div className="flex items-center gap-[10px] mb-[12px] shrink-0">
                          <span className="text-[11.5px] font-medium text-[#555555]">
                            Advance mode
                          </span>
                          <SettingsSwitch
                            checked={actionAdvanceMode}
                            onChange={() => {
                              setActionAdvanceMode((v) => !v);
                              setActiveAdvanceStepDropdown(null);
                            }}
                          />
                        </div>

                        {!actionAdvanceMode ? (
                          <div className="flex-1 flex flex-col">
                            {/* Interactive Key Recording Area */}
                            {actionRecordingStatus === 'idle' ? (
                              <button
                                type="button"
                                onClick={() => {
                                  if (
                                    document.activeElement instanceof HTMLElement
                                  ) {
                                    document.activeElement.blur();
                                  }
                                  setActionRecordingStatus('recording');
                                }}
                                className="w-full min-h-[48px] rounded-[14px] bg-[#e2e2e2] hover:bg-[#dcdcdc] px-[14px] py-[12px] flex items-center justify-center text-[11px] text-[#555555] mb-[12px] transition-colors cursor-pointer shrink-0"
                              >
                                Click here to start creating an action
                              </button>
                            ) : actionRecordingStatus === 'recording' ? (
                              <div
                                onClick={() => {
                                  if (
                                    document.activeElement instanceof HTMLElement
                                  ) {
                                    document.activeElement.blur();
                                  }
                                }}
                                className={`w-full rounded-[14px] bg-[#e2e2e2] px-[12px] py-[10px] mb-[12px] shrink-0 transition-all ${
                                  actionTokens.length > 0
                                    ? 'min-h-[76px] flex flex-col justify-between gap-[8px]'
                                    : 'min-h-[48px] flex items-center justify-end'
                                }`}
                              >
                                {actionTokens.length > 0 && (
                                  <div className="flex flex-wrap items-center gap-[6px]">
                                    {actionTokens.map((tok, idx) => (
                                      <React.Fragment key={tok.id}>
                                        {idx > 0 && (
                                          <span className="text-[11px] text-[#444444] font-medium select-none">
                                            +
                                          </span>
                                        )}
                                        <span
                                          className={`h-[25px] min-w-[25px] px-[9px] rounded-full text-[10.5px] font-medium flex items-center justify-center border ${
                                            tok.kind === 'modifier'
                                              ? 'bg-[#dcfce7] border-[#45a11c] text-[#2d6a18]'
                                              : 'bg-[#e9d5ff] border-[#9333ea] text-[#7e22ce]'
                                          }`}
                                        >
                                          {tok.label}
                                        </span>
                                      </React.Fragment>
                                    ))}
                                  </div>
                                )}

                                <div className="flex justify-end w-full">
                                  <button
                                    type="button"
                                    disabled={actionTokens.length === 0}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (actionTokens.length === 0) return;
                                      setActionRecordingStatus('confirmed');
                                    }}
                                    className={`h-[26px] px-[12px] rounded-full text-[10.5px] font-medium transition-colors ${
                                      actionTokens.length > 0
                                        ? 'bg-white text-[#333333] hover:bg-[#0051ff] hover:text-white shadow-[0_1px_2px_rgba(0,0,0,0.05)] cursor-pointer'
                                        : 'bg-[#d5d5d5] text-[#a6a6a6] cursor-default'
                                    }`}
                                  >
                                    Confirm
                                  </button>
                                </div>
                              </div>
                            ) : (
                              /* Confirmed state — shows recorded pills inside gray box without Confirm button */
                              <div
                                onClick={() => {
                                  if (
                                    document.activeElement instanceof HTMLElement
                                  ) {
                                    document.activeElement.blur();
                                  }
                                  setActionRecordingStatus('recording');
                                }}
                                title="Click to edit key sequence"
                                className="w-full min-h-[48px] rounded-[14px] bg-[#e2e2e2] hover:bg-[#dcdcdc] px-[12px] py-[10px] mb-[12px] flex flex-wrap items-center gap-[6px] shrink-0 transition-colors cursor-pointer"
                              >
                                {actionTokens.map((tok, idx) => (
                                  <React.Fragment key={tok.id}>
                                    {idx > 0 && (
                                      <span className="text-[11px] text-[#444444] font-medium select-none">
                                        +
                                      </span>
                                    )}
                                    <span
                                      className={`h-[25px] min-w-[25px] px-[9px] rounded-full text-[10.5px] font-medium flex items-center justify-center border ${
                                        tok.kind === 'modifier'
                                          ? 'bg-[#dcfce7] border-[#45a11c] text-[#2d6a18]'
                                          : 'bg-[#e9d5ff] border-[#9333ea] text-[#7e22ce]'
                                      }`}
                                    >
                                      {tok.label}
                                    </span>
                                  </React.Fragment>
                                ))}
                              </div>
                            )}

                            {/* Dashed Hint Box matching Screenshots 1-4 */}
                            <div className="flex-1 min-h-[230px] rounded-[20px] border border-dashed border-[#cfcfcf] px-[24px] py-[18px] flex flex-col justify-between">
                              <div>
                                <h4 className="text-[14.5px] font-semibold text-[#555555] mb-[8px]">
                                  Hint
                                </h4>
                                <p className="text-[10.5px] leading-[1.38] text-[#666666] mb-[8px]">
                                  Press key combination or a phrase to make an action, such as:
                                </p>
                                <ul className="list-disc pl-[16px] text-[10.5px] leading-[1.42] text-[#666666] mb-[10px] space-y-[2px]">
                                  <li>Shortcuts → Ctrl/Cmd + C for copy;</li>
                                  <li>
                                    Text prompt → “Hello” + Enter key to record text or a phrase.
                                  </li>
                                </ul>
                                <p className="text-[10.5px] leading-[1.38] text-[#666666] mb-[10px]">
                                  Some keys may not be captured during recording because another app is using them.
                                </p>
                                <p className="text-[10.5px] leading-[1.38] text-[#666666]">
                                  Use advance mode to add delays, choose keys manually, or insert missed keys.
                                </p>
                              </div>

                              <button
                                onClick={() =>
                                  showToast('Actions documentation opened')
                                }
                                className="mt-[14px] text-[10.5px] text-[#5c5c5c] underline underline-offset-2 hover:text-black text-center cursor-pointer"
                              >
                                Discover more about Actions
                              </button>
                            </div>
                          </div>
                        ) : (
                          /* Advance Mode ON (Screenshots 1–7) */
                          <div className="flex-1 flex flex-col">
                            <div className="flex flex-col">
                              {actionAdvanceSteps.map((step, idx) => {
                                const isDropdownOpen =
                                  activeAdvanceStepDropdown === step.id;
                                const isMultipleSteps =
                                  actionAdvanceSteps.length > 1;
                                const isLastStep =
                                  idx === actionAdvanceSteps.length - 1;
                                const isBeingDragged =
                                  draggingAdvStep?.id === step.id;
                                const isModeHovered =
                                  hoveredModeStepId === step.id;
                                const isDelayHovered =
                                  hoveredDelayStepId === step.id;

                                return (
                                  <React.Fragment key={step.id}>
                                    <motion.div
                                      layout={!isBeingDragged}
                                      animate={{
                                        y: isBeingDragged
                                          ? draggingAdvStep.offsetY
                                          : 0,
                                        scale: isBeingDragged ? 1.015 : 1,
                                      }}
                                      transition={
                                        isBeingDragged
                                          ? { duration: 0 }
                                          : {
                                              type: 'spring',
                                              stiffness: 420,
                                              damping: 32,
                                            }
                                      }
                                      className={`h-[44px] rounded-full border border-[#dfdfdf] bg-[#ebebeb]/70 px-[9px] flex items-center gap-[6px] relative ${
                                        isBeingDragged
                                          ? 'z-40 shadow-[0_10px_24px_rgba(0,0,0,0.12)] bg-[#efefef]'
                                          : 'z-10'
                                      }`}
                                    >
                                      {/* Left 6-dot drag handle circle — hold and drag to reorder */}
                                      <button
                                        type="button"
                                        onPointerDown={(e) => {
                                          if (e.button !== 0) return;
                                          e.stopPropagation();
                                          setActiveAdvanceStepDropdown(null);
                                          advStepDragRef.current = {
                                            id: step.id,
                                            startY: e.clientY,
                                          };
                                          setDraggingAdvStep({
                                            id: step.id,
                                            offsetY: 0,
                                          });
                                        }}
                                        title="Hold and drag to move"
                                        className="w-[25px] h-[25px] rounded-full bg-white hover:bg-neutral-50 flex items-center justify-center text-[#444444] shadow-[0_1px_2px_rgba(0,0,0,0.03)] shrink-0 cursor-grab active:cursor-grabbing"
                                      >
                                        <svg
                                          width="7"
                                          height="11"
                                          viewBox="0 0 8 12"
                                          fill="currentColor"
                                        >
                                          <circle cx="2" cy="2" r="1.1" />
                                          <circle cx="6" cy="2" r="1.1" />
                                          <circle cx="2" cy="6" r="1.1" />
                                          <circle cx="6" cy="6" r="1.1" />
                                          <circle cx="2" cy="10" r="1.1" />
                                          <circle cx="6" cy="10" r="1.1" />
                                        </svg>
                                      </button>

                                      {/* Center Assign Key dropdown pill */}
                                      <div className="flex-1 relative min-w-0">
                                        <button
                                          type="button"
                                          onClick={() => {
                                            if (isDropdownOpen) {
                                              setActiveAdvanceStepDropdown(null);
                                            } else {
                                              setActiveAdvanceStepDropdown(
                                                step.id
                                              );
                                              setGestureKeySearch('');
                                            }
                                          }}
                                          className={`w-full h-[25px] rounded-full bg-white px-[11px] flex items-center justify-between text-[10.5px] text-[#555555] shadow-[0_1px_2px_rgba(0,0,0,0.03)] border transition-colors cursor-pointer ${
                                            isDropdownOpen
                                              ? 'border-[#0051ff]'
                                              : 'border-transparent hover:border-[#0051ff]'
                                          }`}
                                        >
                                          <span className="truncate">
                                            {step.keyLabel || 'Assign Key'}
                                          </span>
                                          {isDropdownOpen ? (
                                            <ChevronUp className="w-[11px] h-[11px] text-[#444] shrink-0" />
                                          ) : (
                                            <ChevronDown className="w-[11px] h-[11px] text-[#444] shrink-0" />
                                          )}
                                        </button>

                                        <AnimatePresence>
                                          {isDropdownOpen && (
                                            <motion.div
                                              initial={{
                                                opacity: 0,
                                                y: -4,
                                                scale: 0.96,
                                              }}
                                              animate={{
                                                opacity: 1,
                                                y: 0,
                                                scale: 1,
                                              }}
                                              exit={{
                                                opacity: 0,
                                                y: -4,
                                                scale: 0.96,
                                              }}
                                              transition={{
                                                duration: 0.2,
                                                ease: [0.32, 0.72, 0, 1],
                                              }}
                                              className="absolute top-[30px] left-0 right-0 bg-white rounded-[16px] shadow-[0_6px_20px_rgba(0,0,0,0.12)] border border-black/[0.05] overflow-hidden z-50"
                                            >
                                              <div className="h-[30px] bg-[#e6e6e6] px-[10px] flex items-center gap-[6px]">
                                                <Search className="w-[10.5px] h-[10.5px] text-[#555555] stroke-[2] shrink-0" />
                                                <input
                                                  type="text"
                                                  value={gestureKeySearch}
                                                  onChange={(e) =>
                                                    setGestureKeySearch(
                                                      e.target.value
                                                    )
                                                  }
                                                  placeholder="Search a key"
                                                  className="w-full bg-transparent text-[10px] text-[#333333] placeholder:text-[#9c9c9c] focus:outline-none"
                                                />
                                              </div>

                                              <div className="max-h-[220px] overflow-y-auto list-accordion-scroll divide-y divide-[#eeeeee]">
                                                {BASIC_KEY_SECTIONS.map((sec) => {
                                                  const matchingItems =
                                                    sec.items.filter((it) => {
                                                      if (
                                                        !gestureKeySearch.trim()
                                                      )
                                                        return true;
                                                      const q =
                                                        gestureKeySearch.toLowerCase();
                                                      const lbl = (
                                                        it.listLabel ||
                                                        it.main.replace(
                                                          /\n/g,
                                                          ' '
                                                        )
                                                      ).toLowerCase();
                                                      return lbl.includes(q);
                                                    });
                                                  if (matchingItems.length === 0)
                                                    return null;
                                                  const isSecOpen =
                                                    expandedGestureSection ===
                                                      sec.title ||
                                                    !!gestureKeySearch.trim();
                                                  return (
                                                    <div key={sec.title}>
                                                      <button
                                                        type="button"
                                                        onClick={() =>
                                                          setExpandedGestureSection(
                                                            expandedGestureSection ===
                                                              sec.title
                                                              ? null
                                                              : sec.title
                                                          )
                                                        }
                                                        className={`w-full h-[28px] px-[11px] flex items-center justify-between text-[10.5px] font-normal transition-colors cursor-pointer ${
                                                          isSecOpen
                                                            ? 'bg-[#0051ff] text-white'
                                                            : 'bg-white text-[#555555] hover:bg-[#0051ff] hover:text-white'
                                                        }`}
                                                      >
                                                        <span className="truncate">
                                                          {sec.title}
                                                        </span>
                                                        {isSecOpen ? (
                                                          <ChevronUp className="w-[11px] h-[11px] shrink-0" />
                                                        ) : (
                                                          <ChevronDown className="w-[11px] h-[11px] shrink-0" />
                                                        )}
                                                      </button>
                                                      <AnimatePresence
                                                        initial={false}
                                                      >
                                                        {isSecOpen && (
                                                          <motion.div
                                                            initial={{
                                                              height: 0,
                                                              opacity: 0,
                                                            }}
                                                            animate={{
                                                              height: 'auto',
                                                              opacity: 1,
                                                            }}
                                                            exit={{
                                                              height: 0,
                                                              opacity: 0,
                                                            }}
                                                            transition={{
                                                              duration: 0.2,
                                                            }}
                                                            className="bg-white py-[2px] overflow-hidden"
                                                          >
                                                            {matchingItems.map(
                                                              (it) => {
                                                                const itemName =
                                                                  it.listLabel ||
                                                                  it.main.replace(
                                                                    /\n/g,
                                                                    ' '
                                                                  );
                                                                return (
                                                                  <button
                                                                    key={it.id}
                                                                    type="button"
                                                                    onClick={() => {
                                                                      setActionAdvanceSteps(
                                                                        (
                                                                          prev
                                                                        ) =>
                                                                          prev.map(
                                                                            (
                                                                              s
                                                                            ) =>
                                                                              s.id ===
                                                                              step.id
                                                                                ? {
                                                                                    ...s,
                                                                                    keyLabel:
                                                                                      it.isClearIcon
                                                                                        ? ''
                                                                                        : itemName,
                                                                                  }
                                                                                : s
                                                                          )
                                                                      );
                                                                      setActiveAdvanceStepDropdown(
                                                                        null
                                                                      );
                                                                    }}
                                                                    className="w-full h-[25px] px-[12px] text-left text-[10.5px] text-[#555555] hover:bg-[#0051ff] hover:text-white transition-colors flex items-center cursor-pointer"
                                                                  >
                                                                    {itemName}
                                                                  </button>
                                                                );
                                                              }
                                                            )}
                                                          </motion.div>
                                                        )}
                                                      </AnimatePresence>
                                                    </div>
                                                  );
                                                })}
                                              </div>
                                            </motion.div>
                                          )}
                                        </AnimatePresence>
                                      </div>

                                      {/* Key Mode Toggle Button (Press & release vs Press) with Floating Pill Tooltip */}
                                      <div className="relative shrink-0">
                                        <AnimatePresence>
                                          {isModeHovered && (
                                            <motion.div
                                              initial={{
                                                opacity: 0,
                                                y: 3,
                                                scale: 0.95,
                                              }}
                                              animate={{
                                                opacity: 1,
                                                y: 0,
                                                scale: 1,
                                              }}
                                              exit={{
                                                opacity: 0,
                                                y: 2,
                                                scale: 0.95,
                                              }}
                                              transition={{ duration: 0.16 }}
                                              className="absolute -top-[27px] left-1/2 -translate-x-1/2 h-[21px] px-[10px] rounded-full bg-white shadow-[0_2px_8px_rgba(0,0,0,0.08)] flex items-center justify-center text-[10px] font-medium text-[#333333] whitespace-nowrap pointer-events-none z-50"
                                            >
                                              {step.mode === 'press-release'
                                                ? 'Press & release'
                                                : 'Press'}
                                            </motion.div>
                                          )}
                                        </AnimatePresence>

                                        <button
                                          type="button"
                                          onMouseEnter={() =>
                                            setHoveredModeStepId(step.id)
                                          }
                                          onMouseLeave={() =>
                                            setHoveredModeStepId((prev) =>
                                              prev === step.id ? null : prev
                                            )
                                          }
                                          onClick={() =>
                                            setActionAdvanceSteps((prev) =>
                                              prev.map((s) =>
                                                s.id === step.id
                                                  ? {
                                                      ...s,
                                                      mode:
                                                        s.mode ===
                                                        'press-release'
                                                          ? 'press'
                                                          : 'press-release',
                                                    }
                                                  : s
                                              )
                                            )
                                          }
                                          className="w-[25px] h-[25px] rounded-full bg-white hover:bg-[#0051ff] text-[#444444] hover:text-white flex items-center justify-center shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors cursor-pointer"
                                        >
                                          {step.mode === 'press-release' ? (
                                            /* Up + Down staggered arrows icon (Press & release, Image 5) */
                                            <svg
                                              width="11"
                                              height="11"
                                              viewBox="0 0 12 12"
                                              fill="none"
                                              stroke="currentColor"
                                              strokeWidth="1.35"
                                              strokeLinecap="round"
                                              strokeLinejoin="round"
                                            >
                                              <path d="M4.2 8.5V3M4.2 3L2.4 4.8M4.2 3L6 4.8" />
                                              <path d="M7.8 3.5V9M7.8 9L6 7.2M7.8 9L9.6 7.2" />
                                            </svg>
                                          ) : (
                                            /* Down arrow onto solid dot icon (Press / Hold, Image 6) */
                                            <svg
                                              width="11"
                                              height="11"
                                              viewBox="0 0 12 12"
                                              fill="none"
                                              stroke="currentColor"
                                              strokeWidth="1.35"
                                              strokeLinecap="round"
                                              strokeLinejoin="round"
                                            >
                                              <path d="M6 2.2V6.8M6 6.8L4.1 4.9M6 6.8L7.9 4.9" />
                                              <circle
                                                cx="6"
                                                cy="9.4"
                                                r="1.15"
                                                fill="currentColor"
                                                stroke="none"
                                              />
                                            </svg>
                                          )}
                                        </button>
                                      </div>

                                      {/* Conditional X Delete Button — ONLY shown when there are 2 or more Assign Key capsules (Images 1 vs 2) */}
                                      {isMultipleSteps && (
                                        <button
                                          type="button"
                                          onClick={() =>
                                            setActionAdvanceSteps((prev) =>
                                              prev.filter(
                                                (s) => s.id !== step.id
                                              )
                                            )
                                          }
                                          title="Remove key input"
                                          className="w-[25px] h-[25px] rounded-full bg-white hover:bg-[#e01b24] text-[#555555] hover:text-white flex items-center justify-center shadow-[0_1px_2px_rgba(0,0,0,0.03)] shrink-0 transition-colors cursor-pointer"
                                        >
                                          <X className="w-[11px] h-[11px] stroke-[1.7]" />
                                        </button>
                                      )}
                                    </motion.div>

                                    {/* Between two Assign Key capsules: Gray bar -> Hover/Tap "Delay" pill -> Editable "200 ms" capsule that collapses back to the gray bar when cursor leaves while keeping saved ms */}
                                    {!isLastStep && (
                                      <div
                                        onMouseEnter={() =>
                                          setHoveredDelayStepId(step.id)
                                        }
                                        onMouseLeave={() =>
                                          setHoveredDelayStepId((prev) =>
                                            prev === step.id ? null : prev
                                          )
                                        }
                                        className="min-h-[28px] py-[4px] flex items-center justify-center"
                                      >
                                        {step.delayAfterActive &&
                                        (isDelayHovered ||
                                          editingDelayStepId === step.id) ? (
                                          <motion.div
                                            initial={{
                                              opacity: 0,
                                              scale: 0.92,
                                            }}
                                            animate={{ opacity: 1, scale: 1 }}
                                            onClick={(e) => {
                                              setEditingDelayStepId(step.id);
                                              const inputEl =
                                                e.currentTarget.querySelector(
                                                  'input'
                                                ) as HTMLInputElement | null;
                                              if (
                                                inputEl &&
                                                document.activeElement !==
                                                  inputEl
                                              ) {
                                                inputEl.focus();
                                              }
                                            }}
                                            className="h-[26px] px-[11px] rounded-full bg-[#e2e2e2] hover:bg-[#dcdcdc] flex items-center gap-[5px] text-[10.5px] text-[#555555] cursor-text transition-colors"
                                          >
                                            <svg
                                              width="11"
                                              height="11"
                                              viewBox="0 0 12 12"
                                              fill="none"
                                              stroke="currentColor"
                                              strokeWidth="1.25"
                                              strokeLinecap="round"
                                              strokeLinejoin="round"
                                              className="shrink-0 mr-[3px]"
                                            >
                                              <circle cx="6" cy="6" r="4.6" />
                                              <path d="M6 3.5V6L7.6 7" />
                                            </svg>
                                            <input
                                              type="text"
                                              inputMode="numeric"
                                              autoFocus={
                                                editingDelayStepId === step.id
                                              }
                                              value={step.delayAfterMs ?? '200'}
                                              onFocus={(e) => {
                                                setEditingDelayStepId(step.id);
                                                const len =
                                                  e.currentTarget.value.length;
                                                e.currentTarget.setSelectionRange(
                                                  len,
                                                  len
                                                );
                                              }}
                                              onChange={(e) => {
                                                const val =
                                                  e.target.value.replace(
                                                    /[^0-9]/g,
                                                    ''
                                                  );
                                                setActionAdvanceSteps((prev) =>
                                                  prev.map((s) =>
                                                    s.id === step.id
                                                      ? {
                                                          ...s,
                                                          delayAfterMs: val,
                                                        }
                                                      : s
                                                  )
                                                );
                                              }}
                                              onBlur={() => {
                                                setEditingDelayStepId((prev) =>
                                                  prev === step.id ? null : prev
                                                );
                                                setActionAdvanceSteps((prev) =>
                                                  prev.map((s) =>
                                                    s.id === step.id &&
                                                    !(s.delayAfterMs || '').trim()
                                                      ? {
                                                          ...s,
                                                          delayAfterMs: '200',
                                                        }
                                                      : s
                                                  )
                                                );
                                              }}
                                              onKeyDown={(e) => {
                                                e.stopPropagation();
                                                if (e.key === 'Enter') {
                                                  setActionAdvanceSteps(
                                                    (prev) =>
                                                      prev.map((s) =>
                                                        s.id === step.id &&
                                                        !(
                                                          s.delayAfterMs || ''
                                                        ).trim()
                                                          ? {
                                                              ...s,
                                                              delayAfterMs:
                                                                '200',
                                                            }
                                                          : s
                                                      )
                                                  );
                                                  setEditingDelayStepId(null);
                                                  e.currentTarget.blur();
                                                }
                                              }}
                                              style={{
                                                width: `${Math.max(
                                                  2,
                                                  (step.delayAfterMs ?? '200')
                                                    .length
                                                )}ch`,
                                              }}
                                              className="min-w-[20px] max-w-[54px] bg-transparent text-right text-[10.5px] font-medium text-[#444444] caret-[#333333] focus:outline-none tabular-nums"
                                            />
                                            <span className="text-[#555555] select-none">
                                              ms
                                            </span>
                                            <button
                                              type="button"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                setEditingDelayStepId((prev) =>
                                                  prev === step.id ? null : prev
                                                );
                                                setActionAdvanceSteps((prev) =>
                                                  prev.map((s) =>
                                                    s.id === step.id
                                                      ? {
                                                          ...s,
                                                          delayAfterActive: false,
                                                          delayAfterMs: '200',
                                                        }
                                                      : s
                                                  )
                                                );
                                              }}
                                              title="Remove delay"
                                              className="text-[#555555] hover:text-black ml-[3px] cursor-pointer"
                                            >
                                              <X className="w-[10.5px] h-[10.5px] stroke-[1.7]" />
                                            </button>
                                          </motion.div>
                                        ) : isDelayHovered ? (
                                          <motion.button
                                            type="button"
                                            initial={{
                                              opacity: 0,
                                              scale: 0.9,
                                            }}
                                            animate={{ opacity: 1, scale: 1 }}
                                            transition={{ duration: 0.15 }}
                                            onClick={() => {
                                              setActionAdvanceSteps((prev) =>
                                                prev.map((s) =>
                                                  s.id === step.id
                                                    ? {
                                                        ...s,
                                                        delayAfterActive: true,
                                                        delayAfterMs:
                                                          s.delayAfterMs ||
                                                          '200',
                                                      }
                                                    : s
                                                )
                                              );
                                              setEditingDelayStepId(step.id);
                                            }}
                                            className="h-[25px] px-[11px] rounded-full bg-[#0051ff] text-white text-[10.5px] font-medium flex items-center gap-[5px] shadow-[0_2px_8px_rgba(0,81,255,0.28)] cursor-pointer"
                                          >
                                            <svg
                                              width="11"
                                              height="11"
                                              viewBox="0 0 12 12"
                                              fill="none"
                                              stroke="currentColor"
                                              strokeWidth="1.35"
                                              strokeLinecap="round"
                                              strokeLinejoin="round"
                                            >
                                              <circle cx="6" cy="6" r="4.6" />
                                              <path d="M6 3.5V6L7.6 7" />
                                            </svg>
                                            <span>Delay</span>
                                          </motion.button>
                                        ) : (
                                          <div
                                            onClick={() => {
                                              setHoveredDelayStepId(step.id);
                                              if (step.delayAfterActive) {
                                                setEditingDelayStepId(step.id);
                                              }
                                            }}
                                            title={
                                              step.delayAfterActive
                                                ? `Delay: ${
                                                    step.delayAfterMs || '200'
                                                  } ms`
                                                : 'Add delay'
                                            }
                                            className="w-[48px] h-[8px] rounded-full bg-[#dcdcdc] transition-all cursor-pointer"
                                          />
                                        )}
                                      </div>
                                    )}
                                  </React.Fragment>
                                );
                              })}
                            </div>

                            {/* + Key-input Pill Button */}
                            <button
                              type="button"
                              onClick={() =>
                                setActionAdvanceSteps((prev) => [
                                  ...prev,
                                  {
                                    id: `adv-step-${Date.now()}-${Math.random()}`,
                                    keyLabel: '',
                                    mode: 'press-release',
                                    delayAfterActive: false,
                                    delayAfterMs: '200',
                                  },
                                ])
                              }
                              className="mx-auto mt-[10px] h-[28px] px-[14px] rounded-full bg-[#e2e2e2] hover:bg-[#d8d8d8] text-[10.5px] font-medium text-[#4a4a4a] flex items-center gap-[5px] transition-colors cursor-pointer"
                            >
                              <span>+</span>
                              <span>Key-input</span>
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    </motion.div>
                  ) : (
                    <motion.div
                      key="main-drawer-content"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.26, ease: 'easeInOut' }}
                      className="flex-1 flex flex-col overflow-hidden"
                    >
                      {/* Drawer Top Header: X (left) | Key Mapping (i) (center) */}
                    <div className="px-[18px] pt-[18px] pb-[14px] flex items-center justify-between shrink-0 relative">
                      <button
                        onClick={() => {
                          setMappingDrawerOpen(false);
                          setSelectedKey(null);
                          setSelectedEncoderSub(null);
                          setSelectedDrawerTile(null);
                        }}
                        aria-label="Close Key Mapping"
                        className="w-[24px] h-[24px] rounded-full border-[1.5px] border-transparent hover:border-[#0051ff] flex items-center justify-center text-[#555555] hover:text-black transition-all cursor-pointer"
                      >
                        <X className="w-[14px] h-[14px] stroke-[1.7]" />
                      </button>

                      <div className="flex items-center gap-[5px] text-[#555555] text-[12.5px] font-medium">
                        <span>Key Mapping</span>
                        <button
                          onMouseEnter={() => setActiveTooltip('drawer-mapping')}
                          onMouseLeave={() => setActiveTooltip(null)}
                          onClick={() =>
                            setActiveTooltip(
                              activeTooltip === 'drawer-mapping'
                                ? null
                                : 'drawer-mapping'
                            )
                          }
                          className="text-[#666666] hover:text-[#222] cursor-pointer"
                        >
                          <InfoCircleIcon />
                        </button>
                      </div>

                      <div className="w-[24px]" />

                      <AnimatePresence>
                        {activeTooltip === 'drawer-mapping' && (
                          <motion.div
                            initial={{ opacity: 0, y: -4, scale: 0.96 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: -4, scale: 0.96 }}
                            transition={{ duration: 0.16, ease: [0.32, 0.72, 0, 1] }}
                            className="absolute top-[42px] right-[12px] w-[226px] bg-[#ececec] rounded-[16px] px-[18px] py-[15px] shadow-[0_3px_10px_rgba(0,0,0,0.06)] border border-black/[0.04] text-left z-40 pointer-events-none"
                          >
                            <div className="text-[13px] font-semibold text-[#5e5e5e] mb-[9px]">
                              Key Mapping
                            </div>
                            <p className="text-[11px] leading-[1.36] text-[#686868]">
                              Assign keys, actions and multiactions to the selected button.
                            </p>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                    {/* Search Bar + List/Grid View Toggle */}
                    <div className="px-[15px] flex items-center gap-[7px] shrink-0">
                      <div className="flex-1 h-[27px] rounded-full bg-[#e2e2e2] px-[10px] flex items-center gap-[6px]">
                        <Search className="w-[11px] h-[11px] text-[#666666] stroke-[2] shrink-0" />
                        <input
                          type="text"
                          value={mappingSearch}
                          onChange={(e) => setMappingSearch(e.target.value)}
                          placeholder="Search Key, Action, Multiaction"
                          className="w-full bg-transparent text-[10.5px] text-[#333333] placeholder:text-[#9c9c9c] focus:outline-none"
                        />
                      </div>

                      <div className="w-[62px] h-[27px] rounded-full bg-[#e2e2e2] flex overflow-hidden shrink-0">
                        <button
                          onClick={() => setMappingViewMode('list')}
                          aria-label="List view"
                          aria-pressed={mappingViewMode === 'list'}
                          className={`flex-1 h-full rounded-l-full border-[1.5px] border-transparent hover:border-[#0051ff] flex items-center justify-center transition-all cursor-pointer ${
                            mappingViewMode === 'list'
                              ? 'bg-[#000000] text-white'
                              : 'text-[#444444] hover:bg-black/5'
                          }`}
                        >
                          <svg
                            width="12"
                            height="10"
                            viewBox="0 0 12 10"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.3"
                            strokeLinecap="round"
                          >
                            <circle
                              cx="1.5"
                              cy="1.8"
                              r="0.7"
                              fill="currentColor"
                              stroke="none"
                            />
                            <line x1="4" y1="1.8" x2="10.8" y2="1.8" />
                            <circle
                              cx="1.5"
                              cy="5"
                              r="0.7"
                              fill="currentColor"
                              stroke="none"
                            />
                            <line x1="4" y1="5" x2="10.8" y2="5" />
                            <circle
                              cx="1.5"
                              cy="8.2"
                              r="0.7"
                              fill="currentColor"
                              stroke="none"
                            />
                            <line x1="4" y1="8.2" x2="10.8" y2="8.2" />
                          </svg>
                        </button>
                        <button
                          onClick={() => setMappingViewMode('grid')}
                          aria-label="Grid view"
                          aria-pressed={mappingViewMode === 'grid'}
                          className={`flex-1 h-full rounded-r-full border-[1.5px] border-transparent hover:border-[#0051ff] flex items-center justify-center transition-all cursor-pointer ${
                            mappingViewMode === 'grid'
                              ? 'bg-[#000000] text-white'
                              : 'text-[#444444] hover:bg-black/5'
                          }`}
                        >
                          <svg
                            width="11"
                            height="11"
                            viewBox="0 0 12 12"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.3"
                          >
                            <rect
                              x="1.2"
                              y="1.2"
                              width="3.8"
                              height="3.8"
                              rx="0.6"
                            />
                            <rect
                              x="7"
                              y="1.2"
                              width="3.8"
                              height="3.8"
                              rx="0.6"
                            />
                            <rect
                              x="1.2"
                              y="7"
                              width="3.8"
                              height="3.8"
                              rx="0.6"
                            />
                            <rect
                              x="7"
                              y="7"
                              width="3.8"
                              height="3.8"
                              rx="0.6"
                            />
                          </svg>
                        </button>
                      </div>
                    </div>

                    {/* 4 Category Pill Tabs: Basic | Action | Multi-A | Smart-A */}
                    <div className="px-[15px] pt-[10px] pb-[10px] grid grid-cols-4 gap-[6px] shrink-0">
                      {(['Basic', 'Action', 'Multi-A', 'Smart-A'] as const).map(
                        (tab) => {
                          const isActive = mappingTab === tab;
                          return (
                            <button
                              key={tab}
                              onClick={() => setMappingTab(tab)}
                              className={`h-[31px] rounded-full border-[1.5px] border-transparent hover:border-[#0051ff] text-[11px] font-medium transition-all cursor-pointer ${
                                isActive
                                  ? 'bg-[#000000] text-white'
                                  : 'bg-white text-[#444444] hover:bg-neutral-50'
                              }`}
                            >
                              {tab}
                            </button>
                          );
                        }
                      )}
                    </div>

                    <AnimatePresence mode="wait" initial={false}>
                      {/* =========================================================== */}
                      {/* TAB 1: BASIC (Grid View OR Accordion List View)             */}
                      {/* =========================================================== */}
                      {mappingTab === 'Basic' && (
                        <motion.div
                          key={`basic-tab-${mappingViewMode}`}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.25, ease: 'easeInOut' }}
                          className="flex-1 overflow-y-auto px-[15px] pb-[20px]"
                        >
                          {mappingViewMode === 'grid' ? (
                            <div className="space-y-[18px]">
                              {filteredBasicSections.map((section) => (
                                <div key={section.title}>
                                  <div className="text-[11px] font-medium text-[#444444] mb-[8px]">
                                    {section.title}
                                  </div>

                                  <div className="grid grid-cols-5 gap-[6px]">
                                    {section.items.map((item) => {
                                      const isBeingDragged =
                                        draggedTile?.item.id === item.id;
                                      const isFlashed = flashedTileId === item.id;
                                      return (
                                        <button
                                          key={item.id}
                                          onPointerDown={(e) =>
                                            handleStartTileDrag(e, item, 'Basic')
                                          }
                                          onClick={() =>
                                            handleAssignTileFromDrawer(item)
                                          }
                                          title="Click or drag onto a key to assign"
                                          className={`h-[54px] rounded-[8px] border-[1.5px] flex flex-col items-center justify-center px-1 select-none cursor-grab active:cursor-grabbing ${
                                            isFlashed
                                              ? 'bg-[#000000] text-white border-[#000000] transition-colors duration-75'
                                              : isBeingDragged
                                              ? 'bg-[#e8e8e8] text-[#a8a8a8] border-transparent transition-colors duration-200'
                                              : 'bg-white hover:bg-[#fafafa] text-[#222222] border-transparent hover:border-[#0051ff] transition-colors duration-500 ease-out'
                                          }`}
                                        >
                                          {item.isClearIcon ? (
                                            <EmptyKeyPlusIcon
                                              size={15}
                                              stroke={isFlashed ? '#ffffff' : '#9c9c9c'}
                                            />
                                          ) : item.arrowDir ? (
                                            <ArrowKeyGlyph dir={item.arrowDir} />
                                          ) : item.top ? (
                                            <div className="flex flex-col items-center leading-[1.15] text-[10px]">
                                              <span>{item.top}</span>
                                              <span>{item.main}</span>
                                            </div>
                                          ) : (
                                            <span className="text-[10px] leading-[1.15] text-center whitespace-pre-line">
                                              {item.main}
                                            </span>
                                          )}
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            /* LIST VIEW ACCORDION */
                            <div className="pt-[4px] divide-y divide-[#dcdcdc] border-b border-[#dcdcdc]">
                              {filteredBasicSections.map((section) => {
                                const isExpanded =
                                  !!expandedListSections[section.title];
                                return (
                                  <div key={section.title} className="py-[11px]">
                                    <button
                                      onClick={() =>
                                        toggleListSection(section.title)
                                      }
                                      className="w-full flex items-center justify-between gap-2 text-left cursor-pointer"
                                    >
                                      <div className="flex items-center gap-[5px] min-w-0 flex-1">
                                        <span className="text-[11px] font-medium text-[#525252] shrink-0">
                                          {section.title}
                                        </span>
                                        <span className="text-[11px] font-normal text-[#a6a6a6] truncate">
                                          {section.listPreview}
                                        </span>
                                      </div>
                                      {isExpanded ? (
                                        <ChevronUp className="w-[12px] h-[12px] text-[#555555] shrink-0 stroke-[1.8]" />
                                      ) : (
                                        <ChevronDown className="w-[12px] h-[12px] text-[#555555] shrink-0 stroke-[1.8]" />
                                      )}
                                    </button>

                                    <AnimatePresence initial={false}>
                                      {isExpanded && (
                                        <motion.div
                                          initial={{ height: 0, opacity: 0 }}
                                          animate={{ height: 'auto', opacity: 1 }}
                                          exit={{ height: 0, opacity: 0 }}
                                          transition={{
                                            duration: 0.2,
                                            ease: [0.22, 1, 0.36, 1],
                                          }}
                                          className="overflow-hidden"
                                        >
                                          <div className="mt-[12px] max-h-[136px] overflow-y-auto list-accordion-scroll pr-2 space-y-[8px]">
                                            {section.items.map((item) => {
                                              const rowLabel =
                                                item.listLabel ||
                                                item.main.replace(/\n/g, ' ');
                                              const isFlashed =
                                                flashedTileId === item.id;
                                              return (
                                                <button
                                                  key={item.id}
                                                  onPointerDown={(e) =>
                                                    handleStartTileDrag(e, item, 'Basic')
                                                  }
                                                  onClick={() =>
                                                    handleAssignTileFromDrawer(item)
                                                  }
                                                  className={`block w-full px-2 py-0.5 rounded-md border text-left text-[11px] select-none cursor-grab active:cursor-grabbing ${
                                                    isFlashed
                                                      ? 'bg-[#000000] text-white border-[#000000] transition-colors duration-75'
                                                      : 'bg-transparent text-[#666666] hover:text-black border-transparent hover:border-[#0051ff] transition-colors duration-500 ease-out'
                                                  }`}
                                                >
                                                  {rowLabel}
                                                </button>
                                              );
                                            })}
                                          </div>
                                        </motion.div>
                                      )}
                                    </AnimatePresence>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </motion.div>
                      )}

                    {/* =========================================================== */}
                    {/* TAB 2: ACTION                                               */}
                    {/* =========================================================== */}
                    {mappingTab === 'Action' && (
                      <motion.div
                        key="action-tab"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.25, ease: 'easeInOut' }}
                        className="flex-1 flex flex-col px-[15px] pb-[15px] overflow-hidden"
                      >
                        <button
                          onClick={() => handleOpenCreatorEditor('Action')}
                          className="w-full h-[27px] rounded-full bg-white hover:bg-neutral-50 border-[1.5px] border-transparent hover:border-[#0051ff] flex items-center justify-center gap-[6px] text-[10.5px] font-medium text-[#4a4a4a] shadow-[0_1px_2px_rgba(0,0,0,0.03)] mb-[15px] shrink-0 transition-all cursor-pointer"
                        >
                          <Plus className="w-[11px] h-[11px] stroke-[2]" />
                          <span>New Action</span>
                        </button>

                        {customItemsByTab.Action.length === 0 ? (
                          <div className="flex-1 rounded-[20px] border border-dashed border-[#cfcfcf] flex flex-col items-center justify-center px-[22px] text-center">
                            <h3 className="text-[15.5px] font-semibold text-[#5e5e5e] mb-[14px]">
                              Make your first Action!
                            </h3>
                            <p className="text-[10.5px] leading-[1.35] text-[#666666] mb-[11px]">
                              An action is a recordable macro that captures a sequence of key presses.
                            </p>
                            <p className="text-[10.5px] leading-[1.35] text-[#666666] mb-[11px]">
                              You can record multiple keys in the desired order, and then assign the action to a button.
                            </p>
                            <p className="text-[10.5px] leading-[1.35] text-[#666666] mb-[11px]">
                              Once assigned, pressing the button will automatically perform the entire sequence of recorded keys, saving you time and effort.
                            </p>
                            <p className="text-[10.5px] leading-[1.35] text-[#666666] mb-[22px]">
                              This feature is perfect for repetitive tasks, custom shortcuts, or complex commands.
                            </p>
                            <button
                              onClick={() =>
                                showToast('Actions documentation opened')
                              }
                              className="text-[10.5px] text-[#5c5c5c] underline underline-offset-2 hover:text-black cursor-pointer"
                            >
                              Discover more about Actions
                            </button>
                          </div>
                        ) : (
                          renderCustomItemGroups('Action', customItemsByTab.Action, 'My Actions')
                        )}
                      </motion.div>
                    )}

                    {/* =========================================================== */}
                    {/* TAB 3: MULTI-A                                              */}
                    {/* =========================================================== */}
                    {mappingTab === 'Multi-A' && (
                      <motion.div
                        key="multi-a-tab"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.25, ease: 'easeInOut' }}
                        className="flex-1 flex flex-col px-[15px] pb-[15px] overflow-hidden"
                      >
                        <button
                          onClick={() => handleOpenCreatorEditor('Multi-A')}
                          className="w-full h-[27px] rounded-full bg-white hover:bg-neutral-50 border-[1.5px] border-transparent hover:border-[#0051ff] flex items-center justify-center gap-[6px] text-[10.5px] font-medium text-[#4a4a4a] shadow-[0_1px_2px_rgba(0,0,0,0.03)] mb-[15px] shrink-0 transition-all cursor-pointer"
                        >
                          <Plus className="w-[11px] h-[11px] stroke-[2]" />
                          <span>New Multiaction</span>
                        </button>

                        {customItemsByTab['Multi-A'].length === 0 ? (
                          <div className="flex-1 rounded-[20px] border border-dashed border-[#cfcfcf] flex flex-col items-center justify-center px-[20px] text-center">
                            <h3 className="text-[15.5px] font-semibold text-[#5e5e5e] mb-[14px]">
                              Make your first Multiaction!
                            </h3>
                            <p className="text-[10.5px] leading-[1.35] text-[#666666] mb-[11px]">
                              Multiactions let you assign multiple functions to a single button based on how you interact with it.
                            </p>

                            <div className="w-full text-[10.5px] leading-[1.45] text-[#666666] mb-[11px] space-y-[2px]">
                              <div className="flex items-start">
                                <span className="w-3 text-left shrink-0">•</span>
                                <span className="flex-1 text-center">
                                  Tap the button to play or pause your music.
                                </span>
                              </div>
                              <div className="flex items-start">
                                <span className="w-3 text-left shrink-0">•</span>
                                <span className="flex-1 text-center">
                                  Double tap it to skip to the next track.
                                </span>
                              </div>
                              <div className="flex items-start">
                                <span className="w-3 text-left shrink-0">•</span>
                                <span className="flex-1 text-center">
                                  Hold the button to stop.
                                </span>
                              </div>
                              <div className="flex items-start">
                                <span className="w-3 text-left shrink-0">•</span>
                                <span className="flex-1 text-center">
                                  Tap and hold it to activate your voice assistant.
                                </span>
                              </div>
                            </div>

                            <p className="text-[10.5px] leading-[1.35] text-[#666666] mb-[22px]">
                              This flexibility means one button can handle several tasks, streamlining your workflow and reducing the need for additional controls.
                            </p>
                            <button
                              onClick={() =>
                                showToast('Multiactions documentation opened')
                              }
                              className="text-[10.5px] text-[#5c5c5c] underline underline-offset-2 hover:text-black cursor-pointer"
                            >
                              Discover more about Multiactions
                            </button>
                          </div>
                        ) : (
                          renderCustomItemGroups('Multi-A', customItemsByTab['Multi-A'], 'My Multiactions')
                        )}
                      </motion.div>
                    )}

                    {/* =========================================================== */}
                    {/* TAB 4: SMART-A (Exact match to Screenshot 10)               */}
                    {/* =========================================================== */}
                    {mappingTab === 'Smart-A' && (
                      <motion.div
                        key="smart-a-tab"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.25, ease: 'easeInOut' }}
                        className="flex-1 flex flex-col px-[15px] pb-[15px] overflow-hidden"
                      >
                        <button
                          onClick={() => handleOpenCreatorEditor('Smart-A')}
                          className="w-full h-[27px] rounded-full bg-white hover:bg-neutral-50 border-[1.5px] border-transparent hover:border-[#0051ff] flex items-center justify-center gap-[6px] text-[10.5px] font-medium text-[#4a4a4a] shadow-[0_1px_2px_rgba(0,0,0,0.03)] mb-[15px] shrink-0 transition-all cursor-pointer"
                        >
                          <Plus className="w-[11px] h-[11px] stroke-[2]" />
                          <span>New Smart Action</span>
                        </button>

                        {customItemsByTab['Smart-A'].length === 0 ? (
                          <div className="flex-1 rounded-[20px] border border-dashed border-[#cfcfcf] flex flex-col items-center justify-center px-[24px] text-center">
                            <h3 className="text-[15.5px] font-semibold text-[#5e5e5e] mb-[14px]">
                              Make your first Smart Action!
                            </h3>
                            <p className="text-[10.5px] leading-[1.35] text-[#666666] mb-[11px]">
                              A smart action lets you type text, run commands, open websites, or launch apps with a single key press.
                            </p>
                            <p className="text-[10.5px] leading-[1.35] text-[#666666] mb-[22px]">
                              Create one, then assign it to a button to trigger it instantly.
                            </p>
                            <button
                              onClick={() =>
                                showToast('Smart Actions documentation opened')
                              }
                              className="text-[10.5px] text-[#5c5c5c] underline underline-offset-2 hover:text-black cursor-pointer"
                            >
                              Discover more about Smart Actions
                            </button>
                          </div>
                        ) : (
                          renderCustomItemGroups('Smart-A', customItemsByTab['Smart-A'], 'My Smart Actions')
                        )}
                      </motion.div>
                    )}
                    </AnimatePresence>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.aside>
            )}
          </AnimatePresence>
        </motion.main>
      )}

      {/* ===================================================================== */}
      {/* 2. PRESETS LIBRARY VIEW                                               */}
      {/* ===================================================================== */}
      {activeNav === 'Preset' && (
        <motion.main
          key="preset-screen"
          initial={{ opacity: 0, scale: 0.985, filter: 'blur(4px)' }}
          animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
          exit={{ opacity: 0, scale: 1.01, filter: 'blur(4px)' }}
          transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
          data-preset-screen
          className="preset-screen-scroll flex-1 overflow-y-auto w-full max-w-[1440px] mx-auto pt-[54px] pb-[48px] px-4"
        >
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-[25px] font-medium text-[#666666] tracking-[-0.01em] leading-none">
                Presets library
              </h1>
              <p className="mt-[12px] text-[10.5px] leading-[1.42] text-[#686868]">
                Presets are ready-made key configurations.
                <br />
                Load a preset to instantly apply a predefined workflow to your device.
              </p>
            </div>

            <div className="flex flex-col items-end gap-[9px]">
              <div className="w-[196px] h-[27px] rounded-full bg-[#e2e2e2] px-[11px] flex items-center gap-[6px]">
                <Search className="w-[11px] h-[11px] text-[#666666] stroke-[2]" />
                <input
                  type="text"
                  value={presetSearch}
                  onChange={(e) => setPresetSearch(e.target.value)}
                  placeholder="Search"
                  className="w-full bg-transparent text-[11px] text-[#333333] placeholder:text-[#686868] focus:outline-none"
                />
              </div>

              <div className="w-[130px] h-[27px] rounded-full bg-white flex overflow-hidden shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
                <button
                  onClick={() => setPresetOs('mac')}
                  aria-label="macOS Presets"
                  className={`flex-1 h-full flex items-center justify-center transition-colors cursor-pointer ${
                    presetOs === 'mac'
                      ? 'bg-[#000000] text-white'
                      : 'bg-white text-[#555555] hover:bg-neutral-50'
                  }`}
                >
                  <svg
                    width="11"
                    height="13"
                    viewBox="0 0 14 17"
                    fill="currentColor"
                  >
                    <path d="M11.66 9.03C11.64 6.95 13.36 5.93 13.44 5.88C12.46 4.46 10.95 4.26 10.42 4.2C9.15 4.07 7.92 4.95 7.27 4.95C6.62 4.95 5.63 4.21 4.57 4.23C3.19 4.25 1.91 5.03 1.21 6.26C-0.24 8.77 0.84 12.47 2.24 14.49C2.93 15.49 3.74 16.6 4.82 16.56C5.86 16.52 6.26 15.89 7.51 15.89C8.76 15.89 9.13 16.56 10.21 16.54C11.33 16.52 12.03 15.53 12.71 14.53C13.51 13.37 13.83 12.24 13.85 12.18C13.82 12.17 11.68 11.35 11.66 9.03ZM9.58 2.86C10.15 2.17 10.54 1.21 10.43 0.25C9.6 0.28 8.58 0.8 7.99 1.49C7.47 2.09 7.01 3.07 7.14 4.01C8.06 4.08 8.99 3.55 9.58 2.86Z" />
                  </svg>
                </button>
                <button
                  onClick={() => setPresetOs('win')}
                  aria-label="Windows Presets"
                  className={`flex-1 h-full flex items-center justify-center transition-colors cursor-pointer ${
                    presetOs === 'win'
                      ? 'bg-[#000000] text-white'
                      : 'bg-white text-[#555555] hover:bg-neutral-50'
                  }`}
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 12 12"
                    fill="currentColor"
                  >
                    <rect x="0.5" y="0.5" width="4.8" height="4.8" />
                    <rect x="6.7" y="0.5" width="4.8" height="4.8" />
                    <rect x="0.5" y="6.7" width="4.8" height="4.8" />
                    <rect x="6.7" y="6.7" width="4.8" height="4.8" />
                  </svg>
                </button>
              </div>
            </div>
          </div>

          <div
            data-preset-grid
            className="mt-[36px] grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-[17px]"
          >
            {filteredPresets.map((preset) => {
              const isInstalled = isPresetInstalledInProfile(currentProfile, preset.id);
              return (
                <div
                  key={preset.id}
                  className="bg-[#e3e3e3] rounded-[18px] p-[15px] flex flex-col justify-between min-h-[164px]"
                >
                  <div>
                    <div className="flex items-center gap-[10px]">
                      <PresetAppIcon id={preset.id} />
                      <div>
                        <div className="text-[10px] text-[#6d6d6d] leading-none mb-[3px]">
                          Layer preset
                        </div>
                        <div className="text-[15px] font-semibold text-[#111111] leading-none">
                          {preset.title}
                        </div>
                      </div>
                    </div>

                    <p className="mt-[11px] text-[10.5px] leading-[1.35] text-[#666666] min-h-[28px]">
                      {preset.description}
                    </p>

                    <div className="mt-[6px] text-[10px] font-medium text-[#2b2b2b]">
                      Author: {preset.author}
                    </div>
                  </div>

                  <div className="mt-[10px]">
                    {preset.hasPreview ? (
                      <div className="grid grid-cols-2 gap-[8px]">
                        <button
                          onClick={() => setPreviewPreset(preset)}
                          className="h-[27px] rounded-full bg-white hover:bg-neutral-50 text-[10.5px] font-medium text-[#333333] shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors cursor-pointer"
                        >
                          Preview
                        </button>
                        <button
                          onClick={() => handleInstallPreset(preset)}
                          disabled={isInstalled}
                          aria-label={
                            isInstalled
                              ? `${preset.title} preset already installed on this profile`
                              : `Install ${preset.title} preset`
                          }
                          className="h-[27px] rounded-full bg-white hover:bg-neutral-50 text-[10.5px] font-medium text-[#333333] shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors cursor-pointer disabled:cursor-not-allowed disabled:text-[#999999] disabled:hover:bg-white"
                        >
                          {isInstalled ? 'Installed' : 'Install'}
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => handleInstallPreset(preset)}
                        disabled={isInstalled}
                        aria-label={
                          isInstalled
                            ? `${preset.title} preset already installed on this profile`
                            : `Install ${preset.title} preset`
                        }
                        className="w-full h-[27px] rounded-full bg-white hover:bg-neutral-50 text-[10.5px] font-medium text-[#333333] shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors cursor-pointer disabled:cursor-not-allowed disabled:text-[#999999] disabled:hover:bg-white"
                      >
                        {isInstalled ? 'Installed' : 'Install'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </motion.main>
      )}

      {/* ===================================================================== */}
      {/* 3. SETTINGS VIEW                                                      */}
      {/* ===================================================================== */}
      {activeNav === 'Settings' && (
        <motion.main
          key="settings-screen"
          initial={{ opacity: 0, scale: 0.985, filter: 'blur(4px)' }}
          animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
          exit={{ opacity: 0, scale: 1.01, filter: 'blur(4px)' }}
          transition={{ duration: 0.28, ease: [0.32, 0.72, 0, 1] }}
          className="flex-1 flex flex-col justify-between items-center w-full px-4 overflow-y-auto"
        >
          <div className="flex-1 flex items-center justify-center w-full">
            <div className="w-full max-w-[662px] grid grid-cols-1 md:grid-cols-2 gap-[14px] items-start my-8">
              <div className="flex flex-col gap-[12px]">
                <div className="bg-[#e3e3e3] rounded-[16px] px-[16px] py-[14px]">
                  <h2 className="text-[13.5px] font-medium text-[#4a4a4a] mb-[8px]">
                    Information
                  </h2>
                  <div className="divide-y divide-[#dadada] text-[10.5px]">
                    <div className="py-[7px] flex items-center justify-between">
                      <span className="text-[#585858]">Device status:</span>
                      <span className="text-[#444444] font-medium">
                        {deviceStatus.state === 'connected'
                          ? deviceStatus.device || 'Grid Macro 1'
                          : deviceStatus.state === 'connecting'
                            ? 'Connecting…'
                            : deviceStatus.state === 'searching'
                              ? 'Searching…'
                              : 'Not connected'}
                      </span>
                    </div>
                    <div className="py-[7px] flex items-center justify-between">
                      <span className="text-[#585858]">Firmware version:</span>
                      <span className="text-[#444444] font-medium tabular-nums">
                        {deviceStatus.state === 'connected' ? deviceStatus.fw || 'Unknown' : '—'}
                      </span>
                    </div>
                    <div className="pt-[7px] pb-[2px] flex items-center justify-between">
                      <span className="text-[#585858]">Input app version:</span>
                      <span className="text-[#444444] font-medium tabular-nums">
                        {appVersion}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="bg-[#e3e3e3] rounded-[16px] px-[16px] py-[14px]">
                  <h2 className="text-[13.5px] font-medium text-[#4a4a4a] mb-[8px]">
                    App settings
                  </h2>
                  <div className="divide-y divide-[#dadada] text-[10.5px]">
                    <div className="py-[8px] flex items-center justify-between">
                      <span className="text-[#585858]">Launch app at startup</span>
                      <SettingsSwitch
                        checked={launchAtStartup}
                        disabled={!settingsCapabilities.launchAtStartup}
                        title={settingsCapabilities.launchAtStartup
                          ? 'Start the installed app when you sign in'
                          : 'Available only in the installed desktop app'}
                        onChange={() => void handleAppSettingChange('launchAtStartup', !launchAtStartup)}
                      />
                    </div>
                    <div className="py-[8px] flex items-center justify-between">
                      <span className="text-[#585858] flex items-center gap-[5px]">
                        <span>Allow terminal commands via Smart Actions</span>
                        <span className="text-[#666666]">
                          <InfoCircleIcon size={11} />
                        </span>
                      </span>
                      <SettingsSwitch
                        checked={allowTerminalSmartActions}
                        title="Terminal commands run on this computer. Enable only for trusted Smart Actions."
                        onChange={() => void handleAppSettingChange('allowTerminalSmartActions', !allowTerminalSmartActions)}
                      />
                    </div>
                    <div className="pt-[8px] pb-[2px] flex items-center justify-between">
                      <span className="text-[#585858]">
                        Notify on device connect/disconnect
                      </span>
                      <SettingsSwitch
                        checked={allowDeviceNotifications}
                        title="Shows a system notification when the device connects or disconnects."
                        onChange={() => void handleAppSettingChange('allowDeviceNotifications', !allowDeviceNotifications)}
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-[12px]">
                <div className="bg-[#e3e3e3] rounded-[16px] px-[16px] py-[14px]">
                  <h2 className="text-[13.5px] font-medium text-[#4a4a4a] mb-[12px]">
                    Support
                  </h2>
                  <div className="space-y-[7px]">
                    {([
                      { key: 'help', label: 'Help & Documentation' },
                      { key: 'contact', label: 'Contact support' },
                      { key: 'feedback', label: 'Give feedback' },
                      { key: 'releaseNotes', label: 'Release notes' },
                    ] as const).map(({ key, label }) => (
                      <button
                        type="button"
                        key={label}
                        onClick={() => void handleOpenSupportLink(key, label)}
                        className="w-full h-[27px] rounded-full bg-white hover:bg-[#0051ff] text-[10.5px] font-medium text-[#444444] hover:text-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors cursor-pointer"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="bg-[#f2e4c6] rounded-[16px] px-[16px] py-[14px]">
                  <div className="flex items-center gap-[7px] text-[#e09100] text-[13.5px] font-medium mb-[12px]">
                    <WarningTriangleIcon color="#e09100" />
                    <span>Device update</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleCheckFirmwareUpdate()}
                    disabled={firmwareCheckPending}
                    title="Checks the published firmware release feed; it does not flash the device"
                    className="w-full h-[27px] rounded-full bg-white hover:bg-[#f59e0b] disabled:opacity-50 text-[10.5px] font-medium text-[#444444] hover:text-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors cursor-pointer disabled:cursor-wait"
                  >
                    {firmwareCheckPending ? 'Checking firmware…' : 'Check firmware update'}
                  </button>
                </div>

                <div className="bg-[#efc8c8] rounded-[16px] px-[16px] py-[14px]">
                  <div className="flex items-center gap-[7px] text-[#e01b24] text-[13.5px] font-medium mb-[12px]">
                    <WarningTriangleIcon color="#e01b24" />
                    <span>Danger zone</span>
                  </div>
                  <div className="space-y-[7px]">
                    <button
                      type="button"
                      onClick={handleResetLocalConfig}
                      className="w-full h-[27px] rounded-full bg-white hover:bg-[#e01b24] text-[10.5px] font-medium text-[#444444] hover:text-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors cursor-pointer"
                    >
                      Reset local config
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleAdvanceFlash()}
                      title="Copies a validated RP2040 UF2 to an already-mounted RPI-RP2 BOOTSEL drive in the desktop app"
                      className="w-full h-[27px] rounded-full bg-white hover:bg-[#e01b24] text-[10.5px] font-medium text-[#444444] hover:text-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors cursor-pointer"
                    >
                      Advance flash
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <footer className="pb-[18px] text-[9.5px] text-[#555555] text-center">
            © 2026 NØDE Studio
          </footer>
        </motion.main>
      )}
      </AnimatePresence>

      {/* PRESET DETAIL PREVIEW PAGE */}
      <AnimatePresence>
        {previewPreset && previewPresetDetails && (
          <motion.main
            key={`preset-preview-${previewPreset.id}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0 z-50 overflow-y-auto bg-[#efefef]"
            aria-label={`${previewPreset.title} preset preview`}
          >
            <div className="w-full max-w-[1300px] mx-auto px-5 sm:px-7 lg:px-[30px] pt-[12px] pb-[52px]">
              <div className="w-full max-w-[1125px]">
                <button
                  type="button"
                  aria-label="Back to presets"
                  onClick={() => {
                    setPreviewPreset(null);
                    setHoveredPreviewSlot(null);
                    setHoveredPreviewDial(null);
                  }}
                  className="flex items-center gap-[12px] text-[16px] text-[#222] cursor-pointer hover:text-[#0051ff] transition-colors"
                >
                  <svg
                    width="22"
                    height="22"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M13 8H3M3 8L7 4M3 8L7 12" />
                  </svg>
                  Back
                </button>

                <header className="mt-[29px] flex flex-col md:flex-row md:items-start md:justify-between gap-6 md:gap-10">
                  <div className="w-full md:w-[268px] shrink-0">
                    <div className="flex items-center gap-[16px]">
                      <PresetAppIcon id={previewPreset.id} size={52} />
                      <div>
                        <div className="text-[13px] text-[#8a8a8a] leading-none mb-[6px]">
                          Layer preset
                        </div>
                        <h1 className="text-[21px] font-medium text-[#111] leading-none">
                          {previewPreset.title}
                        </h1>
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-label={
                        isPreviewPresetInstalled
                          ? `${previewPreset.title} preset already installed on this profile`
                          : `Install ${previewPreset.title} preset`
                      }
                      onClick={() => handleInstallPreset(previewPreset)}
                      disabled={isPreviewPresetInstalled}
                      className="mt-[20px] w-full h-[39px] rounded-full bg-black hover:bg-[#0051ff] text-white text-[13px] font-medium transition-colors cursor-pointer disabled:cursor-not-allowed disabled:bg-[#777777] disabled:hover:bg-[#777777]"
                    >
                      {isPreviewPresetInstalled ? 'Installed' : 'Install'}
                    </button>
                  </div>
                  <div className="md:max-w-[540px] md:pt-[8px] md:text-right">
                    <p className="text-[15px] leading-[1.5] text-[#888]">
                      {previewPresetDetails.description}
                    </p>
                    <p className="mt-[8px] text-[15px] text-[#222]">
                      <span className="font-semibold">Author:</span>{' '}
                      {previewPresetDetails.author}
                    </p>
                  </div>
                </header>

                <section className="mt-[58px] grid grid-cols-1 lg:grid-cols-[214px_minmax(0,1fr)] gap-x-[48px] gap-y-[30px]">
                  <div className="flex flex-col items-center lg:items-start">
                    <MacropadDevice
                      layer={previewPreset.layerKeymap}
                      selectedKey={null}
                      selectedEncoderSub={null}
                      dragOverTarget={null}
                      encoderAngle={45}
                      onSelectKey={() => {}}
                      onSelectEncoderSub={() => {}}
                      onHoverSlot={setHoveredPreviewSlot}
                      highlightedSlot={hoveredPreviewSlot}
                      showSlotNumbers
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-x-[36px] gap-y-[20px] content-start">
                    {previewPresetDetails.keys.map((action, index) => {
                      const keySlot = GRID_MACRO_KEY_SLOTS[index];
                      const isHovered = keySlot !== undefined && hoveredPreviewSlot === keySlot;
                      const shortcut = action.multi
                        ? `Tap ${formatPresetSequence(action.multi.onTap, presetOs).toLowerCase()}${
                            action.multi.doubleTap
                              ? ` · Double tap ${formatPresetSequence(action.multi.doubleTap, presetOs).toLowerCase()}`
                              : ''
                          }`
                        : formatPresetSequence(action.keys, presetOs).toLowerCase();
                      return (
                        <div
                          key={`${previewPreset.id}-key-${index}`}
                          onMouseEnter={() => setHoveredPreviewSlot(keySlot ?? null)}
                          onMouseLeave={() => setHoveredPreviewSlot(null)}
                          className="flex items-start gap-[11px] min-w-0"
                        >
                          <span
                            data-preview-action-number={index + 1}
                            className={`mt-[1px] w-[21px] h-[21px] shrink-0 rounded-full bg-white text-[9px] font-medium flex items-center justify-center transition-all duration-150 ${
                              isHovered
                                ? 'text-[#0051ff] ring-1 ring-[#0051ff] shadow-[0_0_9px_rgba(0,81,255,0.65)]'
                                : 'text-[#444] shadow-[0_1px_2px_rgba(0,0,0,0.05)]'
                            }`}
                          >
                            {index + 1}
                          </span>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-baseline gap-x-[9px] gap-y-[2px]">
                              <span className="text-[14px] font-medium leading-[1.2] text-[#222]">
                                {action.name}
                              </span>
                              <span className="text-[12px] font-medium leading-[1.2] text-[#222]">
                                {shortcut}
                              </span>
                            </div>
                            <p className="mt-[4px] text-[11.5px] leading-[1.35] text-[#999]">
                              {action.description}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <div className="mt-[34px] h-px bg-black/[0.09]" />

                <section className="pt-[24px] grid grid-cols-1 lg:grid-cols-[214px_minmax(0,1fr)] gap-x-[48px] gap-y-[24px]">
                  <div className="flex flex-col items-center">
                    <div className="text-[13px] text-[#666] mb-[9px]">Dial</div>
                    <div className="h-[68px] px-[17px] rounded-full bg-white shadow-[0_2px_8px_rgba(0,0,0,0.06)] flex items-center gap-[10px]">
                      {([
                        { direction: 'cw', text: 'CW', glyph: '↻' },
                        { direction: 'press', text: 'PRESS', glyph: '↓' },
                        { direction: 'ccw', text: 'CCW', glyph: '↺' },
                      ] as const).map((item, index) => {
                        const actionNumber = previewPresetDetails.keys.length + index + 1;
                        const isHovered = hoveredPreviewDial === item.direction;
                        return (
                          <div
                            key={item.direction}
                            data-preview-dial-control={item.direction}
                            onMouseEnter={() => setHoveredPreviewDial(item.direction)}
                            onMouseLeave={() => setHoveredPreviewDial(null)}
                            className="relative"
                          >
                            <span
                              data-preview-dial-control-number={actionNumber}
                              className={`absolute -top-[5px] -right-[3px] z-10 w-[15px] h-[15px] rounded-full bg-white text-[8px] font-medium flex items-center justify-center transition-all duration-150 ${
                                isHovered
                                  ? 'text-[#0051ff] ring-1 ring-[#0051ff] shadow-[0_0_9px_rgba(0,81,255,0.65)]'
                                  : 'text-[#444] shadow-[0_1px_2px_rgba(0,0,0,0.1)]'
                              }`}
                            >
                              {actionNumber}
                            </span>
                            <div
                              data-preview-dial-circle={item.direction}
                              className={`w-[48px] h-[48px] rounded-full bg-[#171717] text-white flex flex-col items-center justify-center transition-all duration-150 ${
                                isHovered
                                  ? 'ring-2 ring-[#0051ff] shadow-[0_0_12px_rgba(0,81,255,0.65)]'
                                  : ''
                              }`}
                            >
                              <span className="text-[15px] leading-none text-[#0051ff]">{item.glyph}</span>
                              <span className="mt-[2px] text-[8px] font-semibold tracking-[0.04em] text-white/80">
                                {item.text}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-x-[36px] gap-y-[20px] content-start">
                    {([
                      { direction: 'cw', action: previewPresetDetails.dial.cw },
                      { direction: 'press', action: previewPresetDetails.dial.press },
                      { direction: 'ccw', action: previewPresetDetails.dial.ccw },
                    ] as const).map(({ direction, action }, index) => {
                      const actionNumber = previewPresetDetails.keys.length + index + 1;
                      const isHovered = hoveredPreviewDial === direction;
                      return (
                        <div
                          key={`${previewPreset.id}-dial-${direction}`}
                          onMouseEnter={() => setHoveredPreviewDial(direction)}
                          onMouseLeave={() => setHoveredPreviewDial(null)}
                          className="flex items-start gap-[11px] min-w-0"
                        >
                        <span
                          data-preview-dial-action-number={actionNumber}
                          className={`mt-[1px] w-[21px] h-[21px] shrink-0 rounded-full bg-white text-[9px] font-medium flex items-center justify-center transition-all duration-150 ${
                            isHovered
                              ? 'text-[#0051ff] ring-1 ring-[#0051ff] shadow-[0_0_9px_rgba(0,81,255,0.65)]'
                              : 'text-[#444] shadow-[0_1px_2px_rgba(0,0,0,0.05)]'
                          }`}
                        >
                          {actionNumber}
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-baseline gap-x-[9px] gap-y-[2px]">
                            <span className="text-[14px] font-medium leading-[1.2] text-[#222]">
                              {action.name}
                            </span>
                            <span className="text-[12px] font-medium leading-[1.2] text-[#222]">
                              {formatPresetSequence(action.keys, presetOs).toLowerCase()}
                            </span>
                          </div>
                          <p className="mt-[4px] text-[11.5px] leading-[1.35] text-[#999]">
                            {action.description}
                          </p>
                        </div>
                      </div>
                      );
                    })}
                  </div>
                </section>
              </div>
            </div>
          </motion.main>
        )}
      </AnimatePresence>

      {/* EDIT LAYOUT MODAL */}
      <AnimatePresence>
        {editLayoutModalOpen && (
          <motion.div
            key="edit-layout-modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/30 backdrop-blur-[1px] flex items-center justify-center z-50"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.94, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: 8 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="bg-white rounded-2xl w-[360px] p-5 shadow-xl border border-black/5"
            >
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-[#222]">
                  Edit Hardware Layout
                </h2>
                <button
                  onClick={() => setEditLayoutModalOpen(false)}
                  className="w-6 h-6 rounded-full border-[1.5px] border-transparent hover:border-[#0051ff] hover:bg-neutral-100 flex items-center justify-center text-[#777] transition-all cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <p className="text-xs text-[#666] mb-4">
                Grid Macro 1 has nine direct keys and one EC11 rotary encoder with a push switch.
              </p>

              <div className="grid grid-cols-[1fr_auto] gap-3 mb-5">
                <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3">
                  <div className="text-xs font-semibold text-[#222] mb-2">
                    3 × 3 key matrix
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {GRID_MACRO_KEY_SLOTS.map((slotId) => (
                      <div
                        key={slotId}
                        className="h-7 rounded-md bg-[#242424] text-white flex items-center justify-center text-[9px] font-medium"
                      >
                        {slotId.toUpperCase()}
                      </div>
                    ))}
                  </div>
                  <div className="text-[10px] text-[#777] mt-2">GP0–GP8</div>
                </div>
                <div className="min-w-[112px] rounded-xl border border-neutral-200 bg-neutral-50 p-3 flex flex-col items-center justify-center text-center">
                  <div className="w-10 h-10 rounded-full bg-[#2f2f2f] border border-[#444] flex items-center justify-center mb-2">
                    <div className="w-1 h-3 rounded-full bg-white/80 -translate-y-1" />
                  </div>
                  <div className="text-xs font-semibold text-[#222]">1 encoder</div>
                  <div className="text-[10px] text-[#777] mt-1">Turn · press</div>
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  onClick={() => setEditLayoutModalOpen(false)}
                  className="px-4 py-1.5 rounded-lg bg-[#0051ff] text-white text-xs font-medium hover:bg-[#0045d8] transition-colors cursor-pointer"
                >
                  Save Layout
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* FLOATING BLACK KEYCAP DRAG PREVIEW WITH SUBTLE CORNER-HELD CIRCULAR MOTION */}
      <AnimatePresence>
        {draggedTile && (
          <motion.div
            key="dragged-tile-preview"
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1.04 }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={{ duration: 0.12, ease: [0.22, 1, 0.36, 1] }}
            style={{
              left: draggedTile.x - 27,
              top: draggedTile.y - 27,
              y: dragSpringBobY,
              rotate: dragSpringRotate,
              transformOrigin: '22% 20%',
            }}
            className="fixed w-[54px] h-[54px] rounded-[9px] bg-[#000000] text-white shadow-[0_14px_28px_rgba(0,0,0,0.34)] flex flex-col items-center justify-center px-1 text-center pointer-events-none z-[100] select-none"
          >
            {draggedTile.item.iconId ? (
              <CustomPickerIcon id={draggedTile.item.iconId} size={20} />
            ) : draggedTile.item.emoji ? (
              <span className="text-[20px] leading-none">
                {draggedTile.item.emoji}
              </span>
            ) : draggedTile.item.isClearIcon ? (
              <EmptyKeyPlusIcon size={16} stroke="#ffffff" />
            ) : draggedTile.item.arrowDir ? (
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="#ffffff"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{
                  transform: `rotate(${
                    draggedTile.item.arrowDir === 'right'
                      ? 0
                      : draggedTile.item.arrowDir === 'down'
                      ? 90
                      : draggedTile.item.arrowDir === 'left'
                      ? 180
                      : -90
                  }deg)`,
                }}
              >
                <path d="M2.5 6H9.5M9.5 6L6.5 3M9.5 6L6.5 9" />
              </svg>
            ) : draggedTile.item.top ? (
              <div className="flex flex-col items-center leading-[1.15] text-[10.5px] font-medium">
                <span>{draggedTile.item.top}</span>
                <span>{draggedTile.item.main}</span>
              </div>
            ) : (
              <span className="text-[10.5px] font-medium leading-[1.15] text-center whitespace-pre-line">
                {draggedTile.sourceTab === 'Basic'
                  ? draggedTile.item.main
                  : formatCustomTileText(draggedTile.item.main)}
              </span>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* SUBTLE FEEDBACK TOAST */}
      <AnimatePresence>
        {toastMessage && (
          <motion.div
            key="feedback-toast"
            initial={{ opacity: 0, y: 12, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.94 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="fixed bottom-5 left-1/2 -translate-x-1/2 bg-black text-white text-[11px] font-medium px-4 py-1.5 rounded-full shadow-lg z-50"
          >
            {toastMessage}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ========================================================================== */
/* SUBCOMPONENTS                                                              */
/* ========================================================================== */

function IsometricKeyIcon({
  type,
  active,
}: {
  type: 'B' | 'A' | 'MA' | 'S';
  active: boolean;
}) {
  const strokeColor = active ? '#000000' : '#4a4a4a';

  if (type === 'MA') {
    return (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <path
          d="M14 13.5L22.5 18L14 22.5L5.5 18L14 13.5Z"
          stroke={strokeColor}
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <path
          d="M5.5 18V20.2L14 24.7L22.5 20.2V18"
          stroke={strokeColor}
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <path
          d="M14 4.2L22.5 8.7L14 13.2L5.5 8.7L14 4.2Z"
          fill={active ? '#0051ff' : 'white'}
          stroke={strokeColor}
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <path
          d="M5.5 8.7V10.9L14 15.4L22.5 10.9V8.7"
          fill={active ? '#0051ff' : 'white'}
          stroke={strokeColor}
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <text
          x="14"
          y="10.2"
          textAnchor="middle"
          fill={strokeColor}
          fontSize="5.4"
          fontWeight="600"
          transform="rotate(-25 14 9)"
        >
          M
        </text>
        <text
          x="14"
          y="20.2"
          textAnchor="middle"
          fill={strokeColor}
          fontSize="5.4"
          fontWeight="600"
          transform="rotate(-25 14 19)"
        >
          A
        </text>
      </svg>
    );
  }

  return (
    <svg width="30" height="26" viewBox="0 0 30 26" fill="none">
      <path
        d="M15 4.2L26.2 10.4L15 16.6L3.8 10.4L15 4.2Z"
        stroke={strokeColor}
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M3.8 10.4V14.2L15 20.4L26.2 14.2V10.4"
        stroke={strokeColor}
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <text
        x="15"
        y="12.5"
        textAnchor="middle"
        fill={strokeColor}
        fontSize="7.5"
        fontWeight="600"
        transform="rotate(-26 15 11)"
      >
        {type}
      </text>
      {type === 'S' && (
        <path
          d="M20.5 3.2L21.4 5.9L24.1 6.8L21.4 7.7L20.5 10.4L19.6 7.7L16.9 6.8L19.6 5.9L20.5 3.2Z"
          fill={strokeColor}
        />
      )}
    </svg>
  );
}

function ArrowKeyGlyph({ dir }: { dir: 'right' | 'left' | 'down' | 'up' }) {
  const rotation =
    dir === 'right'
      ? 0
      : dir === 'down'
      ? 90
      : dir === 'left'
      ? 180
      : -90;
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 12 12"
      fill="none"
      stroke="#222222"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: `rotate(${rotation}deg)` }}
    >
      <path d="M2.5 6H9.5M9.5 6L6.5 3M9.5 6L6.5 9" />
    </svg>
  );
}

function InfoCircleIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 7.2V11.2" strokeLinecap="round" />
      <circle cx="8" cy="4.9" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

function WarningTriangleIcon({ color }: { color: string }) {
  return (
    <svg
      width="15"
      height="14"
      viewBox="0 0 16 15"
      fill="none"
      stroke={color}
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 1.5L14.8 13.5H1.2L8 1.5Z" />
      <path d="M8 6V9.2" />
      <circle cx="8" cy="11.4" r="0.6" fill={color} stroke="none" />
    </svg>
  );
}

function SettingsSwitch({
  checked,
  onChange,
  disabled = false,
  title,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled}
      disabled={disabled}
      title={title}
      onClick={onChange}
      className={`w-[29px] h-[16px] rounded-full p-[2px] flex items-center transition-colors duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
        checked ? 'bg-[#000000] justify-end' : 'bg-[#b3b3b3] justify-start'
      }`}
    >
      <motion.span
        layout
        transition={{ type: 'spring', stiffness: 520, damping: 32 }}
        className="w-[12px] h-[12px] rounded-full bg-white shadow-xs"
      />
    </button>
  );
}

type PresetAppIconConfig = {
  iconId?: string;
  label: string;
  background: string;
  foreground: string;
  iconMode?: 'fill' | 'stroke';
};

const PRESET_APP_ICON_CONFIGS: Record<string, PresetAppIconConfig> = {
  chatgpt: { iconId: 'brand-openai', label: 'AI', background: 'linear-gradient(145deg, #20b98e, #087157)', foreground: '#ffffff', iconMode: 'stroke' },
  vscode: { iconId: 'brand-vscode', label: 'VS', background: 'linear-gradient(145deg, #35b8ed, #0068b7)', foreground: '#ffffff', iconMode: 'stroke' },
  github: { iconId: 'brand-github', label: 'GH', background: 'linear-gradient(145deg, #41454d, #17191e)', foreground: '#ffffff', iconMode: 'fill' },
  terminal: { iconId: 'terminal', label: '>_', background: 'linear-gradient(145deg, #26384b, #101722)', foreground: '#a5f3c3', iconMode: 'stroke' },
  docker: { iconId: 'brand-docker', label: 'D', background: 'linear-gradient(145deg, #43bdf0, #0878c9)', foreground: '#ffffff', iconMode: 'fill' },
  chrome_devtools: { iconId: 'brand-chrome', label: 'C', background: 'linear-gradient(145deg, #424854, #20242c)', foreground: '#ffffff', iconMode: 'fill' },
  photoshop: { iconId: 'brand-adobe-photoshop', label: 'Ps', background: 'linear-gradient(145deg, #06395a, #001e36)', foreground: '#45b8ff', iconMode: 'stroke' },
  illustrator: { iconId: 'brand-adobe-illustrator', label: 'Ai', background: 'linear-gradient(145deg, #542100, #2b0800)', foreground: '#ffad35', iconMode: 'stroke' },
  premiere: { iconId: 'brand-adobe-premiere', label: 'Pr', background: 'linear-gradient(145deg, #392d72, #18113e)', foreground: '#b9a8ff', iconMode: 'stroke' },
  aftereffects: { iconId: 'brand-adobe-after-effects', label: 'Ae', background: 'linear-gradient(145deg, #342361, #171333)', foreground: '#d9a9ff', iconMode: 'stroke' },
  davinci: { iconId: 'brand-davinciresolve', label: 'DR', background: 'linear-gradient(145deg, #343a46, #171b22)', foreground: '#ffffff', iconMode: 'fill' },
  blender: { iconId: 'brand-blender', label: 'Bl', background: 'linear-gradient(145deg, #39576b, #182a39)', foreground: '#ff9a44', iconMode: 'fill' },
  figma: { iconId: 'brand-figma', label: 'F', background: 'linear-gradient(145deg, #353535, #171717)', foreground: '#ffffff', iconMode: 'fill' },
  framer: { iconId: 'brand-framer', label: 'F', background: 'linear-gradient(145deg, #25baff, #0751e7)', foreground: '#ffffff', iconMode: 'fill' },
  canva: { label: 'C', background: 'linear-gradient(145deg, #00c4cc, #7134d8)', foreground: '#ffffff' },
  audacity: { iconId: 'brand-audacity', label: 'Au', background: 'linear-gradient(145deg, #343b70, #171b37)', foreground: '#ffe36b', iconMode: 'fill' },
  affinity: { label: 'A', background: 'linear-gradient(145deg, #6053b7, #14677a)', foreground: '#ffffff' },
  excel: { label: 'X', background: 'linear-gradient(145deg, #20a366, #075b36)', foreground: '#ffffff' },
  word: { label: 'W', background: 'linear-gradient(145deg, #3d8de6, #1557b0)', foreground: '#ffffff' },
  powerpoint: { label: 'P', background: 'linear-gradient(145deg, #f17848, #b93c1f)', foreground: '#ffffff' },
  notion: { iconId: 'brand-notion', label: 'N', background: 'linear-gradient(145deg, #ffffff, #e8e8e8)', foreground: '#171717', iconMode: 'fill' },
  slack: { iconId: 'brand-slack', label: 'S', background: 'linear-gradient(145deg, #ffffff, #f0eaf2)', foreground: '#611f69', iconMode: 'fill' },
  zoom: { iconId: 'brand-zoom', label: 'Z', background: 'linear-gradient(145deg, #55a5ff, #1674e8)', foreground: '#ffffff', iconMode: 'fill' },
  obs: { iconId: 'brand-obsstudio', label: 'OBS', background: 'linear-gradient(145deg, #424a56, #17191f)', foreground: '#ffffff', iconMode: 'fill' },
  discord: { iconId: 'brand-discord', label: 'D', background: 'linear-gradient(145deg, #8790ff, #4d58d7)', foreground: '#ffffff', iconMode: 'fill' },
  spotify: { iconId: 'brand-spotify', label: 'S', background: 'linear-gradient(145deg, #47e184, #14a84e)', foreground: '#102117', iconMode: 'fill' },
  windows: { iconId: 'brand-windows', label: '⊞', background: 'linear-gradient(145deg, #35a6ed, #0068bc)', foreground: '#ffffff', iconMode: 'fill' },
};

function getMacroIconLibrary(): IconLibrary | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { __MACRO_ICONS__?: IconLibrary }).__MACRO_ICONS__;
}

function getPresetAppIconPath(iconId: string): string | undefined {
  return getMacroIconLibrary()?.d?.[iconId];
}

function PresetAppIcon({ id, size = 30 }: { id: string; size?: number }) {
  const config = PRESET_APP_ICON_CONFIGS[id] ?? {
    label: '?',
    background: 'linear-gradient(145deg, #515866, #20242c)',
    foreground: '#ffffff',
  };
  const iconPath = config.iconId ? getPresetAppIconPath(config.iconId) : undefined;
  const iconMode = config.iconMode ?? 'fill';

  return (
    <div
      data-preset-icon={id}
      aria-hidden="true"
      className="flex items-center justify-center shrink-0 overflow-hidden"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        background: config.background,
        color: config.foreground,
        border: '1px solid rgba(255,255,255,0.22)',
        boxShadow: '0 2px 7px rgba(15,23,42,0.16), inset 0 1px 0 rgba(255,255,255,0.18)',
      }}
    >
      {iconPath ? (
        <svg
          width={Math.round(size * 0.6)}
          height={Math.round(size * 0.6)}
          viewBox="0 0 24 24"
          fill={iconMode === 'fill' ? 'currentColor' : 'none'}
          stroke={iconMode === 'stroke' ? 'currentColor' : 'none'}
          strokeWidth={iconMode === 'stroke' ? 1.7 : 0}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d={iconPath} />
        </svg>
      ) : id === 'affinity' ? (
        <svg
          width={Math.round(size * 0.6)}
          height={Math.round(size * 0.6)}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4.5 19L10.4 5.8c.6-1.3 2.6-1.3 3.2 0L19.5 19M7.8 13.2h8.4" />
        </svg>
      ) : (
        <span
          className={`font-bold leading-none tracking-tight select-none ${
            id === 'canva'
              ? 'font-serif italic text-[18px]'
              : id === 'affinity'
                ? 'text-[18px]'
                : ['excel', 'word', 'powerpoint'].includes(id)
                  ? 'text-[14px]'
                  : 'text-[12px]'
          }`}
          style={size > 30 ? { fontSize: `${Math.round(size * 0.36)}px` } : undefined}
        >
          {config.label}
        </span>
      )}
    </div>
  );
}

function EmptyKeyPlusIcon({
  size = 16,
  stroke = '#ffffff',
}: {
  size?: number;
  stroke?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      className="pointer-events-none"
    >
      <rect
        x="1.75"
        y="1.75"
        width="14.5"
        height="14.5"
        rx="6"
        stroke={stroke}
        strokeWidth="1.6"
      />
      <line
        x1="9"
        y1="5.8"
        x2="9"
        y2="12.2"
        stroke={stroke}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <line
        x1="5.8"
        y1="9"
        x2="12.2"
        y2="9"
        stroke={stroke}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface MacropadDeviceProps {
  layer: LayerKeymap;
  selectedKey: KeySlotId | null;
  selectedEncoderSub: EncoderSubActionId | null;
  dragOverTarget: { slotId: KeySlotId; subAction?: EncoderSubActionId } | null;
  draggedFromSlot?: KeySlotId | null;
  encoderAngle: number;
  onSelectKey: (slotId: KeySlotId) => void;
  onSelectEncoderSub: (
    slotId: typeof GRID_MACRO_ENCODER_SLOT,
    sub: EncoderSubActionId
  ) => void;
  onStartKeyDrag?: (
    e: React.PointerEvent,
    slotId: KeySlotId,
    sub?: EncoderSubActionId
  ) => void;
  onHoverSlot?: (slotId: KeySlotId | null) => void;
  highlightedSlot?: KeySlotId | null;
  entrancePhase?: EntrancePhase;
  showSlotNumbers?: boolean;
}

function MacropadDevice({
  layer,
  selectedKey,
  selectedEncoderSub,
  dragOverTarget,
  draggedFromSlot = null,
  encoderAngle,
  onSelectKey,
  onSelectEncoderSub,
  onStartKeyDrag = () => {},
  onHoverSlot,
  highlightedSlot = null,
  entrancePhase,
  showSlotNumbers = false,
}: MacropadDeviceProps) {
  const isEncoderOpen = selectedKey === GRID_MACRO_ENCODER_SLOT;

  return (
    <div className="relative flex items-center justify-center">
      <AnimatePresence>
        {isEncoderOpen && (
          <EncoderPopupCapsule
            key="grid-macro-encoder-popup"
            slotId={GRID_MACRO_ENCODER_SLOT}
            side="right"
            actions={getEncoderActions(layer[GRID_MACRO_ENCODER_SLOT])}
            selectedSub={selectedEncoderSub}
            dragOverSub={
              dragOverTarget?.slotId === GRID_MACRO_ENCODER_SLOT
                ? dragOverTarget.subAction || null
                : null
            }
            onSelectSub={(sub) =>
              onSelectEncoderSub(GRID_MACRO_ENCODER_SLOT, sub)
            }
            onStartSubDrag={(e, sub) =>
              onStartKeyDrag(e, GRID_MACRO_ENCODER_SLOT, sub)
            }
          />
        )}
      </AnimatePresence>

      <div className="w-[172px] bg-[#050505] rounded-[24px] p-[12px] flex flex-col items-center justify-center shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
        <div className="w-full bg-[#151515] rounded-[16px] p-[6px] flex flex-col gap-[6px]">
          <div className="grid grid-cols-3 gap-[3px] items-center h-[42px] w-full">
            <motion.div
              {...getEntranceMotionProps(entrancePhase, {
                delay: 0.96,
                duration: 0.4,
                offsetY: 5,
                initialScale: 0.98,
              })}
              className="w-[42px] h-[42px] flex items-center justify-center select-none"
            >
              <span className="w-[5px] h-[5px] rounded-full bg-[#e8e8e8] shadow-[0_0_6px_rgba(255,255,255,0.85)]" />
            </motion.div>
            <div className="w-[42px] h-[42px]" />
            <motion.div
              {...getEntranceMotionProps(entrancePhase, {
                delay: 0.96,
                duration: 0.4,
                offsetY: 5,
                initialScale: 0.98,
              })}
              className="w-[42px] h-[42px] flex items-center justify-center"
            >
              <FlatDialControl
                selected={isEncoderOpen}
                angle={encoderAngle}
                title={`Dial: ${layer[GRID_MACRO_ENCODER_SLOT].binding}`}
                onClick={() => onSelectKey(GRID_MACRO_ENCODER_SLOT)}
              />
            </motion.div>
          </div>

          <div className="grid grid-cols-3 grid-rows-3 gap-[3px] place-items-center">
            {GRID_MACRO_KEY_SLOTS.map((slotId, index) => (
              <KeycapButton
                key={slotId}
                entrancePhase={entrancePhase}
                entranceIndex={index}
                slotId={slotId}
                label={layer[slotId].label}
                binding={layer[slotId].binding}
                iconId={layer[slotId].iconId}
                color={showSlotNumbers ? undefined : layer[slotId].color}
                slotNumber={showSlotNumbers ? index + 1 : undefined}
                selected={selectedKey === slotId}
                dragOver={dragOverTarget?.slotId === slotId}
                isDraggingSource={draggedFromSlot === slotId}
                onClick={() => onSelectKey(slotId)}
                onPointerDown={(e) => onStartKeyDrag(e, slotId)}
                onHoverSlot={onHoverSlot}
                previewHighlighted={highlightedSlot === slotId}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function FlatDialControl({
  selected,
  angle,
  title,
  onClick,
}: {
  selected: boolean;
  angle: number;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-[39px] h-[39px] rounded-full relative flex items-center justify-center border-[1.5px] transition-all duration-150 cursor-pointer focus:outline-none select-none ${
        selected
          ? 'border-[#0051ff] shadow-[0_0_16px_rgba(0,81,255,0.85)] z-10'
          : 'border-transparent hover:border-[#0051ff] hover:z-10'
      }`}
    >
      <svg
        width="39"
        height="39"
        viewBox="0 0 40 40"
        className="transition-transform duration-150 pointer-events-none"
        style={{ transform: `rotate(${angle - 45}deg)` }}
      >
        <defs>
          <linearGradient id="dialUpperLeft" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#1b1b1b" />
            <stop offset="48%" stopColor="#353535" />
            <stop offset="50%" stopColor="#4c4c4c" />
            <stop offset="52%" stopColor="#262626" />
            <stop offset="100%" stopColor="#333333" />
          </linearGradient>
          <linearGradient id="dialSelectedBlue" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#0051ff" />
            <stop offset="49%" stopColor="#0051ff" />
            <stop offset="51%" stopColor="#003ec7" />
            <stop offset="100%" stopColor="#004be8" />
          </linearGradient>
        </defs>
        <circle
          cx="20"
          cy="20"
          r="19"
          fill={selected ? 'url(#dialSelectedBlue)' : 'url(#dialUpperLeft)'}
          stroke={selected ? '#0051ff' : '#262626'}
          strokeWidth="0.8"
        />
        <line
          x1="6.5"
          y1="33.5"
          x2="33.5"
          y2="6.5"
          stroke={selected ? 'rgba(255,255,255,0.45)' : '#4a4a4a'}
          strokeWidth="1.1"
          strokeOpacity="0.7"
        />
      </svg>
    </button>
  );
}

function EncoderPopupCapsule({
  slotId,
  side,
  actions,
  selectedSub,
  dragOverSub,
  onSelectSub,
  onStartSubDrag,
}: {
  slotId: typeof GRID_MACRO_ENCODER_SLOT;
  side: 'left' | 'right';
  actions: Record<EncoderSubActionId, EncoderSubBinding>;
  selectedSub: EncoderSubActionId | null;
  dragOverSub: EncoderSubActionId | null;
  onSelectSub: (sub: EncoderSubActionId) => void;
  onStartSubDrag: (e: React.PointerEvent, sub: EncoderSubActionId) => void;
}) {
  const [hoveredSub, setHoveredSub] = useState<EncoderSubActionId | null>(null);

  const items: { id: EncoderSubActionId; bottomText?: string }[] = [
    { id: 'cw', bottomText: 'CW' },
    { id: 'press' },
    { id: 'ccw', bottomText: 'CCW' },
  ];

  return (
    <motion.div
      initial={{
        opacity: 0,
        scale: 0.84,
        x: side === 'left' ? 18 : -18,
        filter: 'blur(2px)',
      }}
      animate={{
        opacity: 1,
        scale: 1,
        x: 0,
        filter: 'blur(0px)',
      }}
      exit={{
        opacity: 0,
        scale: 0.86,
        x: side === 'left' ? 14 : -14,
        filter: 'blur(2px)',
      }}
      transition={{ duration: 0.25, ease: [0.32, 0.72, 0, 1] }}
      style={{
        transformOrigin: side === 'left' ? 'right center' : 'left center',
      }}
      className={`absolute top-[11px] ${
        side === 'left' ? 'right-[calc(100%+7px)]' : 'left-[calc(100%+7px)]'
      } h-[58px] px-[6px] rounded-full bg-[#e2e2e2] shadow-[0_3px_12px_rgba(0,0,0,0.08)] border border-black/[0.03] flex items-center gap-[6px] z-30`}
    >
      {items.map((item) => {
        const subData = actions[item.id];
        const isSelected = selectedSub === item.id;
        const isDragOver = dragOverSub === item.id;
        const isHovered = hoveredSub === item.id || isDragOver;
        const accentStroke = isSelected ? '#ffffff' : '#0051ff';

        return (
          <div key={item.id} className="relative flex items-center justify-center">
            {/* Floating white assigned-key pill above hovered sub-button */}
            <AnimatePresence>
              {isHovered && (
                <motion.div
                  initial={{ opacity: 0, y: 5, scale: 0.94 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 4, scale: 0.94 }}
                  transition={{ duration: 0.15, ease: [0.32, 0.72, 0, 1] }}
                  className="absolute -top-[36px] left-1/2 -translate-x-1/2 h-[27px] px-[13px] rounded-full bg-white shadow-[0_2px_8px_rgba(0,0,0,0.07)] flex items-center justify-center text-[11px] font-medium text-[#555555] whitespace-nowrap pointer-events-none z-40"
                >
                  {subData.binding}
                </motion.div>
              )}
            </AnimatePresence>

            <button
              data-drop-slot={slotId}
              data-drop-encoder-sub={item.id}
              onPointerDown={(e) => onStartSubDrag(e, item.id)}
              onClick={() => onSelectSub(item.id)}
              onMouseEnter={() => setHoveredSub(item.id)}
              onMouseLeave={() => setHoveredSub(null)}
              className={`w-[46px] h-[46px] rounded-full relative flex flex-col items-center justify-center border-[1.5px] transition-all duration-150 cursor-pointer focus:outline-none select-none ${
                isSelected
                  ? 'bg-[#0051ff] border-[#0051ff] text-white shadow-[0_0_14px_rgba(0,81,255,0.85)]'
                  : isDragOver
                  ? 'bg-[#313131] text-white border-[#0051ff] shadow-[0_0_10px_rgba(0,81,255,0.5)]'
                  : 'bg-[#313131] text-white border-transparent hover:border-[#0051ff]'
              }`}
            >
              {/* SVG Directional Arrows (CW arc, Press down arrow, CCW arc) in Blue theme */}
              <svg
                width="46"
                height="46"
                viewBox="0 0 46 46"
                fill="none"
                className="absolute inset-0 pointer-events-none"
              >
                {item.id === 'cw' && (
                  <>
                    <path
                      d="M 6.2 22.5 A 16.8 16.8 0 0 1 20.5 6.8"
                      stroke={accentStroke}
                      strokeWidth="1.35"
                      strokeLinecap="round"
                    />
                    <path
                      d="M 17.2 4.8 L 21.1 6.7 L 18.4 10.3"
                      stroke={accentStroke}
                      strokeWidth="1.35"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </>
                )}

                {item.id === 'press' && (
                  <>
                    <path
                      d="M 23 30.5 L 23 39.2"
                      stroke={accentStroke}
                      strokeWidth="1.35"
                      strokeLinecap="round"
                    />
                    <path
                      d="M 19.8 36.2 L 23 39.5 L 26.2 36.2"
                      stroke={accentStroke}
                      strokeWidth="1.35"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </>
                )}

                {item.id === 'ccw' && (
                  <>
                    <path
                      d="M 39.8 22.5 A 16.8 16.8 0 0 0 25.5 6.8"
                      stroke={accentStroke}
                      strokeWidth="1.35"
                      strokeLinecap="round"
                    />
                    <path
                      d="M 28.8 4.8 L 24.9 6.7 L 27.6 10.3"
                      stroke={accentStroke}
                      strokeWidth="1.35"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </>
                )}
              </svg>

              {/* Center Short Assigned Label (e.g. vo..., pl...) */}
              <span
                className={`text-[10.5px] font-medium leading-none tracking-[0.01em] z-10 ${
                  item.id === 'press' ? '-mt-[4px]' : 'mt-[4px]'
                }`}
              >
                {subData.label}
              </span>

              {/* Bottom CW / CCW Label */}
              {item.bottomText && (
                <span className="text-[8.5px] font-semibold leading-none tracking-[0.03em] mt-[3px] z-10">
                  {item.bottomText}
                </span>
              )}
            </button>
          </div>
        );
      })}
    </motion.div>
  );
}

interface KeycapButtonProps {
  entrancePhase?: EntrancePhase;
  entranceIndex?: number;
  slotId: KeySlotId;
  label: string;
  binding: string;
  iconId?: string;
  color?: string;
  slotNumber?: number;
  selected: boolean;
  dragOver?: boolean;
  isDraggingSource?: boolean;
  isLowercase?: boolean;
  onClick: () => void;
  onPointerDown?: (e: React.PointerEvent) => void;
  onHoverSlot?: (slotId: KeySlotId | null) => void;
  previewHighlighted?: boolean;
}

function KeycapButton({
  entrancePhase,
  entranceIndex,
  slotId,
  label,
  binding,
  iconId,
  color,
  slotNumber,
  selected,
  dragOver,
  isDraggingSource,
  isLowercase,
  onClick,
  onPointerDown,
  onHoverSlot,
  previewHighlighted = false,
}: KeycapButtonProps) {
  const isEmpty =
    !iconId && (!label || label === '—' || binding === 'blank');
  const isMultiWordCustom = !iconId && !isEmpty && label.length > 4;
  const entranceProps =
    entranceIndex === undefined
      ? {}
      : getEntranceMotionProps(
          entrancePhase,
          getKeycapEntranceOptions(entranceIndex)
        );

  return (
    <motion.button
      {...entranceProps}
      data-drop-slot={slotId}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onMouseEnter={() => onHoverSlot?.(slotId)}
      onMouseLeave={() => onHoverSlot?.(null)}
      title={binding}
      style={color && !isEmpty && !selected && !dragOver && !isDraggingSource
        ? { backgroundColor: color, borderColor: color }
        : undefined}
      className={`${slotNumber !== undefined ? 'group ' : ''}w-[42px] h-[42px] rounded-[5px] border-[1.5px] flex items-center justify-center transition-all duration-150 cursor-grab active:cursor-grabbing focus:outline-none select-none ${
        isMultiWordCustom
          ? 'text-[8.5px] font-medium leading-[1.08] px-[2px] text-center'
          : isLowercase
          ? 'text-[11px] font-normal'
          : 'text-[11.5px] font-medium'
      } ${
        previewHighlighted
          ? 'bg-[#313131] text-[#f3f3f3] border-[#0051ff] shadow-[0_0_12px_rgba(0,81,255,0.65)] z-10'
          : isDraggingSource
          ? 'bg-[#1e1e1e] text-[#6d6d6d] border-transparent'
          : selected
          ? 'bg-[#0051ff] border-[#0051ff] text-white shadow-[0_0_16px_rgba(0,81,255,0.85)] z-10'
          : dragOver
          ? 'bg-[#313131] text-[#f3f3f3] border-[#0051ff] z-10'
          : 'bg-[#313131] text-[#f3f3f3] border-t-[#3e3e3e] border-l-[#3e3e3e] border-b-[#252525] border-r-[#252525] hover:border-[#0051ff] hover:z-10 active:scale-[0.97]'
      }`}
    >
      {slotNumber !== undefined ? (
        <span
          data-preview-slot-number={slotNumber}
          className={`text-[12px] font-medium leading-none text-white pointer-events-none transition-[filter] duration-150 ${
            previewHighlighted
              ? 'drop-shadow-[0_0_6px_#0051ff]'
              : 'group-hover:drop-shadow-[0_0_6px_#0051ff]'
          }`}
        >
          {slotNumber}
        </span>
      ) : iconId ? (
        <CustomPickerIcon id={iconId} size={17} />
      ) : isEmpty ? (
        <EmptyKeyPlusIcon size={16} stroke="#ffffff" />
      ) : (
        <span
          className={
            isMultiWordCustom
              ? 'leading-[1.08] break-words line-clamp-3'
              : 'leading-none tracking-[0.01em]'
          }
        >
          {label}
        </span>
      )}
    </motion.button>
  );
}

interface KnobControlProps {
  selected: boolean;
  angle: number;
  title: string;
  onClick: () => void;
}

function KnobControl({
  selected,
  angle,
  title,
  onClick,
}: KnobControlProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-[39px] h-[39px] rounded-full relative flex items-center justify-center border-[1.5px] transition-all duration-150 cursor-pointer focus:outline-none select-none ${
        selected
          ? 'bg-[#0051ff] border-[#0051ff] shadow-[0_0_16px_rgba(0,81,255,0.85)] z-10'
          : 'border-transparent hover:border-[#0051ff] hover:z-10'
      }`}
    >
      <svg
        width="39"
        height="39"
        viewBox="0 0 40 40"
        className="transition-transform duration-150 pointer-events-none"
        style={{ transform: `rotate(${angle}deg)` }}
      >
        <circle
          cx="20"
          cy="20"
          r="19"
          fill={selected ? '#0051ff' : '#2f2f2f'}
          stroke={selected ? '#0051ff' : '#3b3b3b'}
          strokeWidth="0.9"
        />
        <line
          x1="7.2"
          y1="7.2"
          x2="15.2"
          y2="15.2"
          stroke={selected ? '#ffffff' : '#151515'}
          strokeWidth="1.35"
          strokeLinecap="round"
        />
        <line
          x1="32.8"
          y1="7.2"
          x2="24.8"
          y2="15.2"
          stroke={selected ? '#ffffff' : '#151515'}
          strokeWidth="1.35"
          strokeLinecap="round"
        />
        <line
          x1="7.2"
          y1="32.8"
          x2="15.2"
          y2="24.8"
          stroke={selected ? '#ffffff' : '#151515'}
          strokeWidth="1.35"
          strokeLinecap="round"
        />
        <line
          x1="32.8"
          y1="32.8"
          x2="24.8"
          y2="24.8"
          stroke={selected ? '#ffffff' : '#151515'}
          strokeWidth="1.35"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}

/* ========================================================================== */
/* REAL VECTOR ICON RENDERER FOR SELECT ICON DRAWER & SAVED CUSTOM TILES      */
/* ========================================================================== */

const INLINE_CUSTOM_ICON_IDS = new Set([
  'copy-plus', 'layers-plus', 'plus-square', 'stop-square', 'rows-two', 'type-square',
  'diamonds', 'circle-fill', 'square-fill', 'globe', 'sparkles', 'play-square', 'image',
  'refresh', 'arrow-left', 'arrow-right', 'grid-four', 'lock', 'chat-bubble', 'clock',
  'pause-circle', 'zap', 'maximize', 'apps-plus', 'hexagon-nut', 'minimize', 'moon',
  'framer-bolt', 'database', 'play-triangle', 'terminal', 'volume',
]);

function CustomPickerIcon({ id, size = 14 }: { id: string; size?: number }) {
  if (id.startsWith('num-')) {
    const digit = id.replace('num-', '');
    return (
      <span
        style={{ fontSize: `${Math.max(10, Math.round(size * 0.85))}px` }}
        className="font-semibold leading-none tracking-tight select-none"
      >
        {digit}
      </span>
    );
  }

  const isInlineIcon = INLINE_CUSTOM_ICON_IDS.has(id);
  const catalogIconPath = isInlineIcon ? undefined : getPresetAppIconPath(id);
  const iconMetadata = catalogIconPath
    ? findIconMetadata(getMacroIconLibrary(), id)
    : undefined;
  const isFilledIcon = iconMetadata?.t === 'f';

  return (
    <svg
      width={size}
      height={size}
      viewBox={catalogIconPath ? '0 0 24 24' : '0 0 16 16'}
      fill={isFilledIcon ? 'currentColor' : 'none'}
      stroke={isFilledIcon ? 'none' : 'currentColor'}
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {id === 'copy-plus' && (
        <>
          <rect x="5" y="5" width="8.5" height="8.5" rx="1.6" fill="currentColor" stroke="none" />
          <path d="M3 10.5V3.8C3 3.1 3.5 2.5 4.2 2.5H10.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M9.25 7.2V11.3M7.2 9.25H11.3" stroke="#ffffff" strokeWidth="1.3" />
        </>
      )}
      {id === 'layers-plus' && (
        <>
          <rect x="2.5" y="2.5" width="8.5" height="8.5" rx="1.6" fill="currentColor" stroke="none" />
          <path d="M13 5.5V12.2C13 12.9 12.5 13.5 11.8 13.5H5.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M6.75 4.7V8.8M4.7 6.75H8.8" stroke="#ffffff" strokeWidth="1.3" />
        </>
      )}
      {id === 'plus-square' && (
        <>
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />
          <path d="M8 5.2V10.8M5.2 8H10.8" stroke="#ffffff" strokeWidth="1.4" />
        </>
      )}
      {id === 'stop-square' && (
        <rect x="2.5" y="2.5" width="11" height="11" rx="2.2" fill="currentColor" stroke="none" />
      )}
      {id === 'rows-two' && (
        <>
          <rect x="2.5" y="3" width="11" height="4.2" rx="1.4" fill="currentColor" stroke="none" />
          <rect x="2.5" y="8.8" width="11" height="4.2" rx="1.4" fill="currentColor" stroke="none" />
        </>
      )}
      {id === 'type-square' && (
        <>
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />
          <path d="M5.5 5.5H10.5M8 5.5V11" stroke="#ffffff" strokeWidth="1.4" />
        </>
      )}
      {id === 'diamonds' && (
        <>
          <polygon points="8,1.8 10.3,4.1 8,6.4 5.7,4.1" fill="currentColor" stroke="none" />
          <polygon points="8,9.6 10.3,11.9 8,14.2 5.7,11.9" fill="currentColor" stroke="none" />
          <polygon points="4.1,5.7 6.4,8 4.1,10.3 1.8,8" fill="currentColor" stroke="none" />
          <polygon points="11.9,5.7 14.2,8 11.9,10.3 9.6,8" fill="currentColor" stroke="none" />
        </>
      )}
      {id === 'circle-fill' && (
        <circle cx="8" cy="8" r="5.5" fill="currentColor" stroke="none" />
      )}
      {id === 'square-fill' && (
        <rect x="3" y="3" width="10" height="10" rx="1.2" fill="currentColor" stroke="none" />
      )}
      {id === 'globe' && (
        <>
          <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" />
          <ellipse cx="8" cy="8" rx="2.5" ry="5.5" stroke="currentColor" strokeWidth="1.2" />
          <path d="M2.8 8H13.2" stroke="currentColor" strokeWidth="1.2" />
        </>
      )}
      {id === 'sparkles' && (
        <>
          <path
            d="M7.5 2L8.8 6.2L13 7.5L8.8 8.8L7.5 13L6.2 8.8L2 7.5L6.2 6.2L7.5 2Z"
            fill="currentColor"
            stroke="none"
          />
          <circle cx="12.5" cy="3.5" r="1" fill="currentColor" stroke="none" />
        </>
      )}
      {id === 'play-square' && (
        <>
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />
          <polygon points="6.5,5.5 10.8,8 6.5,10.5" fill="#ffffff" stroke="none" />
        </>
      )}
      {id === 'image' && (
        <>
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />
          <circle cx="5.6" cy="5.8" r="1" fill="#ffffff" stroke="none" />
          <path d="M3.5 11.5L6.8 8.2L9.2 10.5L10.8 9L12.5 11.5" stroke="#ffffff" strokeWidth="1.2" />
        </>
      )}
      {id === 'refresh' && (
        <>
          <path d="M12.5 6A5 5 0 1 0 13 9.5" stroke="currentColor" strokeWidth="1.5" />
          <polyline points="13,3 13,6.2 9.8,6.2" stroke="currentColor" strokeWidth="1.5" />
        </>
      )}
      {id === 'arrow-left' && (
        <path d="M13 8H3M3 8L7 4M3 8L7 12" stroke="currentColor" strokeWidth="1.6" />
      )}
      {id === 'arrow-right' && (
        <path d="M3 8H13M13 8L9 4M13 8L9 12" stroke="currentColor" strokeWidth="1.6" />
      )}
      {id === 'grid-four' && (
        <>
          <rect x="2.5" y="2.5" width="4.6" height="4.6" rx="1" fill="currentColor" stroke="none" />
          <rect x="8.9" y="2.5" width="4.6" height="4.6" rx="1" fill="currentColor" stroke="none" />
          <rect x="2.5" y="8.9" width="4.6" height="4.6" rx="1" fill="currentColor" stroke="none" />
          <rect x="8.9" y="8.9" width="4.6" height="4.6" rx="1" fill="currentColor" stroke="none" />
        </>
      )}
      {id === 'lock' && (
        <>
          <rect x="3.2" y="7" width="9.6" height="6.8" rx="1.8" fill="currentColor" stroke="none" />
          <path d="M5.2 7V5.2A2.8 2.8 0 0 1 10.8 5.2V7" stroke="currentColor" strokeWidth="1.5" />
        </>
      )}
      {id === 'chat-bubble' && (
        <path
          d="M8 2.5C4.7 2.5 2 4.8 2 7.7C2 9.3 2.8 10.7 4.1 11.6L3.2 13.8L6 12.6C6.6 12.8 7.3 12.9 8 12.9C11.3 12.9 14 10.6 14 7.7C14 4.8 11.3 2.5 8 2.5Z"
          fill="currentColor"
          stroke="none"
        />
      )}
      {id === 'clock' && (
        <>
          <circle cx="8" cy="8" r="5.8" fill="currentColor" stroke="none" />
          <path d="M8 4.8V8.2L10.4 9.6" stroke="#ffffff" strokeWidth="1.4" />
        </>
      )}
      {id === 'pause-circle' && (
        <>
          <rect x="3.5" y="3" width="3.4" height="10" rx="1.2" fill="currentColor" stroke="none" />
          <rect x="9.1" y="3" width="3.4" height="10" rx="1.2" fill="currentColor" stroke="none" />
        </>
      )}
      {id === 'zap' && (
        <polygon
          points="9,1.8 3.5,9 7.8,9 7,14.2 12.5,7 8.2,7"
          fill="currentColor"
          stroke="none"
        />
      )}
      {id === 'maximize' && (
        <>
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />
          <path d="M6 10L10 6M10 6H7M10 6V9" stroke="#ffffff" strokeWidth="1.3" />
        </>
      )}
      {id === 'apps-plus' && (
        <>
          <rect x="2.5" y="2.5" width="11" height="11" rx="2.2" fill="currentColor" stroke="none" />
          <circle cx="5.7" cy="5.7" r="1.1" fill="#ffffff" stroke="none" />
          <circle cx="10.3" cy="5.7" r="1.1" fill="#ffffff" stroke="none" />
          <circle cx="5.7" cy="10.3" r="1.1" fill="#ffffff" stroke="none" />
          <path d="M10.3 8.8V11.8M8.8 10.3H11.8" stroke="#ffffff" strokeWidth="1.2" />
        </>
      )}
      {id === 'hexagon-nut' && (
        <>
          <polygon
            points="8,2 13.2,5 13.2,11 8,14 2.8,11 2.8,5"
            fill="currentColor"
            stroke="none"
          />
          <circle cx="8" cy="8" r="2.2" fill="#ffffff" stroke="none" />
        </>
      )}
      {id === 'minimize' && (
        <>
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />
          <path d="M5.5 7.5V5.5H7.5M10.5 8.5V10.5H8.5" stroke="#ffffff" strokeWidth="1.3" />
        </>
      )}
      {id === 'moon' && (
        <path
          d="M12.5 9.8A5.2 5.2 0 0 1 6.2 3.5A5.2 5.2 0 1 0 12.5 9.8Z"
          fill="currentColor"
          stroke="none"
        />
      )}
      {id === 'framer-bolt' && (
        <path
          d="M4 2.5H12V6.5H8L4 2.5ZM4 6.5H8L12 10.5H4V6.5ZM4 10.5H8V14L4 10.5Z"
          fill="currentColor"
          stroke="none"
        />
      )}
      {id === 'database' && (
        <>
          <ellipse cx="8" cy="4.2" rx="4.8" ry="1.8" fill="currentColor" stroke="none" />
          <path
            d="M3.2 6.8C3.2 7.8 5.3 8.6 8 8.6C10.7 8.6 12.8 7.8 12.8 6.8V9.2C12.8 10.2 10.7 11 8 11C5.3 11 3.2 10.2 3.2 9.2V6.8Z"
            fill="currentColor"
            stroke="none"
          />
          <path
            d="M3.2 10.8C3.2 11.8 5.3 12.6 8 12.6C10.7 12.6 12.8 11.8 12.8 10.8V12.6C12.8 13.6 10.7 14.4 8 14.4C5.3 14.4 3.2 13.6 3.2 12.6V10.8Z"
            fill="currentColor"
            stroke="none"
          />
        </>
      )}
      {id === 'play-triangle' && (
        <polygon points="4.5,3 12.8,8 4.5,13" fill="currentColor" stroke="none" />
      )}
      {id === 'terminal' && (
        <>
          <rect x="2" y="2.5" width="12" height="11" rx="2" fill="currentColor" stroke="none" />
          <path d="M4.8 6L7.2 8L4.8 10M8.2 10H11" stroke="#ffffff" strokeWidth="1.3" />
        </>
      )}
      {id === 'volume' && (
        <>
          <polygon points="3,6.2 6,6.2 9.2,3.5 9.2,12.5 6,9.8 3,9.8" fill="currentColor" stroke="none" />
          <path d="M11.2 5.8C12 6.5 12 9.5 11.2 10.2" stroke="currentColor" strokeWidth="1.4" />
        </>
      )}
      {catalogIconPath && <path d={catalogIconPath} />}
    </svg>
  );
}

