export interface Player {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  grounded: boolean;
  wasGrounded: boolean;
  invulnTimer: number;
}

export const PLAYER_DEFAULTS = {
  startX: 40,
  startY: 50,
};

export const PHYS = {
  GRAVITY: 900, // px/s^2 in virtual pixels
  FRICTION: 8,
  BASE_CRUISE_SPEED: 80, // px/s
  MAX_SPEED: 300,
  SOFT_CAP_START: 160,
  JUMP_IMPULSE: 300,
  JUMP_HOLD_TIME: 0.12,
};

export function createPlayer(x = PLAYER_DEFAULTS.startX): Player {
  return {
    x,
    y: PLAYER_DEFAULTS.startY,
    vx: PHYS.BASE_CRUISE_SPEED,
    vy: 0,
    angle: 0,
    grounded: false,
    wasGrounded: false,
    invulnTimer: 0,
  };
}

export default {
  Player: null as any,
};
