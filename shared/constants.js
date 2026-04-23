export const GAME_PHASES = {
  BOOT: "BOOT",
  LOBBY: "LOBBY",
  ASSET_LOADING: "ASSET_LOADING",
  ROLE_ASSIGN: "ROLE_ASSIGN",
  READY: "READY",
  COUNTDOWN: "COUNTDOWN",
  PLAYING: "PLAYING",
  RESULTS: "RESULTS"
};

export const CLIENT_TYPES = {
  DISPLAY: "display",
  CONTROLLER: "controller"
};

export const ROLES = {
  PHOTOGRAPHER: "photographer",
  RUNNER: "runner"
};

export const ROOM_CODE_LENGTH = 4;
export const MAX_RUNNERS = 3;
export const MAX_PLAYERS = MAX_RUNNERS + 1;
export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;
export const COUNTDOWN_SECONDS = 3;
export const ROUND_SECONDS = 30;
export const RESULTS_SECONDS = 60;
export const SHUTTER_COOLDOWN_MS = 1000;
export const FACE_UPLOAD_INTERVAL_MS = 500;
export const MAX_FACE_FRAME_BYTES = 260_000;
export const MAX_PHOTO_BYTES = 650_000;
export const LOAD_READY_PERCENT = 100;

export const ARENA = {
  runnerLanes: [7.5, 9.6, 11.7],
  plazaTopRadius: 15,
  plazaBottomRadius: 15.2,
  plazaHeight: 0.5,
  ringRadii: [12.5, 10.4, 8.2],
  ringTubeRadius: 0.18,
  ringY: 0.28,
  pedestalTopRadius: 2.6,
  pedestalBottomRadius: 3,
  pedestalHeight: 1.4,
  pedestalY: 0.65,
  fountainRadius: 4.5,
  fountainBaseTopRadius: 5.1,
  fountainBaseBottomRadius: 5.5,
  fountainBaseHeight: 0.55,
  fountainBaseY: 0.28,
  fountainJetCount: 6,
  fountainJetTopRadius: 0.45,
  fountainJetBottomRadius: 0.65,
  fountainJetHeight: 4.8,
  fountainJetY: 2.4,
  avatarHeight: 1.8,
  cameraHeight: 1.65,
  spectatorStandCamera: {
    position: {
      x: 0,
      y: 13,
      z: 32
    },
    target: {
      x: 0,
      // Seed stand-view direction only; the spectator solver adjusts target Y.
      y: -3,
      z: 0
    },
    fov: 43
  },
  spectatorProductionCamera: {
    position: {
      x: -22,
      y: 18,
      z: 28
    },
    target: {
      x: 0,
      y: 1.5,
      z: 0
    },
    fov: 42
  },
  spectatorDisplayViewportScale: 1.0,
  spectatorFraming: {
    radialSamples: 48,
    targetYRange: {
      min: -8,
      max: 2
    },
    targetYSearchSteps: 24,
    targetYIterations: 12,
    safeFrame: {
      width: 0.84,
      height: 0.8
    },
    allowanceTop: 0.94,
    readableJetTopY: 5.2
  },
  themeBackdrop: {
    enabled: true,
    enabledModes: {
      spectator: true,
      controllerPhotographer: true,
      controllerRunner: false
    },
    pillars: {
      count: 32,
      photographerCount: 18,
      radius: 18.8,
      radialJitter: 1.4,
      width: 0.46,
      depth: 0.46,
      baseHeight: 3.8,
      heightVariance: 2.4,
      bobAmplitude: 0.65,
      bobSpeed: 0.32
    },
    waveRings: {
      count: 4,
      photographerCount: 3,
      radii: [17.8, 20.8, 24, 27.2],
      heights: [4.3, 5.5, 6.9, 8.4],
      tubeRadius: 0.08,
      pulseAmount: 0.035,
      rotationSpeed: 0.08
    },
    floatingCubes: {
      count: 16,
      photographerCount: 0,
      radiusMin: 15.8,
      radiusMax: 22.4,
      sizeMin: 0.45,
      sizeMax: 1.15,
      heightMin: 3.5,
      heightMax: 8.8,
      bobAmplitude: 0.34,
      bobSpeed: 0.42
    }
  },
  cameraVerticalFovRadians: THREE_DEG_TO_RAD(55),
  captureAspectRatio: 9 / 16,
  captureWidth: 540,
  captureHeight: 960,
  pitchClamp: {
    min: -0.7,
    max: 0.45
  },
  yawSpeedPerSecond: 1.6,
  laneSwapCooldownMs: 500,
  runnerAngularSpeed: 0.9,
  obstructionAnglePadding: 0.22,
  runnerBodyAnglePadding: 0.09,
  obstructionCoverageThreshold: 0.8,
  obstructionPulseMs: 1600,
  countdownLeadMs: COUNTDOWN_SECONDS * 1000
};

function THREE_DEG_TO_RAD(degrees) {
  return (degrees * Math.PI) / 180;
}

export const PLAYER_COLORS = ["#ff6b6b", "#ffd166", "#06d6a0", "#4cc9f0"];
