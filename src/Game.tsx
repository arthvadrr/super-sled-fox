import React, { useRef, useEffect } from 'react';
import InputManager from './input';
import { createPlayer, Player, PHYS, PLAYER_DEFAULTS } from './player';
import { LEVELS } from './levels';

// runtime mutable level loaded from the LEVELS pack
let currentLevelIndex = 0;
let currentLevel = JSON.parse(JSON.stringify(LEVELS[currentLevelIndex].level));
import assetManager from './assetManager';
import audioManager from './audioManager';
import { createSpriteSheet, AnimatedSprite, AnimationStateMachine } from './sprite';
import { loadParallaxLayers, ParallaxLayer } from './parallax';
import EffectsManager from './effects';
import { getHeightAtX, getSlopeAtX } from './heightmap';
import { validateLevel } from './level';
import { startEditor } from './editor';

const VIRTUAL_WIDTH = 400;
const VIRTUAL_HEIGHT = 225;

type GameState = 'title' | 'playing' | 'paused' | 'dead' | 'complete' | 'editor' | 'loading';

export default function Game() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<GameState>('title');

  // expose a simple setter for manual testing from console
  (window as any).__setGameState = (s: GameState) => {
    stateRef.current = s;
  };

  useEffect(() => {
    // enter loading state and fetch assets for the current level
    stateRef.current = 'loading';
    let loadingCancelled = false;
    let loadedCount = 0;
    let totalToLoad = 0;
    let loadingProgress = 0;

    async function loadLevelAssets() {
      try {
        const meta: any = currentLevel.meta || {};
        const assets = meta.assets || [];
        if (!Array.isArray(assets) || assets.length === 0) {
          // no explicit assets: wait a small timeout so UI shows loading briefly
          // continue afterwards so other meta-driven resources (parallax, sfx)
          // still get a chance to load even when `meta.assets` is empty.
          await new Promise((r) => setTimeout(r, 500));
        }

        totalToLoad = assets.length;
        const promises = assets.map(async (a: string) => {
          // heuristic: image if png/jpg, audio if mp3/ogg/m4a
          const lower = a.toLowerCase();
          if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.webp')) {
            await assetManager.loadImage(a);
          } else if (lower.endsWith('.mp3') || lower.endsWith('.ogg') || lower.endsWith('.m4a') || lower.endsWith('.wav')) {
            await assetManager.loadAudio(a);
          } else {
            // try image first
            await assetManager.loadImage(a).catch(() => assetManager.loadAudio(a).catch(() => { }));
          }
          loadedCount++;
          loadingProgress = totalToLoad > 0 ? loadedCount / totalToLoad : 1;
        });

        // race between asset loading and a max timeout so loading never blocks forever
        await Promise.race([Promise.all(promises), new Promise((r) => setTimeout(r, 2000))]);
        // Attempt to create SFX hooks from meta.sfx (silent/no-op on missing)
        try {
          const sfxMeta: any = meta.sfx || {};
          sfxJump = await audioManager.createSound(sfxMeta.jump || 'sfx/jump.mp3').catch(() => null);
          sfxLand = await audioManager.createSound(sfxMeta.land || 'sfx/land.mp3').catch(() => null);
          sfxCheckpoint = await audioManager.createSound(sfxMeta.checkpoint || 'sfx/checkpoint.mp3').catch(() => null);
          sfxDeath = await audioManager.createSound(sfxMeta.death || 'sfx/death.mp3').catch(() => null);
          sfxComplete = await audioManager.createSound(sfxMeta.complete || 'sfx/complete.mp3').catch(() => null);
        } catch (e) {
          // ignore — sounds will be null
        }
        // Load parallax layers from meta (optional) via helper
        try {
          const layersSpec: any[] = meta.parallax || meta.layers || [];
          const loaded = await loadParallaxLayers(assetManager, layersSpec);
          parallax.push(...loaded);
        } catch (e) {
          // ignore
        }
        // try load a player sprite sheet (optional)
        try {
          const pImg = await assetManager.loadImage('sprites/player.png').catch(() => null);
          if (pImg) {
            const sheet = createSpriteSheet(pImg, 32, 32);
            const base = new AnimatedSprite(sheet);
            base.addAnim('idle', [0], 6, true);
            const runFrames: number[] = [];
            for (let i = 1; i <= Math.min(4, sheet.frameCount - 1); i++) runFrames.push(i);
            if (runFrames.length > 0) base.addAnim('run', runFrames, 14, true);
            if (sheet.frameCount > 5) base.addAnim('jump', [5], 12, false);
            if (sheet.frameCount > 6) base.addAnim('fall', [6], 12, false);
            const entity = new AnimationStateMachine();
            entity.addLayer(base, { fallback: 'idle' }, 0, 0);
            // try load an accessory overlay (hat/gear) that aligns with same frames
            try {
              const acc = await assetManager.loadImage('sprites/player_hat.png').catch(() => null);
              if (acc) {
                const accSheet = createSpriteSheet(acc, 32, 32);
                const accSprite = new AnimatedSprite(accSheet);
                // mirror animations from base where possible
                accSprite.addAnim('idle', [0], 6, true);
                if (accSheet.frameCount > 1) {
                  const f: number[] = [];
                  for (let i = 1; i <= Math.min(4, accSheet.frameCount - 1); i++) f.push(i);
                  if (f.length) accSprite.addAnim('run', f, 14, true);
                }
                entity.addLayer(accSprite, { fallback: 'idle' }, 0, -8);
              }
            } catch (e) {
              /* ignore accessory */
            }
            playerEntity = entity;
          }
        } catch (e) {
          // ignore — sprite optional
        }
      } catch (e) {
        // ignore — fallthrough to title
      }
    }

    loadLevelAssets().then(() => {
      if (!loadingCancelled) stateRef.current = 'title';
    });

    // helper to load a level by pack index at runtime
    async function loadLevelByIndex(idx: number) {
      if (idx < 0 || idx >= LEVELS.length) return;
      currentLevelIndex = idx;
      currentLevel = JSON.parse(JSON.stringify(LEVELS[idx].level));
      // clear runtime assets/visuals that are level-specific
      parallax.length = 0;
      // reset checkpoint/start state for new level
      try {
        const startObjNew = (currentLevel.objects || []).find((o: any) => o.type === 'start');
        lastCheckpointX = startObjNew ? startObjNew.x : PLAYER_DEFAULTS.startX;
        reachedFinish = false;
      } catch (e) {
        // ignore
      }
      // attempt to load assets for the new level
      await loadLevelAssets();
      // respawn player at start/checkpoint of new level
      respawn();
      // briefly show restart hint so player knows R will restart
      restartHintTimer = 2.5;
    }

    // Audio unlock gate: unlock audio on first user gesture
    const unlockOnce = () => {
      audioManager.unlock().catch(() => { });
      window.removeEventListener('keydown', unlockOnce);
      window.removeEventListener('pointerdown', unlockOnce);
    };
    window.addEventListener('keydown', unlockOnce, { once: true });
    window.addEventListener('pointerdown', unlockOnce, { once: true });
    const canvasEl = canvasRef.current!;
    const ctx = canvasEl.getContext('2d')!;

    // virtual (offscreen) canvas at fixed virtual resolution
    const vcanvas = document.createElement('canvas');
    vcanvas.width = VIRTUAL_WIDTH;
    vcanvas.height = VIRTUAL_HEIGHT;
    const vctx = vcanvas.getContext('2d')!;

    // player + camera state
    const currPlayer: Player = createPlayer();
    let prevPlayer: Player = { ...currPlayer };

    // Camera state (we only track horizontal for now)
    const currCam = { x: currPlayer.x };
    let prevCam = { ...currCam };

    // Camera tuning
    const CAMERA = {
      LOOK_AHEAD_MULT: 0.5, // look-ahead multiplier from player vx
      MAX_LOOK_AHEAD: 60, // max pixels to look ahead
      SMOOTH: 8, // higher = snappier follow
    };
    // Rendering tuning
    const RENDER = {
      PIXEL_SNAP: true, // snap world -> screen pixels to avoid subpixel blur
      PADDING: 8, // extra segments to draw outside view to avoid popping
    };
    let lastGroundY: number | null = null;
    let lastGroundAngle = 0;
    let ledgeGrace = 0; // seconds to preserve grounded pose after leaving ground
    // debug tracked values
    let lastSlope = 0;
    let lastSlopeEff = 0;
    let lastAccelRaw = 0;
    let lastAccelScaled = 0;
    // tuning constants for slope and motor
    const SLOPE_SCALE = 0.35;
    const MAX_SLOPE = 1.5;
    const MOTOR_K = 6;
    const MOTOR_MAX = 250;
    // debug / effects
    let landingFlash = 0; // seconds of white flash on landing
    // crash / respawn visuals
    let crashFade = 0; // seconds of crash fade overlay (counts down)
    let crashTimer = 0; // time until auto-respawn after crash
    // transient UI hint shown briefly after starting a new level
    let restartHintTimer = 0;
    let fps = 60;
    // debugging: track space-press snapshot and whether a jump was applied this frame
    let spacePressSnapshot: any = null;
    let jumpAppliedThisFrame = false;
    // persistent last-contact samples so main loop can inspect them
    let lastContactBack: number | null = null;
    let lastContactFront: number | null = null;
    let lastContactAvg: number | null = null;
    let lastNearGround: boolean = false;
    let pendingImmediateJump = false;
    // editor state tracking
    let lastNonEditorState: GameState = stateRef.current;
    let editorStop: any = null;
    // editor camera (only active while in editor mode)
    let editorCamX = 0;
    let editorCamY = 0;
    let editorZoom = 1;
    const EDITOR_ZOOM_MIN = 0.5;
    const EDITOR_ZOOM_MAX = 3.0;
    let lastEditorZoom = 1;
    // parallax layers: images and scroll factors
    const parallax: ParallaxLayer[] = [];
    // visual effects (dust, speed lines, screen shake)
    const effects = new EffectsManager({ enabled: true });
    // optional player entity (layered sprite + state machine)
    let playerEntity: AnimationStateMachine | null = null;
    // sound hooks (populated during loading)
    let sfxJump: any = null;
    let sfxLand: any = null;
    let sfxCheckpoint: any = null;
    let sfxDeath: any = null;
    let sfxComplete: any = null;
    // jump tuning / state
    const JUMP = {
      COYOTE_TIME: 0.12,
      BUFFER_TIME: 0.12,
      HOLD_GRAVITY_FACTOR: 0.45, // while holding jump, gravity is reduced by this factor
    };
    let coyoteTimer = 0;
    let jumpBuffer = 0;
    let jumpHold = 0;
    let jumpLock = 0; // short timer to prevent immediate re-grounding after jump
    // checkpoint / finish / death
    const startObj = (currentLevel.objects || []).find((o: any) => o.type === 'start');
    let lastCheckpointX = startObj ? startObj.x : currPlayer.x;
    let reachedFinish = false;
    let deathTimer = 0; // delay before auto-respawn
    // debug logging accumulator
    // debug logging accumulator (removed)

    function respawn() {
      const rx = lastCheckpointX ?? PLAYER_DEFAULTS.startX;
      currPlayer.x = rx;
      const hy = getHeightAtX(currentLevel as any, rx);
      // place player slightly above ground so feet sit on the surface rather than inside it
      const FEET_OFFSET = 8; // virtual pixels from contact height to player's origin
      currPlayer.y = hy !== null ? hy - FEET_OFFSET : PLAYER_DEFAULTS.startY;
      currPlayer.vx = PHYS.BASE_CRUISE_SPEED;
      currPlayer.vy = 0;
      currPlayer.angle = getSlopeAtX(currentLevel as any, rx) ?? 0;
      // start slightly above ground and mark airborne so we don't snap into the ground
      currPlayer.grounded = false;
      currPlayer.wasGrounded = false;
      lastGroundY = null;
      currPlayer.invulnTimer = 1.0; // grant a short invulnerability window after respawn
      prevPlayer = { ...currPlayer };
      currCam.x = currPlayer.x;
      prevCam = { ...currCam };
      // respawn
      // resume play
      stateRef.current = 'playing';
      reachedFinish = false;
      deathTimer = 0;
    }

    // Developer test helper: trigger a crash/fall sequence programmatically
    function triggerCrash() {
      if (stateRef.current === 'dead') return;
      stateRef.current = 'dead';
      crashFade = 0.6;
      crashTimer = 0.9;
      void sfxDeath?.play?.();
    }

    // simulation step (fixed dt seconds)
    function simulate(dt: number) {
      // two-point ground contact positions
      const halfWidth = 8; // virtual pixels from center to contact points
      const backX = currPlayer.x - halfWidth;
      const frontX = currPlayer.x + halfWidth;
      // timers
      coyoteTimer = Math.max(0, coyoteTimer - dt);
      jumpBuffer = Math.max(0, jumpBuffer - dt);
      jumpHold = Math.max(0, jumpHold - dt);
      // decrement invulnerability timer
      currPlayer.invulnTimer = Math.max(0, (currPlayer.invulnTimer || 0) - dt);
      // periodic debug log to help diagnose speed/control issues
      // debug logging removed
      // respawn
      // decay jump lock
      jumpLock = Math.max(0, jumpLock - dt);
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
      const nearGround = avgY !== null && currPlayer.y >= (avgY - NEAR_GROUND_THRESHOLD);

      // update persistent last-contact diagnostics so main loop can report them
      lastContactBack = hb;
      lastContactFront = hf;
      lastContactAvg = avgY;
      lastNearGround = !!nearGround;

      if (contactExists && (currPlayer.wasGrounded || nearGround) && jumpLock <= 0) {
        // grounded: snap to contact average, reset vertical velocity and set angle
        // log grounding transition when we become grounded this step
        if (!currPlayer.grounded) {
          // eslint-disable-next-line no-console
          console.log('[jump-debug] grounded set TRUE', { t: performance.now(), hb, hf, avgY, nearGround, wasGrounded: currPlayer.wasGrounded, jumpLock, y: currPlayer.y });
        }
        currPlayer.y = avgY!;
        currPlayer.vy = 0;
        currPlayer.grounded = true;
        currPlayer.angle = Math.atan2((hf as number) - (hb as number), frontX - backX);

        // debug: log before movement step in grounded branch
        // grounded branch

        // grounded motion: acceleration along slope from gravity projection
        const slope = getSlopeAtX(currentLevel as any, currPlayer.x) ?? Math.tan(currPlayer.angle);
        lastSlope = slope;
        // clamp slope for safety and compute gravity projection
        const slopeEff = Math.max(-MAX_SLOPE, Math.min(MAX_SLOPE, slope));
        lastSlopeEff = slopeEff;
        const accelRaw = PHYS.GRAVITY * slopeEff / Math.sqrt(1 + slopeEff * slopeEff);
        const accelScaled = accelRaw * SLOPE_SCALE;
        lastAccelRaw = accelRaw;
        lastAccelScaled = accelScaled;

        // input speed modifiers and braking
        const forward = input.get('ArrowRight').isDown || input.get('d').isDown || input.get('w').isDown;
        const back = input.get('ArrowLeft').isDown || input.get('a').isDown || input.get('s').isDown;
        let speedMul = 1.0;
        if (forward) speedMul = 1.5;
        else if (back) speedMul = 0.5;

        // target cruise speed modified by input
        const targetSpeed = PHYS.BASE_CRUISE_SPEED * speedMul;

        // forward motor assist (grounded only)
        let motorAccel = 0;
        if (forward && !back) {
          motorAccel = Math.max(0, Math.min(MOTOR_MAX, (targetSpeed - currPlayer.vx) * MOTOR_K));
        }

        // apply slope gravity (scaled)
        currPlayer.vx += accelScaled * dt;
        // apply motor assist but do not exceed targetSpeed
        if (motorAccel > 0) {
          const maxDelta = Math.max(0, targetSpeed - currPlayer.vx);
          const applied = Math.min(motorAccel * dt, maxDelta);
          currPlayer.vx += applied;
        }

        // braking only for back: if back pressed and vx > target, decelerate; never reverse to negative
        if (back) {
          if (currPlayer.vx > targetSpeed) {
            currPlayer.vx = Math.max(targetSpeed, currPlayer.vx - PHYS.FRICTION * 4 * dt);
          }
        } else {
          // accelerate toward target smoothly
          const accel = 200; // px/s^2 accel toward target
          const delta = targetSpeed - currPlayer.vx;
          const change = Math.sign(delta) * Math.min(Math.abs(delta), accel * dt);
          currPlayer.vx += change;
        }

        // simple friction along ground (always apply small friction)
        const frictionAcc = PHYS.FRICTION * 0.5;
        if (currPlayer.vx > 0) {
          currPlayer.vx = Math.max(0, currPlayer.vx - frictionAcc * dt);
        } else {
          currPlayer.vx = Math.min(0, currPlayer.vx + frictionAcc * dt);
        }

        // Soft cap: taper acceleration above soft start
        const softStart = PHYS.SOFT_CAP_START;
        if (currPlayer.vx > softStart) {
          // apply mild damping to values above softStart so reaching MAX_SPEED feels harder
          const over = currPlayer.vx - softStart;
          // damping factor scales with dt so effect is framerate independent
          const damping = 1 + 3 * dt;
          currPlayer.vx = softStart + over / damping;
        }

        // clamp hard max and min
        if (currPlayer.vx > PHYS.MAX_SPEED) currPlayer.vx = PHYS.MAX_SPEED;
        if (currPlayer.vx < 0) currPlayer.vx = 0;

        // prepare coyote timer (allow jump shortly after leaving ground)
        coyoteTimer = JUMP.COYOTE_TIME;

        // jump from grounded: immediate if pressed
        const jumpPressedGround = input.get(' ').wasPressed || input.get('ArrowUp').wasPressed || input.get('w').wasPressed;
        if (jumpPressedGround) {
          // log press snapshot to help diagnose missed jumps
          // eslint-disable-next-line no-console
          console.log('[jump-debug] space press (grounded check)', {
            t: performance.now(),
            state: stateRef.current,
            grounded: currPlayer.grounded,
            wasGrounded: currPlayer.wasGrounded,
            coyoteTimer,
            jumpBuffer,
            jumpLock,
            jumpHold,
            vy: currPlayer.vy,
            y: currPlayer.y,
            lastGroundY,
            nearGround,
            hb,
            hf,
            ledgeGrace,
          });

          currPlayer.vy = -PHYS.JUMP_IMPULSE;
          currPlayer.grounded = false;
          jumpHold = PHYS.JUMP_HOLD_TIME;
          jumpLock = 0.18;
          // play sfx
          void sfxJump?.play?.();
          // jump applied
          // immediately integrate a small vertical step so height sampling doesn't re-detect ground
          try {
            currPlayer.y += currPlayer.vy * dt;
            lastGroundY = null;
            ledgeGrace = 0;
          } catch (e) { }
          // mark jump applied and log
          jumpAppliedThisFrame = true;
          // consume any stored press so it doesn't retrigger on landing
          spacePressSnapshot = null;
          pendingImmediateJump = false;
          // eslint-disable-next-line no-console
          console.log('[jump-debug] jump applied (grounded)', { t: performance.now(), vy: currPlayer.vy, y: currPlayer.y });
        }

        // Missed-press fallback: if we captured a space press earlier (or main loop
        // requested an immediate jump) but the physics step didn't see it, force a
        // jump now when the player is effectively grounded.
        if ((spacePressSnapshot || pendingImmediateJump) && !jumpAppliedThisFrame && jumpLock <= 0) {
          const withinProximity = nearGround || (typeof avgY === 'number' && Math.abs(currPlayer.y - avgY) <= NEAR_GROUND_THRESHOLD);
          if (contactExists && withinProximity) {
            // apply same jump as normal grounded case
            currPlayer.vy = -PHYS.JUMP_IMPULSE;
            currPlayer.grounded = false;
            jumpHold = PHYS.JUMP_HOLD_TIME;
            jumpLock = 0.18;
            void sfxJump?.play?.();
            try {
              currPlayer.y += currPlayer.vy * dt;
              lastGroundY = null;
              ledgeGrace = 0;
            } catch (e) { }
            jumpAppliedThisFrame = true;
            // consume any stored press so it doesn't retrigger on landing
            spacePressSnapshot = null;
            pendingImmediateJump = false;
            // eslint-disable-next-line no-console
            console.log('[jump-debug] forced jump (missed-press fallback)', { press: spacePressSnapshot, pendingImmediateJump, t: performance.now(), vy: currPlayer.vy, y: currPlayer.y });
            // consume snapshot and pending flag so we don't re-fire
            spacePressSnapshot = null;
            pendingImmediateJump = false;
          }
        }

        // advance horizontal position while grounded
        // advance horizontal position while grounded
        currPlayer.x += currPlayer.vx * dt;

        // update last ground pose
        // update last ground pose
        lastGroundY = avgY;
        lastGroundAngle = currPlayer.angle;
        ledgeGrace = 0;
        // landing detection: if we were airborne last fixed-step, trigger land event
        if (!currPlayer.wasGrounded && currPlayer.grounded) {
          // only show a white landing flash for harder impacts; keep dust/particles always
          const impactVel = Math.abs(prevPlayer.vy || 0);
          const FLASH_IMPACT_THRESHOLD = 450; // require a harder impact to show flash
          const CRASH_IMPACT_THRESHOLD = 820; // above this, treat as a crash
          if (impactVel > CRASH_IMPACT_THRESHOLD && (currPlayer.invulnTimer <= 0)) {
            // trigger crash: brief fade-out and schedule respawn
            stateRef.current = 'dead';
            crashFade = 0.6;
            crashTimer = 0.9;
            // play death sound
            void sfxDeath?.play?.();
          } else {
            if (impactVel > FLASH_IMPACT_THRESHOLD) landingFlash = 0.12;
            currPlayer.invulnTimer = 0.5;
            // play landing sound
            void sfxLand?.play?.();
            // visual effects: dust and shake
            try {
              effects.onLand(currPlayer.x, currPlayer.y, currPlayer.vx);
            } catch (e) {
              /* ignore */
            }
          }
        }
      } else {
        // contact exists but we didn't treat as grounded (maybe jumpLock or not near enough)
        if (contactExists && !(currPlayer.wasGrounded || nearGround) || (contactExists && jumpLock > 0)) {
          // eslint-disable-next-line no-console
          console.log('[jump-debug] contact exists but not grounded', { t: performance.now(), hb, hf, avgY, nearGround, wasGrounded: currPlayer.wasGrounded, jumpLock, y: currPlayer.y });
        }
        // became airborne this frame?
        if (currPlayer.wasGrounded && !currPlayer.grounded) {
          // log airborne transition
          // eslint-disable-next-line no-console
          console.log('[jump-debug] became airborne', { t: performance.now(), y: currPlayer.y, vy: currPlayer.vy });
          // preserve last grounded pose for a short grace period
          if (lastGroundY === null) {
            lastGroundY = prevPlayer.y;
            lastGroundAngle = prevPlayer.angle;
          }
          ledgeGrace = FIXED_DT; // one fixed step
        }

        // if we have grace left, preserve vertical/angle and don't apply gravity yet
        if (ledgeGrace > 0) {
          ledgeGrace -= dt;
          if (lastGroundY !== null) {
            currPlayer.y = lastGroundY;
            currPlayer.angle = lastGroundAngle;
          }
          // still advance horizontal position
          // before airborne-preserve move
          currPlayer.x += currPlayer.vx * dt;
          // don't modify vy yet
        } else {
          // handle jump input buffering: if player pressed jump recently, store it
          const jumpPressed = input.get(' ').wasPressed || input.get('ArrowUp').wasPressed || input.get('w').wasPressed;
          if (jumpPressed) {
            jumpBuffer = JUMP.BUFFER_TIME;
            // eslint-disable-next-line no-console
            console.log('[jump-debug] space press (airborne/buffer)', { t: performance.now(), coyoteTimer, jumpBuffer, jumpLock, grounded: currPlayer.grounded, wasGrounded: currPlayer.wasGrounded, vy: currPlayer.vy, y: currPlayer.y });
          }

          // attempt to jump if we still have coyote time
          if (jumpBuffer > 0 && coyoteTimer > 0) {
            currPlayer.vy = -PHYS.JUMP_IMPULSE;
            currPlayer.grounded = false;
            jumpHold = PHYS.JUMP_HOLD_TIME;
            jumpBuffer = 0;
            coyoteTimer = 0;
            // jump sfx
            void sfxJump?.play?.();
            // mark jump applied and log
            jumpAppliedThisFrame = true;
            // eslint-disable-next-line no-console
            console.log('[jump-debug] jump applied (coyote)', { t: performance.now(), vy: currPlayer.vy, y: currPlayer.y });
          }

          // apply airborne physics with variable gravity while holding jump
          const holdingJump = jumpHold > 0 && (input.get(' ').isDown || input.get('ArrowUp').isDown || input.get('w').isDown);
          const gravityFactor = holdingJump ? JUMP.HOLD_GRAVITY_FACTOR : 1;
          currPlayer.vy += PHYS.GRAVITY * gravityFactor * dt;
          // debug: before airborne integration
          // before airborne integration
          currPlayer.x += currPlayer.vx * dt;
          currPlayer.y += currPlayer.vy * dt;
        }

        currPlayer.grounded = false;
      }

      // check checkpoints / finish after movement
      for (const obj of currentLevel.objects || []) {
        if (obj.type === 'checkpoint') {
          if (currPlayer.x >= obj.x && lastCheckpointX < obj.x) {
            lastCheckpointX = obj.x;
            landingFlash = 0.18;
            void sfxCheckpoint?.play?.();
          }
        }
        if (obj.type === 'finish') {
          if (currPlayer.x >= obj.x && !reachedFinish) {
            reachedFinish = true;
            stateRef.current = 'complete';
            landingFlash = 0.6;
            void sfxComplete?.play?.();
          }
        }
      }

      // death: fell too far below screen
      if (currPlayer.y > VIRTUAL_HEIGHT + 160 && stateRef.current !== 'dead' && !reachedFinish) {
        // falling out -> crash/death
        stateRef.current = 'dead';
        crashFade = 0.6;
        crashTimer = 0.9; // auto-respawn after crash
        void sfxDeath?.play?.();
      }



      // advance player sprite animation (if present)
      playerEntity?.update(dt);
      // update visual effects
      try {
        effects.update(dt);
      } catch (e) {
        // ignore
      }

      // camera follows player with look-ahead and smoothing, clamped to level bounds
      const levelWidth = (currentLevel.meta && currentLevel.meta.width) || (currentLevel.segments && currentLevel.segments.length) || VIRTUAL_WIDTH;
      const look = Math.max(-CAMERA.MAX_LOOK_AHEAD, Math.min(CAMERA.MAX_LOOK_AHEAD, currPlayer.vx * CAMERA.LOOK_AHEAD_MULT));
      const targetCamX = currPlayer.x + look;
      // smooth toward target (frame-rate independent)
      const t = Math.min(1, CAMERA.SMOOTH * dt);
      currCam.x += (targetCamX - currCam.x) * t;
      // clamp so camera doesn't show past level edges
      const halfW = VIRTUAL_WIDTH / 2;
      const minCam = halfW;
      const maxCam = Math.max(halfW, levelWidth - halfW);
      currCam.x = Math.max(minCam, Math.min(maxCam, currCam.x));
      // airborne rotation easing: when not grounded, ease angle toward neutral (0)
      if (!currPlayer.grounded) {
        const ANGLE_EASE = 6; // higher = faster easing
        currPlayer.angle += (0 - currPlayer.angle) * Math.min(1, ANGLE_EASE * dt);
      }
    }

    function draw() {
      // interpolation alpha based on accumulator
      const alpha = Math.max(0, Math.min(1, accumulator / FIXED_DT));
      const isEditor = stateRef.current === 'editor';
      const zoom = isEditor ? editorZoom : 1;

      // interpolate player and camera
      const ix = prevPlayer.x * (1 - alpha) + currPlayer.x * alpha;
      const iy = prevPlayer.y * (1 - alpha) + currPlayer.y * alpha;
      const camx = prevCam.x * (1 - alpha) + currCam.x * alpha;

      // Editor camera uses the same coordinate convention as screenToWorldFn:
      // camX/camY represent the CENTER of the view in world units.
      const camXUsed = isEditor ? editorCamX : camx;
      const camYUsed = isEditor ? editorCamY : 0;
      const viewWorldW = VIRTUAL_WIDTH / Math.max(0.0001, zoom);
      const viewWorldH = VIRTUAL_HEIGHT / Math.max(0.0001, zoom);
      const leftWorld = camXUsed - viewWorldW / 2;
      const topWorld = camYUsed - viewWorldH / 2;
      const wxToS = (wx: number) => (wx - leftWorld) * zoom;
      const wyToS = (wy: number) => (wy - topWorld) * zoom;


      // draw scene into virtual canvas (virtual pixels)
      vctx.fillStyle = '#0b1220';
      vctx.fillRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);

      // apply screen-shake offset to camera when rendering
      const shakeX = (!isEditor && (effects && effects.shake && effects.shake.x)) ? effects.shake.x : 0;
      const shakeY = (!isEditor && (effects && effects.shake && effects.shake.y)) ? effects.shake.y : 0;
      const camxShaken = camx + shakeX;

      // draw parallax background layers (back-to-front)
      if (parallax.length > 0) {
        for (let li = 0; li < parallax.length; li++) {
          const layer = parallax[li];
          if (!layer || !layer.img) continue;
          const img = layer.img;
          const factor = layer.factor || 0.5;
          const yOff = (layer.yOff || 0) + shakeY;
          // tile image horizontally to fill view
          const imgW = img.width || VIRTUAL_WIDTH;
          const parallaxCamX = isEditor ? editorCamX : camxShaken;
          const scroll = (parallaxCamX * factor) % imgW;
          // draw enough tiles to cover screen
          for (let x = -imgW; x < VIRTUAL_WIDTH + imgW; x += imgW) {
            vctx.drawImage(img, Math.round(x - scroll), Math.round(yOff));
          }
        }
      }

      // compute camera offset used by gameplay-only helpers (effects). World rendering in editor mode uses wxToS/wyToS.
      let camOffsetX = camxShaken - VIRTUAL_WIDTH / 2;
      if (!isEditor && RENDER.PIXEL_SNAP) camOffsetX = Math.round(camOffsetX);

      // compute visible segment range for culling (zoom-aware)
      const rightWorld = camXUsed + viewWorldW / 2;
      const leftIdx = Math.max(0, Math.floor(leftWorld) - RENDER.PADDING);
      const rightIdx = Math.min((currentLevel.segments && currentLevel.segments.length - 1) || 0, Math.ceil(rightWorld) + RENDER.PADDING);

      // draw terrain (filled polygon) only in visible range
      // Draw each continuous ground chunk separately so gaps (null heights) remain empty.
      // top-to-bottom ground gradient (white -> desaturated navy)
      let groundFill: CanvasPattern | CanvasGradient | string = '#2a6f3a';
      try {
        const groundGrad = vctx.createLinearGradient(0, 0, 0, VIRTUAL_HEIGHT);
        groundGrad.addColorStop(0, '#ffffff');
        groundGrad.addColorStop(1, '#2f4056');
        groundFill = groundGrad;
        vctx.fillStyle = groundFill;
      } catch (e) {
        groundFill = '#2a6f3a';
        vctx.fillStyle = groundFill as string;
      }
      const DEBUG_GAP_MARKERS = true; // temporary visual aid: draw marker at top when sampler returns null
      let inChunk = false;
      let chunkFirstX = 0; // world x of first sample in chunk
      let chunkLastX = 0; // world x of last sample in chunk
      for (let xi = leftIdx; xi <= rightIdx; xi++) {
        const sx = isEditor ? wxToS(xi) : (xi - camOffsetX);
        const hy = getHeightAtX(currentLevel as any, xi);
        if (hy === null) {
          if (DEBUG_GAP_MARKERS) {
            // small red marker at top to confirm sampler returned null here
            vctx.fillStyle = 'red';
            vctx.fillRect(Math.round(sx) - 1, 2, 2, 6);
            vctx.fillStyle = groundFill as any;
          }
          // gap: if we were drawing a chunk, close and fill it
          if (inChunk) {
            // finish polygon for this chunk
            const xEnd = isEditor ? wxToS(chunkLastX) : (chunkLastX - camOffsetX);
            const xStart = isEditor ? wxToS(chunkFirstX) : (chunkFirstX - camOffsetX);
            vctx.lineTo(xEnd, VIRTUAL_HEIGHT);
            vctx.lineTo(xStart, VIRTUAL_HEIGHT);
            vctx.closePath();
            vctx.fill();
            // draw a clipped procedural ice strip along the top edge of this chunk
            try {
              // compute top Y (smallest y) across the chunk in screen/virtual coords
              let topY: number | null = null;
              for (let xi_i = chunkFirstX; xi_i <= chunkLastX; xi_i++) {
                const hy_i = getHeightAtX(currentLevel as any, xi_i);
                if (hy_i === null) continue;
                const sy_i = isEditor ? wyToS(hy_i) : hy_i;
                topY = topY === null ? sy_i : Math.min(topY, sy_i);
              }
              if (topY !== null) {
                const iceH = 12; // thickness in virtual pixels
                const xStart = isEditor ? wxToS(chunkFirstX) : (chunkFirstX - camOffsetX);
                const xEnd = isEditor ? wxToS(chunkLastX) : (chunkLastX - camOffsetX);

                // recreate the top-edge polygon for clipping
                vctx.beginPath();
                {
                  const h0 = getHeightAtX(currentLevel as any, chunkFirstX) as number;
                  const sx0 = isEditor ? wxToS(chunkFirstX) : (chunkFirstX - camOffsetX);
                  const sy0 = isEditor ? wyToS(h0) : h0;
                  vctx.moveTo(sx0, sy0);
                }
                for (let sx_i = chunkFirstX + 1; sx_i <= chunkLastX; sx_i++) {
                  const hy_i = getHeightAtX(currentLevel as any, sx_i);
                  if (hy_i === null) break;
                  const sxp = isEditor ? wxToS(sx_i) : (sx_i - camOffsetX);
                  const syp = isEditor ? wyToS(hy_i) : hy_i;
                  vctx.lineTo(sxp, syp);
                }
                vctx.lineTo(xEnd, VIRTUAL_HEIGHT);
                vctx.lineTo(xStart, VIRTUAL_HEIGHT);
                vctx.closePath();

                vctx.save();
                vctx.clip();

                // vertical gradient for icy look
                const g = vctx.createLinearGradient(0, topY - iceH, 0, topY + 4);
                g.addColorStop(0, '#e6fbff');
                g.addColorStop(0.5, '#cfeeff');
                g.addColorStop(1, 'rgba(200,240,255,0)');
                vctx.fillStyle = g;

                // draw a smoothed ice band following the top surface with variable thickness
                try {
                  const sampleStep = 1; // finer sampling for denser ice detail
                  const pts: { sx: number; sy: number; t: number }[] = [];
                  const base = 20; // thicker base thickness (wider ice)
                  for (let wx = chunkFirstX; wx <= chunkLastX; wx += sampleStep) {
                    const hy_w = getHeightAtX(currentLevel as any, wx);
                    if (hy_w === null) continue;
                    const sx_w = isEditor ? wxToS(wx) : (wx - camOffsetX);
                    const sy_w = isEditor ? wyToS(hy_w) : hy_w;
                    // stronger, more frequent variation: higher-frequency sine waves
                    const t = base + Math.sin(wx * 0.5) * 10 + Math.sin(wx * 0.12) * 6;
                    pts.push({ sx: Math.round(sx_w), sy: sy_w, t });
                  }
                  if (pts.length >= 2) {
                    // determine gradient bounds
                    let minY = Number.POSITIVE_INFINITY;
                    let maxY = Number.NEGATIVE_INFINITY;
                    for (const p of pts) {
                      minY = Math.min(minY, p.sy - p.t);
                      maxY = Math.max(maxY, p.sy);
                    }
                    const g2 = vctx.createLinearGradient(0, minY, 0, maxY + 4);
                    g2.addColorStop(0, '#e6fbff');
                    g2.addColorStop(0.5, '#cfeeff');
                    g2.addColorStop(1, 'rgba(200,240,255,0)');
                    vctx.fillStyle = g2;

                    vctx.beginPath();
                    // upper edge (ice top)
                    for (let i = 0; i < pts.length; i++) {
                      const p = pts[i];
                      const y = p.sy - p.t;
                      if (i === 0) vctx.moveTo(p.sx, y);
                      else vctx.lineTo(p.sx, y);
                    }
                    // lower edge (surface) back to start
                    for (let i = pts.length - 1; i >= 0; i--) {
                      const p = pts[i];
                      vctx.lineTo(p.sx, p.sy);
                    }
                    vctx.closePath();
                    vctx.fill();
                    // add a subtle glossy highlight along the top edge
                    try {
                      vctx.beginPath();
                      for (let i = 0; i < pts.length; i++) {
                        const p = pts[i];
                        const y = p.sy - p.t + 1; // slightly offset from top
                        if (i === 0) vctx.moveTo(p.sx, y);
                        else vctx.lineTo(p.sx, y);
                      }
                      vctx.strokeStyle = 'rgba(255,255,255,0.45)';
                      vctx.lineWidth = 1;
                      vctx.stroke();
                    } catch (e) {
                      /* ignore highlight errors */
                    }
                  }
                } catch (e) {
                  // fallback already handled
                }

                vctx.restore();
              }
            } catch (e) {
              // safe fallback: ignore ice rendering errors
            }
            // stroke the top edge with an icy look: darker base + light highlight
            try {
              const pts: { x: number; y: number }[] = [];
              for (let sx_i = chunkFirstX; sx_i <= chunkLastX; sx_i++) {
                const hy_i = getHeightAtX(currentLevel as any, sx_i);
                if (hy_i === null) break;
                const sxp = isEditor ? wxToS(sx_i) : (sx_i - camOffsetX);
                const syp = isEditor ? wyToS(hy_i) : hy_i;
                pts.push({ x: Math.round(sxp), y: syp });
              }
              if (pts.length >= 2) {
                // darker subtle bluish shadow line
                vctx.beginPath();
                vctx.lineWidth = 2;
                vctx.strokeStyle = 'rgba(0,60,90,0.35)';
                vctx.moveTo(pts[0].x, pts[0].y);
                for (let i = 1; i < pts.length; i++) vctx.lineTo(pts[i].x, pts[i].y);
                vctx.stroke();
                // light icy highlight
                vctx.beginPath();
                vctx.lineWidth = 1;
                vctx.strokeStyle = 'rgba(170,220,255,0.95)';
                vctx.moveTo(pts[0].x, pts[0].y - 0.5);
                for (let i = 1; i < pts.length; i++) vctx.lineTo(pts[i].x, pts[i].y - 0.5);
                vctx.stroke();
              }
            } catch (e) {
              /* ignore stroke errors */
            }
            vctx.beginPath();
            inChunk = false;
          }
          continue;
        }

        if (!inChunk) {
          // start a new chunk
          chunkFirstX = xi;
          chunkLastX = xi;
          vctx.beginPath();
          vctx.moveTo(sx, isEditor ? wyToS(hy) : hy);
          inChunk = true;
        } else {
          // continue current chunk
          vctx.lineTo(sx, isEditor ? wyToS(hy) : hy);
          chunkLastX = xi;
        }
      }

      if (inChunk) {
        // close and fill the final chunk
        const xEnd = isEditor ? wxToS(chunkLastX) : (chunkLastX - camOffsetX);
        const xStart = isEditor ? wxToS(chunkFirstX) : (chunkFirstX - camOffsetX);
        vctx.lineTo(xEnd, VIRTUAL_HEIGHT);
        vctx.lineTo(xStart, VIRTUAL_HEIGHT);
        vctx.closePath();
        vctx.fill();
        // draw procedural ice strip for final chunk (same logic as above)
        try {
          let topY: number | null = null;
          for (let xi_i = chunkFirstX; xi_i <= chunkLastX; xi_i++) {
            const hy_i = getHeightAtX(currentLevel as any, xi_i);
            if (hy_i === null) continue;
            const sy_i = isEditor ? wyToS(hy_i) : hy_i;
            topY = topY === null ? sy_i : Math.min(topY, sy_i);
          }
          if (topY !== null) {
            const iceH = 12;
            const sxStart = isEditor ? wxToS(chunkFirstX) : (chunkFirstX - camOffsetX);
            const sxEnd = isEditor ? wxToS(chunkLastX) : (chunkLastX - camOffsetX);

            vctx.beginPath();
            {
              const h0 = getHeightAtX(currentLevel as any, chunkFirstX) as number;
              const sx0 = isEditor ? wxToS(chunkFirstX) : (chunkFirstX - camOffsetX);
              const sy0 = isEditor ? wyToS(h0) : h0;
              vctx.moveTo(sx0, sy0);
            }
            for (let sx_i = chunkFirstX + 1; sx_i <= chunkLastX; sx_i++) {
              const hy_i = getHeightAtX(currentLevel as any, sx_i);
              if (hy_i === null) break;
              const sxp = isEditor ? wxToS(sx_i) : (sx_i - camOffsetX);
              const syp = isEditor ? wyToS(hy_i) : hy_i;
              vctx.lineTo(sxp, syp);
            }
            vctx.lineTo(sxEnd, VIRTUAL_HEIGHT);
            vctx.lineTo(sxStart, VIRTUAL_HEIGHT);
            vctx.closePath();

            vctx.save();
            vctx.clip();

            const g = vctx.createLinearGradient(0, topY - iceH, 0, topY + 4);
            g.addColorStop(0, '#e6fbff');
            g.addColorStop(0.5, '#cfeeff');
            g.addColorStop(1, 'rgba(200,240,255,0)');
            vctx.fillStyle = g;

            // draw a smoothed ice band for the final chunk (variable thickness)
            try {
              const sampleStep = 1;
              const pts: { sx: number; sy: number; t: number }[] = [];
              const base = 20;
              for (let wx = chunkFirstX; wx <= chunkLastX; wx += sampleStep) {
                const hy_w = getHeightAtX(currentLevel as any, wx);
                if (hy_w === null) continue;
                const sx_w = isEditor ? wxToS(wx) : (wx - camOffsetX);
                const sy_w = isEditor ? wyToS(hy_w) : hy_w;
                // stronger, more frequent variation: higher-frequency sine waves
                const t = base + Math.sin(wx * 0.5) * 10 + Math.sin(wx * 0.12) * 6;
                pts.push({ sx: Math.round(sx_w), sy: sy_w, t });
              }
              if (pts.length >= 2) {
                let minY = Number.POSITIVE_INFINITY;
                let maxY = Number.NEGATIVE_INFINITY;
                for (const p of pts) {
                  minY = Math.min(minY, p.sy - p.t);
                  maxY = Math.max(maxY, p.sy);
                }
                const g2 = vctx.createLinearGradient(0, minY, 0, maxY + 4);
                g2.addColorStop(0, '#e6fbff');
                g2.addColorStop(0.5, '#cfeeff');
                g2.addColorStop(1, 'rgba(200,240,255,0)');
                vctx.fillStyle = g2;

                vctx.beginPath();
                for (let i = 0; i < pts.length; i++) {
                  const p = pts[i];
                  const y = p.sy - p.t;
                  if (i === 0) vctx.moveTo(p.sx, y);
                  else vctx.lineTo(p.sx, y);
                }
                for (let i = pts.length - 1; i >= 0; i--) {
                  const p = pts[i];
                  vctx.lineTo(p.sx, p.sy);
                }
                vctx.closePath();
                vctx.fill();
                try {
                  vctx.beginPath();
                  for (let i = 0; i < pts.length; i++) {
                    const p = pts[i];
                    const y = p.sy - p.t + 1;
                    if (i === 0) vctx.moveTo(p.sx, y);
                    else vctx.lineTo(p.sx, y);
                  }
                  vctx.strokeStyle = 'rgba(255,255,255,0.45)';
                  vctx.lineWidth = 1;
                  vctx.stroke();
                } catch (e) {
                  /* ignore highlight errors */
                }
              }
            } catch (e) {
              // ignore
            }

            vctx.restore();
          }
        } catch (e) {
          // ignore
        }
        // stroke top edge of final chunk with icy look (shadow + highlight)
        try {
          const pts2: { x: number; y: number }[] = [];
          for (let sx_i = chunkFirstX; sx_i <= chunkLastX; sx_i++) {
            const hy_i = getHeightAtX(currentLevel as any, sx_i);
            if (hy_i === null) break;
            const sxp = isEditor ? wxToS(sx_i) : (sx_i - camOffsetX);
            const syp = isEditor ? wyToS(hy_i) : hy_i;
            pts2.push({ x: Math.round(sxp), y: syp });
          }
              if (pts2.length >= 2) {
                vctx.beginPath();
                vctx.lineWidth = 2;
                vctx.strokeStyle = 'rgba(0,60,90,0.35)';
                vctx.moveTo(pts2[0].x, pts2[0].y);
                for (let i = 1; i < pts2.length; i++) vctx.lineTo(pts2[i].x, pts2[i].y);
                vctx.stroke();

                vctx.beginPath();
                vctx.lineWidth = 1;
                vctx.strokeStyle = 'rgba(170,220,255,0.95)';
                vctx.moveTo(pts2[0].x, pts2[0].y - 0.5);
                for (let i = 1; i < pts2.length; i++) vctx.lineTo(pts2[i].x, pts2[i].y - 0.5);
                vctx.stroke();
              }
        } catch (e) {
          /* ignore */
        }
        vctx.beginPath();
      }

      // draw level objects (start/checkpoint/finish) culling to visible range
      for (const obj of currentLevel.objects || []) {
        if (obj.x < leftIdx - 1 || obj.x > rightIdx + 1) continue;
        const hx = isEditor ? wxToS(obj.x) : (obj.x - camOffsetX);
        const hyWorld = getHeightAtX(currentLevel as any, obj.x);
        const hy = hyWorld !== null ? (isEditor ? wyToS(hyWorld) : hyWorld) : (VIRTUAL_HEIGHT / 2);
        if (obj.type === 'start') {
          vctx.fillStyle = '#ffd700';
          vctx.fillRect(Math.round(hx) - 4, Math.round(hy) - 12, 8, 8);
        } else if (obj.type === 'checkpoint') {
          vctx.fillStyle = '#00bfff';
          vctx.fillRect(Math.round(hx) - 3, Math.round(hy) - 16, 6, 12);
        } else if (obj.type === 'finish') {
          vctx.fillStyle = '#ff4d6d';
          vctx.beginPath();
          vctx.moveTo(Math.round(hx), Math.round(hy) - 14);
          vctx.lineTo(Math.round(hx) + 6, Math.round(hy));
          vctx.lineTo(Math.round(hx) - 6, Math.round(hy));
          vctx.closePath();
          vctx.fill();
        }
      }

      // player draw (sprite if available, otherwise simple placeholder)
      const px = Math.round(isEditor ? wxToS(ix) : (ix - camOffsetX));
      const py = Math.round((isEditor ? wyToS(iy) : iy) - (shakeY || 0));
      // cull off-screen player draws for performance
      if (px >= -64 && px <= VIRTUAL_WIDTH + 64) {
        if (playerEntity) {
          // choose animation state based on player physics
          let pstate = 'idle';
          if (!currPlayer.grounded) {
            pstate = currPlayer.vy < 0 ? 'jump' : 'fall';
          } else {
            pstate = currPlayer.vx > 20 ? 'run' : 'idle';
            // speed lines / motion streaks
            try {
              effects.onSpeed(currPlayer.x, currPlayer.y, currPlayer.vx);
            } catch (e) {
              /* ignore */
            }
          }
          const flip = currPlayer.vx < 0;
          playerEntity.play(pstate);
          // collect draw descriptors and perform a batched draw pass grouped by source image
          const descs = playerEntity.collectDrawDescriptors(px, py, { anchor: 'bottom', scale: 1, flip });
          const groups = new Map<HTMLImageElement, typeof descs>();
          for (const d of descs) {
            if (!d.img) continue;
            let g = groups.get(d.img);
            if (!g) {
              g = [] as typeof descs;
              groups.set(d.img, g);
            }
            g.push(d);
          }
          for (const [img, items] of groups) {
            for (const it of items) {
              vctx.save();
              vctx.globalAlpha = it.alpha;
              if (it.flip) {
                vctx.translate(it.dx + it.dw / 2, 0);
                vctx.scale(-1, 1);
                vctx.translate(-(it.dx + it.dw / 2), 0);
              }
              vctx.drawImage(img, it.sx, it.sy, it.sw, it.sh, it.dx, it.dy, it.dw, it.dh);
              vctx.restore();
            }
          }
        } else {
          // placeholder: treat `py` as the player's bottom so the square sits on the ground
          vctx.fillStyle = '#fff';
          vctx.fillRect(px - 8, py - 16, 16, 16);
        }

      }

      // draw effects (particles) after main scene but before overlays
      if (!isEditor) {
        try {
          effects.draw(vctx, camOffsetX, shakeY || 0);
        } catch (e) {
          /* ignore */
        }
      }

      // landing flash overlay
      if (landingFlash > 0) {
        vctx.save();
        vctx.globalAlpha = Math.min(1, landingFlash / 0.12) * 0.6;
        vctx.fillStyle = '#fff';
        vctx.fillRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
        vctx.restore();
      }

      // crash fade overlay (black fade on crash)
      if (crashFade > 0) {
        vctx.save();
        const a = Math.min(1, crashFade / 0.6);
        vctx.globalAlpha = a;
        vctx.fillStyle = '#000';
        vctx.fillRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
        vctx.restore();
      }

      // debug overlay (top-left)
      vctx.fillStyle = 'rgba(0,0,0,0.6)';
      vctx.fillRect(6, 6, 200, 78);
      vctx.fillStyle = '#fff';
      vctx.font = '12px monospace';
      vctx.fillText(`FPS: ${fps.toFixed(1)}`, 12, 22);
      vctx.fillText(`Player: x=${ix.toFixed(1)} y=${iy.toFixed(1)}`, 12, 36);
      vctx.fillText(`Vel: vx=${currPlayer.vx.toFixed(1)} vy=${currPlayer.vy.toFixed(1)}`, 12, 50);
      vctx.fillText(`Grounded: ${currPlayer.grounded}`, 12, 64);
      vctx.fillText(`Slope:${lastSlope.toFixed(3)} eff:${lastSlopeEff.toFixed(3)}`, 12, 78);
      vctx.fillText(`Acc raw:${lastAccelRaw.toFixed(1)} scaled:${lastAccelScaled.toFixed(1)} ${lastAccelScaled >= 0 ? '+' : '-'}`, 12, 92);
      vctx.fillText(`CamX: ${camx.toFixed(1)}`, 12, 106);

      vctx.fillStyle = '#fff';
      vctx.font = '14px monospace';
      vctx.fillText(`Virtual ${VIRTUAL_WIDTH}×${VIRTUAL_HEIGHT} — interpolated render`, 8, 18);

      // UI overlays for non-playing states
      if (stateRef.current === 'title') {
        vctx.fillStyle = 'rgba(0,0,0,0.7)';
        vctx.fillRect(0, VIRTUAL_HEIGHT / 2 - 48, VIRTUAL_WIDTH, 96);
        vctx.fillStyle = '#fff';
        vctx.font = '28px monospace';
        vctx.textAlign = 'center';
        vctx.fillText('Super Sled Fox', VIRTUAL_WIDTH / 2, VIRTUAL_HEIGHT / 2 - 6);
        vctx.font = '14px monospace';
        vctx.fillText('Press SPACE to Start', VIRTUAL_WIDTH / 2, VIRTUAL_HEIGHT / 2 + 18);
        vctx.textAlign = 'left';
      } else if (stateRef.current === 'paused') {
        vctx.fillStyle = 'rgba(0,0,0,0.6)';
        vctx.fillRect(VIRTUAL_WIDTH / 2 - 120, VIRTUAL_HEIGHT / 2 - 36, 240, 72);
        vctx.fillStyle = '#fff';
        vctx.font = '24px monospace';
        vctx.textAlign = 'center';
        vctx.fillText('PAUSED', VIRTUAL_WIDTH / 2, VIRTUAL_HEIGHT / 2 + 6);
        vctx.textAlign = 'left';
      } else if (stateRef.current === 'dead') {
        vctx.fillStyle = 'rgba(0,0,0,0.7)';
        vctx.fillRect(VIRTUAL_WIDTH / 2 - 160, VIRTUAL_HEIGHT / 2 - 48, 320, 96);
        vctx.fillStyle = '#fff';
        vctx.font = '20px monospace';
        vctx.textAlign = 'center';
        vctx.fillText('You Died', VIRTUAL_WIDTH / 2, VIRTUAL_HEIGHT / 2 - 2);
        vctx.font = '12px monospace';
        vctx.fillText('Press R to Respawn', VIRTUAL_WIDTH / 2, VIRTUAL_HEIGHT / 2 + 18);
        vctx.textAlign = 'left';
      } else if (stateRef.current === 'complete') {
        const isLastLevel = currentLevelIndex + 1 >= LEVELS.length;
        vctx.fillStyle = 'rgba(0,0,0,0.85)';
        vctx.fillRect(0, VIRTUAL_HEIGHT / 2 - 64, VIRTUAL_WIDTH, 128);
        vctx.fillStyle = '#fff';
        vctx.font = '26px monospace';
        vctx.textAlign = 'center';
        if (isLastLevel) {
          vctx.fillText('You Beat The Game — Thanks!', VIRTUAL_WIDTH / 2, VIRTUAL_HEIGHT / 2 - 4);
          vctx.font = '14px monospace';
          vctx.fillText('Press R to Restart', VIRTUAL_WIDTH / 2, VIRTUAL_HEIGHT / 2 + 22);
        } else {
          vctx.fillText('Level Complete — Well done!', VIRTUAL_WIDTH / 2, VIRTUAL_HEIGHT / 2 - 4);
          vctx.font = '14px monospace';
          vctx.fillText('Press SPACE to Continue', VIRTUAL_WIDTH / 2, VIRTUAL_HEIGHT / 2 + 22);
        }
        vctx.textAlign = 'left';
      }

      // loading overlay
      if (stateRef.current === 'loading') {
        vctx.fillStyle = 'rgba(0,0,0,0.8)';
        vctx.fillRect(0, VIRTUAL_HEIGHT / 2 - 24, VIRTUAL_WIDTH, 48);
        vctx.fillStyle = '#fff';
        vctx.font = '16px monospace';
        vctx.textAlign = 'center';
        vctx.fillText('Loading...', VIRTUAL_WIDTH / 2, VIRTUAL_HEIGHT / 2 + 6);
        vctx.textAlign = 'left';
      }

      // transient restart hint (shows briefly after starting a new level)
      if (restartHintTimer > 0) {
        vctx.save();
        const alpha = Math.min(1, restartHintTimer / 2.5);
        vctx.globalAlpha = alpha;
        vctx.fillStyle = 'rgba(0,0,0,0.8)';
        const bw = 220;
        const bh = 20;
        vctx.fillRect(VIRTUAL_WIDTH / 2 - bw / 2, 8, bw, bh);
        vctx.fillStyle = '#fff';
        vctx.font = '12px monospace';
        vctx.textAlign = 'center';
        vctx.fillText('Press R to Restart', VIRTUAL_WIDTH / 2, 8 + 14);
        vctx.textAlign = 'left';
        vctx.restore();
      }

      // Editor mode indicator (visible only when in editor state)
      if (stateRef.current === 'editor') {
        vctx.save();
        const bw = 100;
        const bh = 22;
        const bx = VIRTUAL_WIDTH - bw - 10;
        const by = 8;
        vctx.fillStyle = 'rgba(0,0,0,0.55)';
        vctx.fillRect(bx, by, bw, bh);
        vctx.strokeStyle = 'rgba(255,215,0,0.9)';
        vctx.strokeRect(bx, by, bw, bh);
        vctx.fillStyle = '#ffd700';
        vctx.font = '12px monospace';
        vctx.textAlign = 'center';
        vctx.fillText('EDITOR MODE', bx + bw / 2, by + 15);
        vctx.textAlign = 'left';
        vctx.restore();
      }

      // call editor overlay renderer if present
      try {
        if (typeof editorStop !== 'undefined' && editorStop && (editorStop as any).renderOverlay) {
          if (stateRef.current === 'editor') {
            // Editor overlay expects a world window origin (left/top), not camera center.
            // Provide the same view window the renderer is using so overlay sticks to ground under pan/zoom.
            const viewW = VIRTUAL_WIDTH / Math.max(0.0001, editorZoom);
            const viewH = VIRTUAL_HEIGHT / Math.max(0.0001, editorZoom);
            const left = editorCamX - viewW / 2;
            const top = editorCamY - viewH / 2;
            (editorStop as any).renderOverlay(vctx, left, top, viewW, viewH);
          } else {
            // Gameplay camera origin (left/top) for consistency
            (editorStop as any).renderOverlay(vctx, camOffsetX, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
          }
        }
      } catch (e) {
        // ignore overlay errors
      }

      // compute scale to fit window while preserving aspect ratio (letterboxing)
      const scale = Math.min(window.innerWidth / VIRTUAL_WIDTH, window.innerHeight / VIRTUAL_HEIGHT);
      const destW = Math.round(VIRTUAL_WIDTH * scale);
      const destH = Math.round(VIRTUAL_HEIGHT * scale);
      const destX = Math.round((window.innerWidth - destW) / 2);
      const destY = Math.round((window.innerHeight - destH) / 2);
      const dpr = window.devicePixelRatio || 1;

      // clear full backing store (in device pixels) to black for letterboxing bars
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      // disable smoothing and draw the virtual canvas scaled to backing store
      ctx.imageSmoothingEnabled = false;
      vctx.imageSmoothingEnabled = false;
      ctx.drawImage(vcanvas, 0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT, destX * dpr, destY * dpr, destW * dpr, destH * dpr);
    }

    // layout setup
    function resize() {
      const dpr = window.devicePixelRatio || 1;
      canvasEl.width = Math.round(window.innerWidth * dpr);
      canvasEl.height = Math.round(window.innerHeight * dpr);
      canvasEl.style.width = `${window.innerWidth}px`;
      canvasEl.style.height = `${window.innerHeight}px`;
      ctx.imageSmoothingEnabled = false;
      vctx.imageSmoothingEnabled = false;
    }

    resize();
    window.addEventListener('resize', resize);

    // input manager
    const input = new InputManager();
    input.start();

    // fixed timestep rAF loop with accumulator
    let rafId = 0;
    let lastTime = performance.now();
    let accumulator = 0;
    const FIXED_DT = 1 / 60;
    let lastGameState: GameState = stateRef.current;

    function loop(now: number) {
      // pause sim when page is hidden
      if (document.hidden) {
        lastTime = now;
        rafId = requestAnimationFrame(loop);
        return;
      }

      let delta = (now - lastTime) / 1000;
      if (delta > 0.25) delta = 0.25; // clamp to avoid spiral of death
      // update a smoothed FPS estimate
      if (delta > 0) fps += (1 / delta - fps) * 0.08;
      // decay landing flash timer
      landingFlash = Math.max(0, landingFlash - delta);
      // decay transient restart hint timer
      restartHintTimer = Math.max(0, (restartHintTimer || 0) - delta);
      // handle crash/death timers (fade only) even when not playing
      if (stateRef.current === 'dead') {
        if (crashTimer > 0) {
          crashTimer -= delta;
          crashFade = Math.max(0, crashFade - delta);
        } else {
          // no auto-respawn; wait for user to press `R` to respawn
        }
      }
      lastTime = now;
      accumulator += delta;
      // handle global input for state changes (pause, restart, start)
      const escPressed = input.get('Escape').wasPressed;
      const rPressed = input.get('r').wasPressed;
      const startPressed = input.get(' ').wasPressed;
      const crashKey = input.get('k').wasPressed;
      const ePressed = input.get('e').wasPressed;
      if (startPressed) {
        // Only capture a snapshot for missed-press handling when the player is
        // currently grounded. We shouldn't record a 'missed' press while
        // airborne because that would later trigger forced jumps incorrectly.
        if (currPlayer.grounded) {
          spacePressSnapshot = {
            t: performance.now(),
            state: stateRef.current,
            grounded: currPlayer.grounded,
            wasGrounded: currPlayer.wasGrounded,
            coyoteTimer,
            jumpBuffer,
            jumpLock,
            vy: currPlayer.vy,
            y: currPlayer.y,
          };
          // If we appear grounded now and contact samples from the last simulate show
          // we're near the ground, request an immediate jump to be applied inside
          // the next physics step to avoid missing the transient wasPressed edge.
          if (stateRef.current === 'playing' && spacePressSnapshot.grounded && jumpLock <= 0 && lastContactBack !== null && lastContactFront !== null && lastNearGround) {
            pendingImmediateJump = true;
            // eslint-disable-next-line no-console
            console.log('[jump-debug] requested pendingImmediateJump from main loop', { t: performance.now(), press: spacePressSnapshot });
          }
        }
      }
      if (rPressed) {
        // force respawn / restart
        respawn();
      }

      // dev test: press K to simulate a crash
      if (crashKey) triggerCrash();

      // toggle pause/resume
      if (escPressed) {
        if (stateRef.current === 'playing') stateRef.current = 'paused';
        else if (stateRef.current === 'paused') stateRef.current = 'playing';
      }

      // start from title
      if (stateRef.current === 'title' && startPressed) {
        respawn();
        stateRef.current = 'playing';
      }

      // continue to next level from complete when SPACE pressed
      if (stateRef.current === 'complete' && startPressed) {
        const nextIdx = currentLevelIndex + 1;
        if (nextIdx < LEVELS.length) {
          // show loading state while switching levels
          stateRef.current = 'loading';
          loadLevelByIndex(nextIdx).then(() => {
            // only resume play if still in loading state
            if (stateRef.current === 'loading') stateRef.current = 'playing';
          });
        } else {
          // no next level: restart current level
          respawn();
          stateRef.current = 'playing';
        }
      }

      // toggle editor state when compile-time enabled
      if (ePressed && typeof EDITOR_ENABLED !== 'undefined' && EDITOR_ENABLED) {
        if (stateRef.current !== 'editor') {
          lastNonEditorState = stateRef.current;
          stateRef.current = 'editor';
        } else {
          stateRef.current = lastNonEditorState || 'title';
        }
      }

      // detect simple game-state transitions and reset timing to avoid large accumulator
      if (lastGameState !== stateRef.current) {
        lastGameState = stateRef.current;
        // prevent interpolation artifacts by syncing snapshots
        prevPlayer = { ...currPlayer };
        prevCam = { ...currCam };
        accumulator = 0;
        lastTime = now;
        // start/stop editor when entering/exiting editor state
        try {
          const canvasElInner = canvasRef.current!;
          if (typeof EDITOR_ENABLED !== 'undefined' && EDITOR_ENABLED) {
            if (stateRef.current === 'editor') {
              if (!editorStop) {
                // initialize editor camera from gameplay cam/player
                editorCamX = currCam.x;
                editorCamY = currPlayer.y || VIRTUAL_HEIGHT / 2;
                editorZoom = lastEditorZoom || 1;
                canvasElInner.dataset.editorActive = '1';
                // screenToWorld maps client pixels -> virtual coords -> world coords
                const screenToWorldFn = (clientX: number, clientY: number) => {
                  // convert client -> virtual canvas coords (px,py)
                  const scale = Math.min(window.innerWidth / VIRTUAL_WIDTH, window.innerHeight / VIRTUAL_HEIGHT);
                  const destW = VIRTUAL_WIDTH * scale;
                  const destH = VIRTUAL_HEIGHT * scale;
                  const destX = (window.innerWidth - destW) / 2;
                  const destY = (window.innerHeight - destH) / 2;
                  const px = (clientX - destX) / scale;
                  const py = (clientY - destY) / scale;
                  // when in editor mode, convert virtual px/py -> world using editor cam + zoom
                  const wx = (px - VIRTUAL_WIDTH / 2) / editorZoom + editorCamX;
                  const wy = (py - VIRTUAL_HEIGHT / 2) / editorZoom + editorCamY;
                  return { x: wx, y: wy };
                };

                editorStop = startEditor({
                  canvas: canvasElInner,
                  screenToWorld: screenToWorldFn,
                  level: currentLevel as any,
                  onChange() {
                    // noop for now; could mark level dirty
                  },
                });

                // Export / Import UI (only present while editor active)
                const exportBtn = document.createElement('button');
                exportBtn.textContent = 'Export Level';
                exportBtn.style.position = 'fixed';
                exportBtn.style.right = '12px';
                exportBtn.style.bottom = '12px';
                exportBtn.style.zIndex = '9999';
                exportBtn.style.padding = '6px 8px';
                exportBtn.style.background = '#222';
                exportBtn.style.color = '#ffd700';
                document.body.appendChild(exportBtn);

                const fileInput = document.createElement('input');
                fileInput.type = 'file';
                fileInput.accept = 'application/json';
                fileInput.style.display = 'none';
                document.body.appendChild(fileInput);

                const importBtn = document.createElement('button');
                importBtn.textContent = 'Import Level';
                importBtn.style.position = 'fixed';
                importBtn.style.right = '120px';
                importBtn.style.bottom = '12px';
                importBtn.style.zIndex = '9999';
                importBtn.style.padding = '6px 8px';
                importBtn.style.background = '#222';
                importBtn.style.color = '#fff';
                document.body.appendChild(importBtn);

                const showError = (msg: string) => {
                  const el = document.createElement('div');
                  el.textContent = msg;
                  el.style.position = 'fixed';
                  el.style.left = '12px';
                  el.style.bottom = '12px';
                  el.style.background = 'rgba(0,0,0,0.8)';
                  el.style.color = '#fff';
                  el.style.padding = '8px 12px';
                  el.style.zIndex = '9999';
                  document.body.appendChild(el);
                  setTimeout(() => el.remove(), 4000);
                };

                exportBtn.addEventListener('click', () => {
                  try {
                    const dataStr = JSON.stringify(currentLevel, null, 2);
                    const blob = new Blob([dataStr], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = (currentLevel.meta && currentLevel.meta.title ? currentLevel.meta.title.replace(/[^a-z0-9]/gi, '_') : 'level') + '.json';
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    URL.revokeObjectURL(url);
                  } catch (e) {
                    showError('Export failed');
                  }
                });

                importBtn.addEventListener('click', () => fileInput.click());
                fileInput.addEventListener('change', (ev) => {
                  const f = (ev.target as HTMLInputElement).files?.[0];
                  if (!f) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    try {
                      const parsed = JSON.parse(String(reader.result));
                      // TODO: migrateLevel if needed (not implemented yet)
                      const v = validateLevel(parsed as any);
                      if (!v.ok) { showError('Invalid level: ' + v.reason); return; }
                      // accept and replace current level
                      Object.assign(currentLevel, parsed);
                      showError('Level imported');
                    } catch (e) {
                      showError('Import failed');
                    }
                  };
                  reader.readAsText(f);
                });

                // drag & drop support
                const onDrop = (ev: DragEvent) => {
                  if (stateRef.current !== 'editor') return;
                  ev.preventDefault();
                  const f = ev.dataTransfer?.files?.[0];
                  if (!f) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    try {
                      const parsed = JSON.parse(String(reader.result));
                      const v = validateLevel(parsed as any);
                      if (!v.ok) { showError('Invalid level: ' + v.reason); return; }
                      Object.assign(currentLevel, parsed);
                      showError('Level imported');
                    } catch (e) {
                      showError('Import failed');
                    }
                  };
                  reader.readAsText(f);
                };
                const onDragOver = (ev: DragEvent) => { if (stateRef.current === 'editor') ev.preventDefault(); };
                window.addEventListener('drop', onDrop);
                window.addEventListener('dragover', onDragOver);

                // attach to editor handlers for cleanup
                (editorStop as any).__exportImportNodes = { exportBtn, importBtn, fileInput, onDrop, onDragOver };

                // wheel zoom handler (anchor zoom at cursor)
                const wheelHandler = (ev: WheelEvent) => {
                  if (stateRef.current !== 'editor') return;
                  ev.preventDefault();
                  // client -> virtual px/py
                  const scale = Math.min(window.innerWidth / VIRTUAL_WIDTH, window.innerHeight / VIRTUAL_HEIGHT);
                  const destW = VIRTUAL_WIDTH * scale;
                  const destH = VIRTUAL_HEIGHT * scale;
                  const destX = (window.innerWidth - destW) / 2;
                  const destY = (window.innerHeight - destH) / 2;
                  const px = (ev.clientX - destX) / scale;
                  const py = (ev.clientY - destY) / scale;
                  // world under cursor before zoom
                  const worldBeforeX = (px - VIRTUAL_WIDTH / 2) / editorZoom + editorCamX;
                  const worldBeforeY = (py - VIRTUAL_HEIGHT / 2) / editorZoom + editorCamY;
                  // delta from wheel: use exponential scale
                  const factor = Math.pow(1.1, -ev.deltaY / 100);
                  let newZoom = editorZoom * factor;
                  newZoom = Math.max(EDITOR_ZOOM_MIN, Math.min(EDITOR_ZOOM_MAX, newZoom));
                  // adjust camera so worldUnderCursor stays stable
                  editorCamX = worldBeforeX - (px - VIRTUAL_WIDTH / 2) / newZoom;
                  editorCamY = worldBeforeY - (py - VIRTUAL_HEIGHT / 2) / newZoom;
                  editorZoom = newZoom;
                  lastEditorZoom = editorZoom;
                };
                window.addEventListener('wheel', wheelHandler, { passive: false });

                // pointer pan handler (middle or right button drag)
                let panPointerId: number | null = null;
                let panLastPx = 0;
                let panLastPy = 0;
                const onPointerDownPan = (ev: PointerEvent) => {
                  if (stateRef.current !== 'editor') return;
                  if (ev.button !== 1 && ev.button !== 2) return; // middle or right
                  try { (ev.target as Element).setPointerCapture(ev.pointerId); } catch (e) { }
                  panPointerId = ev.pointerId;
                  const scale = Math.min(window.innerWidth / VIRTUAL_WIDTH, window.innerHeight / VIRTUAL_HEIGHT);
                  const destW = VIRTUAL_WIDTH * scale;
                  const destH = VIRTUAL_HEIGHT * scale;
                  const destX = (window.innerWidth - destW) / 2;
                  const destY = (window.innerHeight - destH) / 2;
                  panLastPx = (ev.clientX - destX) / scale;
                  panLastPy = (ev.clientY - destY) / scale;
                };
                const onPointerMovePan = (ev: PointerEvent) => {
                  if (stateRef.current !== 'editor') return;
                  if (panPointerId !== ev.pointerId) return;
                  const scale = Math.min(window.innerWidth / VIRTUAL_WIDTH, window.innerHeight / VIRTUAL_HEIGHT);
                  const destW = VIRTUAL_WIDTH * scale;
                  const destH = VIRTUAL_HEIGHT * scale;
                  const destX = (window.innerWidth - destW) / 2;
                  const destY = (window.innerHeight - destH) / 2;
                  const px = (ev.clientX - destX) / scale;
                  const py = (ev.clientY - destY) / scale;
                  const dx = px - panLastPx;
                  const dy = py - panLastPy;
                  panLastPx = px;
                  panLastPy = py;
                  // move editor cam by delta / zoom
                  editorCamX -= dx / editorZoom;
                  editorCamY -= dy / editorZoom;
                };
                const onPointerUpPan = (ev: PointerEvent) => {
                  if (panPointerId !== ev.pointerId) return;
                  panPointerId = null;
                  try { (ev.target as Element).releasePointerCapture(ev.pointerId); } catch (e) { }
                };
                canvasElInner.addEventListener('pointerdown', onPointerDownPan);
                window.addEventListener('pointermove', onPointerMovePan);
                window.addEventListener('pointerup', onPointerUpPan);

                // keydown handler for keyboard zoom/reset
                const keydownHandler = (ev: KeyboardEvent) => {
                  if (stateRef.current !== 'editor') return;
                  if (ev.key === '=' || ev.key === '+') {
                    let newZoom = Math.max(EDITOR_ZOOM_MIN, Math.min(EDITOR_ZOOM_MAX, editorZoom * 1.1));
                    editorZoom = newZoom; lastEditorZoom = editorZoom;
                  } else if (ev.key === '-') {
                    let newZoom = Math.max(EDITOR_ZOOM_MIN, Math.min(EDITOR_ZOOM_MAX, editorZoom / 1.1));
                    editorZoom = newZoom; lastEditorZoom = editorZoom;
                  } else if (ev.key === 'z') {
                    editorZoom = 1; lastEditorZoom = 1; editorCamX = currPlayer.x; editorCamY = currPlayer.y || VIRTUAL_HEIGHT / 2;
                  }
                };
                window.addEventListener('keydown', keydownHandler);

                // store these handlers on editorStop so we can remove them when stopping
                (editorStop as any).__editorHandlers = { wheelHandler, onPointerDownPan, onPointerMovePan, onPointerUpPan, keydownHandler };
              }
            } else {
              if (editorStop) {
                try { if (canvasRef.current) canvasRef.current.dataset.editorActive = '0'; } catch (e) { }
                // remove editor-specific handlers
                try {
                  const h = (editorStop as any).__editorHandlers;
                  if (h) {
                    window.removeEventListener('wheel', h.wheelHandler);
                    const canvasElInner2 = canvasRef.current!;
                    canvasElInner2.removeEventListener('pointerdown', h.onPointerDownPan);
                    window.removeEventListener('pointermove', h.onPointerMovePan);
                    window.removeEventListener('pointerup', h.onPointerUpPan);
                    if (h.keydownHandler) window.removeEventListener('keydown', h.keydownHandler);
                  }
                } catch (e) { }
                try {
                  const nodes = (editorStop as any).__exportImportNodes;
                  if (nodes) {
                    try { nodes.exportBtn.remove(); } catch (e) { }
                    try { nodes.importBtn.remove(); } catch (e) { }
                    try { nodes.fileInput.remove(); } catch (e) { }
                    try { window.removeEventListener('drop', nodes.onDrop); } catch (e) { }
                    try { window.removeEventListener('dragover', nodes.onDragOver); } catch (e) { }
                  }
                } catch (e) { }
                try { editorStop(); } catch (e) { }
                editorStop = null;
              }
            }
          }
        } catch (e) {
          // ignore editor start errors
        }
      }

      if (stateRef.current === 'playing') {
        while (accumulator >= FIXED_DT) {
          // advance snapshots
          prevPlayer = { ...currPlayer };
          prevCam = { ...currCam };
          // reset jump-applied marker for this fixed-step batch
          jumpAppliedThisFrame = false;
          // You can query input here per-step if needed, e.g. input.get(' ')
          simulate(FIXED_DT);
          accumulator -= FIXED_DT;
        }
      } else {
        // not playing: don't advance sim; clamp accumulator so alpha stays sensible
        accumulator = 0;
      }

      draw();
      // editor keyboard pan/zoom handling
      if (stateRef.current === 'editor') {
        const basePanSpeed = 180; // world units per second
        const panSpeed = basePanSpeed * Math.min(0.033, delta) / Math.max(0.0001, editorZoom);
        if (input.get('w').isDown || input.get('ArrowUp').isDown) editorCamY -= panSpeed;
        if (input.get('s').isDown || input.get('ArrowDown').isDown) editorCamY += panSpeed;
        if (input.get('a').isDown || input.get('ArrowLeft').isDown) editorCamX -= panSpeed;
        if (input.get('d').isDown || input.get('ArrowRight').isDown) editorCamX += panSpeed;
        // keyboard zoom handled via keydown listener attached when editor starts
      }

      // if space was pressed this frame but no jump was applied during simulation, log detailed snapshot
      if (spacePressSnapshot && !jumpAppliedThisFrame) {
        // eslint-disable-next-line no-console
        console.log('[jump-debug] SPACE pressed but no jump applied', {
          press: spacePressSnapshot,
          now: performance.now(),
          grounded: currPlayer.grounded,
          wasGrounded: currPlayer.wasGrounded,
          lastGroundY,
          ledgeGrace,
          jumpLock,
          coyoteTimer,
          jumpBuffer,
          vy: currPlayer.vy,
          y: currPlayer.y,
          // additional diagnostics: contact samples and whether input still reports wasPressed
          contactBack: lastContactBack,
          contactFront: lastContactFront,
          contactAvg: lastContactAvg,
          contactExists: lastContactBack !== null && lastContactFront !== null,
          nearGround: lastNearGround,
          inputWasPressedNow: input.get(' ').wasPressed,
        });
      }
      // clear per-frame transient input flags
      input.clearTransient();
      // reset snapshot and applied flag after handling
      spacePressSnapshot = null;
      jumpAppliedThisFrame = false;
      rafId = requestAnimationFrame(loop);
    }

    rafId = requestAnimationFrame(loop);

    return () => {
      window.removeEventListener('resize', resize);
      input.stop();
      cancelAnimationFrame(rafId);
    };
  }, []);

  return <canvas ref={canvasRef} style={{ position: 'fixed', left: 0, top: 0, width: '100%', height: '100%' }} />;
}
