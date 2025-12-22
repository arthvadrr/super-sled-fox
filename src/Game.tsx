import React, { useRef, useEffect } from 'react';

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
    const canvasEl = canvasRef.current!;
    const ctx = canvasEl.getContext('2d')!;

    // virtual (offscreen) canvas at fixed virtual resolution
    const vcanvas = document.createElement('canvas');
    vcanvas.width = VIRTUAL_WIDTH;
    vcanvas.height = VIRTUAL_HEIGHT;
    const vctx = vcanvas.getContext('2d')!;

    // simple sim state to demonstrate fixed-timestep updates
    type SimState = { x: number; vx: number };
    type CamState = { x: number };

    const currSim: SimState = { x: 40, vx: 40 };
    let prevSim: SimState = { ...currSim };

    const currCam: CamState = { x: currSim.x };
    let prevCam: CamState = { ...currCam };

    // simulation step (fixed dt seconds)
    function simulate(dt: number) {
      currSim.x += currSim.vx * dt;
      if (currSim.x > VIRTUAL_WIDTH + 20) currSim.x = -20;
      // simple camera: follow player directly
      currCam.x = currSim.x;
    }

    function draw() {
      // interpolation alpha based on accumulator
      const alpha = Math.max(0, Math.min(1, accumulator / FIXED_DT));

      // interpolate sim and camera
      const ix = prevSim.x * (1 - alpha) + currSim.x * alpha;
      const camx = prevCam.x * (1 - alpha) + currCam.x * alpha;

      // draw scene into virtual canvas (virtual pixels)
      vctx.fillStyle = '#0b1220';
      vctx.fillRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);

      // compute camera offset (centered)
      const camOffsetX = Math.round(camx - VIRTUAL_WIDTH / 2);

      // player placeholder -- transformed by camera
      vctx.fillStyle = '#fff';
      vctx.fillRect(Math.round(ix - camOffsetX) - 8, Math.round(VIRTUAL_HEIGHT / 2) - 8, 16, 16);

      vctx.fillStyle = '#fff';
      vctx.font = '14px monospace';
      vctx.fillText('Virtual 400×225 — interpolated render', 8, 18);

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
      lastTime = now;
      accumulator += delta;
      // detect simple game-state transitions and reset timing to avoid large accumulator
      if (lastGameState !== stateRef.current) {
        lastGameState = stateRef.current;
        // prevent interpolation artifacts by syncing snapshots
        prevSim = { ...currSim };
        prevCam = { ...currCam };
        accumulator = 0;
        lastTime = now;
      }

      if (stateRef.current === 'playing') {
        while (accumulator >= FIXED_DT) {
          // advance snapshots
          prevSim = { ...currSim };
          prevCam = { ...currCam };
          simulate(FIXED_DT);
          accumulator -= FIXED_DT;
        }
      } else {
        // not playing: don't advance sim; clamp accumulator so alpha stays sensible
        accumulator = 0;
      }

      draw();
      rafId = requestAnimationFrame(loop);
    }

    rafId = requestAnimationFrame(loop);

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(rafId);
    };
  }, []);

  return <canvas ref={canvasRef} style={{ position: 'fixed', left: 0, top: 0, width: '100%', height: '100%' }} />;
}
