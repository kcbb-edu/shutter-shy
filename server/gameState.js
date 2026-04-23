import crypto from "node:crypto";
import {
  ARENA,
  ARENA_THEME_IDS,
  COUNTDOWN_SECONDS,
  DEFAULT_ARENA_THEME_ID,
  GAME_PHASES,
  LOAD_READY_PERCENT,
  MAX_FACE_FRAME_BYTES,
  MAX_PHOTO_BYTES,
  MAX_RUNNERS,
  PLAYER_COLORS,
  RESULTS_SECONDS,
  SHUTTER_COOLDOWN_MS,
  ROLES,
  ROUND_SECONDS,
  clamp,
  isArenaThemeId,
  isDataUrlWithinLimit,
  normalizeAngle,
  roundSeconds
} from "../shared/protocol.js";
import { COPY } from "../shared/copy.js";

function createRoundId() {
  return crypto.randomUUID();
}

function createPlayer({ name, sessionId, color }) {
  return {
    id: crypto.randomUUID(),
    name: String(name || COPY.common.player).trim().slice(0, 20) || COPY.common.player,
    sessionId,
    role: null,
    connected: true,
    loadProgress: 0,
    ready: false,
    faceFrame: null,
    faceUpdatedAt: 0,
    laneIndex: 1,
    angle: 0,
    moveDirection: 0,
    pendingLaneShift: 0,
    lastLaneShiftAt: 0,
    yaw: 0,
    pitch: -0.05,
    color,
    disconnectedAt: null,
    disconnectDeadlineAt: null,
    setup: {
      motionReady: false,
      faceReady: false,
      faceEnabled: false
    }
  };
}

function buildInitialFountains() {
  return Array.from({ length: ARENA.fountainJetCount }, (_, index) => ({
    index,
    angle: (index / ARENA.fountainJetCount) * Math.PI * 2,
    active: false,
    strength: 0,
    width: 0.12 + Math.random() * 0.2
  }));
}

function unique(values) {
  return [...new Set(values)];
}

const FALLBACK_EMOJIS = ["🙂", "😎", "😄", "😉", "🤩", "😺"];
const DISCONNECT_GRACE_MS = 8_000;

function fallbackEmojiForPlayer(player) {
  const seed = Array.from(String(player.id || player.name || "runner")).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return FALLBACK_EMOJIS[seed % FALLBACK_EMOJIS.length];
}

function getHorizontalFovRadians(aspectRatio) {
  return 2 * Math.atan(Math.tan(ARENA.cameraVerticalFovRadians / 2) * aspectRatio);
}

function getRunnerVisibilitySampleAngles(targetAngle, halfWidth) {
  return [-1, -0.5, 0, 0.5, 1].map((multiplier) => normalizeAngle(targetAngle + halfWidth * multiplier));
}

function randomArenaThemeId() {
  return ARENA_THEME_IDS[Math.floor(Math.random() * ARENA_THEME_IDS.length)] || DEFAULT_ARENA_THEME_ID;
}

export class GameState {
  constructor(roomCode) {
    this.roomCode = roomCode;
    this.lastTickAt = Date.now();
    this.countdownStartedAt = 0;
    this.resultsStartedAt = 0;
    this.roundStartedAt = 0;
    this.state = {
      phase: GAME_PHASES.BOOT,
      roomCode,
      roundId: createRoundId(),
      lobbyRevision: 0,
      roundRevision: 0,
      players: [],
      successfulGallery: [],
      shotHistory: [],
      capturedRunnerIds: [],
      countdownLeft: COUNTDOWN_SECONDS,
      timeLeft: ROUND_SECONDS,
      resultsTimeLeft: RESULTS_SECONDS,
      galleryClosedPlayerIds: [],
      winner: null,
      fountains: buildInitialFountains(),
      photographerPlayerId: null,
      themePreference: null,
      resolvedTheme: DEFAULT_ARENA_THEME_ID,
      qrCodeDataUrl: null,
      joinUrl: null,
      shutterSequence: 0,
      lastShotAt: 0,
      nextShutterAt: 0
    };
    this.resetForLobby();
  }

  bumpLobbyRevision() {
    this.state.lobbyRevision += 1;
  }

  bumpRoundRevision() {
    this.state.roundRevision += 1;
  }

  setRoomInfo({ qrCodeDataUrl, joinUrl }) {
    this.state.qrCodeDataUrl = qrCodeDataUrl;
    this.state.joinUrl = joinUrl;
  }

  resetForLobby() {
    this.state.phase = GAME_PHASES.LOBBY;
    this.state.roundId = createRoundId();
    this.state.successfulGallery = [];
    this.state.shotHistory = [];
    this.state.capturedRunnerIds = [];
    this.state.countdownLeft = COUNTDOWN_SECONDS;
    this.state.timeLeft = ROUND_SECONDS;
    this.state.resultsTimeLeft = RESULTS_SECONDS;
    this.state.galleryClosedPlayerIds = [];
    this.state.winner = null;
    this.state.photographerPlayerId = this.getPhotographer()?.id || null;
    this.state.fountains = buildInitialFountains();
    this.state.shutterSequence = 0;
    this.state.lastShotAt = 0;
    this.state.nextShutterAt = 0;
    this.resultsStartedAt = 0;
    this.roundStartedAt = 0;
    this.countdownStartedAt = 0;
    for (const player of this.state.players) {
      player.role = null;
      player.loadProgress = 0;
      player.ready = false;
      player.moveDirection = 0;
      player.pendingLaneShift = 0;
      player.setup.motionReady = false;
      player.setup.faceEnabled = false;
      player.setup.faceReady = true;
    }
    this.state.photographerPlayerId = null;
    this.bumpLobbyRevision();
    this.bumpRoundRevision();
    this.syncPhaseFromReadiness();
  }

  addOrReconnectPlayer(name, sessionId) {
    let player = this.state.players.find((entry) => entry.sessionId === sessionId);
    if (player) {
      player.connected = true;
      player.disconnectedAt = null;
      player.disconnectDeadlineAt = null;
      player.name = String(name || player.name).trim().slice(0, 20) || player.name;
      player.ready = false;
      this.reconcileReconnectedPlayerRole(player);
      this.state.photographerPlayerId = this.getPhotographer()?.id || null;
      this.bumpLobbyRevision();
      this.bumpRoundRevision();
      this.syncPhaseFromReadiness();
      return player;
    }
    if (this.state.players.length >= MAX_RUNNERS + 1) {
      return null;
    }
    const color = PLAYER_COLORS[this.state.players.length % PLAYER_COLORS.length];
    player = createPlayer({ name, sessionId, color });
    player.angle = this.state.players.length * ((Math.PI * 2) / Math.max(MAX_RUNNERS, 1));
    this.state.players.push(player);
    this.bumpLobbyRevision();
    this.bumpRoundRevision();
    this.syncPhaseFromReadiness();
    return player;
  }

  disconnectPlayer(playerId, now = Date.now()) {
    const player = this.getPlayer(playerId);
    if (!player) {
      return;
    }
    player.connected = false;
    player.disconnectedAt = now;
    player.disconnectDeadlineAt = now + DISCONNECT_GRACE_MS;
    player.ready = false;
    player.moveDirection = 0;
    player.pendingLaneShift = 0;
    this.bumpLobbyRevision();
    this.bumpRoundRevision();
    this.state.photographerPlayerId = this.getPhotographer()?.id || null;
    this.syncPhaseFromReadiness();
  }

  removePlayer(playerId) {
    this.state.players = this.state.players.filter((player) => player.id !== playerId);
    if (this.state.photographerPlayerId === playerId) {
      this.state.photographerPlayerId = null;
    }
    this.bumpLobbyRevision();
    this.bumpRoundRevision();
    this.syncPhaseFromReadiness();
  }

  getConnectedPlayers() {
    return this.state.players.filter((player) => player.connected);
  }

  getActivePlayers() {
    return this.getConnectedPlayers().filter((player) => player.role);
  }

  getConnectedPhotographerExcluding(playerId = null) {
    return this.getConnectedPlayers().find((player) => player.role === ROLES.PHOTOGRAPHER && player.id !== playerId) || null;
  }

  getConnectedRunnersExcluding(playerId = null) {
    return this.getConnectedPlayers().filter((player) => player.role === ROLES.RUNNER && player.id !== playerId);
  }

  reconcileReconnectedPlayerRole(player) {
    if (!player?.role) {
      return;
    }
    if (player.role === ROLES.PHOTOGRAPHER && this.getConnectedPhotographerExcluding(player.id)) {
      player.role = null;
    }
    if (player.role === ROLES.RUNNER && this.getConnectedRunnersExcluding(player.id).length >= MAX_RUNNERS) {
      player.role = null;
    }
    if (!player.role) {
      player.ready = false;
      player.moveDirection = 0;
      player.pendingLaneShift = 0;
    }
  }

  pruneDisconnectedPlayers(now = Date.now()) {
    const expiredPlayerIds = this.state.players
      .filter((player) => !player.connected && typeof player.disconnectDeadlineAt === "number" && player.disconnectDeadlineAt <= now)
      .map((player) => player.id);

    if (expiredPlayerIds.length === 0) {
      return false;
    }

    for (const playerId of expiredPlayerIds) {
      this.removePlayer(playerId);
    }
    return true;
  }

  getPlayer(playerId) {
    return this.state.players.find((player) => player.id === playerId) || null;
  }

  getPhotographer() {
    return this.getConnectedPlayers().find((player) => player.role === ROLES.PHOTOGRAPHER) || null;
  }

  getRunners() {
    return this.getConnectedPlayers().filter((player) => player.role === ROLES.RUNNER);
  }

  getRoleAvailability() {
    const photographer = this.getPhotographer();
    const runnerCount = this.getRunners().length;
    return {
      photographerAvailable: !photographer,
      photographerPlayerId: photographer?.id || null,
      runnerSlotsRemaining: Math.max(0, MAX_RUNNERS - runnerCount)
    };
  }

  canStartRound() {
    return Boolean(this.getPhotographer()) && this.getRunners().length >= 1;
  }

  setThemePreference(playerId, nextThemePreference) {
    const player = this.getPlayer(playerId);
    if (!player) {
      return { ok: false, message: COPY.errors.playerNotFound };
    }
    if (player.role !== ROLES.PHOTOGRAPHER) {
      return { ok: false, message: COPY.errors.onlyPhotographerCanSetTheme };
    }
    if ([GAME_PHASES.COUNTDOWN, GAME_PHASES.PLAYING, GAME_PHASES.RESULTS].includes(this.state.phase)) {
      return { ok: false, message: COPY.errors.themeLocked };
    }
    if (nextThemePreference !== null && !isArenaThemeId(nextThemePreference)) {
      return { ok: false, message: COPY.errors.unknownTheme };
    }

    this.state.themePreference = nextThemePreference;
    if (nextThemePreference) {
      this.state.resolvedTheme = nextThemePreference;
    }
    this.bumpLobbyRevision();
    this.bumpRoundRevision();
    return {
      ok: true,
      themePreference: this.state.themePreference,
      resolvedTheme: this.state.resolvedTheme
    };
  }

  chooseRole(playerId, role) {
    const player = this.getPlayer(playerId);
    if (!player) {
      return { ok: false, message: COPY.errors.playerNotFound };
    }
    if (role == null) {
      if (player.role === ROLES.PHOTOGRAPHER && this.state.photographerPlayerId === playerId) {
        this.state.photographerPlayerId = null;
      }
      player.role = null;
      player.ready = false;
      player.moveDirection = 0;
      player.pendingLaneShift = 0;
      player.setup.motionReady = false;
      player.laneIndex = 1;
      this.bumpLobbyRevision();
      this.bumpRoundRevision();
      this.syncPhaseFromReadiness();
      return { ok: true, player };
    }
    if (![ROLES.PHOTOGRAPHER, ROLES.RUNNER].includes(role)) {
      return { ok: false, message: COPY.errors.unknownRole };
    }
    if (player.role === ROLES.PHOTOGRAPHER && role !== ROLES.PHOTOGRAPHER && this.state.photographerPlayerId === playerId) {
      this.state.photographerPlayerId = null;
    }
    if (role === ROLES.PHOTOGRAPHER) {
      const current = this.getPhotographer();
      if (current && current.id !== playerId) {
        return { ok: false, message: COPY.errors.photographerTaken };
      }
      this.state.photographerPlayerId = playerId;
      player.laneIndex = 0;
      player.angle = 0;
    }
    if (role === ROLES.RUNNER) {
      player.setup.motionReady = false;
      player.setup.faceReady = !player.setup.faceEnabled;
    }
    player.role = role;
    player.ready = false;
    this.bumpLobbyRevision();
    this.bumpRoundRevision();
    this.syncPhaseFromReadiness();
    return { ok: true, player };
  }

  setLoadProgress(playerId, progress, setup = {}) {
    const player = this.getPlayer(playerId);
    if (!player) {
      return;
    }
    player.loadProgress = clamp(Number(progress) || 0, 0, 100);
    if (typeof setup.motionReady === "boolean") {
      player.setup.motionReady = setup.motionReady;
    }
    if (typeof setup.faceReady === "boolean") {
      player.setup.faceReady = setup.faceReady;
    }
    if (typeof setup.faceEnabled === "boolean") {
      player.setup.faceEnabled = setup.faceEnabled;
      if (!setup.faceEnabled) {
        player.setup.faceReady = true;
      }
    }
    this.bumpLobbyRevision();
    this.bumpRoundRevision();
    this.syncPhaseFromReadiness();
  }

  setReady(playerId, nextReady) {
    const player = this.getPlayer(playerId);
    if (!player) {
      return { ok: false, message: COPY.errors.playerNotFound };
    }
    if (!player.role) {
      return { ok: false, message: COPY.errors.chooseRoleFirst };
    }
    if (player.role === ROLES.RUNNER && player.setup.faceEnabled && !player.setup.faceReady) {
      return { ok: false, message: COPY.errors.runnerNeedsFace };
    }
    if (player.role === ROLES.PHOTOGRAPHER && !player.setup.motionReady) {
      return { ok: false, message: COPY.errors.photographerNeedsMotion };
    }
    if (player.loadProgress < LOAD_READY_PERCENT) {
      return { ok: false, message: COPY.errors.assetsNotReady };
    }
    player.ready = Boolean(nextReady);
    this.bumpLobbyRevision();
    this.bumpRoundRevision();
    this.syncPhaseFromReadiness();
    return { ok: true };
  }

  updateFaceFrame(playerId, payload = {}) {
    const player = this.getPlayer(playerId);
    if (!player) {
      return { ok: false, message: COPY.errors.playerNotFound };
    }
    if (!isDataUrlWithinLimit(payload.imageDataUrl, MAX_FACE_FRAME_BYTES)) {
      return { ok: false, message: COPY.errors.invalidFaceImage };
    }
    player.faceFrame = {
      imageDataUrl: payload.imageDataUrl,
      capturedAt: Number(payload.capturedAt || Date.now())
    };
    player.faceUpdatedAt = Date.now();
    player.setup.faceReady = true;
    player.setup.faceEnabled = true;
    this.bumpLobbyRevision();
    this.bumpRoundRevision();
    return { ok: true, player };
  }

  updatePhotographerMotion(playerId, payload = {}) {
    const player = this.getPlayer(playerId);
    if (!player || player.role !== ROLES.PHOTOGRAPHER) {
      return;
    }
    player.yaw = normalizeAngle(Number(payload.yaw || 0));
    player.pitch = clamp(Number(payload.pitch || 0), ARENA.pitchClamp.min, ARENA.pitchClamp.max);
  }

  updateRunnerInput(playerId, payload = {}) {
    const player = this.getPlayer(playerId);
    if (!player || player.role !== ROLES.RUNNER) {
      return;
    }
    player.moveDirection = clamp(Number(payload.moveDirection || 0), -1, 1);
    const laneShift = clamp(Number(payload.laneShift || 0), -1, 1);
    if (laneShift !== 0) {
      player.pendingLaneShift = laneShift;
    }
  }

  syncPhaseFromReadiness() {
    const previousPhase = this.state.phase;
    if (this.state.phase === GAME_PHASES.PLAYING || this.state.phase === GAME_PHASES.RESULTS) {
      return;
    }
    const players = this.getConnectedPlayers();
    const activePlayers = this.getActivePlayers();
    if (players.length === 0) {
      this.state.phase = GAME_PHASES.LOBBY;
      if (this.state.phase !== previousPhase) {
        this.bumpLobbyRevision();
        this.bumpRoundRevision();
      }
      return;
    }
    const hasRoles = activePlayers.length > 0;
    const photographer = this.getPhotographer();
    const runners = this.getRunners();
    const allLoaded = activePlayers.length > 0 && activePlayers.every((player) => player.loadProgress >= LOAD_READY_PERCENT);
    const allReady = activePlayers.length > 0 && activePlayers.every((player) => player.ready);
    if (!hasRoles) {
      this.state.phase = GAME_PHASES.LOBBY;
      if (this.state.phase !== previousPhase) {
        this.bumpLobbyRevision();
        this.bumpRoundRevision();
      }
      return;
    }
    if (!photographer || runners.length === 0) {
      this.state.phase = GAME_PHASES.ROLE_ASSIGN;
      if (this.state.phase !== previousPhase) {
        this.bumpLobbyRevision();
        this.bumpRoundRevision();
      }
      return;
    }
    if (!allLoaded) {
      this.state.phase = GAME_PHASES.ASSET_LOADING;
      if (this.state.phase !== previousPhase) {
        this.bumpLobbyRevision();
        this.bumpRoundRevision();
      }
      return;
    }
    if (previousPhase === GAME_PHASES.COUNTDOWN && allReady && this.canStartRound()) {
      this.state.phase = GAME_PHASES.COUNTDOWN;
      return;
    }
    this.state.phase = GAME_PHASES.READY;
    if (this.state.phase !== previousPhase) {
      this.bumpLobbyRevision();
      this.bumpRoundRevision();
    }
    if (previousPhase !== GAME_PHASES.COUNTDOWN && allReady && this.canStartRound()) {
      this.startCountdown();
    }
  }

  startCountdown() {
    if (this.state.phase === GAME_PHASES.COUNTDOWN || this.state.phase === GAME_PHASES.PLAYING) {
      return;
    }
    this.countdownStartedAt = Date.now();
    this.state.phase = GAME_PHASES.COUNTDOWN;
    this.state.countdownLeft = COUNTDOWN_SECONDS;
    this.state.successfulGallery = [];
    this.state.shotHistory = [];
    this.state.capturedRunnerIds = [];
    this.state.winner = null;
    this.state.resultsTimeLeft = RESULTS_SECONDS;
    this.state.galleryClosedPlayerIds = [];
    this.state.shutterSequence = 0;
    this.state.lastShotAt = 0;
    this.state.nextShutterAt = 0;
    for (const runner of this.getRunners()) {
      runner.moveDirection = 0;
      runner.pendingLaneShift = 0;
    }
    this.bumpLobbyRevision();
    this.bumpRoundRevision();
  }

  startRound(now = Date.now()) {
    this.roundStartedAt = now;
    this.state.resolvedTheme = this.state.themePreference || randomArenaThemeId();
    this.state.phase = GAME_PHASES.PLAYING;
    this.state.timeLeft = ROUND_SECONDS;
    this.state.successfulGallery = [];
    this.state.shotHistory = [];
    this.state.capturedRunnerIds = [];
    this.state.winner = null;
    this.state.resultsTimeLeft = RESULTS_SECONDS;
    this.state.galleryClosedPlayerIds = [];
    this.bumpRoundRevision();
  }

  finishRound(winner, now = Date.now()) {
    if (this.state.phase === GAME_PHASES.RESULTS) {
      return;
    }
    this.resultsStartedAt = now;
    this.state.phase = GAME_PHASES.RESULTS;
    this.state.winner = winner;
    this.state.timeLeft = 0;
    this.state.resultsTimeLeft = RESULTS_SECONDS;
    this.state.galleryClosedPlayerIds = [];
    this.bumpLobbyRevision();
    this.bumpRoundRevision();
  }

  getConnectedGalleryReviewPlayerIds() {
    return this.state.players
      .filter((player) => player.connected)
      .map((player) => player.id);
  }

  getGalleryReviewStatus() {
    const connectedPlayerIds = this.getConnectedGalleryReviewPlayerIds();
    const closedIds = connectedPlayerIds.filter((playerId) => this.state.galleryClosedPlayerIds.includes(playerId));
    return {
      totalCount: connectedPlayerIds.length,
      closedCount: closedIds.length,
      allClosed: connectedPlayerIds.length > 0 && closedIds.length === connectedPlayerIds.length
    };
  }

  setGalleryReview(playerId, isOpen) {
    const player = this.getPlayer(playerId);
    if (!player) {
      return { ok: false, message: COPY.errors.playerNotFound, reset: false };
    }
    if (this.state.phase !== GAME_PHASES.RESULTS) {
      return { ok: true, reset: false };
    }
    if (isOpen) {
      this.state.galleryClosedPlayerIds = this.state.galleryClosedPlayerIds.filter((id) => id !== playerId);
    } else if (!this.state.galleryClosedPlayerIds.includes(playerId)) {
      this.state.galleryClosedPlayerIds.push(playerId);
    }
    this.bumpRoundRevision();
    const reviewStatus = this.getGalleryReviewStatus();
    if (reviewStatus.allClosed) {
      this.resetForLobby();
      return { ok: true, reset: true };
    }
    return { ok: true, reset: false };
  }

  getWinningTeam() {
    const runnerCount = this.getRunners().length;
    if (runnerCount === 0) {
      return "runners";
    }
    return this.state.capturedRunnerIds.length >= runnerCount ? "photographer" : "runners";
  }

  tick(now = Date.now(), deltaMs = now - this.lastTickAt) {
    const safeDeltaMs = Math.max(0, Math.min(deltaMs, 250));
    this.lastTickAt = now;
    let roundChanged = false;
    if (this.pruneDisconnectedPlayers(now)) {
      roundChanged = true;
    }
    if (this.state.phase === GAME_PHASES.COUNTDOWN) {
      const elapsed = now - this.countdownStartedAt;
      const nextCountdownLeft = Math.max(0, COUNTDOWN_SECONDS - Math.floor(elapsed / 1000));
      if (nextCountdownLeft !== this.state.countdownLeft) {
        this.state.countdownLeft = nextCountdownLeft;
        roundChanged = true;
      }
      if (elapsed >= COUNTDOWN_SECONDS * 1000) {
        this.startRound(now);
        roundChanged = true;
      }
    }
    if (this.state.phase === GAME_PHASES.PLAYING) {
      const deltaSeconds = safeDeltaMs / 1000;
      this.tickRunners(now, deltaSeconds);
      this.tickFountains(now);
      roundChanged = true;
      const elapsed = (now - this.roundStartedAt) / 1000;
      this.state.timeLeft = Math.max(0, ROUND_SECONDS - elapsed);
      if (elapsed >= ROUND_SECONDS) {
        this.finishRound(this.getWinningTeam(), now);
        roundChanged = true;
      }
    }
    if (this.state.phase === GAME_PHASES.RESULTS) {
      const nextResultsTimeLeft = roundSeconds(RESULTS_SECONDS - (now - this.resultsStartedAt) / 1000, 1);
      if (nextResultsTimeLeft !== this.state.resultsTimeLeft) {
        this.state.resultsTimeLeft = nextResultsTimeLeft;
        roundChanged = true;
      }
      if (this.getGalleryReviewStatus().allClosed) {
        this.resetForLobby();
        roundChanged = true;
        return;
      }
      if (now - this.resultsStartedAt >= RESULTS_SECONDS * 1000) {
        this.resetForLobby();
        roundChanged = true;
      }
    }
    if (roundChanged) {
      this.bumpRoundRevision();
    }
  }

  tickRunners(now, deltaSeconds) {
    for (const runner of this.getRunners()) {
      runner.angle = normalizeAngle(runner.angle + runner.moveDirection * ARENA.runnerAngularSpeed * deltaSeconds);
      if (runner.pendingLaneShift !== 0 && now - runner.lastLaneShiftAt >= ARENA.laneSwapCooldownMs) {
        runner.laneIndex = clamp(runner.laneIndex + runner.pendingLaneShift, 0, ARENA.runnerLanes.length - 1);
        runner.lastLaneShiftAt = now;
      }
      runner.pendingLaneShift = 0;
    }
  }

  tickFountains(now) {
    const step = Math.floor(now / ARENA.obstructionPulseMs);
    const secondaryStep = Math.floor(now / (ARENA.obstructionPulseMs * 0.75));
    this.state.fountains = this.state.fountains.map((jet, index) => {
      const active = index === step % this.state.fountains.length || index === secondaryStep % this.state.fountains.length;
      return {
        ...jet,
        active,
        strength: active ? 1 : 0.12
      };
    });
  }

  isRunnerVisibleToPhotographer(runner, photographer) {
    const horizontalFov = getHorizontalFovRadians(ARENA.captureAspectRatio);
    const delta = normalizeAngle(runner.angle - photographer.yaw);
    if (Math.abs(delta) > horizontalFov / 2 + ARENA.runnerBodyAnglePadding) {
      return false;
    }
    return !this.isRunnerFullyObstructed(runner.angle, ARENA.runnerBodyAnglePadding);
  }

  isObstructed(targetAngle) {
    return this.state.fountains.some((jet) => {
      const padding = Math.max(0, ARENA.obstructionAnglePadding + (jet.width || 0));
      return jet.active && Math.abs(normalizeAngle(targetAngle - jet.angle)) <= padding;
    });
  }

  getRunnerObstructionCoverage(targetAngle, runnerHalfWidth = ARENA.runnerBodyAnglePadding) {
    const sampleAngles = getRunnerVisibilitySampleAngles(targetAngle, runnerHalfWidth);
    const obstructedSampleCount = sampleAngles.filter((sampleAngle) => this.isObstructed(sampleAngle)).length;
    return obstructedSampleCount / Math.max(sampleAngles.length, 1);
  }

  isRunnerFullyObstructed(targetAngle, runnerHalfWidth = ARENA.runnerBodyAnglePadding) {
    return this.getRunnerObstructionCoverage(targetAngle, runnerHalfWidth) >= ARENA.obstructionCoverageThreshold;
  }

  registerShutter(playerId, payload = {}) {
    const photographer = this.getPlayer(playerId);
    if (!photographer || photographer.role !== ROLES.PHOTOGRAPHER) {
      return { ok: false, message: COPY.errors.onlyPhotographerCanShoot };
    }
    if (this.state.phase !== GAME_PHASES.PLAYING) {
      return { ok: false, message: COPY.errors.roundNotActive };
    }
    const now = Date.now();
    if (now < this.state.nextShutterAt) {
      return {
        ok: false,
        message: COPY.errors.shutterCoolingDown,
        retryAt: this.state.nextShutterAt
      };
    }
    if (typeof payload.yaw === "number" || typeof payload.pitch === "number") {
      this.updatePhotographerMotion(playerId, payload);
    }
    const imageDataUrl = payload.imageDataUrl || "";
    if (imageDataUrl && !isDataUrlWithinLimit(imageDataUrl, MAX_PHOTO_BYTES)) {
      return { ok: false, message: COPY.errors.photoTooLarge };
    }

    const projectedWinnerBefore = this.getWinningTeam();
    const visibleRunners = this.getRunners().filter((runner) => this.isRunnerVisibleToPhotographer(runner, photographer));
    const capturedRunnerIds = visibleRunners.map((runner) => runner.id);
    const horizontalFov = getHorizontalFovRadians(ARENA.captureAspectRatio);
    const blockedRunnerIds = this.getRunners()
      .filter((runner) => !capturedRunnerIds.includes(runner.id))
      .filter((runner) => {
        const delta = normalizeAngle(runner.angle - photographer.yaw);
        return Math.abs(delta) <= horizontalFov / 2 + ARENA.runnerBodyAnglePadding
          && this.isRunnerFullyObstructed(runner.angle, ARENA.runnerBodyAnglePadding);
      })
      .map((runner) => runner.id);
    const newRunnerIds = capturedRunnerIds.filter((runnerId) => !this.state.capturedRunnerIds.includes(runnerId));
    if (newRunnerIds.length > 0) {
      this.state.capturedRunnerIds.push(...newRunnerIds);
      this.state.capturedRunnerIds = unique(this.state.capturedRunnerIds);
    }

    const photo = {
      id: crypto.randomUUID(),
      roundId: this.state.roundId,
      createdAt: now,
      capturedRunnerIds,
      newRunnerIds,
      blockedRunnerIds,
      shutterSequence: this.state.shutterSequence + 1,
      imageDataUrl
    };

    this.state.shotHistory.unshift(photo);
    this.state.shotHistory = this.state.shotHistory.slice(0, 30);
    if (capturedRunnerIds.length > 0) {
      this.state.successfulGallery.unshift(photo);
      this.state.successfulGallery = this.state.successfulGallery.slice(0, 18);
    }
    this.state.shutterSequence = photo.shutterSequence;
    this.state.lastShotAt = photo.createdAt;
    this.state.nextShutterAt = photo.createdAt + SHUTTER_COOLDOWN_MS;
    this.bumpRoundRevision();

    return {
      ok: true,
      photo,
      debug: {
        visibleRunnerIds: capturedRunnerIds,
        newRunnerIds,
        blockedRunnerIds,
        photographerId: photographer.id,
        projectedWinner: this.getWinningTeam(),
        winnerChanged: projectedWinnerBefore !== this.getWinningTeam()
      }
    };
  }

  getRunnerCaptureSummary() {
    return this.getRunners().map((runner) => {
      const successfulShots = this.state.successfulGallery.filter((photo) => photo.capturedRunnerIds.includes(runner.id));
      return {
        playerId: runner.id,
        name: runner.name,
        color: runner.color,
        captured: this.state.capturedRunnerIds.includes(runner.id),
        successfulPhotoCount: successfulShots.length,
        representativePhoto: successfulShots[0] || null,
        faceImageDataUrl: runner.faceFrame?.imageDataUrl || null,
        fallbackEmoji: fallbackEmojiForPlayer(runner)
      };
    });
  }

  getRunnerGroups() {
    return this.getRunners().map((runner) => {
      const photos = this.state.successfulGallery
        .filter((photo) => photo.capturedRunnerIds.includes(runner.id))
        .map((photo) => ({ ...photo }));
      return {
        playerId: runner.id,
        name: runner.name,
        color: runner.color,
        captured: this.state.capturedRunnerIds.includes(runner.id),
        photos,
        faceImageDataUrl: runner.faceFrame?.imageDataUrl || null,
        fallbackEmoji: fallbackEmojiForPlayer(runner)
      };
    });
  }

  buildRoundDebugSummary() {
    return {
      roomCode: this.roomCode,
      roundId: this.state.roundId,
      resolvedTheme: this.state.resolvedTheme,
      winner: this.state.winner,
      capturedRunnerIds: [...this.state.capturedRunnerIds],
      shotIds: this.state.shotHistory.map((photo) => photo.id),
      runnerSummary: this.getRunnerCaptureSummary().map((entry) => ({
        playerId: entry.playerId,
        name: entry.name,
        captured: entry.captured,
        successfulPhotoCount: entry.successfulPhotoCount
      }))
    };
  }

  getRoomState() {
    return {
      roomCode: this.roomCode,
      qrCodeDataUrl: this.state.qrCodeDataUrl,
      joinUrl: this.state.joinUrl,
      phase: this.state.phase,
      themePreference: this.state.themePreference,
      resolvedTheme: this.state.resolvedTheme
    };
  }

  getLobbyState() {
    return {
      lobbyRevision: this.state.lobbyRevision,
      phase: this.state.phase,
      roomCode: this.roomCode,
      themePreference: this.state.themePreference,
      resolvedTheme: this.state.resolvedTheme,
      roleAvailability: this.getRoleAvailability(),
      minimumRequirementsMet: this.canStartRound(),
      players: this.state.players.map((player) => ({
        id: player.id,
        name: player.name,
        role: player.role,
        ready: player.ready,
        connected: player.connected,
        loadProgress: player.loadProgress,
        hasFaceFrame: Boolean(player.faceFrame),
        faceFrameUpdatedAt: player.faceUpdatedAt,
        setup: {
          motionReady: Boolean(player.setup.motionReady),
          faceReady: Boolean(player.setup.faceReady),
          faceEnabled: Boolean(player.setup.faceEnabled)
        },
        color: player.color
      })),
      photographerPlayerId: this.state.photographerPlayerId
    };
  }

  getRoundState() {
    return {
      roundRevision: this.state.roundRevision,
      phase: this.state.phase,
      roundId: this.state.roundId,
      themePreference: this.state.themePreference,
      resolvedTheme: this.state.resolvedTheme,
      countdownLeft: this.state.countdownLeft,
      timeLeft: this.state.timeLeft,
      resultsTimeLeft: this.state.resultsTimeLeft,
      galleryReview: this.getGalleryReviewStatus(),
      winner: this.state.winner,
      capturedRunnerIds: [...this.state.capturedRunnerIds],
      photographerPlayerId: this.state.photographerPlayerId,
      shutterSequence: this.state.shutterSequence,
      lastShotAt: this.state.lastShotAt,
      nextShutterAt: this.state.nextShutterAt,
      shutterCooldownMs: SHUTTER_COOLDOWN_MS,
      fountains: this.state.fountains.map((jet) => ({ ...jet })),
      players: this.state.players.map((player) => ({
        id: player.id,
        name: player.name,
        role: player.role,
        color: player.color,
        laneIndex: player.laneIndex,
        angle: player.angle,
        yaw: player.yaw,
        pitch: player.pitch,
        faceFrame: player.faceFrame,
        faceEnabled: Boolean(player.setup.faceEnabled),
        connected: player.connected
      }))
    };
  }

  getGalleryState() {
    return {
      roundId: this.state.roundId,
      winner: this.state.winner,
      capturedRunnerIds: [...this.state.capturedRunnerIds],
      resultsTimeLeft: this.state.resultsTimeLeft,
      galleryReview: this.getGalleryReviewStatus(),
      runnerSummary: this.getRunnerCaptureSummary(),
      runnerGroups: this.getRunnerGroups(),
      items: this.state.successfulGallery.map((item) => ({ ...item }))
    };
  }

  getSelfState(playerId) {
    const player = this.getPlayer(playerId);
    if (!player) {
      return {
        playerId: null,
        role: null
      };
    }
    return {
      playerId: player.id,
      role: player.role,
      sessionId: player.sessionId
    };
  }
}
