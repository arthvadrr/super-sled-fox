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
  FRICTION: 2,
  BASE_CRUISE_SPEED: 200, // px/s
  // Significantly raise max speed; soft-cap starts earlier relative to max so
  // it's progressively harder to reach absolute max.
  MAX_SPEED: 40000,
  SOFT_CAP_START: 16000,
  JUMP_IMPULSE: 300,
  JUMP_HOLD_TIME: 0.12,
  // Manual forward thrust when player holds the forward key (px/s^2)
  FORWARD_THRUST: 30,
  // Deceleration applied when the player holds the brake key (px/s^2)
  // Lowered to preserve "ice" feel (gentler braking).
  BRAKE_DECEL: 300,
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
