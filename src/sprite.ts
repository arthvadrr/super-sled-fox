export type SpriteSheet = {
  img: HTMLImageElement;
  frameW: number;
  frameH: number;
  cols: number;
  rows: number;
  frameCount: number;
};

export function createSpriteSheet(img: HTMLImageElement, frameW: number, frameH: number): SpriteSheet {
  const cols = Math.max(1, Math.floor(img.width / frameW));
  const rows = Math.max(1, Math.floor(img.height / frameH));
  return { img, frameW, frameH, cols, rows, frameCount: cols * rows };
}

type AnimDef = { name: string; frames: number[]; fps: number; loop?: boolean };

export class AnimatedSprite {
  sheet: SpriteSheet;
  anims: Record<string, AnimDef> = {};
  current: string | null = null;
  time = 0;
  frame = 0;
  private _finished = false;
  private prevAnim: string | null = null;
  private prevTime = 0;
  private prevFrame = 0;
  private fadeTimer = 0;
  private fadeDuration = 0;

  constructor(sheet: SpriteSheet) {
    this.sheet = sheet;
  }

  addAnim(name: string, frames: number[], fps = 12, loop = true) {
    this.anims[name] = { name, frames, fps, loop };
    if (!this.current) this.play(name);
  }

  play(name: string) {
    if (this.current === name) return;
    if (!this.anims[name]) return;
    this.current = name;
    this.time = 0;
    this.frame = 0;
    this._finished = false;
  }

  crossfadeTo(name: string, duration = 0.12) {
    if (this.current === name) return;
    if (!this.anims[name]) return;
    this.prevAnim = this.current;
    this.prevTime = this.time;
    this.prevFrame = this.frame;
    this.fadeDuration = Math.max(0, duration);
    this.fadeTimer = this.fadeDuration;
    this.current = name;
    this.time = 0;
    this.frame = 0;
    this._finished = false;
  }

  update(dt: number) {
    if (!this.current) return;
    const a = this.anims[this.current];
    if (!a) return;
    this.time += dt;
    const frameTime = 1 / Math.max(1, a.fps);
    while (this.time >= frameTime) {
      this.time -= frameTime;
      this.frame++;
      if (this.frame >= a.frames.length) {
        if (a.loop) this.frame = 0;
        else {
          this.frame = a.frames.length - 1;
          this._finished = true;
        }
      }
    }

    if (this.fadeTimer > 0 && this.prevAnim) {
      const pa = this.anims[this.prevAnim];
      if (pa) {
        this.prevTime += dt;
        const pFrameTime = 1 / Math.max(1, pa.fps);
        while (this.prevTime >= pFrameTime) {
          this.prevTime -= pFrameTime;
          this.prevFrame++;
          if (this.prevFrame >= pa.frames.length) {
            if (pa.loop) this.prevFrame = 0;
            else this.prevFrame = pa.frames.length - 1;
          }
        }
      }
      this.fadeTimer -= dt;
      if (this.fadeTimer <= 0) {
        this.prevAnim = null;
        this.prevTime = 0;
        this.prevFrame = 0;
        this.fadeTimer = 0;
        this.fadeDuration = 0;
      }
    }
  }

  getCurrentAnim(): string | null {
    return this.current;
  }

  isFinished(): boolean {
    return this._finished;
  }

  draw(ctx: CanvasRenderingContext2D, x: number, y: number, options?: { anchor?: 'center' | 'bottom'; scale?: number; flip?: boolean }) {
    if (!this.current) return;
    const drawSingle = (animName: string, frameIndex: number, alpha = 1) => {
      const a = this.anims[animName];
      if (!a) return;
      const idx = a.frames[frameIndex % a.frames.length];
      const sx = (idx % this.sheet.cols) * this.sheet.frameW;
      const sy = Math.floor(idx / this.sheet.cols) * this.sheet.frameH;
      const sw = this.sheet.frameW;
      const sh = this.sheet.frameH;
      const scale = options?.scale ?? 1;
      const w = sw * scale;
      const h = sh * scale;
      let dx = Math.round(x);
      let dy = Math.round(y);
      if (options?.anchor === 'center') {
        dx -= Math.round(w / 2);
        dy -= Math.round(h / 2);
      } else if (options?.anchor === 'bottom') {
        dx -= Math.round(w / 2);
        dy -= Math.round(h);
      }
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      if (options?.flip) {
        ctx.translate(dx + w / 2, 0);
        ctx.scale(-1, 1);
        ctx.translate(-(dx + w / 2), 0);
      }
      ctx.drawImage(this.sheet.img, sx, sy, sw, sh, dx, dy, w, h);
      ctx.restore();
    };

    if (this.prevAnim && this.fadeTimer > 0 && this.fadeDuration > 0) {
      const t = Math.max(0, Math.min(1, this.fadeTimer / this.fadeDuration));
      drawSingle(this.prevAnim, this.prevFrame, t);
      drawSingle(this.current!, this.frame, 1 - t);
    } else {
      drawSingle(this.current, this.frame, 1);
    }
  }

  getDrawDescriptors(x: number, y: number, options?: { anchor?: 'center' | 'bottom'; scale?: number; flip?: boolean }) {
    const out: Array<{
      img: HTMLImageElement;
      sx: number;
      sy: number;
      sw: number;
      sh: number;
      dx: number;
      dy: number;
      dw: number;
      dh: number;
      alpha: number;
      flip: boolean;
    }> = [];
    if (!this.current) return out;

    const makeDesc = (animName: string | null, frameIndex: number, alpha = 1) => {
      if (!animName) return null;
      const a = this.anims[animName];
      if (!a) return null;
      const idx = a.frames[frameIndex % a.frames.length];
      const sx = (idx % this.sheet.cols) * this.sheet.frameW;
      const sy = Math.floor(idx / this.sheet.cols) * this.sheet.frameH;
      const sw = this.sheet.frameW;
      const sh = this.sheet.frameH;
      const scale = options?.scale ?? 1;
      const w = sw * scale;
      const h = sh * scale;
      let dx = Math.round(x);
      let dy = Math.round(y);
      if (options?.anchor === 'center') {
        dx -= Math.round(w / 2);
        dy -= Math.round(h / 2);
      } else if (options?.anchor === 'bottom') {
        dx -= Math.round(w / 2);
        dy -= Math.round(h);
      }
      return { img: this.sheet.img, sx, sy, sw, sh, dx, dy, dw: w, dh: h, alpha: Math.max(0, Math.min(1, alpha)), flip: !!options?.flip };
    };

    if (this.prevAnim && this.fadeTimer > 0 && this.fadeDuration > 0) {
      const t = Math.max(0, Math.min(1, this.fadeTimer / this.fadeDuration));
      const p = makeDesc(this.prevAnim, this.prevFrame, t);
      const c = makeDesc(this.current, this.frame, 1 - t);
      if (p) out.push(p);
      if (c) out.push(c);
    } else {
      const c = makeDesc(this.current, this.frame, 1);
      if (c) out.push(c);
    }
    return out;
  }
}

export class AnimationStateMachine {
  layers: Array<{ sprite: AnimatedSprite; mapping: Record<string, string>; ox: number; oy: number }> = [];
  current: string | null = null;

  addLayer(sprite: AnimatedSprite, mapping: Record<string, string> = {}, ox = 0, oy = 0) {
    this.layers.push({ sprite, mapping, ox, oy });
    if (!this.current) this.current = 'idle';
  }

  play(state: string) {
    if (this.current === state) return;
    this.current = state;
    for (const L of this.layers) {
      const anim = L.mapping[state] ?? state;
      if (anim && (L.sprite as any).anims && (L.sprite as any).anims[anim]) {
        const s: any = L.sprite as any;
        if (typeof s.crossfadeTo === 'function') s.crossfadeTo(anim, 0.12);
        else s.play(anim);
      } else {
        const keys = Object.keys((L.sprite as any).anims || {});
        if (keys.length > 0) L.sprite.play(keys[0]);
      }
    }
  }

  // Backwards-compatible alias: some codebases call `setState` on entities
  // to change animation state. Provide a thin wrapper to `play` for that API.
  setState(state: string) {
    this.play(state);
  }

  update(dt: number) {
    for (const L of this.layers) {
      L.sprite.update(dt);
      const cur = L.sprite.getCurrentAnim();
      if (cur && L.sprite.isFinished()) {
        const fallback = L.mapping['fallback'] || 'idle';
        if (fallback && (L.sprite as any).anims && (L.sprite as any).anims[fallback]) {
          L.sprite.play(fallback);
        }
      }
    }
  }

  collectDrawDescriptors(x: number, y: number, options?: { anchor?: 'center' | 'bottom'; scale?: number; flip?: boolean }) {
    const out: Array<{
      img: HTMLImageElement;
      sx: number;
      sy: number;
      sw: number;
      sh: number;
      dx: number;
      dy: number;
      dw: number;
      dh: number;
      alpha: number;
      flip: boolean;
    }> = [];
    for (const L of this.layers) {
      const descs = L.sprite.getDrawDescriptors(x + L.ox, y + L.oy, options);
      for (const d of descs) out.push(d);
    }
    return out;
  }

  draw(ctx: CanvasRenderingContext2D, x: number, y: number, options?: { anchor?: 'center' | 'bottom'; scale?: number; flip?: boolean }) {
    for (const L of this.layers) {
      const ox = L.ox || 0;
      const oy = L.oy || 0;
      L.sprite.draw(ctx, x + ox, y + oy, options);
    }
  }
}

export default { createSpriteSheet, AnimatedSprite };
