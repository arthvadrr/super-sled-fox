export type Segment = number | null; // null represents a gap

export type ObjType = 'start' | 'checkpoint' | 'finish' | 'wall' | 'hazard' | 'decor' | 'collider';

export interface LevelObject {
  type: ObjType;
  x: number; // position in segment-space (index)
  // optional text/message for objects that support it (deprecated `sign` removed)
  message?: string[];
  // optional y (world Y) for objects that specify vertical placement
  y?: number;
  // optional width (world units) for `wall` objects
  width?: number;
  // optional radius for circular hazards
  radius?: number;
  // optional source (for `decor`): image path or data-URL
  src?: string;
  // optional scale for `decor`
  scale?: number;
  // optional layer: 0 = behind ground, 1 = front (default 1)
  layer?: number;
}

export interface LevelMeta {
  title: string;
  author?: string;
  // recommended logical width in virtual pixels (can be segments.length)
  width?: number;
  // virtual canvas height for this level
  virtualHeight?: number;
  // segment logical length in world units (editor tuning)
  segmentLen?: number;
  // arbitrary asset list (images/audio) referenced by the level
  assets?: string[];
  // optional avalanche speed in world units per second; 0 or missing = disabled
  avalancheSpeed?: number;
}

export interface Level {
  version: number;
  meta: LevelMeta;
  segments: Segment[];
  objects: LevelObject[];
}

export function validateLevel(l: Level): { ok: true } | { ok: false; reason: string } {
  if (!l || typeof l !== 'object') return { ok: false, reason: 'not an object' };
  if (l.version !== 1) return { ok: false, reason: 'unsupported version' };
  if (!Array.isArray(l.segments) || l.segments.length === 0) return { ok: false, reason: 'segments missing' };
  const width = l.segments.length;
  for (const o of l.objects || []) {
    if (typeof o.x !== 'number' || o.x < 0 || o.x >= width) return { ok: false, reason: 'object out of bounds' };
    if (!['start', 'checkpoint', 'finish', 'wall', 'hazard', 'decor', 'collider'].includes(o.type)) return { ok: false, reason: 'invalid object type' };
    if (o.type === 'wall') {
      const w = (o as any).width;
      if (w !== undefined) {
        if (typeof w !== 'number' || !isFinite(w) || w <= 0) return { ok: false, reason: 'invalid wall width' };
      }
      const y = (o as any).y;
      if (y !== undefined) {
        if (typeof y !== 'number' || !isFinite(y)) return { ok: false, reason: 'invalid wall y' };
      }
    } else if (o.type === 'hazard') {
      const r = (o as any).radius;
      if (r !== undefined) {
        if (typeof r !== 'number' || !isFinite(r) || r <= 0) return { ok: false, reason: 'invalid hazard radius' };
      }
    } else if (o.type === 'collider') {
      const w = (o as any).width;
      const h = (o as any).height;
      if (w !== undefined) {
        if (typeof w !== 'number' || !isFinite(w) || w <= 0) return { ok: false, reason: 'invalid collider width' };
      }
      if (h !== undefined) {
        if (typeof h !== 'number' || !isFinite(h) || h <= 0) return { ok: false, reason: 'invalid collider height' };
      } else if (o.type === 'decor') {
        const s = (o as any).src;
        if (s !== undefined) {
          if (typeof s !== 'string') return { ok: false, reason: 'invalid decor src' };
        }
        const sc = (o as any).scale;
        if (sc !== undefined) {
          if (typeof sc !== 'number' || !isFinite(sc) || sc <= 0) return { ok: false, reason: 'invalid decor scale' };
        }
        const y = (o as any).y;
        if (y !== undefined) {
          if (typeof y !== 'number' || !isFinite(y)) return { ok: false, reason: 'invalid decor y' };
        }
        const layer = (o as any).layer;
        if (layer !== undefined) {
          if (typeof layer !== 'number' || !isFinite(layer)) return { ok: false, reason: 'invalid decor layer' };
        }
      }
    }
  }
  // validate optional meta avalanche speed
  if (l.meta && (l.meta as any).avalancheSpeed !== undefined) {
    const s = (l.meta as any).avalancheSpeed;
    if (typeof s !== 'number' || !isFinite(s) || s < 0) return { ok: false, reason: 'invalid avalancheSpeed' };
  }
  // validate optional meta fields
  if (l.meta) {
    const mv = (l.meta as any).virtualHeight;
    if (mv !== undefined) {
      if (typeof mv !== 'number' || !isFinite(mv) || mv < 0) return { ok: false, reason: 'invalid virtualHeight' };
    }
    const sl = (l.meta as any).segmentLen;
    if (sl !== undefined) {
      if (typeof sl !== 'number' || !isFinite(sl) || sl <= 0) return { ok: false, reason: 'invalid segmentLen' };
    }
    const assets = (l.meta as any).assets;
    if (assets !== undefined) {
      if (!Array.isArray(assets) || assets.some((a) => typeof a !== 'string')) return { ok: false, reason: 'invalid assets list' };
    }
  }
  return { ok: true };
}

export default Level;
