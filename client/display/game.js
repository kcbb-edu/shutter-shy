import * as PIXI from '/pixi/pixi.mjs';
import { CLIENT_TYPES, FACE_STALE_HOLD_MS, GAME_PHASES, HIGHLIGHT_EVENT_PRIORITIES, MAX_HIGHLIGHT_SNAPSHOTS_PER_ROUND, MSG_TYPES, ROLES, WORLD, normalizeRoomCode } from "/shared/protocol.js";
import { summarizeBars } from "/shared/utils.js";

const socketUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
const diagnosticsEnabled = new URLSearchParams(location.search).get("pitchDebug") === "1";
const DISPLAY_KEEPALIVE_MS = 4 * 60 * 1000;
const reconnectState = {
  timer: null,
  attempts: 0
};

const dom = {
  qr: document.getElementById("qr-code"),
  centerCard: document.getElementById("center-card"),
  centerTitle: document.getElementById("center-title"),
  centerSubtitle: document.getElementById("center-subtitle"),
  resultWall: document.getElementById("result-wall"),
  resultEmpty: document.getElementById("result-empty"),
  resultPhotoWall: document.getElementById("result-photo-wall"),
  loadingOverlay: document.getElementById("loading-overlay"),
  loadingTitle: document.getElementById("loading-title"),
  loadingCopy: document.getElementById("loading-copy"),
  timerPill: document.getElementById("timer-pill"),
  timerWhole: document.getElementById("timer-whole"),
  timerFrac: document.getElementById("timer-frac"),
  phaseLabel: document.getElementById("phase-label"),
  playerList: document.getElementById("player-list"),
  setupStatus: document.getElementById("setup-status"),
  eventFeed: document.getElementById("event-feed"),
  newRoomButton: document.getElementById("new-room-button"),
  debugOverlay: document.getElementById("debug-overlay"),
  debugClose: document.getElementById("debug-close"),
  countdownDisplay: document.getElementById("countdown-display"),
  countdownNumber: document.getElementById("countdown-number"),
  debugPlayerDetail: document.getElementById("debug-player-detail"),
  pitchDebugSection: document.getElementById("pitch-debug-section"),
  pitchDebugDetail: document.getElementById("pitch-debug-detail"),
  lobbyOverlay: document.getElementById("lobby-overlay"),
  lobbyRoomCode: document.getElementById("lobby-room-code"),
  lobbySubtitle: document.getElementById("lobby-subtitle"),
  lobbyRoleStatus: document.getElementById("lobby-role-status"),
  lobbyPlayerCount: document.getElementById("lobby-player-count"),
  lobbyHint: document.getElementById("lobby-hint")
};

const state = {
  socket: null,
  desiredRoomCode: normalizeRoomCode(new URLSearchParams(location.search).get("room") || ""),
  room: null,
  game: null,
  highlights: {
    roundId: null,
    items: []
  },
  lastError: "",
  isConnecting: false,
  uiDirty: true,
  uiCache: {
    playerKey: "",
    eventCount: 0,
    lastEventAt: 0,
    setupKey: "",
    timerKey: "",
    centerKey: ""
  },
  capture: {
    sentCount: 0,
    seenEventKeys: new Set(),
    sentCaptureIds: new Set(),
    roundStartCapturedFor: null,
    roundEndCapturedFor: null
  },
  faceImageCache: new Map(),
  playerFaceState: new Map(),
  playerDeathAnim: new Map(),
  seenDeathEventKeys: new Set(),
  attackerAnim: {
    screenX: null,
    headScale: 0.78
  },
  keepaliveTimer: null
};

// ---------- Pixi setup ----------

const app = new PIXI.Application();
await app.init({
  canvas: document.getElementById("pixi-canvas"),
  resizeTo: window,
  autoDensity: true,
  resolution: window.devicePixelRatio || 1,
  antialias: true,
  background: 0x0c0f1e,
});

// Scene layers
const bgGraphics = new PIXI.Graphics();
const blobLayer = new PIXI.Container();
const arenaGraphics = new PIXI.Graphics();
const playerLayer = new PIXI.Container();
const textLayer = new PIXI.Container();
app.stage.addChild(bgGraphics, blobLayer, arenaGraphics, playerLayer, textLayer);

// ---------- Glow blobs ----------

function createSoftCircleTexture() {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx2d = c.getContext("2d");
  const grad = ctx2d.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0,   "rgba(255,255,255,0.75)");
  grad.addColorStop(0.4, "rgba(255,255,255,0.35)");
  grad.addColorStop(0.75,"rgba(255,255,255,0.08)");
  grad.addColorStop(1,   "rgba(255,255,255,0)");
  ctx2d.fillStyle = grad;
  ctx2d.fillRect(0, 0, size, size);
  return PIXI.Texture.from(c);
}

const softTex = createSoftCircleTexture();

// Blob definitions: color, base size (fraction of screen short-side), orbit center, drift speed, phase offset
const BLOB_DEFS = [
  { color: 0xff4e7d, size: 0.72, ox: 0.38, oy: 0.36, speed: 0.00038, phase: 0,    ampReact: 0.55 }, // pink  – reacts most to voice
  { color: 0x7a4bff, size: 0.58, ox: 0.72, oy: 0.60, speed: 0.00028, phase: 2.09, ampReact: 0.28 }, // purple
  { color: 0x4cc9f0, size: 0.50, ox: 0.22, oy: 0.58, speed: 0.00045, phase: 4.19, ampReact: 0.18 }, // cyan
  { color: 0xffcf3d, size: 0.34, ox: 0.62, oy: 0.22, speed: 0.00033, phase: 1.05, ampReact: 0.22 }, // gold
];

const blobs = BLOB_DEFS.map((def) => {
  const sprite = new PIXI.Sprite(softTex);
  sprite.anchor.set(0.5);
  sprite.blendMode = "add";
  sprite.alpha = 0.55;
  sprite.tint = def.color;
  blobLayer.addChild(sprite);
  return { sprite, ...def };
});

function updateBlobs(game) {
  const t = performance.now();
  const w = window.innerWidth;
  const h = window.innerHeight;
  const shortSide = Math.min(w, h);
  const amp = Math.min(1, game?.attackerSetup?.lastAmplitudeNorm ?? 0);
  const isPlaying = game?.phase === GAME_PHASES.PLAYING || game?.phase === GAME_PHASES.COUNTDOWN;

  blobs.forEach((blob, i) => {
    const driftX = Math.sin(t * blob.speed + blob.phase) * w * 0.09;
    const driftY = Math.cos(t * blob.speed * 0.63 + blob.phase + 1.3) * h * 0.07;

    blob.sprite.x = blob.ox * w + driftX;
    blob.sprite.y = blob.oy * h + driftY;

    // Primary blob (pink) pulses hard with amplitude; others follow subtly
    const ampBump = isPlaying ? amp * blob.ampReact : 0;
    const radius = shortSide * blob.size * (1 + ampBump);
    blob.sprite.width = blob.sprite.height = radius * 2;

    // Gently breathe opacity; brighten on voice hit
    const breathe = 0.5 + 0.08 * Math.sin(t * 0.0009 + blob.phase);
    blob.sprite.alpha = breathe + (isPlaying ? amp * 0.32 : 0);
  });
}

// ── Cached FillGradient objects (created once, reused every frame) ──────────
// FillGradient uses normalized 0→1 bounding-box space so these are safe to
// reuse across different-sized rects — no per-frame allocation needed.
const BAR_GRAD_ACTIVE = new PIXI.FillGradient(0, 0, 0, 1);
BAR_GRAD_ACTIVE.addColorStop(0,   0xff5c8a);
BAR_GRAD_ACTIVE.addColorStop(0.6, 0xff3d6e);
BAR_GRAD_ACTIVE.addColorStop(1,   0x7a1832);

const BAR_GRAD_NEIGHBOR = new PIXI.FillGradient(0, 0, 0, 1);
BAR_GRAD_NEIGHBOR.addColorStop(0, 0xff7aa0);
BAR_GRAD_NEIGHBOR.addColorStop(1, 0x3d0e1f);

const BAR_GRAD_INACTIVE = new PIXI.FillGradient(0, 0, 0, 1);
BAR_GRAD_INACTIVE.addColorStop(0,   0xffffff);
BAR_GRAD_INACTIVE.addColorStop(0.5, 0x9090c0);
BAR_GRAD_INACTIVE.addColorStop(1,   0x1a1a3a);

// Per-player Pixi objects: id -> { headContainer, bodyGraphics, headGraphics, faceMask, faceSprite, defaultFaceGraphics, nameText, subtitleText, lastFaceSrc, lastExpression, lastHeadRadius, lastFaceMaskRadius }
const playerObjects = new Map();

function getOrCreatePlayerObjects(player) {
  if (playerObjects.has(player.id)) return playerObjects.get(player.id);

  const headContainer = new PIXI.Container();
  const bodyGraphics = new PIXI.Graphics();
  const headGraphics = new PIXI.Graphics();
  const faceMask = new PIXI.Graphics();
  const faceSprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
  faceSprite.mask = faceMask;
  faceSprite.visible = false;
  const defaultFaceGraphics = new PIXI.Graphics();

  headContainer.addChild(headGraphics, faceMask, faceSprite, defaultFaceGraphics);
  playerLayer.addChild(bodyGraphics, headContainer);

  const nameText = new PIXI.Text({ text: player.name, style: {
    fontSize: 14, fill: 0xf8fafc, fontWeight: "600", fontFamily: "system-ui", align: "center"
  }});
  nameText.anchor.set(0.5, 1);

  const subtitleText = new PIXI.Text({ text: "", style: {
    fontSize: 12, fill: 0xf8fafc, fontWeight: "500", fontFamily: "system-ui", align: "center"
  }});
  subtitleText.anchor.set(0.5, 0);

  textLayer.addChild(nameText, subtitleText);

  const obj = { headContainer, bodyGraphics, headGraphics, faceMask, faceSprite, defaultFaceGraphics, nameText, subtitleText, lastFaceSrc: null, lastExpression: null, lastHeadRadius: -1, lastFaceMaskRadius: -1 };
  playerObjects.set(player.id, obj);
  return obj;
}

// Reusable Set to avoid allocations every frame in prunePlayerObjects
const _activePruneIds = new Set();

// Interpolated display positions for smooth 60fps rendering between 20Hz server ticks
const displayPositions = new Map();
function prunePlayerObjects(activePlayers) {
  if (playerObjects.size === 0) return;
  _activePruneIds.clear();
  for (let i = 0; i < activePlayers.length; i++) _activePruneIds.add(activePlayers[i].id);
  for (const [id, obj] of playerObjects) {
    if (!_activePruneIds.has(id)) {
      playerLayer.removeChild(obj.bodyGraphics, obj.headContainer);
      textLayer.removeChild(obj.nameText, obj.subtitleText);
      obj.bodyGraphics.destroy();
      obj.headContainer.destroy({ children: true });
      obj.nameText.destroy();
      obj.subtitleText.destroy();
      playerObjects.delete(id);
      displayPositions.delete(id);
    }
  }
}

// ---------- Resize / hello ----------

function sendHello() {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({
      type: MSG_TYPES.HELLO,
      payload: {
        clientType: CLIENT_TYPES.DISPLAY,
        roomCode: state.desiredRoomCode,
        aspectRatio: window.innerWidth / Math.max(window.innerHeight, 1)
      }
    }));
  }
}

function redrawBackground(projection) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  bgGraphics.clear();
  const grad = new PIXI.FillGradient(0, 0, 0, 1); // 0→1 = top→bottom of bounding box
  grad.addColorStop(0, 0x1c1028);
  grad.addColorStop(0.55, 0x11172f);
  grad.addColorStop(1, 0x081018);
  bgGraphics.rect(0, 0, w, h).fill(grad);
  if (projection) {
    bgGraphics
      .ellipse(w * 0.5, projection.offsetY + projection.height * 0.28, projection.width * 0.42, projection.height * 0.22)
      .fill({ color: 0xffffff, alpha: 0.04 });
  }
}

// ---------- WebSocket / connect ----------

function setLoading(visible, title = "連線中", copy = "等待房間狀態⋯") {
  dom.loadingOverlay.classList.toggle("hidden", !visible);
  dom.loadingTitle.textContent = title;
  dom.loadingCopy.textContent = copy;
}

function syncRoomCode(roomCode) {
  const normalized = normalizeRoomCode(roomCode);
  state.desiredRoomCode = normalized;
  const url = new URL(location.href);
  if (normalized) {
    url.searchParams.set("room", normalized);
  } else {
    url.searchParams.delete("room");
  }
  history.replaceState({}, "", url);
}

function connect() {
  clearTimeout(reconnectState.timer);
  reconnectState.timer = null;
  state.isConnecting = true;
  setLoading(true, "連線中", "建立房間連線⋯");

  const socket = new WebSocket(socketUrl);
  state.socket = socket;

  socket.addEventListener("open", () => {
    reconnectState.attempts = 0;
    state.isConnecting = false;
    sendHello();
    startKeepaliveLoop();
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === MSG_TYPES.UI_STATE) {
      state.room = message.payload.room;
      syncRoomCode(message.payload.room.roomCode);
      state.lastError = "";
      state.uiDirty = true;
      setLoading(false);
      return;
    }

    if (message.type === MSG_TYPES.GAME_STATE) {
      const incomingGame = message.payload.game;
      if (state.game?.roundId && incomingGame?.roundId && state.game.roundId !== incomingGame.roundId) {
        resetCaptureState();
      }
      if (message.payload.snapshotKind === "full" || !state.game) {
        state.game = incomingGame;
      } else {
        state.game = {
          ...state.game,
          ...incomingGame,
          players: incomingGame.players || state.game.players,
          terrain: {
            ...state.game.terrain,
            ...incomingGame.terrain
          },
          attackerSetup: {
            ...state.game.attackerSetup,
            ...incomingGame.attackerSetup
          },
          recentEvents: incomingGame.recentEvents || state.game.recentEvents
        };
      }
      state.uiDirty = true;
      setLoading(false);
      return;
    }

    if (message.type === MSG_TYPES.HIGHLIGHTS) {
      state.highlights = {
        roundId: message.payload?.roundId || null,
        items: Array.isArray(message.payload?.items) ? message.payload.items : []
      };
      state.uiDirty = true;
      return;
    }

    if (message.type === MSG_TYPES.ROOM_ERROR) {
      state.lastError = message.payload?.message || "Room error";
      setLoading(true, "畫面錯誤", state.lastError);
    }
  });

  socket.addEventListener("close", () => {
    stopKeepaliveLoop();
    if (state.socket === socket) {
      state.socket = null;
    }
    if (document.visibilityState === "hidden") {
      return;
    }
    const delay = Math.min(1000 * 2 ** reconnectState.attempts, 5000);
    reconnectState.attempts += 1;
    setLoading(true, "重新連線中", "正在重新連線⋯");
    reconnectState.timer = setTimeout(connect, delay);
  });

  socket.addEventListener("error", () => {
    socket.close();
  });
}

function sendDisplayKeepalive() {
  if (state.socket?.readyState !== WebSocket.OPEN) {
    return;
  }
  state.socket.send(JSON.stringify({
    type: MSG_TYPES.DISPLAY_KEEPALIVE,
    payload: {
      sentAt: Date.now()
    }
  }));
}

function stopKeepaliveLoop() {
  clearInterval(state.keepaliveTimer);
  state.keepaliveTimer = null;
}

function startKeepaliveLoop() {
  stopKeepaliveLoop();
  sendDisplayKeepalive();
  state.keepaliveTimer = setInterval(() => {
    sendDisplayKeepalive();
  }, DISPLAY_KEEPALIVE_MS);
}

// ---------- UI (DOM) ----------

function formatTimer(game) {
  if (!game) return "--";
  if (game.phase === GAME_PHASES.COUNTDOWN) return game.countdownLeft.toFixed(1);
  return game.timeLeft.toFixed(1);
}

function formatPitchDebug(setup, game) {
  if (!setup) return "等待攻擊者資料";
  const dominantFreq = Number.isFinite(setup.lastDominantBandHz) ? `${Math.round(setup.lastDominantBandHz)} Hz` : "—";
  const amp = Number.isFinite(setup.lastAmplitudeNorm) ? `${Math.round(setup.lastAmplitudeNorm * 100)}%` : "—";
  const range = setup.profileRangeHz
    ? `${Math.round(setup.profileRangeHz.lowHz)}–${Math.round(setup.profileRangeHz.highHz)} Hz`
    : `${setup.expectedCoverage || "fallback"}`;
  const bandIndex = Number.isInteger(setup.lastDominantBandIndex) ? `#${setup.lastDominantBandIndex + 1}` : "—";
  const eqSnapshot = summarizeBars(game?.terrain);
  return [
    `phase: ${formatPhase(game?.phase)}`,
    `calibrationState: ${setup.calibrationState || "—"}`,
    `dominantBandHz: ${dominantFreq}`,
    `activeBand: ${bandIndex}`,
    `lastAmplitudeNorm: ${amp}`,
    `profileRange: ${range}`,
    `voiced: ${setup.voiced ? "yes" : "no"}`,
    `reject: ${setup.lastRejectionReason || "—"}`,
    `coverage: ${setup.expectedCoverage || "—"}`,
    `bars: ${eqSnapshot || "—"}`
  ].join("\n");
}

function formatPhase(phase) {
  switch (phase) {
    case GAME_PHASES.LOBBY: return "大廳";
    case GAME_PHASES.ROLE_SELECT: return "選角";
    case GAME_PHASES.ATTACKER_SETUP: return "魔王設定";
    case GAME_PHASES.WAITING_READY: return "等待準備";
    case GAME_PHASES.COUNTDOWN: return "倒數";
    case GAME_PHASES.PLAYING: return "進行中";
    case GAME_PHASES.RESULT: return "結果";
    default: return phase || "--";
  }
}

function getLobbyHint({ phase, attacker, players }) {
  if (phase === GAME_PHASES.LOBBY || phase === GAME_PHASES.ROLE_SELECT) {
    if (!attacker) return "掃碼加入後先選角色。只有 1 位玩家可以當大魔王，其他玩家都可以當小勇者。";
    return `😈 ${attacker.name} 已成為大魔王，其他玩家請選小勇者並準備。`;
  }
  if (phase === GAME_PHASES.ATTACKER_SETUP) {
    return attacker
      ? `😈 ${attacker.name} 正在設定聲音，其他玩家可先開相機貼紙並準備。`
      : "等待 1 位玩家成為大魔王並完成聲音設定。";
  }
  if (phase === GAME_PHASES.WAITING_READY) {
    const readyCount = players.filter((p) => p.isReady).length;
    return attacker
      ? `😈 ${attacker.name} 已就位，請其餘玩家完成準備。現在已有 ${readyCount} 位玩家準備好。`
      : "等待 1 位玩家成為大魔王，其他玩家可以先加入。";
  }
  return "掃碼加入，立即開始遊戲。";
}

function makeHeartSvg(filled) {
  const fill = filled ? "#ff3d5c" : "rgba(255,255,255,0.15)";
  const stroke = filled ? "#fff" : "rgba(255,255,255,0.2)";
  return `<svg width="15" height="15" viewBox="0 0 20 20">
    <path d="M10 17C10 17,2 12,2 7C2 4,4 2,6 2C8 2,10 4,10 6C10 4,12 2,14 2C16 2,18 4,18 7C18 12,10 17,10 17Z"
      fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>
  </svg>`;
}

function updatePlayerList() {
  const players = state.game?.players || [];
  const playerKey = players.map((p) =>
    `${p.id}:${p.name}:${p.role || ""}:${p.isReady ? "1" : "0"}:${p.livesRemaining ?? "x"}`
  ).join("|");
  if (playerKey === state.uiCache.playerKey) return;
  state.uiCache.playerKey = playerKey;
  dom.playerList.innerHTML = "";
  players.forEach((player) => {
    const lives = player.livesRemaining ?? 3;
    const isAttacker = player.role === ROLES.ATTACKER;
    const card = document.createElement("div");
    card.className = "player-card" + (lives === 0 ? " is-eliminated" : "");
    card.style.setProperty("--player-ring", player.color);
    card.style.setProperty("--player-body", player.color + "44");

    // Avatar circle with mini face
    const avatar = document.createElement("div");
    avatar.className = "player-avatar";
    avatar.style.background = player.color + "33";
    avatar.style.borderColor = "#fff";
    avatar.innerHTML = `<svg viewBox="-20 -20 40 40" width="30" height="30">
      <circle cx="-6" cy="-2" r="2.5" fill="rgba(30,14,50,0.85)"/>
      <circle cx="6" cy="-2" r="2.5" fill="rgba(30,14,50,0.85)"/>
      <path d="M-5 6Q0 10 5 6" fill="none" stroke="rgba(30,14,50,0.85)" stroke-width="2" stroke-linecap="round"/>
    </svg>`;

    // Info
    const info = document.createElement("div");
    info.className = "player-info";

    const nameRow = document.createElement("div");
    nameRow.className = "player-name";
    nameRow.textContent = player.name;

    const heartsRow = document.createElement("div");
    heartsRow.className = "player-hearts";

    if (isAttacker) {
      heartsRow.innerHTML = `<span class="player-role-tag">😈 大魔王</span>`;
    } else {
      const maxLives = 3;
      let heartsHtml = "";
      for (let i = 0; i < maxLives; i++) {
        heartsHtml += makeHeartSvg(i < lives);
      }
      heartsRow.innerHTML = heartsHtml;
    }

    info.append(nameRow, heartsRow);
    card.append(avatar, info);
    dom.playerList.appendChild(card);
  });
}

function updateEventFeed() {
  const events = state.game?.recentEvents || [];
  const lastEventAt = events.length > 0 ? events[events.length - 1].createdAt : 0;
  if (events.length === state.uiCache.eventCount && lastEventAt === state.uiCache.lastEventAt) return;
  state.uiCache.eventCount = events.length;
  state.uiCache.lastEventAt = lastEventAt;
  dom.eventFeed.innerHTML = "";
  if (events.length === 0) {
    const empty = document.createElement("div");
    empty.className = "event-row";
    empty.textContent = "尚無事件。";
    dom.eventFeed.appendChild(empty);
    return;
  }
  events.slice().reverse().forEach((event) => {
    const item = document.createElement("div");
    item.className = "event-row";
    item.textContent = event.message;
    dom.eventFeed.appendChild(item);
  });
}

function updateSetupStatus() {
  const setup = state.game?.attackerSetup;
  const setupKey = setup
    ? `${setup.hasMicPermission ? 1 : 0}:${setup.environmentPreset}:${setup.sensitivityPreset}:${setup.lastDominantBandIndex ?? "x"}:${Math.round((setup.lastAmplitudeNorm || 0) * 100)}`
    : "none";
  if (setupKey === state.uiCache.setupKey) return;
  state.uiCache.setupKey = setupKey;
  if (!setup) { dom.setupStatus.textContent = "等待攻擊者"; return; }
  const mic = setup.hasMicPermission ? "麥克風 OK" : "等待麥克風";
  const roomNoise = setup.environmentPreset === "quiet" ? "安靜房間" : setup.environmentPreset === "noisy" ? "吵鬧房間" : "一般房間";
  const spike = setup.sensitivityPreset === "easy" ? "容易出招" : setup.sensitivityPreset === "loud" ? "需要大聲" : "平衡";
  dom.setupStatus.textContent = `${mic} · 環境 ${roomNoise} · 攻擊 ${spike}`;
}

function updateTimerPanel() {
  const game = state.game;
  const timerKey = `${game?.phase || ""}:${game?.countdownLeft || 0}:${game?.timeLeft || 0}`;
  if (timerKey === state.uiCache.timerKey) return;
  state.uiCache.timerKey = timerKey;

  dom.phaseLabel.textContent = formatPhase(game?.phase);

  const timeStr = formatTimer(game);
  const dotIdx = timeStr.indexOf(".");
  if (dotIdx >= 0) {
    dom.timerWhole.textContent = timeStr.slice(0, dotIdx).padStart(2, "0");
    dom.timerFrac.textContent = "." + timeStr.slice(dotIdx + 1);
  } else {
    dom.timerWhole.textContent = timeStr;
    dom.timerFrac.textContent = "";
  }

  const urgent = game?.phase === GAME_PHASES.PLAYING && (game?.timeLeft ?? 99) < 10;
  dom.timerPill.classList.toggle("urgent", !!urgent);
}

function updateLobbyOverlay() {
  const phase = state.game?.phase;
  const showLobby =
    state.room &&
    state.game &&
    phase !== GAME_PHASES.PLAYING &&
    phase !== GAME_PHASES.COUNTDOWN &&
    phase !== GAME_PHASES.RESULT;

  dom.lobbyOverlay.classList.toggle("hidden", !showLobby);
  if (!showLobby) return;

  const code = state.room.roomCode || "";
  dom.lobbyRoomCode.textContent = code;
  dom.lobbySubtitle.textContent = state.room.joinUrl ? `加入網址：${state.room.joinUrl}` : "";
  dom.qr.src = state.room.qrCodeDataUrl || "";

  const players = state.game.players || [];
  const attacker = players.find((p) => p.role === ROLES.ATTACKER);
  const playerCount = players.length;
  dom.lobbyPlayerCount.textContent = `${playerCount} 位玩家`;
  dom.lobbyHint.textContent = getLobbyHint({ phase, attacker, players });
  if (attacker) {
    dom.lobbyRoleStatus.textContent = `😈 ${attacker.name} 是魔王 · ${playerCount} 位玩家`;
  } else {
    dom.lobbyRoleStatus.textContent = playerCount > 0 ? "⚠️ 還沒有大魔王" : "⚠️ 等待玩家加入";
  }
}

function updateCenterCard() {
  const phase = state.game?.phase;
  const winner = state.game?.winner || "";
  const highlightCount = state.highlights.roundId === state.game?.roundId ? state.highlights.items.length : 0;
  const secondsLeft = phase === GAME_PHASES.RESULT ? Math.ceil(state.game?.timeLeft ?? 0) : 0;
  const centerKey = `${phase || "none"}:${winner}:${state.game?.roundId || ""}:${highlightCount}:${secondsLeft}`;
  if (centerKey === state.uiCache.centerKey) return;
  state.uiCache.centerKey = centerKey;
  dom.resultWall.classList.add("hidden");
  dom.resultPhotoWall.innerHTML = "";
  dom.resultEmpty.classList.add("hidden");

  if (phase !== GAME_PHASES.RESULT) { dom.centerCard.classList.add("hidden"); return; }

  dom.centerCard.classList.remove("hidden");
  dom.centerTitle.textContent = winner === ROLES.ATTACKER ? "聲波大魔王勝利！" : "小勇者存活！";
  dom.centerSubtitle.textContent = secondsLeft > 0 ? `${secondsLeft} 秒後進入下一回合` : "準備進入下一回合⋯";
  dom.resultWall.classList.remove("hidden");
  const items = state.highlights.roundId === state.game.roundId ? state.highlights.items : [];
  dom.resultPhotoWall.classList.toggle("is-single", items.length === 1);
  dom.resultPhotoWall.classList.toggle("is-few", items.length > 1 && items.length <= 3);
  if (items.length === 0) {
    dom.resultEmpty.classList.remove("hidden");
    dom.resultEmpty.textContent = winner === ROLES.ATTACKER ? "擷取勝利畫面中⋯" : "擷取存活畫面中⋯";
  } else {
    dom.resultEmpty.classList.add("hidden");
    items.forEach((item, index) => {
      const card = document.createElement("div");
      card.className = "photo-wall-item";
      card.style.setProperty("--tilt", `${index % 2 === 0 ? -3 : 2}deg`);
      card.style.setProperty("--offset-y", `${index % 2 === 0 ? 0 : 10}px`);
      const frame = document.createElement("div");
      frame.className = "photo-wall-frame";
      const image = document.createElement("img");
      image.src = item.imageBase64;
      image.alt = item.caption || "精彩鏡頭";
      frame.appendChild(image);
      const caption = document.createElement("div");
      caption.className = "photo-wall-caption";
      caption.textContent = item.caption || "精彩鏡頭";
      card.append(frame, caption);
      dom.resultPhotoWall.appendChild(card);
    });
  }
}

function updateCountdownOverlay() {
  const phase = state.game?.phase;
  if (phase !== GAME_PHASES.COUNTDOWN) { dom.countdownDisplay.classList.add("hidden"); return; }
  dom.countdownDisplay.classList.remove("hidden");
  const left = state.game.countdownLeft ?? 0;
  const ceiled = Math.ceil(left);
  const label = left < 0.5 ? "GO！" : String(Math.min(ceiled, 3));
  const cls = left < 0.5 ? "count-go" : `count-${Math.min(ceiled, 3)}`;
  if (dom.countdownNumber.dataset.label !== label) {
    dom.countdownNumber.dataset.label = label;
    dom.countdownNumber.textContent = label;
    dom.countdownNumber.className = `countdown-number ${cls}`;
    dom.countdownNumber.style.animation = "none";
    void dom.countdownNumber.offsetWidth;
    dom.countdownNumber.style.animation = "cd-pop 0.45s cubic-bezier(0.34,1.56,0.64,1) forwards";
  }
}

function updateDebugPlayerDetail() {
  if (!dom.debugPlayerDetail || dom.debugOverlay.classList.contains("hidden")) return;
  const players = state.game?.players || [];
  dom.debugPlayerDetail.innerHTML = players.map((p) =>
    `<div>${p.name} · ${p.role || "未選"} · 已準備：${p.isReady ? "是" : "否"} · 生命：${p.livesRemaining ?? "—"}</div>`
  ).join("") || "<div>無玩家</div>";
}

function updatePitchDebugDetail() {
  if (!dom.pitchDebugSection || !dom.pitchDebugDetail) return;
  const visible = diagnosticsEnabled && !dom.debugOverlay.classList.contains("hidden");
  dom.pitchDebugSection.classList.toggle("hidden", !visible);
  if (!visible) return;
  dom.pitchDebugDetail.textContent = formatPitchDebug(state.game?.attackerSetup, state.game);
}

function renderUi() {
  if (!state.uiDirty) return;
  state.uiDirty = false;
  updateTimerPanel();
  updatePlayerList();
  updateEventFeed();
  updateSetupStatus();
  updateLobbyOverlay();
  updateCenterCard();
  updateCountdownOverlay();
  updateDebugPlayerDetail();
  updatePitchDebugDetail();
}

// ---------- Projection / world → screen ----------

function getProjection(game) {
  const aspect = game?.layout?.gameplayAspectRatio || WORLD.aspectRatio;
  let width = window.innerWidth;
  let height = width / aspect;
  if (height > window.innerHeight) {
    height = window.innerHeight;
    width = height * aspect;
  }
  return {
    width,
    height,
    offsetX: (window.innerWidth - width) / 2,
    offsetY: (window.innerHeight - height) / 2
  };
}

function worldToScreen(game, projection, x, y) {
  const width = game?.layout?.gameplayWidth || 1;
  return {
    x: projection.offsetX + (x / width) * projection.width,
    y: projection.offsetY + y * projection.height
  };
}

// ---------- Arena ----------

function drawArena(game, projection) {
  arenaGraphics.clear();
  const { terrain, layout } = game;
  const edgeZone = layout.edgeZoneWidth;
  const edgeDepth = layout.edgeDropDepth || WORLD.edgeDropDepth;
  const gameplayWidth = layout.gameplayWidth;

  const pLeftEdge  = worldToScreen(game, projection, 0, WORLD.platformY + edgeDepth);
  const pLeftFlat  = worldToScreen(game, projection, edgeZone, WORLD.platformY);
  const pRightFlat = worldToScreen(game, projection, gameplayWidth - edgeZone, WORLD.platformY);
  const pRightEdge = worldToScreen(game, projection, gameplayWidth, WORLD.platformY + edgeDepth);

  // ── Fancy platform slab ──────────────────────────────────────────────────
  const thick = Math.max(10, projection.height * 0.022);
  const platMidX = (pLeftFlat.x + pRightFlat.x) / 2;
  const platFlatW = pRightFlat.x - pLeftFlat.x;

  // A. Underside glow ellipse
  arenaGraphics
    .ellipse(platMidX, pLeftFlat.y + thick * 0.8, platFlatW * 0.72, thick * 1.6)
    .fill({ color: 0xff4e7d, alpha: 0.13 });

  // B. Slab body (filled trapezoid with depth)
  arenaGraphics
    .moveTo(pLeftEdge.x,  pLeftEdge.y)
    .lineTo(pLeftFlat.x,  pLeftFlat.y)
    .lineTo(pRightFlat.x, pRightFlat.y)
    .lineTo(pRightEdge.x, pRightEdge.y)
    .lineTo(pRightEdge.x, pRightEdge.y + thick)
    .lineTo(pRightFlat.x, pRightFlat.y + thick)
    .lineTo(pLeftFlat.x,  pLeftFlat.y + thick)
    .lineTo(pLeftEdge.x,  pLeftEdge.y + thick)
    .closePath()
    .fill({ color: 0x1e1238, alpha: 0.88 });

  // C. Bottom accent stripe (purple underside)
  arenaGraphics
    .moveTo(pLeftEdge.x,  pLeftEdge.y + thick)
    .lineTo(pLeftFlat.x,  pLeftFlat.y + thick)
    .lineTo(pRightFlat.x, pRightFlat.y + thick)
    .lineTo(pRightEdge.x, pRightEdge.y + thick)
    .stroke({ color: 0x7a4bff, alpha: 0.55, width: 2 });

  // D. Top surface bright line
  arenaGraphics
    .moveTo(pLeftEdge.x,  pLeftEdge.y)
    .lineTo(pLeftFlat.x,  pLeftFlat.y)
    .lineTo(pRightFlat.x, pRightFlat.y)
    .lineTo(pRightEdge.x, pRightEdge.y)
    .stroke({ color: 0xffffff, alpha: 0.92, width: 3 });

  // E. Top inner pink glow line (flat section only)
  arenaGraphics
    .moveTo(pLeftFlat.x,  pLeftFlat.y + 3)
    .lineTo(pRightFlat.x, pRightFlat.y + 3)
    .stroke({ color: 0xff4e7d, alpha: 0.38, width: 1.5 });

  // ── EQ terrain bars ──────────────────────────────────────────────────────
  const idleWiggleBase = !Number.isInteger(terrain.activeBandIndex);
  const time = performance.now() / 1000;

  terrain.bars.forEach((bar) => {
    const idleWiggle = idleWiggleBase
      ? (0.006 + (bar.index % 3) * 0.0015) * (0.2 + 0.8 * ((Math.sin(time * 3.1 + bar.index * 0.9) + 1) / 2))
      : 0;
    const displayHeight = Math.max(bar.currentHeight || 0, idleWiggle);
    const topPoint    = worldToScreen(game, projection, bar.startX, terrain.baselineY - displayHeight);
    const bottomPoint = worldToScreen(game, projection, bar.endX,   terrain.baselineY);
    const barW = Math.max(6, bottomPoint.x - topPoint.x - 4);
    const barH = Math.max(4, bottomPoint.y - topPoint.y);
    const bx   = topPoint.x + 2;
    const by   = topPoint.y;
    const isActive   = bar.index === terrain.activeBandIndex;
    const isNeighbor = Number.isInteger(terrain.activeBandIndex) && Math.abs(bar.index - terrain.activeBandIndex) === 1;
    const radius = Math.min(18, barW * 0.28);

    // A. Bloom glow behind active bar
    if (isActive) {
      arenaGraphics
        .roundRect(bx - 6, by - 8, barW + 12, barH + 16, radius + 4)
        .fill({ color: 0xff5c8a, alpha: 0.18 });
    }

    // B. Gradient fill (uses cached gradient objects — no per-frame allocation)
    const grad = isActive ? BAR_GRAD_ACTIVE : isNeighbor ? BAR_GRAD_NEIGHBOR : BAR_GRAD_INACTIVE;
    arenaGraphics.roundRect(bx, by, barW, barH, radius).fill(grad);

    // C. Bright top-cap line on active bar
    if (isActive) {
      arenaGraphics
        .moveTo(bx + radius, by)
        .lineTo(bx + barW - radius, by)
        .stroke({ color: 0xffffff, alpha: 0.9, width: 2 });
    }

    // D. Soft outline on neighbor bars
    if (isNeighbor) {
      arenaGraphics
        .roundRect(bx, by, barW, barH, radius)
        .stroke({ color: 0xff7aa0, alpha: 0.4, width: 1 });
    }
  });
}

// ---------- Face image asset management ----------

function getFaceImageAsset(imageBase64) {
  if (!imageBase64) return null;
  const cached = state.faceImageCache.get(imageBase64);
  if (cached) return cached;
  const image = new Image();
  const asset = { image, status: "loading" };
  image.onload = () => { asset.status = image.naturalWidth > 0 ? "ready" : "error"; };
  image.onerror = () => { asset.status = "error"; };
  image.src = imageBase64;
  if (typeof image.decode === "function") {
    image.decode()
      .then(() => { asset.status = image.naturalWidth > 0 ? "ready" : "error"; })
      .catch(() => { asset.status = image.complete && image.naturalWidth > 0 ? "ready" : "error"; });
  }
  state.faceImageCache.set(imageBase64, asset);
  return asset;
}

function getRenderableFaceAsset(player) {
  const playerState = state.playerFaceState.get(player.id) || {
    currentSrc: null, currentAsset: null, pendingSrc: null, pendingAsset: null
  };
  const snapshotSrc = player.faceSnapshot?.imageBase64 || null;

  if (!snapshotSrc) {
    playerState.pendingSrc = null;
    playerState.pendingAsset = null;
    state.playerFaceState.set(player.id, playerState);
    return playerState.currentAsset;
  }

  if (playerState.currentSrc === snapshotSrc && playerState.currentAsset?.status === "ready") {
    state.playerFaceState.set(player.id, playerState);
    return playerState.currentAsset;
  }

  if (playerState.pendingSrc !== snapshotSrc) {
    playerState.pendingSrc = snapshotSrc;
    playerState.pendingAsset = getFaceImageAsset(snapshotSrc);
  }

  if (playerState.pendingAsset?.status === "ready") {
    playerState.currentSrc = playerState.pendingSrc;
    playerState.currentAsset = playerState.pendingAsset;
    playerState.pendingSrc = null;
    playerState.pendingAsset = null;
  }

  state.playerFaceState.set(player.id, playerState);
  return playerState.currentAsset;
}

// ---------- Player drawing ----------

function drawDefaultFaceOnGraphics(g, radius, color, expression = "happy") {
  g.clear();
  const colorNum = parseInt(color.replace("#", ""), 16);
  g.circle(0, 0, radius * 0.9).fill({ color: colorNum, alpha: 0.12 });

  const lw = Math.max(2, radius * 0.07);
  const ex = radius * 0.22;
  const ey = -radius * 0.08;
  const fc = 0x2a1d3e; // face color

  if (expression === "ko") {
    const s = radius * 0.11;
    [-ex, ex].forEach((cx) => {
      g.moveTo(cx - s, ey - s).lineTo(cx + s, ey + s).stroke({ color: fc, width: lw, cap: "round" });
      g.moveTo(cx + s, ey - s).lineTo(cx - s, ey + s).stroke({ color: fc, width: lw, cap: "round" });
    });
    g.moveTo(-radius * 0.2, radius * 0.24).lineTo(radius * 0.2, radius * 0.24)
      .stroke({ color: fc, width: lw, cap: "round" });

  } else if (expression === "scared") {
    // Big round eyes + highlight dot
    g.circle(-ex, ey, radius * 0.13).fill(fc);
    g.circle(ex, ey, radius * 0.13).fill(fc);
    g.circle(-ex + radius * 0.05, ey - radius * 0.04, radius * 0.045).fill({ color: 0xffffff, alpha: 0.65 });
    g.circle(ex + radius * 0.05, ey - radius * 0.04, radius * 0.045).fill({ color: 0xffffff, alpha: 0.65 });
    // D-shaped open mouth (bottom half arc, filled)
    g.arc(0, radius * 0.18, radius * 0.17, Math.PI, 0).fill({ color: fc, alpha: 0.9 });

  } else if (expression === "shocked") {
    // Ring eyes
    g.circle(-ex, ey, radius * 0.12).stroke({ color: fc, width: lw });
    g.circle(ex, ey, radius * 0.12).stroke({ color: fc, width: lw });
    g.circle(-ex, ey, radius * 0.04).fill(fc);
    g.circle(ex, ey, radius * 0.04).fill(fc);
    // O mouth
    g.circle(0, radius * 0.22, radius * 0.12).stroke({ color: fc, width: lw });

  } else {
    // happy — filled dot eyes + quadratic bezier smile (matches design reference)
    g.circle(-ex, ey, radius * 0.09).fill(fc);
    g.circle(ex, ey, radius * 0.09).fill(fc);
    g.moveTo(-radius * 0.22, radius * 0.14)
      .quadraticCurveTo(0, radius * 0.42, radius * 0.22, radius * 0.14)
      .stroke({ color: fc, width: lw * 1.2, cap: "round" });
  }
}

function drawBodyOnGraphics(g, scale, color, isAttacker, animT = 0) {
  g.clear();
  const colorNum = parseInt(color.replace("#", ""), 16);
  const lw = Math.max(3, scale * 0.08);

  // Key y-positions — all upward from feet at (0,0)
  const footSpread = scale * 0.10;
  const hipY       = -scale * 0.38;
  const shoulderY  = -scale * 0.66;

  // Arm swing idle animation
  const swing = Math.sin(animT * 2.2) * 0.18;

  // Feet ellipses
  g.ellipse(-footSpread, -scale * 0.04, scale * 0.13, scale * 0.06).fill({ color: colorNum });
  g.ellipse( footSpread + scale * 0.02, -scale * 0.04, scale * 0.14, scale * 0.06).fill({ color: colorNum });

  // Legs + torso + arms
  g.moveTo(-footSpread + scale * 0.04, 0).lineTo(-scale * 0.06, hipY)
   .moveTo( footSpread - scale * 0.04, 0).lineTo( scale * 0.06, hipY)
   .moveTo(0, hipY).lineTo(0, shoulderY)
   .moveTo(0, shoulderY).lineTo(-scale * 0.24 - swing * scale * 0.08, shoulderY + scale * 0.24)
   .moveTo(0, shoulderY).lineTo( scale * 0.24 + swing * scale * 0.08, shoulderY + scale * 0.24)
   .stroke({ color: colorNum, width: lw, cap: "round", join: "round" });

  if (isAttacker) {
    // Magic orb on right hand
    g.circle(scale * 0.28 + swing * scale * 0.08, shoulderY + scale * 0.22, scale * 0.09)
     .fill({ color: 0xffffff, alpha: 0.22 });
  }
}

function getPlayerExpression(player, game) {
  if (player.livesRemaining === 0) return "ko";
  const deathAnim = state.playerDeathAnim.get(player.id);
  if (deathAnim && deathAnim.zoom > 1.05) return "shocked";
  if (game.phase === GAME_PHASES.PLAYING && player.livesRemaining === 1) return "scared";
  return "happy";
}

function tickDeathAnims(game) {
  const recentEvents = game.recentEvents || [];
  recentEvents.forEach((event) => {
    if (event.kind !== "wave" && event.kind !== "fall" && event.kind !== "out") return;
    const key = `${game.roundId}:${event.playerId}:${event.createdAt}`;
    if (state.seenDeathEventKeys.has(key)) return;
    state.seenDeathEventKeys.add(key);
    state.playerDeathAnim.set(event.playerId, { zoom: 2.4, decayRate: 0.025 });
  });
}

function updatePlayers(game, projection) {
  tickDeathAnims(game);
  prunePlayerObjects(game.players);
  const setup = game.attackerSetup;

  game.players.forEach((player) => {
    const obj = getOrCreatePlayerObjects(player);

    // Lerp display position toward server position for smooth 60fps animation
    let dp = displayPositions.get(player.id);
    if (!dp) {
      dp = { x: player.x, y: player.y };
      displayPositions.set(player.id, dp);
    } else {
      const LERP = 0.38;
      dp.x += (player.x - dp.x) * LERP;
      // Snap Y immediately when grounded to avoid floating above platform
      dp.y = player.isGrounded ? player.y : dp.y + (player.y - dp.y) * LERP;
    }

    const basePoint = worldToScreen(game, projection, dp.x, dp.y);
    const isAttacker = player.role === ROLES.ATTACKER;
    const scale = projection.height * (isAttacker ? 0.11 : 0.095);

    let drawX = basePoint.x;
    let headRadiusMult = isAttacker ? 0.78 : 0.72;
    const expression = isAttacker ? "happy" : getPlayerExpression(player, game);

    if (isAttacker && setup) {
      const bandIndex = setup.lastDominantBandIndex;
      const amp = Math.min(1, setup.lastAmplitudeNorm ?? 0);
      const bars = game.terrain?.bars;
      const targetBar = Number.isInteger(bandIndex) && bars ? bars[bandIndex] : null;
      if (targetBar) {
        const targetX = worldToScreen(game, projection, (targetBar.startX + targetBar.endX) / 2, dp.y).x;
        if (state.attackerAnim.screenX === null) {
          state.attackerAnim.screenX = targetX;
        } else {
          state.attackerAnim.screenX += (targetX - state.attackerAnim.screenX) * 0.12;
        }
      }
      if (state.attackerAnim.screenX === null) state.attackerAnim.screenX = basePoint.x;

      const targetScale = 0.78 + amp * 0.75;
      const lerpFactor = targetScale > state.attackerAnim.headScale ? 0.45 : 0.08;
      state.attackerAnim.headScale += (targetScale - state.attackerAnim.headScale) * lerpFactor;
      headRadiusMult = state.attackerAnim.headScale;

      drawX = state.attackerAnim.screenX;
    }

    const deathAnim = state.playerDeathAnim.get(player.id);
    if (deathAnim) {
      headRadiusMult *= deathAnim.zoom;
      deathAnim.zoom = 1 + (deathAnim.zoom - 1) * (1 - deathAnim.decayRate);
      if (deathAnim.zoom < 1.01) state.playerDeathAnim.delete(player.id);
    }

    const headRadius = scale * headRadiusMult;
    const headX = drawX;

    // Feet anchored to the bottom of the player bounding box (= platformY)
    const feetPoint = worldToScreen(game, projection, dp.x, dp.y + WORLD.playerHeight / 2);
    const animT = performance.now() / 1000;
    const phaseOff = ((player.id.charCodeAt(0) || 0) + (player.id.charCodeAt(1) || 0)) * 0.5;
    const idleBob = isAttacker ? 0 : Math.sin(animT * 2.2 + phaseOff) * 2.5;
    const feetY = feetPoint.y + idleBob;

    const headY = feetY - scale * 0.66 - headRadius;

    // Body (drawn upward from feet at origin)
    obj.bodyGraphics.position.set(drawX, feetY);
    drawBodyOnGraphics(obj.bodyGraphics, scale, player.color, isAttacker, animT + phaseOff);

    // Head container
    obj.headContainer.position.set(headX, headY);

    // Head circle — only redraw when radius changes meaningfully
    const headRadiusChanged = Math.abs(headRadius - obj.lastHeadRadius) > 0.5;
    if (headRadiusChanged) {
      obj.lastHeadRadius = headRadius;
      const colorNum = parseInt(player.color.replace("#", ""), 16);
      obj.headGraphics.clear();
      obj.headGraphics.circle(headRadius * 0.03, headRadius * 0.08, headRadius * 1.02)
        .fill({ color: 0x000000, alpha: 0.18 });
      obj.headGraphics.circle(0, 0, headRadius).fill({ color: 0xfff7ee });
      obj.headGraphics.circle(0, 0, headRadius)
        .stroke({ color: colorNum, width: Math.max(4, headRadius * 0.09) });
    }

    // Face
    const snapshot = player.faceSnapshot;
    const isFresh = snapshot?.capturedAt && Date.now() - snapshot.capturedAt <= FACE_STALE_HOLD_MS;
    const asset = isFresh ? getRenderableFaceAsset(player) : null;

    if (asset?.status === "ready" && asset.image?.naturalWidth > 0) {
      // Update texture only when face src changes
      const faceSrc = player.faceSnapshot.imageBase64;
      const faceSrcChanged = obj.lastFaceSrc !== faceSrc;
      if (faceSrcChanged) {
        obj.lastFaceSrc = faceSrc;
        const tex = PIXI.Texture.from(asset.image);
        obj.faceSprite.texture = tex;
      }
      // Reposition + resize when radius OR face first appears (faceSrcChanged covers first load)
      if (headRadiusChanged || faceSrcChanged) {
        obj.faceSprite.position.set(-headRadius, -headRadius);
        obj.faceSprite.width = headRadius * 2;
        obj.faceSprite.height = headRadius * 2;
        obj.faceMask.clear().circle(0, 0, headRadius).fill(0xffffff);
        obj.lastFaceMaskRadius = headRadius;
      }
      obj.faceSprite.visible = true;
      if (obj.defaultFaceGraphics.visible) {
        obj.defaultFaceGraphics.clear();
        obj.defaultFaceGraphics.visible = false;
      }
    } else {
      if (obj.faceSprite.visible) obj.faceSprite.visible = false;
      obj.defaultFaceGraphics.visible = true;
      obj.defaultFaceGraphics.position.set(0, 0);
      // Only redraw face when expression or size changes
      if (expression !== obj.lastExpression || headRadiusChanged) {
        obj.lastExpression = expression;
        drawDefaultFaceOnGraphics(obj.defaultFaceGraphics, headRadius, player.color, expression);
      }
    }

    // Name + subtitle text
    obj.nameText.text = player.name;
    obj.nameText.position.set(headX, headY - headRadius - 6);

    const subtitle = isAttacker ? "大魔王" : `${player.livesRemaining} 條命`;
    obj.subtitleText.text = subtitle;
    obj.subtitleText.position.set(drawX, feetY + 10);
  });
}

// ---------- Capture / screenshot ----------

function resetCaptureState() {
  state.capture.sentCount = 0;
  state.capture.seenEventKeys = new Set();
  state.capture.sentCaptureIds = new Set();
  state.capture.roundStartCapturedFor = null;
  state.capture.roundEndScheduledFor = null;
  state.faceImageCache.clear();
  state.playerFaceState.clear();
  state.playerDeathAnim.clear();
  state.seenDeathEventKeys.clear();
  state.attackerAnim.screenX = null;
  state.attackerAnim.headScale = 0.78;
}

function makeCaptureKey(eventType, captureId) {
  return `${state.game?.roundId || "round"}:${eventType}:${captureId}`;
}

function exportFullscreenCapture({ captureId, caption, eventType = "round-end", capturedAt = Date.now(), imageBase64 = null }) {
  if (imageBase64) {
    return {
      captureId, caption, eventType, capturedAt,
      filename: `waveform-attack-${state.room?.roomCode || "room"}-${state.game.roundId.slice(0, 8)}-${captureId}.jpg`,
      imageBase64
    };
  }
  const sourceCanvas = app.renderer.extract.canvas(app.stage);
  const sourceWidth = sourceCanvas.width;
  const sourceHeight = sourceCanvas.height;
  const targetWidth = Math.min(sourceWidth, 1280);
  const targetHeight = Math.max(1, Math.round((sourceHeight / sourceWidth) * targetWidth));
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = targetWidth;
  exportCanvas.height = targetHeight;
  const exportCtx = exportCanvas.getContext("2d");
  exportCtx.drawImage(sourceCanvas, 0, 0, sourceWidth, sourceHeight, 0, 0, targetWidth, targetHeight);
  return {
    captureId, caption, eventType, capturedAt,
    filename: `waveform-attack-${state.room?.roomCode || "room"}-${state.game.roundId.slice(0, 8)}-${captureId}.jpg`,
    imageBase64: exportCanvas.toDataURL("image/jpeg", 0.88)
  };
}

function sendCapture(captureId, eventType, buildPayload, delayMs = 0) {
  const captureKey = makeCaptureKey(eventType, captureId);
  if (state.capture.sentCaptureIds.has(captureKey) || state.capture.sentCount >= MAX_HIGHLIGHT_SNAPSHOTS_PER_ROUND) return;
  state.capture.sentCaptureIds.add(captureKey);
  state.capture.sentCount += 1;
  const roundId = state.game?.roundId;
  setTimeout(() => {
    if (state.socket?.readyState !== WebSocket.OPEN || !roundId) return;
    const payload = buildPayload();
    state.socket.send(JSON.stringify({ type: MSG_TYPES.DISPLAY_CAPTURE, payload: { roundId, ...payload } }));
  }, delayMs);
}

function getEventPriority(eventType) { return HIGHLIGHT_EVENT_PRIORITIES[eventType] || 0; }

function mapEventType(event) {
  if (event.kind === "wave" || event.kind === "fall") return "life-lost";
  if (event.kind === "out") return "player-out";
  return "round-event";
}

function buildEventCaption(event, eventType) {
  switch (eventType) {
    case "player-out": return "Player out";
    case "life-lost": return "Life lost";
    default: return "Highlight event";
  }
}

function maybeScheduleHighlightBursts(game) {
  if (state.socket?.readyState !== WebSocket.OPEN || !game) return;
  if (game.phase === GAME_PHASES.PLAYING && state.capture.roundStartCapturedFor !== game.roundId) {
    state.capture.roundStartCapturedFor = game.roundId;
    const rsId = `round-start-${game.roundId}`;
    sendCapture(rsId, "round-start", () =>
      exportFullscreenCapture({ captureId: rsId, caption: "回合開始", eventType: "round-start", capturedAt: Date.now() }),
      800
    );
  }
  const recentEvents = game.recentEvents || [];
  recentEvents.forEach((event) => {
    const eventType = mapEventType(event);
    if (!["life-lost", "player-out"].includes(eventType)) return;
    const eventKey = `${game.roundId}:${event.playerId || "player"}:${eventType}:${event.createdAt}`;
    if (state.capture.seenEventKeys.has(eventKey)) return;
    if (eventType === "player-out") {
      state.capture.seenEventKeys.add(`${game.roundId}:${event.playerId || "player"}:life-lost:${event.createdAt}`);
    }
    state.capture.seenEventKeys.add(eventKey);
    const evId = `${eventType}-${event.playerId || "player"}-${event.createdAt}`;
    const evCaption = buildEventCaption(event, eventType);
    const evCapturedAt = event.createdAt;
    const captureDelay = eventType === "life-lost" || eventType === "player-out" ? 400 : 0;
    sendCapture(evId, eventType, () =>
      exportFullscreenCapture({ captureId: evId, caption: evCaption, eventType, capturedAt: evCapturedAt }),
      captureDelay
    );
  });

  if (game.phase === GAME_PHASES.RESULT && state.capture.roundEndScheduledFor !== game.roundId) {
    state.capture.roundEndScheduledFor = game.roundId;
    let hasDeathHighlight = false;
    for (const k of state.capture.sentCaptureIds) {
      if (k.includes(":life-lost:") || k.includes(":player-out:")) { hasDeathHighlight = true; break; }
    }
    if (!hasDeathHighlight) {
      const reId = `round-end-${game.roundId}`;
      sendCapture(reId, "round-end", () =>
        exportFullscreenCapture({ captureId: reId, caption: "回合結束", eventType: "round-end", capturedAt: Date.now() })
      );
    }
  }
}

// ---------- Event handlers ----------

dom.newRoomButton.addEventListener("click", () => {
  if (state.socket?.readyState !== WebSocket.OPEN) return;
  setLoading(true, "建立新房間", "關閉舊房間，準備新加入畫面⋯");
  state.socket.send(JSON.stringify({ type: MSG_TYPES.DISPLAY_NEW_ROOM, payload: {} }));
});

window.addEventListener("resize", () => {
  sendHello();
  state.uiDirty = true;
});

window.addEventListener("pagehide", () => {
  state.socket?.close();
});

document.getElementById("debug-toggle").addEventListener("click", () => {
  dom.debugOverlay.classList.toggle("hidden");
  state.uiDirty = true;
});

dom.debugClose?.addEventListener("click", () => {
  dom.debugOverlay.classList.add("hidden");
  state.uiDirty = true;
});

// ---------- Main loop ----------

let bgNeedsRedraw = true;
let lastProjectionKey = "";

app.ticker.add(() => {
  renderUi();
  const game = state.game;
  const projection = getProjection(game);

  // Redraw background only when projection changes (resize or first frame)
  const projKey = `${projection.width}|${projection.height}|${projection.offsetX}|${projection.offsetY}`;
  if (bgNeedsRedraw || projKey !== lastProjectionKey) {
    lastProjectionKey = projKey;
    bgNeedsRedraw = false;
    redrawBackground(projection);
  }

  updateBlobs(game);
  if (game) {
    drawArena(game, projection);
    updatePlayers(game, projection);
    maybeScheduleHighlightBursts(game);
  }
});

window.addEventListener("resize", () => { bgNeedsRedraw = true; });

connect();
window.addEventListener("beforeunload", stopKeepaliveLoop);
sendHello();
