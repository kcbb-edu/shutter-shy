import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";
import { ArenaView } from "../common/scene";
import { installViewportCssVars } from "../common/viewport";
import {
  ARENA,
  CLIENT_TYPES,
  DEFAULT_ARENA_THEME_ID,
  GAME_PHASES,
  MSG_TYPES,
  ROLES,
  SHUTTER_COOLDOWN_MS
} from "../../shared/protocol.js";
import {
  COPY,
  formatRoleLabel,
  formatThemeLabel,
  formatWinnerTitle,
  getRoomClosedMessage
} from "../../shared/copy.js";

const socketUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
const RECENT_ROOM_KEY = "shutter-shy:room";
const NAME_KEY = "shutter-shy:name";
const SESSION_KEY = "shutter-shy:session";
const FACE_UPLOAD_INTERVAL_MS = 400;
const FACE_DETECTION_INTERVAL_MS = 180;
const FACE_CROP_SCALE = 1.12;
const FACE_CROP_VERTICAL_BIAS = -0.16;
const FACE_DETECTION_WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm";
const FACE_DETECTION_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
const RANDOM_NAMES = [
  "小光",
  "米糕",
  "阿拍",
  "小宇",
  "布丁",
  "可樂",
  "小葵",
  "阿翔"
];

type ControllerStep =
  | "join"
  | "role-select"
  | "permissions"
  | "ready"
  | "countdown"
  | "playing-runner"
  | "playing-photographer"
  | "post-round";

type MediaPipeResult = Awaited<ReturnType<FaceDetector["detectForVideo"]>>;
type ArenaThemeId = "neon" | "synthwave";
type ThemePreference = ArenaThemeId | null;

type PendingAction<T> = {
  value: T;
  sinceRevision: number;
} | null;

const elements = {
  app: document.getElementById("controller-app") as HTMLElement,
  canvas: document.getElementById("controller-canvas") as HTMLCanvasElement,
  flash: document.getElementById("camera-flash") as HTMLElement,
  topRoomCode: document.getElementById("top-room-code") as HTMLElement,
  topPlayerName: document.getElementById("top-player-name") as HTMLElement,
  topRole: document.getElementById("top-role") as HTMLElement,
  topStateDot: document.getElementById("top-state-dot") as HTMLElement,
  leaveButton: document.getElementById("leave-button") as HTMLButtonElement,
  flowStage: document.getElementById("flow-stage") as HTMLElement,
  joinScreen: document.getElementById("join-screen") as HTMLElement,
  roleScreen: document.getElementById("role-screen") as HTMLElement,
  permissionsScreen: document.getElementById("permissions-screen") as HTMLElement,
  readyScreen: document.getElementById("ready-screen") as HTMLElement,
  countdownScreen: document.getElementById("countdown-screen") as HTMLElement,
  postRoundScreen: document.getElementById("post-round-screen") as HTMLElement,
  joinStatus: document.getElementById("join-status") as HTMLElement,
  nameInput: document.getElementById("name-input") as HTMLInputElement,
  roomInput: document.getElementById("room-input") as HTMLInputElement,
  randomNameButton: document.getElementById("random-name-button") as HTMLButtonElement,
  joinButton: document.getElementById("join-button") as HTMLButtonElement,
  photographerRole: document.getElementById("photographer-role") as HTMLButtonElement,
  runnerRole: document.getElementById("runner-role") as HTMLButtonElement,
  roleStatus: document.getElementById("role-status") as HTMLElement,
  roleRoomStatus: document.getElementById("role-room-status") as HTMLElement,
  permissionsTitle: document.getElementById("permissions-title") as HTMLElement,
  permissionsCopy: document.getElementById("permissions-copy") as HTMLElement,
  rolePlayers: document.getElementById("role-players") as HTMLElement,
  runnerPermissions: document.getElementById("runner-permissions") as HTMLElement,
  photographerPermissions: document.getElementById("photographer-permissions") as HTMLElement,
  faceToggleButton: document.getElementById("face-toggle-button") as HTMLButtonElement,
  faceVideo: document.getElementById("face-video") as HTMLVideoElement,
  faceFrameShell: document.getElementById("face-frame-shell") as HTMLElement,
  facePreviewCanvas: document.getElementById("face-preview-canvas") as HTMLCanvasElement,
  facePreviewImage: document.getElementById("face-preview-image") as HTMLImageElement,
  faceGuideLabel: document.getElementById("face-guide-label") as HTMLElement,
  runnerSetupStatus: document.getElementById("runner-setup-status") as HTMLElement,
  motionButton: document.getElementById("motion-button") as HTMLButtonElement,
  photographerSetupStatus: document.getElementById("photographer-setup-status") as HTMLElement,
  themePicker: document.getElementById("theme-picker") as HTMLElement,
  themeModeLabel: document.getElementById("theme-mode-label") as HTMLElement,
  themeStatus: document.getElementById("theme-status") as HTMLElement,
  themeRandomButton: document.getElementById("theme-random-button") as HTMLButtonElement,
  themeNeonButton: document.getElementById("theme-neon-button") as HTMLButtonElement,
  themeSynthwaveButton: document.getElementById("theme-synthwave-button") as HTMLButtonElement,
  permissionsNextButton: document.getElementById("permissions-next-button") as HTMLButtonElement,
  permissionsBackButton: document.getElementById("permissions-back-button") as HTMLButtonElement,
  permissionPlayers: document.getElementById("permission-players") as HTMLElement,
  countdownCopy: document.getElementById("countdown-copy") as HTMLElement,
  countdownNumber: document.getElementById("countdown-number") as HTMLElement,
  postRoundTitle: document.getElementById("post-round-title") as HTMLElement,
  postRoundCopy: document.getElementById("post-round-copy") as HTMLElement,
  postRoundSummary: document.getElementById("post-round-summary") as HTMLElement,
  controllerReadybar: document.getElementById("controller-readybar") as HTMLElement,
  runnerPlayUi: document.getElementById("runner-play-ui") as HTMLElement,
  runnerPhaseCopy: document.getElementById("runner-phase-copy") as HTMLElement,
  runnerTimer: document.getElementById("runner-timer") as HTMLElement,
  runnerFaceThumb: document.getElementById("runner-face-thumb") as HTMLCanvasElement,
  moveLeft: document.getElementById("move-left") as HTMLButtonElement,
  moveRight: document.getElementById("move-right") as HTMLButtonElement,
  laneIn: document.getElementById("lane-in") as HTMLButtonElement,
  laneOut: document.getElementById("lane-out") as HTMLButtonElement,
  photographerPlayUi: document.getElementById("photographer-play-ui") as HTMLElement,
  photographerPhaseCopy: document.getElementById("photographer-phase-copy") as HTMLElement,
  photographerTimer: document.getElementById("photographer-timer") as HTMLElement,
  shutterButton: document.getElementById("shutter-button") as HTMLButtonElement,
  shutterCooldownRing: document.getElementById("shutter-cooldown-ring") as HTMLElement,
  shutterCooldownLabel: document.getElementById("shutter-cooldown-label") as HTMLElement,
  gallery: document.getElementById("gallery") as HTMLElement,
  closeDownloadsButton: document.getElementById("close-downloads-button") as HTMLButtonElement
};

const state = {
  socket: null as WebSocket | null,
  room: null as any,
  lobby: null as any,
  round: null as any,
  gallery: null as any,
  lobbyRevision: -1,
  roundRevision: -1,
  self: { playerId: null as string | null, role: null as string | null },
  roomCode: new URLSearchParams(location.search).get("room") || localStorage.getItem(RECENT_ROOM_KEY) || "",
  playerName: localStorage.getItem(NAME_KEY) || "",
  joinNamePlaceholder: "",
  sessionId: localStorage.getItem(SESSION_KEY) || crypto.randomUUID(),
  joined: false,
  shouldAutoHello: false,
  didReportLoadReady: false,
  currentMoveDirection: 0,
  view: new ArenaView(elements.canvas, "controller"),
  faceStream: null as MediaStream | null,
  faceCanvas: document.createElement("canvas"),
  facePreviewUrl: "",
  orientation: {
    enabled: false,
    baseAlpha: null as number | null,
    yaw: 0,
    pitch: -0.05
  },
  localStepOverride: null as null | "permissions",
  downloadsOpen: false,
  downloadsStickyRoundId: "",
  downloadsSnapshot: null as any,
  galleryDismissedRoundId: "",
  flashTimeout: 0,
  faceDetector: null as FaceDetector | null,
  faceDetectorReady: false,
  faceDetectionBusy: false,
  faceDetectionRaf: 0,
  lastFaceUploadAt: 0,
  runnerCameraActive: false,
  faceCameraActive: false,
  faceReadyLive: false,
  faceCameraStarting: false,
  faceToggleDesired: null as boolean | null,
  faceError: "",
  smoothedFaceCrop: null as null | { cropX: number; cropY: number; cropSize: number },
  lastFaceDetectedAt: 0,
  lastFaceDetectionRunAt: 0,
  motionReadyOverride: null as boolean | null,
  pendingRole: null as PendingAction<string | null>,
  pendingTheme: null as PendingAction<ThemePreference>,
  pendingReady: null as PendingAction<boolean>,
  pendingFaceToggle: null as PendingAction<boolean>,
  pendingMotionPermission: false,
  lastInlineError: "",
  shutterCooldownUntil: 0,
  shutterCooldownRaf: 0,
  shutterInputLockUntil: 0,
  lastShutterTriggerAt: 0
};

installViewportCssVars({
  freezeHeightOnKeyboard: true,
  onChange: () => {
    state.view.resize();
  }
});

function keepFocusedFieldVisible(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return;
  }
  if (!target.matches("input, textarea, select")) {
    return;
  }
  window.setTimeout(() => {
    target.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  }, 180);
}

function debugLog(event: string, details: Record<string, unknown> = {}) {
  console.debug(`[shutter-shy] ${event}`, details);
}

function pickRandomName() {
  return RANDOM_NAMES[Math.floor(Math.random() * RANDOM_NAMES.length)];
}

function refreshJoinPlaceholder() {
  state.joinNamePlaceholder = pickRandomName();
  elements.nameInput.placeholder = `${state.joinNamePlaceholder}${COPY.controller.namePlaceholderSuffix}`;
}

if (!state.playerName) {
  refreshJoinPlaceholder();
} else {
  state.joinNamePlaceholder = state.playerName;
  elements.nameInput.placeholder = `${state.joinNamePlaceholder}${COPY.controller.namePlaceholderSuffix}`;
}

localStorage.setItem(SESSION_KEY, state.sessionId);
elements.nameInput.value = "";
elements.roomInput.value = state.roomCode;

function getSelfPlayer() {
  return state.lobby?.players?.find((player: any) => player.id === state.self.playerId)
    || state.round?.players?.find((player: any) => player.id === state.self.playerId)
    || null;
}

function isRunnerFaceEnabled(selfPlayer: any) {
  if (state.faceToggleDesired != null) {
    return state.faceToggleDesired;
  }
  return Boolean(selfPlayer?.setup?.faceEnabled);
}

function normalizeThemeId(value: unknown): ArenaThemeId {
  return value === "synthwave" ? "synthwave" : "neon";
}

function getResolvedTheme() {
  return normalizeThemeId(
    state.lobby?.resolvedTheme
    || state.room?.resolvedTheme
    || state.round?.resolvedTheme
    || DEFAULT_ARENA_THEME_ID
  );
}

function getThemeSourcePhase() {
  return state.room?.phase || state.round?.phase || GAME_PHASES.LOBBY;
}

function getThemeLocked() {
  return [GAME_PHASES.COUNTDOWN, GAME_PHASES.PLAYING, GAME_PHASES.RESULTS].includes(getThemeSourcePhase());
}

function getResolvedThemeForCurrentRound() {
  return normalizeThemeId(
    state.round?.resolvedTheme
    || state.room?.resolvedTheme
    || state.lobby?.resolvedTheme
    || DEFAULT_ARENA_THEME_ID
  );
}

function getThemePreference(): ThemePreference {
  const value = state.lobby?.themePreference ?? state.round?.themePreference ?? state.room?.themePreference ?? null;
  if (value == null) {
    return null;
  }
  return normalizeThemeId(value);
}

function getThemePreferenceSnapshots(): ThemePreference[] {
  const values = [
    state.lobby?.themePreference,
    state.room?.themePreference,
    state.round?.themePreference
  ];
  return values
    .filter((value, index) => values.indexOf(value) === index)
    .map((value) => (value == null ? null : normalizeThemeId(value)));
}

function getEffectiveThemePreference(): ThemePreference {
  return state.pendingTheme?.value ?? getThemePreference();
}

function getEffectiveRole() {
  return state.pendingRole?.value ?? state.self.role;
}

function isEffectiveReady(selfPlayer: any) {
  if (state.pendingReady) {
    return state.pendingReady.value;
  }
  return Boolean(selfPlayer?.ready);
}

function isMotionReady(selfPlayer: any) {
  if (state.motionReadyOverride != null) {
    return state.motionReadyOverride;
  }
  return Boolean(selfPlayer?.setup?.motionReady);
}

function isRunnerFaceReady(selfPlayer: any) {
  if (!isRunnerFaceEnabled(selfPlayer)) {
    return true;
  }
  if (state.faceStream || state.faceCameraStarting || state.faceToggleDesired != null) {
    return state.faceReadyLive;
  }
  return Boolean(selfPlayer?.setup?.faceReady || state.faceReadyLive);
}

function isPermissionComplete(selfPlayer: any) {
  const effectiveRole = getEffectiveRole();
  if (effectiveRole === ROLES.RUNNER) {
    return !isRunnerFaceEnabled(selfPlayer) || isRunnerFaceReady(selfPlayer);
  }
  if (effectiveRole === ROLES.PHOTOGRAPHER) {
    return isMotionReady(selfPlayer);
  }
  return false;
}

function getCurrentStep(): ControllerStep {
  const phase = state.round?.phase || state.room?.phase || GAME_PHASES.LOBBY;
  if (!state.joined) {
    return "join";
  }
  if (phase === GAME_PHASES.RESULTS) {
    return "post-round";
  }
  if (phase === GAME_PHASES.COUNTDOWN) {
    return "countdown";
  }
  if (phase === GAME_PHASES.PLAYING) {
    return getEffectiveRole() === ROLES.PHOTOGRAPHER ? "playing-photographer" : "playing-runner";
  }
  if (!getEffectiveRole()) {
    return "role-select";
  }
  return "permissions";
}

function isPhotographerPlaying() {
  return state.self.role === ROLES.PHOTOGRAPHER && state.round?.phase === GAME_PHASES.PLAYING;
}

function isRunnerRoundPhase(step: ControllerStep) {
  return state.self.role === ROLES.RUNNER && ["permissions", "countdown", "playing-runner"].includes(step);
}

function send(type: string, payload = {}) {
  if (state.socket?.readyState !== WebSocket.OPEN) {
    return;
  }
  state.socket.send(JSON.stringify({ type, payload }));
}

function notifyGalleryReview(open: boolean) {
  const roundId = state.downloadsStickyRoundId
    || state.downloadsSnapshot?.roundId
    || state.gallery?.roundId
    || state.round?.roundId
    || "";
  send(MSG_TYPES.GALLERY_REVIEW_SET, {
    open,
    roundId
  });
}

function setDownloadsOpen(nextOpen: boolean, { clearSnapshot = false } = {}) {
  const currentRoundId = state.downloadsSnapshot?.roundId
    || state.gallery?.roundId
    || state.round?.roundId
    || state.downloadsStickyRoundId
    || "";
  if (state.downloadsOpen === nextOpen && !clearSnapshot) {
    return;
  }
  state.downloadsOpen = nextOpen;
  if (nextOpen) {
    state.galleryDismissedRoundId = "";
    state.downloadsStickyRoundId = currentRoundId;
    notifyGalleryReview(true);
    return;
  }
  state.galleryDismissedRoundId = currentRoundId;
  state.downloadsStickyRoundId = currentRoundId;
  notifyGalleryReview(false);
  if (clearSnapshot) {
    state.downloadsSnapshot = null;
    state.downloadsStickyRoundId = "";
  }
}

function getActiveResultRoundId() {
  return state.downloadsSnapshot?.roundId
    || state.gallery?.roundId
    || state.round?.roundId
    || state.downloadsStickyRoundId
    || "";
}

function dismissCurrentGalleryReview() {
  const roundId = getActiveResultRoundId();
  if (!roundId) {
    state.downloadsOpen = false;
    render();
    return;
  }
  if (!state.downloadsSnapshot && state.gallery?.roundId === roundId) {
    state.downloadsSnapshot = structuredClone(state.gallery);
  }
  state.downloadsStickyRoundId = roundId;
  state.galleryDismissedRoundId = roundId;
  state.downloadsOpen = false;
  notifyGalleryReview(false);
  render();
}

function clearResultReviewState() {
  state.downloadsOpen = false;
  state.downloadsSnapshot = null;
  state.downloadsStickyRoundId = "";
}

function getShutterCooldownMs() {
  return state.round?.shutterCooldownMs || SHUTTER_COOLDOWN_MS;
}

function getShutterCooldownRemainingMs() {
  return Math.max(0, Math.max(state.shutterCooldownUntil, state.shutterInputLockUntil) - Date.now());
}

function stopShutterCooldownLoop() {
  if (state.shutterCooldownRaf) {
    window.cancelAnimationFrame(state.shutterCooldownRaf);
    state.shutterCooldownRaf = 0;
  }
}

function renderShutterCooldown() {
  const remainingMs = getShutterCooldownRemainingMs();
  const durationMs = getShutterCooldownMs();
  const progress = remainingMs > 0 ? remainingMs / durationMs : 0;
  const active = isPhotographerPlaying();
  elements.shutterButton.disabled = remainingMs > 0 || !active;
  elements.shutterCooldownRing.style.setProperty("--cooldown-progress", String(progress));
  elements.shutterCooldownRing.classList.toggle("cooling", active && remainingMs > 0);
  elements.shutterCooldownLabel.classList.toggle("hidden", !active || remainingMs <= 0);
  elements.shutterCooldownLabel.textContent = remainingMs > 0 ? `${(remainingMs / 1000).toFixed(1)}s` : COPY.controller.shutterReady;

  if (remainingMs > 0 && !state.shutterCooldownRaf) {
    state.shutterCooldownRaf = window.requestAnimationFrame(function tick() {
      state.shutterCooldownRaf = 0;
      renderShutterCooldown();
    });
    return;
  }

  if (remainingMs <= 0) {
    stopShutterCooldownLoop();
  }
}

function startShutterCooldown(acceptedAt = Date.now()) {
  const nextUntil = acceptedAt + getShutterCooldownMs();
  state.shutterCooldownUntil = Math.max(state.shutterCooldownUntil, nextUntil);
  state.shutterInputLockUntil = Math.max(state.shutterInputLockUntil, nextUntil);
  renderShutterCooldown();
}

function syncShutterCooldownFromRound() {
  const acceptedAt = Number(state.round?.lastShotAt || 0);
  if (!acceptedAt) {
    if (getShutterCooldownRemainingMs() <= 0) {
      state.shutterCooldownUntil = 0;
      renderShutterCooldown();
    }
    return;
  }
  const syncedUntil = acceptedAt + getShutterCooldownMs();
  if (syncedUntil > state.shutterCooldownUntil) {
    state.shutterCooldownUntil = syncedUntil;
  }
  if (state.shutterInputLockUntil < state.shutterCooldownUntil) {
    state.shutterInputLockUntil = state.shutterCooldownUntil;
  }
  renderShutterCooldown();
}

function isShutterCoolingDown(now = Date.now()) {
  return now < Math.max(state.shutterCooldownUntil, state.shutterInputLockUntil);
}

function tryTriggerShutter(event?: Event) {
  event?.preventDefault();
  event?.stopPropagation();
  if (!isPhotographerPlaying()) {
    return;
  }
  const now = Date.now();
  if (isShutterCoolingDown(now)) {
    return;
  }
  if (now - state.lastShutterTriggerAt < 80) {
    return;
  }
  state.lastShutterTriggerAt = now;
  const createdAt = now;
  const localShot = state.view.captureShot();
  state.shutterInputLockUntil = createdAt + getShutterCooldownMs();
  startShutterCooldown(createdAt);
  triggerFlash();
  send(MSG_TYPES.SHUTTER, {
    imageDataUrl: localShot.imageDataUrl,
    yaw: localShot.yaw,
    pitch: localShot.pitch,
    capturedRunnerIds: localShot.capturedRunnerIds,
    blockedRunnerIds: localShot.blockedRunnerIds,
    createdAt
  });
}

function randomName() {
  const value = pickRandomName();
  state.playerName = value;
  elements.nameInput.value = value;
}

function syncPermissionOverride() {
  const selfPlayer = getSelfPlayer();
  if (!selfPlayer) {
    state.faceToggleDesired = null;
    state.motionReadyOverride = null;
    state.localStepOverride = null;
    return;
  }
  if (state.faceToggleDesired != null && Boolean(selfPlayer?.setup?.faceEnabled) === state.faceToggleDesired) {
    state.faceToggleDesired = null;
  }
  if (state.motionReadyOverride != null && Boolean(selfPlayer?.setup?.motionReady) === state.motionReadyOverride) {
    state.motionReadyOverride = null;
  }
  state.localStepOverride = null;
}

function clearPendingState() {
  state.pendingRole = null;
  state.pendingTheme = null;
  state.pendingReady = null;
  state.pendingFaceToggle = null;
  state.pendingMotionPermission = false;
  state.lastInlineError = "";
}

function setInlineError(message: string) {
  state.lastInlineError = message;
}

function reconcilePendingState(selfPlayer: any) {
  if (state.pendingRole && ((selfPlayer?.role ?? null) === state.pendingRole.value)) {
    state.pendingRole = null;
  }
  if (state.pendingTheme) {
    const pendingTheme = state.pendingTheme.value;
    const preferenceConfirmed = getThemePreferenceSnapshots().some((value) => value === pendingTheme);
    const roundThemeConfirmed = pendingTheme != null
      && [
        state.round?.resolvedTheme,
        state.room?.resolvedTheme
      ].some((value) => value != null && normalizeThemeId(value) === pendingTheme);
    if (preferenceConfirmed || roundThemeConfirmed) {
      state.pendingTheme = null;
    }
  }
  if (state.pendingReady && Boolean(selfPlayer?.ready) === state.pendingReady.value) {
    state.pendingReady = null;
  }
  if (state.pendingFaceToggle && Boolean(selfPlayer?.setup?.faceEnabled) === state.pendingFaceToggle.value) {
    state.pendingFaceToggle = null;
  }
  if (state.pendingMotionPermission && Boolean(selfPlayer?.setup?.motionReady)) {
    state.pendingMotionPermission = false;
  }
  if (!state.pendingRole && !state.pendingTheme && !state.pendingReady && !state.pendingFaceToggle && !state.pendingMotionPermission) {
    state.lastInlineError = "";
  }
}

function triggerFlash() {
  window.clearTimeout(state.flashTimeout);
  elements.flash.classList.add("active");
  state.flashTimeout = window.setTimeout(() => {
    elements.flash.classList.remove("active");
  }, 120);
}

async function ensureFaceDetector() {
  if (state.faceDetectorReady && state.faceDetector) {
    return state.faceDetector;
  }
  const vision = await FilesetResolver.forVisionTasks(FACE_DETECTION_WASM_URL);
  state.faceDetector = await FaceDetector.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: FACE_DETECTION_MODEL_URL
    },
    runningMode: "VIDEO"
  });
  state.faceDetectorReady = true;
  return state.faceDetector;
}

async function ensureRunnerCameraLive() {
  const selfPlayer = getSelfPlayer();
  if (state.faceCameraStarting || state.faceStream || state.self.role !== ROLES.RUNNER || !isRunnerFaceEnabled(selfPlayer)) {
    return;
  }
  state.faceCameraStarting = true;
  try {
    await enableFaceCamera();
  } catch (error) {
    state.faceToggleDesired = false;
    state.faceError = COPY.errors.faceCameraStartFailed;
    debugLog("runner-camera-auto-start-failed", {
      roomCode: state.roomCode,
      playerId: state.self.playerId,
      message: error instanceof Error ? error.message : "unknown"
    });
  } finally {
    state.faceCameraStarting = false;
    render();
  }
}

function extractFaceBox(result: MediaPipeResult | null, video: HTMLVideoElement) {
  const detections = [...(result?.detections || [])];
  const detection = detections.sort((left, right) => {
    const leftArea = (left.boundingBox?.width || 0) * (left.boundingBox?.height || 0);
    const rightArea = (right.boundingBox?.width || 0) * (right.boundingBox?.height || 0);
    return rightArea - leftArea;
  })[0];
  const boundingBox = detection?.boundingBox;
  if (!boundingBox || !video.videoWidth || !video.videoHeight) {
    return null;
  }

  const x = Math.max(0, boundingBox.originX);
  const y = Math.max(0, boundingBox.originY);
  const width = Math.min(video.videoWidth - x, boundingBox.width);
  const height = Math.min(video.videoHeight - y, boundingBox.height);
  if (width <= 0 || height <= 0) {
    return null;
  }

  const sizeNorm = Math.min(width / video.videoWidth, height / video.videoHeight);
  const insideGuide = sizeNorm > 0.08;
  const centerX = x + width / 2;
  const centerY = y + height / 2;

  const cropSize = Math.max(width, height) * FACE_CROP_SCALE;
  const cropX = Math.max(0, Math.min(video.videoWidth - cropSize, centerX - cropSize / 2));
  const cropCenterY = centerY + height * FACE_CROP_VERTICAL_BIAS;
  const cropY = Math.max(0, Math.min(video.videoHeight - cropSize, cropCenterY - cropSize / 2));

  return {
    insideGuide,
    cropX,
    cropY,
    cropSize
  };
}

function smoothFaceCrop(box: ReturnType<typeof extractFaceBox>) {
  if (!box) {
    state.smoothedFaceCrop = null;
    return null;
  }
  if (!state.smoothedFaceCrop) {
    state.smoothedFaceCrop = {
      cropX: box.cropX,
      cropY: box.cropY,
      cropSize: box.cropSize
    };
    return state.smoothedFaceCrop;
  }
  const alpha = 0.22;
  state.smoothedFaceCrop = {
    cropX: state.smoothedFaceCrop.cropX + (box.cropX - state.smoothedFaceCrop.cropX) * alpha,
    cropY: state.smoothedFaceCrop.cropY + (box.cropY - state.smoothedFaceCrop.cropY) * alpha,
    cropSize: state.smoothedFaceCrop.cropSize + (box.cropSize - state.smoothedFaceCrop.cropSize) * alpha
  };
  return state.smoothedFaceCrop;
}

function updateRunnerFacePreview(imageDataUrl: string) {
  state.facePreviewUrl = imageDataUrl;
  if (elements.facePreviewImage.src !== imageDataUrl) {
    elements.facePreviewImage.src = imageDataUrl;
  }
}

function drawStoredFacePreview(imageDataUrl: string) {
  if (!imageDataUrl) {
    clearFaceCanvases();
    return;
  }
  const image = new Image();
  image.onload = () => updateLiveFaceCanvases(image);
  image.src = imageDataUrl;
}

function drawFaceCanvas(target: HTMLCanvasElement, source: CanvasImageSource) {
  const context = target.getContext("2d");
  if (!context) {
    return;
  }
  const width = target.clientWidth || target.width || 1;
  const height = target.clientHeight || target.height || width;
  if (target.width !== width || target.height !== height) {
    target.width = width;
    target.height = height;
  }
  context.clearRect(0, 0, target.width, target.height);
  let sourceWidth = target.width;
  let sourceHeight = target.height;
  if ("videoWidth" in source && "videoHeight" in source) {
    sourceWidth = (source as HTMLVideoElement).videoWidth || sourceWidth;
    sourceHeight = (source as HTMLVideoElement).videoHeight || sourceHeight;
  } else if ("naturalWidth" in source && "naturalHeight" in source) {
    sourceWidth = (source as HTMLImageElement).naturalWidth || sourceWidth;
    sourceHeight = (source as HTMLImageElement).naturalHeight || sourceHeight;
  } else if ("width" in source && "height" in source) {
    sourceWidth = Number((source as HTMLCanvasElement).width) || sourceWidth;
    sourceHeight = Number((source as HTMLCanvasElement).height) || sourceHeight;
  }
  const scale = Math.min(target.width / sourceWidth, target.height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const offsetX = (target.width - drawWidth) / 2;
  const offsetY = (target.height - drawHeight) / 2;
  context.drawImage(source, offsetX, offsetY, drawWidth, drawHeight);
}

function updateLiveFaceCanvases(source: CanvasImageSource) {
  drawFaceCanvas(elements.facePreviewCanvas, source);
  drawFaceCanvas(elements.runnerFaceThumb, source);
}

function getFaceCaptureRotation(video: HTMLVideoElement) {
  return 0;
}

function captureFaceFromBox(box: ReturnType<typeof extractFaceBox>) {
  if (!box || !state.faceStream) {
    return null;
  }
  const video = elements.faceVideo;
  const canvas = state.faceCanvas;
  canvas.width = 540;
  canvas.height = 540;
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  const rotation = getFaceCaptureRotation(video);
  context.save();
  if (rotation !== 0) {
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(rotation);
    context.drawImage(
      video,
      box.cropX,
      box.cropY,
      box.cropSize,
      box.cropSize,
      -canvas.width / 2,
      -canvas.height / 2,
      canvas.width,
      canvas.height
    );
  } else {
    context.drawImage(video, box.cropX, box.cropY, box.cropSize, box.cropSize, 0, 0, canvas.width, canvas.height);
  }
  context.restore();
  return canvas.toDataURL("image/jpeg", 0.82);
}

async function processFaceDetection() {
  if (!state.runnerCameraActive || state.faceDetectionBusy || !state.faceStream || state.self.role !== ROLES.RUNNER || !isRunnerFaceEnabled(getSelfPlayer())) {
    return;
  }
  const now = Date.now();
  if (now - state.lastFaceDetectionRunAt < FACE_DETECTION_INTERVAL_MS) {
    return;
  }
  state.lastFaceDetectionRunAt = now;
  const video = elements.faceVideo;
  if (!video.videoWidth || !video.videoHeight || video.readyState < 2) {
    return;
  }

  state.faceDetectionBusy = true;
  try {
    const detector = await ensureFaceDetector();
    const result = detector.detectForVideo(video, performance.now());
    const box = extractFaceBox(result, video);
    const smoothedBox = smoothFaceCrop(box);
    state.faceError = "";
    if (box?.insideGuide) {
      state.lastFaceDetectedAt = Date.now();
    }
    state.faceReadyLive = Date.now() - state.lastFaceDetectedAt < 700;
    elements.faceFrameShell.classList.toggle("captured", state.faceReadyLive);
    elements.faceGuideLabel.textContent = state.faceReadyLive
      ? COPY.controller.faceDetectedReady
      : COPY.controller.faceKeepVisible;
    elements.runnerSetupStatus.textContent = state.faceReadyLive
      ? COPY.controller.faceTrackingLive
      : COPY.controller.faceCameraEnabled;

    if (state.faceReadyLive && smoothedBox) {
      const imageDataUrl = captureFaceFromBox(smoothedBox);
      if (imageDataUrl) {
        updateLiveFaceCanvases(state.faceCanvas);
        if (Date.now() - state.lastFaceUploadAt >= FACE_UPLOAD_INTERVAL_MS) {
          state.lastFaceUploadAt = Date.now();
          updateRunnerFacePreview(imageDataUrl);
          send(MSG_TYPES.FACE_FRAME, {
            imageDataUrl,
            capturedAt: state.lastFaceUploadAt
          });
          debugLog("runner-face-frame-sent", { at: state.lastFaceUploadAt });
        }
      }
    }
  } catch (error) {
    state.faceError = COPY.errors.faceDetectionFailed;
  } finally {
    state.faceDetectionBusy = false;
  }
}

function faceDetectionLoop() {
  if (!state.runnerCameraActive) {
    return;
  }
  state.faceDetectionRaf = window.requestAnimationFrame(async () => {
    await processFaceDetection();
    faceDetectionLoop();
  });
}

function startRunnerCameraLoop() {
  if (state.runnerCameraActive) {
    return;
  }
  state.runnerCameraActive = true;
  debugLog("runner-camera-start", { roomCode: state.roomCode, playerId: state.self.playerId });
  faceDetectionLoop();
}

function stopRunnerCameraLoop() {
  if (!state.runnerCameraActive) {
    return;
  }
  debugLog("runner-camera-stop", { roomCode: state.roomCode, playerId: state.self.playerId });
  state.runnerCameraActive = false;
  state.faceReadyLive = false;
  window.cancelAnimationFrame(state.faceDetectionRaf);
  state.faceDetectionRaf = 0;
}

function clearFaceCanvases() {
  for (const canvas of [elements.facePreviewCanvas, elements.runnerFaceThumb]) {
    const context = canvas.getContext("2d");
    if (!context) {
      continue;
    }
    context.clearRect(0, 0, canvas.width || canvas.clientWidth || 1, canvas.height || canvas.clientHeight || 1);
  }
}

function connect() {
  const socket = new WebSocket(socketUrl);
  state.socket = socket;
  socket.addEventListener("open", () => {
    render();
    if (!state.shouldAutoHello || !state.roomCode) {
      return;
    }
    socket.send(JSON.stringify({
      type: MSG_TYPES.HELLO,
      payload: {
        clientType: CLIENT_TYPES.CONTROLLER,
        roomCode: state.roomCode,
        name: state.playerName || state.joinNamePlaceholder || COPY.common.player,
        sessionId: state.sessionId
      }
    }));
    state.shouldAutoHello = false;
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type === MSG_TYPES.ROOM_STATE) {
      state.room = message.payload.room;
      debugLog("theme-room-state", {
        phase: state.room?.phase,
        themePreference: state.room?.themePreference ?? null,
        resolvedTheme: state.room?.resolvedTheme ?? null
      });
      state.view.setTheme(state.room?.resolvedTheme);
      state.self = message.payload.self;
      state.joined = Boolean(state.self.playerId);
      if (state.joined) {
        state.shouldAutoHello = false;
      }
      if (state.room?.roomCode) {
        state.roomCode = state.room.roomCode;
        elements.roomInput.value = state.roomCode;
        localStorage.setItem(RECENT_ROOM_KEY, state.roomCode);
      }
      if (!state.self.role) {
        state.localStepOverride = null;
      }
      reconcilePendingState(getSelfPlayer());
      if (state.joined && !state.didReportLoadReady) {
        state.didReportLoadReady = true;
        send(MSG_TYPES.LOAD_PROGRESS, { progress: 100 });
      }
      render();
    }
    if (message.type === MSG_TYPES.LOBBY_STATE) {
      if (typeof message.payload?.lobbyRevision === "number" && message.payload.lobbyRevision < state.lobbyRevision) {
        return;
      }
      state.lobby = message.payload;
      debugLog("theme-lobby-state", {
        lobbyRevision: message.payload?.lobbyRevision ?? null,
        phase: message.payload?.phase ?? null,
        themePreference: message.payload?.themePreference ?? null,
        resolvedTheme: message.payload?.resolvedTheme ?? null
      });
      state.view.setTheme(state.lobby?.resolvedTheme);
      state.lobbyRevision = message.payload?.lobbyRevision ?? state.lobbyRevision;
      const selfPlayer = getSelfPlayer();
      reconcilePendingState(selfPlayer);
      if (selfPlayer?.faceFrame?.imageDataUrl) {
        updateRunnerFacePreview(selfPlayer.faceFrame.imageDataUrl);
        if (!state.faceStream) {
          drawStoredFacePreview(selfPlayer.faceFrame.imageDataUrl);
        }
      }
      syncPermissionOverride();
      render();
    }
    if (message.type === MSG_TYPES.ROUND_STATE) {
      if (typeof message.payload?.roundRevision === "number" && message.payload.roundRevision < state.roundRevision) {
        return;
      }
      state.round = message.payload;
      debugLog("theme-round-state", {
        roundRevision: message.payload?.roundRevision ?? null,
        phase: message.payload?.phase ?? null,
        themePreference: message.payload?.themePreference ?? null,
        resolvedTheme: message.payload?.resolvedTheme ?? null
      });
      state.view.setTheme(state.round?.resolvedTheme);
      state.roundRevision = message.payload?.roundRevision ?? state.roundRevision;
      reconcilePendingState(getSelfPlayer());
      if (state.round?.phase !== GAME_PHASES.RESULTS) {
        clearResultReviewState();
      }
      state.view.setRoundState(state.round);
      const selfPlayer = state.round?.players?.find((player: any) => player.id === state.self.playerId);
      if (selfPlayer?.faceFrame?.imageDataUrl) {
        updateRunnerFacePreview(selfPlayer.faceFrame.imageDataUrl);
        if (!state.faceStream) {
          drawStoredFacePreview(selfPlayer.faceFrame.imageDataUrl);
        }
      }
      if (selfPlayer?.role === ROLES.PHOTOGRAPHER) {
        state.view.setCameraOrientation(state.orientation.yaw || selfPlayer.yaw, state.orientation.pitch || selfPlayer.pitch);
      }
      syncShutterCooldownFromRound();
      render();
    }
    if (message.type === MSG_TYPES.GALLERY_STATE) {
      state.gallery = message.payload;
      if (state.round?.phase === GAME_PHASES.RESULTS && state.gallery?.roundId) {
        state.downloadsStickyRoundId = state.gallery.roundId;
        state.downloadsSnapshot = structuredClone(state.gallery);
        if (state.galleryDismissedRoundId !== state.gallery.roundId) {
          state.downloadsOpen = true;
        }
      } else if (state.round?.phase !== GAME_PHASES.RESULTS) {
        clearResultReviewState();
      }
      render();
    }
    if (message.type === MSG_TYPES.ROOM_ERROR) {
      clearPendingState();
      setInlineError(message.payload.message);
      elements.joinStatus.textContent = message.payload.message;
      render();
    }
    if (message.type === MSG_TYPES.PHOTO_RESULT) {
      if (typeof message.payload?.createdAt === "number") {
        startShutterCooldown(message.payload.createdAt);
      }
    }
    if (message.type === MSG_TYPES.ROOM_CLOSED) {
      resetJoinedState();
      elements.joinStatus.textContent = getRoomClosedMessage(message.payload?.reason, message.payload?.replacementRoomCode);
      render();
    }
  });

  socket.addEventListener("close", () => {
    state.shouldAutoHello = state.joined;
    elements.joinStatus.textContent = COPY.common.reconnecting;
    render();
    window.setTimeout(connect, 800);
  });
}

function resetJoinedState() {
  state.joined = false;
  state.self = { playerId: null, role: null };
  state.lobby = null;
  state.round = null;
  state.gallery = null;
  state.localStepOverride = null;
  state.shouldAutoHello = false;
  state.didReportLoadReady = false;
  state.downloadsOpen = false;
  state.downloadsSnapshot = null;
  state.downloadsStickyRoundId = "";
  state.galleryDismissedRoundId = "";
  state.facePreviewUrl = "";
  state.faceReadyLive = false;
  state.faceToggleDesired = null;
  state.faceError = "";
  state.faceCameraActive = false;
  state.smoothedFaceCrop = null;
  state.lastFaceDetectedAt = 0;
  state.lastFaceDetectionRunAt = 0;
  state.motionReadyOverride = null;
  state.pendingRole = null;
  state.pendingTheme = null;
  state.pendingReady = null;
  state.pendingFaceToggle = null;
  state.pendingMotionPermission = false;
  state.lobbyRevision = -1;
  state.roundRevision = -1;
  state.lastInlineError = "";
  state.shutterCooldownUntil = 0;
  state.shutterInputLockUntil = 0;
  state.lastShutterTriggerAt = 0;
  state.orientation.enabled = false;
  state.view.setTheme(DEFAULT_ARENA_THEME_ID);
  stopShutterCooldownLoop();
  clearFaceCanvases();
  elements.facePreviewImage.src = "";
  stopFaceCamera();
}

function joinRoom() {
  state.playerName = elements.nameInput.value.trim() || state.joinNamePlaceholder || pickRandomName();
  state.roomCode = elements.roomInput.value.trim().toUpperCase();
  localStorage.setItem(NAME_KEY, state.playerName);
  localStorage.setItem(RECENT_ROOM_KEY, state.roomCode);
  state.shouldAutoHello = true;
  send(MSG_TYPES.HELLO, {
    clientType: CLIENT_TYPES.CONTROLLER,
    roomCode: state.roomCode,
    name: state.playerName,
    sessionId: state.sessionId
  });
}

function leaveRoom() {
  send(MSG_TYPES.LEAVE, {});
  resetJoinedState();
  refreshJoinPlaceholder();
  render();
}

function stopFaceCamera() {
  stopRunnerCameraLoop();
  if (state.faceStream) {
    state.faceStream.getTracks().forEach((track) => track.stop());
    state.faceStream = null;
  }
  state.faceCameraActive = false;
  state.faceCameraStarting = false;
  elements.faceVideo.srcObject = null;
  elements.faceFrameShell.classList.remove("captured");
  elements.faceGuideLabel.textContent = "開啟後會啟動相機。";
  if (state.facePreviewUrl) {
    drawStoredFacePreview(state.facePreviewUrl);
  } else {
    clearFaceCanvases();
  }
  state.smoothedFaceCrop = null;
  state.lastFaceDetectedAt = 0;
  state.lastFaceDetectionRunAt = 0;
}

async function enableFaceCamera() {
  state.faceReadyLive = false;
  state.lastFaceDetectedAt = 0;
  state.lastFaceDetectionRunAt = 0;
  state.faceError = "";
  send(MSG_TYPES.LOAD_PROGRESS, {
    progress: 100,
    setup: {
      faceEnabled: true,
      faceReady: false
    }
  });
  if (!state.faceStream) {
    state.faceStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 960 } },
      audio: false
    });
    elements.faceVideo.srcObject = state.faceStream;
    await elements.faceVideo.play();
  }
  state.faceCameraActive = true;
  await ensureFaceDetector();
  startRunnerCameraLoop();
  state.faceCameraStarting = false;
  render();
}

function setRunnerFaceTextureEnabled(enabled: boolean) {
  state.faceToggleDesired = enabled;
  state.pendingFaceToggle = { value: enabled, sinceRevision: state.lobbyRevision };
  setInlineError("");
  state.faceError = "";
  if (!enabled) {
    stopFaceCamera();
    state.faceReadyLive = false;
    state.lastFaceDetectedAt = 0;
    send(MSG_TYPES.LOAD_PROGRESS, {
      progress: 100,
      setup: {
        faceEnabled: false,
        faceReady: true
      }
    });
    render();
    return;
  }

  state.faceCameraStarting = true;
  render();
  send(MSG_TYPES.LOAD_PROGRESS, {
    progress: 100,
    setup: {
      faceEnabled: true,
      faceReady: false
    }
  });
  enableFaceCamera().catch((error) => {
    state.faceToggleDesired = false;
    state.pendingFaceToggle = null;
    state.faceError = COPY.errors.faceCameraFailed;
    state.faceCameraStarting = false;
    stopFaceCamera();
    send(MSG_TYPES.LOAD_PROGRESS, {
      progress: 100,
      setup: {
        faceEnabled: false,
        faceReady: true
      }
    });
    render();
  });
}

async function enableMotion() {
  state.pendingMotionPermission = true;
  setInlineError("");
  render();
  const deviceOrientation = window.DeviceOrientationEvent as any;
  if (typeof deviceOrientation?.requestPermission === "function") {
    const result = await deviceOrientation.requestPermission();
    if (result !== "granted") {
      state.pendingMotionPermission = false;
      setInlineError(COPY.errors.motionPermissionDenied);
      render();
      return;
    }
  }
  state.orientation.enabled = true;
  state.orientation.baseAlpha = null;
  state.motionReadyOverride = true;
  state.pendingMotionPermission = false;
  send(MSG_TYPES.LOAD_PROGRESS, {
    progress: 100,
    setup: { motionReady: true }
  });
  render();
}

window.addEventListener("deviceorientation", (event) => {
  if (!state.orientation.enabled || !isPhotographerPlaying()) {
    return;
  }
  const alpha = event.alpha ?? 0;
  const beta = event.beta ?? 0;
  if (state.orientation.baseAlpha == null) {
    state.orientation.baseAlpha = alpha;
  }
  const yaw = (((state.orientation.baseAlpha - alpha) * Math.PI) / 180);
  const pitch = Math.max(ARENA.pitchClamp.min, Math.min(ARENA.pitchClamp.max, (beta * Math.PI) / 180 - 0.75));
  state.orientation.yaw = yaw;
  state.orientation.pitch = pitch;
  state.view.setCameraOrientation(yaw, pitch);
  send(MSG_TYPES.CAMERA_MOTION, { yaw, pitch });
});

window.setInterval(() => {
  if (isPhotographerPlaying() && state.socket?.readyState === WebSocket.OPEN) {
    send(MSG_TYPES.CAMERA_MOTION, {
      yaw: state.orientation.yaw,
      pitch: state.orientation.pitch
    });
  }
}, 80);

function setMoveDirection(nextDirection: number) {
  if (state.currentMoveDirection === nextDirection) {
    return;
  }
  state.currentMoveDirection = nextDirection;
  send(MSG_TYPES.RUNNER_INPUT, {
    moveDirection: state.currentMoveDirection
  });
}

function renderPlayers() {
  const players = state.lobby?.players || [];
  for (const list of [elements.rolePlayers, elements.permissionPlayers]) {
    list.innerHTML = "";
    if (players.length === 0) {
      list.innerHTML = `<div class="empty-state">${COPY.controller.permissionPlayersEmpty}</div>`;
      continue;
    }
    for (const player of players) {
      const card = document.createElement("div");
      const setupLabel = player.role === ROLES.PHOTOGRAPHER
        ? (player.setup?.motionReady ? COPY.controller.setupMotionReady : COPY.controller.setupNeedMotion)
        : player.role === ROLES.RUNNER
          ? (player.setup?.faceEnabled
            ? (player.setup?.faceReady ? COPY.controller.setupFaceReady : COPY.controller.setupNeedFace)
            : COPY.controller.setupFaceOff)
          : COPY.controller.setupChooseRole;
      card.className = "player-chip";
      card.innerHTML = `
        <div>
          <strong>${player.name}</strong>
          <div class="status-copy">${formatRoleLabel(player.role)} · ${setupLabel}</div>
        </div>
        <div class="badge">${player.ready ? COPY.common.ready : `${player.loadProgress}%`}</div>
      `;
      list.append(card);
    }
  }
}

function renderThemePicker(effectiveRole: string | null) {
  const effectiveThemePreference = getEffectiveThemePreference();
  const resolvedTheme = getResolvedTheme();
  const currentRoundTheme = getResolvedThemeForCurrentRound();
  const isRandom = effectiveThemePreference == null;
  const isLocked = getThemeLocked();
  const themeSelectionReady = state.self.role === ROLES.PHOTOGRAPHER;
  const buttons = [
    [elements.themeRandomButton, null],
    [elements.themeNeonButton, "neon"],
    [elements.themeSynthwaveButton, "synthwave"]
  ] as const;

  elements.themePicker.classList.toggle("hidden", effectiveRole !== ROLES.PHOTOGRAPHER);
  if (effectiveRole !== ROLES.PHOTOGRAPHER) {
    return;
  }

  for (const [button, themeId] of buttons) {
    const selected = effectiveThemePreference === themeId;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
    button.disabled = !themeSelectionReady || isLocked || Boolean(state.pendingTheme);
  }

  elements.themeModeLabel.textContent = isRandom
    ? COPY.themes.randomEachRound
    : COPY.controller.themeModeManual(formatThemeLabel(effectiveThemePreference));

  if (state.pendingTheme) {
    elements.themeStatus.textContent = COPY.controller.themeUpdating;
    return;
  }

  if (!themeSelectionReady) {
    elements.themeStatus.textContent = COPY.controller.themePickRoleFirst;
    return;
  }

  if (isRandom) {
    elements.themeStatus.textContent = isLocked
      ? COPY.controller.themeCurrent(formatThemeLabel(currentRoundTheme))
      : COPY.controller.themePreviewAtRoundStart(formatThemeLabel(resolvedTheme));
    return;
  }

  elements.themeStatus.textContent = isLocked
    ? COPY.controller.themeCurrent(formatThemeLabel(currentRoundTheme))
    : COPY.controller.themePreviewNextRound(formatThemeLabel(effectiveThemePreference));
}

function renderGallery() {
  const snapshot = state.downloadsSnapshot || state.gallery;
  const items = [...(snapshot?.items || [])].sort((left: any, right: any) => {
    const leftSuccessful = left?.successful !== false && (left?.capturedRunnerIds?.length || 0) > 0;
    const rightSuccessful = right?.successful !== false && (right?.capturedRunnerIds?.length || 0) > 0;
    if (leftSuccessful !== rightSuccessful) {
      return leftSuccessful ? -1 : 1;
    }
    return Number(right?.createdAt || 0) - Number(left?.createdAt || 0);
  });
  const runnerNameMap = new Map<string, string>();
  for (const entry of snapshot?.runnerSummary || []) {
    if (entry?.id && entry?.name) {
      runnerNameMap.set(entry.id, entry.name);
    }
  }
  for (const player of state.round?.players || state.lobby?.players || []) {
    if (player?.id && player?.name && !runnerNameMap.has(player.id)) {
      runnerNameMap.set(player.id, player.name);
    }
  }
  elements.gallery.innerHTML = "";
  if (items.length === 0) {
    elements.gallery.innerHTML = `<div class="empty-state">${COPY.controller.noSuccessfulCaptures}</div>`;
    return;
  }
  for (const item of items) {
    const card = document.createElement("a");
    const successful = item.successful !== false && (item.capturedRunnerIds?.length || 0) > 0;
    card.className = `gallery-card gallery-tile ${successful ? "successful" : "missed"}`;
    card.href = item.imageDataUrl;
    card.download = `shutter-shy-${item.id}.jpg`;
    card.target = "_blank";
    card.rel = "noreferrer";
    const capturedCount = item.capturedRunnerIds?.length || 0;
    const blockedCount = item.blockedRunnerIds?.length || 0;
    const capturedNames = (item.capturedRunnerIds || [])
      .map((runnerId: string) => runnerNameMap.get(runnerId))
      .filter(Boolean);
    const capturedLine = successful
      ? (capturedNames.length > 0 ? capturedNames.join("、") : COPY.controller.capturedCount(capturedCount))
      : "沒有拍到跑者";
    card.innerHTML = `
      ${item.imageDataUrl ? `<img src="${item.imageDataUrl}" alt="${successful ? COPY.controller.successfulPhotoAlt : COPY.controller.missedPhotoAlt}" />` : `<div class="empty-state">${COPY.controller.noPreview}</div>`}
      <div class="meta">
        <div class="meta-row">
          <span class="meta-label">${successful ? COPY.controller.shotHit : COPY.controller.shotMiss}</span>
          <span class="meta-time status-copy">${new Date(item.createdAt).toLocaleTimeString()}</span>
        </div>
        <strong class="meta-primary">${capturedLine}</strong>
        ${blockedCount > 0 ? `<div class="status-copy">${COPY.controller.blockedCount(blockedCount)}</div>` : ""}
      </div>
    `;
    elements.gallery.append(card);
  }
}

function renderPostRoundSummary() {
  const summary = (state.downloadsSnapshot || state.gallery)?.runnerSummary || [];
  elements.postRoundSummary.innerHTML = "";
  for (const entry of summary) {
    const badge = document.createElement("div");
    badge.className = `result-badge-card ${entry.captured ? "good" : "bad"}`;
    badge.innerHTML = `
      <div class="result-badge-name">${entry.name}</div>
      <div class="result-badge-state ${entry.captured ? "good" : "bad"}">${entry.captured ? COPY.controller.summaryCaptured : COPY.controller.summaryEscaped}</div>
    `;
    elements.postRoundSummary.append(badge);
  }
  if (summary.length === 0) {
    elements.postRoundSummary.innerHTML = `<div class="empty-state">${COPY.controller.noRunnerSummary}</div>`;
  }
}

function renderTop(step: ControllerStep) {
  const selfPlayer = getSelfPlayer();
  const socketReady = state.socket?.readyState === WebSocket.OPEN;
  const dotClass = !socketReady ? "offline" : isEffectiveReady(selfPlayer) ? "ready" : state.joined ? "live" : "offline";
  elements.topRoomCode.textContent = state.roomCode || "----";
  elements.topPlayerName.textContent = state.playerName || elements.nameInput.value.trim() || COPY.common.guest;
  elements.topRole.textContent = formatRoleLabel(getEffectiveRole());
  elements.topStateDot.className = `top-dot ${dotClass}`;
  elements.leaveButton.classList.toggle("hidden", !state.joined);
  elements.app.classList.toggle("playing-photographer", step === "playing-photographer");
  elements.app.classList.toggle("with-readybar", step === "permissions");
}

function updateRuntimeForStep(step: ControllerStep) {
  const selfPlayer = getSelfPlayer();
  const effectiveRole = getEffectiveRole();
  const photographerPreview = step === "permissions" && effectiveRole === ROLES.PHOTOGRAPHER;
  const shouldRenderController3d = step === "playing-photographer" || step === "playing-runner" || photographerPreview;
  if (step === "playing-photographer" || photographerPreview) {
    state.view.setControllerView("photographer", state.self.playerId);
  } else if (step === "playing-runner") {
    state.view.setControllerView("runner", state.self.playerId);
  } else {
    state.view.setControllerView("idle", state.self.playerId);
  }
  state.view.setActive(shouldRenderController3d);
  elements.canvas.classList.toggle("active-play-canvas", shouldRenderController3d);

  const runnerCameraShouldRun = state.joined
    && isRunnerRoundPhase(step)
    && isRunnerFaceEnabled(selfPlayer);
  if (runnerCameraShouldRun && state.faceStream) {
    startRunnerCameraLoop();
  } else if (runnerCameraShouldRun && !state.faceStream) {
    ensureRunnerCameraLive();
  } else if (!runnerCameraShouldRun) {
    if (
      step === "post-round"
      || step === "role-select"
      || step === "join"
      || !isRunnerFaceEnabled(selfPlayer)
      || state.self.role !== ROLES.RUNNER
    ) {
      stopFaceCamera();
    } else {
      stopRunnerCameraLoop();
    }
  }
}

function render() {
  const step = getCurrentStep();
  const selfPlayer = getSelfPlayer();
  const effectiveRole = getEffectiveRole();
  const effectiveReady = isEffectiveReady(selfPlayer);
  const phase = state.round?.phase || state.room?.phase || GAME_PHASES.LOBBY;
  const roleAvailability = state.lobby?.roleAvailability || {
    photographerAvailable: true,
    photographerPlayerId: null,
    runnerSlotsRemaining: 3
  };

  renderTop(step);
  updateRuntimeForStep(step);
  if (step === "permissions" || step === "role-select") {
    renderPlayers();
  }
  if (step === "post-round") {
    renderGallery();
  }
  if (step === "post-round") {
    renderPostRoundSummary();
  }

  elements.joinScreen.classList.toggle("hidden", step !== "join");
  elements.roleScreen.classList.toggle("hidden", step !== "role-select");
  elements.permissionsScreen.classList.toggle("hidden", step !== "permissions");
  elements.readyScreen.classList.add("hidden");
  elements.countdownScreen.classList.toggle("hidden", step !== "countdown");
  elements.postRoundScreen.classList.toggle("hidden", step !== "post-round");
  elements.controllerReadybar.classList.toggle("hidden", step !== "permissions");
  elements.flowStage.classList.toggle("hidden", step === "playing-runner" || step === "playing-photographer");
  elements.runnerPlayUi.classList.toggle("hidden", step !== "playing-runner");
  elements.photographerPlayUi.classList.toggle("hidden", step !== "playing-photographer");

  elements.joinStatus.textContent = state.joined
    ? COPY.controller.roomConnected
    : COPY.controller.roomJoinHint;

  const photographerTakenByOther = !roleAvailability.photographerAvailable && roleAvailability.photographerPlayerId !== state.self.playerId;
  elements.photographerRole.disabled = photographerTakenByOther || Boolean(state.pendingRole);
  elements.runnerRole.disabled = Boolean(state.pendingRole);
  elements.photographerRole.classList.toggle("locked", photographerTakenByOther);
  elements.photographerRole.classList.toggle("selected", effectiveRole === ROLES.PHOTOGRAPHER);
  elements.runnerRole.classList.toggle("selected", effectiveRole === ROLES.RUNNER);
  elements.roleStatus.textContent = photographerTakenByOther
    ? COPY.controller.photographerTaken
    : COPY.controller.chooseRole;
  elements.roleRoomStatus.textContent = state.lobby?.minimumRequirementsMet
    ? COPY.controller.enoughPlayers
    : COPY.controller.needMorePlayers(roleAvailability.runnerSlotsRemaining);

  elements.runnerPermissions.classList.toggle("hidden", effectiveRole !== ROLES.RUNNER);
  elements.photographerPermissions.classList.toggle("hidden", effectiveRole !== ROLES.PHOTOGRAPHER);
  elements.permissionsTitle.textContent = effectiveRole === ROLES.PHOTOGRAPHER
    ? COPY.controller.permissionsTitlePhotographer
    : COPY.controller.permissionsTitleRunner;
  elements.permissionsCopy.textContent = effectiveRole === ROLES.PHOTOGRAPHER
    ? COPY.controller.permissionsCopyPhotographer
    : COPY.controller.permissionsCopyRunner;
  renderThemePicker(effectiveRole);

  const facePreviewUrl = state.facePreviewUrl || selfPlayer?.faceFrame?.imageDataUrl || "";
  const runnerFaceEnabled = isRunnerFaceEnabled(selfPlayer);
  const runnerFaceReady = isRunnerFaceReady(selfPlayer);
  if (facePreviewUrl && elements.facePreviewImage.src !== facePreviewUrl) {
    elements.facePreviewImage.src = facePreviewUrl;
  }
  elements.faceToggleButton.disabled = state.faceCameraStarting || Boolean(state.pendingFaceToggle);
  elements.faceToggleButton.classList.toggle("on", runnerFaceEnabled);
  elements.faceToggleButton.classList.toggle("off", !runnerFaceEnabled);
  elements.faceToggleButton.setAttribute("aria-pressed", String(runnerFaceEnabled));
  elements.facePreviewCanvas.classList.toggle("hidden", !Boolean(state.faceStream) || !runnerFaceEnabled || !runnerFaceReady);
  elements.facePreviewImage.classList.toggle("hidden", !facePreviewUrl || Boolean(state.faceStream) || !runnerFaceEnabled || !runnerFaceReady);
  elements.faceFrameShell.classList.toggle("captured", runnerFaceReady);
  elements.faceFrameShell.classList.toggle("hidden", !runnerFaceEnabled);
  elements.faceGuideLabel.textContent = runnerFaceReady
    ? COPY.controller.faceDetectedReady
    : runnerFaceEnabled
      ? COPY.controller.faceKeepVisible
      : COPY.controller.faceOptionalOff;
  elements.runnerSetupStatus.textContent = runnerFaceReady
    ? COPY.controller.faceTrackingLive
    : runnerFaceEnabled
      ? (state.faceCameraStarting ? COPY.controller.faceCameraStarting : COPY.controller.faceCameraEnabled)
      : COPY.controller.faceOptionalHint;
  elements.photographerSetupStatus.textContent = isMotionReady(selfPlayer)
    ? COPY.controller.motionReady
    : COPY.controller.motionRequired;
  const motionReady = isMotionReady(selfPlayer);
  elements.motionButton.disabled = state.pendingMotionPermission || motionReady;
  elements.motionButton.classList.toggle("variant-key", !motionReady);
  elements.motionButton.classList.toggle("variant-finished", motionReady);
  elements.motionButton.textContent = motionReady ? COPY.controller.motionReady : "啟用動作感應";
  const permissionComplete = isPermissionComplete(selfPlayer);
  if (effectiveReady) {
    elements.permissionsNextButton.disabled = true;
    elements.permissionsNextButton.dataset.state = "finished";
    elements.permissionsNextButton.textContent = COPY.controller.readyFinished;
  } else if (permissionComplete) {
    elements.permissionsNextButton.disabled = Boolean(state.pendingReady);
    elements.permissionsNextButton.dataset.state = "ready";
    elements.permissionsNextButton.textContent = COPY.common.ready;
  } else {
    elements.permissionsNextButton.disabled = true;
    elements.permissionsNextButton.dataset.state = "waiting";
    elements.permissionsNextButton.textContent = COPY.controller.enablePermissionsToContinue;
  }
  if (state.lastInlineError) {
    if (effectiveRole === ROLES.PHOTOGRAPHER) {
      elements.photographerSetupStatus.textContent = state.lastInlineError;
    } else if (effectiveRole === ROLES.RUNNER) {
      elements.runnerSetupStatus.textContent = state.lastInlineError;
    } else {
      elements.joinStatus.textContent = state.lastInlineError;
    }
  } else if (effectiveRole === ROLES.RUNNER && state.faceError) {
    elements.runnerSetupStatus.textContent = state.faceError;
  }

  elements.countdownNumber.textContent = String(state.round?.countdownLeft ?? 3);
  elements.countdownCopy.textContent = COPY.controller.countdown;

  elements.runnerPhaseCopy.textContent = COPY.controller.runnerPhase;
  elements.photographerPhaseCopy.textContent = COPY.controller.photographerPhase;
  elements.runnerTimer.textContent = Number(state.round?.timeLeft ?? 30).toFixed(1);
  elements.photographerTimer.textContent = Number(state.round?.timeLeft ?? 30).toFixed(1);
  elements.runnerFaceThumb.classList.toggle("hidden", !runnerFaceEnabled || (!facePreviewUrl && !state.faceStream));

  const resultSnapshot = state.downloadsSnapshot || state.gallery;
  const resultRoundId = resultSnapshot?.roundId || state.round?.roundId || "";
  const waitingForOthers = step === "post-round"
    && phase === GAME_PHASES.RESULTS
    && !state.downloadsOpen
    && Boolean(resultRoundId)
    && state.galleryDismissedRoundId === resultRoundId;
  const capturedCount = resultSnapshot?.runnerSummary?.filter((entry: any) => entry.captured).length || 0;
  const totalRunners = resultSnapshot?.runnerSummary?.length || 0;
  elements.postRoundTitle.textContent = formatWinnerTitle(state.round?.winner);
  elements.postRoundCopy.textContent = waitingForOthers
    ? COPY.controller.waitingForOthers(Math.max(0, Math.ceil(state.round?.resultsTimeLeft || 0)))
    : totalRunners > 0
      ? COPY.controller.capturedSummary(capturedCount, totalRunners)
      : COPY.controller.noRunnerSummary;
  elements.gallery.classList.toggle("hidden", waitingForOthers);
  elements.closeDownloadsButton.classList.toggle("hidden", waitingForOthers);
  elements.postRoundSummary.parentElement?.classList.toggle("hidden", false);

  renderShutterCooldown();
}

elements.randomNameButton.addEventListener("click", randomName);
elements.joinButton.addEventListener("click", joinRoom);
elements.leaveButton.addEventListener("click", leaveRoom);
elements.photographerRole.addEventListener("click", () => {
  state.localStepOverride = null;
  state.pendingRole = { value: ROLES.PHOTOGRAPHER, sinceRevision: state.lobbyRevision };
  setInlineError("");
  render();
  send(MSG_TYPES.ROLE_SET, { role: ROLES.PHOTOGRAPHER });
});
elements.runnerRole.addEventListener("click", () => {
  state.localStepOverride = null;
  state.pendingRole = { value: ROLES.RUNNER, sinceRevision: state.lobbyRevision };
  setInlineError("");
  render();
  send(MSG_TYPES.ROLE_SET, { role: ROLES.RUNNER });
});
elements.faceToggleButton.addEventListener("click", () => {
  const selfPlayer = getSelfPlayer();
  setRunnerFaceTextureEnabled(!isRunnerFaceEnabled(selfPlayer));
});
elements.motionButton.addEventListener("click", () => {
  enableMotion().catch((error) => {
    state.pendingMotionPermission = false;
    setInlineError(COPY.errors.motionAccessFailed);
    render();
  });
});
for (const [button, themeId] of [
  [elements.themeRandomButton, null],
  [elements.themeNeonButton, "neon"],
  [elements.themeSynthwaveButton, "synthwave"]
] as const) {
  button.addEventListener("click", () => {
    debugLog("theme-set-click", {
      requestedTheme: themeId,
      selfRole: state.self.role,
      roomPhase: state.room?.phase ?? null,
      lobbyPhase: state.lobby?.phase ?? null
    });
    state.pendingTheme = { value: themeId, sinceRevision: state.lobbyRevision };
    setInlineError("");
    render();
    send(MSG_TYPES.THEME_SET, { themeId });
  });
}
elements.permissionsNextButton.addEventListener("click", () => {
  const selfPlayer = getSelfPlayer();
  if (!isPermissionComplete(selfPlayer) || isEffectiveReady(selfPlayer)) {
    return;
  }
  const nextReady = true;
  state.pendingReady = { value: nextReady, sinceRevision: state.lobbyRevision };
  setInlineError("");
  render();
  send(MSG_TYPES.READY_SET, { ready: nextReady });
});
elements.permissionsBackButton.addEventListener("click", () => {
  stopFaceCamera();
  state.localStepOverride = null;
  state.facePreviewUrl = "";
  clearFaceCanvases();
  elements.facePreviewImage.src = "";
  state.pendingRole = { value: null, sinceRevision: state.lobbyRevision };
  state.pendingTheme = null;
  state.pendingReady = null;
  setInlineError("");
  render();
  send(MSG_TYPES.ROLE_SET, { role: null });
});
function handleCloseGalleryTap(event?: Event) {
  event?.preventDefault();
  event?.stopPropagation();
  dismissCurrentGalleryReview();
}

elements.closeDownloadsButton.addEventListener("pointerup", handleCloseGalleryTap);
elements.closeDownloadsButton.addEventListener("touchend", handleCloseGalleryTap, { passive: false });
elements.closeDownloadsButton.addEventListener("click", handleCloseGalleryTap);
elements.flowStage.addEventListener("focusin", (event) => {
  keepFocusedFieldVisible(event.target);
});
elements.shutterButton.addEventListener("pointerdown", tryTriggerShutter);
elements.shutterButton.addEventListener("touchstart", tryTriggerShutter, { passive: false });
elements.shutterButton.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  tryTriggerShutter(event);
});

for (const [button, direction] of [[elements.moveLeft, -1], [elements.moveRight, 1]] as const) {
  button.addEventListener("pointerdown", () => setMoveDirection(direction));
  button.addEventListener("pointerup", () => setMoveDirection(0));
  button.addEventListener("pointerleave", () => setMoveDirection(0));
  button.addEventListener("pointercancel", () => setMoveDirection(0));
}

elements.laneIn.addEventListener("click", () => send(MSG_TYPES.RUNNER_INPUT, { moveDirection: state.currentMoveDirection, laneShift: -1 }));
elements.laneOut.addEventListener("click", () => send(MSG_TYPES.RUNNER_INPUT, { moveDirection: state.currentMoveDirection, laneShift: 1 }));

refreshJoinPlaceholder();
connect();
render();
