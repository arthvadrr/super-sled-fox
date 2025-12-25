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

  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  function worldXToIndex(wx: number) {
    return clamp(Math.floor(wx / segmentLen), 0, level.segments.length - 1);
  }
  function worldYToHeight(wy: number) {
    const metaVH = (level.meta && (level.meta as any).virtualHeight) as number | undefined;
    const vh = typeof metaVH === 'number' ? metaVH : virtualHeight;
    return clamp(Math.round(wy), 0, vh);
  }

  // Tools
  enum Tool {
    PaintHeight = 'Paint',
    ToggleGap = 'ToggleGap',
    PlaceCheckpoint = 'PlaceCheckpoint',
    PlaceStart = 'PlaceStart',
    PlaceFinish = 'PlaceFinish',
    PlaceWall = 'PlaceWall',
    Select = 'Select',
    PlaceSign = 'PlaceSign',
    Delete = 'Delete',
  }

  let currentTool: Tool = Tool.PaintHeight;
  let rafScheduled = false;
  let dragging = false;
  let lastPaintIndex: number | null = null;
  let hoveredIndex: number | null = null;
  let lastGapIndex: number | null = null;
  let gapDragAction: 'makeGap' | 'fillGap' | null = null;
  let gapFillHeight: number = 100;
  let selectedObjectIndex: number | null = null; // index into level.objects
  let draggingObjectIndex: number | null = null;
  let statusText: string | null = null;

  function scheduleOnChange() {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      onChange?.();
    });
  }

  // helpers
  function ensureStartFinish() {
    if (!Array.isArray(level.objects)) level.objects = [] as any;
    const hasStart = (level.objects || []).some((o) => o.type === 'start');
    const hasFinish = (level.objects || []).some((o) => o.type === 'finish');
    if (!hasStart) level.objects.push({ type: 'start', x: Math.max(0, Math.min(level.segments.length - 1, 4)) });
    if (!hasFinish) level.objects.push({ type: 'finish', x: Math.max(0, Math.min(level.segments.length - 1, level.segments.length - 5)) });
  }

  function paintBetween(a: number, b: number, h: number) {
    const s = Math.min(a, b);
    const t = Math.max(a, b);
    for (let i = s; i <= t; i++) level.segments[i] = h;
  }

  function findNearestObjectByIndex(idx: number, radiusSegments: number) {
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < (level.objects || []).length; i++) {
      const o = level.objects[i];
      const d = Math.abs((o.x || 0) - idx);
      if (d <= radiusSegments && d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best >= 0 ? best : null;
  }

  function findNearestNonNullHeight(idx: number): number {
    // search outward for a non-null height to use when filling a gap
    for (let d = 1; d < level.segments.length; d++) {
      const l = idx - d;
      const r = idx + d;
      if (l >= 0 && level.segments[l] !== null) return level.segments[l] as number;
      if (r < level.segments.length && level.segments[r] !== null) return level.segments[r] as number;
    }
    return 100;
  }

  function applyGapBetween(a: number, b: number) {
    const s = Math.min(a, b);
    const t = Math.max(a, b);
    for (let i = s; i <= t; i++) {
      if (gapDragAction === 'makeGap') {
        level.segments[i] = null;
      } else if (gapDragAction === 'fillGap') {
        level.segments[i] = gapFillHeight;
      }
    }
  }

  ensureStartFinish();

  // pointer handlers
  function onPointerDown(e: PointerEvent) {
    if ((canvas.dataset.editorActive ?? '') !== '1') return;
    if (e.button !== 0) return;
    dragging = true;
    lastGapIndex = null;
    gapDragAction = null;
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch (err) {}
    const { x: wx, y: wy } = screenToWorld(e.clientX, e.clientY);
    const idx = worldXToIndex(wx);
    hoveredIndex = idx;

    if (currentTool === Tool.PaintHeight) {
      const h = worldYToHeight(wy);
      level.segments[idx] = h;
      lastPaintIndex = idx;
      selectedObjectIndex = null;
      scheduleOnChange();
      return;
    }

    if (currentTool === Tool.ToggleGap) {
      // Dragging in gap mode should create ONE continuous action, not flip-flop per segment.
      // Decide the action from the first segment: if it is currently a gap, we will fill; otherwise we will make a gap.
      gapDragAction = level.segments[idx] === null ? 'fillGap' : 'makeGap';
      gapFillHeight = findNearestNonNullHeight(idx);
      lastGapIndex = idx;
      applyGapBetween(idx, idx);
      scheduleOnChange();
      return;
    }

    if (currentTool === Tool.PlaceCheckpoint || currentTool === Tool.PlaceStart || currentTool === Tool.PlaceFinish) {
      const objIdx = idx;
      if (currentTool === Tool.PlaceCheckpoint) {
        const found = (level.objects || []).findIndex((o) => o.type === 'checkpoint' && Math.abs((o.x || 0) - objIdx) <= 1);
        if (found >= 0) {
          level.objects[found].x = objIdx;
          selectedObjectIndex = found;
        } else {
          level.objects.push({ type: 'checkpoint', x: objIdx } as any);
          selectedObjectIndex = level.objects.length - 1;
        }
      } else {
        const t = currentTool === Tool.PlaceStart ? 'start' : 'finish';
        const found = (level.objects || []).findIndex((o) => o.type === t);
        if (found >= 0) {
          level.objects[found].x = objIdx;
          selectedObjectIndex = found;
        } else {
          level.objects.push({ type: t as any, x: objIdx } as any);
          selectedObjectIndex = level.objects.length - 1;
        }
      }
      scheduleOnChange();
      return;
    }
    if (currentTool === Tool.PlaceSign) {
      // place a sign and prompt for up to 3 lines (10 chars each)
      if (!Array.isArray(level.objects)) level.objects = [] as any;
      const defaultMsg = ['', '', ''];
      level.objects.push({ type: 'sign', x: idx, message: defaultMsg } as any);
      selectedObjectIndex = level.objects.length - 1;
      // prompt for lines sequentially
      try {
        const lines: string[] = [];
        for (let li = 0; li < 3; li++) {
          const promptText = `Sign line ${li + 1} (max 10 chars, leave blank to skip)`;
          const resp = window.prompt(promptText, '');
          if (!resp) break;
          lines.push(resp.slice(0, 10).toUpperCase());
        }
        if (lines.length > 0) level.objects[selectedObjectIndex].message = lines;
      } catch (e) {}
      scheduleOnChange();
      return;
    }

    if (currentTool === Tool.PlaceWall) {
      // toggle wall at this index
      if (!Array.isArray(level.objects)) level.objects = [] as any;
      // find existing wall within 1 segment
      const found = (level.objects || []).findIndex((o) => (o as any).type === 'wall' && Math.abs(((o as any).x || 0) - idx) <= 1);
      if (found >= 0) {
        level.objects.splice(found, 1);
      } else {
        level.objects.push({ type: 'wall', x: idx } as any);
      }
      selectedObjectIndex = null;
      scheduleOnChange();
      return;
    }

    if (currentTool === Tool.Select) {
      const pickRadius = 12; // virtual pixels
      const radiusSegments = Math.ceil(pickRadius / Math.max(1, segmentLen));
      const foundIndex = findNearestObjectByIndex(idx, radiusSegments);
      if (foundIndex !== null) {
        selectedObjectIndex = foundIndex;
        draggingObjectIndex = selectedObjectIndex;
      } else {
        selectedObjectIndex = null;
      }
      scheduleOnChange();
      return;
    }

    if (currentTool === Tool.Delete) {
      const pickRadius = 12; // virtual pixels
      const radiusSegments = Math.ceil(pickRadius / Math.max(1, segmentLen));
      const foundIndex = findNearestObjectByIndex(idx, radiusSegments);
      if (foundIndex !== null) {
        // remove the object
        level.objects.splice(foundIndex, 1);
        selectedObjectIndex = null;
        scheduleOnChange();
      } else {
        statusText = 'No object to delete here';
        setTimeout(() => (statusText = null), 900);
      }
      return;
    }
  }

  function onPointerMove(e: PointerEvent) {
    const { x: wx, y: wy } = screenToWorld(e.clientX, e.clientY);
    const idx = worldXToIndex(wx);
    hoveredIndex = idx;
    if (!dragging) return;

    if (currentTool === Tool.PaintHeight) {
      const h = worldYToHeight(wy);
      if (lastPaintIndex === null) {
        level.segments[idx] = h;
        lastPaintIndex = idx;
        scheduleOnChange();
        return;
      }
      if (idx === lastPaintIndex) {
        level.segments[idx] = h;
        scheduleOnChange();
        return;
      }
      paintBetween(lastPaintIndex, idx, h);
      lastPaintIndex = idx;
      scheduleOnChange();
      return;
    }

    if (currentTool === Tool.ToggleGap) {
      if (gapDragAction === null) {
        // Safety: if we somehow missed pointerdown initialization, infer an action.
        gapDragAction = level.segments[idx] === null ? 'fillGap' : 'makeGap';
        gapFillHeight = findNearestNonNullHeight(idx);
      }
      if (lastGapIndex === null) {
        lastGapIndex = idx;
        applyGapBetween(idx, idx);
        scheduleOnChange();
        return;
      }
      // Apply idempotent action across the span crossed since the last move.
      applyGapBetween(lastGapIndex, idx);
      lastGapIndex = idx;
      scheduleOnChange();
      return;
    }

    if (currentTool === Tool.Select && draggingObjectIndex !== null) {
      const obj = level.objects[draggingObjectIndex];
      if (!obj) return;
      const newX = idx;
      obj.x = Math.max(0, Math.min(level.segments.length - 1, newX));
      scheduleOnChange();
      return;
    }

    // allow quick-edit of a selected sign via double-click (open prompt)
    if (currentTool === Tool.Select && draggingObjectIndex !== null && level.objects[draggingObjectIndex]?.type === 'sign') {
      // handled elsewhere on pointerup; no-op here
    }
  }

  function onPointerUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    try {
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch (err) {}
    lastPaintIndex = null;
    lastGapIndex = null;
    gapDragAction = null;
    scheduleOnChange();
    // Auto-smooth small jaggedness after a paint operation so tiny bumps
    // don't create micro-uphill events that bleed speed.
    if (currentTool === Tool.PaintHeight) {
      smoothSegments(1);
    }
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  function onKeyDown(e: KeyboardEvent) {
    const k = e.key.toLowerCase();
    if (k === '1') currentTool = Tool.PaintHeight;
    else if (k === '2') currentTool = Tool.ToggleGap;
    else if (k === '3') currentTool = Tool.PlaceCheckpoint;
    else if (k === '4') currentTool = Tool.PlaceStart;
    else if (k === '5') currentTool = Tool.PlaceFinish;
    else if (k === 'v' || k === '0') currentTool = Tool.Select;
    else if (k === '8') currentTool = Tool.PlaceSign;
    else if (k === '7') currentTool = Tool.Delete;
    else if (k === 'e') {
      // edit selected object (sign text)
      if (selectedObjectIndex !== null) {
        const obj = level.objects[selectedObjectIndex];
        if (obj && obj.type === 'sign') {
          try {
            const old = obj.message || [];
            const lines: string[] = [];
            for (let li = 0; li < 3; li++) {
              const existing = old[li] || '';
              const resp = window.prompt(`Edit sign line ${li + 1} (max 10 chars, leave blank to keep)`, existing);
              if (resp === null) {
                // cancelled — keep remaining lines
                lines.push(existing);
                continue;
              }
              lines.push(resp.slice(0, 10).toUpperCase());
            }
            obj.message = lines;
            scheduleOnChange();
          } catch (e) {}
        }
      }
    } else if (k === 'escape') {
      selectedObjectIndex = null;
      currentTool = Tool.PaintHeight;
    } else if (k === 'delete' || k === 'backspace') {
      if (selectedObjectIndex !== null) {
        // delete currently selected object
        level.objects.splice(selectedObjectIndex, 1);
        selectedObjectIndex = null;
        scheduleOnChange();
      }
    }
  }
  window.addEventListener('keydown', onKeyDown as any);

  function stop() {
    canvas.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    window.removeEventListener('keydown', onKeyDown as any);
    window.removeEventListener('keydown', onKeyDownExtra as any);
  }

  // allow switching to wall tool via key '6'
  function onKeyDownExtra(e: KeyboardEvent) {
    const k = e.key.toLowerCase();
    if (k === '6') currentTool = Tool.PlaceWall;
  }
  window.addEventListener('keydown', onKeyDownExtra as any);

  // Smooth the `level.segments` array in-place using a simple moving average
  // over a radius (in segments). Null (gaps) are preserved.
  function smoothSegments(radius: number = 1) {
    if (!level || !Array.isArray(level.segments)) return;
    const old = level.segments.slice();
    const n = old.length;
    const out: (number | null)[] = old.slice();
    for (let i = 0; i < n; i++) {
      if (old[i] === null) continue; // preserve gaps
      let sum = 0;
      let count = 0;
      const a = Math.max(0, i - radius);
      const b = Math.min(n - 1, i + radius);
      for (let j = a; j <= b; j++) {
        const v = old[j];
        if (v !== null && typeof v === 'number') {
          sum += v as number;
          count++;
        }
      }
      if (count > 0) out[i] = Math.round(sum / count);
    }
    level.segments = out;
    scheduleOnChange();
  }

  (stop as any).renderOverlay = function (vctx: CanvasRenderingContext2D, leftWorld: number, topWorld: number, viewW: number, viewH: number) {
    vctx.save();

    // Map world-space view window (viewW/viewH) into the fixed virtual canvas pixel space.
    // Game.tsx renders the world with this same mapping when zoomed.
    const canvasW = vctx.canvas.width;
    const canvasH = vctx.canvas.height;
    const scaleX = canvasW / Math.max(0.0001, viewW);
    const scaleY = canvasH / Math.max(0.0001, viewH);
    const onePx = 1 / Math.max(0.0001, scaleX);
    const halfPx = 0.5 * onePx;

    // screen = (world - leftWorld/topWorld) * scale
    // IMPORTANT: scale first, then translate by world units.
    vctx.scale(scaleX, scaleY);
    vctx.translate(-leftWorld, -topWorld);

    const rightWorld = leftWorld + viewW;
    const bottomWorld = topWorld + viewH;

    const startX = Math.max(0, Math.floor(leftWorld / segmentLen) - 1);
    const endX = Math.min(level.segments.length - 1, Math.ceil(rightWorld / segmentLen) + 1);

    vctx.lineWidth = onePx;
    // grid lines
    for (let i = startX; i <= endX; i++) {
      const sx = i * segmentLen;
      vctx.strokeStyle = i % 10 === 0 ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)';
      vctx.beginPath();
      vctx.moveTo(sx + halfPx, topWorld);
      vctx.lineTo(sx + halfPx, bottomWorld);
      vctx.stroke();
    }

    // gaps visualization
    for (let i = startX; i <= endX; i++) {
      if (level.segments[i] === null) {
        const sx = i * segmentLen;
        vctx.fillStyle = 'rgba(255,0,0,0.08)';
        vctx.fillRect(sx, topWorld, segmentLen, viewH);
      }
    }

    // draw gap-edge walls in editor (purple) so designers can see where
    // collision faces will be created. This is editor-only and does not
    // affect in-game visuals.
    try {
      const wallHalf = Math.min(segmentLen * 0.5, 2);
      for (let i = startX; i <= endX; i++) {
        const left = level.segments[i];
        const right = i + 1 < (level.segments || []).length ? level.segments[i + 1] : undefined;
        if ((left === null && typeof right === 'number') || (typeof left === 'number' && right === null)) {
          const edgeX = (i + 1) * segmentLen;
          const worldLeft = edgeX - wallHalf;
          const worldRight = edgeX + wallHalf;
          const sxLeft = worldLeft;
          const sxRight = worldRight;
          const solidH = left === null ? (right as number) : (left as number);
          const syTop = solidH;
          const syBottom = topWorld + viewH;
          // editor-only purple wall fill
          vctx.fillStyle = 'rgba(160,64,255,0.95)';
          vctx.fillRect(sxLeft, syTop, sxRight - sxLeft, syBottom - syTop);
          // decorative darker streaks to imply texture
          vctx.strokeStyle = 'rgba(90,20,140,0.6)';
          vctx.lineWidth = onePx * 0.8;
          for (let k = 0; k < 3; k++) {
            const mx = sxLeft + (sxRight - sxLeft) * ((k + 1) / 4) + Math.sin((i + 1) * (k + 3)) * (onePx * 2);
            vctx.beginPath();
            vctx.moveTo(mx, syTop - onePx);
            vctx.lineTo(mx + Math.sin((i + 1) * (k + 5)) * onePx * 2, syBottom + onePx);
            vctx.stroke();
          }
        }
      }
    } catch (e) {}

    // hovered segment highlight
    if (hoveredIndex !== null) {
      const hx = hoveredIndex * segmentLen;
      vctx.fillStyle = currentTool === Tool.ToggleGap ? 'rgba(255,165,0,0.12)' : 'rgba(255,255,0,0.08)';
      vctx.fillRect(hx, topWorld, segmentLen, viewH);
    }

    vctx.fillStyle = 'rgba(255,255,255,0.95)';
    vctx.strokeStyle = 'rgba(0,0,0,0.6)';
    // draw small handles / segment sample points
    for (let i = startX; i <= endX; i++) {
      const v = level.segments[i];
      const sx = i * segmentLen + segmentLen / 2;
      if (v === null) {
        vctx.fillStyle = 'rgba(255,0,0,0.9)';
        vctx.fillRect(sx - 2 * onePx, bottomWorld - 6 * onePx, 4 * onePx, 4 * onePx);
        vctx.fillStyle = 'rgba(255,255,255,0.95)';
      } else {
        const hy = v as number;
        vctx.beginPath();
        vctx.arc(sx, hy, 2 * onePx, 0, Math.PI * 2);
        vctx.fill();
        vctx.stroke();
      }
    }

    // draw objects
    for (let i = 0; i < (level.objects || []).length; i++) {
      const obj = level.objects[i];
      if (!obj) continue;
      if (obj.x < startX - 1 || obj.x > endX + 1) continue;
      const ox = obj.x * segmentLen;
      vctx.lineWidth = (selectedObjectIndex === i ? 2 : 1) * onePx;
      if ((obj as any).type === 'start') {
        vctx.strokeStyle = '#00ff44';
        vctx.fillStyle = '#00ff44';
        vctx.beginPath();
        vctx.moveTo(ox + halfPx, topWorld + 4);
        vctx.lineTo(ox + halfPx, bottomWorld - 4);
        vctx.stroke();
        vctx.font = '10px monospace';
        vctx.textAlign = 'center';
        vctx.fillText('S', ox + halfPx, topWorld + 14);
      } else if ((obj as any).type === 'finish') {
        vctx.strokeStyle = '#ff4d6d';
        vctx.fillStyle = '#ff4d6d';
        vctx.beginPath();
        vctx.moveTo(ox + halfPx, topWorld + 4);
        vctx.lineTo(ox + halfPx, bottomWorld - 4);
        vctx.stroke();
        vctx.font = '10px monospace';
        vctx.textAlign = 'center';
        vctx.fillText('F', ox + halfPx, topWorld + 14);
      } else if ((obj as any).type === 'wall') {
        // explicit wall object: top aligns to terrain at that x unless obj.y provided
        const oy = typeof (obj as any).y === 'number' ? (obj as any).y : (level.segments[Math.round(obj.x)] as number) || topWorld + viewH / 2;
        const widthWorld = (obj as any).width || Math.max(1, segmentLen * 0.6);
        const halfW = widthWorld / 2;
        const sxLeft = ox - halfW;
        const sxRight = ox + halfW;
        const syTop = oy;
        const syBottom = topWorld + viewH;
        vctx.fillStyle = '#6b3f1a';
        vctx.fillRect(sxLeft, syTop, sxRight - sxLeft, syBottom - syTop);
        vctx.strokeStyle = 'rgba(0,0,0,0.25)';
        vctx.lineWidth = onePx;
        vctx.strokeRect(sxLeft, syTop, sxRight - sxLeft, syBottom - syTop);
        vctx.font = '10px monospace';
        vctx.textAlign = 'center';
        vctx.fillStyle = '#ffd700';
        vctx.fillText('W', ox + halfPx, topWorld + 14);
      } else {
        vctx.strokeStyle = '#ffd700';
        vctx.fillStyle = '#ffd700';
        vctx.beginPath();
        vctx.moveTo(ox + halfPx, topWorld + 4);
        vctx.lineTo(ox + halfPx, bottomWorld - 4);
        vctx.stroke();
        vctx.font = '10px monospace';
        vctx.textAlign = 'center';
        vctx.fillText('C', ox + halfPx, topWorld + 14);
      }
      if (selectedObjectIndex === i) {
        vctx.strokeStyle = 'rgba(255,255,255,0.9)';
        vctx.strokeRect(ox - 6 * onePx, topWorld + 16, 12 * onePx, 12 * onePx);
      }
    }

    // HUD
    vctx.save();
    vctx.resetTransform();
    const hudW = vctx.canvas.width;
    const hudH = vctx.canvas.height;
    vctx.fillStyle = 'rgba(0,0,0,0.6)';
    vctx.fillRect(hudW - 180, 8, 172, 84);
    vctx.fillStyle = 'yellow';
    vctx.font = '12px monospace';
    vctx.fillText('EDITOR ON', hudW - 170, 24);
    vctx.fillStyle = '#fff';
    vctx.font = '11px monospace';
    vctx.fillText(`Tool: ${currentTool}`, hudW - 170, 40);
    const hoverVal = hoveredIndex !== null ? level.segments[hoveredIndex] : null;
    const hoverStr = hoveredIndex === null ? '-' : hoverVal === null ? 'GAP' : String(hoverVal);
    vctx.fillText(`Hover idx: ${hoveredIndex ?? '-'} seg: ${hoverStr}`, hudW - 170, 56);
    if (selectedObjectIndex !== null) {
      const so = level.objects[selectedObjectIndex];
      vctx.fillText(`Selected: ${so.type} @${so.x}`, hudW - 170, 72);
    } else {
      vctx.fillText(`Selected: -`, hudW - 170, 72);
    }
    if (statusText) {
      vctx.fillStyle = 'rgba(255,255,255,0.9)';
      vctx.fillText(statusText, hudW - 170, 88);
    }
    vctx.restore();
    vctx.restore();
  };

  // expose smoothing function on the returned stop so external UI can trigger it
  (stop as any).smoothSegments = smoothSegments;

  return stop;
}

export default { startEditor };
