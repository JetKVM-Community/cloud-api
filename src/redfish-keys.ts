// HID Usage Tables (USB HID Keyboard Scan Codes)
// Reference: USB HID Usage Tables v1.12, Section 10 (Keyboard/Keypad Page 0x07)

export const HID_KEY = {
  // Function keys
  F1: 0x3a,
  F2: 0x3b,
  F3: 0x3c,
  F4: 0x3d,
  F5: 0x3e,
  F6: 0x3f,
  F7: 0x40,
  F8: 0x41,
  F9: 0x42,
  F10: 0x43,
  F11: 0x44,
  F12: 0x45,

  // Special keys
  RETURN: 0x28,
  ESCAPE: 0x29,
  BACKSPACE: 0x2a,
  TAB: 0x2b,
  SPACE: 0x2c,
  DELETE: 0x4c,
  INSERT: 0x49,

  // Arrow keys
  RIGHT: 0x4f,
  LEFT: 0x50,
  DOWN: 0x51,
  UP: 0x52,

  // Power key (USB HID 0x66 - Keyboard Power)
  POWER: 0x66,
} as const;

export const HID_MODIFIER = {
  NONE: 0x00,
  LEFT_CTRL: 0x01,
  LEFT_SHIFT: 0x02,
  LEFT_ALT: 0x04,
  LEFT_GUI: 0x08,
  RIGHT_CTRL: 0x10,
  RIGHT_SHIFT: 0x20,
  RIGHT_ALT: 0x40,
  RIGHT_GUI: 0x80,
} as const;

export interface KeyCombo {
  modifier: number;
  keys: number[];
}

// Mapping from Redfish ResetType to keyboard sequences
// These represent what key presses would be sent to achieve each reset type
export function getResetKeySequence(resetType: string): KeyCombo[] | null {
  switch (resetType) {
    case "ForceRestart":
      // Ctrl+Alt+Delete
      return [
        {
          modifier: HID_MODIFIER.LEFT_CTRL | HID_MODIFIER.LEFT_ALT,
          keys: [HID_KEY.DELETE],
        },
      ];
    case "GracefulRestart":
      // Ctrl+Alt+Delete (same combo, OS handles gracefully)
      return [
        {
          modifier: HID_MODIFIER.LEFT_CTRL | HID_MODIFIER.LEFT_ALT,
          keys: [HID_KEY.DELETE],
        },
      ];
    case "GracefulShutdown":
      // Alt+F4 (close/shutdown dialog)
      return [
        {
          modifier: HID_MODIFIER.LEFT_ALT,
          keys: [HID_KEY.F4],
        },
      ];
    case "ForceOff":
      // Power key press (long press simulated)
      return [
        {
          modifier: HID_MODIFIER.NONE,
          keys: [HID_KEY.POWER],
        },
      ];
    case "On":
      // Power key press (short press)
      return [
        {
          modifier: HID_MODIFIER.NONE,
          keys: [HID_KEY.POWER],
        },
      ];
    default:
      return null;
  }
}
