// Simple AssetManager with safe fallbacks for missing images/audio.
// Loads assets relative to a base path; missing files resolve to placeholders/no-op audio.

export type SafeAudio = {
  play: () => Promise<void>;
  pause: () => void;
  loop: boolean;
  volume: number;
};

export class AssetManager {
  private basePath: string;
  private images = new Map<string, HTMLImageElement>();
  private audios = new Map<string, SafeAudio | HTMLAudioElement>();

  constructor(basePath = '/') {
    this.basePath = basePath.replace(/\/+$/, '') + '/';
  }

  private makePlaceholderImage(w = 64, h = 64, label = 'missing') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#333';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#999';
    ctx.fillRect(0, 0, w / 2, h / 2);
    ctx.fillRect(w / 2, h / 2, w / 2, h / 2);
    ctx.fillStyle = '#fff';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(label, w / 2, h / 2 + 3);
    const img = new Image();
    img.src = c.toDataURL();
    return img;
  }

  private makeSilentAudio(): SafeAudio {
    return {
      play: async () => Promise.resolve(),
      pause: () => {},
      loop: false,
      volume: 1,
    };
  }

  loadImage(name: string): Promise<HTMLImageElement> {
    if (this.images.has(name)) return Promise.resolve(this.images.get(name)!);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const src = name.startsWith('http') ? name : this.basePath + name;
    return new Promise((res) => {
      img.onload = () => {
        this.images.set(name, img);
        res(img);
      };
      img.onerror = () => {
        const placeholder = this.makePlaceholderImage(64, 64, name.split('/').pop() || 'missing');
        this.images.set(name, placeholder);
        res(placeholder);
      };
      img.src = src;
    });
  }

  getImage(name: string): HTMLImageElement | undefined {
    return this.images.get(name);
  }

  async loadAudio(name: string): Promise<SafeAudio | HTMLAudioElement> {
    if (this.audios.has(name)) return this.audios.get(name)!;
    // prefer HTMLAudioElement; on any error, fall back to silent audio
    try {
      const audio = new Audio();
      audio.src = name.startsWith('http') ? name : this.basePath + name;
      audio.preload = 'auto';
      // wrap load events
      await new Promise<void>((resolve) => {
        const onok = () => {
          cleanup();
          resolve();
        };
        const onerr = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          audio.removeEventListener('canplaythrough', onok);
          audio.removeEventListener('error', onerr);
        };
        audio.addEventListener('canplaythrough', onok);
        audio.addEventListener('error', onerr);
      });
      // store and return audio element (it may still be broken, but is usable)
      this.audios.set(name, audio);
      return audio;
    } catch (e) {
      const s = this.makeSilentAudio();
      this.audios.set(name, s);
      return s;
    }
  }

  getAudio(name: string): (SafeAudio | HTMLAudioElement) | undefined {
    return this.audios.get(name);
  }

  // Conveniences: try multiple candidate names and return the first that loads (or placeholder)
  async loadImageAny(candidates: string[]): Promise<HTMLImageElement> {
    for (const c of candidates) {
      try {
        const img = await this.loadImage(c);
        if (img) return img;
      } catch (_) {
        // continue
      }
    }
    const placeholder = this.makePlaceholderImage(64, 64, 'missing');
    return placeholder;
  }

  async loadAudioAny(candidates: string[]): Promise<SafeAudio | HTMLAudioElement> {
    for (const c of candidates) {
      try {
        const a = await this.loadAudio(c);
        if (a) return a;
      } catch (_) {
        // continue
      }
    }
    return this.makeSilentAudio();
  }
}

const defaultManager = new AssetManager('/assets/');
export default defaultManager;
