import { PHYS_CONSTANTS, JUMP_SETTINGS, FIXED_DT, VIRTUAL_HEIGHT } from './constants';
import { GameContext } from './types';
import { getHeightAtX, getSlopeAtX } from '../heightmap';
import { PHYS, PLAYER_DEFAULTS } from '../player';
import { InputManager } from '../input';

const { SLOPE_DOWN_SCALE, SLOPE_UP_SCALE, MAX_SLOPE, MOTOR_K, MOTOR_MAX, HALF_WIDTH } = PHYS_CONSTANTS;
const { COYOTE_TIME, BUFFER_TIME, HOLD_GRAVITY_FACTOR } = JUMP_SETTINGS;

export function simulate(ctx: GameContext, dt: number, input: InputManager) {
  const { currPlayer, currentLevel } = ctx;

  // Log input state changes for 'a' and ArrowLeft to debug missing logs.
  try {
    const aDown = input.get('a').isDown;
    const leftDown = input.get('ArrowLeft').isDown;
    const dDown = input.get('d').isDown;
    const rightDown = input.get('ArrowRight').isDown;
    const prev = (window as any).__lastKeyDownStates || { a: false, left: false, d: false, right: false };
    if (aDown !== prev.a || leftDown !== prev.left || dDown !== prev.d || rightDown !== prev.right) {
      (window as any).__lastKeyDownStates = { a: aDown, left: leftDown, d: dDown, right: rightDown };
    }
  } catch (e) {}

  // two-point ground contact positions
  const backX = currPlayer.x - HALF_WIDTH;
  const frontX = currPlayer.x + HALF_WIDTH;

  // timers
  ctx.coyoteTimer = Math.max(0, ctx.coyoteTimer - dt);
  ctx.jumpBuffer = Math.max(0, ctx.jumpBuffer - dt);
  ctx.jumpHold = Math.max(0, ctx.jumpHold - dt);
  ctx.jumpAppliedThisFrame = false;

  // boost/stamina: decrement refill-block timer if present
  ctx.boostRefillBlockedTimer = Math.max(0, (ctx.boostRefillBlockedTimer || 0) - dt);

  // boost UI timers: blink when locked, and full-visible timer
  try {
    if (ctx.boostLocked) {
      ctx.boostBlinkTimer = (ctx.boostBlinkTimer || 0) + dt;
      const BLINK_PERIOD = 0.6;
      if (ctx.boostBlinkTimer >= BLINK_PERIOD) {
        ctx.boostBlinkTimer -= BLINK_PERIOD;
        ctx.boostBlinkOn = !ctx.boostBlinkOn;
      }
    }
    ctx.boostFullVisibleTimer = Math.max(0, (ctx.boostFullVisibleTimer || 0) - dt);
  } catch (e) {}

  // decrement invulnerability timer
  currPlayer.invulnTimer = Math.max(0, (currPlayer.invulnTimer || 0) - dt);

  // distance from player's origin to feet (must match renderer/respawn)
  const FEET_OFFSET = 8;

  // Helper: when a non-avalanche crash occurs, decide whether to force a
  // full-level restart (if no checkpoint or avalanche passed the last
  // checkpoint) or save the avalanche position so it can resume after
  // respawning at the checkpoint.
  const handleAvalancheOnCrash = (ctxLocal: GameContext) => {
    try {
      if (typeof ctxLocal.avalancheX === 'number') {
        const startX = ctxLocal.lastCheckpointX ?? PLAYER_DEFAULTS.startX;
        const hadCheckpoint = (ctxLocal.lastCheckpointX ?? PLAYER_DEFAULTS.startX) > PLAYER_DEFAULTS.startX;
        if (!hadCheckpoint) {
          ctxLocal.forceFullRestart = true;
        } else if ((ctxLocal.avalancheX || 0) > (ctxLocal.lastCheckpointX || PLAYER_DEFAULTS.startX)) {
          // avalanche is past the player's checkpoint — force full restart
          ctxLocal.forceFullRestart = true;
        } else {
          // save avalanche position/speed so it can be restored after respawn
          ctxLocal.savedAvalancheX = ctxLocal.avalancheX;
          if (typeof ctxLocal.avalancheSpeed === 'number') ctxLocal.savedAvalancheSpeed = ctxLocal.avalancheSpeed;
        }
      }
    } catch (e) {}

    // (was exposing boosting here, but `boosting` isn't in scope)
  };

  // decay jump lock
  ctx.jumpLock = Math.max(0, ctx.jumpLock - dt);
  const hb = getHeightAtX(currentLevel as any, backX);
  const hf = getHeightAtX(currentLevel as any, frontX);

  currPlayer.wasGrounded = currPlayer.grounded;

  // Determine whether we're grounded: require both contact samples exist AND
  // that the player was already grounded or is physically near the contact height.
  let avgY: number | null = null;
  const contactExists = hb !== null && hf !== null;
  if (contactExists) {
    avgY = (hb + hf) / 2;
  }

  const NEAR_GROUND_THRESHOLD = 6; // pixels
  const nearGround = avgY !== null && currPlayer.y >= avgY - NEAR_GROUND_THRESHOLD;

  // update persistent last-contact diagnostics so main loop can report them
  ctx.lastContactBack = hb;
  ctx.lastContactFront = hf;
  ctx.lastContactAvg = avgY;
  ctx.lastNearGround = !!nearGround;

  if (contactExists && (currPlayer.wasGrounded || nearGround) && ctx.jumpLock <= 0) {
    // grounded: snap to contact average, reset vertical velocity and set angle
    if (!currPlayer.grounded) {
    }
    // preserve previous vertical velocity so we can emit landing effects
    const prevVy = currPlayer.vy;
    currPlayer.y = avgY! - FEET_OFFSET;
    currPlayer.vy = 0;
    currPlayer.grounded = true;
    currPlayer.angle = Math.atan2((hf as number) - (hb as number), frontX - backX);
    // Refresh coyote time while grounded so buffered jumps can fire.
    ctx.coyoteTimer = COYOTE_TIME;

    // input speed modifiers and braking — read input early so we can respect braking intent
    const forward = input.get('ArrowRight').isDown || input.get('d').isDown || input.get('w').isDown;
    const back = input.get('ArrowLeft').isDown || input.get('a').isDown || input.get('s').isDown;
    const boostAvailable = (typeof ctx.boostStamina === 'number' ? ctx.boostStamina : 1) > 0 && !ctx.boostLocked;
    let boosting = forward && !back && boostAvailable;
    let speedMul = 1.0;
    if (boosting) speedMul = 1.5;
    else if (back) speedMul = 0.5;
    try {
      ctx.isBoosting = !!boosting;
    } catch (e) {}
    const targetSpeed = PHYS.BASE_CRUISE_SPEED * speedMul;

    // grounded motion: acceleration along slope from gravity projection
    const slope = getSlopeAtX(currentLevel as any, currPlayer.x) ?? Math.tan(currPlayer.angle);
    ctx.lastSlope = slope;
    const slopeEff = Math.max(-MAX_SLOPE, Math.min(MAX_SLOPE, slope));
    ctx.lastSlopeEff = slopeEff;
    const accelRaw = (PHYS.GRAVITY * slopeEff) / Math.sqrt(1 + slopeEff * slopeEff);
    // use different scales for downhill vs uphill: when accelRaw is positive use downhill scale
    const scale = accelRaw >= 0 ? SLOPE_DOWN_SCALE : SLOPE_UP_SCALE;
    let accelScaled = accelRaw * scale;
    // If player is actively holding 'back' (braking), prevent slope from accelerating them forward.
    if (back && accelScaled > 0) accelScaled = 0;
    ctx.lastAccelRaw = accelRaw;
    ctx.lastAccelScaled = accelScaled;
    // forward motor assist (grounded only)
    let motorAccel = 0;
    if (forward && !back) {
      motorAccel = Math.max(0, Math.min(MOTOR_MAX, (targetSpeed - currPlayer.vx) * MOTOR_K));
      try {
        const now = performance.now();
        const lastFwdLog = (window as any).__lastFwdAssistLog || 0;
        if (now - lastFwdLog > 250) {
          (window as any).__lastFwdAssistLog = now;
        }
      } catch (e) {}
    }

    // apply slope gravity (scaled)
    const preVx = currPlayer.vx;
    currPlayer.vx += accelScaled * dt;
    // apply motor assist but do not exceed targetSpeed
    if (motorAccel > 0) {
      const maxDelta = Math.max(0, targetSpeed - currPlayer.vx);
      const applied = Math.min(motorAccel * dt, maxDelta);
      currPlayer.vx += applied;
      try {
        if (applied <= 0 && targetSpeed > currPlayer.vx + 0.001) {
        }
      } catch (e) {}
    }

    // If forward is held, provide a modest manual thrust only when the player
    // is below the target plus a small hysteresis. This prevents small continuous
    // thrusts when downhill carries the player above target speed and avoids
    // oscillation between nearby slopes.
    if (forward && !back && currPlayer.vx < targetSpeed + 40) {
      const thrust = PHYS.FORWARD_THRUST * dt;
      currPlayer.vx += thrust;
      try {
        const now = performance.now();
        const last = (window as any).__lastFwdThrustLog || 0;
        if (now - last > 250) {
          (window as any).__lastFwdThrustLog = now;
        }
      } catch (e) {}
    }

    // Boost/stamina handling while player is holding the forward key.
    // Deplete fully in ~4s while held; refill at ~8s when not held. If emptied,
    // start a refill-block timer (4s) before automatic refill begins.
    try {
      const STAMINA_DEPLETION_RATE = 1 / 2; // per second (3s to deplete)
      const STAMINA_REFILL_RATE = 1 / 2; // per second (9s to refill)
      const STAMINA_REFILL_DELAY_AFTER_EMPTY = 2; // seconds delay when emptied (reduced)
      if (typeof ctx.boostStamina !== 'number') ctx.boostStamina = 1;
      if (forward && !back && boostAvailable) {
        // consuming stamina while boosting
        if (ctx.boostStamina > 0) {
          ctx.boostStamina = Math.max(0, ctx.boostStamina - STAMINA_DEPLETION_RATE * dt);
          if (ctx.boostStamina === 0) {
            ctx.boostRefillBlockedTimer = STAMINA_REFILL_DELAY_AFTER_EMPTY;
            ctx.boostLocked = true; // lock boosting until fully refilled
            boosting = false;
          }
        }
      } else {
        // refill when not boosting and refill delay expired
        if ((ctx.boostRefillBlockedTimer || 0) <= 0) {
          const prev = ctx.boostStamina;
          ctx.boostStamina = Math.min(1, ctx.boostStamina + STAMINA_REFILL_RATE * dt);
          // if we were locked and have now reached full, unlock and show full for 1s
          if (ctx.boostLocked && ctx.boostStamina >= 1) {
            ctx.boostLocked = false;
            ctx.boostFullVisibleTimer = 1.0;
            ctx.boostBlinkTimer = 0;
            ctx.boostBlinkOn = false;
          }
        }
      }
    } catch (e) {}

    // Debugging/logging for 'a' press runaway: throttle logs to avoid spam.
    try {
      const aDown = input.get('a').isDown;
      const postVx = currPlayer.vx;
      const deltaV = postVx - preVx;
      const now = performance.now();
      const last = (window as any).__lastInsaneALogTime || 0;
      const shouldLog = aDown && (deltaV > 20 || postVx > 2000);
      if (shouldLog && now - last > 1000) {
        (window as any).__lastInsaneALogTime = now;
      }
    } catch (e) {}

    // braking: when back is held, reduce speed magnitude toward zero (never reverse direction)
    if (back) {
      const brakeDecel = PHYS.BRAKE_DECEL || 1200;
      if (currPlayer.vx > 0) {
        currPlayer.vx = Math.max(0, currPlayer.vx - brakeDecel * dt);
      } else if (currPlayer.vx < 0) {
        currPlayer.vx = Math.min(0, currPlayer.vx + brakeDecel * dt);
      }
    } else {
      // accelerate toward target smoothly
      const accel = 120; // px/s^2 accel toward target (reduced for gentler acceleration)
      const delta = targetSpeed - currPlayer.vx;
      const change = Math.sign(delta) * Math.min(Math.abs(delta), accel * dt);
      currPlayer.vx += change;
    }

    // simple friction along ground. Reduce friction after downhill boosts
    // so momentum gained from going downhill mostly carries across level ground.
    const downhillPreserveFactor = 0.12; // keep most downhill speed
    const baseFrictionFactor = slopeEff > 0 ? downhillPreserveFactor : 0.5;
    const frictionAcc = PHYS.FRICTION * baseFrictionFactor;
    if (currPlayer.vx > 0) {
      currPlayer.vx = Math.max(0, currPlayer.vx - frictionAcc * dt);
    } else {
      currPlayer.vx = Math.min(0, currPlayer.vx + frictionAcc * dt);
    }

    // Velocity deadzone: when the player is grounded and moving very slowly
    // (and not actively holding forward/back), snap to zero to avoid small
    // oscillations between nearby slopes.
    const DEADZONE_V = 10; // px/s
    if (currPlayer.grounded && Math.abs(currPlayer.vx) < DEADZONE_V && !forward && !back && Math.abs(slopeEff) < 0.25) {
      currPlayer.vx = 0;
    }

    // Soft cap: progressively resist further acceleration as speed rises above SOFT_CAP_START.
    if (currPlayer.vx > PHYS.SOFT_CAP_START) {
      const over = currPlayer.vx - PHYS.SOFT_CAP_START;
      const denom = Math.max(1, PHYS.MAX_SPEED - PHYS.SOFT_CAP_START);
      const frac = Math.min(1, over / denom);
      // Quadratic ramp: resistance grows with square of fraction (tunable coefficient).
      const DRAG_COEFF = 4.0; // higher = harder to reach max
      const resist = DRAG_COEFF * frac * frac * currPlayer.vx;
      currPlayer.vx = Math.max(PHYS.SOFT_CAP_START, currPlayer.vx - resist * dt);
    }
    // Absolute clamp to avoid runaway from numerical issues
    currPlayer.vx = Math.min(PHYS.MAX_SPEED, currPlayer.vx);

    // Emit snow/speed particles when player is actively braking or boosting.
    try {
      if (ctx.effects && typeof ctx.effects.onSpeed === 'function') {
        const now = performance.now();
        const last = (window as any).__lastSpeedEmitTime || 0;
        // throttle particle emission to avoid spam (every ~100ms)
        if (now - last > 90) {
          (window as any).__lastSpeedEmitTime = now;
          const feetY = currPlayer.y + FEET_OFFSET; // emit from feet/front
          // determine front X based on current movement direction (front of player)
          const frontX = currPlayer.x + (currPlayer.vx >= 0 ? HALF_WIDTH : -HALF_WIDTH);
          const moving = Math.abs(currPlayer.vx) > 8;
          if (moving) {
            if (forward && !back) {
              ctx.effects.onSpeed(frontX, feetY, currPlayer.vx);
              try {
                if (boosting) ctx.effects.onBoost(backX, feetY, currPlayer.vx);
              } catch (e) {}
            } else if (back) {
              ctx.effects.onSpeed(frontX, feetY, currPlayer.vx);
            }
          }
        }
      }
    } catch (e) {}
  } else {
    // airborne
    if (currPlayer.grounded) {
      // Start coyote time when we step off the ground.
      ctx.coyoteTimer = COYOTE_TIME;
    }
    currPlayer.grounded = false;
    ctx.lastGroundY = null;

    // airborne physics: gravity and horizontal air friction
    let gravity = PHYS.GRAVITY;
    // holding jump reduces gravity for higher jumps
    if (ctx.jumpHold > 0 && (input.get(' ').isDown || input.get('w').isDown || input.get('ArrowUp').isDown)) {
      gravity *= HOLD_GRAVITY_FACTOR;
    }
    currPlayer.vy += gravity * dt;
    // horizontal air friction (lower than ground)
    currPlayer.vx -= currPlayer.vx * PHYS.FRICTION * 0.2 * dt;

    // angle should level out toward 0 in air
    currPlayer.angle *= 1.0 - 2.0 * dt;
    // Allow stamina refill while airborne when not holding forward
    try {
      const forwardAir = input.get('ArrowRight').isDown || input.get('d').isDown || input.get('w').isDown;
      if (typeof ctx.boostStamina !== 'number') ctx.boostStamina = 1;
      if (!forwardAir && (ctx.boostRefillBlockedTimer || 0) <= 0) {
        const STAMINA_REFILL_RATE = 1 / 9;
        ctx.boostStamina = Math.min(1, ctx.boostStamina + STAMINA_REFILL_RATE * dt);
      }
    } catch (e) {}
  }

  // Jump logic
  const jumpPressed = input.get(' ').wasPressed || input.get('w').wasPressed || input.get('ArrowUp').wasPressed;
  if (jumpPressed || ctx.pendingImmediateJump) {
    ctx.jumpBuffer = BUFFER_TIME;
    if (ctx.pendingImmediateJump) {
      ctx.pendingImmediateJump = false;
    }
  }

  if (ctx.jumpBuffer > 0 && ctx.coyoteTimer > 0 && ctx.jumpLock <= 0) {
    currPlayer.vy = -PHYS.JUMP_IMPULSE;
    currPlayer.grounded = false;
    ctx.coyoteTimer = 0;
    ctx.jumpBuffer = 0;
    ctx.jumpHold = PHYS.JUMP_HOLD_TIME;
    ctx.jumpLock = 0.1; // prevent immediate re-grounding
    ctx.jumpAppliedThisFrame = true;
    void ctx.sfxJump?.play?.();
    ctx.effects.shake.shake(2);
  }

  // integration
  currPlayer.x += currPlayer.vx * dt;
  currPlayer.y += currPlayer.vy * dt;

  // Gap-edge wall collision: must run while airborne too.
  // Use a SWEPT test (prev -> curr) so we don't miss impacts when the player crosses the wall plane in one frame.
  try {
    if (!ctx.reachedFinish && ctx.state !== 'dead') {
      const segs = (currentLevel && currentLevel.segments) || [];
      const levelBottom = (currentLevel && (currentLevel.meta as any)?.virtualHeight) || (globalThis as any).VIRTUAL_HEIGHT || 225;
      const FEET_OFFSET_LOCAL = FEET_OFFSET;
      const PLAYER_BODY_H = 18;
      const wallHalf = 0.6;
      const crashTolerance = 6;

      // Previous position BEFORE integration this frame.
      const prevX = currPlayer.x - currPlayer.vx * dt;
      const prevY = currPlayer.y - currPlayer.vy * dt;

      // Player AABB helpers.
      const pAabbAt = (x: number, y: number) => {
        const left = x - HALF_WIDTH;
        const right = x + HALF_WIDTH;
        const bottom = y + FEET_OFFSET_LOCAL;
        const top = bottom - PLAYER_BODY_H;
        return { left, right, top, bottom };
      };

      const prevBox = pAabbAt(prevX, prevY);
      const currBox = pAabbAt(currPlayer.x, currPlayer.y);

      // Consider nearby edges around current position.
      const ix = Math.floor(currPlayer.x);
      for (let di = -3; di <= 3; di++) {
        const i = ix + di;
        if (i < 0 || i >= segs.length - 1) continue;
        const leftSeg = segs[i];
        const rightSeg = segs[i + 1];
        const gapOnLeft = leftSeg === null && rightSeg !== null;
        const gapOnRight = leftSeg !== null && rightSeg === null;
        if (!gapOnLeft && !gapOnRight) continue;

        const edgeX = i + 1;
        const solidH = gapOnLeft ? (rightSeg as number) : (leftSeg as number);

        // Wall AABB: vertical face at edgeX, from solid surface downwards.
        const wLeft = edgeX - wallHalf;
        const wRight = edgeX + wallHalf;
        const wTop = solidH;
        const wBottom = levelBottom;

        // Only crash when the player's FEET are at/near/below the solid surface height.
        // Also crash immediately when descending (vy >= 0) and we hit the wall face.
        const feetOk = currBox.bottom >= wTop - crashTolerance;
        const descending = currPlayer.vy >= 0;

        // SWEPT horizontal face hit:
        // - If the gap is on the LEFT, the player can hit the wall from the left side while moving RIGHT.
        //   Detect crossing of the wall's LEFT plane (wLeft) by the player's RIGHT side.
        // - If the gap is on the RIGHT, the player can hit the wall from the right side while moving LEFT.
        //   Detect crossing of the wall's RIGHT plane (wRight) by the player's LEFT side.
        let crossed = false;
        if (gapOnLeft) {
          const movedRight = currPlayer.x >= prevX - 0.0001;
          // Crossed into the wall face this frame (or is already overlapping it).
          crossed = (movedRight && prevBox.right <= wLeft && currBox.right >= wLeft) || (movedRight && currBox.right > wLeft && currBox.left < wRight);
        } else if (gapOnRight) {
          const movedLeft = currPlayer.x <= prevX + 0.0001;
          crossed = (movedLeft && prevBox.left >= wRight && currBox.left <= wRight) || (movedLeft && currBox.right > wLeft && currBox.left < wRight);
        }

        if (!crossed) continue;

        // Vertical overlap with the wall span.
        const verticalOverlap = currBox.bottom > wTop && currBox.top < wBottom;
        if (!verticalOverlap) continue;

        if (descending || feetOk) {
          // handle avalanche interaction with this crash
          try {
            handleAvalancheOnCrash(ctx);
          } catch (e) {}
          ctx.state = 'dead';
          ctx.crashFade = 0.6;
          ctx.crashTimer = 0.9;
          ctx.crashFlash = 0.6;
          try {
            void ctx.sfxDeath?.play?.();
          } catch (e) {}
          try {
            ctx.effects.shake.shake(10);
          } catch (e) {}
          try {
            ctx.effects.onCrash(currPlayer.x, currPlayer.y + FEET_OFFSET_LOCAL, currPlayer.vx, currPlayer.vy);
          } catch (e) {}
          try {
            // hide the player sprite so only explosion is visible
            ctx.playerEntity = null;
          } catch (e) {}
          break;
        }
      }
    }
  } catch (e) {}

  // Global high-velocity watchdog: log input + context when vx becomes very large.
  try {
    const HV_THRESH = 1000;
    const now = performance.now();
    const last = (window as any).__lastHighVxLogTime || 0;
    if (currPlayer.vx > HV_THRESH && now - last > 500) {
      (window as any).__lastHighVxLogTime = now;
    }
  } catch (e) {}
  // landing detection (if we were airborne and now we are grounded or cross the ground)
  if (!currPlayer.wasGrounded) {
    const h = getHeightAtX(currentLevel as any, currPlayer.x);
    const FEET_OFFSET = 8;
    if (h !== null && currPlayer.y >= h - FEET_OFFSET && currPlayer.vy >= 0 && ctx.jumpLock <= 0) {
      if (currPlayer.vy > 180) {
        ctx.landingFlash = 0.15;
        ctx.effects.shake.shake(Math.min(6, currPlayer.vy / 60));
        void ctx.sfxLand?.play?.();
        // emit landing particles at the player's feet
        try {
          ctx.effects.onLand(currPlayer.x, h - FEET_OFFSET, currPlayer.vy);
        } catch (e) {}
      }
      currPlayer.y = h - FEET_OFFSET;
      currPlayer.vy = 0;
      currPlayer.grounded = true;
    }
  }

  // Gap-edge wall detection: check nearby segment boundaries where one side is a gap
  // NOTE: Disabled. Wall collisions are handled in the deterministic AABB block above.
  if (false) {
    try {
      const segs = (currentLevel && currentLevel.segments) || [];
      const ix = Math.floor(currPlayer.x);
      for (let di = -1; di <= 1; di++) {
        const i = ix + di;
        if (i < 0 || i >= segs.length - 1) continue;
        const left = segs[i];
        const right = segs[i + 1];
        if ((left === null && right !== null) || (left !== null && right === null)) {
          const edgeX = i + 1; // boundary between segments i and i+1
          const dx = currPlayer.x - edgeX;
          const within = Math.abs(dx) < 1.2; // slightly larger detection window
          const movingInto = (dx > 0 && currPlayer.vx < -10) || (dx < 0 && currPlayer.vx > 10);
          if (within && movingInto && !ctx.reachedFinish && ctx.state !== 'dead') {
            // Determine solid surface height on the boundary
            const solidH = left === null ? (right as number) : (left as number);
            const playerFeetY = currPlayer.y + 8; // match FEET_OFFSET used for grounding
            // Debug log for gap-edge detection
            try {
              const now = performance.now();
              const last = (window as any).__lastGapWallLog || 0;
              if (now - last > 150) {
                (window as any).__lastGapWallLog = now;
                // suppressed debug log
              }
            } catch (e) {}

            // If feet are at/below the solid surface, this is a fatal impact.
            if (playerFeetY >= solidH - 6) {
              try {
                handleAvalancheOnCrash(ctx);
              } catch (e) {}
              ctx.state = 'dead';
              ctx.crashFade = 0.6;
              ctx.crashTimer = 0.9;
              ctx.crashFlash = 0.6;
              try {
                void ctx.sfxDeath?.play?.();
              } catch (e) {}
              try {
                ctx.effects.shake.shake(10);
              } catch (e) {}
              try {
                ctx.effects.onCrash(currPlayer.x, playerFeetY, currPlayer.vx, currPlayer.vy);
              } catch (e) {}
              try {
                ctx.playerEntity = null;
              } catch (e) {}
              break;
            }

            // Otherwise, the player has hit the vertical face above the ground.
            // In that case we should block horizontal movement and prevent the
            // physics from 'magically' climbing the player up onto the slope.
            // Nudge the player out of the wall and zero horizontal velocity.
            try {
              const edgeX = i + 1;
              // If moving right into a left-side wall
              if (dx < 0 && currPlayer.vx > 20) {
                currPlayer.x = edgeX - HALF_WIDTH - 0.01;
              }
              // If moving left into a right-side wall
              if (dx > 0 && currPlayer.vx < -20) {
                currPlayer.x = edgeX + HALF_WIDTH + 0.01;
              }
              currPlayer.vx = 0;
              // keep the player airborne so they don't immediately snap to terrain
              currPlayer.grounded = false;
              // small jump-lock to avoid instant re-grounding due to residual sampling
              ctx.jumpLock = Math.max(ctx.jumpLock, 0.06);
            } catch (e) {}
          }
        }
      }
    } catch (e) {}
  }

  // hazard detection (objects in level)
  const objects = currentLevel.objects || [];
  for (const obj of objects) {
    const ox = obj.x ?? 0;
    // objects may omit a `y` field; use terrain height at the object's x as a sensible default
    const oy = typeof obj.y === 'number' ? obj.y : (getHeightAtX(currentLevel as any, Math.round(ox)) ?? currPlayer.y);
    const dx = currPlayer.x - ox;
    const dy = currPlayer.y - oy;
    const distSq = dx * dx + dy * dy;
    const radius = obj.radius || 12;
    let collided = false;

    // Allow finish to trigger when the player crosses the object's X coordinate
    // during this frame (swept X test) so jumping directly over the finish
    // will still register as completing the level.
    const prevX = currPlayer.x - currPlayer.vx * dt;
    const crossedX = (prevX <= ox && currPlayer.x >= ox) || (prevX >= ox && currPlayer.x <= ox);

    if (obj.type === 'collider') {
      // rectangular collider: use width/height (world units) centered at obj.x/obj.y
      // use the player's feet position for more accurate contact testing
      const cw = (obj as any).width || 16;
      const ch = (obj as any).height || 24;
      const halfW = cw / 2;
      const halfH = ch / 2;
      const px = currPlayer.x;
      const pyFeet = currPlayer.y + FEET_OFFSET;
      // overlap test between player's feet point and collider rect (with horizontal half-width)
      if (Math.abs(px - ox) <= halfW + HALF_WIDTH && Math.abs(pyFeet - oy) <= halfH + FEET_OFFSET) collided = true;
    } else {
      if (distSq < radius * radius || crossedX) collided = true;
    }

    if (collided) {
      if (obj.type === 'hazard' || (obj as any).type === 'wall' || (obj as any).type === 'collider') {
        // don't allow hazards to kill the player once they've reached the finish
        if (!ctx.reachedFinish && currPlayer.invulnTimer <= 0) {
          // crash
          if (ctx.state !== 'dead') {
            try {
              handleAvalancheOnCrash(ctx);
            } catch (e) {}
            ctx.state = 'dead';
            ctx.crashFade = 0.6;
            ctx.crashTimer = 0.9;
            void ctx.sfxDeath?.play?.();
            try {
              ctx.effects.shake.shake(8);
            } catch (e) {}
            try {
              ctx.effects.onCrash(currPlayer.x, currPlayer.y + FEET_OFFSET, currPlayer.vx, currPlayer.vy);
            } catch (e) {}
            try {
              ctx.playerEntity = null;
            } catch (e) {}
          }
        }
      } else if (obj.type === 'finish') {
        // mark reached finish; subsequent hazards or falls should be ignored
        ctx.reachedFinish = true;
        ctx.state = 'complete';
        void ctx.sfxComplete?.play?.();
      } else if (obj.type === 'checkpoint') {
        if (ox > ctx.lastCheckpointX) {
          ctx.lastCheckpointX = ox;
          void ctx.sfxCheckpoint?.play?.();
          try {
            // emit many small orange upward sparks when a checkpoint is reached
            if (ctx.effects && ctx.effects.particles) {
              const emitX = ox;
              const emitY = oy - 6; // slightly above ground
              // big burst of upward orange sparks
              ctx.effects.shake.shake(6, 0.18);
              ctx.effects.particles.emitDirectional(emitX, emitY, 240, {
                angle: -Math.PI * 0.5, // upward
                spread: 1.6,
                speed: 180,
                size: 1.2,
                color: '#ff8c00',
                ttl: 1.6,
              });
              // layered small explosion for extra density
              ctx.effects.particles.emitExplosion(emitX, emitY - 6, 40, {
                spread: 40,
                speed: 120,
                size: 2,
                color: '#ffb86b',
              });
            }
          } catch (e) {}
        }
      }
    }
  }

  // Avalanche logic: advance a left-originating sheet across the level
  try {
    const meta = (currentLevel && (currentLevel.meta as any)) || {};
    const avalSpeed = typeof meta.avalancheSpeed === 'number' ? meta.avalancheSpeed : 0;
    if (avalSpeed > 0) {
      // initialize avalanche position just before the level's start when first seen
      if (typeof ctx.avalancheX !== 'number') {
        const startObj = currentLevel && currentLevel.objects ? (currentLevel.objects as any[]).find((o) => o.type === 'start') : undefined;
        const startX = typeof startObj?.x === 'number' ? startObj.x : ctx.currPlayer.x || 0;
        const START_OFFSET = 120; // start a bit to the left of the start marker
        ctx.avalancheX = startX - START_OFFSET;
        ctx.avalancheSpeed = avalSpeed;
        ctx.avalancheActive = true;
      }
      // keep speed in sync with level meta
      ctx.avalancheSpeed = avalSpeed;
      // advance avalanche leading edge
      const speed = typeof ctx.avalancheSpeed === 'number' ? ctx.avalancheSpeed : avalSpeed;
      const prevAvalX = typeof ctx.avalancheX === 'number' ? ctx.avalancheX : undefined;
      ctx.avalancheX = (ctx.avalancheX || 0) + speed * dt;

      // SIMPLE EMITTER MODEL: 4 emitters along the front that throw large, slow chunks.
      try {
        if (ctx.effects && ctx.effects.particles) {
          ctx.avalancheEmitTimer = Math.max(0, (ctx.avalancheEmitTimer || 0) - dt);
          if ((ctx.avalancheEmitTimer || 0) <= 0) {
            // trigger emitters ~3 times/sec (configurable to 2-4/sec)
            ctx.avalancheEmitTimer = 0.33;
            const frontX = ctx.avalancheX || 0;
            const levelH = (currentLevel && (currentLevel.meta as any).virtualHeight) || (globalThis as any).VIRTUAL_HEIGHT || VIRTUAL_HEIGHT || 225;
            // emitter horizontal offsets (world units) behind the leading edge
            const emitterOffsets = [8, 18, 30, 44];
            // vertical screen fractions: emitters spread evenly on player's screen Y axis
            const screenFracs = [0.22, 0.42, 0.62, 0.82];
            // compute camera-derived topWorld so emitters stick to screen Y positions
            const camY = ctx.currCam && typeof ctx.currCam.y === 'number' ? ctx.currCam.y : ctx.currPlayer.y || 0;
            const viewWorldH = VIRTUAL_HEIGHT; // virtual canvas height in world units
            const topWorld = camY - viewWorldH / 2;
            // particle cap: skip heavy emits if too many particles already
            const PARTICLE_CAP = 2200;
            const currentParticles = ctx.effects.particles.particles.length;
            for (let ei = 0; ei < emitterOffsets.length; ei++) {
              // X anchored roughly to the avalanche front (slightly behind)
              const exBase = frontX - emitterOffsets[ei] + (Math.random() - 0.5) * 6;
              // Y fixed to screen fraction -> world Y so emitters remain at same
              // screen vertical positions as the camera moves.
              const frac = screenFracs[ei] ?? 0.5;
              let eyBase = topWorld + frac * viewWorldH + (Math.random() - 0.5) * 8;
              // If terrain at emitter X is significantly above the chosen screen Y,
              // nudge the emitter up toward the terrain so chunks feel grounded.
              try {
                const terrainY = getHeightAtX(currentLevel as any, Math.round(exBase));
                if (terrainY !== null && terrainY - 12 < eyBase) {
                  // prefer to originate a little above terrain when terrain is visible
                  eyBase = Math.min(eyBase, (terrainY as number) - 6 + (Math.random() - 0.5) * 6);
                }
              } catch (e) {}
              try {
                // skip heavy emission if particles are already high
                if (currentParticles > PARTICLE_CAP) continue;
                // emit a few very large, slow chunks from each emitter (2-3 chunks)
                const chunkCount = 1 + Math.floor(Math.random() * 3); // 1-3
                for (let c = 0; c < chunkCount; c++) {
                  const size = 48 + Math.random() * 16; // 48-64 px
                  ctx.effects.particles.emitDirectional(exBase + (Math.random() - 0.5) * 24, eyBase + (Math.random() - 0.5) * 28, 1, {
                    angle: Math.PI + (Math.random() - 0.5) * 0.45, // mostly left
                    spread: 0.6 + Math.random() * 1.4,
                    speed: 8 + Math.random() * 48,
                    size,
                    color: '#fbfdff',
                    ttl: 2.0 + Math.random() * 2.6,
                  });
                }

                // churn: emit a cluster of short-lived small snow particles to give motion
                const churnCount = 6 + Math.floor(Math.random() * 8);
                ctx.effects.particles.emitDirectional(exBase, eyBase - 6, churnCount, {
                  angle: Math.PI + -0.1 + (Math.random() - 0.5) * 0.6,
                  spread: 1.8,
                  speed: 40 + Math.random() * 80,
                  size: 1 + Math.random() * 2,
                  color: 'rgba(255,255,255,0.96)',
                  ttl: 0.5 + Math.random() * 0.8,
                });
              } catch (e) {}
            }
          }
        }
      } catch (e) {}

      // collision: if player's x is behind the avalanche leading edge, they are caught
      const AVAL_WIDTH = 12; // thickness of avalanche leading edge
      if (!ctx.reachedFinish && ctx.state !== 'dead' && (ctx.currPlayer.x || 0) <= (ctx.avalancheX || 0) + AVAL_WIDTH) {
        // force a full-level restart (ignore checkpoints)
        ctx.forceFullRestart = true;
        ctx.state = 'dead';
        ctx.crashFade = 0.6;
        ctx.crashTimer = 0.9;
        ctx.crashFlash = 0.6;
        try {
          void ctx.sfxDeath?.play?.();
        } catch (e) {}
        try {
          ctx.effects.shake.shake(12);
        } catch (e) {}
        try {
          ctx.effects.onCrash(ctx.currPlayer.x, ctx.currPlayer.y + 8, ctx.currPlayer.vx, ctx.currPlayer.vy);
        } catch (e) {}
        try {
          ctx.playerEntity = null;
        } catch (e) {}
      }
    }
  } catch (e) {}

  // bounds check - don't trigger death if we've already reached the finish
  // Use level meta virtualHeight when available so taller levels don't prematurely trigger a crash.
  const levelHeight = (currentLevel && (currentLevel.meta as any)?.virtualHeight) || (globalThis as any).VIRTUAL_HEIGHT || 225;
  const crashThreshold = Math.max(600, levelHeight + ((globalThis as any).VIRTUAL_HEIGHT || 225));
  if (currPlayer.y > crashThreshold && !ctx.reachedFinish) {
    if (ctx.state !== 'dead') {
      try {
        handleAvalancheOnCrash(ctx);
      } catch (e) {}
      ctx.state = 'dead';
      ctx.crashFade = 0.6;
      ctx.crashTimer = 0.9;
      void ctx.sfxDeath?.play?.();
      try {
        ctx.effects.onCrash(currPlayer.x, currPlayer.y + FEET_OFFSET, currPlayer.vx, currPlayer.vy);
      } catch (e) {}
      try {
        ctx.playerEntity = null;
      } catch (e) {}
    }
  }

  // Update animated sprite
  if (ctx.playerEntity) {
    if (!currPlayer.grounded) {
      ctx.playerEntity.setState(currPlayer.vy < 0 ? 'jump' : 'fall');
    } else {
      ctx.playerEntity.setState(Math.abs(currPlayer.vx) > 10 ? 'run' : 'idle');
    }
    ctx.playerEntity.update(dt);
  }

  // update effects
  ctx.effects.update(dt);
}
