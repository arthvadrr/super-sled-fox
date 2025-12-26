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
      // boost/stamina defaults
      boostStamina: 1,
      boostRefillBlockedTimer: 0,
      boostLocked: false,
      boostFullVisibleTimer: 0,
      boostBlinkTimer: 0,
      boostBlinkOn: false,
      isBoosting: false,

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
      const hadFullRestart = gameContext.forceFullRestart === true;
      const rx = hadFullRestart ? PLAYER_DEFAULTS.startX : (gameContext.lastCheckpointX ?? PLAYER_DEFAULTS.startX);
      // clear full-restart flag after using it
      gameContext.forceFullRestart = false;
      // reset or restore avalanche position when respawning depending on whether
      // we performed a full restart or have a saved avalanche position and a
      // valid checkpoint.
      try {
        const meta = (gameContext.currentLevel && (gameContext.currentLevel.meta as any)) || {};
        const avalSpeed = typeof meta.avalancheSpeed === 'number' ? meta.avalancheSpeed : 0;
        if (avalSpeed > 0) {
          const startObj = (gameContext.currentLevel && (gameContext.currentLevel.objects || []) as any[])
            ? (gameContext.currentLevel.objects as any[]).find((o) => o.type === 'start')
            : undefined;
          const startX = typeof startObj?.x === 'number' ? startObj.x : rx;
          const START_OFFSET = 120;

          const cpX = gameContext.lastCheckpointX ?? PLAYER_DEFAULTS.startX;
          const hasNonStartCheckpoint = cpX > PLAYER_DEFAULTS.startX;

          if (hadFullRestart || !hasNonStartCheckpoint) {
            // full restart or no checkpoint reached -> reset avalanche to beginning
            gameContext.avalancheX = startX - START_OFFSET;
            gameContext.avalancheSpeed = avalSpeed;
            gameContext.avalancheActive = true;
            // clear any saved values
            gameContext.savedAvalancheX = undefined;
            gameContext.savedAvalancheSpeed = undefined;
          } else if (typeof gameContext.savedAvalancheX === 'number' && gameContext.savedAvalancheX <= cpX) {
            // resume avalanche from saved position (it was behind the player's checkpoint)
            gameContext.avalancheX = gameContext.savedAvalancheX;
            gameContext.avalancheSpeed = gameContext.savedAvalancheSpeed ?? avalSpeed;
            gameContext.avalancheActive = true;
            // consume saved values
            gameContext.savedAvalancheX = undefined;
            gameContext.savedAvalancheSpeed = undefined;
          } else {
            // default: reset to start
            gameContext.avalancheX = startX - START_OFFSET;
            gameContext.avalancheSpeed = avalSpeed;
            gameContext.avalancheActive = true;
            gameContext.savedAvalancheX = undefined;
            gameContext.savedAvalancheSpeed = undefined;
          }
        } else {
          gameContext.avalancheX = undefined;
          gameContext.avalancheActive = false;
          gameContext.avalancheSpeed = undefined;
        }
      } catch (e) { }
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
      // Initial camera placement uses a horizontal bias so the player is
      // positioned slightly left-of-center for better forward visibility.
      gameContext.currCam.x = gameContext.currPlayer.x + (CAMERA_SETTINGS.HORIZONTAL_BIAS || 0);
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
      const bias = CAMERA_SETTINGS.HORIZONTAL_BIAS || 0;
      const targetCamX = gameContext.currPlayer.x + look + bias;
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

                // single fixed container for all editor UI elements
                const editorUI = document.createElement('div');
                editorUI.id = 'editor-ui';
                editorUI.className = 'editor-ui';
                document.body.appendChild(editorUI);

                // Export / Import UI (only present while editor active)
                const exportBtn = document.createElement('button');
                exportBtn.textContent = 'Export Level';
                exportBtn.className = 'editor-btn export';
                editorUI.appendChild(exportBtn);

                const fileInput = document.createElement('input');
                fileInput.type = 'file';
                fileInput.accept = 'application/json';
                fileInput.className = 'editor-fileinput';
                editorUI.appendChild(fileInput);

                const importBtn = document.createElement('button');
                importBtn.textContent = 'Import Level';
                importBtn.className = 'editor-btn';
                editorUI.appendChild(importBtn);

                // --- Level resize UI ---
                const widthLabel = document.createElement('label');
                widthLabel.className = 'editor-panel';

                const widthInput = document.createElement('input');
                widthInput.type = 'number';
                widthInput.min = '1';
                widthInput.value = String((currentLevel.meta && (currentLevel.meta as any).width) || (currentLevel.segments && currentLevel.segments.length) || 0);
                widthInput.className = 'editor-input';

                const resizeBtn = document.createElement('button');
                resizeBtn.textContent = 'Resize Width';
                resizeBtn.className = 'editor-btn';

                widthLabel.appendChild(widthInput);
                widthLabel.appendChild(resizeBtn);
                editorUI.appendChild(widthLabel);

                const heightLabel = document.createElement('label');
                heightLabel.className = 'editor-panel';

                const heightInput = document.createElement('input');
                heightInput.type = 'number';
                heightInput.min = '0';
                heightInput.value = String((currentLevel.meta && (currentLevel.meta as any).virtualHeight) || VIRTUAL_HEIGHT);
                heightInput.className = 'editor-input';

                const setHeightBtn = document.createElement('button');
                setHeightBtn.textContent = 'Set Height';
                setHeightBtn.className = 'editor-btn';

                heightLabel.appendChild(heightInput);
                heightLabel.appendChild(setHeightBtn);
                editorUI.appendChild(heightLabel);

                // --- Avalanche speed UI ---
                const avalancheLabel = document.createElement('label');
                avalancheLabel.className = 'editor-panel';

                const avalancheInput = document.createElement('input');
                avalancheInput.type = 'number';
                avalancheInput.min = '0';
                avalancheInput.step = '1';
                avalancheInput.value = String((currentLevel.meta && (currentLevel.meta as any).avalancheSpeed) || 0);
                avalancheInput.className = 'editor-input';

                const setAvalBtn = document.createElement('button');
                setAvalBtn.textContent = 'Set Avalanche';
                setAvalBtn.className = 'editor-btn';

                avalancheLabel.appendChild(avalancheInput);
                avalancheLabel.appendChild(setAvalBtn);
                editorUI.appendChild(avalancheLabel);

                setAvalBtn.onclick = () => {
                  const v = Math.max(0, Number(avalancheInput.value) || 0);
                  if (!currentLevel.meta) currentLevel.meta = {} as any;
                  (currentLevel.meta as any).avalancheSpeed = v;
                };

                // --- Smooth UI ---
                const smoothLabel = document.createElement('label');
                smoothLabel.className = 'editor-panel';

                const radiusInput = document.createElement('input');
                radiusInput.type = 'number';
                radiusInput.min = '1';
                radiusInput.value = '1';
                radiusInput.className = 'editor-input';

                const smoothBtn = document.createElement('button');
                smoothBtn.textContent = 'Smooth';
                smoothBtn.className = 'editor-btn';

                smoothLabel.appendChild(radiusInput);
                smoothLabel.appendChild(smoothBtn);
                editorUI.appendChild(smoothLabel);

                // --- Decor palette ---
                const decorLabel = document.createElement('div');
                decorLabel.id = 'editor-decor-label';
                decorLabel.className = 'editor-panel';

                const paletteRow = document.createElement('div');
                paletteRow.className = 'palette-row';

                const BUILT_IN_DECOR = [
                  'decor/christmas-tree.png',
                  'decor/dark-pine-tree-2.png',
                  'decor/dead-tree.png',
                  'decor/pine-tree-dark.png',
                  'decor/snowy-cabin.png',
                  'decor/wood-cabin-2.png',
                  'decor/boulder-tall.png',
                  'decor/wide-boulder.png',
                ];

                function refreshPalette() {
                  // clear
                  while (paletteRow.firstChild) paletteRow.removeChild(paletteRow.firstChild);
                  const assets = (currentLevel.meta && (currentLevel.meta as any).assets) || [];
                  // combine level assets + built-in decor, dedupe
                  const combined = Array.from(new Set([...(assets as string[]).filter((a) => typeof a === 'string'), ...BUILT_IN_DECOR]));
                  const decorAssets = combined.filter((a) => typeof a === 'string' && (a.startsWith('data:') || a.toLowerCase().includes('/decor/') || a.toLowerCase().includes('decor/')));
                  for (const a of decorAssets) {
                    const thumb = document.createElement('img');
                    thumb.className = 'thumb';
                    thumb.title = String(a);
                    // load via assetManager so basePath applied
                    (async () => {
                      try {
                        const im = await assetManager.loadImage(String(a));
                        thumb.src = im.src;
                      } catch (e) {
                        // ignore
                      }
                    })();
                    thumb.onclick = () => {
                      const canvasElInner = canvasRef.current!;
                      canvasElInner.dataset.editorDecor = String(a);
                      // highlight selection
                      for (const node of Array.from(paletteRow.children)) (node as HTMLElement).classList.remove('selected');
                      thumb.classList.add('selected');
                      // switch editor into place-decor tool
                      try { (gameContext.editorStop as any)?.setTool?.('PlaceDecor'); } catch (e) { }
                    };
                    paletteRow.appendChild(thumb);
                  }
                }

                decorLabel.appendChild(paletteRow);
                editorUI.appendChild(decorLabel);
                refreshPalette();

                // small floating menu for selected decor: resize + delete
                const decorMenu = document.createElement('div');
                decorMenu.id = 'editor-decor-menu';
                decorMenu.className = 'decor-menu';
                // start hidden
                decorMenu.style.display = 'none';

                const scaleLabel = document.createElement('div');
                scaleLabel.textContent = 'Scale: ';
                const scaleVal = document.createElement('span');
                scaleVal.textContent = '1.0';
                scaleLabel.appendChild(scaleVal);
                decorMenu.appendChild(scaleLabel);

                const layerLabel = document.createElement('div');
                layerLabel.textContent = 'Layer: ';
                const layerSelect = document.createElement('select');
                const optBehind = document.createElement('option'); optBehind.value = '0'; optBehind.text = 'Behind (0)';
                const optFront = document.createElement('option'); optFront.value = '1'; optFront.text = 'Front (1)';
                layerSelect.appendChild(optFront);
                layerSelect.appendChild(optBehind);
                // spacing handled by CSS
                layerLabel.appendChild(layerSelect);
                decorMenu.appendChild(layerLabel);

                const scaleMinus = document.createElement('button');
                scaleMinus.textContent = '-';
                scaleMinus.className = 'editor-btn';
                const scalePlus = document.createElement('button');
                scalePlus.textContent = '+';
                scalePlus.className = 'editor-btn';
                const deleteBtn = document.createElement('button');
                deleteBtn.textContent = 'Delete';
                deleteBtn.className = 'editor-btn delete';

                decorMenu.appendChild(scaleMinus);
                decorMenu.appendChild(scalePlus);
                decorMenu.appendChild(deleteBtn);
                editorUI.appendChild(decorMenu);

                // small floating menu for selected collider: width/height + delete
                const colliderMenu = document.createElement('div');
                colliderMenu.id = 'editor-collider-menu';
                colliderMenu.className = 'decor-menu';
                colliderMenu.style.display = 'none';

                const colliderWidthLabel = document.createElement('div');
                colliderWidthLabel.textContent = 'Width: ';
                const colliderWidthVal = document.createElement('span');
                colliderWidthVal.textContent = '0';
                colliderWidthLabel.appendChild(colliderWidthVal);
                colliderMenu.appendChild(colliderWidthLabel);

                const colliderHeightLabel = document.createElement('div');
                colliderHeightLabel.textContent = 'Height: ';
                const colliderHeightVal = document.createElement('span');
                colliderHeightVal.textContent = '0';
                colliderHeightLabel.appendChild(colliderHeightVal);
                colliderMenu.appendChild(colliderHeightLabel);

                const colliderWidthMinus = document.createElement('button'); colliderWidthMinus.textContent = '-'; colliderWidthMinus.className = 'editor-btn';
                const colliderWidthPlus = document.createElement('button'); colliderWidthPlus.textContent = '+'; colliderWidthPlus.className = 'editor-btn';
                const colliderHeightMinus = document.createElement('button'); colliderHeightMinus.textContent = '-'; colliderHeightMinus.className = 'editor-btn';
                const colliderHeightPlus = document.createElement('button'); colliderHeightPlus.textContent = '+'; colliderHeightPlus.className = 'editor-btn';
                const deleteColliderBtn = document.createElement('button'); deleteColliderBtn.textContent = 'Delete'; deleteColliderBtn.className = 'editor-btn delete';

                colliderMenu.appendChild(colliderWidthMinus);
                colliderMenu.appendChild(colliderWidthPlus);
                colliderMenu.appendChild(colliderHeightMinus);
                colliderMenu.appendChild(colliderHeightPlus);
                colliderMenu.appendChild(deleteColliderBtn);
                editorUI.appendChild(colliderMenu);

                // small floating menu for selected sign: 3 text lines + scale + delete
                const signMenu = document.createElement('div');
                signMenu.id = 'editor-sign-menu';
                signMenu.className = 'decor-menu';
                signMenu.style.display = 'none';

                const signLineInputs: HTMLInputElement[] = [];
                for (let i = 0; i < 3; i++) {
                  const lbl = document.createElement('div');
                  lbl.textContent = `Line ${i + 1}: `;
                  const inp = document.createElement('input');
                  inp.type = 'text';
                  inp.maxLength = 10 as any;
                  inp.className = 'editor-input';
                  lbl.appendChild(inp);
                  signMenu.appendChild(lbl);
                  signLineInputs.push(inp as HTMLInputElement);
                }
                const signScaleMinus = document.createElement('button'); signScaleMinus.textContent = '-'; signScaleMinus.className = 'editor-btn';
                const signScalePlus = document.createElement('button'); signScalePlus.textContent = '+'; signScalePlus.className = 'editor-btn';
                const signDeleteBtn = document.createElement('button'); signDeleteBtn.textContent = 'Delete'; signDeleteBtn.className = 'editor-btn delete';
                signMenu.appendChild(signScaleMinus);
                signMenu.appendChild(signScalePlus);
                signMenu.appendChild(signDeleteBtn);
                editorUI.appendChild(signMenu);

                // poll selection state from editor via canvas.dataset.editorSelected
                const pollId = window.setInterval(() => {
                  try {
                    const canvasElInner = canvasRef.current!;
                    const sel = canvasElInner.dataset.editorSelected;
                    if (!sel) {
                      decorMenu.style.display = 'none';
                      colliderMenu.style.display = 'none';
                      return;
                    }
                    const idx = Number(sel);
                    const obj = currentLevel.objects && currentLevel.objects[idx];
                    if (!obj) {
                      decorMenu.style.display = 'none';
                      colliderMenu.style.display = 'none';
                      return;
                    }

                    if (obj.type === 'decor') {
                      colliderMenu.style.display = 'none';
                      // show decor menu and update scale value
                      decorMenu.style.display = 'flex';
                      scaleVal.textContent = String((obj as any).scale || 1);
                      try { layerSelect.value = String((obj as any).layer ?? 1); } catch (e) { }
                      return;
                    }

                    if (obj.type === 'collider') {
                      decorMenu.style.display = 'none';
                      // show collider menu and update width/height
                      colliderMenu.style.display = 'flex';
                      const seg = (currentLevel.meta && (currentLevel.meta as any).segmentLen) || 1;
                      const defW = Math.max(1, seg * 2);
                      const w = (obj as any).width || defW;
                      const h = (obj as any).height || 24;
                      colliderWidthVal.textContent = String(w);
                      colliderHeightVal.textContent = String(h);
                      return;
                    }

                    if (obj.type === 'sign') {
                      // show sign menu and populate lines
                      decorMenu.style.display = 'none';
                      colliderMenu.style.display = 'none';
                      signMenu.style.display = 'flex';
                      const lines: string[] = Array.isArray((obj as any).message) ? (obj as any).message : [];
                      for (let i = 0; i < 3; i++) {
                        const val = lines[i] || '';
                        const inp = signLineInputs[i] as HTMLInputElement;
                        if (inp.value !== val) inp.value = val;
                      }
                      // store scale on sign objects
                      const s = (obj as any).scale || 1;
                      // show scale in a simple way by storing on a data attr for visual debugging
                      return;
                    }

                    // fallback: hide both
                    decorMenu.style.display = 'none';
                    colliderMenu.style.display = 'none';
                  } catch (e) { }
                }, 150);

                scalePlus.onclick = () => {
                  try {
                    const canvasElInner = canvasRef.current!;
                    const sel = canvasElInner.dataset.editorSelected;
                    if (!sel) return;
                    const idx = Number(sel);
                    const obj = currentLevel.objects && currentLevel.objects[idx];
                    if (!obj || obj.type !== 'decor') return;
                    obj.scale = (obj.scale || 1) + 0.1;
                    // notify editor overlay to refresh
                    try { (gameContext.editorStop as any)?.notify?.(); } catch (e) { }
                  } catch (e) { }
                };
                scaleMinus.onclick = () => {
                  try {
                    const canvasElInner = canvasRef.current!;
                    const sel = canvasElInner.dataset.editorSelected;
                    if (!sel) return;
                    const idx = Number(sel);
                    const obj = currentLevel.objects && currentLevel.objects[idx];
                    if (!obj || obj.type !== 'decor') return;
                    obj.scale = Math.max(0.1, (obj.scale || 1) - 0.1);
                    try { (gameContext.editorStop as any)?.notify?.(); } catch (e) { }
                  } catch (e) { }
                };
                deleteBtn.onclick = () => {
                  try {
                    const canvasElInner = canvasRef.current!;
                    const sel = canvasElInner.dataset.editorSelected;
                    if (!sel) return;
                    const idx = Number(sel);
                    if (!Array.isArray(currentLevel.objects)) return;
                    if (idx >= 0 && idx < currentLevel.objects.length) {
                      currentLevel.objects.splice(idx, 1);
                      // clear selection marker and notify
                      canvasElInner.dataset.editorSelected = '';
                      try { (gameContext.editorStop as any)?.notify?.(); } catch (e) { }
                    }
                  } catch (e) { }
                };

                layerSelect.onchange = () => {
                  try {
                    const canvasElInner = canvasRef.current!;
                    const sel = canvasElInner.dataset.editorSelected;
                    if (!sel) return;
                    const idx = Number(sel);
                    const obj = currentLevel.objects && currentLevel.objects[idx];
                    if (!obj || obj.type !== 'decor') return;
                    obj.layer = Number(layerSelect.value) || 0;
                    try { (gameContext.editorStop as any)?.notify?.(); } catch (e) { }
                  } catch (e) { }
                };

                // collider menu handlers
                colliderWidthPlus.onclick = () => {
                  try {
                    const canvasElInner = canvasRef.current!;
                    const sel = canvasElInner.dataset.editorSelected;
                    if (!sel) return;
                    const idx = Number(sel);
                    const obj = currentLevel.objects && currentLevel.objects[idx];
                    if (!obj || obj.type !== 'collider') return;
                    const inc = 10;
                    (obj as any).width = ((obj as any).width || 20) + inc;
                    try { (gameContext.editorStop as any)?.notify?.(); } catch (e) { }
                  } catch (e) { }
                };
                colliderWidthMinus.onclick = () => {
                  try {
                    const canvasElInner = canvasRef.current!;
                    const sel = canvasElInner.dataset.editorSelected;
                    if (!sel) return;
                    const idx = Number(sel);
                    const obj = currentLevel.objects && currentLevel.objects[idx];
                    if (!obj || obj.type !== 'collider') return;
                    const dec = 10;
                    (obj as any).width = Math.max(1, ((obj as any).width || 20) - dec);
                    try { (gameContext.editorStop as any)?.notify?.(); } catch (e) { }
                  } catch (e) { }
                };
                colliderHeightPlus.onclick = () => {
                  try {
                    const canvasElInner = canvasRef.current!;
                    const sel = canvasElInner.dataset.editorSelected;
                    if (!sel) return;
                    const idx = Number(sel);
                    const obj = currentLevel.objects && currentLevel.objects[idx];
                    if (!obj || obj.type !== 'collider') return;
                    const inc = 10;
                    (obj as any).height = ((obj as any).height || 24) + inc;
                    try { (gameContext.editorStop as any)?.notify?.(); } catch (e) { }
                  } catch (e) { }
                };
                colliderHeightMinus.onclick = () => {
                  try {
                    const canvasElInner = canvasRef.current!;
                    const sel = canvasElInner.dataset.editorSelected;
                    if (!sel) return;
                    const idx = Number(sel);
                    const obj = currentLevel.objects && currentLevel.objects[idx];
                    if (!obj || obj.type !== 'collider') return;
                    const dec = 10;
                    (obj as any).height = Math.max(1, ((obj as any).height || 24) - dec);
                    try { (gameContext.editorStop as any)?.notify?.(); } catch (e) { }
                  } catch (e) { }
                };
                deleteColliderBtn.onclick = () => {
                  try {
                    const canvasElInner = canvasRef.current!;
                    const sel = canvasElInner.dataset.editorSelected;
                    if (!sel) return;
                    const idx = Number(sel);
                    if (!Array.isArray(currentLevel.objects)) return;
                    if (idx >= 0 && idx < currentLevel.objects.length) {
                      currentLevel.objects.splice(idx, 1);
                      canvasElInner.dataset.editorSelected = '';
                      try { (gameContext.editorStop as any)?.notify?.(); } catch (e) { }
                    }
                  } catch (e) { }
                };

                // sign menu handlers
                signScalePlus.onclick = () => {
                  try {
                    const canvasElInner = canvasRef.current!;
                    const sel = canvasElInner.dataset.editorSelected;
                    if (!sel) return;
                    const idx = Number(sel);
                    const obj = currentLevel.objects && currentLevel.objects[idx];
                    if (!obj || obj.type !== 'sign') return;
                    (obj as any).scale = ((obj as any).scale || 1) + 0.1;
                    try { (gameContext.editorStop as any)?.notify?.(); } catch (e) { }
                  } catch (e) { }
                };
                signScaleMinus.onclick = () => {
                  try {
                    const canvasElInner = canvasRef.current!;
                    const sel = canvasElInner.dataset.editorSelected;
                    if (!sel) return;
                    const idx = Number(sel);
                    const obj = currentLevel.objects && currentLevel.objects[idx];
                    if (!obj || obj.type !== 'sign') return;
                    (obj as any).scale = Math.max(0.1, ((obj as any).scale || 1) - 0.1);
                    try { (gameContext.editorStop as any)?.notify?.(); } catch (e) { }
                  } catch (e) { }
                };
                signDeleteBtn.onclick = () => {
                  try {
                    const canvasElInner = canvasRef.current!;
                    const sel = canvasElInner.dataset.editorSelected;
                    if (!sel) return;
                    const idx = Number(sel);
                    if (!Array.isArray(currentLevel.objects)) return;
                    if (idx >= 0 && idx < currentLevel.objects.length) {
                      currentLevel.objects.splice(idx, 1);
                      canvasElInner.dataset.editorSelected = '';
                      try { (gameContext.editorStop as any)?.notify?.(); } catch (e) { }
                    }
                  } catch (e) { }
                };
                for (let i = 0; i < 3; i++) {
                  // prevent global key handlers from firing while typing
                  signLineInputs[i].addEventListener('keydown', (ev) => { ev.stopPropagation(); });
                  signLineInputs[i].addEventListener('keyup', (ev) => { ev.stopPropagation(); });
                  // update message on each input event so poll doesn't overwrite typed text
                  signLineInputs[i].addEventListener('input', () => {
                    try {
                      const canvasElInner = canvasRef.current!;
                      const sel = canvasElInner.dataset.editorSelected;
                      if (!sel) return;
                      const idx = Number(sel);
                      const obj = currentLevel.objects && currentLevel.objects[idx];
                      if (!obj || obj.type !== 'sign') return;
                      const lines = Array.isArray((obj as any).message) ? (obj as any).message.slice() : ['', '', ''];
                      lines[i] = (signLineInputs[i] as HTMLInputElement).value.slice(0, 10).toUpperCase();
                      (obj as any).message = lines;
                      try { (gameContext.editorStop as any)?.notify?.(); } catch (e) { }
                    } catch (e) { }
                  });
                }



                // attach menu to cleanup list
                (gameContext.editorStop as any).__exportImportNodes = { ...(gameContext.editorStop as any).__exportImportNodes || {}, decorLabel, decorMenu, colliderMenu, pollId };
                // store pollId globally as a fallback so we can clear it if needed
                try { (window as any).__editor_decor_poll = pollId; } catch (e) { }


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
                  el.className = 'editor-toast';
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
                (gameContext.editorStop as any).__exportImportNodes = { exportBtn, importBtn, fileInput, onDrop, onDragOver, widthLabel, heightLabel, widthInput, heightInput, resizeBtn, setHeightBtn, smoothLabel, smoothBtn, radiusInput, avalancheLabel, avalancheInput, setAvalBtn, decorLabel, decorMenu, colliderMenu, signMenu, pollId, editorUI };

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
                  // ignore zoom keys while typing in inputs
                  try {
                    const ae = document.activeElement as HTMLElement | null;
                    if (ae) {
                      const tag = (ae.tagName || '').toLowerCase();
                      if (tag === 'input' || tag === 'textarea' || tag === 'select' || ae.isContentEditable) return;
                    }
                  } catch (err) { }
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
                    try { nodes.avalancheLabel && nodes.avalancheLabel.remove(); } catch (e) { }
                    try { nodes.setAvalBtn && nodes.setAvalBtn.remove(); } catch (e) { }
                    try { nodes.avalancheInput && nodes.avalancheInput.remove(); } catch (e) { }
                    try { nodes.decorLabel && nodes.decorLabel.remove(); } catch (e) { }
                    try { nodes.uploadBtn && nodes.uploadBtn.remove(); } catch (e) { }
                    try { nodes.uploadInput && nodes.uploadInput.remove(); } catch (e) { }
                    try { window.removeEventListener('drop', nodes.onDrop); } catch (e) { }
                    try { window.removeEventListener('dragover', nodes.onDragOver); } catch (e) { }
                    try { nodes.editorUI && nodes.editorUI.remove(); } catch (e) { }
                    try { const n3 = document.getElementById('editor-ui'); if (n3) n3.remove(); } catch (e) { }
                  }
                } catch (e) { }
                // additional safety: remove any lingering decor UI by ID and clear poll
                try {
                  try { const n = document.getElementById('editor-decor-menu'); if (n) n.remove(); } catch (e) { }
                  try { const n2 = document.getElementById('editor-decor-label'); if (n2) n2.remove(); } catch (e) { }
                  try { const pid = (gameContext.editorStop as any).__exportImportNodes && (gameContext.editorStop as any).__exportImportNodes.pollId; if (pid) clearInterval(pid); } catch (e) { }
                  try { if ((window as any).__editor_decor_poll) { clearInterval((window as any).__editor_decor_poll); (window as any).__editor_decor_poll = null; } } catch (e) { }
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
