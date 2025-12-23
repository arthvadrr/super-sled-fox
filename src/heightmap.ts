import { Level } from './level';

// Convert continuous x (virtual pixels) to segment index (integer)
export function xToIndex(level: Level, x: number): number {
  // Treat each segment as 1 unit wide; clamp to array bounds
  return Math.max(0, Math.min(level.segments.length - 1, Math.floor(x)));
}

// Get height at continuous x using linear interpolation between segment samples.
// Returns null if either sample is a gap (null) or if x is outside level.
export function getHeightAtX(level: Level, x: number): number | null {
  if (!level || !Array.isArray(level.segments)) return null;
  if (x < 0 || x > level.segments.length - 1) return null;

  const i0 = Math.floor(x);
  const i1 = Math.min(level.segments.length - 1, i0 + 1);
  const h0 = level.segments[i0];
  const h1 = level.segments[i1];

  if (h0 === null || h1 === null) {
    // If both indices equal and h0 non-null, return it; otherwise gap
    if (i0 === i1 && h0 !== null) return h0 as number;
    return null;
  }

  const t = x - i0;
  return (h0 as number) * (1 - t) + (h1 as number) * t;
}

// Return slope (dy/dx) at x using the discrete segment heights.
// If unavailable (gap), returns null.
export function getSlopeAtX(level: Level, x: number): number | null {
  const i0 = Math.floor(x);
  const i1 = Math.min(level.segments.length - 1, i0 + 1);
  const h0 = level.segments[i0];
  const h1 = level.segments[i1];
  if (h0 === null || h1 === null) return null;
  // since indices are 1 unit apart, slope is simply delta
  return (h1 as number) - (h0 as number);
}

// Return normal vector (unit) at x as {nx, ny} pointing 'up' from slope.
export function getNormalAtX(level: Level, x: number): { nx: number; ny: number } | null {
  const slope = getSlopeAtX(level, x);
  if (slope === null) return null;
  // surface tangent vector ~ (1, slope); normal is perpendicular (-slope, 1)
  const nx = -slope;
  const ny = 1;
  const mag = Math.hypot(nx, ny);
  if (mag === 0) return { nx: 0, ny: 1 };
  return { nx: nx / mag, ny: ny / mag };
}

export default {
  xToIndex,
  getHeightAtX,
  getSlopeAtX,
  getNormalAtX,
};
