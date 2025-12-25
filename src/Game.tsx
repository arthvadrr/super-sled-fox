import React, { useRef, useEffect } from 'react';
import InputManager from './input';
import { createPlayer, Player, PHYS, PLAYER_DEFAULTS } from './player';
import { LEVELS } from './levels';
import assetManager from './assetManager';
import audioManager from './audioManager';
import { ParallaxLayer } from './parallax';
import EffectsManager from './effects';
import { getHeightAtX } from './heightmap';
import { validateLevel } from './level';
import { startEditor } from './editor';
import {
  VIRTUAL_WIDTH,
  VIRTUAL_HEIGHT,
  CAMERA_SETTINGS,
  FIXED_DT
} from './game/constants';
import {
  GameState,
  GameContext,
  Camera
} from './game/types';
import { createSnowPattern, createNoisePattern, createWoodPattern } from './game/patterns';
import { simulate } from './game/simulation';
import { draw } from './game/renderer';
import { loadLevelAssets, loadLevelByIndex } from './game/levelLoader';

// Editor zoom bounds (fall back to sensible defaults when not provided at build-time)
const EDITOR_ZOOM_MIN = (globalThis as any).EDITOR_ZOOM_MIN ?? 0.25;
const EDITOR_ZOOM_MAX = (globalThis as any).EDITOR_ZOOM_MAX ?? 4;

// Runtime mutable level state (module-level for now, will be moved to context)
let currentLevelIndex = 0;
let currentLevel = JSON.parse(JSON.stringify(LEVELS[currentLevelIndex].level));

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

    // Level assets will be loaded after `gameContext` is initialized below

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
    // Create visual texture patterns using extracted functions
    const snowPattern = createSnowPattern(vctx);
    const noisePattern = createNoisePattern(vctx);
    const woodPattern = createWoodPattern(vctx);

    // Initialize player and camera
    const initialPlayer: Player = createPlayer();
    const initialCam: Camera = { x: initialPlayer.x, y: initialPlayer.y };

    // Initialize GameContext with all mutable game state
    const gameContext: GameContext = {
      state: stateRef.current,
      currentLevel,
      currentLevelIndex,

      currPlayer: initialPlayer,
      prevPlayer: { ...initialPlayer },
      currCam: initialCam,
      prevCam: { ...initialCam },

      lastGroundY: null,
      lastGroundAngle: 0,
      ledgeGrace: 0,

      lastSlope: 0,
      lastSlopeEff: 0,
      lastAccelRaw: 0,
      lastAccelScaled: 0,

      landingFlash: 0,
      crashFlash: 0,
      crashFade: 0,
      crashTimer: 0,
      restartHintTimer: 0,
      fps: 60,

      spacePressSnapshot: null,
      jumpAppliedThisFrame: false,
      lastContactBack: null,
      lastContactFront: null,
      lastContactAvg: null,
      lastNearGround: false,
      pendingImmediateJump: false,

      lastNonEditorState: stateRef.current,
      editorStop: null,
      editorCamX: 0,
      editorCamY: 0,
      editorZoom: 1,
      lastEditorZoom: 1,

      parallax: [],
      effects: new EffectsManager({ enabled: true }),
      playerEntity: null,

      sfxJump: null,
      sfxLand: null,
      sfxCheckpoint: null,
      sfxDeath: null,
      sfxComplete: null,

      coyoteTimer: 0,
      jumpBuffer: 0,
      jumpHold: 0,
      jumpLock: 0,

      lastCheckpointX: ((currentLevel.objects || []).find((o: any) => o.type === 'start') as any)?.x ?? initialPlayer.x,
      reachedFinish: false,
      deathTimer: 0,

      snowPattern,
      noisePattern,
      woodPattern,

      accumulator: 0,
      lastTime: performance.now()
    };

    // Use extracted level loading function now that `gameContext` exists
    loadLevelAssets(gameContext).then(() => {
      if (!loadingCancelled) {
        stateRef.current = 'title';
        gameContext.state = 'title';
      }
    });

    function respawn() {
      const rx = gameContext.lastCheckpointX ?? PLAYER_DEFAULTS.startX;
      gameContext.currPlayer.x = rx;
      const hy = getHeightAtX(gameContext.currentLevel as any, rx);
      // place player slightly above ground so feet sit on the surface rather than inside it
      const FEET_OFFSET = 8; // virtual pixels from contact height to player's origin
      gameContext.currPlayer.y = hy !== null ? hy - FEET_OFFSET : PLAYER_DEFAULTS.startY;
      gameContext.currPlayer.vx = PHYS.BASE_CRUISE_SPEED;
      gameContext.currPlayer.vy = 0;
      gameContext.currPlayer.angle = 0;
      // start slightly above ground and mark airborne so we don't snap into the ground
      gameContext.currPlayer.grounded = false;
      gameContext.currPlayer.wasGrounded = false;
      gameContext.lastGroundY = null;
      gameContext.currPlayer.invulnTimer = 1.0; // grant a short invulnerability window after respawn
      gameContext.prevPlayer = { ...gameContext.currPlayer };
      gameContext.currCam.x = gameContext.currPlayer.x;
      gameContext.currCam.y = gameContext.currPlayer.y;
      gameContext.prevCam = { ...gameContext.currCam };
      // resume play
      // restore player sprite if it was removed by explosion
      try {
        if (!gameContext.playerEntity) gameContext.playerEntity = (gameContext as any).playerEntityTemplate ?? null;
      } catch (e) { }
      gameContext.state = 'playing';
      stateRef.current = 'playing';
      gameContext.reachedFinish = false;
      gameContext.deathTimer = 0;
    }

    // Developer test helper: trigger a crash/fall sequence programmatically
    function triggerCrash() {
      if (stateRef.current === 'dead') return;
      gameContext.state = 'dead';
      stateRef.current = 'dead';
      gameContext.crashFade = 0.6;
      gameContext.crashTimer = 0.9;
      void gameContext.sfxDeath?.play?.();
    }

    // Simulation wrapper: calls extracted simulate then updates camera
    function simulateStep(dt: number, input: InputManager) {
      // Call extracted simulation logic
      simulate(gameContext, dt, input);

      // Camera follows player with look-ahead and smoothing, clamped to level bounds
      const levelWidth = (gameContext.currentLevel.meta && gameContext.currentLevel.meta.width) || (gameContext.currentLevel.segments && gameContext.currentLevel.segments.length) || VIRTUAL_WIDTH;
      const look = Math.max(-CAMERA_SETTINGS.MAX_LOOK_AHEAD, Math.min(CAMERA_SETTINGS.MAX_LOOK_AHEAD, gameContext.currPlayer.vx * CAMERA_SETTINGS.LOOK_AHEAD_MULT));
      const targetCamX = gameContext.currPlayer.x + look;
      // Smooth toward target (frame-rate independent)
      const t = Math.min(1, CAMERA_SETTINGS.SMOOTH * dt);
      gameContext.currCam.x += (targetCamX - gameContext.currCam.x) * t;
      // Clamp so camera doesn't show past level edges
      const halfW = VIRTUAL_WIDTH / 2;
      const minCam = halfW;
      const maxCam = Math.max(halfW, levelWidth - halfW);
      gameContext.currCam.x = Math.max(minCam, Math.min(maxCam, gameContext.currCam.x));
      // Vertical camera follow: smooth toward player Y and clamp to level vertical bounds
      const levelHeight = (gameContext.currentLevel.meta && (gameContext.currentLevel.meta as any).virtualHeight) || VIRTUAL_HEIGHT;
      const halfH = VIRTUAL_HEIGHT / 2;
      const minCamY = halfH;
      const maxCamY = Math.max(halfH, levelHeight - halfH);
      const targetCamY = gameContext.currPlayer.y;
      if (typeof gameContext.currCam.y !== 'number') gameContext.currCam.y = targetCamY;
      gameContext.currCam.y += (targetCamY - gameContext.currCam.y) * t;
      gameContext.currCam.y = Math.max(minCamY, Math.min(maxCamY, gameContext.currCam.y));
      // Airborne rotation easing: when not grounded, ease angle toward neutral (0)
      if (!gameContext.currPlayer.grounded) {
        const ANGLE_EASE = 6; // higher = faster easing
        gameContext.currPlayer.angle += (0 - gameContext.currPlayer.angle) * Math.min(1, ANGLE_EASE * dt);
      }
    }

    // Draw wrapper: calls extracted draw function
    function drawGame() {
      draw(gameContext, vctx, canvasEl, ctx);
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

    // fixed timestep rAF loop
    let rafId = 0;
    gameContext.lastTime = performance.now();
    let lastGameState: GameState = stateRef.current;

    function loop(now: number) {
      // pause sim when page is hidden
      if (document.hidden) {
        gameContext.lastTime = now;
        rafId = requestAnimationFrame(loop);
        return;
      }

      let delta = (now - gameContext.lastTime) / 1000;
      if (delta > 0.25) delta = 0.25; // clamp to avoid spiral of death
      // update a smoothed FPS estimate
      if (delta > 0) gameContext.fps += (1 / delta - gameContext.fps) * 0.08;
      // decay landing flash timer
      gameContext.landingFlash = Math.max(0, gameContext.landingFlash - delta);
      // decay transient restart hint timer
      gameContext.restartHintTimer = Math.max(0, (gameContext.restartHintTimer || 0) - delta);
      // handle crash/death timers (fade only) even when not playing
      // simulation may set gameContext.state = 'dead' without updating stateRef.current,
      // so check both to ensure crash timers are decremented reliably.
      if (stateRef.current === 'dead' || gameContext.state === 'dead') {
        if (gameContext.crashTimer > 0) {
          gameContext.crashTimer -= delta;
          gameContext.crashFade = Math.max(0, gameContext.crashFade - delta);
          try {
            // keep effects (particles / screen shake) updating so crash explosion animates
            gameContext.effects.update(delta);
          } catch (e) { }
        } else {
          // no auto-respawn; wait for user to press `R` to respawn
        }
      }
      gameContext.lastTime = now;
      gameContext.accumulator += delta;
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
        if (gameContext.currPlayer.grounded) {
          gameContext.spacePressSnapshot = {
            t: performance.now(),
            state: stateRef.current,
            grounded: gameContext.currPlayer.grounded,
            wasGrounded: gameContext.currPlayer.wasGrounded,
            coyoteTimer: gameContext.coyoteTimer,
            jumpBuffer: gameContext.jumpBuffer,
            jumpLock: gameContext.jumpLock,
            vy: gameContext.currPlayer.vy,
            y: gameContext.currPlayer.y,
          };
          // When playing and grounded, schedule a pending immediate jump so the
          // physics step will consume it as soon as possible. This is more
          // reliable than relying on transient contact samples when presses
          // occur near the end of the frame.
          if (stateRef.current === 'playing' && gameContext.jumpLock <= 0) {
            gameContext.pendingImmediateJump = true;
            // eslint-disable-next-line no-console
            console.log('[jump-debug] requested pendingImmediateJump from main loop', { t: performance.now(), press: gameContext.spacePressSnapshot });
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
          gameContext.state = 'loading';
          stateRef.current = 'loading';
          loadLevelByIndex(gameContext, nextIdx, respawn).then(() => {
            // only resume play if still in loading state
            if (stateRef.current === 'loading') {
              gameContext.state = 'playing';
              stateRef.current = 'playing';
            }
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
          gameContext.lastNonEditorState = stateRef.current;
          stateRef.current = 'editor';
        } else {
          stateRef.current = gameContext.lastNonEditorState || 'title';
        }
      }

      // detect simple game-state transitions and reset timing to avoid large accumulator
      if (lastGameState !== stateRef.current) {
        lastGameState = stateRef.current;
        // keep gameContext.state in sync with the external stateRef so
        // rendering and other systems that read ctx.state behave correctly.
        gameContext.state = stateRef.current;
        // prevent interpolation artifacts by syncing snapshots
        gameContext.prevPlayer = { ...gameContext.currPlayer };
        gameContext.prevCam = { ...gameContext.currCam };
        gameContext.accumulator = 0;
        gameContext.lastTime = now;
        // start/stop editor when entering/exiting editor state
        try {
          const canvasElInner = canvasRef.current!;
          if (typeof EDITOR_ENABLED !== 'undefined' && EDITOR_ENABLED) {
            if (stateRef.current === 'editor') {
              if (!gameContext.editorStop) {
                // initialize editor camera from gameplay cam/player
                gameContext.editorCamX = gameContext.currCam.x;
                gameContext.editorCamY = gameContext.currPlayer.y || VIRTUAL_HEIGHT / 2;
                gameContext.editorZoom = gameContext.lastEditorZoom || 1;
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
                  const wx = (px - VIRTUAL_WIDTH / 2) / gameContext.editorZoom + gameContext.editorCamX;
                  const wy = (py - VIRTUAL_HEIGHT / 2) / gameContext.editorZoom + gameContext.editorCamY;
                  return { x: wx, y: wy };
                };

                gameContext.editorStop = startEditor({
                  canvas: canvasElInner,
                  screenToWorld: screenToWorldFn,
                  level: currentLevel as any,
                  // allow per-level editor tuning via meta
                  segmentLen: (currentLevel.meta && (currentLevel.meta as any).segmentLen) || 1,
                  virtualHeight: (currentLevel.meta && (currentLevel.meta as any).virtualHeight) || VIRTUAL_HEIGHT,
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

                // --- Level resize UI ---
                const widthLabel = document.createElement('label');
                widthLabel.style.position = 'fixed';
                widthLabel.style.right = '240px';
                widthLabel.style.bottom = '12px';
                widthLabel.style.zIndex = '9999';
                widthLabel.style.color = '#fff';
                widthLabel.style.fontFamily = 'monospace';
                widthLabel.style.fontSize = '12px';
                widthLabel.style.display = 'flex';
                widthLabel.style.gap = '6px';

                const widthInput = document.createElement('input');
                widthInput.type = 'number';
                widthInput.min = '1';
                widthInput.value = String((currentLevel.meta && (currentLevel.meta as any).width) || (currentLevel.segments && currentLevel.segments.length) || 0);
                widthInput.style.width = '80px';
                widthInput.style.padding = '4px';
                widthInput.style.background = '#222';
                widthInput.style.color = '#fff';
                widthInput.style.border = '1px solid #444';

                const resizeBtn = document.createElement('button');
                resizeBtn.textContent = 'Resize Width';
                resizeBtn.style.padding = '6px 8px';
                resizeBtn.style.background = '#222';
                resizeBtn.style.color = '#fff';

                widthLabel.appendChild(widthInput);
                widthLabel.appendChild(resizeBtn);
                document.body.appendChild(widthLabel);

                const heightLabel = document.createElement('label');
                heightLabel.style.position = 'fixed';
                heightLabel.style.right = '420px';
                heightLabel.style.bottom = '12px';
                heightLabel.style.zIndex = '9999';
                heightLabel.style.color = '#fff';
                heightLabel.style.fontFamily = 'monospace';
                heightLabel.style.fontSize = '12px';
                heightLabel.style.display = 'flex';
                heightLabel.style.gap = '6px';

                const heightInput = document.createElement('input');
                heightInput.type = 'number';
                heightInput.min = '0';
                heightInput.value = String((currentLevel.meta && (currentLevel.meta as any).virtualHeight) || VIRTUAL_HEIGHT);
                heightInput.style.width = '80px';
                heightInput.style.padding = '4px';
                heightInput.style.background = '#222';
                heightInput.style.color = '#fff';
                heightInput.style.border = '1px solid #444';

                const setHeightBtn = document.createElement('button');
                setHeightBtn.textContent = 'Set Height';
                setHeightBtn.style.padding = '6px 8px';
                setHeightBtn.style.background = '#222';
                setHeightBtn.style.color = '#fff';

                heightLabel.appendChild(heightInput);
                heightLabel.appendChild(setHeightBtn);
                document.body.appendChild(heightLabel);

                // --- Smooth UI ---
                const smoothLabel = document.createElement('label');
                smoothLabel.style.position = 'fixed';
                smoothLabel.style.right = '560px';
                smoothLabel.style.bottom = '12px';
                smoothLabel.style.zIndex = '9999';
                smoothLabel.style.color = '#fff';
                smoothLabel.style.fontFamily = 'monospace';
                smoothLabel.style.fontSize = '12px';
                smoothLabel.style.display = 'flex';
                smoothLabel.style.gap = '6px';

                const radiusInput = document.createElement('input');
                radiusInput.type = 'number';
                radiusInput.min = '1';
                radiusInput.value = '1';
                radiusInput.style.width = '48px';
                radiusInput.style.padding = '4px';
                radiusInput.style.background = '#222';
                radiusInput.style.color = '#fff';
                radiusInput.style.border = '1px solid #444';

                const smoothBtn = document.createElement('button');
                smoothBtn.textContent = 'Smooth';
                smoothBtn.style.padding = '6px 8px';
                smoothBtn.style.background = '#222';
                smoothBtn.style.color = '#fff';

                smoothLabel.appendChild(radiusInput);
                smoothLabel.appendChild(smoothBtn);
                document.body.appendChild(smoothLabel);

                smoothBtn.onclick = () => {
                  try {
                    const r = Math.max(1, Math.floor(Number(radiusInput.value) || 1));
                    const fn = (gameContext.editorStop as any)?.smoothSegments as ((r: number) => void) | undefined;
                    if (fn) fn(r);
                  } catch (e) { }
                };

                // helper: safely resize segments array
                const resizeSegments = (newLen: number) => {
                  if (!Array.isArray(currentLevel.segments)) currentLevel.segments = [] as any;
                  const old = currentLevel.segments;
                  const oldLen = old.length;
                  if (newLen === oldLen) return;
                  if (newLen > oldLen) {
                    // append copies of last non-null or default 120
                    let fill = 120;
                    for (let i = oldLen - 1; i >= 0; i--) {
                      if (old[i] !== null && typeof old[i] === 'number') { fill = old[i] as number; break; }
                    }
                    for (let i = oldLen; i < newLen; i++) old.push(fill);
                  } else {
                    // truncate and clamp objects
                    old.length = newLen;
                    if (Array.isArray(currentLevel.objects)) {
                      currentLevel.objects = currentLevel.objects.filter((o: any) => (o.x || 0) < newLen);
                    }
                  }
                  // update meta.width
                  if (!currentLevel.meta) currentLevel.meta = {} as any;
                  (currentLevel.meta as any).width = newLen;
                };

                resizeBtn.onclick = () => {
                  const v = Math.max(1, Math.floor(Number(widthInput.value) || 0));
                  resizeSegments(v);
                };

                setHeightBtn.onclick = () => {
                  const hv = Math.max(0, Math.floor(Number(heightInput.value) || 0));
                  if (!currentLevel.meta) currentLevel.meta = {} as any;
                  (currentLevel.meta as any).virtualHeight = hv;
                };

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
                (gameContext.editorStop as any).__exportImportNodes = { exportBtn, importBtn, fileInput, onDrop, onDragOver, widthLabel, heightLabel, widthInput, heightInput, resizeBtn, setHeightBtn, smoothLabel, smoothBtn, radiusInput };

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
                  const worldBeforeX = (px - VIRTUAL_WIDTH / 2) / gameContext.editorZoom + gameContext.editorCamX;
                  const worldBeforeY = (py - VIRTUAL_HEIGHT / 2) / gameContext.editorZoom + gameContext.editorCamY;
                  // delta from wheel: use exponential scale
                  const factor = Math.pow(1.1, -ev.deltaY / 100);
                  let newZoom = gameContext.editorZoom * factor;
                  newZoom = Math.max(EDITOR_ZOOM_MIN, Math.min(EDITOR_ZOOM_MAX, newZoom));
                  // adjust camera so worldUnderCursor stays stable
                  gameContext.editorCamX = worldBeforeX - (px - VIRTUAL_WIDTH / 2) / newZoom;
                  gameContext.editorCamY = worldBeforeY - (py - VIRTUAL_HEIGHT / 2) / newZoom;
                  gameContext.editorZoom = newZoom;
                  gameContext.lastEditorZoom = gameContext.editorZoom;
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
                  gameContext.editorCamX -= dx / gameContext.editorZoom;
                  gameContext.editorCamY -= dy / gameContext.editorZoom;
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
                    let newZoom = Math.max(EDITOR_ZOOM_MIN, Math.min(EDITOR_ZOOM_MAX, gameContext.editorZoom * 1.1));
                    gameContext.editorZoom = newZoom; gameContext.lastEditorZoom = gameContext.editorZoom;
                  } else if (ev.key === '-') {
                    let newZoom = Math.max(EDITOR_ZOOM_MIN, Math.min(EDITOR_ZOOM_MAX, gameContext.editorZoom / 1.1));
                    gameContext.editorZoom = newZoom; gameContext.lastEditorZoom = gameContext.editorZoom;
                  } else if (ev.key === 'z') {
                    gameContext.editorZoom = 1; gameContext.lastEditorZoom = 1; gameContext.editorCamX = gameContext.currPlayer.x; gameContext.editorCamY = gameContext.currPlayer.y || VIRTUAL_HEIGHT / 2;
                  }
                };
                window.addEventListener('keydown', keydownHandler);

                // store these handlers on editorStop so we can remove them when stopping
                (gameContext.editorStop as any).__editorHandlers = { wheelHandler, onPointerDownPan, onPointerMovePan, onPointerUpPan, keydownHandler };
              }
            } else {
              if (gameContext.editorStop) {
                try { if (canvasRef.current) canvasRef.current.dataset.editorActive = '0'; } catch (e) { }
                // remove editor-specific handlers
                try {
                  const h = (gameContext.editorStop as any).__editorHandlers;
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
                  const nodes = (gameContext.editorStop as any).__exportImportNodes;
                  if (nodes) {
                    try { nodes.exportBtn.remove(); } catch (e) { }
                    try { nodes.importBtn.remove(); } catch (e) { }
                    try { nodes.fileInput.remove(); } catch (e) { }
                    try { nodes.widthLabel.remove(); } catch (e) { }
                    try { nodes.heightLabel.remove(); } catch (e) { }
                    try { nodes.smoothLabel.remove(); } catch (e) { }
                    try { window.removeEventListener('drop', nodes.onDrop); } catch (e) { }
                    try { window.removeEventListener('dragover', nodes.onDragOver); } catch (e) { }
                  }
                } catch (e) { }
                try { (gameContext.editorStop as any)(); } catch (e) { }
                gameContext.editorStop = null;
              }
            }
          }
        } catch (e) {
          // ignore editor start errors
        }
      }

      if (stateRef.current === 'playing') {
        while (gameContext.accumulator >= FIXED_DT) {
          // advance snapshots
          gameContext.prevPlayer = { ...gameContext.currPlayer };
          gameContext.prevCam = { ...gameContext.currCam };
          // reset jump-applied marker for this fixed-step batch
          gameContext.jumpAppliedThisFrame = false;
          // You can query input here per-step if needed, e.g. input.get(' ')
          simulateStep(FIXED_DT, input);
          gameContext.accumulator -= FIXED_DT;
        }
        // If simulation requested a state change (e.g. reached finish sets ctx.state='complete'),
        // ensure the external `stateRef` mirrors it so the main loop stops simulating and UI updates.
        if (gameContext.state !== stateRef.current) {
          stateRef.current = gameContext.state as GameState;
          lastGameState = stateRef.current;
          gameContext.prevPlayer = { ...gameContext.currPlayer };
          gameContext.prevCam = { ...gameContext.currCam };
          gameContext.accumulator = 0;
          gameContext.lastTime = now;
        }
      } else {
        // not playing: don't advance sim; clamp accumulator so alpha stays sensible
        gameContext.accumulator = 0;
      }

      drawGame();
      // editor keyboard pan/zoom handling
      if (stateRef.current === 'editor') {
        const basePanSpeed = 180; // world units per second
        const panSpeed = basePanSpeed * Math.min(0.033, delta) / Math.max(0.0001, gameContext.editorZoom);
        if (input.get('w').isDown || input.get('ArrowUp').isDown) gameContext.editorCamY -= panSpeed;
        if (input.get('s').isDown || input.get('ArrowDown').isDown) gameContext.editorCamY += panSpeed;
        if (input.get('a').isDown || input.get('ArrowLeft').isDown) gameContext.editorCamX -= panSpeed;
        if (input.get('d').isDown || input.get('ArrowRight').isDown) gameContext.editorCamX += panSpeed;
        // keyboard zoom handled via keydown listener attached when editor starts
      }

      // if space was pressed this frame but no jump was applied during simulation, log detailed snapshot
      if (gameContext.spacePressSnapshot && !gameContext.jumpAppliedThisFrame) {
        // eslint-disable-next-line no-console
        console.log('[jump-debug] SPACE pressed but no jump applied', {
          press: gameContext.spacePressSnapshot,
          now: performance.now(),
          grounded: gameContext.currPlayer.grounded,
          wasGrounded: gameContext.currPlayer.wasGrounded,
          lastGroundY: gameContext.lastGroundY,
          ledgeGrace: gameContext.ledgeGrace,
          jumpLock: gameContext.jumpLock,
          coyoteTimer: gameContext.coyoteTimer,
          jumpBuffer: gameContext.jumpBuffer,
          vy: gameContext.currPlayer.vy,
          y: gameContext.currPlayer.y,
          // additional diagnostics: contact samples and whether input still reports wasPressed
          contactBack: gameContext.lastContactBack,
          contactFront: gameContext.lastContactFront,
          contactAvg: gameContext.lastContactAvg,
          contactExists: gameContext.lastContactBack !== null && gameContext.lastContactFront !== null,
          nearGround: gameContext.lastNearGround,
          inputWasPressedNow: input.get(' ').wasPressed,
        });
      }
      // clear per-frame transient input flags
      input.clearTransient();
      // reset snapshot and applied flag after handling
      gameContext.spacePressSnapshot = null;
      gameContext.jumpAppliedThisFrame = false;
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
