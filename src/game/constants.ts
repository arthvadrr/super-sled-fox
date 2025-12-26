export const VIRTUAL_WIDTH = 400;
export const VIRTUAL_HEIGHT = 225;

export const PHYS_CONSTANTS = {
  SLOPE_DOWN_SCALE: 0.8,
  SLOPE_UP_SCALE: 0.8,
  MAX_SLOPE: 2, // max slope (dy/dx) that affects speed
  MOTOR_K: 6, // motor torque constant
  MOTOR_MAX: 250,
  FEET_OFFSET: 8,
  HALF_WIDTH: 8,
};

export const CAMERA_SETTINGS = {
  LOOK_AHEAD_MULT: 0.5,
  MAX_LOOK_AHEAD: 60,
  SMOOTH: 8,
  HORIZONTAL_BIAS: 90,
};

export const RENDER_SETTINGS = {
  PIXEL_SNAP: true,
  PADDING: 8,
};

export const JUMP_SETTINGS = {
  COYOTE_TIME: 0.12,
  BUFFER_TIME: 0.12,
  HOLD_GRAVITY_FACTOR: 0.45,
};

export const EDITOR_SETTINGS = {
  ZOOM_MIN: 0.5,
  ZOOM_MAX: 3.0,
};

export const FIXED_DT = 1 / 60;

// Gameplay camera zoom (used when not in editor). <1 = zoomed out, >1 = zoomed in.
export const GAMEPLAY_ZOOM = 0.8;

// Dynamic camera zoom tuning: target zoom is computed from player speed and
// smoothly interpolated toward the target each simulation step.
export const CAMERA_ZOOM = {
  BASE: GAMEPLAY_ZOOM,
  MIN: 0.4,
  MAX: 10.0,
  // multiplier that maps |vx| -> zoom delta: zoom = BASE - |vx| * SPEED_TO_ZOOM
  // tuned so typical speeds produce a subtle but visible zoom-out.
  SPEED_TO_ZOOM: 0.0008,
  // smoothing factor (higher = faster interpolation)
  SMOOTH: 8,
};
