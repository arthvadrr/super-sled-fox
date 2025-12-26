import assetManager from '../assetManager';
import audioManager from '../audioManager';
import { createSpriteSheet, AnimatedSprite, AnimationStateMachine } from '../sprite';
import { loadParallaxLayers } from '../parallax';
import { GameContext } from './types';
import { LEVELS } from '../levels';
import { PLAYER_DEFAULTS } from '../player';

export async function loadLevelAssets(ctx: GameContext) {
  try {
    const meta: any = ctx.currentLevel.meta || {};
    const assets = meta.assets || [];
    if (!Array.isArray(assets) || assets.length === 0) {
      await new Promise((r) => setTimeout(r, 500));
    }

    const promises = assets.map(async (a: string) => {
      const lower = a.toLowerCase();
      if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.webp')) {
        await assetManager.loadImage(a);
      } else if (lower.endsWith('.mp3') || lower.endsWith('.ogg') || lower.endsWith('.m4a') || lower.endsWith('.wav')) {
        await assetManager.loadAudio(a);
      } else {
        await assetManager.loadImage(a).catch(() => assetManager.loadAudio(a).catch(() => {}));
      }
    });

    await Promise.race([Promise.all(promises), new Promise((r) => setTimeout(r, 2000))]);

    try {
      const sfxMeta: any = meta.sfx || {};
      ctx.sfxJump = await audioManager.createSound(sfxMeta.jump || 'sfx/jump.mp3').catch(() => null);
      ctx.sfxLand = await audioManager.createSound(sfxMeta.land || 'sfx/land.mp3').catch(() => null);
      ctx.sfxCheckpoint = await audioManager.createSound(sfxMeta.checkpoint || 'sfx/checkpoint.mp3').catch(() => null);
      ctx.sfxDeath = await audioManager.createSound(sfxMeta.death || 'sfx/death.mp3').catch(() => null);
      ctx.sfxComplete = await audioManager.createSound(sfxMeta.complete || 'sfx/complete.mp3').catch(() => null);
    } catch (e) {}

    // load background music if specified in level meta (meta.music)
    try {
      // stop any previous music before loading new
      try { ctx.music?.pause?.(); } catch (e) {}
      ctx.music = undefined;
      const musicPath = meta.music || (meta.assets && (meta.assets as any).music);
      if (musicPath) {
        ctx.music = await audioManager.createSound(musicPath).catch(() => null);
        if (ctx.music) {
          try { ctx.music.loop = true; } catch (e) {}
          try { void ctx.music.play?.(); } catch (e) {}
        }
      }
    } catch (e) {}

    try {
      const layersSpec: any[] = meta.parallax || meta.layers || [];
      const loaded = await loadParallaxLayers(assetManager, layersSpec);
      ctx.parallax.push(...loaded);
    } catch (e) {}

    try {
      // Prefer the new 64x64 spritesheet if present, fall back to older 32px assets.
      const pImg = await assetManager
        .loadImageAny(['sprites/sled-fox-64-spritesheet.png', 'sprites/player.png', 'sprites/player.svg', 'sprites/fox-sled.png', 'sprites/fox-sled.svg'])
        .catch(() => null);
      // assetManager may return a data-URL placeholder when none of the
      // candidates exist. Treat data: URLs as "not found" so we don't create
      // a fake sprite from the placeholder image (which would later render
      // as an undesired square or junk art).
      const isPlaceholder = !pImg || (typeof pImg.src === 'string' && pImg.src.startsWith('data:'));
      // Debug: log what image source we ended up with so the browser console
      // will show 404s or wrong paths when running the app.
      try {
        // suppressed asset debug logging
      } catch (e) {}
      if (!isPlaceholder && pImg) {
        // Choose frame size depending on which image was actually loaded.
        const src = typeof pImg.src === 'string' ? pImg.src : '';
        const use64 = src.includes('sled-fox-64-spritesheet') || src.includes('sled-fox-64-spritesheet.png');
        const frameW = use64 ? 64 : 32;
        const frameH = frameW;
        const sheet = createSpriteSheet(pImg, frameW, frameH);
        const base = new AnimatedSprite(sheet);
        // If we have a full-width spritesheet, interpret rows as: row0=idle, row1=jump
        if (use64 && sheet.cols > 0) {
          const idleFrames: number[] = [];
          const jumpFrames: number[] = [];
          for (let c = 0; c < sheet.cols; c++) idleFrames.push(c);
          for (let c = 0; c < sheet.cols; c++) jumpFrames.push(sheet.cols + c);
          if (idleFrames.length > 0) base.addAnim('idle', idleFrames, 8, true);
          if (jumpFrames.length > 0) base.addAnim('jump', jumpFrames, 10, false);
          // fallback run animation (use idle frames if not provided)
          if (idleFrames.length > 1) base.addAnim('run', idleFrames, 14, true);
        } else {
          base.addAnim('idle', [0], 6, true);
          const runFrames: number[] = [];
          for (let i = 1; i <= Math.min(4, sheet.frameCount - 1); i++) runFrames.push(i);
          if (runFrames.length > 0) base.addAnim('run', runFrames, 14, true);
          if (sheet.frameCount > 5) base.addAnim('jump', [5], 12, false);
          if (sheet.frameCount > 6) base.addAnim('fall', [6], 12, false);
        }
        const entity = new AnimationStateMachine();
        entity.addLayer(base, { fallback: 'idle' }, 0, 0);

        try {
          const acc = await assetManager.loadImage('sprites/player_hat.png').catch(() => null);
          // assetManager may return a data-URL placeholder when the file is
          // missing. Don't treat that as a real accessory image — otherwise
          // the placeholder will render as a gray square over the player.
          const accIsPlaceholder = !acc || (typeof acc.src === 'string' && acc.src.startsWith('data:'));
          if (!accIsPlaceholder && acc) {
            const accSheet = createSpriteSheet(acc, 32, 32);
            const accSprite = new AnimatedSprite(accSheet);
            accSprite.addAnim('idle', [0], 6, true);
            if (accSheet.frameCount > 1) {
              const f: number[] = [];
              for (let i = 1; i <= Math.min(4, accSheet.frameCount - 1); i++) f.push(i);
              accSprite.addAnim('run', f, 14, true);
            }
            if (accSheet.frameCount > 5) accSprite.addAnim('jump', [5], 12, false);
            if (accSheet.frameCount > 6) accSprite.addAnim('fall', [6], 12, false);
            entity.addLayer(accSprite, { fallback: 'idle' }, 0, 0);
          }
        } catch (e) {}
        ctx.playerEntity = entity;
        // keep a template instance so we can restore the sprite after it's nulled on crash
        try {
          (ctx as any).playerEntityTemplate = entity;
        } catch (e) {}
      }
    } catch (e) {}
  } catch (e) {}
}

export async function loadLevelByIndex(ctx: GameContext, idx: number, respawnFn: () => void) {
  if (idx < 0 || idx >= LEVELS.length) return;
  // stop any existing level music before switching levels
  try { ctx.music?.pause?.(); } catch (e) {}
  ctx.music = undefined;
  ctx.currentLevelIndex = idx;
  ctx.currentLevel = JSON.parse(JSON.stringify(LEVELS[idx].level));
  ctx.state = 'loading';
  ctx.parallax.length = 0;

  try {
    const startObjNew = (ctx.currentLevel.objects || []).find((o: any) => o.type === 'start');
    ctx.lastCheckpointX = startObjNew ? startObjNew.x : PLAYER_DEFAULTS.startX;
    ctx.reachedFinish = false;
  } catch (e) {}

  await loadLevelAssets(ctx);
  respawnFn();
  ctx.restartHintTimer = 2.5;
}
