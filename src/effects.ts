type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ttl: number;
  age: number;
  size: number;
  color: string;
};

export class ParticleSystem {
  particles: Particle[] = [];
  enabled = true;

  emit(x: number, y: number, count = 6, opts: { spread?: number; speed?: number; size?: number; color?: string } = {}) {
    if (!this.enabled) return;
    const spread = opts.spread ?? 12;
    const speed = opts.speed ?? 60;
    const size = opts.size ?? 2.5;
    const color = opts.color ?? '#ddd';
    for (let i = 0; i < count; i++) {
      const ang = (Math.random() - 0.5) * Math.PI + Math.PI * 0.5;
      const s = speed * (0.4 + Math.random() * 0.8);
      this.particles.push({
        x,
        y,
        vx: Math.cos(ang) * s + (Math.random() - 0.5) * spread,
        vy: Math.sin(ang) * s * 0.6 + (Math.random() - 0.5) * spread * 0.3,
        ttl: 0.6 + Math.random() * 0.6,
        age: 0,
        size: size * (0.6 + Math.random() * 0.9),
        color,
      });
    }
  }

  emitDirectional(x: number, y: number, count = 6, opts: { angle?: number; spread?: number; speed?: number; size?: number; color?: string } = {}) {
    if (!this.enabled) return;
    const angleBase = opts.angle ?? (Math.PI * 0.5); // default up
    const spread = opts.spread ?? 0.9; // radians
    const speed = opts.speed ?? 60;
    const size = opts.size ?? 2.5;
    const color = opts.color ?? '#ddd';
    for (let i = 0; i < count; i++) {
      const ang = angleBase + (Math.random() - 0.5) * spread;
      const s = speed * (0.4 + Math.random() * 0.8);
      this.particles.push({
        x,
        y,
        vx: Math.cos(ang) * s + (Math.random() - 0.5) * 6,
        vy: Math.sin(ang) * s + (Math.random() - 0.5) * 4,
        ttl: 0.4 + Math.random() * 0.6,
        age: 0,
        size: size * (0.6 + Math.random() * 0.9),
        color,
      });
    }
  }

  emitSpeedLines(x: number, y: number, count = 3, opts: { vx?: number; color?: string } = {}) {
    if (!this.enabled) return;
    const baseV = Math.abs(opts.vx ?? 0);
    for (let i = 0; i < count; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      this.particles.push({
        x: x + (Math.random() - 0.5) * 12,
        y: y + (Math.random() - 0.5) * 6,
        vx: side * (80 + Math.random() * 120) + baseV * 0.2,
        vy: (Math.random() - 0.5) * 10,
        ttl: 0.25 + Math.random() * 0.25,
        age: 0,
        size: 1 + Math.random() * 2.5,
        color: opts.color ?? '#fff',
      });
    }
  }

  update(dt: number) {
    if (!this.enabled) return;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      if (p.age >= p.ttl) {
        this.particles.splice(i, 1);
        continue;
      }
      // simple physics
      p.vy += 200 * dt; // gravity-ish
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }

  draw(ctx: CanvasRenderingContext2D, camOffsetX = 0, camOffsetY = 0) {
    if (!this.enabled) return;
    for (const p of this.particles) {
      const a = 1 - p.age / p.ttl;
      ctx.fillStyle = p.color;
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.fillRect(Math.round(p.x - camOffsetX), Math.round(p.y - camOffsetY), Math.max(1, p.size), Math.max(1, p.size));
      ctx.closePath();
      ctx.globalAlpha = 1;
    }
  }
}

export class ScreenShake {
  x = 0;
  y = 0;
  private strength = 0;
  private time = 0;

  shake(strength: number, duration = 0.25) {
    this.strength = Math.max(this.strength, strength);
    this.time = Math.max(this.time, duration);
  }

  update(dt: number) {
    if (this.time > 0) {
      this.time -= dt;
      const t = Math.max(0, this.time);
      const s = this.strength * (t / Math.max(0.0001, this.time + dt));
      // random oscillation
      this.x = (Math.random() - 0.5) * s;
      this.y = (Math.random() - 0.5) * s * 0.5;
    } else {
      this.x = 0;
      this.y = 0;
      this.strength = 0;
    }
  }
}

export class EffectsManager {
  particles: ParticleSystem;
  shake: ScreenShake;
  enabled = true;

  constructor(opts: { enabled?: boolean } = {}) {
    this.enabled = opts.enabled ?? true;
    this.particles = new ParticleSystem();
    this.particles.enabled = this.enabled;
    this.shake = new ScreenShake();
  }

  update(dt: number) {
    if (!this.enabled) return;
    this.particles.update(dt);
    this.shake.update(dt);
  }

  draw(ctx: CanvasRenderingContext2D, camOffsetX = 0, camOffsetY = 0) {
    if (!this.enabled) return;
    this.particles.draw(ctx, camOffsetX, camOffsetY);
  }

  onLand(x: number, y: number, impactVel = 0) {
    if (!this.enabled) return;
    // emit dust and small shake proportional to impact
    const strength = Math.min(10, Math.abs(impactVel) * 0.05 + 2);
    this.shake.shake(strength, 0.18 + Math.min(0.4, Math.abs(impactVel) * 0.002));
    this.particles.emit(x, y + 2, 10, { spread: 18, speed: Math.min(140, Math.abs(impactVel) * 0.6), size: 2, color: '#d9cbb3' });
  }

  onSpeed(x: number, y: number, vx: number) {
    if (!this.enabled) return;
    if (Math.abs(vx) < 120) return;
    const n = Math.min(4, Math.floor(Math.abs(vx) / 80));
    this.particles.emitSpeedLines(x + (vx > 0 ? -8 : 8), y - 6, n, { vx, color: 'rgba(255,255,255,0.9)' });
  }

  onBoost(x: number, y: number, vx: number) {
    if (!this.enabled) return;
    // flame: small fast particles pointing backwards relative to vx
    const dir = vx >= 0 ? -1 : 1;
    const angleBase = dir < 0 ? Math.PI : 0; // left or right
    // Emit a few flame sparks
    this.particles.emitDirectional(x + dir * 10, y - 4, 6, { angle: angleBase, spread: 0.8, speed: 140, size: 1.6, color: '#ffb86b' });
    // Emit smoke: slower, larger, drifting upward/back
    this.particles.emitDirectional(x + dir * 6, y - 2, 4, { angle: angleBase + -0.6, spread: 1.0, speed: 36, size: 3.2, color: 'rgba(120,120,120,0.85)' });
    // small speed lines for extra visual feedback
    this.particles.emitSpeedLines(x + (vx > 0 ? -8 : 8), y - 6, 2, { vx, color: 'rgba(255,200,120,0.95)' });
  }
}

export default EffectsManager;
