import React, { useRef, useEffect } from 'react';
import InputManager from './input';
import { createPlayer, Player, PHYS, PLAYER_DEFAULTS } from './player';
import sampleLevel from './levels/sample-level';
import assetManager from './assetManager';
import audioManager from './audioManager';
import { createSpriteSheet, AnimatedSprite, AnimationStateMachine } from './sprite';
import { loadParallaxLayers, ParallaxLayer } from './parallax';
import { getHeightAtX, getSlopeAtX } from './heightmap';

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
        const meta: any = sampleLevel.meta || {};
        const assets = meta.assets || [];
        if (!Array.isArray(assets) || assets.length === 0) {
          // no explicit assets: wait a small timeout so UI shows loading briefly
          await new Promise((r) => setTimeout(r, 500));
          return;
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
    // debug / effects
    let landingFlash = 0; // seconds of white flash on landing
    let fps = 60;
    // parallax layers: images and scroll factors
    const parallax: ParallaxLayer[] = [];
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
    // checkpoint / finish / death
    const startObj = (sampleLevel.objects || []).find((o) => o.type === 'start');
    let lastCheckpointX = startObj ? startObj.x : currPlayer.x;
    let reachedFinish = false;
    let deathTimer = 0; // delay before auto-respawn

    function respawn() {
      const rx = lastCheckpointX ?? PLAYER_DEFAULTS.startX;
      currPlayer.x = rx;
      const hy = getHeightAtX(sampleLevel as any, rx);
      currPlayer.y = hy !== null ? hy : PLAYER_DEFAULTS.startY;
      currPlayer.vx = PHYS.BASE_CRUISE_SPEED;
      currPlayer.vy = 0;
      currPlayer.angle = getSlopeAtX(sampleLevel as any, rx) ?? 0;
      currPlayer.grounded = true;
      currPlayer.wasGrounded = true;
      currPlayer.invulnTimer = 0.5;
      prevPlayer = { ...currPlayer };
      currCam.x = currPlayer.x;
      prevCam = { ...currCam };
      // resume play
      stateRef.current = 'playing';
      reachedFinish = false;
      deathTimer = 0;
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
      const hb = getHeightAtX(sampleLevel as any, backX);
      const hf = getHeightAtX(sampleLevel as any, frontX);

      currPlayer.wasGrounded = currPlayer.grounded;

      if (hb !== null && hf !== null) {
        // grounded: y is average of contacts, angle from line
        const avgY = (hb + hf) / 2;
        currPlayer.y = avgY;
        currPlayer.vy = 0;
        currPlayer.grounded = true;
        currPlayer.angle = Math.atan2(hf - hb, frontX - backX);

        // grounded motion: acceleration along slope from gravity projection
        const slope = getSlopeAtX(sampleLevel as any, currPlayer.x) ?? Math.tan(currPlayer.angle);
        const slopeMag = slope;
        const accelAlong = -PHYS.GRAVITY * slopeMag / Math.sqrt(1 + slopeMag * slopeMag);
        currPlayer.vx += accelAlong * dt;

        // input speed modifiers and braking
        const forward = input.get('ArrowRight').isDown || input.get('d').isDown || input.get('w').isDown;
        const back = input.get('ArrowLeft').isDown || input.get('a').isDown || input.get('s').isDown;
        let speedMul = 1.0;
        if (forward) speedMul = 1.5;
        else if (back) speedMul = 0.5;

        // target cruise speed modified by input
        const targetSpeed = PHYS.BASE_CRUISE_SPEED * speedMul;

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

        // update last ground pose
        lastGroundY = avgY;
        lastGroundAngle = currPlayer.angle;
        ledgeGrace = 0;
        // landing detection: if we were airborne last fixed-step, trigger land event
        if (!currPlayer.wasGrounded && currPlayer.grounded) {
          landingFlash = 0.12;
          currPlayer.invulnTimer = 0.5;
          // play landing sound
          void sfxLand?.play?.();
        }
      } else {
        // became airborne this frame?
        if (currPlayer.wasGrounded && !currPlayer.grounded) {
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
          currPlayer.x += currPlayer.vx * dt;
          // don't modify vy yet
        } else {
          // handle jump input buffering: if player pressed jump recently, store it
          const jumpPressed = input.get(' ').wasPressed || input.get('ArrowUp').wasPressed || input.get('w').wasPressed;
          if (jumpPressed) jumpBuffer = JUMP.BUFFER_TIME;

          // attempt to jump if we still have coyote time
          if (jumpBuffer > 0 && coyoteTimer > 0) {
            currPlayer.vy = -PHYS.JUMP_IMPULSE;
            currPlayer.grounded = false;
            jumpHold = PHYS.JUMP_HOLD_TIME;
            jumpBuffer = 0;
            coyoteTimer = 0;
            // jump sfx
            void sfxJump?.play?.();
          }

          // apply airborne physics with variable gravity while holding jump
          const holdingJump = jumpHold > 0 && (input.get(' ').isDown || input.get('ArrowUp').isDown || input.get('w').isDown);
          const gravityFactor = holdingJump ? JUMP.HOLD_GRAVITY_FACTOR : 1;
          currPlayer.vy += PHYS.GRAVITY * gravityFactor * dt;
          currPlayer.x += currPlayer.vx * dt;
          currPlayer.y += currPlayer.vy * dt;
        }

        currPlayer.grounded = false;
      }

      // check checkpoints / finish after movement
      for (const obj of sampleLevel.objects || []) {
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
        stateRef.current = 'dead';
        deathTimer = 0.7; // auto-respawn after short delay
        void sfxDeath?.play?.();
      }

      // handle death auto-respawn timer
      if (stateRef.current === 'dead') {
        deathTimer -= dt;
        if (deathTimer <= 0) {
          respawn();
        }
      }

      // advance player sprite animation (if present)
      playerEntity?.update(dt);

      // camera follows player with look-ahead and smoothing, clamped to level bounds
      const levelWidth = (sampleLevel.meta && sampleLevel.meta.width) || (sampleLevel.segments && sampleLevel.segments.length) || VIRTUAL_WIDTH;
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

      // interpolate player and camera
      const ix = prevPlayer.x * (1 - alpha) + currPlayer.x * alpha;
      const iy = prevPlayer.y * (1 - alpha) + currPlayer.y * alpha;
      const camx = prevCam.x * (1 - alpha) + currCam.x * alpha;


      // draw scene into virtual canvas (virtual pixels)
      vctx.fillStyle = '#0b1220';
      vctx.fillRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);

      // draw parallax background layers (back-to-front)
      if (parallax.length > 0) {
        for (let li = 0; li < parallax.length; li++) {
          const layer = parallax[li];
          if (!layer || !layer.img) continue;
          const img = layer.img;
          const factor = layer.factor || 0.5;
          const yOff = layer.yOff || 0;
          // tile image horizontally to fill view
          const imgW = img.width || VIRTUAL_WIDTH;
          const scroll = (camx * factor) % imgW;
          // draw enough tiles to cover screen
          for (let x = -imgW; x < VIRTUAL_WIDTH + imgW; x += imgW) {
            vctx.drawImage(img, Math.round(x - scroll), Math.round(yOff));
          }
        }
      }

      // compute camera offset (centered)
      let camOffsetX = camx - VIRTUAL_WIDTH / 2;
      if (RENDER.PIXEL_SNAP) camOffsetX = Math.round(camOffsetX);

      // compute visible segment range for culling
      const leftWorld = camx - VIRTUAL_WIDTH / 2;
      const rightWorld = camx + VIRTUAL_WIDTH / 2;
      const leftIdx = Math.max(0, Math.floor(leftWorld) - RENDER.PADDING);
      const rightIdx = Math.min((sampleLevel.segments && sampleLevel.segments.length - 1) || 0, Math.ceil(rightWorld) + RENDER.PADDING);

      // draw terrain (filled polygon) only in visible range
      vctx.fillStyle = '#2a6f3a';
      vctx.beginPath();
      let started = false;
      for (let xi = leftIdx; xi <= rightIdx; xi++) {
        const sx = xi - camOffsetX;
        const hy = getHeightAtX(sampleLevel as any, xi);
        if (hy === null) {
          // gap: if currently drawing, close and fill the polygon to bottom, then restart
          if (started) {
            vctx.lineTo((xi - 1) - camOffsetX, VIRTUAL_HEIGHT);
            vctx.lineTo(leftIdx - camOffsetX, VIRTUAL_HEIGHT);
            vctx.closePath();
            vctx.fill();
            vctx.beginPath();
            started = false;
          }
          continue;
        }
        if (!started) {
          vctx.moveTo(sx, hy);
          started = true;
        } else {
          vctx.lineTo(sx, hy);
        }
      }
      if (started) {
        // close the shape to bottom and fill
        vctx.lineTo(rightIdx - camOffsetX, VIRTUAL_HEIGHT);
        vctx.lineTo(leftIdx - camOffsetX, VIRTUAL_HEIGHT);
        vctx.closePath();
        vctx.fill();
      }

      // draw level objects (start/checkpoint/finish) culling to visible range
      for (const obj of sampleLevel.objects || []) {
        if (obj.x < leftIdx - 1 || obj.x > rightIdx + 1) continue;
        const hx = obj.x - camOffsetX;
        const hy = getHeightAtX(sampleLevel as any, obj.x) ?? VIRTUAL_HEIGHT / 2;
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
      const px = Math.round(ix - camOffsetX);
      const py = Math.round(iy);
      // cull off-screen player draws for performance
      if (px >= -64 && px <= VIRTUAL_WIDTH + 64) {
        if (playerEntity) {
          // choose animation state based on player physics
          let pstate = 'idle';
          if (!currPlayer.grounded) {
            pstate = currPlayer.vy < 0 ? 'jump' : 'fall';
          } else {
            pstate = currPlayer.vx > 20 ? 'run' : 'idle';
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
          vctx.fillStyle = '#fff';
          vctx.fillRect(px - 8, py - 8, 16, 16);
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

      // debug overlay (top-left)
      vctx.fillStyle = 'rgba(0,0,0,0.6)';
      vctx.fillRect(6, 6, 200, 78);
      vctx.fillStyle = '#fff';
      vctx.font = '12px monospace';
      vctx.fillText(`FPS: ${fps.toFixed(1)}`, 12, 22);
      vctx.fillText(`Player: x=${ix.toFixed(1)} y=${iy.toFixed(1)}`, 12, 36);
      vctx.fillText(`Vel: vx=${currPlayer.vx.toFixed(1)} vy=${currPlayer.vy.toFixed(1)}`, 12, 50);
      vctx.fillText(`Grounded: ${currPlayer.grounded}`, 12, 64);
      vctx.fillText(`CamX: ${camx.toFixed(1)}`, 12, 78);

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
        vctx.fillStyle = 'rgba(0,0,0,0.85)';
        vctx.fillRect(0, VIRTUAL_HEIGHT / 2 - 64, VIRTUAL_WIDTH, 128);
        vctx.fillStyle = '#fff';
        vctx.font = '26px monospace';
        vctx.textAlign = 'center';
        vctx.fillText('Level Complete', VIRTUAL_WIDTH / 2, VIRTUAL_HEIGHT / 2 - 4);
        vctx.font = '14px monospace';
        vctx.fillText('Press R to Restart', VIRTUAL_WIDTH / 2, VIRTUAL_HEIGHT / 2 + 22);
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
      lastTime = now;
      accumulator += delta;
      // handle global input for state changes (pause, restart, start)
      const escPressed = input.get('Escape').wasPressed;
      const rPressed = input.get('r').wasPressed;
      const startPressed = input.get(' ').wasPressed;
      if (rPressed) {
        // force respawn / restart
        respawn();
      }

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

      // detect simple game-state transitions and reset timing to avoid large accumulator
      if (lastGameState !== stateRef.current) {
        lastGameState = stateRef.current;
        // prevent interpolation artifacts by syncing snapshots
        prevPlayer = { ...currPlayer };
        prevCam = { ...currCam };
        accumulator = 0;
        lastTime = now;
      }

      if (stateRef.current === 'playing') {
        while (accumulator >= FIXED_DT) {
          // advance snapshots
          prevPlayer = { ...currPlayer };
          prevCam = { ...currCam };
          // You can query input here per-step if needed, e.g. input.get(' ')
          simulate(FIXED_DT);
          accumulator -= FIXED_DT;
        }
      } else {
        // not playing: don't advance sim; clamp accumulator so alpha stays sensible
        accumulator = 0;
      }

      draw();
      // clear per-frame transient input flags
      input.clearTransient();
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
