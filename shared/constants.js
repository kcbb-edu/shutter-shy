export const GAME_PHASES = {
  LOBBY: "LOBBY",
  ROLE_SELECT: "ROLE_SELECT",
  ATTACKER_SETUP: "ATTACKER_SETUP",
  WAITING_READY: "WAITING_READY",
  COUNTDOWN: "COUNTDOWN",
  PLAYING: "PLAYING",
  RESULT: "RESULT"
};

export const ROLES = {
  ATTACKER: "attacker",
  PLAYER: "player"
};

export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;
export const GAME_DURATION_SECONDS = 30;
export const COUNTDOWN_SECONDS = 3;
export const RESULT_SECONDS = 10;
export const MAX_PLAYERS = 8;
export const RUNNER_LIVES = 3;
export const RESPAWN_DELAY_SECONDS = 1.4;
export const MAX_RECENT_EVENTS = 6;
export const RECENT_EVENT_SECONDS = 4.5;
export const FACE_SNAPSHOT_INTERVAL_MS = 1000;
export const FACE_UPLOAD_TARGET_MS = 1000;
export const FACE_STALE_HOLD_MS = 15000;
export const MAX_FACE_SNAPSHOT_BYTES = 220_000;
export const ELIMINATION_SNAPSHOT_WIDTH = 960;
export const MAX_HIGHLIGHT_SNAPSHOTS_PER_ROUND = 24;

export const WORLD = {
  width: 1,
  height: 1,
  aspectRatio: 16 / 9,
  platformY: 0.32,
  waveBaselineY: 0.88,
  baseGameplayWidth: 1,
  ultrawideThreshold: 2.1,
  extraWideThreshold: 3.4,
  ultrawideGameplayWidth: 1.48,
  extraWideGameplayWidth: 1.9,
  playerWidth: 0.035,
  playerHeight: 0.09,
  gravity: 1.55,
  moveAcceleration: 2.6,
  maxMoveSpeed: 0.42,
  ultrawideMoveSpeedMultiplier: 1.18,
  extraWideMoveSpeedMultiplier: 1.32,
  frictionGround: 0.78,
  frictionAir: 0.94,
  jumpVelocity: -0.86,
  edgeZoneWidth: 0.12,
  ultrawideEdgeZoneWidth: 0.18,
  extraWideEdgeZoneWidth: 0.24,
  edgeDropDepth: 0.1,
  slopeSlideAcceleration: 0.85,
  terrainSigma: 0.065,
  ultrawideTerrainSigma: 0.09,
  extraWideTerrainSigma: 0.12,
  terrainAmplitudeMax: 0.64,
  terrainAmplitudeFloor: 0.0,
  eqBandCount: 12,
  eqNeighborDecay: 0.35,
  eqEdgeWidthMultiplier: 1.38,
  eqCenterWidthMultiplier: 0.84,
  eqHeightMax: 0.64,
  eqIdleFloor: 0.0,
  frequencySmoothing: 0.24,
  frequencyInputSmoothing: 0.42,
  frequencyHysteresis: 0.04,
  maxFrequencyStepPerTick: 0.12,
  amplitudeAttack: 0.32,
  amplitudeRelease: 0.1,
  knockoutJumpVelocity: -0.52,
  knockoutHorizontalVelocity: 0.18,
  spawnPadding: 0.14,
  ultrawideSpawnPadding: 0.2,
  extraWideSpawnPadding: 0.28
};

export const AUDIO = {
  minHz: 85,
  maxHz: 2000,
  analysisMinHz: 85,
  analysisMaxHz: 1600,
  defaultProfileLowHz: 95,
  defaultProfileHighHz: 720,
  profileQuantileLow: 0.15,
  profileQuantileHigh: 0.85,
  profilePadRatio: 0.1,
  profileMinSpanHz: 240,
  profileMaxSpanHz: 760,
  analysisProbeBandCount: 24,
  voicedBandShareFloor: 0.08,
  voicedLoudAmplitudeFloor: 0.12,
  voicedOnAmplitudeFloor: 0.05,
  voicedOffAmplitudeFloor: 0.025,
  voicedPersistenceMs: 140,
  rawBandTiltPower: 0.52,
  probeBandTiltPower: 0.2,
  minAmplitude: 0.001,
  maxAmplitude: 0.024,
  voicedStrongAmplitudeFloor: 0.30
};

export const VIEWPORT_POLICY = {
  gameplayAspectRatio: WORLD.aspectRatio,
  letterbox: true,
  stretchGameplay: false
};

export const PLAYER_COLORS = [
  "#ff6b6b",
  "#ffd166",
  "#06d6a0",
  "#4cc9f0",
  "#5e60ce",
  "#f72585",
  "#90be6d",
  "#f9844a"
];

export const HIGHLIGHT_EVENT_PRIORITIES = {
  "player-out": 4,
  "life-lost": 3,
  "round-start": 2,
  "round-end": 1
};
