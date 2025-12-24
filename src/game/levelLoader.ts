import assetManager from '../assetManager';
import audioManager from '../audioManager';
import { createSpriteSheet, AnimatedSprite, AnimationStateMachine } from '../sprite';
import { loadParallaxLayers } from '../parallax';
import { GameContext } from './types';
import { LEVELS } from '../levels';
import { PLAYER_DEFAULTS } from '../player';
import { getHeightAtX, getSlopeAtX } from '../heightmap';

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
        await assetManager.loadImage(a).catch(() => assetManager.loadAudio(a).catch(() => { }));
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
    } catch (e) { }

    try {
      const layersSpec: any[] = meta.parallax || meta.layers || [];
      const loaded = await loadParallaxLayers(assetManager, layersSpec);
      ctx.parallax.push(...loaded);
    } catch (e) { }

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
        
        try {
          const acc = await assetManager.loadImage('sprites/player_hat.png').catch(() => null);
          if (acc) {
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
        } catch (e) { }
        ctx.playerEntity = entity;
      }
    } catch (e) { }
  } catch (e) { }
}

export async function loadLevelByIndex(ctx: GameContext, idx: number, respawnFn: () => void) {
  if (idx < 0 || idx >= LEVELS.length) return;
  ctx.currentLevelIndex = idx;
  ctx.currentLevel = JSON.parse(JSON.stringify(LEVELS[idx].level));
  ctx.state = 'loading';
  ctx.parallax.length = 0;
  
  try {
    const startObjNew = (ctx.currentLevel.objects || []).find((o: any) => o.type === 'start');
    ctx.lastCheckpointX = startObjNew ? startObjNew.x : PLAYER_DEFAULTS.startX;
    ctx.reachedFinish = false;
  } catch (e) { }

  await loadLevelAssets(ctx);
  respawnFn();
  ctx.restartHintTimer = 2.5;
}