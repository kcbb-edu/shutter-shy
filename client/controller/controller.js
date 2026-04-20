import { AUDIO, CLIENT_TYPES, FACE_UPLOAD_TARGET_MS, GAME_PHASES, MAX_FACE_SNAPSHOT_BYTES, MSG_TYPES, ROLES, RUNNER_LIVES, WORLD, normalizeRoomCode } from "/shared/protocol.js";
import { buildLocalResultOverlay, closeHighlightOverlay, createHiddenHighlightOverlay, normalizeHighlightPayload } from "/shared/highlightOverlay.js";
import { getLogBandRangeForIndex } from "/shared/utils.js";
import { createDefaultSpectrumProfile, computeSpectrumFrame, smoothBandPosition, stabilizeSpectrumFrame, updateSpectrumProfile } from "./spectrumControl.js";

const socketUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
const RECENT_ROOM_KEY = "waveform-attack:recent-room";
const NAME_KEY = "waveform-attack:player-name";
const MEDIAPIPE_TASKS_VISION_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/vision_bundle.mjs";
const MEDIAPIPE_WASM_ROOT = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm";
const MEDIAPIPE_FACE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
const diagnosticsEnabled = new URLSearchParams(location.search).get("pitchDebug") === "1";

let _detectorInitPromise = null;

const PITCH_RMS_GATE = 0.018;
const AMP_ATTACK_SMOOTH = 0.5;        // amplitude envelope — fast attack
const AMP_RELEASE_SMOOTH = 0.08;      // amplitude envelope — slow release

const RANDOM_NAMES = [
  "超級無敵蘋果", "會飛的恐龍", "嗷嗷叫的蘑菇", "不怕熱的冰淇淋",
  "超強的洋蔥", "閃光的土豆", "愛吃糖的獅子", "跑太快的烏龜",
  "噴火的布丁", "最強的棉花糖", "叫不醒的企鵝", "亂亂叫的仙人掌",
  "偷吃魚的貓熊", "夢遊的章魚", "超厲害的香蕉"
];

const dom = {
  roomCode: document.getElementById("room-code"),
  roomCodeHero: document.getElementById("room-code-hero"),
  roomInput: document.getElementById("room-input"),
  useRecentRoom: document.getElementById("use-recent-room"),
  changeRoomButton: document.getElementById("change-room-button"),
  globalStatus: document.getElementById("global-status"),
  reconnectBanner: document.getElementById("reconnect-banner"),
  reconnectCopy: document.getElementById("reconnect-copy"),
  roomResetBanner: document.getElementById("room-reset-banner"),
  roomResetCopy: document.getElementById("room-reset-copy"),
  roomResetRejoin: document.getElementById("room-reset-rejoin"),
  joinScreen: document.getElementById("join-screen"),
  roleScreen: document.getElementById("role-screen"),
  attackerSetupScreen: document.getElementById("attacker-setup-screen"),
  playerScreen: document.getElementById("player-screen"),
  waitingScreen: document.getElementById("waiting-screen"),
  attackerScreen: document.getElementById("attacker-screen"),
  shareCard: document.getElementById("share-card"),
  joinButton: document.getElementById("join-button"),
  nameInput: document.getElementById("name-input"),
  joinStatus: document.getElementById("join-status"),
  actionBar: document.getElementById("action-bar"),
  roleStatus: document.getElementById("role-status"),
  readyButton: document.getElementById("ready-button"),
  readyBar: document.getElementById("ready-bar"),
  runnerReadyBarSlot: document.getElementById("runner-ready-bar-slot"),
  attackerReadyBarSlot: document.getElementById("attacker-ready-bar-slot"),
  playerPhase: document.getElementById("player-phase"),
  playerTimer: document.getElementById("player-timer"),
  runnerLives: document.getElementById("runner-lives"),
  runnerDeathCause: document.getElementById("runner-death-cause"),
  runnerRespawnStatus: document.getElementById("runner-respawn-status"),
  shareGallery: document.getElementById("share-gallery"),
  shareCopy: document.getElementById("share-copy"),
  galleryContinue: document.getElementById("gallery-continue"),
  micButton: document.getElementById("mic-button"),
  micStatus: document.getElementById("mic-status"),
  environmentSelect: document.getElementById("environment-select"),
  sensitivitySelect: document.getElementById("sensitivity-select"),
  gateSlider: document.getElementById("gate-slider"),
  gateValue: document.getElementById("gate-value"),
  ceilingSlider: document.getElementById("ceiling-slider"),
  ceilingValue: document.getElementById("ceiling-value"),
  bandSummary: document.getElementById("band-summary"),
  frequencyReadout: document.getElementById("frequency-readout"),
  spikeSummary: document.getElementById("spike-summary"),
  tipSummary: document.getElementById("tip-summary"),
  summaryLow: document.getElementById("summary-low"),
  summaryHigh: document.getElementById("summary-high"),
  summaryCoverage: document.getElementById("summary-coverage"),
  waitingRoomCode: document.getElementById("waiting-room-code"),
  eqPreview: document.getElementById("eq-preview"),
  eqLive: document.getElementById("eq-live"),
  cameraSection: document.getElementById("camera-setup-section"),
  runnerCameraSlot: document.getElementById("runner-camera-slot"),
  attackerCameraSlot: document.getElementById("attacker-camera-slot"),
  cameraToggle: document.getElementById("camera-toggle"),
  cameraButton: document.getElementById("camera-button"),
  cameraPreviewWrap: document.getElementById("camera-preview-wrap"),
  cameraPreview: document.getElementById("camera-preview"),
  faceCropPreview: document.getElementById("face-crop-preview"),
  cameraStatus: document.getElementById("camera-status"),
  roleButtons: [...document.querySelectorAll("[data-role]")],
  controlButtons: [...document.querySelectorAll("[data-action]")],
  randomNameButton: document.getElementById("random-name-button"),
  micVisual: document.getElementById("mic-visual"),
  deathPopup: document.getElementById("death-popup"),
  deathPopupCause: document.getElementById("death-popup-cause"),
  deathPopupRespawn: document.getElementById("death-popup-respawn"),
  pitchDiagnostics: document.getElementById("pitch-diagnostics"),
  diagnosticFrequency: document.getElementById("diag-frequency"),
  diagnosticRms: document.getElementById("diag-rms"),
  diagnosticBasePitch: document.getElementById("diag-base-pitch"),
  diagnosticRange: document.getElementById("diag-range"),
  diagnosticMapped: document.getElementById("diag-mapped"),
  diagnosticVirtualHz: document.getElementById("diag-virtual-hz"),
  diagnosticValidity: document.getElementById("diag-validity"),
  diagnosticSamples: document.getElementById("diag-samples"),
  diagnosticMarkerButtons: [...document.querySelectorAll("[data-diag-marker]")],
  replayRecordButton: document.getElementById("replay-record-button"),
  replayStopButton: document.getElementById("replay-stop-button"),
  replayAnalyzeButton: document.getElementById("replay-analyze-button"),
  replayFileInput: document.getElementById("replay-file-input"),
  replayAudio: document.getElementById("replay-audio"),
  replayStatus: document.getElementById("replay-status"),
  replayFrameStatus: document.getElementById("replay-frame-status"),
  replayProfileStatus: document.getElementById("replay-profile-status"),
  replayMeter: document.getElementById("replay-meter"),
  replayLog: document.getElementById("replay-log"),
  runnerReadyScreen: document.getElementById("runner-ready-screen"),
  runnerReadyBack: document.getElementById("runner-ready-back"),
  attackerSetupBack: document.getElementById("attacker-setup-back"),
  roleAttackerNotice: document.getElementById("role-attacker-notice"),
  topbarPlayerName: document.getElementById("topbar-player-name"),
  topbarRoleEmoji: document.getElementById("topbar-role-emoji"),
  topbarRoomCode: document.getElementById("topbar-room-code")
};

const state = {
  socket: null,
  reconnectTimer: null,
  reconnectAttempts: 0,
  wantsJoin: false,
  joinPending: false,
  roomCode: normalizeRoomCode(new URLSearchParams(location.search).get("room") || localStorage.getItem(RECENT_ROOM_KEY) || ""),
  playerName: localStorage.getItem(NAME_KEY) || "",
  sessionId: "",
  playerId: null,
  room: null,
  game: null,
  self: null,
  joinSkipRoundId: null,
  joinSkipRoundPending: false,
  activeView: "join",
  roomClosedNotice: {
    visible: false,
    roomCode: ""
  },
  highlightOverlay: {
    ...createHiddenHighlightOverlay()
  },
  lastAutoOverlayRoundId: null,
  viewOverride: null,
  localInput: {
    left: false,
    right: false,
    jump: false
  },
  audio: {
    context: null,
    analyser: null,
    stream: null,
    timeSampleBuffer: null,
    frequencyDataBuffer: null,
    enabled: false,
    rafId: 0,
    lastSentAt: 0,
    latestDominantHz: null,
    latestDominantBandHz: null,
    latestDominantBandIndex: null,
    latestBandLevels: Array.from({ length: WORLD.eqBandCount }, () => 0),
    latestControlLevels: Array.from({ length: WORLD.eqBandCount }, () => 0),
    stableBandLevels: Array.from({ length: WORLD.eqBandCount }, () => 0),
    smoothedBandPosition: null,
    latestRms: 0,
    latestRejectionReason: null,
    profile: createDefaultSpectrumProfile(),
    voiced: false,
    isStrong: false,
    voicedHoldUntil: 0,
    amplitudeSmooth: 0,     // envelope-smoothed amplitude [0,1]
    hasAutoReadied: false,
    miniLog: []   // [{t, dominantHz, bandIndex, voiced}] — last 5
  },
  diagnostics: {
    enabled: diagnosticsEnabled,
    trace: [],
    lastTraceAt: 0
  },
  replayLab: {
    stream: null,
    recorder: null,
    chunks: [],
    audioUrl: "",
    analysisContext: null,
    analysisSource: null,
    analyser: null,
    timeBuffer: null,
    frequencyBuffer: null,
    rafId: 0,
    amplitudeSmooth: 0,
    profile: createDefaultSpectrumProfile(),
    stableBandLevels: Array.from({ length: WORLD.eqBandCount }, () => 0),
    smoothedBandPosition: null,
    voicedHoldUntil: 0,
    frames: [],
    currentFrame: null,
    status: "尚未錄音"
  },
  camera: {
    stream: null,
    enabled: false,
    panelExpanded: false,
    videoReady: false,
    rafId: 0,
    lastSentAt: 0,
    uploadInFlight: false,
    detectInFlight: false,
    error: "",
    detector: undefined,
    detectorModule: null,
    detectorResult: null,
    lastFaceCrop: null,
    trackingMode: "pending",
    lastDetectAt: 0,
    initError: "",
    captureCanvas: document.createElement("canvas")
  }
};

function pushDiagnosticSample(sample) {
  if (!state.diagnostics.enabled) {
    return;
  }
  state.diagnostics.trace.unshift(sample);
  state.diagnostics.trace = state.diagnostics.trace.slice(0, 8);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(current, target, factor) {
  return current + (target - current) * factor;
}

function mapAmplitudeNormFromRms(rms) {
  const rawAmpNorm = clamp((rms - AUDIO.minAmplitude) / Math.max(AUDIO.maxAmplitude - AUDIO.minAmplitude, 0.01), 0, 1);
  return Math.min(1, Math.pow(rawAmpNorm * 2.8, 0.58));
}

function formatDiagHz(value) {
  return Number.isFinite(value) ? `${Math.round(value)} Hz` : "—";
}

function formatDiagPercent(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : "—";
}

// Returns true once the mic is on (adaptive system is ready immediately).

function resetSpectrumState({ preserveMic = true, preserveProfile = false } = {}) {
  const retainedProfile = preserveProfile && state.audio.profile
    ? {
        lowHz: state.audio.profile.lowHz,
        highHz: state.audio.profile.highHz,
        samples: Array.isArray(state.audio.profile.samples) ? [...state.audio.profile.samples] : [],
        ready: Boolean(state.audio.profile.ready)
      }
    : createDefaultSpectrumProfile();
  state.audio.latestDominantHz = null;
  state.audio.latestDominantBandHz = null;
  state.audio.latestDominantBandIndex = null;
  state.audio.latestBandLevels = Array.from({ length: WORLD.eqBandCount }, () => 0);
  state.audio.latestControlLevels = Array.from({ length: WORLD.eqBandCount }, () => 0);
  state.audio.stableBandLevels = Array.from({ length: WORLD.eqBandCount }, () => 0);
  state.audio.smoothedBandPosition = null;
  state.audio.latestRms = 0;
  state.audio.latestRejectionReason = null;
  state.audio.profile = retainedProfile;
  state.audio.voiced = false;
  state.audio.voicedHoldUntil = 0;
  state.audio.amplitudeSmooth = 0;
  state.audio.hasAutoReadied = false;
  if (preserveMic && state.audio.enabled) {
    applyAttackerSetup();
  }
}

function getSessionStorageKey(roomCode) {
  return `waveform-attack:${roomCode}:session`;
}

function ensureSessionId(roomCode) {
  const existing = localStorage.getItem(getSessionStorageKey(roomCode));
  if (existing) {
    return existing;
  }
  const created = crypto.randomUUID();
  localStorage.setItem(getSessionStorageKey(roomCode), created);
  return created;
}

function syncUrl(roomCode) {
  const url = new URL(location.href);
  if (roomCode) {
    url.searchParams.set("room", roomCode);
  } else {
    url.searchParams.delete("room");
  }
  history.replaceState({}, "", url);
}

function assignRoom(roomCode, { persist = false } = {}) {
  state.roomCode = normalizeRoomCode(roomCode);
  state.sessionId = state.roomCode ? ensureSessionId(state.roomCode) : "";
  syncUrl(state.roomCode);
  if (persist && state.roomCode) {
    localStorage.setItem(RECENT_ROOM_KEY, state.roomCode);
  }
  renderRoomLabels();
}

function setStatus(element, message) {
  if (element) {
    element.textContent = message;
  }
}

function send(type, payload = {}) {
  if (state.socket?.readyState !== WebSocket.OPEN) {
    return;
  }
  state.socket.send(JSON.stringify({ type, payload }));
}

async function requestRawAudioStream() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
  } catch {
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }
}

function releaseLocalInputs() {
  state.localInput.left = false;
  state.localInput.right = false;
  state.localInput.jump = false;
}

function getCameraLabel(self) {
  if (!self?.role) {
    return "可選：開啟相機在大螢幕上顯示你的臉！";
  }
  if (state.camera.error) {
    return state.camera.error;
  }
  if (state.camera.initError) {
    return state.camera.initError;
  }
  if (state.camera.enabled && state.camera.trackingMode === "lost") {
    return "臉部追蹤遺失，使用上次裁切。";
  }
  if (state.camera.enabled && state.camera.trackingMode === "fallback") {
    return "臉部追蹤不可用，使用中心裁切。";
  }
  if (state.camera.enabled) {
    return "臉部追蹤中。";
  }
  return "可選：開啟相機在大螢幕上顯示你的臉！";
}

function renderControlStates() {
  dom.controlButtons.forEach((button) => {
    const action = button.dataset.action;
    const pressed = Boolean(state.localInput[action]);
    button.dataset.state = pressed ? "pressed" : "idle";
  });
}

function openSocket() {
  if (state.socket && state.socket.readyState <= WebSocket.OPEN) {
    return;
  }

  const socket = new WebSocket(socketUrl);
  state.socket = socket;

  socket.addEventListener("open", () => {
    state.reconnectAttempts = 0;
    if (!state.wantsJoin) {
      return;
    }
    state.joinPending = true;
    sendHello();
    render();
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);

    if (message.type === MSG_TYPES.UI_STATE) {
      const wasJoined = Boolean(state.playerId);
      state.room = message.payload.room;
      state.self = message.payload.self;
      state.playerId = state.self?.playerId || null;
      assignRoom(message.payload.room.roomCode, { persist: true });
      if (!wasJoined && state.playerId) {
        state.joinSkipRoundId = state.game?.roundId ?? null;
        state.joinSkipRoundPending = state.game?.roundId == null;
      }
      state.joinPending = false;
      state.roomClosedNotice = { visible: false, roomCode: "" };
      render();
      return;
    }

    if (message.type === MSG_TYPES.GAME_STATE) {
      const previousRoundId = state.game?.roundId || null;
      if (message.payload.snapshotKind === "full" || !state.game) {
        state.game = message.payload.game;
      } else {
        const incoming = message.payload.game;
        state.game = {
          ...state.game,
          ...incoming,
          players: incoming.players || state.game.players,
          terrain: {
            ...state.game.terrain,
            ...incoming.terrain
          },
          attackerSetup: {
            ...state.game.attackerSetup,
            ...incoming.attackerSetup
          },
          recentEvents: incoming.recentEvents || state.game.recentEvents
        };
      }
      if (state.audio.enabled && previousRoundId && state.game?.roundId && previousRoundId !== state.game.roundId) {
        resetSpectrumState({ preserveMic: true, preserveProfile: true });
      }
      if (state.joinSkipRoundPending && state.game?.roundId) {
        state.joinSkipRoundId = state.game.roundId;
        state.joinSkipRoundPending = false;
      }
      render();
      return;
    }

    if (message.type === MSG_TYPES.HIGHLIGHTS) {
      state.highlightOverlay = normalizeHighlightPayload(message.payload);
      render();
      return;
    }

    if (message.type === MSG_TYPES.ROOM_ERROR) {
      state.joinPending = false;
      setStatus(dom.joinStatus, message.payload?.message || "Unable to join room.");
      setStatus(dom.globalStatus, message.payload?.message || "Room error.");
      render();
      return;
    }

    if (message.type === MSG_TYPES.ROOM_CLOSED) {
      handleRoomClosed(message.payload || {});
    }
  });

  socket.addEventListener("close", () => {
    if (state.socket === socket) {
      state.socket = null;
    }
    releaseLocalInputs();
    renderControlStates();
    if (!state.wantsJoin || document.visibilityState === "hidden") {
      return;
    }
    const delay = Math.min(1000 * 2 ** state.reconnectAttempts, 5000);
    state.reconnectAttempts += 1;
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(openSocket, delay);
    render();
  });

  socket.addEventListener("error", () => {
    socket.close();
  });
}

function sendHello() {
  if (!state.roomCode) {
    return;
  }
  send(MSG_TYPES.HELLO, {
    clientType: CLIENT_TYPES.CONTROLLER,
    roomCode: state.roomCode,
    name: state.playerName,
    sessionId: state.sessionId
  });
}

function closeSocket() {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  state.socket?.close();
  state.socket = null;
}

function resetMembership() {
  state.playerId = null;
  state.room = null;
  state.game = null;
  state.self = null;
  state.joinPending = false;
  state.joinSkipRoundId = null;
  state.joinSkipRoundPending = false;
  state.lastAutoOverlayRoundId = null;
  state.highlightOverlay = createHiddenHighlightOverlay();
  releaseLocalInputs();
}

function handleRoomClosed(payload) {
  const nextRoomCode = normalizeRoomCode(payload.replacementRoomCode || "");
  resetMembership();
  stopMicrophone();
  stopCamera();
  state.roomClosedNotice = {
    visible: Boolean(nextRoomCode),
    roomCode: nextRoomCode
  };
  if (nextRoomCode) {
    assignRoom(nextRoomCode, { persist: true });
  }
  state.wantsJoin = false;
  setStatus(
    dom.joinStatus,
    nextRoomCode ? `房間移至 ${nextRoomCode}。準備好了可以重新加入。` : "大螢幕已關閉房間。"
  );
  render();
}

function joinRoom() {
  const roomCode = normalizeRoomCode(dom.roomInput.value);
  const playerName = dom.nameInput.value.trim().slice(0, 20);
  if (!roomCode) {
    setStatus(dom.joinStatus, "請輸入房號。");
    return;
  }
  if (!playerName) {
    setStatus(dom.joinStatus, "請輸入你的名字。");
    return;
  }

  state.playerName = playerName;
  localStorage.setItem(NAME_KEY, playerName);
  assignRoom(roomCode, { persist: true });
  state.wantsJoin = true;
  state.joinPending = true;
  openSocket();
  if (state.socket?.readyState === WebSocket.OPEN) {
    sendHello();
  }
  render();
}

function leaveRoom() {
  send(MSG_TYPES.LEAVE);
  state.wantsJoin = false;
  resetMembership();
  stopMicrophone();
  stopCamera();
  closeSocket();
  render();
}

function rejoinReplacementRoom() {
  if (!state.roomClosedNotice.roomCode) {
    return;
  }
  assignRoom(state.roomClosedNotice.roomCode, { persist: true });
  state.roomClosedNotice = { visible: false, roomCode: "" };
  state.wantsJoin = true;
  state.joinPending = true;
  openSocket();
  if (state.socket?.readyState === WebSocket.OPEN) {
    sendHello();
  }
  render();
}

function getSelfPlayer() {
  return state.game?.players.find((player) => player.id === state.playerId) || null;
}

function ensureResultOverlay() {
  if (!state.game || state.game.phase !== GAME_PHASES.RESULT) {
    return;
  }
  if (state.game.roundId === state.joinSkipRoundId) {
    return;
  }
  if (state.highlightOverlay.roundId === state.game.roundId && state.highlightOverlay.open) {
    return;
  }
  if (state.lastAutoOverlayRoundId === state.game.roundId) {
    return;
  }
  state.lastAutoOverlayRoundId = state.game.roundId;
  state.highlightOverlay = buildLocalResultOverlay(state.game);
}

function deriveActiveView() {
  if (!state.wantsJoin || !state.playerId || !state.game) {
    return "join";
  }

  const self = getSelfPlayer();
  if (!self) {
    return "join";
  }

  const preGame =
    state.game.phase === GAME_PHASES.ATTACKER_SETUP ||
    state.game.phase === GAME_PHASES.WAITING_READY;

  if (!preGame) {
    state.viewOverride = null;
  }

  if (!self.role) {
    return "role";
  }

  if (state.viewOverride === "role" && preGame) {
    return "role";
  }

  if (self.role === ROLES.ATTACKER) {
    return state.game.phase === GAME_PHASES.PLAYING ? "attackerPlay" : "attackerSetup";
  }

  if (state.game.phase === GAME_PHASES.PLAYING) {
    return self.isEliminated ? "runnerWaiting" : "runnerPlay";
  }

  return "runnerReady";
}

function renderRoomLabels() {
  const roomCode = state.roomCode || "----";
  dom.roomCode.textContent = roomCode;
  dom.roomCodeHero.textContent = roomCode;
  dom.waitingRoomCode.textContent = roomCode;
  if (document.activeElement !== dom.roomInput) {
    dom.roomInput.value = state.roomCode;
  }
  const recentRoom = normalizeRoomCode(localStorage.getItem(RECENT_ROOM_KEY) || "");
  const showRecent = Boolean(recentRoom && recentRoom !== state.roomCode);
  dom.useRecentRoom.classList.toggle("hidden", !showRecent);
  if (showRecent) {
    dom.useRecentRoom.textContent = `使用最近房間 ${recentRoom}`;
  }
}

function formatPhaseLabel(phase) {
  switch (phase) {
    case GAME_PHASES.LOBBY:
      return "大廳";
    case GAME_PHASES.ROLE_SELECT:
      return "選角";
    case GAME_PHASES.ATTACKER_SETUP:
      return "魔王設定";
    case GAME_PHASES.WAITING_READY:
      return "等待準備";
    case GAME_PHASES.COUNTDOWN:
      return "倒數";
    case GAME_PHASES.PLAYING:
      return "進行中";
    case GAME_PHASES.RESULT:
      return "結果";
    default:
      return phase || "--";
  }
}

function localizeOverlaySummary(summary = "") {
  return String(summary)
    .replace("Attacker wins this round.", "這回合由聲波大魔王獲勝。")
    .replace("Runners survive this round.", "這回合由小勇者撐到最後。")
    .replace("Round complete.", "回合結束。")
    .replace("No major events were recorded this round.", "這回合沒有特別事件。");
}

function moveSharedPrepPanels() {
  const cameraTarget = state.activeView === "attackerSetup" ? dom.attackerCameraSlot : dom.runnerCameraSlot;
  if (cameraTarget && dom.cameraSection.parentElement !== cameraTarget) {
    cameraTarget.appendChild(dom.cameraSection);
  }

  const readyTarget = state.activeView === "attackerSetup" ? dom.attackerReadyBarSlot : dom.runnerReadyBarSlot;
  if (readyTarget && dom.readyBar.parentElement !== readyTarget) {
    readyTarget.appendChild(dom.readyBar);
  }
}

function renderCameraSection(self) {
  const shouldShow =
    Boolean(self?.role) &&
    (state.activeView === "runnerReady" || state.activeView === "attackerSetup") &&
    !state.highlightOverlay.open;
  if (shouldShow) {
    moveSharedPrepPanels();
  }
  dom.cameraSection.classList.toggle("hidden", !shouldShow);
  if (!shouldShow) {
    return;
  }
  dom.cameraSection.dataset.collapsed = state.camera.panelExpanded ? "false" : "true";
  dom.cameraToggle.textContent = state.camera.panelExpanded ? "收起面板" : "展開面板";
  dom.cameraButton.textContent = state.camera.enabled ? "關閉臉部貼紙" : "開啟臉部貼紙";
  dom.cameraPreviewWrap.classList.toggle("hidden", !state.camera.panelExpanded);
  dom.cameraPreview.classList.toggle("hidden", !state.camera.enabled);
  dom.faceCropPreview.classList.toggle("hidden", !state.camera.enabled);
  setStatus(dom.cameraStatus, getCameraLabel(self));
}

function formatTimer(game) {
  if (!game) {
    return "--";
  }
  if (game.phase === GAME_PHASES.COUNTDOWN) {
    return `${Math.ceil(game.countdownLeft)}`;
  }
  return `${game.timeLeft.toFixed(1)} 秒`;
}

function formatLives(self) {
  if (!self) {
    return "♥♥♥";
  }
  if (self.isEliminated) {
    return "出局";
  }
  return Array.from({ length: RUNNER_LIVES }, (_, index) => (index < self.livesRemaining ? "♥" : "♡")).join("");
}

function formatFrequency(value) {
  if (!Number.isFinite(value)) {
    return "未偵測到主頻段";
  }
  return `${Math.round(value)} Hz`;
}

function createPreviewBars() {
  return Array.from({ length: 12 }, (_, index) => ({
    index,
    currentHeight: 0,
    width: index === 0 || index === 11 ? 1.38 : index === 1 || index === 10 ? 1.08 : 1
  }));
}

function buildEqPreviewState() {
  const setup = state.game?.attackerSetup;
  const activeBandIndex = state.audio.enabled
    ? state.audio.latestDominantBandIndex
    : (setup?.lastDominantBandIndex ?? null);
  const bars = createPreviewBars();
  const levels = state.audio.enabled
    ? state.audio.latestBandLevels
    : (Array.isArray(setup?.lastBandLevels) ? setup.lastBandLevels : bars.map(() => 0));
  bars.forEach((bar, index) => {
    bar.currentHeight = Math.max(0, Math.min(1, levels[index] || 0)) * WORLD.eqHeightMax;
  });
  return {
    bars,
    activeBandIndex,
    isNoise: state.audio.enabled && state.audio.voiced && !state.audio.isStrong,
    profileRangeHz: state.audio.enabled
      ? { lowHz: state.audio.profile.lowHz, highHz: state.audio.profile.highHz }
      : (setup?.profileRangeHz || null)
  };
}

function ensureEqBars(container, count) {
  if (!container) {
    return [];
  }
  if (container.children.length !== count) {
    container.innerHTML = "";
    for (let index = 0; index < count; index += 1) {
      const bar = document.createElement("div");
      bar.className = "eq-bar";
      bar.dataset.index = String(index);
      bar.dataset.edge = index === 0 || index === count - 1 ? "true" : "false";
      bar.dataset.nearEdge = index === 1 || index === count - 2 ? "true" : "false";
      const fill = document.createElement("div");
      fill.className = "eq-bar-fill";
      bar.appendChild(fill);
      container.appendChild(bar);
    }
  }
  return [...container.children];
}

function renderEqBars(container, terrain) {
  if (!container || !terrain?.bars?.length) {
    return;
  }
  const bars = ensureEqBars(container, terrain.bars.length);
  const isNoise = Boolean(terrain.isNoise);
  bars.forEach((element, index) => {
    const source = terrain.bars[index];
    const fill = element.firstElementChild;
    const normalized = Math.max(0, Math.min(1, (source.currentHeight || 0) / Math.max(WORLD.eqHeightMax, 0.0001)));
    fill.style.height = `${Math.max(8, Math.round(normalized * 100))}%`;
    element.dataset.active = source.index === terrain.activeBandIndex ? "true" : "false";
    element.dataset.neighbor = Number.isInteger(terrain.activeBandIndex) && Math.abs(source.index - terrain.activeBandIndex) === 1 ? "true" : "false";
    element.dataset.noise = isNoise ? "true" : "false";
  });
}

function buildReplayTerrain(frame) {
  const bars = createPreviewBars();
  const levels = Array.isArray(frame?.levels) ? frame.levels : bars.map(() => 0);
  bars.forEach((bar, index) => {
    bar.currentHeight = Math.max(0, Math.min(1, levels[index] || 0)) * WORLD.eqHeightMax;
  });
  return {
    bars,
    activeBandIndex: Number.isInteger(frame?.bandIndex) ? frame.bandIndex : null
  };
}

function buildControlBandLevelsFromIndex(bandIndex) {
  return Array.from({ length: WORLD.eqBandCount }, (_, index) => {
    const distance = Math.abs(index - bandIndex);
    if (distance === 0) {
      return 1;
    }
    if (distance === 1) {
      return WORLD.eqNeighborDecay;
    }
    return 0;
  });
}

function getBandCenterHz(bandIndex, lowHz, highHz) {
  if (!Number.isInteger(bandIndex)) {
    return null;
  }
  const range = getLogBandRangeForIndex(bandIndex, lowHz, highHz, WORLD.eqBandCount);
  return range ? (range.startHz + range.endHz) / 2 : null;
}

function applySilentAmplitudeClamp(currentAmplitude, voiced) {
  if (voiced) {
    return currentAmplitude;
  }
  return currentAmplitude * 0.28;
}

function renderReplayLab() {
  if (!dom.replayStatus || !dom.replayFrameStatus || !dom.replayProfileStatus || !dom.replayLog) {
    return;
  }
  dom.replayStatus.textContent = state.replayLab.status;
  dom.replayFrameStatus.textContent = state.replayLab.currentFrame
    ? `${state.replayLab.currentFrame.index + 1} / ${state.replayLab.frames.length}`
    : (state.replayLab.frames.length > 0 ? `0 / ${state.replayLab.frames.length}` : "—");
  dom.replayProfileStatus.textContent = `${Math.round(state.replayLab.profile.lowHz)}–${Math.round(state.replayLab.profile.highHz)} Hz`;
  renderEqBars(dom.replayMeter, buildReplayTerrain(state.replayLab.currentFrame));
  dom.replayLog.innerHTML = state.replayLab.frames.length > 0
    ? state.replayLab.frames
        .slice(-18)
        .reverse()
        .map((frame) => {
          const dominant = Number.isFinite(frame.dominantBandHz) ? `${Math.round(frame.dominantBandHz)} Hz` : "—";
          return `<div class="diagnostic-sample">#${frame.index + 1} · ${frame.voiced ? "voiced" : "silent"} · band ${Number.isInteger(frame.bandIndex) ? frame.bandIndex + 1 : "—"} · center ${dominant} · amp ${frame.amplitudeNorm.toFixed(2)} · rms ${frame.rms.toFixed(4)} · levels ${frame.levels.map((level) => Math.round(level * 9)).join("")}</div>`;
        })
        .join("")
    : '<div class="diagnostic-sample">錄一段聲音或匯入音檔後，按「回放分析」。</div>';
}

function setReplayStatus(message) {
  state.replayLab.status = message;
  renderReplayLab();
}

function clearReplayAudioUrl() {
  if (!state.replayLab.audioUrl) {
    return;
  }
  URL.revokeObjectURL(state.replayLab.audioUrl);
  state.replayLab.audioUrl = "";
}

function teardownReplayAnalysis() {
  cancelAnimationFrame(state.replayLab.rafId);
  state.replayLab.rafId = 0;
  if (state.replayLab.analysisSource) {
    state.replayLab.analysisSource.disconnect();
    state.replayLab.analysisSource = null;
  }
  state.replayLab.analyser = null;
  state.replayLab.timeBuffer = null;
  state.replayLab.frequencyBuffer = null;
  if (state.replayLab.analysisContext) {
    state.replayLab.analysisContext.close().catch(() => {});
    state.replayLab.analysisContext = null;
  }
}

function stopReplayAnalysis({ keepFrame = true } = {}) {
  teardownReplayAnalysis();
  dom.replayAudio?.pause();
  if (dom.replayAudio) {
    dom.replayAudio.onended = null;
  }
  if (!keepFrame) {
    state.replayLab.currentFrame = null;
  }
}

function resetReplayFrames() {
  state.replayLab.frames = [];
  state.replayLab.currentFrame = null;
  state.replayLab.profile = createDefaultSpectrumProfile();
  state.replayLab.amplitudeSmooth = 0;
  state.replayLab.stableBandLevels = Array.from({ length: WORLD.eqBandCount }, () => 0);
  state.replayLab.smoothedBandPosition = null;
  state.replayLab.voicedHoldUntil = 0;
}

function setReplayAudioBlob(blob, label = "已載入錄音") {
  stopReplayAnalysis({ keepFrame: false });
  clearReplayAudioUrl();
  const nextUrl = URL.createObjectURL(blob);
  state.replayLab.audioUrl = nextUrl;
  dom.replayAudio.src = nextUrl;
  dom.replayAudio.load();
  resetReplayFrames();
  setReplayStatus(`${label}，可回放分析`);
}

function stopReplayRecording() {
  const recorder = state.replayLab.recorder;
  if (!recorder) {
    return;
  }
  if (recorder.state !== "inactive") {
    recorder.stop();
  }
  state.replayLab.recorder = null;
  state.replayLab.stream?.getTracks().forEach((track) => track.stop());
  state.replayLab.stream = null;
}

async function startReplayRecording() {
  stopReplayAnalysis({ keepFrame: false });
  stopReplayRecording();
  resetReplayFrames();
  clearReplayAudioUrl();
  dom.replayAudio.removeAttribute("src");
  dom.replayAudio.load();
  try {
    const stream = await requestRawAudioStream();
    const recorder = new MediaRecorder(stream);
    state.replayLab.stream = stream;
    state.replayLab.recorder = recorder;
    state.replayLab.chunks = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) {
        state.replayLab.chunks.push(event.data);
      }
    });
    recorder.addEventListener("stop", () => {
      state.replayLab.stream?.getTracks().forEach((track) => track.stop());
      state.replayLab.stream = null;
      if (!state.replayLab.chunks.length) {
        setReplayStatus("沒有錄到聲音，請再試一次");
        render();
        return;
      }
      const blob = new Blob(state.replayLab.chunks, { type: recorder.mimeType || "audio/webm" });
      state.replayLab.chunks = [];
      state.replayLab.recorder = null;
      setReplayAudioBlob(blob, "錄音完成");
      render();
    }, { once: true });
    recorder.start();
    setReplayStatus("錄音中…");
    render();
  } catch {
    setReplayStatus("無法開始錄音，請確認瀏覽器已允許麥克風");
    render();
  }
}

function captureReplayFrame(now) {
  if (!state.replayLab.analyser || !state.replayLab.analysisContext) {
    return false;
  }
  state.replayLab.analyser.getFloatTimeDomainData(state.replayLab.timeBuffer);
  state.replayLab.analyser.getFloatFrequencyData(state.replayLab.frequencyBuffer);

  let rms = 0;
  for (let index = 0; index < state.replayLab.timeBuffer.length; index += 1) {
    rms += state.replayLab.timeBuffer[index] * state.replayLab.timeBuffer[index];
  }
  rms = Math.sqrt(rms / state.replayLab.timeBuffer.length);

  const targetAmplitude = mapAmplitudeNormFromRms(rms);
  state.replayLab.amplitudeSmooth = lerp(
    state.replayLab.amplitudeSmooth,
    targetAmplitude,
    targetAmplitude > state.replayLab.amplitudeSmooth ? AMP_ATTACK_SMOOTH : AMP_RELEASE_SMOOTH
  );
  const voicedLatch = state.replayLab.voicedHoldUntil > now;

  const frame = computeSpectrumFrame({
    timeData: state.replayLab.timeBuffer,
    frequencyData: state.replayLab.frequencyBuffer,
    sampleRate: state.replayLab.analysisContext.sampleRate,
    fftSize: state.replayLab.analyser.fftSize,
    profileLowHz: state.replayLab.profile.lowHz,
    profileHighHz: state.replayLab.profile.highHz,
    amplitudeNorm: state.replayLab.amplitudeSmooth,
    voicedLatch
  });
  state.replayLab.profile = updateSpectrumProfile(state.replayLab.profile, frame.dominantHz, now, {
    voiced: frame.voiced,
    canAdapt: true
  });
  const settledFrame = computeSpectrumFrame({
    timeData: state.replayLab.timeBuffer,
    frequencyData: state.replayLab.frequencyBuffer,
    sampleRate: state.replayLab.analysisContext.sampleRate,
    fftSize: state.replayLab.analyser.fftSize,
    profileLowHz: state.replayLab.profile.lowHz,
    profileHighHz: state.replayLab.profile.highHz,
    amplitudeNorm: state.replayLab.amplitudeSmooth,
    voicedLatch
  });
  const stableFrame = stabilizeSpectrumFrame(
    state.replayLab.stableBandLevels,
    settledFrame,
    state.replayLab.profile.lowHz,
    state.replayLab.profile.highHz
  );
  state.replayLab.stableBandLevels = stableFrame.rawBandLevels;
  state.replayLab.voicedHoldUntil = stableFrame.voiced ? now + AUDIO.voicedPersistenceMs : 0;
  state.replayLab.smoothedBandPosition = smoothBandPosition(
    state.replayLab.smoothedBandPosition,
    stableFrame.dominantBandIndex,
    stableFrame.voiced
  );
  const finalBandIndex = stableFrame.voiced && Number.isFinite(state.replayLab.smoothedBandPosition)
    ? Math.round(state.replayLab.smoothedBandPosition)
    : stableFrame.dominantBandIndex;
  const finalBandHz = getBandCenterHz(finalBandIndex, state.replayLab.profile.lowHz, state.replayLab.profile.highHz);
  const finalAmplitude = applySilentAmplitudeClamp(state.replayLab.amplitudeSmooth, stableFrame.voiced);

  const nextFrame = {
    index: state.replayLab.frames.length,
    rms,
    amplitudeNorm: finalAmplitude,
    voiced: stableFrame.voiced,
    bandIndex: finalBandIndex,
    dominantBandHz: finalBandHz,
    levels: stableFrame.rawBandLevels,
    peakRatio: stableFrame.peakRatio
  };
  state.replayLab.frames.push(nextFrame);
  state.replayLab.currentFrame = nextFrame;
  return true;
}

function tickReplayAnalysis() {
  if (!state.replayLab.analyser || dom.replayAudio.paused || dom.replayAudio.ended) {
    return;
  }
  captureReplayFrame(performance.now());
  renderReplayLab();
  state.replayLab.rafId = requestAnimationFrame(tickReplayAnalysis);
}

async function startReplayAnalysis() {
  if (!dom.replayAudio?.src) {
    setReplayStatus("請先錄音或匯入音檔");
    return;
  }
  stopReplayRecording();
  stopReplayAnalysis({ keepFrame: false });
  resetReplayFrames();

  try {
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.16;
    analyser.minDecibels = -95;
    analyser.maxDecibels = -10;
    const source = context.createMediaElementSource(dom.replayAudio);
    source.connect(analyser);
    analyser.connect(context.destination);

    state.replayLab.analysisContext = context;
    state.replayLab.analysisSource = source;
    state.replayLab.analyser = analyser;
    state.replayLab.timeBuffer = new Float32Array(analyser.fftSize);
    state.replayLab.frequencyBuffer = new Float32Array(analyser.frequencyBinCount);
    state.replayLab.profile = createDefaultSpectrumProfile();
    state.replayLab.amplitudeSmooth = 0;

    dom.replayAudio.currentTime = 0;
    dom.replayAudio.onended = () => {
      stopReplayAnalysis({ keepFrame: true });
      setReplayStatus(`回放完成，共分析 ${state.replayLab.frames.length} 幀`);
    };
    await context.resume();
    await dom.replayAudio.play();
    setReplayStatus("回放分析中…");
    renderReplayLab();
    tickReplayAnalysis();
  } catch {
    stopReplayAnalysis({ keepFrame: true });
    setReplayStatus("回放分析啟動失敗，請再試一次");
  }
}

function renderTopStatus(self) {
  dom.reconnectBanner.classList.toggle("hidden", !(state.wantsJoin && !state.socket));
  dom.reconnectCopy.textContent = "正在重新連線⋯";
  dom.roomResetBanner.classList.toggle("hidden", !state.roomClosedNotice.visible);
  dom.roomResetCopy.textContent = state.roomClosedNotice.roomCode
    ? `大螢幕開了新房間 ${state.roomClosedNotice.roomCode}。`
    : "房間已關閉。";
  setStatus(dom.globalStatus, state.joinPending ? "加入中⋯" : "");
}

function renderRoleScreen(self) {
  dom.roleButtons.forEach((button) => {
    const roleOwner =
      button.dataset.role === ROLES.ATTACKER
        ? state.game?.players?.find((player) => player.role === ROLES.ATTACKER && player.id !== state.playerId)
        : null;
    button.dataset.state = button.dataset.role === self?.role ? "selected" : (roleOwner ? "disabled" : "idle");
    button.disabled = Boolean(roleOwner) && button.dataset.role === ROLES.ATTACKER && button.dataset.role !== self?.role;
  });

  const existingAttacker = state.game?.players?.find((player) => player.role === ROLES.ATTACKER && player.id !== state.playerId);
  if (dom.roleAttackerNotice) {
    dom.roleAttackerNotice.classList.toggle("hidden", !existingAttacker);
    if (existingAttacker) {
      dom.roleAttackerNotice.textContent = `😈 ${existingAttacker.name} 已是魔王，你只能選小勇者。`;
    }
  }
}

function renderRunnerHud(self) {
  dom.playerPhase.textContent = formatPhaseLabel(state.game?.phase);
  dom.playerTimer.textContent = formatTimer(state.game);
  dom.runnerLives.textContent = formatLives(self);
  dom.runnerDeathCause.textContent = self?.lastDeathCause || "無";
  if (self?.isRespawning && self.respawnAt) {
    const seconds = Math.max(0, (self.respawnAt - Date.now()) / 1000);
    dom.runnerRespawnStatus.textContent = `${seconds.toFixed(1)}秒後重生`;
  } else if (self?.isEliminated) {
    dom.runnerRespawnStatus.textContent = "等下回合重新選角色。";
  } else {
    dom.runnerRespawnStatus.textContent = "持續移動！";
  }
}

let _deathPopupTimer = null;
let _lastRespawnAt = 0;

function renderDeathPopup(self) {
  if (!dom.deathPopup) return;
  const isNewDeath = self?.isRespawning && self.respawnAt && self.respawnAt !== _lastRespawnAt;
  if (isNewDeath) {
    _lastRespawnAt = self.respawnAt;
    clearTimeout(_deathPopupTimer);
    const causeMap = { wave: "被聲波打到！", fall: "掉下去啦！" };
    dom.deathPopupCause.textContent = causeMap[self.lastDeathCause] || "出局啦 👻";
    dom.deathPopup.classList.remove("hidden");
    void dom.deathPopup.offsetHeight;
    _deathPopupTimer = setTimeout(() => dom.deathPopup.classList.add("hidden"), 2200);
  }
  if (!dom.deathPopup.classList.contains("hidden") && self?.isRespawning && self.respawnAt) {
    const secs = Math.max(0, (self.respawnAt - Date.now()) / 1000);
    dom.deathPopupRespawn.textContent = secs > 0.05 ? `${secs.toFixed(1)}秒後重生` : "重生！";
  }
}

function renderAttackerSetup() {
  const setup = state.game?.attackerSetup;
  const self = getSelfPlayer();
  const isOwner = self?.role === ROLES.ATTACKER;
  const spectrumActive = state.audio.enabled;

  dom.micButton.textContent = state.audio.enabled ? "關閉麥克風" : "開啟麥克風";

  if (dom.micVisual) {
    if (spectrumActive) {
      dom.micVisual.classList.remove("mic-active");
      dom.micVisual.classList.add("mic-confirmed");
    } else if (state.audio.enabled) {
      dom.micVisual.classList.add("mic-active");
      dom.micVisual.classList.remove("mic-confirmed");
    } else {
      dom.micVisual.classList.remove("mic-active", "mic-confirmed");
    }
  }

  if (spectrumActive) {
    dom.micStatus.innerHTML = '<span class="mic-ok-badge">✅ 麥克風 OK！</span>';
  } else if (state.audio.enabled) {
    dom.micStatus.textContent = "系統正在學你這局最常用的發聲範圍，不用唱準，只要讓不同頻段亮起來。";
  } else if (isOwner) {
    dom.micStatus.textContent = "開啟麥克風，對著它大喊！";
  } else {
    dom.micStatus.textContent = "等待聲波大魔王開啟麥克風⋯";
  }

  dom.frequencyReadout.textContent = formatFrequency(state.audio.latestDominantBandHz);
  const previewTerrain = state.audio.enabled ? buildEqPreviewState() : (state.game?.terrain?.bars?.length ? state.game.terrain : buildEqPreviewState());
  renderEqBars(dom.eqPreview, previewTerrain);
  renderEqBars(dom.eqLive, previewTerrain);
  const activeBandIndex = Number.isInteger(previewTerrain.activeBandIndex) ? previewTerrain.activeBandIndex : (setup?.lastDominantBandIndex ?? null);
  const ampNorm = state.audio.enabled ? state.audio.amplitudeSmooth : (setup?.lastAmplitudeNorm ?? 0);
  dom.bandSummary.textContent = Number.isInteger(activeBandIndex)
    ? `第 ${activeBandIndex + 1} 條 · ${formatFrequency(state.audio.enabled ? state.audio.latestDominantBandHz : setup?.lastDominantBandHz)}`
    : "等待輸入";
  dom.spikeSummary.textContent = `${Math.round(ampNorm * 100)}%`;
  const profileLowHz = state.audio.enabled ? state.audio.profile.lowHz : (setup?.profileLowHz ?? AUDIO.defaultProfileLowHz);
  const profileHighHz = state.audio.enabled ? state.audio.profile.highHz : (setup?.profileHighHz ?? AUDIO.defaultProfileHighHz);
  dom.summaryLow.textContent = `${Math.round(profileLowHz)} Hz`;
  dom.summaryHigh.textContent = `${Math.round(profileHighHz)} Hz`;
  dom.summaryCoverage.textContent = state.audio.enabled
    ? `本局控制窗 ${Math.round(profileLowHz)}–${Math.round(profileHighHz)} Hz`
    : "開啟麥克風後自動學習本局控制窗。";

  if (state.audio.enabled && dom.tipSummary) {
    if (state.audio.miniLog.length === 0) {
      dom.tipSummary.textContent = "等待有效發聲…";
    } else {
      const lines = [...state.audio.miniLog].reverse().map(e => {
        if (e.voiced) return `${Math.round(e.dominantHz)} Hz → 第 ${e.bandIndex + 1} 條`;
        return `✗ ${e.reason === "noise" ? "靜音" : e.reason || "未定義"}`;
      });
      dom.tipSummary.textContent = lines.join("  |  ");
    }
  } else {
    dom.tipSummary.textContent = "不用唱準，只要讓頻段亮起來；系統會用你這局常用聲音範圍來分配 12 條柱。";
  }
}

function renderPitchDiagnostics() {
  if (!dom.pitchDiagnostics) {
    return;
  }
  const visible = state.diagnostics.enabled && state.activeView === "attackerSetup";
  dom.pitchDiagnostics.classList.toggle("hidden", !visible);
  if (!visible) {
    return;
  }

  dom.diagnosticFrequency.textContent = formatDiagHz(state.audio.latestDominantHz);
  dom.diagnosticRms.textContent = `${state.audio.latestRms.toFixed(4)} / ${formatDiagPercent(Math.max(0, Math.min(1, (state.audio.latestRms - AUDIO.minAmplitude) / Math.max(AUDIO.maxAmplitude - AUDIO.minAmplitude, 0.01))))}`;
  dom.diagnosticBasePitch.textContent = `基頻窗 (${state.audio.profile.samples.length} 樣本)`;
  dom.diagnosticRange.textContent = `${Math.round(state.audio.profile.lowHz)}–${Math.round(state.audio.profile.highHz)} Hz`;
  dom.diagnosticMapped.textContent = Number.isInteger(state.audio.latestDominantBandIndex) ? `第 ${state.audio.latestDominantBandIndex + 1} 條` : "—";
  dom.diagnosticVirtualHz.textContent = formatDiagHz(state.audio.latestDominantBandHz);
  if (!state.audio.enabled) {
    dom.diagnosticValidity.textContent = "等待麥克風輸入";
  } else if (state.audio.voiced) {
    dom.diagnosticValidity.textContent = `voiced · 頻段控制已啟動`;
  } else if (state.audio.latestRejectionReason) {
    dom.diagnosticValidity.textContent = `已忽略：${state.audio.latestRejectionReason}`;
  } else {
    dom.diagnosticValidity.textContent = "等待有效發聲…";
  }

  if (dom.diagnosticSamples) {
    dom.diagnosticSamples.innerHTML = state.diagnostics.trace
      .map((sample) => {
        const time = new Date(sample.createdAt).toLocaleTimeString("zh-HK", { hour12: false });
        const reason = sample.rejectionReason ? ` · reject ${sample.rejectionReason}` : "";
        const profileRange = Number.isFinite(sample.profileLowHz) && Number.isFinite(sample.profileHighHz)
          ? ` · profile ${Math.round(sample.profileLowHz)}-${Math.round(sample.profileHighHz)}`
          : "";
        const band = Number.isInteger(sample.bandIndex) ? ` · band ${sample.bandIndex + 1}` : "";
        const levels = Array.isArray(sample.levels) ? ` · levels ${sample.levels.map((level) => Math.round(level * 9)).join("")}` : "";
        return `<div class="diagnostic-sample">${time} · ${sample.voiced ? "voiced" : "silent"} · peak ${formatDiagHz(sample.dominantHz)} · center ${formatDiagHz(sample.dominantBandHz)}${reason}${profileRange}${band}${levels} · rms ${sample.rms.toFixed(4)}</div>`;
      })
      .join("") || '<div class="diagnostic-sample">尚未收到頻譜樣本。</div>';
  }
}

function renderResult(self) {
  const winner = state.highlightOverlay.winner || state.game?.winner;
  const showingOverlay = state.highlightOverlay.open;
  const inResultPhase = state.game?.phase === GAME_PHASES.RESULT;

  // Simple win/lose headline based on this player's role vs the winner
  const iWon = self?.role && winner && self.role === winner;
  const resultHeadline = !winner ? "回合結束！" : iWon ? "你贏了！🎉" : "你輸了！😅";

  dom.shareCopy.textContent = resultHeadline;
  dom.shareGallery.innerHTML = "";

  if (showingOverlay) {
    // "Long-press to download" hint above images (only if there are images)
    const hasImages = state.highlightOverlay.items.some((item) => item.imageBase64);
    if (hasImages) {
      const hint = document.createElement("p");
      hint.className = "share-hint";
      hint.textContent = "長按圖片可以下載";
      dom.shareGallery.appendChild(hint);
    }

    state.highlightOverlay.items.forEach((item) => {
      if (!item.imageBase64) return;
      const chip = document.createElement("div");
      chip.className = "share-item";
      const image = document.createElement("img");
      image.className = "share-image";
      image.src = item.imageBase64;
      image.alt = item.caption || "精彩鏡頭";
      chip.appendChild(image);
      dom.shareGallery.appendChild(chip);
    });

    if (!hasImages) {
      const empty = document.createElement("div");
      empty.className = "summary-chip wide";
      const label = document.createElement("strong");
      label.textContent = "這回合沒有精彩鏡頭。";
      empty.appendChild(label);
      dom.shareGallery.appendChild(empty);
    }

    dom.galleryContinue.classList.remove("hidden");
    dom.galleryContinue.textContent = "關掉";
  } else if (inResultPhase) {
    // Overlay was closed — show countdown until next round
    const secondsLeft = Math.ceil(state.game.timeLeft ?? 0);
    const countdown = document.createElement("div");
    countdown.className = "summary-chip wide result-countdown";
    countdown.innerHTML = `<strong>${secondsLeft} 秒後回到下一回合</strong>`;
    dom.shareGallery.appendChild(countdown);
    dom.galleryContinue.classList.add("hidden");
  }

  dom.shareCard.dataset.mode = showingOverlay ? "overlay" : "countdown";
}

function renderTopbar(self) {
  const hasName = Boolean(self?.name);
  const hasRoom = Boolean(state.roomCode);

  dom.topbarPlayerName.classList.toggle("hidden", !hasName);
  dom.topbarRoleEmoji.classList.add("hidden"); // role emoji removed from topbar
  dom.topbarRoomCode.classList.toggle("hidden", !hasRoom);

  if (hasName) dom.topbarPlayerName.textContent = self.name;
  if (hasRoom) dom.topbarRoomCode.textContent = state.roomCode;
}

function renderActionBar(self) {
  if (state.activeView !== "runnerReady" && state.activeView !== "attackerSetup") {
    return;
  }
  const ready = Boolean(self?.isReady);
  const isAttacker = self?.role === ROLES.ATTACKER;
  const setup = state.game?.attackerSetup;
  // Attacker can ready up as soon as mic is on locally (no server round-trip needed)
  const attackerCanReady = !isAttacker || state.audio.enabled;
  dom.readyButton.disabled = ready || !attackerCanReady;
  dom.readyButton.textContent = ready ? "已準備好！" : "準備好了！";
  if (ready) {
    dom.roleStatus.textContent = "等待遊戲開始";
  } else if (isAttacker && !attackerCanReady) {
    dom.roleStatus.textContent = "先開啟麥克風，就能立即準備。";
  } else if (isAttacker) {
    dom.roleStatus.textContent = "開啟麥克風後即可準備，或發出聲音後系統自動準備。";
  } else {
    dom.roleStatus.textContent = "";
  }
}

function render() {
  ensureResultOverlay();
  state.activeView = deriveActiveView();
  const self = getSelfPlayer();
  syncMicrophoneLifecycle();
  syncCameraLifecycle();
  moveSharedPrepPanels();

  renderRoomLabels();
  renderTopbar(self);
  renderTopStatus(self);
  renderActionBar(self);
  renderRoleScreen(self);
  renderRunnerHud(self);
  renderDeathPopup(self);
  renderAttackerSetup();
  renderPitchDiagnostics();
  renderReplayLab();
  renderCameraSection(self);
  renderResult(self);
  renderControlStates();

  dom.joinScreen.classList.toggle("hidden",          state.activeView !== "join");
  dom.roleScreen.classList.toggle("hidden",          state.activeView !== "role");
  dom.runnerReadyScreen.classList.toggle("hidden",   state.activeView !== "runnerReady");
  dom.attackerSetupScreen.classList.toggle("hidden", state.activeView !== "attackerSetup");
  dom.playerScreen.classList.toggle("hidden",        state.activeView !== "runnerPlay");
  dom.waitingScreen.classList.toggle("hidden",       state.activeView !== "runnerWaiting");
  dom.attackerScreen.classList.toggle("hidden",      state.activeView !== "attackerPlay");
  const showShareCard = state.highlightOverlay.open ||
    (state.game?.phase === GAME_PHASES.RESULT && state.lastAutoOverlayRoundId === state.game?.roundId);
  dom.shareCard.classList.toggle("hidden", !showShareCard);

  setStatus(
    dom.joinStatus,
    state.joinPending
      ? `加入房間 ${state.roomCode}⋯`
      : state.roomCode
        ? `準備加入房間 ${state.roomCode}。`
        : "請輸入房號。"
  );
}

function drawCenterCropToCanvas(video, canvas, { circle = false } = {}) {
  const crop = resolveCameraCrop(video, state.camera.lastFaceCrop);
  if (!crop) {
    return false;
  }
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (circle) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(canvas.width / 2, canvas.height / 2, canvas.width * 0.42, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
  }
  ctx.drawImage(video, crop.sx, crop.sy, crop.size, crop.size, 0, 0, canvas.width, canvas.height);
  if (circle) {
    ctx.restore();
    ctx.lineWidth = 8;
    ctx.strokeStyle = "rgba(255,255,255,0.88)";
    ctx.beginPath();
    ctx.arc(canvas.width / 2, canvas.height / 2, canvas.width * 0.42, 0, Math.PI * 2);
    ctx.stroke();
  }
  return true;
}

function getCenterCrop(video) {
  const sourceSize = Math.min(video.videoWidth || 0, video.videoHeight || 0);
  if (!sourceSize) {
    return null;
  }
  return {
    xNorm: (video.videoWidth - sourceSize) / 2 / video.videoWidth,
    yNorm: (video.videoHeight - sourceSize) / 2 / video.videoHeight,
    sizeNorm: sourceSize / Math.min(video.videoWidth, video.videoHeight)
  };
}

function resolveCameraCrop(video, normalizedCrop = null) {
  const sourceSize = Math.min(video.videoWidth || 0, video.videoHeight || 0);
  if (!sourceSize) {
    return null;
  }
  const crop = normalizedCrop || getCenterCrop(video);
  const size = Math.max(1, Math.round(crop.sizeNorm * sourceSize));
  const sx = Math.max(0, Math.min(video.videoWidth - size, Math.round(crop.xNorm * video.videoWidth)));
  const sy = Math.max(0, Math.min(video.videoHeight - size, Math.round(crop.yNorm * video.videoHeight)));
  return { sx, sy, size };
}

async function ensureFaceDetector() {
  if (state.camera.detector !== undefined) {
    return state.camera.detector;
  }
  if (!_detectorInitPromise) {
    _detectorInitPromise = (async () => {
      try {
        const visionModule = state.camera.detectorModule || await import(MEDIAPIPE_TASKS_VISION_URL);
        state.camera.detectorModule = visionModule;
        const vision = await visionModule.FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_ROOT);
        let detector;
        try {
          detector = await visionModule.FaceDetector.createFromOptions(vision, {
            baseOptions: { modelAssetPath: MEDIAPIPE_FACE_MODEL_URL, delegate: "GPU" },
            runningMode: "VIDEO",
            minDetectionConfidence: 0.5,
            minSuppressionThreshold: 0.3
          });
        } catch {
          detector = await visionModule.FaceDetector.createFromOptions(vision, {
            baseOptions: { modelAssetPath: MEDIAPIPE_FACE_MODEL_URL },
            runningMode: "VIDEO",
            minDetectionConfidence: 0.5,
            minSuppressionThreshold: 0.3
          });
        }
        state.camera.detector = detector;
        state.camera.initError = "";
      } catch (error) {
        state.camera.detector = null;
        const message = error instanceof Error ? error.message : "unknown detector init error";
        console.error("[camera] Face detector init failed:", error);
        state.camera.initError = `Face tracking unavailable: ${message}`;
      }
      return state.camera.detector;
    })();
  }
  return _detectorInitPromise;
}

function normalizeCropFromFace(video, box) {
  const minSide = Math.min(video.videoWidth, video.videoHeight);
  const faceSize = Math.max(box.width || 0, box.height || 0);
  if (!faceSize || !minSide) {
    return null;
  }
  const cropSize = Math.max(minSide * 0.26, Math.min(minSide, faceSize * 1.45));
  const faceCenterX = (box.x || 0) + (box.width || 0) / 2;
  const faceCenterY = (box.y || 0) + (box.height || 0) / 2 - cropSize * 0.06;
  const sx = Math.max(0, Math.min(video.videoWidth - cropSize, faceCenterX - cropSize / 2));
  const sy = Math.max(0, Math.min(video.videoHeight - cropSize, faceCenterY - cropSize / 2));
  return {
    xNorm: sx / video.videoWidth,
    yNorm: sy / video.videoHeight,
    sizeNorm: cropSize / minSide
  };
}

function getDetectionBoundingBox(video, detection) {
  const box = detection?.boundingBox || null;
  if (!box) {
    return null;
  }
  if (![box.originX, box.originY, box.width, box.height].every(Number.isFinite)) {
    return null;
  }
  return {
    x: Math.max(0, box.originX),
    y: Math.max(0, box.originY),
    width: Math.max(1, box.width),
    height: Math.max(1, box.height)
  };
}

async function updateFaceCropFromDetector() {
  if (!state.camera.enabled || !state.camera.videoReady || dom.cameraPreview.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return state.camera.lastFaceCrop || getCenterCrop(dom.cameraPreview);
  }
  const now = performance.now();
  if (now - state.camera.lastDetectAt < 250 || state.camera.detectInFlight) {
    return state.camera.lastFaceCrop || getCenterCrop(dom.cameraPreview);
  }
  state.camera.lastDetectAt = now;
  state.camera.detectInFlight = true;
  try {
    const detector = await ensureFaceDetector();
    if (!detector) {
      state.camera.trackingMode = "fallback";
      return state.camera.lastFaceCrop || getCenterCrop(dom.cameraPreview);
    }
    const result = detector.detectForVideo(dom.cameraPreview, performance.now());
    const detection = result?.detections?.[0] || null;
    const faceBox = getDetectionBoundingBox(dom.cameraPreview, detection);
    const crop = faceBox ? normalizeCropFromFace(dom.cameraPreview, faceBox) : null;
    if (crop) {
      state.camera.lastFaceCrop = crop;
      state.camera.trackingMode = "mediapipe";
      return crop;
    }
    state.camera.trackingMode = state.camera.lastFaceCrop ? "lost" : "fallback";
    return state.camera.lastFaceCrop || getCenterCrop(dom.cameraPreview);
  } catch {
    state.camera.trackingMode = "fallback";
    return state.camera.lastFaceCrop || getCenterCrop(dom.cameraPreview);
  } finally {
    state.camera.detectInFlight = false;
  }
}

function applyAttackerSetup() {
  const status = state.audio.enabled ? "complete" : "preset";
  send(MSG_TYPES.ATTACKER_SETUP, {
    hasMicPermission: state.audio.enabled,
    noiseGate: AUDIO.minAmplitude,
    ceiling: AUDIO.maxAmplitude,
    status,
    skipped: !state.audio.enabled,
    expectedCoverage: state.audio.enabled
      ? `頻譜控制 ${Math.round(state.audio.profile.lowHz)}-${Math.round(state.audio.profile.highHz)} Hz${state.diagnostics.enabled ? " · 診斷開啟" : ""}`
      : "等待麥克風",
    profileLowHz: state.audio.profile.lowHz,
    profileHighHz: state.audio.profile.highHz,
    diagnosticsEnabled: state.diagnostics.enabled
  });
}


function tickMicrophone() {
  if (!state.audio.enabled || !state.audio.analyser) {
    return;
  }
  state.audio.analyser.getFloatTimeDomainData(state.audio.timeSampleBuffer);
  state.audio.analyser.getFloatFrequencyData(state.audio.frequencyDataBuffer);

  let rms = 0;
  for (let index = 0; index < state.audio.timeSampleBuffer.length; index += 1) {
    rms += state.audio.timeSampleBuffer[index] * state.audio.timeSampleBuffer[index];
  }
  rms = Math.sqrt(rms / state.audio.timeSampleBuffer.length);
  state.audio.latestRms = rms;
  const now = performance.now();
  const boostedAmpNorm = mapAmplitudeNormFromRms(rms);
  state.audio.amplitudeSmooth = lerp(
    state.audio.amplitudeSmooth, boostedAmpNorm,
    boostedAmpNorm > state.audio.amplitudeSmooth ? AMP_ATTACK_SMOOTH : AMP_RELEASE_SMOOTH
  );
  const voicedLatch = state.audio.voicedHoldUntil > now;
  const frame = computeSpectrumFrame({
    timeData: state.audio.timeSampleBuffer,
    frequencyData: state.audio.frequencyDataBuffer,
    sampleRate: state.audio.context.sampleRate,
    fftSize: state.audio.analyser.fftSize,
    profileLowHz: state.audio.profile.lowHz,
    profileHighHz: state.audio.profile.highHz,
    amplitudeNorm: state.audio.amplitudeSmooth,
    voicedLatch
  });
  const canAdapt = state.game?.phase === GAME_PHASES.ATTACKER_SETUP || state.game?.phase === GAME_PHASES.COUNTDOWN;
  const expandOnly = state.game?.phase === GAME_PHASES.PLAYING;
  state.audio.profile = updateSpectrumProfile(state.audio.profile, frame.dominantHz, now, {
    voiced: frame.voiced,
    canAdapt: canAdapt || expandOnly,
    expandOnly
  });
  const settledFrame = computeSpectrumFrame({
    timeData: state.audio.timeSampleBuffer,
    frequencyData: state.audio.frequencyDataBuffer,
    sampleRate: state.audio.context.sampleRate,
    fftSize: state.audio.analyser.fftSize,
    profileLowHz: state.audio.profile.lowHz,
    profileHighHz: state.audio.profile.highHz,
    amplitudeNorm: state.audio.amplitudeSmooth,
    voicedLatch
  });
  const stableFrame = stabilizeSpectrumFrame(
    state.audio.stableBandLevels,
    settledFrame,
    state.audio.profile.lowHz,
    state.audio.profile.highHz
  );
  state.audio.stableBandLevels = stableFrame.rawBandLevels;
  state.audio.voicedHoldUntil = stableFrame.voiced ? now + AUDIO.voicedPersistenceMs : 0;
  state.audio.smoothedBandPosition = smoothBandPosition(
    state.audio.smoothedBandPosition,
    stableFrame.dominantBandIndex,
    stableFrame.voiced
  );
  const finalBandIndex = stableFrame.voiced && Number.isFinite(state.audio.smoothedBandPosition)
    ? Math.round(state.audio.smoothedBandPosition)
    : stableFrame.dominantBandIndex;
  const finalControlBandLevels = Number.isInteger(finalBandIndex)
    ? buildControlBandLevelsFromIndex(finalBandIndex)
    : Array.from({ length: WORLD.eqBandCount }, () => 0);
  const finalBandHz = getBandCenterHz(finalBandIndex, state.audio.profile.lowHz, state.audio.profile.highHz);
  const finalAmplitude = applySilentAmplitudeClamp(state.audio.amplitudeSmooth, stableFrame.voiced);
  const isStrong = stableFrame.voiced && state.audio.amplitudeSmooth >= AUDIO.voicedStrongAmplitudeFloor;

  state.audio.latestDominantHz = stableFrame.dominantHz;
  state.audio.latestDominantBandHz = finalBandHz;
  state.audio.latestDominantBandIndex = finalBandIndex;
  state.audio.latestBandLevels = stableFrame.rawBandLevels;
  state.audio.latestControlLevels = finalControlBandLevels;
  state.audio.voiced = stableFrame.voiced;
  state.audio.isStrong = isStrong;
  state.audio.latestRejectionReason = stableFrame.voiced ? null : (rms < PITCH_RMS_GATE ? "noise" : "unvoiced");

  if (stableFrame.voiced && !state.audio.hasAutoReadied && state.audio.enabled && state.activeView === "attackerSetup" && !getSelfPlayer()?.isReady) {
    state.audio.hasAutoReadied = true;
    send(MSG_TYPES.READY);
    render();
  }

  if (now - state.audio.lastSentAt > 50) {
    const diagnostics = state.diagnostics.enabled
        ? {
          source: "controller",
          role: getSelfPlayer()?.role || null,
          phase: state.game?.phase || null,
          rms: Number(rms.toFixed(5)),
          rawFundamentalHz: stableFrame.rawFundamentalHz !== null ? Number(stableFrame.rawFundamentalHz.toFixed(2)) : null,
          fundamentalHz: stableFrame.fundamentalHz !== null ? Number(stableFrame.fundamentalHz.toFixed(2)) : null,
          dominantHz: stableFrame.dominantHz !== null ? Number(stableFrame.dominantHz.toFixed(2)) : null,
          dominantBandHz: finalBandHz !== null ? Number(finalBandHz.toFixed(2)) : null,
          dominantBandIndex: finalBandIndex,
          voiced: stableFrame.voiced,
          rejectionReason: state.audio.latestRejectionReason,
          profileLowHz: Number(state.audio.profile.lowHz.toFixed(2)),
          profileHighHz: Number(state.audio.profile.highHz.toFixed(2)),
          peakRatio: Number(stableFrame.peakRatio.toFixed(4)),
          levels: stableFrame.rawBandLevels.map((level) => Number(level.toFixed(4))),
          amplitudeNorm: Number(finalAmplitude.toFixed(4))
        }
      : undefined;
    send(MSG_TYPES.AUDIO, {
      rawFundamentalHz: Number.isFinite(stableFrame.rawFundamentalHz) ? stableFrame.rawFundamentalHz : null,
      fundamentalHz: Number.isFinite(stableFrame.fundamentalHz) ? stableFrame.fundamentalHz : null,
      dominantBandIndex: isStrong ? finalBandIndex : null,
      dominantBandHz: isStrong ? finalBandHz : null,
      bandLevels: isStrong ? finalControlBandLevels : Array.from({ length: WORLD.eqBandCount }, () => 0),
      amplitudeNorm: finalAmplitude,
      profileRangeHz: {
        lowHz: state.audio.profile.lowHz,
        highHz: state.audio.profile.highHz
      },
      voiced: isStrong,
      diagnostics
    });
    state.audio.lastSentAt = now;

    state.audio.miniLog.push({
      t: now,
      dominantHz: stableFrame.dominantHz,
      bandIndex: finalBandIndex,
      voiced: stableFrame.voiced,
      reason: state.audio.latestRejectionReason
    });
    if (state.audio.miniLog.length > 5) state.audio.miniLog.shift();

    if (state.diagnostics.enabled && now - state.diagnostics.lastTraceAt > 140) {
      state.diagnostics.lastTraceAt = now;
      pushDiagnosticSample({
        createdAt: Date.now(),
        rawFundamentalHz: stableFrame.rawFundamentalHz,
        fundamentalHz: stableFrame.fundamentalHz,
        dominantHz: stableFrame.dominantHz,
        dominantBandHz: finalBandHz,
        bandIndex: finalBandIndex,
        levels: stableFrame.rawBandLevels,
        rms: Number(rms.toFixed(4)),
        voiced: stableFrame.voiced,
        rejectionReason: state.audio.latestRejectionReason,
        profileLowHz: state.audio.profile.lowHz,
        profileHighHz: state.audio.profile.highHz
      });
    }
  }

  if (state.audio.enabled) {
    dom.frequencyReadout.textContent = formatFrequency(state.audio.latestDominantBandHz);
  }
  state.audio.rafId = requestAnimationFrame(tickMicrophone);
}

async function startMicrophone() {
  if (state.audio.enabled) {
    stopMicrophone();
    applyAttackerSetup();
    render();
    return;
  }
  try {
    const stream = await requestRawAudioStream();
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.16;
    analyser.minDecibels = -95;
    analyser.maxDecibels = -10;
    source.connect(analyser);
    state.audio.context = context;
    state.audio.stream = stream;
    state.audio.analyser = analyser;
    state.audio.timeSampleBuffer = new Float32Array(analyser.fftSize);
    state.audio.frequencyDataBuffer = new Float32Array(analyser.frequencyBinCount);
    state.audio.enabled = true;
    resetSpectrumState({ preserveMic: true, preserveProfile: false });
    await context.resume();
    applyAttackerSetup();
    tickMicrophone();
    render();
  } catch {
    state.audio.enabled = false;
    setStatus(dom.micStatus, "麥克風權限被拒絕。");
  }
}

function stopMicrophone() {
  cancelAnimationFrame(state.audio.rafId);
  state.audio.stream?.getTracks().forEach((track) => track.stop());
  state.audio.context?.close();
  state.audio.context = null;
  state.audio.stream = null;
  state.audio.analyser = null;
  state.audio.timeSampleBuffer = null;
  state.audio.frequencyDataBuffer = null;
  state.audio.enabled = false;
  resetSpectrumState({ preserveMic: false });
  state.audio.miniLog = [];
  dom.frequencyReadout.textContent = "未偵測到主頻段";
}

function stopMicrophoneAndSync({ notifyServer = false } = {}) {
  const hadMic = state.audio.enabled;
  stopMicrophone();
  if (notifyServer && hadMic && state.socket?.readyState === WebSocket.OPEN) {
    applyAttackerSetup();
  }
}

function drawFacePreview() {
  if (!state.camera.enabled || !state.camera.videoReady || dom.cameraPreview.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return;
  }
  dom.faceCropPreview.width = 192;
  dom.faceCropPreview.height = 192;
  drawCenterCropToCanvas(dom.cameraPreview, dom.faceCropPreview, { circle: true });
}

async function uploadFaceSnapshot() {
  if (!state.camera.enabled || !state.camera.videoReady || state.camera.uploadInFlight || dom.cameraPreview.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return;
  }
  if (state.camera.trackingMode !== "mediapipe") {
    return;
  }
  await updateFaceCropFromDetector();
  const captureCanvas = state.camera.captureCanvas;
  captureCanvas.width = 192;
  captureCanvas.height = 192;
  if (!drawCenterCropToCanvas(dom.cameraPreview, captureCanvas)) {
    return;
  }
  state.camera.uploadInFlight = true;
  captureCanvas.toBlob(
    async (blob) => {
      if (!blob) {
        state.camera.uploadInFlight = false;
        return;
      }
      if (blob.size > MAX_FACE_SNAPSHOT_BYTES) {
        state.camera.uploadInFlight = false;
        state.camera.error = "Camera snapshot is too large. Move closer and try again.";
        setStatus(dom.cameraStatus, "Camera snapshot is too large. Move closer and try again.");
        return;
      }
      const buffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let index = 0; index < bytes.length; index += 1) {
        binary += String.fromCharCode(bytes[index]);
      }
      send(MSG_TYPES.FACE_SNAPSHOT, {
        imageBase64: `data:image/jpeg;base64,${btoa(binary)}`,
        capturedAt: Date.now(),
        shape: "circle"
      });
      state.camera.error = "";
      state.camera.uploadInFlight = false;
    },
    "image/jpeg",
    0.76
  );
}

function tickCamera() {
  if (!state.camera.enabled) {
    return;
  }
  void updateFaceCropFromDetector();
  drawFacePreview();
  const now = performance.now();
  const sendInterval = state.camera.trackingMode === "mediapipe" ? 500 : FACE_UPLOAD_TARGET_MS;
  if (now - state.camera.lastSentAt >= sendInterval) {
    void uploadFaceSnapshot();
    state.camera.lastSentAt = now;
  }
  state.camera.rafId = requestAnimationFrame(tickCamera);
}

async function startCamera() {
  if (state.camera.enabled) {
    stopCamera();
    render();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 640 }
      },
      audio: false
    });
    state.camera.stream = stream;
    state.camera.enabled = true;
    state.camera.panelExpanded = true;
    state.camera.videoReady = false;
    state.camera.error = "";
    state.camera.lastFaceCrop = null;
    state.camera.trackingMode = "pending";
    state.camera.lastDetectAt = 0;
    state.camera.initError = "";
    state.camera.detectorResult = null;
    ensureFaceDetector().catch(() => {});
    dom.cameraPreview.srcObject = stream;
    await dom.cameraPreview.play();
    if (dom.cameraPreview.readyState >= HTMLMediaElement.HAVE_METADATA) {
      state.camera.videoReady = true;
      tickCamera();
    } else {
      dom.cameraPreview.onloadedmetadata = () => {
        state.camera.videoReady = true;
        tickCamera();
        render();
      };
    }
    stream.getVideoTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        state.camera.error = "Camera stopped by the browser or device.";
        stopCamera({ preserveError: true });
        render();
      });
    });
    render();
  } catch {
    state.camera.enabled = false;
    state.camera.error = "Camera permission was denied.";
    setStatus(dom.cameraStatus, state.camera.error);
  }
}

function stopCamera({ preserveError = false } = {}) {
  cancelAnimationFrame(state.camera.rafId);
  dom.cameraPreview.pause();
  dom.cameraPreview.srcObject = null;
  dom.cameraPreview.onloadedmetadata = null;
  state.camera.stream?.getTracks().forEach((track) => track.stop());
  state.camera.stream = null;
  state.camera.enabled = false;
  state.camera.videoReady = false;
  state.camera.uploadInFlight = false;
  state.camera.lastSentAt = 0;
  state.camera.lastFaceCrop = null;
  state.camera.detectorResult = null;
  state.camera.trackingMode = "pending";
  state.camera.lastDetectAt = 0;
  state.camera.initError = "";
  state.camera.detectInFlight = false;
  _detectorInitPromise = null;
  state.camera.detector = undefined;
  if (!preserveError) {
    state.camera.error = "";
  }
  const ctx = dom.faceCropPreview.getContext("2d");
  ctx.clearRect(0, 0, dom.faceCropPreview.width || 0, dom.faceCropPreview.height || 0);
}

function syncCameraLifecycle() {
  const self = getSelfPlayer();
  const shouldKeepCamera =
    Boolean(self?.role) &&
    Boolean(state.game) &&
    state.game.phase !== GAME_PHASES.RESULT;
  if (!shouldKeepCamera && state.camera.enabled) {
    stopCamera();
  }
}

function syncMicrophoneLifecycle() {
  const self = getSelfPlayer();
  const shouldKeepMic =
    Boolean(self) &&
    self.role === ROLES.ATTACKER &&
    Boolean(state.game) &&
    (state.game.phase === GAME_PHASES.LOBBY ||
      state.game.phase === GAME_PHASES.ROLE_SELECT ||
      state.game.phase === GAME_PHASES.ATTACKER_SETUP ||
      state.game.phase === GAME_PHASES.WAITING_READY ||
      state.game.phase === GAME_PHASES.COUNTDOWN ||
      state.game.phase === GAME_PHASES.PLAYING);

  if (!shouldKeepMic && state.audio.enabled) {
    stopMicrophoneAndSync({
      notifyServer: Boolean(self && self.role === ROLES.ATTACKER && state.game?.phase !== GAME_PHASES.RESULT)
    });
  }
}

function setLocalInput(action, pressed) {
  state.localInput[action] = pressed;
  renderControlStates();
  send(MSG_TYPES.INPUT, { action, pressed });
}

// Re-send active inputs every 100ms to recover from dropped packets on unstable networks
setInterval(() => {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  const { left, right, jump } = state.localInput;
  if (left)  send(MSG_TYPES.INPUT, { action: 'left',  pressed: true });
  if (right) send(MSG_TYPES.INPUT, { action: 'right', pressed: true });
  if (jump)  send(MSG_TYPES.INPUT, { action: 'jump',  pressed: true });
}, 100);

function bindRunnerControls() {
  dom.controlButtons.forEach((button) => {
    const action = button.dataset.action;
    button.addEventListener("pointerdown", () => setLocalInput(action, true));
    button.addEventListener("pointerup", () => setLocalInput(action, false));
    button.addEventListener("pointercancel", () => setLocalInput(action, false));
    button.addEventListener("lostpointercapture", () => setLocalInput(action, false));
  });
}

dom.joinButton.addEventListener("click", joinRoom);
dom.changeRoomButton.addEventListener("click", leaveRoom);
dom.roomResetRejoin.addEventListener("click", rejoinReplacementRoom);
dom.useRecentRoom.addEventListener("click", () => {
  const recent = normalizeRoomCode(localStorage.getItem(RECENT_ROOM_KEY) || "");
  if (recent) {
    assignRoom(recent);
    render();
  }
});
dom.readyButton.addEventListener("click", () => send(MSG_TYPES.READY));
dom.galleryContinue.addEventListener("click", () => {
  state.highlightOverlay = closeHighlightOverlay(state.highlightOverlay);
  render();
});
dom.micButton.addEventListener("click", startMicrophone);
dom.replayRecordButton?.addEventListener("click", () => {
  void startReplayRecording();
});
dom.replayStopButton?.addEventListener("click", () => {
  const hadRecorder = Boolean(state.replayLab.recorder);
  const hadAnalysis = Boolean(state.replayLab.analyser);
  stopReplayRecording();
  stopReplayAnalysis({ keepFrame: true });
  if (hadRecorder) {
    setReplayStatus("停止錄音，正在整理音檔…");
  } else if (hadAnalysis) {
    setReplayStatus(`已停止回放，已分析 ${state.replayLab.frames.length} 幀`);
  }
});
dom.replayAnalyzeButton?.addEventListener("click", () => {
  void startReplayAnalysis();
});
dom.replayFileInput?.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }
  stopReplayRecording();
  setReplayAudioBlob(file, `已載入 ${file.name}`);
});
dom.cameraToggle.addEventListener("click", () => {
  state.camera.panelExpanded = !state.camera.panelExpanded;
  render();
});
dom.cameraButton.addEventListener("click", startCamera);
dom.environmentSelect.addEventListener("change", applyAttackerSetup);
dom.sensitivitySelect.addEventListener("change", applyAttackerSetup);
dom.gateSlider.addEventListener("input", applyAttackerSetup);
dom.ceilingSlider.addEventListener("input", applyAttackerSetup);
dom.roleButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.viewOverride = null;
    send(MSG_TYPES.SET_ROLE, { role: button.dataset.role });
  });
});
dom.randomNameButton?.addEventListener("click", () => {
  dom.nameInput.value = RANDOM_NAMES[Math.floor(Math.random() * RANDOM_NAMES.length)];
});
dom.diagnosticMarkerButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (!state.diagnostics.enabled) {
      return;
    }
    send(MSG_TYPES.ATTACKER_SETUP, {
      diagnosticsEnabled: true,
      diagnosticsMarker: button.dataset.diagMarker || "未命名標記"
    });
  });
});
dom.runnerReadyBack?.addEventListener("click", () => {
  send(MSG_TYPES.SET_ROLE, { role: null });
  state.viewOverride = "role";
  render();
});
dom.attackerSetupBack?.addEventListener("click", () => {
  send(MSG_TYPES.SET_ROLE, { role: null });
  state.viewOverride = "role";
  stopMicrophoneAndSync({ notifyServer: false });
  render();
});

window.addEventListener("pagehide", () => {
  releaseLocalInputs();
  stopReplayRecording();
  stopReplayAnalysis({ keepFrame: false });
  clearReplayAudioUrl();
  stopMicrophone();
  stopCamera();
  closeSocket();
});

assignRoom(state.roomCode);
dom.nameInput.value = state.playerName;
bindRunnerControls();
render();
