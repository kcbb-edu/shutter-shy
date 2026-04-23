import * as THREE from "three";
import { ArenaView } from "../common/scene";
import { CLIENT_TYPES, DEFAULT_ARENA_THEME_ID, GAME_PHASES, MSG_TYPES } from "../../shared/protocol.js";
import { COPY, formatRoleLabel, formatWinnerTitle } from "../../shared/copy.js";

const socketUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

const elements = {
  canvas: document.getElementById("display-canvas") as HTMLCanvasElement,
  lobbyCard: document.getElementById("lobby-card") as HTMLElement,
  roundCard: document.getElementById("round-card") as HTMLElement,
  playersCard: document.getElementById("players-card") as HTMLElement,
  roomCode: document.getElementById("room-code") as HTMLElement,
  phaseCopy: document.getElementById("phase-copy") as HTMLElement,
  qrCode: document.getElementById("qr-code") as HTMLImageElement,
  players: document.getElementById("players") as HTMLElement,
  timerPill: document.getElementById("timer-pill") as HTMLElement,
  scoreCopy: document.getElementById("score-copy") as HTMLElement,
  newRoomButton: document.getElementById("new-room-button") as HTMLButtonElement,
  resultsOverlay: document.getElementById("results-overlay") as HTMLElement,
  resultsCard: document.getElementById("results-card") as HTMLElement,
  resultsTitle: document.getElementById("results-title") as HTMLElement,
  resultsCopy: document.getElementById("results-copy") as HTMLElement,
  resultsCountdown: document.getElementById("results-countdown") as HTMLElement,
  runnerSummaryGrid: document.getElementById("runner-summary-grid") as HTMLElement,
  countdownOverlay: document.getElementById("countdown-overlay") as HTMLElement,
  countdownNumber: document.getElementById("countdown-number") as HTMLElement
};

const view = new ArenaView(elements.canvas, "spectator");
view.setActive(true);

const state = {
  room: null as any,
  lobby: null as any,
  round: null as any,
  gallery: null as any,
  socket: null as WebSocket | null,
  lastShutterSequence: 0,
  audioContext: null as AudioContext | null
};
let debugVisible = false;
let debugRafId = 0;

function connect() {
  const socket = new WebSocket(socketUrl);
  state.socket = socket;
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({
      type: MSG_TYPES.HELLO,
      payload: {
        clientType: CLIENT_TYPES.DISPLAY
      }
    }));
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type === MSG_TYPES.ROOM_STATE) {
      state.room = message.payload.room;
      view.setTheme(state.room?.resolvedTheme);
      render();
    }
    if (message.type === MSG_TYPES.LOBBY_STATE) {
      state.lobby = message.payload;
      view.setTheme(state.lobby?.resolvedTheme);
      render();
    }
    if (message.type === MSG_TYPES.ROUND_STATE) {
      state.round = message.payload;
      view.setTheme(state.round?.resolvedTheme);
      view.setRoundState(state.round);
      if (state.round?.shutterSequence > state.lastShutterSequence) {
        state.lastShutterSequence = state.round.shutterSequence;
        playShutterCue();
      }
      render();
    }
    if (message.type === MSG_TYPES.GALLERY_STATE) {
      state.gallery = message.payload;
      render();
    }
    if (message.type === MSG_TYPES.ROOM_CLOSED) {
      state.room = null;
      state.lobby = null;
      state.round = null;
      state.gallery = null;
      view.setTheme(DEFAULT_ARENA_THEME_ID);
      render();
    }
  });

  socket.addEventListener("close", () => {
    window.setTimeout(connect, 800);
  });
}

function ensureAudioContext() {
  if (!state.audioContext) {
    state.audioContext = new AudioContext();
  }
  return state.audioContext;
}

function playShutterCue() {
  if (!state.round || state.round.phase !== GAME_PHASES.PLAYING) {
    return;
  }
  const audioContext = ensureAudioContext();
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(920, audioContext.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(460, audioContext.currentTime + 0.08);
  gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.16, audioContext.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.11);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + 0.12);
}

function renderPlayers() {
  const players = state.lobby?.players || [];
  elements.players.innerHTML = "";
  if (players.length === 0) {
    elements.players.innerHTML = `<div class="empty-state">${COPY.display.playersEmpty}</div>`;
    return;
  }
  for (const player of players) {
    const card = document.createElement("div");
    card.className = "player-chip";
    card.innerHTML = `
      <div>
        <strong>${player.name}</strong>
        <div class="status-copy">${formatRoleLabel(player.role)} · ${player.connected ? COPY.common.online : COPY.common.offline}</div>
      </div>
      <div class="badge">${player.ready ? COPY.common.ready : `${player.loadProgress}%`}</div>
    `;
    elements.players.append(card);
  }
}

function renderResultCards() {
  const groups = state.gallery?.runnerGroups || [];
  elements.runnerSummaryGrid.innerHTML = "";
  elements.runnerSummaryGrid.classList.toggle("fewer-than-three", groups.length > 0 && groups.length < 3);
  elements.runnerSummaryGrid.style.setProperty("--runner-count", String(groups.length || 1));
  if (groups.length === 0) {
    elements.runnerSummaryGrid.innerHTML = `<div class="empty-state">${COPY.display.runnerSummaryEmpty}</div>`;
    return;
  }
  for (const entry of groups) {
    const card = document.createElement("article");
    card.className = "runner-summary-card";
    const photos = (entry.photos || []).slice(0, 3);
    const photoMarkup = photos.length
      ? photos.map((photo: any, index: number) => `
          <figure class="result-photo" style="--photo-index:${index};--photo-count:${photos.length}">
            <img src="${photo.imageDataUrl}" alt="${entry.name} 的照片" />
          </figure>
        `).join("")
      : "";
    const faceMarkup = entry.faceImageDataUrl
      ? `<img src="${entry.faceImageDataUrl}" alt="${entry.name} 的臉部照片" />`
      : `<span class="emoji">${entry.fallbackEmoji || "🙂"}</span>`;
    card.innerHTML = `
      <div class="result-fan-shell">
        ${photoMarkup ? `<div class="result-fan">${photoMarkup}</div>` : `<div class="result-fan empty"></div>`}
        <div class="result-face">${faceMarkup}</div>
      </div>
      <div class="meta">
        <strong>${entry.name}</strong>
        <div class="status-copy">${entry.captured ? COPY.display.successfulPhotos(photos.length) : COPY.display.noSuccessfulPhotos}</div>
        <div class="result-verdict ${entry.captured ? "good" : "bad"}">${entry.captured ? "✓" : "✕"}</div>
      </div>
    `;
    elements.runnerSummaryGrid.append(card);
  }
}

function render() {
  elements.roomCode.textContent = state.room?.roomCode || "----";
  elements.qrCode.src = state.room?.qrCodeDataUrl || "";
  const phase = state.round?.phase || state.room?.phase || GAME_PHASES.LOBBY;
  const isCountdown = phase === GAME_PHASES.COUNTDOWN;
  const isPlaying = phase === GAME_PHASES.PLAYING;
  const isResults = phase === GAME_PHASES.RESULTS;
  const isLiveArena = isCountdown || isPlaying;
  const timerValue = phase === GAME_PHASES.COUNTDOWN
    ? state.round?.countdownLeft ?? 3
    : phase === GAME_PHASES.RESULTS
      ? state.round?.resultsTimeLeft ?? 10
      : state.round?.timeLeft ?? 30;
  elements.timerPill.textContent = Number(timerValue).toFixed(phase === GAME_PHASES.PLAYING || phase === GAME_PHASES.RESULTS ? 1 : 0);
  elements.scoreCopy.textContent = COPY.display.scoreCopy(
    state.round?.capturedRunnerIds?.length || 0,
    state.gallery?.runnerSummary?.length || 3
  );
  const resultsReview = state.round?.galleryReview || state.gallery?.galleryReview || { closedCount: 0, totalCount: 0 };

  if (isResults) {
    elements.phaseCopy.textContent = COPY.display.reviewingResults;
    elements.resultsOverlay.classList.remove("hidden");
    elements.resultsTitle.textContent = formatWinnerTitle(state.round?.winner);
    elements.resultsCopy.textContent = COPY.display.closeGalleryProgress(
      resultsReview.closedCount,
      resultsReview.totalCount || 0
    );
    elements.resultsCountdown.textContent = `${Math.max(0, Math.ceil(state.round?.resultsTimeLeft || 0))}s`;
  } else {
    elements.resultsOverlay.classList.add("hidden");
    elements.phaseCopy.textContent = phase === GAME_PHASES.PLAYING
      ? COPY.display.playingPhase
      : COPY.display.lobbyPhase;
  }

  elements.lobbyCard.classList.toggle("hidden", isResults || isLiveArena);
  elements.playersCard.classList.toggle("hidden", isResults || isLiveArena);
  elements.roundCard.classList.toggle("hidden", isResults);

  elements.countdownOverlay.classList.toggle("hidden", !isCountdown);
  elements.countdownNumber.textContent = String(state.round?.countdownLeft ?? 3);

  renderPlayers();
  renderResultCards();
}

elements.newRoomButton.addEventListener("click", () => {
  state.socket?.send(JSON.stringify({ type: MSG_TYPES.DISPLAY_NEW_ROOM, payload: {} }));
});

window.addEventListener("pointerdown", () => {
  if (state.audioContext?.state === "suspended") {
    state.audioContext.resume();
  }
});

const overlayCanvas = document.createElement("canvas");
overlayCanvas.style.cssText = [
  "position:absolute", "inset:0", "width:100%", "height:100%",
  "pointer-events:none", "z-index:10"
].join(";");
elements.canvas.parentElement!.appendChild(overlayCanvas);

function f2(n: number) { return n.toFixed(2); }

function getScreenGeometry(points: Array<{ x: number; y: number; z: number }>) {
  const projectedPoints = points
    .map((point) => view.worldToScreen(point.x, point.y, point.z))
    .filter((point) => point.inFront)
    .map((point) => ({ x: point.screenX, y: point.screenY }));

  if (!projectedPoints.length) {
    return null;
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of projectedPoints) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }

  return {
    points: projectedPoints,
    bounds: {
      minX,
      maxX,
      minY,
      maxY,
      width: maxX - minX,
      height: maxY - minY,
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2
    }
  };
}

function getArenaScreenGeometry() {
  return getScreenGeometry(view.spectatorFrameGeometry.meshPoints);
}

function getAllowanceScreenGeometry() {
  return getScreenGeometry(view.spectatorFrameGeometry.allowancePoints);
}

function getConvexHull(points: Array<{ x: number; y: number }>) {
  if (points.length <= 1) {
    return points;
  }

  const sorted = [...points].sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const cross = (origin: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);

  const lower: Array<{ x: number; y: number }> = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper: Array<{ x: number; y: number }> = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function drawViewportOverlay() {
  const cssW = view.canvas.clientWidth || window.innerWidth;
  const cssH = view.canvas.clientHeight || window.innerHeight;
  const viewport = view.getDisplayViewportCss();
  const dpr = window.devicePixelRatio || 1;
  overlayCanvas.width = cssW * dpr;
  overlayCanvas.height = cssH * dpr;
  const ctx = overlayCanvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  if (!debugVisible) {
    return;
  }

  const arenaGeometry = getArenaScreenGeometry();
  if (!arenaGeometry) {
    return;
  }
  const allowanceGeometry = getAllowanceScreenGeometry();
  const arenaBounds = arenaGeometry.bounds;
  const arenaHull = getConvexHull(arenaGeometry.points);
  const allowanceHull = allowanceGeometry ? getConvexHull(allowanceGeometry.points) : [];

  const centerX = cssW / 2;
  const centerY = cssH / 2;

  if (viewport.width < cssW || viewport.height < cssH) {
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    ctx.setLineDash([10, 8]);
    ctx.strokeRect(viewport.x, viewport.y, viewport.width, viewport.height);
    ctx.setLineDash([]);
  }

  ctx.strokeStyle = "rgba(255,255,0,0.75)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(centerX - 18, centerY); ctx.lineTo(centerX + 18, centerY); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(centerX, centerY - 18); ctx.lineTo(centerX, centerY + 18); ctx.stroke();

  if (allowanceHull.length >= 2) {
    ctx.strokeStyle = "rgba(80,220,255,0.55)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(allowanceHull[0].x, allowanceHull[0].y);
    for (let index = 1; index < allowanceHull.length; index += 1) {
      ctx.lineTo(allowanceHull[index].x, allowanceHull[index].y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (arenaHull.length >= 2) {
    ctx.strokeStyle = "rgba(120,255,120,0.98)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(arenaHull[0].x, arenaHull[0].y);
    for (let index = 1; index < arenaHull.length; index += 1) {
      ctx.lineTo(arenaHull[index].x, arenaHull[index].y);
    }
    ctx.closePath();
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(120,255,120,0.98)";
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(arenaBounds.centerX - 16, arenaBounds.centerY); ctx.lineTo(arenaBounds.centerX + 16, arenaBounds.centerY); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(arenaBounds.centerX, arenaBounds.centerY - 16); ctx.lineTo(arenaBounds.centerX, arenaBounds.centerY + 16); ctx.stroke();
}

window.addEventListener("resize", drawViewportOverlay);

const debugToggle = document.createElement("button");
debugToggle.style.cssText = [
  "position:fixed", "right:8px", "bottom:8px", "z-index:9998",
  "font:11px monospace", "padding:4px 10px", "border-radius:999px",
  "cursor:pointer", "border:1px solid rgba(255,255,255,0.25)",
  "background:rgba(8,12,18,0.8)", "color:#d7f7ff"
].join(";");
debugToggle.textContent = "Debug";
document.body.appendChild(debugToggle);

const panel = document.createElement("div");
panel.style.cssText = [
  "position:fixed", "bottom:8px", "right:8px", "z-index:9999",
  "background:rgba(0,0,0,0.88)", "color:#0ff", "font:11px/1.5 monospace",
  "padding:10px 12px", "border-radius:10px", "width:270px",
  "border:1px solid rgba(0,255,255,0.25)"
].join(";");
panel.hidden = true;
document.body.appendChild(panel);

const buttonRow = document.createElement("div");
buttonRow.style.cssText = "display:flex; gap:6px; margin-bottom:8px";
panel.appendChild(buttonRow);

const hideBtn = document.createElement("button");
hideBtn.style.cssText = [
  "flex:1", "font:11px monospace", "padding:4px 8px", "border-radius:4px",
  "cursor:pointer", "border:1px solid rgba(255,255,255,0.2)",
  "background:rgba(255,255,255,0.08)", "color:#d7f7ff"
].join(";");
hideBtn.textContent = "Hide";
buttonRow.appendChild(hideBtn);

const resetBtn = document.createElement("button");
resetBtn.style.cssText = [
  "flex:1", "font:11px monospace", "padding:4px 8px", "border-radius:4px",
  "cursor:pointer", "border:1px solid rgba(255,200,0,0.45)",
  "background:rgba(255,200,0,0.12)", "color:#fc0"
].join(";");
resetBtn.textContent = "Reset";
resetBtn.addEventListener("click", () => {
  view.debugOverrideCamera = false;
});
buttonRow.appendChild(resetBtn);

const contrastBtn = document.createElement("button");
contrastBtn.style.cssText = [
  "flex:1", "font:11px monospace", "padding:4px 8px", "border-radius:4px",
  "cursor:pointer", "border:1px solid rgba(67,217,255,0.35)",
  "background:rgba(67,217,255,0.12)", "color:#7df9ff"
].join(";");
buttonRow.appendChild(contrastBtn);

const statsEl = document.createElement("pre");
statsEl.style.cssText = "margin:0; color:#0ff; font:inherit";
panel.appendChild(statsEl);

const pipWrap = document.createElement("div");
pipWrap.style.cssText = [
  "margin:0 0 8px 0",
  "border:1px solid rgba(0,255,255,0.25)",
  "border-radius:8px",
  "overflow:hidden",
  "background:#08111f"
].join(";");
panel.insertBefore(pipWrap, statsEl);

const pipLabel = document.createElement("div");
pipLabel.style.cssText = [
  "padding:4px 8px",
  "font:10px monospace",
  "color:#7df9ff",
  "background:rgba(67,217,255,0.08)",
  "border-bottom:1px solid rgba(0,255,255,0.15)"
].join(";");
pipLabel.textContent = "Live Spectator View";
pipWrap.appendChild(pipLabel);

const pipCanvas = document.createElement("canvas");
pipCanvas.width = 246;
pipCanvas.height = 154;
pipCanvas.style.cssText = "display:block; width:246px; height:154px; background:#08111f";
pipWrap.appendChild(pipCanvas);

const pipRenderer = new THREE.WebGLRenderer({ canvas: pipCanvas, antialias: true, alpha: false });
pipRenderer.setPixelRatio(1);
pipRenderer.setSize(pipCanvas.width, pipCanvas.height, false);
pipRenderer.outputColorSpace = THREE.SRGBColorSpace;
pipRenderer.setClearColor("#08111f");

function renderCameraPip() {
  const renderWidth = pipCanvas.width;
  const renderHeight = pipCanvas.height;
  const mainAspect = view.camera.aspect || 1;
  let viewportWidth = renderWidth;
  let viewportHeight = Math.round(viewportWidth / mainAspect);

  if (viewportHeight > renderHeight) {
    viewportHeight = renderHeight;
    viewportWidth = Math.round(viewportHeight * mainAspect);
  }

  const viewportX = Math.floor((renderWidth - viewportWidth) / 2);
  const viewportY = Math.floor((renderHeight - viewportHeight) / 2);

  pipRenderer.setScissorTest(false);
  pipRenderer.clear();
  pipRenderer.setViewport(viewportX, viewportY, viewportWidth, viewportHeight);
  pipRenderer.setScissor(viewportX, viewportY, viewportWidth, viewportHeight);
  pipRenderer.setScissorTest(true);
  pipRenderer.render(view.scene, view.camera);
  pipRenderer.setScissorTest(false);
}

function syncContrastButton() {
  contrastBtn.textContent = view.spectatorContrastMode ? "Contrast On" : "Contrast Off";
}

function setDebugVisible(nextVisible: boolean) {
  debugVisible = nextVisible;
  panel.hidden = !nextVisible;
  debugToggle.hidden = nextVisible;
  view.setAvatarDebugMode(nextVisible);
  if (!nextVisible) {
    if (view.spectatorContrastMode) {
      view.setSpectatorContrastMode(false);
      syncContrastButton();
    }
    window.cancelAnimationFrame(debugRafId);
    debugRafId = 0;
    statsEl.textContent = "";
    drawViewportOverlay();
    pipRenderer.clear();
    return;
  }
  if (!debugRafId) {
    updateDebug();
  }
}

debugToggle.addEventListener("click", () => {
  setDebugVisible(true);
});

hideBtn.addEventListener("click", () => {
  setDebugVisible(false);
});

contrastBtn.addEventListener("click", () => {
  view.setSpectatorContrastMode(!view.spectatorContrastMode);
  syncContrastButton();
});

window.addEventListener("keydown", (event) => {
  if (event.shiftKey && event.key.toLowerCase() === "d") {
    setDebugVisible(!debugVisible);
  }
});

function updateDebug() {
  if (!debugVisible) {
    debugRafId = 0;
    return;
  }

  const cssW = view.canvas.clientWidth || window.innerWidth;
  const cssH = view.canvas.clientHeight || window.innerHeight;
  const viewport = view.getDisplayViewportCss();
  const centerX = cssW / 2;
  const centerY = cssH / 2;
  const arenaGeometry = getArenaScreenGeometry();
  const arenaBounds = arenaGeometry?.bounds || null;
  const arenaCenterX = arenaBounds ? arenaBounds.centerX : centerX;
  const arenaCenterY = arenaBounds ? arenaBounds.centerY : centerY;
  const arenaOffX = arenaCenterX - centerX;
  const arenaOffY = arenaCenterY - centerY;
  const resolvedTarget = view.resolvedSpectatorFrame?.target;

  statsEl.textContent = [
    `pos  ${f2(view.camera.position.x)}, ${f2(view.camera.position.y)}, ${f2(view.camera.position.z)}`,
    `fov  ${view.camera.fov}°   asp ${f2(view.camera.aspect)}`,
    `tgt  ${f2(resolvedTarget.x)}, ${f2(resolvedTarget.y)}, ${f2(resolvedTarget.z)}`,
    `view ${Math.round(viewport.width)}x${Math.round(viewport.height)} @ ${f2(viewport.width / Math.max(cssW, 1))}`,
    `contrast      ${view.spectatorContrastMode ? "on" : "off"}`,
    `────────────────────────────`,
    arenaBounds
      ? `arena ctr     ${Math.round(arenaCenterX)},${Math.round(arenaCenterY)}  off ${f2(arenaOffX)}, ${f2(arenaOffY)}`
      : `arena ctr     unavailable`,
    `screen ctr     ${Math.round(centerX)},${Math.round(centerY)}`
  ].join("\n");

  drawViewportOverlay();
  renderCameraPip();
  debugRafId = window.requestAnimationFrame(updateDebug);
}

syncContrastButton();
connect();
