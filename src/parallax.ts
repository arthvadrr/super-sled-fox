import type AssetManager from './assetManager';

export type ParallaxLayer = {
  img: HTMLImageElement | null;
  factor: number; // scroll factor relative to camera
  yOff: number; // vertical offset in virtual pixels
  tile?: boolean; // whether to tile horizontally
  alpha?: number; // layer opacity
};

export async function loadParallaxLayers(assetMgr: any, layersSpec: any[] = []): Promise<ParallaxLayer[]> {
  const out: ParallaxLayer[] = [];
  if (!Array.isArray(layersSpec)) return out;
  for (const L of layersSpec) {
    const src = typeof L === 'string' ? L : L && L.src;
    const factor = (L && (L.factor ?? L.scrollFactor)) ?? (typeof L === 'string' ? 0.5 : 0.5);
    const yOff = (L && L.y) ?? 0;
    const tile = L && (typeof L.tile === 'boolean' ? L.tile : true);
    const alpha = (L && L.alpha) ?? 1;
    if (!src) {
      out.push({ img: null, factor, yOff, tile, alpha });
      continue;
    }
    try {
      // Try the literal src first, but fall back to common alternate extensions
      // (e.g. .svg <-> .png) so levels can reference one while the asset exists
      // with the other extension.
      const candidates: string[] = [src];
      try {
        const lower = String(src).toLowerCase();
        if (lower.endsWith('.svg')) candidates.push(src.replace(/\.svg$/i, '.png'));
        else if (lower.endsWith('.png')) candidates.push(src.replace(/\.png$/i, '.svg'));
      } catch (e) {
        // ignore
      }
      const img = await assetMgr.loadImageAny(candidates);

      out.push({ img, factor, yOff, tile, alpha });
    } catch (e) {
      out.push({ img: null, factor, yOff, tile, alpha });
    }
  }
  return out;
}

export default { loadParallaxLayers };
