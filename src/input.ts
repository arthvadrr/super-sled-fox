export type KeyName = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'w' | 'a' | 's' | 'd' | 'k' | ' ' | 'Escape' | 'r' | 'e' | 'F1';

type KeyState = {
  isDown: boolean;
  wasPressed: boolean;
  wasReleased: boolean;
};

const DEFAULT_KEYS: KeyName[] = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'w', 'a', 's', 'd', 'k', ' ', 'Escape', 'r', 'e', 'F1'];

export class InputManager {
  private keys = new Map<KeyName, KeyState>();
  private downHandler = this.onKeyDown.bind(this);
  private upHandler = this.onKeyUp.bind(this);

  constructor() {
    for (const k of DEFAULT_KEYS) {
      this.keys.set(k, { isDown: false, wasPressed: false, wasReleased: false });
    }
  }

  start() {
    window.addEventListener('keydown', this.downHandler, { passive: false });
    window.addEventListener('keyup', this.upHandler, { passive: false });
  }

  stop() {
    window.removeEventListener('keydown', this.downHandler);
    window.removeEventListener('keyup', this.upHandler);
  }

  private onKeyDown(e: KeyboardEvent) {
    // normalize key values: handle Space/Spacebar, uppercase letters, and fall back to e.code
    let kRaw = e.key;
    if (!kRaw || kRaw === 'Unidentified') kRaw = e.code;
    let norm: string = kRaw;
    // map common variants of the space key to a single space char
    if (kRaw === ' ' || kRaw === 'Space' || kRaw === 'Spacebar' || e.code === 'Space') norm = ' ';
    // normalize single-letter keys to lowercase so 'W' and 'w' match our map
    if (norm.length === 1) norm = norm.toLowerCase();
    const state = this.keys.get(norm as KeyName);
    if (!state) return;
    if (!state.isDown) {
      state.isDown = true;
      state.wasPressed = true;
      // log space presses for debugging jump input reliability
      if (norm === ' ') {
        // include raw key/code and timestamp to aid diagnosis
        // eslint-disable-next-line no-console
        console.log('[input] space pressed', { key: kRaw, code: e.code, t: performance.now() });
      }
    }
  }

  private onKeyUp(e: KeyboardEvent) {
    let kRaw = e.key;
    if (!kRaw || kRaw === 'Unidentified') kRaw = e.code;
    let norm: string = kRaw;
    if (kRaw === ' ' || kRaw === 'Space' || kRaw === 'Spacebar' || e.code === 'Space') norm = ' ';
    if (norm.length === 1) norm = norm.toLowerCase();
    const state = this.keys.get(norm as KeyName);
    if (!state) return;
    if (state.isDown) {
      state.isDown = false;
      state.wasReleased = true;
    }
  }

  // Retrieve state snapshot (read-only) for a named key
  get(key: KeyName): KeyState {
    const s = this.keys.get(key)!;
    return { ...s };
  }

  // Clear transient flags (call after you processed a frame)
  clearTransient() {
    for (const s of this.keys.values()) {
      s.wasPressed = false;
      s.wasReleased = false;
    }
  }
}

export default InputManager;
