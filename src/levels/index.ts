import sampleLevel from './sample-level';
import level01 from './level_01.json';
import level02 from './level_02.json';
import type { Level } from '../level';

export type LevelPackEntry = {
  id: string;
  name: string;
  level: Level;
  assets?: {
    music?: string;
    ambience?: string;
    bg?: string;
    fg?: string;
    sfxSet?: string;
  };
};

// For now we expose the single sample level as the first pack entry.
export const LEVELS: LevelPackEntry[] = [
  {
    id: 'level-01',
    name: (level01 as any).meta?.title || 'Level 01',
    level: level01 as Level,
    assets: {},
  },
  {
    id: 'level-02',
    name: (level02 as any).meta?.title || 'Level 02',
    level: level02 as Level,
    assets: {},
  },
];

export function getLevelById(id: string) {
  return LEVELS.find((p) => p.id === id) || null;
}

export default { LEVELS, getLevelById };
