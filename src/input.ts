export type KeyName = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'w' | 'a' | 's' | 'd' | ' ' | 'Escape' | 'r' | 'e' | 'F1';

type KeyState = {
  isDown: boolean;
  wasPressed: boolean;
  wasReleased: boolean;
};

const DEFAULT_KEYS: KeyName[] = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'w', 'a', 's', 'd', ' ', 'Escape', 'r', 'e', 'F1'];

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
    const k = (e.key as KeyName) || e.code;
    // prevent default for arrows and space
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown' || k === ' ') {
      e.preventDefault();
    }
    const state = this.keys.get(k as KeyName);
    if (!state) return;
    if (!state.isDown) {
      state.isDown = true;
      state.wasPressed = true;
    }
  }

  private onKeyUp(e: KeyboardEvent) {
    const k = (e.key as KeyName) || e.code;
    const state = this.keys.get(k as KeyName);
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
