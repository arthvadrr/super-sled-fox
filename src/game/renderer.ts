import { VIRTUAL_WIDTH, VIRTUAL_HEIGHT, RENDER_SETTINGS, FIXED_DT } from './constants';
import { GameContext } from './types';
import { getHeightAtX } from '../heightmap';

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

  // Editor camera uses the same coordinate convention as screenToWorldFn:
  // camX/camY represent the CENTER of the view in world units.
  const camXUsed = isEditor ? editorCamX : camx;
  const camYUsed = isEditor ? editorCamY : 0;
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

  // compute visible segment range for culling (zoom-aware)
  const rightWorld = camXUsed + viewWorldW / 2;
  const leftIdx = Math.max(0, Math.floor(leftWorld) - PADDING);
  const rightIdx = Math.min((currentLevel.segments && currentLevel.segments.length - 1) || 0, Math.ceil(rightWorld) + PADDING);

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
    const sy = isEditor ? wyToS(hy) : hy + shakeY;
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
      const sx = isEditor ? wxToS(xi) : (xi - camOffsetX);
      // deterministic rough offset (sine-based) to avoid flicker
      const off = (Math.sin(xi * 0.45) * amp1 + Math.sin(xi * 0.13) * amp2);
      const sy = isEditor ? wyToS(hy + off) : (hy + shakeY + off);
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
      const sx = isEditor ? wxToS(xi) : (xi - camOffsetX);
      // smaller smoother offset for glow
      const off2 = (Math.sin(xi * 0.33) * (amp1 * 0.5) + Math.sin(xi * 0.11) * (amp2 * 0.5));
      const sy = isEditor ? wyToS(hy + off2) : (hy + shakeY + off2);
      if (!pathOpen) {
        vctx.moveTo(sx, sy);
        pathOpen = true;
      } else {
        vctx.lineTo(sx, sy);
      }
    }
    if (pathOpen) vctx.stroke();

    vctx.restore();
  } catch (e) { }

  // Draw objects
  const objects = currentLevel.objects || [];
  for (const obj of objects) {
    const sx = isEditor ? wxToS(obj.x) : obj.x - camOffsetX;
    const sy = isEditor ? wyToS(obj.y) : obj.y + shakeY;
    const radius = (obj.radius || 12) * zoom;
    if (sx < -radius || sx > VIRTUAL_WIDTH + radius) continue;

    if (obj.type === 'hazard') {
      vctx.fillStyle = '#ff4444';
      vctx.beginPath();
      vctx.arc(sx, sy, radius, 0, Math.PI * 2);
      vctx.fill();
      vctx.strokeStyle = '#fff';
      vctx.lineWidth = 1.5 * zoom;
      vctx.stroke();
    } else if (obj.type === 'finish') {
      vctx.fillStyle = '#44ff44';
      vctx.beginPath();
      vctx.arc(sx, sy, radius, 0, Math.PI * 2);
      vctx.fill();
      vctx.strokeStyle = '#fff';
      vctx.lineWidth = 2 * zoom;
      vctx.stroke();
    } else if (obj.type === 'checkpoint') {
      const active = ctx.lastCheckpointX >= obj.x;
      vctx.fillStyle = active ? '#ffff44' : '#666644';
      vctx.beginPath();
      vctx.arc(sx, sy, radius * 0.7, 0, Math.PI * 2);
      vctx.fill();
    } else if (obj.type === 'start') {
      vctx.strokeStyle = '#8888ff';
      vctx.setLineDash([4 * zoom, 4 * zoom]);
      vctx.beginPath();
      vctx.arc(sx, sy, radius, 0, Math.PI * 2);
      vctx.stroke();
      vctx.setLineDash([]);
    }
  }

  // Draw player
  vctx.save();
  const psx = isEditor ? wxToS(ix) : ix - camOffsetX;
  const psy = isEditor ? wyToS(iy) : iy + shakeY;
  vctx.translate(psx, psy);
  vctx.rotate(currPlayer.angle);
  // FEET_OFFSET: pixels from contact height to player's origin (matches simulation/respawn)
  const FEET_OFFSET = 8;

  if (playerEntity) {
    // draw so the sprite's bottom (feet) sits at the contact height
    playerEntity.draw(vctx, 0, FEET_OFFSET, { anchor: 'bottom', scale: zoom });
  } else {
    vctx.fillStyle = '#ff9900';
    const pw = 16 * zoom;
    const ph = 8 * zoom;
    vctx.fillRect(-pw / 2, -ph / 2, pw, ph);
  }
  vctx.restore();

  // Draw effects
  vctx.save();
  if (!isEditor) {
    vctx.translate(-camOffsetX, shakeY);
    effects.draw(vctx);
  }
  vctx.restore();

  // Editor overlay (drawn on top of world when active)
  if (isEditor && (ctx as any).editorStop && typeof (ctx as any).editorStop.renderOverlay === 'function') {
    try {
      (ctx as any).editorStop.renderOverlay(vctx, leftWorld, topWorld, viewWorldW, viewWorldH);
    } catch (e) { }
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

    if (restartHintTimer > 0) {
      vctx.fillStyle = `rgba(255,255,255,${Math.min(1, restartHintTimer)})`;
      vctx.font = '8px monospace';
      vctx.textAlign = 'right';
      vctx.fillText('PRESS R TO RESTART LEVEL', VIRTUAL_WIDTH - 8, VIRTUAL_HEIGHT - 8);
    }
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
