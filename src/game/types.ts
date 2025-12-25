import { Player } from '../player';
import { ParallaxLayer } from '../parallax';
import { AnimationStateMachine } from '../sprite';
import EffectsManager from '../effects';

export type GameState = 'title' | 'playing' | 'paused' | 'dead' | 'complete' | 'editor' | 'loading';

export interface Camera {
  x: number;
  y?: number;
}

export interface EditorHandlers {
  wheelHandler: (ev: WheelEvent) => void;
  onPointerDownPan: (ev: PointerEvent) => void;
  onPointerMovePan: (ev: PointerEvent) => void;
  onPointerUpPan: (ev: PointerEvent) => void;
  keydownHandler: (ev: KeyboardEvent) => void;
}

export interface GameContext {
  state: GameState;
  currentLevel: any;
  currentLevelIndex: number;

  currPlayer: Player;
  prevPlayer: Player;
  currCam: Camera;
  prevCam: Camera;

  lastGroundY: number | null;
  lastGroundAngle: number;
  ledgeGrace: number;

  lastSlope: number;
  lastSlopeEff: number;
  lastAccelRaw: number;
  lastAccelScaled: number;

  landingFlash: number;
  crashFlash: number;
  crashFade: number;
  crashTimer: number;
  restartHintTimer: number;
  fps: number;

  spacePressSnapshot: any;
  jumpAppliedThisFrame: boolean;
  lastContactBack: number | null;
  lastContactFront: number | null;
  lastContactAvg: number | null;
  lastNearGround: boolean;
  pendingImmediateJump: boolean;

  lastNonEditorState: GameState;
  editorStop: any | null;
  editorCamX: number;
  editorCamY: number;
  editorZoom: number;
  lastEditorZoom: number;

  parallax: ParallaxLayer[];
  effects: EffectsManager;
  playerEntity: AnimationStateMachine | null;

  sfxJump: any;
  sfxLand: any;
  sfxCheckpoint: any;
  sfxDeath: any;
  sfxComplete: any;

  coyoteTimer: number;
  jumpBuffer: number;
  jumpHold: number;
  jumpLock: number;

  lastCheckpointX: number;
  reachedFinish: boolean;
  deathTimer: number;
  // avalanche state: current leading X position and configured speed
  avalancheX?: number;
  avalancheSpeed?: number;
  avalancheActive?: boolean;
  avalancheEmitTimer?: number;
  avalancheClumpTimer?: number;
  // saved avalanche position/speed when player crashes (non-avalanche)
  savedAvalancheX?: number;
  savedAvalancheSpeed?: number;
  // when true, respawn should ignore checkpoints and restart at level start
  forceFullRestart?: boolean;

  snowPattern: CanvasPattern | null;
  noisePattern: CanvasPattern | null;
  woodPattern?: CanvasPattern | null;

  // boost/stamina: normalized 0..1, refill-block timer when fully depleted
  boostStamina: number;
  boostRefillBlockedTimer: number;
  // boost UI / lock state
  boostLocked: boolean;
  boostFullVisibleTimer: number;
  boostBlinkTimer: number;
  boostBlinkOn: boolean;
  isBoosting: boolean;

  accumulator: number;
  lastTime: number;
}
