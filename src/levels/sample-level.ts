import { Level } from '../level';

// Simple sample level: flat ground at height 120, small gap between 200-209
const SEGMENTS: (number | null)[] = [];
const TOTAL = 800;
for (let i = 0; i < TOTAL; i++) {
  if (i >= 200 && i < 210) {
    SEGMENTS.push(null); // gap
  } else {
    SEGMENTS.push(120); // constant height
  }
}

export const sampleLevel: Level = {
  version: 1,
  meta: {
    title: 'Sample Level 1',
    author: 'auto',
    width: SEGMENTS.length,
    // simple parallax layer config (paths are relative to /assets/)
    parallax: [
      { src: 'parallax/sky.svg', factor: 0.05, y: 0, tile: true, alpha: 1 },
      { src: 'parallax/mountains.svg', factor: 0.18, y: 18, tile: true, alpha: 1 },
      { src: 'parallax/mid.svg', factor: 0.35, y: 42, tile: true, alpha: 1 },
      { src: 'parallax/fg.svg', factor: 0.7, y: 80, tile: true, alpha: 1 },
    ],
  } as any,
  segments: SEGMENTS,
  objects: [
    { type: 'start', x: 40 },
    { type: 'checkpoint', x: 400 },
    { type: 'finish', x: 760 },
  ],
};

export default sampleLevel;
