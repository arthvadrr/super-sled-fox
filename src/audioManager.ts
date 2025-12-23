import assetManager from './assetManager';

// AudioManager: creates an AudioContext only after explicit user interaction.
// Before unlock, play() is a no-op. After unlock, existing loaded HTMLAudioElements
// can be played, and queued play requests are executed.

type Playable = {
  play: () => Promise<void>;
  pause: () => void;
  loop: boolean;
  volume: number;
};

class AudioManager {
  private ctx: AudioContext | null = null;
  private unlocked = false;
  private pendingPlays: Array<() => void> = [];

  isUnlocked() {
    return this.unlocked;
  }

  async unlock(): Promise<void> {
    if (this.unlocked) return;
    try {
      const C = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (C) {
        this.ctx = new C();
        // resume in case it's suspended
        if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
      }
    } catch (e) {
      // ignore
    }
    this.unlocked = true;
    // flush queued plays
    for (const fn of this.pendingPlays) fn();
    this.pendingPlays = [];
  }

  // Create a playable wrapper around either an HTMLAudioElement or a silent fallback
  async createSound(name: string): Promise<Playable> {
    const a = await assetManager.loadAudio(name);
    // If assetManager gave us a silent SafeAudio (object with play), return wrapper
    if (typeof (a as any).play === 'function' && !(a instanceof HTMLAudioElement)) {
      return a as Playable;
    }

    const element = a as HTMLAudioElement;

    const wrapper: Playable = {
      loop: false,
      play: async () => {
        const doPlay = async () => {
          try {
            element.loop = wrapper.loop;
            element.volume = wrapper.volume;
            await element.play();
          } catch (e) {
            // ignore
          }
        };
        if (!this.unlocked) {
          // queue the play to happen once unlocked
          this.pendingPlays.push(() => {
            void doPlay();
          });
        } else {
          await doPlay();
        }
      },
      pause: () => {
        try {
          element.pause();
        } catch (e) {}
      },
      get volume() {
        return element.volume;
      },
      set volume(v: number) {
        element.volume = v;
      },
    };

    return wrapper;
  }
}

const audioManager = new AudioManager();
export default audioManager;
