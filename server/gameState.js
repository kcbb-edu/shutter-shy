import crypto from "node:crypto";
import {
  AUDIO,
  COUNTDOWN_SECONDS,
  FACE_STALE_HOLD_MS,
  MAX_RECENT_EVENTS,
  GAME_DURATION_SECONDS,
  GAME_PHASES,
  MAX_PLAYERS,
  MAX_FACE_SNAPSHOT_BYTES,
  PLAYER_COLORS,
  RECENT_EVENT_SECONDS,
  RESPAWN_DELAY_SECONDS,
  RESULT_SECONDS,
  ROLES,
  RUNNER_LIVES,
  TICK_MS,
  VIEWPORT_POLICY,
  WORLD
} from "../shared/constants.js";
import { buildEqBands, getBandAtX, getLogBandRangeForIndex, sampleTerrainTopY } from "../shared/utils.js";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(current, target, factor) {
  return current + (target - current) * factor;
}

function percentile(values, quantile) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = clamp(Math.round((sorted.length - 1) * quantile), 0, sorted.length - 1);
  return sorted[index];
}

function createRecentEvent({ playerId, message, kind, createdAt = Date.now() }) {
  return { playerId, message, kind, createdAt };
}

function getRunnerFootSampleXs(player) {
  const halfFootSpan = WORLD.playerWidth * 0.38;
  return [
    player.x - halfFootSpan,
    player.x,
    player.x + halfFootSpan
  ];
}

export function buildLayout(displayAspectRatio = WORLD.aspectRatio) {
  const isExtraWide = displayAspectRatio >= WORLD.extraWideThreshold;
  const isUltrawide = !isExtraWide && displayAspectRatio >= WORLD.ultrawideThreshold;
  const profile = isExtraWide ? "extra-wide" : isUltrawide ? "ultrawide" : "standard";
  const gameplayWidth = isExtraWide
    ? WORLD.extraWideGameplayWidth
    : isUltrawide
      ? WORLD.ultrawideGameplayWidth
      : WORLD.baseGameplayWidth;
  return {
    profile,
    displayAspectRatio,
    gameplayWidth,
    gameplayAspectRatio: WORLD.aspectRatio * gameplayWidth,
    maxMoveSpeed: WORLD.maxMoveSpeed * (isExtraWide ? WORLD.extraWideMoveSpeedMultiplier : isUltrawide ? WORLD.ultrawideMoveSpeedMultiplier : 1),
    terrainSigma: isExtraWide ? WORLD.extraWideTerrainSigma : isUltrawide ? WORLD.ultrawideTerrainSigma : WORLD.terrainSigma,
    edgeZoneWidth: isExtraWide ? WORLD.extraWideEdgeZoneWidth : isUltrawide ? WORLD.ultrawideEdgeZoneWidth : WORLD.edgeZoneWidth,
    edgeDropDepth: WORLD.edgeDropDepth,
    spawnPadding: isExtraWide ? WORLD.extraWideSpawnPadding : isUltrawide ? WORLD.ultrawideSpawnPadding : WORLD.spawnPadding
  };
}

export function samplePlatformHeight(layout, x) {
  if (x < 0 || x > layout.gameplayWidth) {
    return null;
  }
  const edgeZone = layout.edgeZoneWidth;
  if (x < edgeZone) {
    const ratio = (edgeZone - x) / edgeZone;
    return WORLD.platformY + ratio * layout.edgeDropDepth;
  }
  if (x > layout.gameplayWidth - edgeZone) {
    const ratio = (x - (layout.gameplayWidth - edgeZone)) / edgeZone;
    return WORLD.platformY + ratio * layout.edgeDropDepth;
  }
  return WORLD.platformY;
}

function sampleSlopeDirection(layout, x) {
  if (x < layout.edgeZoneWidth) {
    return 1;
  }
  if (x > layout.gameplayWidth - layout.edgeZoneWidth) {
    return -1;
  }
  return 0;
}

function createAttackerSetup() {
  return {
    ownerSessionId: null,
    status: "preset",
    skipped: true,
    hasMicPermission: false,
    environmentPreset: "balanced",
    sensitivityPreset: "balanced",
    noiseGate: AUDIO.minAmplitude,
    ceiling: AUDIO.maxAmplitude,
    expectedCoverage: "fallback",
    calibrationState: "preset",
    profileLowHz: AUDIO.defaultProfileLowHz,
    profileHighHz: AUDIO.defaultProfileHighHz,
    diagnosticsEnabled: false,
    lastRejectionReason: null,
    lastAmplitudeNorm: 0,
    lastDominantBandIndex: null,
    lastDominantBandHz: null,
    lastBandLevels: Array.from({ length: WORLD.eqBandCount }, () => 0),
    profileRangeHz: {
      lowHz: AUDIO.defaultProfileLowHz,
      highHz: AUDIO.defaultProfileHighHz
    },
    voiced: false
  };
}

function createIdleTerrain(layout) {
  return {
    baselineY: WORLD.waveBaselineY,
    platformY: WORLD.platformY,
    activeBandIndex: null,
    bandCount: WORLD.eqBandCount,
    bars: buildEqBands(layout, { bandCount: WORLD.eqBandCount })
  };
}

function rebuildTerrainBars(terrain, layout) {
  const nextBars = buildEqBands(layout, { bandCount: terrain.bandCount || WORLD.eqBandCount });
  const previousBars = Array.isArray(terrain.bars) ? terrain.bars : [];
  return nextBars.map((bar) => {
    const previous = previousBars[bar.index];
    return previous
      ? {
          ...bar,
          targetHeight: previous.targetHeight || 0,
          currentHeight: previous.currentHeight || 0
        }
      : bar;
  });
}

function makePlayer(name, color, sessionId) {
  return {
    id: crypto.randomUUID(),
    sessionId,
    name: String(name || "Player").slice(0, 20),
    color,
    role: null,
    x: 0.5,
    y: WORLD.platformY - WORLD.playerHeight / 2,
    vx: 0,
    vy: 0,
    isAlive: true,
    isRespawning: false,
    isEliminated: false,
    isReady: false,
    isGrounded: true,
    livesRemaining: RUNNER_LIVES,
    deathCount: 0,
    eliminatedAt: null,
    respawnAt: null,
    lastDeathCause: null,
    invincibleUntil: 0,
    jumpBufferTicks: 0,
    coyoteTicks: 0,
    prevJumpInput: false,
    faceSnapshot: null,
    input: {
      left: false,
      right: false,
      jump: false
    }
  };
}

export class GameState {
  constructor(roomCode) {
    this.roomCode = roomCode;
    this.lastTickAt = Date.now();
    this.countdownStartedAt = null;
    this.resultStartedAt = null;
    this.roundWinner = null;
    this.targetAudio = {
      activeBandIndex: null,
      amplitude: 0,
      bandLevels: Array.from({ length: WORLD.eqBandCount }, () => 0),
      voiced: false
    };
    const layout = buildLayout();
    this.state = {
      phase: GAME_PHASES.LOBBY,
      roomCode,
      roundId: crypto.randomUUID(),
      timeLeft: GAME_DURATION_SECONDS,
      countdownLeft: COUNTDOWN_SECONDS,
      winner: null,
      players: [],
      terrain: createIdleTerrain(layout),
      attackerSetup: createAttackerSetup(),
      recentEvents: [],
      layout,
      viewportPolicy: {
        ...VIEWPORT_POLICY,
        gameplayAspectRatio: layout.gameplayAspectRatio
      },
      qrCodeDataUrl: null
    };
  }

  setQrCodeDataUrl(qrCodeDataUrl) {
    this.state.qrCodeDataUrl = qrCodeDataUrl;
  }

  pruneRecentEvents(now = Date.now()) {
    this.state.recentEvents = this.state.recentEvents
      .filter((event) => now - event.createdAt <= RECENT_EVENT_SECONDS * 1000)
      .slice(-MAX_RECENT_EVENTS);
  }

  pushRecentEvent(event) {
    this.state.recentEvents.push(createRecentEvent(event));
    this.pruneRecentEvents();
  }

  setDisplayMetrics({ aspectRatio }) {
    const layout = buildLayout(aspectRatio || WORLD.aspectRatio);
    this.state.layout = layout;
    this.state.viewportPolicy = {
      ...VIEWPORT_POLICY,
      gameplayAspectRatio: layout.gameplayAspectRatio
    };
    this.state.terrain.platformY = WORLD.platformY;
    this.state.terrain.baselineY = WORLD.waveBaselineY;
    this.state.terrain.bars = rebuildTerrainBars(this.state.terrain, layout);

    if (this.state.phase !== GAME_PHASES.PLAYING) {
      this.repositionRunners();
    }
  }

  addPlayer(name, sessionId) {
    if (this.state.players.length >= MAX_PLAYERS + 1) {
      return null;
    }
    const usedColors = new Set(this.state.players.map((player) => player.color));
    const color = PLAYER_COLORS.find((entry) => !usedColors.has(entry)) || PLAYER_COLORS[0];
    const player = makePlayer(name, color, sessionId);
    this.state.players.push(player);
    this.repositionRunners();
    this.refreshPhaseFromRoster();
    return player;
  }

  removePlayer(playerId) {
    const removed = this.getPlayer(playerId);
    this.state.players = this.state.players.filter((player) => player.id !== playerId);
    if (removed?.role === ROLES.ATTACKER) {
      this.state.attackerSetup = createAttackerSetup();
    }
    this.repositionRunners();
    this.refreshPhaseFromRoster();
  }

  getPlayer(playerId) {
    return this.state.players.find((player) => player.id === playerId) || null;
  }

  getPlayersByRole(role) {
    return this.state.players.filter((player) => player.role === role);
  }

  getAttacker() {
    return this.getPlayersByRole(ROLES.ATTACKER)[0] || null;
  }

  chooseRole(playerId, role) {
    const player = this.getPlayer(playerId);
    if (!player) {
      return { ok: false, reason: "Unknown player." };
    }
    const previousAttacker = this.getAttacker();
    if (role === ROLES.ATTACKER) {
      const attacker = previousAttacker;
      if (attacker && attacker.id !== playerId) {
        return { ok: false, reason: "Attacker role is already taken." };
      }
      if (this.state.attackerSetup.ownerSessionId && this.state.attackerSetup.ownerSessionId !== player.sessionId) {
        this.state.attackerSetup.hasMicPermission = false;
      }
      this.state.attackerSetup.ownerSessionId = player.sessionId;
    } else if (player.role === ROLES.ATTACKER && previousAttacker?.id === player.id) {
      this.state.attackerSetup.hasMicPermission = false;
    }

    player.role = role;
    player.isReady = false;
    this.repositionRunners();
    this.refreshPhaseFromRoster();
    return { ok: true };
  }

  setReady(playerId) {
    const player = this.getPlayer(playerId);
    if (!player || !player.role) {
      return { ok: false, reason: "Choose a role first." };
    }
    if (player.role === ROLES.ATTACKER && !this.isAttackerSetupSatisfied()) {
      return { ok: false, reason: "Enable the mic, then calibrate or skip setup before readying." };
    }
    player.isReady = true;
    this.refreshPhaseFromRoster();
    return { ok: true };
  }

  setInput(playerId, action, pressed) {
    const player = this.getPlayer(playerId);
    if (!player || player.role !== ROLES.PLAYER) {
      return;
    }
    if (action in player.input) {
      player.input[action] = Boolean(pressed);
    }
  }

  updateFaceSnapshot(playerId, payload = {}) {
    const player = this.getPlayer(playerId);
    if (!player) {
      return { ok: false, reason: "Unknown player." };
    }

    const imageBase64 = String(payload.imageBase64 || "");
    const capturedAt = Number(payload.capturedAt || Date.now());
    const shape = "circle";
    const byteLength = Buffer.byteLength(imageBase64, "utf8");

    if (!/^data:image\/(?:jpeg|png|webp);base64,/.test(imageBase64)) {
      return { ok: false, reason: "Invalid face snapshot." };
    }
    if (byteLength > MAX_FACE_SNAPSHOT_BYTES * 1.45) {
      return { ok: false, reason: "Face snapshot too large." };
    }

    player.faceSnapshot = {
      imageBase64,
      capturedAt,
      shape
    };
    return { ok: true };
  }

  getFreshFaceSnapshot(player, now = Date.now()) {
    if (!player?.faceSnapshot?.imageBase64) {
      return null;
    }
    if (!player.faceSnapshot.capturedAt || now - player.faceSnapshot.capturedAt > FACE_STALE_HOLD_MS) {
      return null;
    }
    return {
      imageBase64: player.faceSnapshot.imageBase64,
      capturedAt: player.faceSnapshot.capturedAt,
      shape: player.faceSnapshot.shape || "circle"
    };
  }

  updateAttackerSetup(playerId, payload = {}) {
    const attacker = this.getPlayer(playerId);
    if (!attacker || attacker.role !== ROLES.ATTACKER) {
      return;
    }

    const setup = this.state.attackerSetup;
    setup.ownerSessionId = attacker.sessionId;
    setup.hasMicPermission = Boolean(payload.hasMicPermission ?? setup.hasMicPermission);
    setup.environmentPreset = payload.environmentPreset || setup.environmentPreset;
    setup.sensitivityPreset = payload.sensitivityPreset || setup.sensitivityPreset;
    setup.noiseGate = clamp(Number(payload.noiseGate ?? setup.noiseGate), 0, 0.2);
    setup.ceiling = clamp(Number(payload.ceiling ?? setup.ceiling), setup.noiseGate + 0.01, 0.4);
    setup.status = payload.status || setup.status;
    setup.skipped = Boolean(payload.skipped ?? setup.skipped);
    setup.expectedCoverage = payload.expectedCoverage || setup.expectedCoverage;
    setup.calibrationState = payload.calibrationState || setup.calibrationState;
    setup.diagnosticsEnabled = Boolean(payload.diagnosticsEnabled ?? setup.diagnosticsEnabled);

    if (Number.isFinite(payload.profileLowHz) && Number.isFinite(payload.profileHighHz)) {
      const lowHz = clamp(Number(payload.profileLowHz), AUDIO.analysisMinHz, AUDIO.analysisMaxHz);
      const highHz = clamp(Number(payload.profileHighHz), lowHz + 1, AUDIO.analysisMaxHz);
      setup.profileLowHz = lowHz;
      setup.profileHighHz = highHz;
      setup.profileRangeHz = { lowHz, highHz };
    }
  }

  isAttackerSetupSatisfied() {
    const attacker = this.getAttacker();
    if (!attacker) {
      return false;
    }
    const setup = this.state.attackerSetup;
    return (
      setup.ownerSessionId === attacker.sessionId &&
      setup.hasMicPermission &&
      (setup.status === "complete" || setup.status === "fallback" || setup.status === "preset" || setup.skipped)
    );
  }

  updateAudio({ rawFundamentalHz = null, fundamentalHz = null, dominantBandIndex = null, dominantBandHz = null, bandLevels = null, amplitudeNorm = 0, profileRangeHz = null, voiced = false, diagnostics = null }) {
    const setup = this.state.attackerSetup;
    const safeBandLevels = Array.isArray(bandLevels) && bandLevels.length === this.state.terrain.bandCount
      ? bandLevels.map((level) => clamp(Number(level) || 0, 0, 1))
      : Array.from({ length: this.state.terrain.bandCount }, () => 0);
    const bandIndex = Number.isInteger(dominantBandIndex) ? clamp(dominantBandIndex, 0, this.state.terrain.bandCount - 1) : null;
    const activeProfileRange = profileRangeHz && Number.isFinite(profileRangeHz.lowHz) && Number.isFinite(profileRangeHz.highHz)
      ? {
          lowHz: clamp(Number(profileRangeHz.lowHz), AUDIO.analysisMinHz, AUDIO.analysisMaxHz),
          highHz: clamp(Number(profileRangeHz.highHz), AUDIO.analysisMinHz + 1, AUDIO.analysisMaxHz)
        }
      : setup.profileRangeHz;
    const bandRange = bandIndex === null ? null : getLogBandRangeForIndex(bandIndex, activeProfileRange.lowHz, activeProfileRange.highHz, this.state.terrain.bandCount);

    this.targetAudio.activeBandIndex = voiced ? bandIndex : null;
    this.targetAudio.amplitude = clamp(amplitudeNorm, 0, 1);
    this.targetAudio.bandLevels = voiced ? safeBandLevels : Array.from({ length: this.state.terrain.bandCount }, () => 0);
    this.targetAudio.voiced = Boolean(voiced);
    if (typeof diagnostics?.rejectionReason === "string" || diagnostics?.rejectionReason === null) {
      setup.lastRejectionReason = diagnostics?.rejectionReason ?? null;
    }
    if (typeof diagnostics?.calibrationState === "string") {
      setup.calibrationState = diagnostics.calibrationState;
    }
    setup.profileLowHz = activeProfileRange.lowHz;
    setup.profileHighHz = activeProfileRange.highHz;
    setup.profileRangeHz = activeProfileRange;
    setup.lastAmplitudeNorm = this.targetAudio.amplitude;
    setup.lastDominantBandIndex = voiced ? bandIndex : null;
    setup.lastDominantBandHz = voiced && Number.isFinite(dominantBandHz) ? dominantBandHz : null;
    setup.lastBandLevels = this.targetAudio.bandLevels;
    setup.voiced = Boolean(voiced);
    return {
      dominantBandIndex: voiced ? bandIndex : null,
      dominantBandHz: voiced && Number.isFinite(dominantBandHz) ? dominantBandHz : null,
      bandRange,
      profileRangeHz: activeProfileRange,
      levels: this.targetAudio.bandLevels,
      voiced: Boolean(voiced),
      amplitude: this.targetAudio.amplitude,
      rawFundamentalHz: Number.isFinite(rawFundamentalHz) ? rawFundamentalHz : (Number.isFinite(diagnostics?.rawFundamentalHz) ? diagnostics.rawFundamentalHz : null),
      fundamentalHz: Number.isFinite(fundamentalHz) ? fundamentalHz : (Number.isFinite(diagnostics?.fundamentalHz) ? diagnostics.fundamentalHz : null),
      diagnosticsEnabled: setup.diagnosticsEnabled
    };
  }

  refreshPhaseFromRoster() {
    if (this.state.phase === GAME_PHASES.PLAYING || this.state.phase === GAME_PHASES.RESULT || this.state.phase === GAME_PHASES.COUNTDOWN) {
      return;
    }
    if (this.state.players.length === 0) {
      this.state.phase = GAME_PHASES.LOBBY;
      return;
    }

    const hasAttacker = this.getPlayersByRole(ROLES.ATTACKER).length === 1;
    const hasPlayers = this.getPlayersByRole(ROLES.PLAYER).length > 0;
    const everyoneHasRole = this.state.players.every((player) => Boolean(player.role));
    if (!everyoneHasRole || !hasAttacker || !hasPlayers) {
      this.state.phase = GAME_PHASES.ROLE_SELECT;
      return;
    }

    const attackerSetupSatisfied = this.isAttackerSetupSatisfied();
    if (!attackerSetupSatisfied) {
      this.state.phase = GAME_PHASES.ATTACKER_SETUP;
      this.countdownStartedAt = null;
      return;
    }

    const everyoneReady = this.state.players.every((player) => player.isReady);
    this.state.phase = everyoneReady ? GAME_PHASES.COUNTDOWN : GAME_PHASES.WAITING_READY;
    if (everyoneReady && !this.countdownStartedAt) {
      this.countdownStartedAt = Date.now();
    }
  }

  repositionRunners() {
    const runners = this.getPlayersByRole(ROLES.PLAYER);
    if (runners.length === 0) {
      return;
    }
    const layout = this.state.layout;
    const left = layout.spawnPadding;
    const right = layout.gameplayWidth - layout.spawnPadding;
    runners.forEach((player, index) => {
      const ratio = runners.length === 1 ? 0.5 : index / (runners.length - 1);
      player.x = left + (right - left) * ratio;
      if ((!player.isAlive && !player.isRespawning) || player.isGrounded) {
        const supportY = samplePlatformHeight(layout, player.x) ?? WORLD.platformY;
        player.y = supportY - WORLD.playerHeight / 2;
      }
    });
  }

  getRespawnSlotX(player) {
    const runners = this.getPlayersByRole(ROLES.PLAYER);
    const layout = this.state.layout;
    const index = Math.max(0, runners.findIndex((entry) => entry.id === player.id));
    const ratio = runners.length <= 1 ? 0.5 : index / (runners.length - 1);
    const left = layout.spawnPadding;
    const right = layout.gameplayWidth - layout.spawnPadding;
    return left + (right - left) * ratio;
  }

  findSafeRespawnX(player) {
    const layout = this.state.layout;
    const desiredX = this.getRespawnSlotX(player);
    const searchStep = layout.gameplayWidth * 0.035;
    const maxSteps = 12;
    const feetMargin = 0.02;

    for (let step = 0; step <= maxSteps; step += 1) {
      const offsets = step === 0 ? [0] : [-step * searchStep, step * searchStep];
      for (const offset of offsets) {
        const candidateX = clamp(
          desiredX + offset,
          layout.spawnPadding * 0.75,
          layout.gameplayWidth - layout.spawnPadding * 0.75
        );
        const supportY = samplePlatformHeight(layout, candidateX);
        if (supportY === null) {
          continue;
        }
        const waveTopY = sampleTerrainTopY(this.state.terrain, candidateX);
        const feetY = supportY;
        if (waveTopY > feetY + feetMargin) {
          return candidateX;
        }
      }
    }

    return desiredX;
  }

  respawnRunner(player) {
    const layout = this.state.layout;
    const x = this.findSafeRespawnX(player);
    const supportY = samplePlatformHeight(layout, x) ?? WORLD.platformY;
    player.x = x;
    player.y = supportY - WORLD.playerHeight / 2;
    player.vx = 0;
    player.vy = 0;
    player.isAlive = true;
    player.isGrounded = true;
    player.isRespawning = false;
    player.respawnAt = null;
    player.eliminatedAt = null;
    player.invincibleUntil = Date.now() + 800; // 800ms grace period after respawn
    player.jumpBufferTicks = 0;
    player.coyoteTicks = 0;
  }

  processRespawns(now) {
    this.getPlayersByRole(ROLES.PLAYER).forEach((player) => {
      if (player.isRespawning && player.respawnAt && now >= player.respawnAt) {
        this.respawnRunner(player);
      }
    });
  }

  eliminateRunner(player, cause, now = Date.now()) {
    player.deathCount += 1;
    player.livesRemaining = Math.max(0, player.livesRemaining - 1);
    player.lastDeathCause = cause;
    player.isAlive = false;
    player.isGrounded = false;
    player.eliminatedAt = now;
    player.vy = WORLD.knockoutJumpVelocity;
    const activeBand = Number.isInteger(this.state.terrain.activeBandIndex)
      ? this.state.terrain.bars[this.state.terrain.activeBandIndex] || null
      : null;
    if (activeBand) {
      player.vx = player.x < activeBand.centerX ? -WORLD.knockoutHorizontalVelocity : WORLD.knockoutHorizontalVelocity;
    } else if (Math.abs(player.vx) > 0.01) {
      player.vx = Math.sign(player.vx) * WORLD.knockoutHorizontalVelocity;
    } else {
      player.vx = player.x < this.state.layout.gameplayWidth / 2 ? -WORLD.knockoutHorizontalVelocity : WORLD.knockoutHorizontalVelocity;
    }

    if (player.livesRemaining > 0) {
      player.isRespawning = true;
      player.isEliminated = false;
      player.respawnAt = now + RESPAWN_DELAY_SECONDS * 1000;
      this.pushRecentEvent({
        playerId: player.id,
        kind: cause,
        message: `${player.name} ${cause === "wave" ? "hit the wave" : "fell off"} - ${player.livesRemaining} lives left`,
        createdAt: now
      });
      return;
    }

    player.isRespawning = false;
    player.isEliminated = true;
    player.respawnAt = null;
    this.pushRecentEvent({
      playerId: player.id,
      kind: "out",
      message: `${player.name} OUT`,
      createdAt: now
    });
  }

  resetRound() {
    const layout = this.state.layout;
    this.state.roundId = crypto.randomUUID();
    this.state.timeLeft = GAME_DURATION_SECONDS;
    this.state.countdownLeft = COUNTDOWN_SECONDS;
    this.state.winner = null;
    this.roundWinner = null;
    this.resultStartedAt = null;
    this.countdownStartedAt = null;
    this.targetAudio = {
      activeBandIndex: null,
      amplitude: 0,
      bandLevels: Array.from({ length: WORLD.eqBandCount }, () => 0),
      voiced: false
    };
    this.state.terrain = createIdleTerrain(layout);
    this.state.recentEvents = [];

    this.repositionRunners();
    this.getPlayersByRole(ROLES.PLAYER).forEach((player) => {
      player.isAlive = true;
      player.isRespawning = false;
      player.isEliminated = false;
      player.isGrounded = true;
      player.vx = 0;
      player.vy = 0;
      player.eliminatedAt = null;
      player.respawnAt = null;
      player.livesRemaining = RUNNER_LIVES;
      player.deathCount = 0;
      player.lastDeathCause = null;
      player.input = { left: false, right: false, jump: false };
      const supportY = samplePlatformHeight(layout, player.x) ?? WORLD.platformY;
      player.y = supportY - WORLD.playerHeight / 2;
    });

    this.getPlayersByRole(ROLES.ATTACKER).forEach((player) => {
      player.isAlive = true;
      player.isGrounded = false;
      player.vx = 0;
      player.vy = 0;
      player.isRespawning = false;
      player.isEliminated = false;
      player.respawnAt = null;
      player.livesRemaining = RUNNER_LIVES;
      player.deathCount = 0;
      player.lastDeathCause = null;
      player.x = layout.gameplayWidth - layout.spawnPadding * 0.4;
      player.y = 0.92;
    });
  }

  startRound() {
    this.state.phase = GAME_PHASES.PLAYING;
    this.resetRound();
  }

  finishRound(winner) {
    this.state.phase = GAME_PHASES.RESULT;
    this.state.winner = winner;
    this.roundWinner = winner;
    this.resultStartedAt = Date.now();
  }

  continueFromResult() {
    this.returnToRoleSelectAfterResult();
  }

  returnToRoleSelectAfterResult() {
    const layout = this.state.layout;
    this.state.players.forEach((player) => {
      player.isReady = false;
      player.role = null;
      player.isAlive = true;
      player.isGrounded = true;
      player.isRespawning = false;
      player.isEliminated = false;
      player.vx = 0;
      player.vy = 0;
      player.eliminatedAt = null;
      player.respawnAt = null;
      player.lastDeathCause = null;
      player.livesRemaining = RUNNER_LIVES;
      player.deathCount = 0;
      player.input = { left: false, right: false, jump: false };
    });
    this.state.roundId = crypto.randomUUID();
    this.state.phase = this.state.players.length > 0 ? GAME_PHASES.ROLE_SELECT : GAME_PHASES.LOBBY;
    this.state.winner = null;
    this.state.timeLeft = GAME_DURATION_SECONDS;
    this.state.countdownLeft = COUNTDOWN_SECONDS;
    this.resultStartedAt = null;
    this.countdownStartedAt = null;
    this.roundWinner = null;
    this.targetAudio = {
      activeBandIndex: null,
      amplitude: 0,
      bandLevels: Array.from({ length: WORLD.eqBandCount }, () => 0),
      voiced: false
    };
    this.state.terrain = createIdleTerrain(layout);
    this.state.attackerSetup = createAttackerSetup();
    this.state.recentEvents = [];
    this.repositionRunners();
  }

  tick() {
    const now = Date.now();
    const deltaSeconds = Math.min((now - this.lastTickAt) / 1000, (TICK_MS / 1000) * 3);
    this.lastTickAt = now;

    if (this.state.phase === GAME_PHASES.COUNTDOWN) {
      if (!this.countdownStartedAt) {
        this.countdownStartedAt = now;
      }
      const elapsed = (now - this.countdownStartedAt) / 1000;
      this.state.countdownLeft = Math.max(0, COUNTDOWN_SECONDS - elapsed);
      if (elapsed >= COUNTDOWN_SECONDS) {
        this.startRound();
      }
      return;
    }

    if (this.state.phase === GAME_PHASES.PLAYING) {
      this.updateTerrain();
      this.updatePlayers(deltaSeconds);
      this.processRespawns(now);
      this.pruneRecentEvents(now);
      this.state.timeLeft = Math.max(0, this.state.timeLeft - deltaSeconds);
      const activeRunners = this.getPlayersByRole(ROLES.PLAYER).filter((player) => !player.isEliminated);
      if (activeRunners.length === 0) {
        this.finishRound(ROLES.ATTACKER);
      } else if (this.state.timeLeft <= 0) {
        this.finishRound(ROLES.PLAYER);
      }
      return;
    }

    if (this.state.phase === GAME_PHASES.RESULT) {
      if (this.resultStartedAt && now - this.resultStartedAt >= RESULT_SECONDS * 1000) {
        this.returnToRoleSelectAfterResult();
      }
      return;
    }

    this.pruneRecentEvents(now);
    this.state.terrain.activeBandIndex = null;
    this.state.terrain.bars.forEach((bar) => {
      bar.targetHeight = WORLD.eqIdleFloor;
      bar.currentHeight = lerp(bar.currentHeight, WORLD.eqIdleFloor, WORLD.amplitudeRelease);
    });
  }

  updateTerrain() {
    this.state.terrain.activeBandIndex = this.targetAudio.voiced ? this.targetAudio.activeBandIndex : null;
    this.state.terrain.bars.forEach((bar) => {
      const target = this.targetAudio.voiced
        ? clamp((this.targetAudio.bandLevels[bar.index] || 0) * this.targetAudio.amplitude * WORLD.eqHeightMax, WORLD.eqIdleFloor, WORLD.eqHeightMax)
        : WORLD.eqIdleFloor;
      bar.targetHeight = target;
      const blend = target > bar.currentHeight ? WORLD.amplitudeAttack : WORLD.amplitudeRelease;
      bar.currentHeight = lerp(bar.currentHeight, target, blend);
    });
  }

  updatePlayers(deltaSeconds) {
    const terrain = this.state.terrain;
    const layout = this.state.layout;

    this.getPlayersByRole(ROLES.PLAYER).forEach((player) => {
      if (player.isEliminated) {
        player.vy += WORLD.gravity * deltaSeconds;
        player.y += player.vy * deltaSeconds;
        player.x += player.vx * deltaSeconds;
        return;
      }

      if (player.isRespawning) {
        player.vy += WORLD.gravity * deltaSeconds;
        player.y += player.vy * deltaSeconds;
        player.x += player.vx * deltaSeconds;
        return;
      }

      const wasGrounded = player.isGrounded;

      const direction = (player.input.right ? 1 : 0) - (player.input.left ? 1 : 0);
      if (direction !== 0) {
        player.vx += direction * WORLD.moveAcceleration * deltaSeconds;
      } else {
        player.vx *= player.isGrounded ? WORLD.frictionGround : WORLD.frictionAir;
      }

      const slopeDirection = player.isGrounded ? sampleSlopeDirection(layout, player.x) : 0;
      if (slopeDirection !== 0) {
        player.vx += slopeDirection * WORLD.slopeSlideAcceleration * deltaSeconds;
      }

      player.vx = clamp(player.vx, -layout.maxMoveSpeed, layout.maxMoveSpeed);

      // Jump buffer: fresh press while airborne stores intent for next landing
      const jumpJustPressed = player.input.jump && !player.prevJumpInput;
      player.prevJumpInput = player.input.jump;
      if (jumpJustPressed && !player.isGrounded) {
        player.jumpBufferTicks = 3; // ~150ms buffer window
      }

      // Execute jump with coyote time + buffer support
      const canJump = player.isGrounded || player.coyoteTicks > 0;
      const wantsJump = player.input.jump || player.jumpBufferTicks > 0;
      if (wantsJump && canJump) {
        player.vy = WORLD.jumpVelocity;
        player.isGrounded = false;
        player.coyoteTicks = 0;
        player.jumpBufferTicks = 0;
      }

      player.vy += WORLD.gravity * deltaSeconds;
      player.x = clamp(
        player.x + player.vx * deltaSeconds,
        -WORLD.playerWidth,
        layout.gameplayWidth + WORLD.playerWidth
      );
      player.y += player.vy * deltaSeconds;

      const feetY = player.y + WORLD.playerHeight / 2;
      const supportY = samplePlatformHeight(layout, player.x);
      if (supportY !== null && player.vy >= 0 && feetY >= supportY) {
        player.y = supportY - WORLD.playerHeight / 2;
        player.vy = 0;
        player.isGrounded = true;
      } else {
        player.isGrounded = false;
      }

      // Coyote time: walked off edge without jumping → brief jump window
      if (wasGrounded && !player.isGrounded) {
        player.coyoteTicks = 2; // ~100ms
      }
      if (!player.isGrounded) {
        if (player.jumpBufferTicks > 0) player.jumpBufferTicks--;
        if (player.coyoteTicks > 0) player.coyoteTicks--;
      }

      const footSampleXs = getRunnerFootSampleXs(player);
      const overlapsSpike = footSampleXs.some((sampleX) => {
        const hitBand = getBandAtX(terrain, sampleX);
        const waveTopY = sampleTerrainTopY(terrain, sampleX);
        return waveTopY <= feetY + 0.01 && (hitBand?.currentHeight || 0) > 0.015;
      });
      // Invincibility frames: ignore wave hits shortly after respawn
      if (overlapsSpike && Date.now() >= player.invincibleUntil) {
        this.eliminateRunner(player, "wave", Date.now());
        return;
      }

      if (player.x <= -0.05 || player.x >= layout.gameplayWidth + 0.05 || player.y >= 1.2) {
        this.eliminateRunner(player, "fall", Date.now());
      }
    });
  }

  serializePlayers({ includeInputs }) {
    const now = Date.now();
    return this.state.players.map((player) => {
      const payload = {
        id: player.id,
        sessionId: player.sessionId,
        name: player.name,
        color: player.color,
        role: player.role,
        x: player.x,
        y: player.y,
        vx: player.vx,
        vy: player.vy,
        isAlive: player.isAlive,
        isRespawning: player.isRespawning,
        isEliminated: player.isEliminated,
        isReady: player.isReady,
        isGrounded: player.isGrounded,
        livesRemaining: player.livesRemaining,
        deathCount: player.deathCount,
        eliminatedAt: player.eliminatedAt,
        respawnAt: player.respawnAt,
        lastDeathCause: player.lastDeathCause,
        faceSnapshot: this.getFreshFaceSnapshot(player, now)
      };
      if (includeInputs) {
        payload.input = { ...player.input };
      }
      return payload;
    });
  }

  serializeAttackerSetup() {
    return {
      ownerSessionId: this.state.attackerSetup.ownerSessionId,
      status: this.state.attackerSetup.status,
      skipped: this.state.attackerSetup.skipped,
      hasMicPermission: this.state.attackerSetup.hasMicPermission,
      environmentPreset: this.state.attackerSetup.environmentPreset,
      sensitivityPreset: this.state.attackerSetup.sensitivityPreset,
      noiseGate: this.state.attackerSetup.noiseGate,
      ceiling: this.state.attackerSetup.ceiling,
      expectedCoverage: this.state.attackerSetup.expectedCoverage,
      calibrationState: this.state.attackerSetup.calibrationState,
      lastRejectionReason: this.state.attackerSetup.lastRejectionReason,
      profileLowHz: this.state.attackerSetup.profileLowHz,
      profileHighHz: this.state.attackerSetup.profileHighHz,
      profileRangeHz: this.state.attackerSetup.profileRangeHz,
      lastAmplitudeNorm: this.state.attackerSetup.lastAmplitudeNorm,
      lastDominantBandIndex: this.state.attackerSetup.lastDominantBandIndex,
      lastDominantBandHz: this.state.attackerSetup.lastDominantBandHz,
      lastBandLevels: this.state.attackerSetup.lastBandLevels,
      voiced: this.state.attackerSetup.voiced
    };
  }

  getFullState({ includeInputs = true } = {}) {
    return {
      phase: this.state.phase,
      roomCode: this.state.roomCode,
      roundId: this.state.roundId,
      timeLeft: this.state.timeLeft,
      countdownLeft: this.state.countdownLeft,
      winner: this.state.winner,
      players: this.serializePlayers({ includeInputs }),
      terrain: {
        baselineY: this.state.terrain.baselineY,
        platformY: this.state.terrain.platformY,
        activeBandIndex: this.state.terrain.activeBandIndex,
        bandCount: this.state.terrain.bandCount,
        bars: this.state.terrain.bars.map((bar) => ({ ...bar }))
      },
      attackerSetup: this.serializeAttackerSetup(),
      recentEvents: this.state.recentEvents.map((event) => ({ ...event })),
      layout: { ...this.state.layout },
      viewportPolicy: { ...this.state.viewportPolicy },
      qrCodeDataUrl: this.state.qrCodeDataUrl
    };
  }

  getDeltaState({ includeInputs = true } = {}) {
    return {
      phase: this.state.phase,
      roomCode: this.state.roomCode,
      roundId: this.state.roundId,
      timeLeft: this.state.timeLeft,
      countdownLeft: this.state.countdownLeft,
      winner: this.state.winner,
      players: this.serializePlayers({ includeInputs }),
      terrain: {
        baselineY: this.state.terrain.baselineY,
        platformY: this.state.terrain.platformY,
        activeBandIndex: this.state.terrain.activeBandIndex,
        bandCount: this.state.terrain.bandCount,
        bars: this.state.terrain.bars.map((bar) => ({ ...bar }))
      },
      attackerSetup: this.serializeAttackerSetup(),
      recentEvents: this.state.recentEvents.map((event) => ({ ...event }))
    };
  }
}
