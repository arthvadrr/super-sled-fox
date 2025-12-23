import type { Level } from './level';

type StartOpts = {
  canvas: HTMLCanvasElement;
  screenToWorld: (clientX: number, clientY: number) => { x: number; y: number };
  level: Level;
  onChange?: () => void;
  segmentLen?: number;
  virtualHeight?: number;
};

export function startEditor(opts: StartOpts) {
  const { canvas, screenToWorld, level, onChange, segmentLen = 1, virtualHeight = 225 } = opts;
  if (!level || !Array.isArray(level.segments)) return () => {};

  let dragging = false;
  let lastIndex: number | null = null;
  let hoveredIndex: number | null = null;
  let rafScheduled = false;

  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

  function worldXToIndex(wx: number) {
    return clamp(Math.floor(wx / segmentLen), 0, level.segments.length - 1);
  }

  function worldYToHeight(wy: number) {
    return clamp(Math.round(wy), 0, virtualHeight);
  }

  function scheduleOnChange() {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      onChange?.();
    });
  }

  function paintBetween(a: number, b: number, h: number) {
    const s = Math.min(a, b);
    const t = Math.max(a, b);
    for (let i = s; i <= t; i++) level.segments[i] = h;
  }

  function onPointerDown(e: PointerEvent) {
    if ((canvas.dataset.editorActive ?? '') !== '1') return;
    if (e.button !== 0) return;
    dragging = true;
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch (err) {}
    const { x: wx, y: wy } = screenToWorld(e.clientX, e.clientY);
    const idx = worldXToIndex(wx);
    const h = worldYToHeight(wy);
    level.segments[idx] = h;
    lastIndex = idx;
    scheduleOnChange();
  }

  function onPointerMove(e: PointerEvent) {
    const { x: wx, y: wy } = screenToWorld(e.clientX, e.clientY);
    const idx = worldXToIndex(wx);
    hoveredIndex = idx;
    if (!dragging) return;
    const h = worldYToHeight(wy);
    if (lastIndex === null) {
      level.segments[idx] = h;
      lastIndex = idx;
      scheduleOnChange();
      return;
    }
    if (idx === lastIndex) {
      level.segments[idx] = h;
      scheduleOnChange();
      return;
    }
    paintBetween(lastIndex, idx, h);
    lastIndex = idx;
    scheduleOnChange();
  }

  function onPointerUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    try {
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch (err) {}
    lastIndex = null;
    scheduleOnChange();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  function stop() {
    canvas.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
  }

  (stop as any).renderOverlay = function (vctx: CanvasRenderingContext2D, camX: number, viewW: number, viewH: number) {
    vctx.save();
    const offsetX = Math.round(viewW / 2 - camX);
    vctx.translate(offsetX, 0);

    const startX = Math.max(0, Math.floor((camX - viewW / 2) / segmentLen) - 1);
    const endX = Math.min(level.segments.length - 1, Math.ceil((camX + viewW / 2) / segmentLen) + 1);

    vctx.lineWidth = 1;
    for (let i = startX; i <= endX; i++) {
      const sx = i * segmentLen;
      vctx.strokeStyle = i % 10 === 0 ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)';
      vctx.beginPath();
      vctx.moveTo(sx + 0.5, 0);
      vctx.lineTo(sx + 0.5, viewH);
      vctx.stroke();
    }

    if (hoveredIndex !== null) {
      const hx = hoveredIndex * segmentLen;
      vctx.fillStyle = 'rgba(255,255,0,0.08)';
      vctx.fillRect(hx, 0, segmentLen, viewH);
    }

    vctx.fillStyle = 'rgba(255,255,255,0.95)';
    vctx.strokeStyle = 'rgba(0,0,0,0.6)';
    for (let i = startX; i <= endX; i++) {
      const v = level.segments[i];
      const sx = i * segmentLen + segmentLen / 2;
      if (v === null) {
        vctx.fillStyle = 'rgba(255,0,0,0.9)';
        vctx.fillRect(sx - 2, viewH - 6, 4, 4);
        vctx.fillStyle = 'rgba(255,255,255,0.95)';
      } else {
        const hy = v as number;
        vctx.beginPath();
        vctx.arc(sx, hy, 2.0, 0, Math.PI * 2);
        vctx.fill();
        vctx.stroke();
      }
    }

    vctx.restore();
  };

  return stop;
}

export default { startEditor };
