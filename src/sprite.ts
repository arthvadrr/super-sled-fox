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
  return {
    img,
    frameW,
    frameH,
    cols,
    rows,
    frameCount: cols * rows,
  };
}

type AnimDef = {
  name: string;
  frames: number[]; // indices into spritesheet
  fps: number;
  loop?: boolean;
};

export class AnimatedSprite {
  sheet: SpriteSheet;
  anims: Record<string, AnimDef> = {};
  current: string | null = null;
  time = 0;
  frame = 0;

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
        else this.frame = a.frames.length - 1;
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D, x: number, y: number, options?: { anchor?: 'center' | 'bottom'; scale?: number; flip?: boolean }) {
    if (!this.current) return;
    const a = this.anims[this.current];
    if (!a) return;
    const idx = a.frames[this.frame % a.frames.length];
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
    if (options?.flip) {
      ctx.translate(dx + w / 2, 0);
      ctx.scale(-1, 1);
      ctx.translate(-(dx + w / 2), 0);
    }
    ctx.drawImage(this.sheet.img, sx, sy, sw, sh, dx, dy, w, h);
    ctx.restore();
  }
}

export default { createSpriteSheet, AnimatedSprite };
