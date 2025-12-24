import { VIRTUAL_WIDTH, VIRTUAL_HEIGHT } from './constants';

export function createSnowPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  try {
    const pcan = document.createElement('canvas');
    pcan.width = 64;
    pcan.height = 64;
    const pc = pcan.getContext('2d')!;
    pc.clearRect(0, 0, pcan.width, pcan.height);
    for (let i = 0; i < 90; i++) {
      const alpha = 0.08 + Math.random() * 0.26;
      pc.fillStyle = `rgba(255,255,255,${alpha})`;
      const r = Math.random() * 2.6 + 0.4;
      pc.beginPath();
      pc.arc(Math.random() * pcan.width, Math.random() * pcan.height, r, 0, Math.PI * 2);
      pc.fill();
    }
    // add more and larger clumps for a chunkier, rougher snow look
    for (let i = 0; i < 20; i++) {
      const alpha = 0.12 + Math.random() * 0.3;
      pc.fillStyle = `rgba(${220 + Math.floor(Math.random() * 35)},${220 + Math.floor(Math.random() * 35)},255,${alpha})`;
      const rx = Math.random() * pcan.width;
      const ry = Math.random() * pcan.height;
      const rw = 3 + Math.random() * 6;
      pc.beginPath();
      pc.ellipse(rx, ry, rw * (0.6 + Math.random() * 1.6), rw * (0.5 + Math.random() * 1.4), Math.random() * Math.PI, 0, Math.PI * 2);
      pc.fill();
    }
    return ctx.createPattern(pcan, 'repeat');
  } catch (e) {
    return null;
  }
}

export function createNoisePattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  try {
    const ncan = document.createElement('canvas');
    ncan.width = 32;
    ncan.height = 32;
    const nc = ncan.getContext('2d')!;
    nc.clearRect(0, 0, ncan.width, ncan.height);
    for (let y = 0; y < ncan.height; y++) {
      for (let x = 0; x < ncan.width; x++) {
        const v = 120 + Math.floor(Math.random() * 120); // darker, higher-contrast noise
        const a = 0.03 + Math.random() * 0.08;
        nc.fillStyle = `rgba(${v},${v},${v},${a})`;
        nc.fillRect(x, y, 1, 1);
      }
    }
    // slightly blur/soften the noise by drawing a few translucent circles
    for (let i = 0; i < 12; i++) {
      nc.fillStyle = `rgba(180,200,220,${0.02 + Math.random() * 0.04})`;
      const rx = Math.random() * ncan.width;
      const ry = Math.random() * ncan.height;
      const rr = 1 + Math.random() * 2;
      nc.beginPath();
      nc.arc(rx, ry, rr, 0, Math.PI * 2);
      nc.fill();
    }
    return ctx.createPattern(ncan, 'repeat');
  } catch (e) {
    return null;
  }
}