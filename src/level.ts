export type Segment = number | null; // null represents a gap

export type ObjType = 'start' | 'checkpoint' | 'finish' | 'sign';

export interface LevelObject {
  type: ObjType;
  x: number; // position in segment-space (index)
  // optional sign message (for `sign` type): up to 3 lines of up to 10 chars
  message?: string[];
}

export interface LevelMeta {
  title: string;
  author?: string;
  // recommended logical width in virtual pixels (can be segments.length)
  width?: number;
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
    if (!['start', 'checkpoint', 'finish', 'sign'].includes(o.type)) return { ok: false, reason: 'invalid object type' };
    if (o.type === 'sign') {
      const msg = (o as any).message;
      if (msg !== undefined) {
        if (!Array.isArray(msg) || msg.length > 3) return { ok: false, reason: 'invalid sign message' };
        for (const line of msg) {
          if (typeof line !== 'string' || line.length > 10) return { ok: false, reason: 'invalid sign message line' };
        }
      }
    }
  }
  return { ok: true };
}

export default Level;
