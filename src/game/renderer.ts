import { VIRTUAL_WIDTH, VIRTUAL_HEIGHT, RENDER_SETTINGS, FIXED_DT } from './constants';
import { GameContext } from './types';
import { getHeightAtX } from '../heightmap';
import assetManager from '../assetManager';

const { PIXEL_SNAP, PADDING } = RENDER_SETTINGS;

export function draw(ctx: GameContext, vctx: CanvasRenderingContext2D, canvasEl: HTMLCanvasElement, mainCtx: CanvasRenderingContext2D) {
  const {
    state,
    currPlayer,
    prevPlayer,
    currCam,
    prevCam,
    currentLevel,
    accumulator,
    editorZoom,
    editorCamX,
    editorCamY,
    effects,
    parallax,
    snowPattern,
    noisePattern,
    playerEntity,
    landingFlash,
    reachedFinish,
    crashFade,
    crashTimer,
    restartHintTimer,
    fps,
  } = ctx;

  // interpolation alpha based on accumulator
  const alpha = Math.max(0, Math.min(1, accumulator / FIXED_DT));
  const isEditor = state === 'editor';
  const zoom = isEditor ? editorZoom : 1;

  // interpolate player and camera
  const ix = prevPlayer.x * (1 - alpha) + currPlayer.x * alpha;
  const iy = prevPlayer.y * (1 - alpha) + currPlayer.y * alpha;
  const camx = prevCam.x * (1 - alpha) + currCam.x * alpha;
  const camy = (prevCam.y || 0) * (1 - alpha) + (currCam.y || 0) * alpha;

  // Editor camera uses the same coordinate convention as screenToWorldFn:
  // camX/camY represent the CENTER of the view in world units.
  const camXUsed = isEditor ? editorCamX : camx;
  const camYUsed = isEditor ? editorCamY : camy;
  const viewWorldW = VIRTUAL_WIDTH / Math.max(0.0001, zoom);
  const viewWorldH = VIRTUAL_HEIGHT / Math.max(0.0001, zoom);
  const leftWorld = camXUsed - viewWorldW / 2;
  const topWorld = camYUsed - viewWorldH / 2;
  const wxToS = (wx: number) => (wx - leftWorld) * zoom;
  const wyToS = (wy: number) => (wy - topWorld) * zoom;

  // draw scene into virtual canvas (virtual pixels)
  vctx.fillStyle = '#0b1220';
  vctx.fillRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);

  // apply screen-shake offset to camera when rendering
  const shakeX = !isEditor && effects && effects.shake && effects.shake.x ? effects.shake.x : 0;
  const shakeY = !isEditor && effects && effects.shake && effects.shake.y ? effects.shake.y : 0;
  const camxShaken = camx + shakeX;

  // draw parallax background layers (back-to-front)
  if (parallax.length > 0) {
    for (let li = 0; li < parallax.length; li++) {
      const layer = parallax[li];
      if (!layer || !layer.img) continue;
      const img = layer.img;
      const factor = layer.factor || 0.5;
      const yOff = (layer.yOff || 0) + shakeY;
      // tile image horizontally to fill view
      const imgW = img.width || VIRTUAL_WIDTH;
      const parallaxCamX = isEditor ? editorCamX : camxShaken;
      const scroll = (parallaxCamX * factor) % imgW;
      // draw enough tiles to cover screen
      for (let x = -imgW; x < VIRTUAL_WIDTH + imgW; x += imgW) {
        vctx.drawImage(img, Math.round(x - scroll), Math.round(yOff));
      }
    }
  }

  // compute camera offset used by gameplay-only helpers (effects). World rendering in editor mode uses wxToS/wyToS.
  let camOffsetX = camxShaken - VIRTUAL_WIDTH / 2;
  if (!isEditor && PIXEL_SNAP) camOffsetX = Math.round(camOffsetX);
  let camOffsetY = camy - VIRTUAL_HEIGHT / 2;
  if (!isEditor && PIXEL_SNAP) camOffsetY = Math.round(camOffsetY);

  // compute visible segment range for culling (zoom-aware)
  const rightWorld = camXUsed + viewWorldW / 2;
  const leftIdx = Math.max(0, Math.floor(leftWorld) - PADDING);
  const rightIdx = Math.min((currentLevel.segments && currentLevel.segments.length - 1) || 0, Math.ceil(rightWorld) + PADDING);

  // Avalanche wall (render behind terrain): draw a mostly-opaque white band
  // from the left edge to the avalanche leading edge so it appears behind
  // the ground polygon drawn later. This keeps the avalanche visually
  // present but the terrain sits on top of it.
  try {
    if (typeof (ctx as any).avalancheX === 'number') {
      const avalX = (ctx as any).avalancheX as number;
      const leftWorldVis = leftWorld;
      const rightClamp = Math.min(avalX, camXUsed + viewWorldW / 2 + 10);
      if (rightClamp > leftWorldVis) {
        const SPILL_LEFT = 40;
        const SPILL_RIGHT = 16;
        let sxL = isEditor ? wxToS(leftWorldVis) : leftWorldVis - camOffsetX;
        let sxR = isEditor ? wxToS(rightClamp) : rightClamp - camOffsetX;
        sxL = Math.floor(sxL - SPILL_LEFT);
        sxR = Math.ceil(sxR + SPILL_RIGHT);
        const widthPx = Math.max(2, Math.round(sxR - sxL));

        vctx.save();
        try {
          const bandTop = 0;
          const bandH = Math.round(VIRTUAL_HEIGHT);
          vctx.beginPath();
          vctx.rect(sxL, bandTop, widthPx, bandH);
          vctx.clip();

          const BASE_OPACITY = 0.94;
          vctx.fillStyle = `rgba(255,255,255,${BASE_OPACITY})`;
          vctx.fillRect(sxL, bandTop, widthPx, bandH);

          const FRONT_SOFT_PX = 64;
          const gradX0 = Math.max(sxL, sxR - FRONT_SOFT_PX - 2);
          const gradX1 = sxR + 8;
          const g = vctx.createLinearGradient(gradX0, 0, gradX1, 0);
          g.addColorStop(0, `rgba(255,255,255,${BASE_OPACITY})`);
          g.addColorStop(1, `rgba(255,255,255,0.0)`);
          vctx.fillStyle = g;
          vctx.fillRect(gradX0, bandTop, Math.max(1, gradX1 - gradX0), bandH);

          if (snowPattern) {
            vctx.globalAlpha = 0.06;
            try {
              (snowPattern as any).setTransform?.(new DOMMatrix().translate(-camOffsetX, 0));
            } catch (e) {}
            vctx.fillStyle = snowPattern as any;
            vctx.fillRect(sxL, bandTop, widthPx, bandH);
            vctx.globalAlpha = 1;
          }
        } catch (e) {}
        vctx.restore();
      }
    }
  } catch (e) {}

  // Draw decor objects that should appear behind the ground before drawing terrain.
  try {
    const objs = currentLevel.objects || [];
    for (const obj of objs) {
      if (!obj || obj.type !== 'decor') continue;
      const layer = (obj as any).layer;
      if (typeof layer === 'number' && layer !== 0) continue; // only layer 0 here
      try {
        const oyWorld = typeof obj.y === 'number' ? obj.y : (getHeightAtX(currentLevel as any, Math.round(obj.x)) ?? VIRTUAL_HEIGHT / 2);
        const sx = isEditor ? wxToS(obj.x) : obj.x - camOffsetX;
        const sy = isEditor ? wyToS(oyWorld) : oyWorld - camOffsetY + shakeY;
        const scale = (obj as any).scale || 1;
        const src = (obj as any).src || '';
        const img = src ? assetManager.getImage(src) : undefined;
        if (img) {
          const w = (img.width || 64) * scale * zoom;
          const h = (img.height || 64) * scale * zoom;
          const dx = sx - w / 2;
          const dy = sy - h;
          vctx.drawImage(img, dx, dy, w, h);
        } else if (src) {
          assetManager.loadImage(src).catch(() => {});
        }
      } catch (e) {}
    }
  } catch (e) {}

  // draw terrain (filled polygon) only in visible range
  let groundFill: CanvasPattern | CanvasGradient | string = '#e6f7ff';
  try {
    const groundGrad = vctx.createLinearGradient(0, 0, 0, VIRTUAL_HEIGHT);
    // moonlit snow (bright cool at top) -> darker bluish shadow at base
    groundGrad.addColorStop(0, '#fbfdff'); // bright moonlit snow
    groundGrad.addColorStop(0.55, '#bcd7f0'); // cool mid tone
    groundGrad.addColorStop(1, '#081826'); // deep night-blue base
    groundFill = groundGrad;
    vctx.fillStyle = groundFill;
  } catch (e) {
    groundFill = '#e6f7ff';
    vctx.fillStyle = groundFill as string;
  }

  const DEBUG_GAP_MARKERS = false;
  let inChunk = false;
  let chunkFirstX = 0;
  let chunkLastX = 0;
  for (let xi = leftIdx; xi <= rightIdx; xi++) {
    const sx = isEditor ? wxToS(xi) : xi - camOffsetX;
    const hy = getHeightAtX(currentLevel as any, xi);
    if (hy === null) {
      if (DEBUG_GAP_MARKERS) {
        vctx.fillStyle = 'red';
        vctx.fillRect(Math.round(sx) - 1, 2, 2, 6);
        vctx.fillStyle = groundFill as any;
      }
      if (inChunk) {
        const xEnd = isEditor ? wxToS(chunkLastX) : chunkLastX - camOffsetX;
        const xStart = isEditor ? wxToS(chunkFirstX) : chunkFirstX - camOffsetX;
        vctx.lineTo(xEnd, VIRTUAL_HEIGHT);
        vctx.lineTo(xStart, VIRTUAL_HEIGHT);
        vctx.closePath();
        vctx.fill();
        if (snowPattern) {
          vctx.save();
          try {
            (snowPattern as any).setTransform?.(new DOMMatrix().translate(-camOffsetX, 0));
          } catch (e) {}
          vctx.globalAlpha = 0.12;
          vctx.fillStyle = snowPattern as any;
          vctx.fill();
          vctx.restore();
        }
        inChunk = false;
      }
      continue;
    }
    const sy = isEditor ? wyToS(hy) : hy - camOffsetY + shakeY;
    if (!inChunk) {
      vctx.beginPath();
      vctx.moveTo(sx, sy);
      chunkFirstX = xi;
      inChunk = true;
    } else {
      vctx.lineTo(sx, sy);
    }
    chunkLastX = xi;
  }
  if (inChunk) {
    const xEnd = isEditor ? wxToS(chunkLastX) : chunkLastX - camOffsetX;
    const xStart = isEditor ? wxToS(chunkFirstX) : chunkFirstX - camOffsetX;
    vctx.lineTo(xEnd, VIRTUAL_HEIGHT);
    vctx.lineTo(xStart, VIRTUAL_HEIGHT);
    vctx.closePath();
    vctx.fill();
    if (snowPattern) {
      vctx.save();
      try {
        (snowPattern as any).setTransform?.(new DOMMatrix().translate(-camOffsetX, 0));
      } catch (e) {}
      vctx.globalAlpha = 0.12;
      vctx.fillStyle = snowPattern as any;
      vctx.fill();
      vctx.restore();
    }
  }

  // Draw a subtle highlight along the top edge of the terrain (ice-like line).
  // Only draw across contiguous non-null segments (don't bridge gaps). Use
  // a two-pass stroke (thin bright line + wider translucent glow) with a
  // small deterministic per-segment offset to create a rough, non-flickering
  // appearance.
  try {
    vctx.save();
    const brightColor = 'rgba(180,220,255,0.95)';
    const glowColor = 'rgba(180,220,255,0.18)';
    const amp1 = 0.9; // primary roughness amplitude (world units)
    const amp2 = 0.45; // secondary roughness amplitude

    // Primary thin stroke
    vctx.lineWidth = Math.max(1 * zoom, 0.5);
    vctx.strokeStyle = brightColor;
    let pathOpen = false;
    vctx.beginPath();
    for (let xi = leftIdx; xi <= rightIdx; xi++) {
      const hy = getHeightAtX(currentLevel as any, xi);
      if (hy === null) {
        if (pathOpen) {
          vctx.stroke();
          vctx.beginPath();
          pathOpen = false;
        }
        continue;
      }
      const sx = isEditor ? wxToS(xi) : xi - camOffsetX;
      // deterministic rough offset (sine-based) to avoid flicker
      const off = Math.sin(xi * 0.45) * amp1 + Math.sin(xi * 0.13) * amp2;
      const sy = isEditor ? wyToS(hy + off) : hy - camOffsetY + shakeY + off;
      if (!pathOpen) {
        vctx.moveTo(sx, sy);
        pathOpen = true;
      } else {
        vctx.lineTo(sx, sy);
      }
    }
    if (pathOpen) vctx.stroke();

    // Soft translucent glow below/around the bright line
    vctx.lineWidth = Math.max(2.2 * zoom, 1);
    vctx.strokeStyle = glowColor;
    pathOpen = false;
    vctx.beginPath();
    for (let xi = leftIdx; xi <= rightIdx; xi++) {
      const hy = getHeightAtX(currentLevel as any, xi);
      if (hy === null) {
        if (pathOpen) {
          vctx.stroke();
          vctx.beginPath();
          pathOpen = false;
        }
        continue;
      }
      const sx = isEditor ? wxToS(xi) : xi - camOffsetX;
      // smaller smoother offset for glow
      const off2 = Math.sin(xi * 0.33) * (amp1 * 0.5) + Math.sin(xi * 0.11) * (amp2 * 0.5);
      const sy = isEditor ? wyToS(hy + off2) : hy - camOffsetY + shakeY + off2;
      if (!pathOpen) {
        vctx.moveTo(sx, sy);
        pathOpen = true;
      } else {
        vctx.lineTo(sx, sy);
      }
    }
    if (pathOpen) vctx.stroke();

    vctx.restore();
  } catch (e) {}

  // Draw objects
  const objects = currentLevel.objects || [];
  // Draw gap-edge walls (wood) between a solid segment and a gap
  try {
    vctx.save();
    const wood = (ctx as any).woodPattern || null;
    const WALL_HALF = 0.5; // world units half-width of wall
    for (let xi = leftIdx; xi < rightIdx; xi++) {
      const left = getHeightAtX(currentLevel as any, xi);
      const right = getHeightAtX(currentLevel as any, xi + 1);
      if ((left === null && right !== null) || (left !== null && right === null)) {
        const edgeX = xi + 1;
        const worldLeft = edgeX - WALL_HALF;
        const worldRight = edgeX + WALL_HALF;
        const sxLeft = isEditor ? wxToS(worldLeft) : worldLeft - camOffsetX;
        const sxRight = isEditor ? wxToS(worldRight) : worldRight - camOffsetX;
        const solidH = left === null ? (right as number) : (left as number);
        const syTop = isEditor ? wyToS(solidH) : solidH - camOffsetY + shakeY;
        const syBottom = isEditor ? wyToS(VIRTUAL_HEIGHT) : VIRTUAL_HEIGHT - camOffsetY + shakeY;
        const h = Math.max(1, Math.round(syBottom - syTop));
        if (wood) vctx.fillStyle = wood as any;
        else vctx.fillStyle = '#5a3414';
        vctx.fillRect(Math.round(sxLeft), Math.round(syTop), Math.round(sxRight - sxLeft), h);
        // fallback stroked edge
        vctx.strokeStyle = 'rgba(0,0,0,0.25)';
        vctx.lineWidth = Math.max(1 * zoom, 0.5);
        vctx.strokeRect(Math.round(sxLeft), Math.round(syTop), Math.round(sxRight - sxLeft), h);
      }
    }
    vctx.restore();
  } catch (e) {}
  for (const obj of objects) {
    // determine object world Y (fall back to terrain height if unspecified)
    const oyWorld = typeof obj.y === 'number' ? obj.y : (getHeightAtX(currentLevel as any, Math.round(obj.x)) ?? VIRTUAL_HEIGHT / 2);
    const sx = isEditor ? wxToS(obj.x) : obj.x - camOffsetX;
    const sy = isEditor ? wyToS(oyWorld) : oyWorld - camOffsetY + shakeY;
    const radius = (obj.radius || 12) * zoom;
    if (sx < -radius || sx > VIRTUAL_WIDTH + radius) continue;

    if (obj.type === 'decor') {
      // skip decor already drawn behind the ground (layer === 0)
      const layer = (obj as any).layer;
      if (typeof layer === 'number' && layer === 0) continue;
      try {
        const oyWorld = typeof obj.y === 'number' ? obj.y : (getHeightAtX(currentLevel as any, Math.round(obj.x)) ?? VIRTUAL_HEIGHT / 2);
        const sx = isEditor ? wxToS(obj.x) : obj.x - camOffsetX;
        const sy = isEditor ? wyToS(oyWorld) : oyWorld - camOffsetY + shakeY;
        const scale = (obj as any).scale || 1;
        const src = (obj as any).src || '';
        const img = src ? assetManager.getImage(src) : undefined;
        if (img) {
          const w = (img.width || 64) * scale * zoom;
          const h = (img.height || 64) * scale * zoom;
          const dx = sx - w / 2;
          const dy = sy - h;
          vctx.drawImage(img, dx, dy, w, h);
        } else if (src) {
          // trigger async load so it appears next frame
          assetManager.loadImage(src).catch(() => {});
        }
      } catch (e) {}
    } else if (obj.type === 'hazard') {
      vctx.fillStyle = '#ff4444';
      vctx.beginPath();
      vctx.arc(sx, sy, radius, 0, Math.PI * 2);
      vctx.fill();
      vctx.strokeStyle = '#fff';
      vctx.lineWidth = 1.5 * zoom;
      vctx.stroke();
    } else if (obj.type === 'finish') {
      // draw a checkered finish flag on a wooden pole
      const poleH = 36 * zoom;
      const poleW = Math.max(1, Math.round(2 * zoom));
      const poleX = Math.round(sx - poleW / 2);
      const poleY = Math.round(sy - poleH);
      // pole
      vctx.fillStyle = (ctx as any).woodPattern || '#5a3414';
      vctx.fillRect(poleX, poleY, poleW, Math.round(poleH));
      vctx.strokeStyle = 'rgba(0,0,0,0.25)';
      vctx.lineWidth = Math.max(1 * zoom, 0.5);
      vctx.strokeRect(poleX, poleY, poleW, Math.round(poleH));
      // flag rectangle (checkered)
      const flagW = Math.round(16 * zoom);
      const flagH = Math.round(12 * zoom);
      const flagX = Math.round(sx + poleW / 2);
      const flagY = Math.round(poleY + 2);
      // draw checkerboard 4x3
      const cols = 4;
      const rows = 3;
      const cellW = Math.max(1, Math.floor(flagW / cols));
      const cellH = Math.max(1, Math.floor(flagH / rows));
      for (let cx = 0; cx < cols; cx++) {
        for (let cy = 0; cy < rows; cy++) {
          const isWhite = (cx + cy) % 2 === 0;
          vctx.fillStyle = isWhite ? '#fff' : '#000';
          vctx.fillRect(flagX + cx * cellW, flagY + cy * cellH, cellW, cellH);
        }
      }
      // thin outline for flag
      vctx.strokeStyle = 'rgba(0,0,0,0.6)';
      vctx.lineWidth = Math.max(1 * zoom, 0.5);
      vctx.strokeRect(flagX, flagY, flagW, flagH);
    } else if (obj.type === 'checkpoint') {
      // draw an orange checkpoint flag on a wooden pole (active = lighter)
      const active = ctx.lastCheckpointX >= obj.x;
      const poleH = 36 * zoom;
      const poleW = Math.max(1, Math.round(2 * zoom));
      const poleX = Math.round(sx - poleW / 2);
      const poleY = Math.round(sy - poleH);
      vctx.fillStyle = (ctx as any).woodPattern || '#5a3414';
      vctx.fillRect(poleX, poleY, poleW, Math.round(poleH));
      vctx.strokeStyle = 'rgba(0,0,0,0.25)';
      vctx.lineWidth = Math.max(1 * zoom, 0.5);
      vctx.strokeRect(poleX, poleY, poleW, Math.round(poleH));
      const flagW = Math.round(14 * zoom);
      const flagH = Math.round(10 * zoom);
      const fx0 = Math.round(sx + poleW / 2);
      const fy0 = Math.round(poleY + 2);
      vctx.fillStyle = active ? '#ffd27f' : '#ff8c00';
      vctx.beginPath();
      vctx.moveTo(fx0, fy0);
      vctx.lineTo(fx0 + flagW, fy0 + flagH / 2);
      vctx.lineTo(fx0, fy0 + flagH);
      vctx.closePath();
      vctx.fill();
      vctx.strokeStyle = 'rgba(0,0,0,0.25)';
      vctx.lineWidth = Math.max(1 * zoom, 0.5);
      vctx.stroke();
    } else if (obj.type === 'start') {
      // draw a green start flag on a wooden pole
      const poleH = 36 * zoom;
      const poleW = Math.max(1, Math.round(2 * zoom));
      const poleX = Math.round(sx - poleW / 2);
      const poleY = Math.round(sy - poleH);
      vctx.fillStyle = (ctx as any).woodPattern || '#5a3414';
      vctx.fillRect(poleX, poleY, poleW, Math.round(poleH));
      vctx.strokeStyle = 'rgba(0,0,0,0.25)';
      vctx.lineWidth = Math.max(1 * zoom, 0.5);
      vctx.strokeRect(poleX, poleY, poleW, Math.round(poleH));
      // green triangular flag
      const flagW = Math.round(14 * zoom);
      const flagH = Math.round(10 * zoom);
      const fx0 = Math.round(sx + poleW / 2);
      const fy0 = Math.round(poleY + 2);
      vctx.fillStyle = '#44ff44';
      vctx.beginPath();
      vctx.moveTo(fx0, fy0);
      vctx.lineTo(fx0 + flagW, fy0 + flagH / 2);
      vctx.lineTo(fx0, fy0 + flagH);
      vctx.closePath();
      vctx.fill();
      vctx.strokeStyle = 'rgba(0,0,0,0.25)';
      vctx.lineWidth = Math.max(1 * zoom, 0.5);
      vctx.stroke();
    } else if ((obj as any).type === 'wall') {
      // draw explicit editor-placed wall: top aligns with terrain unless obj.y specified
      const oy = typeof obj.y === 'number' ? obj.y : (getHeightAtX(currentLevel as any, Math.round(obj.x)) ?? VIRTUAL_HEIGHT / 2);
      const widthWorld = obj.width || 1;
      const halfW = widthWorld / 2;
      const worldLeft = obj.x - halfW;
      const worldRight = obj.x + halfW;
      const sxL = isEditor ? wxToS(worldLeft) : worldLeft - camOffsetX;
      const sxR = isEditor ? wxToS(worldRight) : worldRight - camOffsetX;
      const syTop = isEditor ? wyToS(oy) : oy - camOffsetY + shakeY;
      const syBottom = isEditor ? wyToS(VIRTUAL_HEIGHT) : VIRTUAL_HEIGHT - camOffsetY + shakeY;
      const h = Math.max(1, Math.round(syBottom - syTop));
      const wood = (ctx as any).woodPattern || null;
      if (wood) vctx.fillStyle = wood as any;
      else vctx.fillStyle = '#5a3414';
      vctx.fillRect(Math.round(sxL), Math.round(syTop), Math.round(sxR - sxL), h);
      vctx.strokeStyle = 'rgba(0,0,0,0.25)';
      vctx.lineWidth = Math.max(1 * zoom, 0.5);
      vctx.strokeRect(Math.round(sxL), Math.round(syTop), Math.round(sxR - sxL), h);
    }
    // draw signs
    else if (obj.type === 'sign') {
      const oy = typeof obj.y === 'number' ? obj.y : (getHeightAtX(currentLevel as any, Math.round(obj.x)) ?? VIRTUAL_HEIGHT / 2);
      const sxSign = isEditor ? wxToS(obj.x) : obj.x - camOffsetX;
      const sySign = isEditor ? wyToS(oy) : oy - camOffsetY + shakeY;
      const poleH = 64 * zoom;
      const poleW = Math.max(1, Math.round(2 * zoom));
      const poleX = Math.round(sxSign - poleW / 2);
      const poleY = Math.round(sySign - poleH);
      vctx.fillStyle = (ctx as any).woodPattern || '#5a3414';
      vctx.fillRect(poleX, poleY, poleW, Math.round(poleH));
      vctx.strokeStyle = 'rgba(0,0,0,0.25)';
      vctx.lineWidth = Math.max(1 * zoom, 0.5);
      vctx.strokeRect(poleX, poleY, poleW, Math.round(poleH));
      // board
      const boardW = Math.round(56 * zoom);
      const boardH = Math.round(30 * zoom);
      const boardX = Math.round(sxSign + poleW / 2 + 2);
      const boardY = Math.round(poleY + 2);
      vctx.fillStyle = '#c28f59';
      vctx.fillRect(boardX, boardY, boardW, boardH);
      vctx.strokeStyle = 'rgba(0,0,0,0.25)';
      vctx.strokeRect(boardX, boardY, boardW, boardH);
      // text with padding and monospace font; center and use consistent line height
      try {
        const lines: string[] = Array.isArray((obj as any).message) ? (obj as any).message : [];
        vctx.fillStyle = '#000';
        const padX = 8 * zoom;
        const padY = 6 * zoom;
        const fontSize = Math.max(9 * zoom, 9);
        vctx.font = `${fontSize}px monospace`;
        vctx.textAlign = 'center';
        vctx.textBaseline = 'top';
        const availableH = Math.max(1, boardH - padY * 2);
        const baseLineH = Math.max(1, Math.floor(availableH / 3));
        const extraSpacing = Math.max(1, Math.round(2 * zoom));
        const lineH = baseLineH; // height reserved for each line's font area
        // center text block vertically, accounting for extra spacing between lines
        const linesCount = Math.min(3, Math.max(1, lines.length));
        const totalTextH = lineH * linesCount + extraSpacing * (linesCount - 1);
        const startY = boardY + padY + Math.floor((availableH - totalTextH) / 2);
        const cx = boardX + boardW / 2;
        for (let i = 0; i < linesCount; i++) {
          const txt = (lines[i] || '').slice(0, 10).toUpperCase();
          const ty = startY + i * (lineH + extraSpacing);
          vctx.fillText(txt, cx, ty);
        }
      } catch (e) {}
    }
  }

  vctx.save();
  const psx = isEditor ? wxToS(ix) : ix - camOffsetX;
  const psy = isEditor ? wyToS(iy) : iy - camOffsetY + shakeY;
  vctx.translate(psx, psy);
  vctx.rotate(currPlayer.angle);
  // FEET_OFFSET: pixels from contact height to player's origin (matches simulation/respawn)
  const FEET_OFFSET = 8;

  if (playerEntity) {
    // draw so the sprite's bottom (feet) sits at the contact height
    // Debug: once, log the draw descriptor so we can inspect the
    // image source and frame sizes when debugging sprite issues in-game.
    try {
      const seen = (window as any).__playerSpriteLogged;
      if (!seen && typeof (playerEntity as any).collectDrawDescriptors === 'function') {
        const descs = (playerEntity as any).collectDrawDescriptors(0, FEET_OFFSET, { anchor: 'bottom', scale: zoom });
        // eslint-disable-next-line no-console
        console.log('[renderer] player draw descriptors:', descs);
        (window as any).__playerSpriteLogged = true;
      }
    } catch (e) {}
    playerEntity.draw(vctx, 0, FEET_OFFSET, { anchor: 'bottom', scale: zoom });
  } else {
    // No sprite available: intentionally draw nothing instead of a placeholder
    // square. This avoids visual clutter when the player sprite hasn't loaded.
  }
  vctx.restore();

  // Draw effects
  vctx.save();
  if (!isEditor) {
    vctx.translate(-camOffsetX, -camOffsetY + shakeY);
    effects.draw(vctx);
  }
  vctx.restore();

  // Editor overlay (drawn on top of world when active)
  if (isEditor && (ctx as any).editorStop && typeof (ctx as any).editorStop.renderOverlay === 'function') {
    try {
      (ctx as any).editorStop.renderOverlay(vctx, leftWorld, topWorld, viewWorldW, viewWorldH);
    } catch (e) {}
  }

  // Draw UI / Overlays
  if (!isEditor) {
    if (state === 'title') {
      vctx.fillStyle = 'rgba(0,0,0,0.5)';
      vctx.fillRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
      vctx.fillStyle = '#fff';
      vctx.font = '24px sans-serif';
      vctx.textAlign = 'center';
      vctx.fillText('SUPER SLED FOX', VIRTUAL_WIDTH / 2, VIRTUAL_HEIGHT / 2 - 20);
      vctx.font = '12px sans-serif';
      vctx.fillText('PRESS SPACE TO START', VIRTUAL_WIDTH / 2, VIRTUAL_HEIGHT / 2 + 20);
    } else if (state === 'paused') {
      vctx.fillStyle = 'rgba(0,0,0,0.4)';
      vctx.fillRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
      vctx.fillStyle = '#fff';
      vctx.font = '20px sans-serif';
      vctx.textAlign = 'center';
      vctx.fillText('PAUSED', VIRTUAL_WIDTH / 2, VIRTUAL_HEIGHT / 2);
    } else if (state === 'complete') {
      vctx.fillStyle = 'rgba(0,100,0,0.4)';
      vctx.fillRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
      vctx.fillStyle = '#fff';
      vctx.font = '20px sans-serif';
      vctx.textAlign = 'center';
      vctx.fillText('LEVEL COMPLETE!', VIRTUAL_WIDTH / 2, VIRTUAL_HEIGHT / 2 - 10);
      vctx.font = '10px sans-serif';
      vctx.fillText('PRESS SPACE FOR NEXT LEVEL', VIRTUAL_WIDTH / 2, VIRTUAL_HEIGHT / 2 + 20);
    } else if (state === 'dead') {
      if (crashFade > 0) {
        vctx.fillStyle = `rgba(255,255,255,${crashFade * 0.8})`;
        vctx.fillRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
      }
      if (crashTimer <= 0) {
        vctx.fillStyle = 'rgba(0,0,0,0.3)';
        vctx.fillRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
        vctx.fillStyle = '#fff';
        vctx.font = '16px sans-serif';
        vctx.textAlign = 'center';
        vctx.fillText('CRASHED!', VIRTUAL_WIDTH / 2, VIRTUAL_HEIGHT / 2 - 5);
        vctx.font = '10px sans-serif';
        vctx.fillText('PRESS R TO RESTART', VIRTUAL_WIDTH / 2, VIRTUAL_HEIGHT / 2 + 15);
      }
    } else if (state === 'loading') {
      vctx.fillStyle = '#0b1220';
      vctx.fillRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
      vctx.fillStyle = '#fff';
      vctx.font = '12px sans-serif';
      vctx.textAlign = 'center';
      vctx.fillText('LOADING...', VIRTUAL_WIDTH / 2, VIRTUAL_HEIGHT / 2);
    }

    if (landingFlash > 0) {
      vctx.fillStyle = `rgba(255,255,255,${landingFlash * 0.5})`;
      vctx.fillRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
    }

    // Top overlay: checkpoint/status indicators (only when level has checkpoints)
    try {
      const objs = (currentLevel && currentLevel.objects) || [];
      const cps = objs.filter((o: any) => o.type === 'checkpoint');
      if (cps.length > 0) {
        const MARGIN = 12;
        const barX = MARGIN;
        const barY = 6;
        const barW = VIRTUAL_WIDTH - MARGIN * 2;
        const barH = 18;

        // (avalanche top band removed)

        // no background band: flags render directly on top of view

        // draw flags in a compact row centered at the top
        const flagW = 8;
        const flagH = 6;
        const poleW = 2;
        const poleH = 8;
        const gap = 4; // pixels between flags
        const totalW = cps.length * (flagW + poleW + gap);
        const startX = Math.round((VIRTUAL_WIDTH - totalW) / 2) + Math.round(poleW / 2);
        const sy = 8 + Math.round(poleH / 2);
        for (let i = 0; i < cps.length; i++) {
          const cp = cps[i] as any;
          const sx = startX + i * (flagW + poleW + gap);

          // determine state
          const reached = typeof ctx.lastCheckpointX === 'number' && (ctx.lastCheckpointX || 0) >= (cp.x || 0);
          const avalPast = typeof (ctx as any).avalancheX === 'number' && (ctx as any).avalancheX > (cp.x || 0);

          vctx.save();
          // inactive = mostly transparent
          if (!reached && !avalPast) vctx.globalAlpha = 0.25;

          // draw pole
          vctx.fillStyle = (ctx as any).woodPattern || '#5a3414';
          vctx.fillRect(sx - Math.floor(poleW / 2), sy - poleH, poleW, poleH);

          // choose flag color: reached->light orange, not reached->orange, avalanche past->red
          let flagColor = '#ff8c00';
          if (reached) flagColor = '#ffd27f';
          if (avalPast) flagColor = '#ff4444';

          // draw triangular flag (small)
          const fx0 = sx + Math.round(poleW / 2) + 1;
          const fy0 = sy - poleH + 1;
          vctx.fillStyle = flagColor;
          vctx.beginPath();
          vctx.moveTo(fx0, fy0);
          vctx.lineTo(fx0 + flagW, fy0 + Math.round(flagH / 2));
          vctx.lineTo(fx0, fy0 + flagH);
          vctx.closePath();
          vctx.fill();
          vctx.restore();
        }
        // small boost/stamina bar centered under the flags (below the top band)
        try {
          const stamina = typeof ctx.boostStamina === 'number' ? ctx.boostStamina : 1;
          const barW = 40;
          const barH = 3;

          // compute player screen position
          const playerSX = isEditor ? wxToS(ix) : ix - camOffsetX;
          const playerSY = isEditor ? wyToS(iy) : iy - camOffsetY + shakeY;
          const barX = Math.round(playerSX - barW / 2) + 2;
          const barY = Math.round(playerSY + 20);

          // compute opacity per rules:
          const isBoosting = !!(ctx as any).isBoosting;
          const locked = !!(ctx as any).boostLocked;
          const blinkOn = !!(ctx as any).boostBlinkOn;
          const fullVisible = ((ctx as any).boostFullVisibleTimer || 0) > 0;

          let opacity = 0;
          if (isBoosting) opacity = 1.0;
          else if (locked) opacity = 1.0; // keep fully visible when depleted (border will blink)
          else if (fullVisible) opacity = 1.0;
          else opacity = stamina >= 1 - 1e-6 ? 0.0 : 1.0; // do not reduce opacity while refilling

          if (opacity > 0) {
            vctx.save();
            vctx.globalAlpha = opacity;

            vctx.fillStyle = '#222';
            vctx.fillRect(barX, barY, barW, barH);
            const innerPad = 1;
            const innerW = Math.max(0, Math.round((barW - innerPad * 2) * stamina));
            const innerH = Math.max(0, barH - innerPad * 2);
            const innerColor = locked ? '#ff4444' : '#4eeaf7';
            vctx.fillStyle = innerColor;
            vctx.fillRect(barX + innerPad, barY + innerPad, innerW, innerH);
            const strokeColor = locked ? (blinkOn ? 'rgba(255,68,68,0.95)' : 'rgba(255,68,68,0.6)') : 'rgba(136,136,136,0.28)';
            vctx.strokeStyle = strokeColor;
            vctx.lineWidth = 0.5;
            vctx.strokeRect(barX + 0.5, barY + 0.5, barW - 1, barH - 1);

            vctx.restore();
          }
        } catch (e) {}
        // top band removed
      }
    } catch (e) {}

    if (restartHintTimer > 0) {
      vctx.fillStyle = `rgba(255,255,255,${Math.min(1, restartHintTimer)})`;
      vctx.font = '8px monospace';
      vctx.textAlign = 'right';
      vctx.fillText('PRESS R TO RESTART LEVEL', VIRTUAL_WIDTH - 8, VIRTUAL_HEIGHT - 8);
    }

    // Small controls hint at bottom center
    try {
      const hintText = 'JUMP: Spacebar  BRAKE: Left Arrow or A  BOOST: Hold Right Arrow or D';
      vctx.font = '8px sans-serif';
      vctx.textAlign = 'center';
      vctx.fillStyle = 'rgba(0,0,0,0.45)';
      // subtle background bar for readability
      const padH = 6;
      const hintW = vctx.measureText(hintText).width + 18;
      const hintX = VIRTUAL_WIDTH / 2 - hintW / 2;
      const hintY = VIRTUAL_HEIGHT - 18 - padH / 2;
      vctx.fillRect(hintX, hintY, hintW, padH + 6);
      vctx.fillStyle = 'rgba(255,255,255,0.92)';
      vctx.fillText(hintText, VIRTUAL_WIDTH / 2, VIRTUAL_HEIGHT - 12);
    } catch (e) {}
  }

  if (noisePattern) {
    vctx.save();
    vctx.globalCompositeOperation = 'overlay';
    vctx.globalAlpha = 0.04;
    vctx.fillStyle = noisePattern;
    vctx.fillRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
    vctx.restore();
  }

  // Draw debug info
  const debugEnabled = (window as any).__DEBUG_INFO;
  if (debugEnabled) {
    vctx.fillStyle = 'rgba(0,0,0,0.5)';
    vctx.fillRect(2, 2, 120, 75);
    vctx.fillStyle = '#0f0';
    vctx.font = '8px monospace';
    vctx.textAlign = 'left';
    vctx.fillText(`FPS: ${Math.round(fps)}`, 5, 12);
    vctx.fillText(`POS: ${Math.round(currPlayer.x)},${Math.round(currPlayer.y)}`, 5, 22);
    vctx.fillText(`VEL: ${Math.round(currPlayer.vx)},${Math.round(currPlayer.vy)}`, 5, 32);
    vctx.fillText(`GND: ${currPlayer.grounded} (was:${currPlayer.wasGrounded})`, 5, 42);
    vctx.fillText(`SLP: ${ctx.lastSlope?.toFixed(3)} (eff:${ctx.lastSlopeEff?.toFixed(3)})`, 5, 52);
    vctx.fillText(`ACC: ${ctx.lastAccelRaw?.toFixed(1)} (sc:${ctx.lastAccelScaled?.toFixed(1)})`, 5, 62);
    vctx.fillText(`CAM: ${Math.round(camx)}`, 5, 72);
  }

  // Draw virtual canvas to real canvas
  const scale = Math.min(window.innerWidth / VIRTUAL_WIDTH, window.innerHeight / VIRTUAL_HEIGHT);
  const destW = Math.round(VIRTUAL_WIDTH * scale);
  const destH = Math.round(VIRTUAL_HEIGHT * scale);
  const destX = Math.round((window.innerWidth - destW) / 2);
  const destY = Math.round((window.innerHeight - destH) / 2);
  const dpr = window.devicePixelRatio || 1;

  mainCtx.fillStyle = '#000';
  mainCtx.fillRect(0, 0, canvasEl.width, canvasEl.height);
  mainCtx.imageSmoothingEnabled = false;
  vctx.imageSmoothingEnabled = false;
  mainCtx.drawImage(vctx.canvas, 0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT, destX * dpr, destY * dpr, destW * dpr, destH * dpr);
}
