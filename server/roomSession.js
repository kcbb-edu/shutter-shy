import QRCode from "qrcode";
import { GameState } from "./gameState.js";
import { CLIENT_TYPES, createMessage, HIGHLIGHT_EVENT_PRIORITIES, MAX_HIGHLIGHT_SNAPSHOTS_PER_ROUND, MSG_TYPES, ROLES } from "../shared/protocol.js";
import { buildRoundSummary } from "../shared/highlightOverlay.js";

const SOCKET_OPEN = 1;
const CONTROLLER_RECONNECT_GRACE_MS = 15000;
const DISPLAY_RECONNECT_GRACE_MS = 15000;
const MAX_BUFFERED_BYTES = 256_000;
const CONTROLLER_GAME_STATE_INTERVAL_MS = 100;
const HIGHLIGHT_CAPTURE_SUFFIX_PRIORITIES = {
  impact: 0,
  "pre-hit": 1,
  "reaction-a": 2,
  "reaction-b": 3
};

function getCaptureSequenceRank(captureId = "") {
  const suffix = String(captureId).split("-").slice(-2).join("-");
  return HIGHLIGHT_CAPTURE_SUFFIX_PRIORITIES[suffix] ?? HIGHLIGHT_CAPTURE_SUFFIX_PRIORITIES[String(captureId).split("-").pop()] ?? 9;
}

export class RoomSession {
  constructor({ roomCode, publicOrigin, onRoomEmpty, logger = () => {} }) {
    this.roomCode = roomCode;
    this.publicOrigin = publicOrigin;
    this.onRoomEmpty = onRoomEmpty;
    this.logger = logger;
    this.joinUrl = `${publicOrigin}/controller/?room=${roomCode}`;
    this.state = new GameState(roomCode);
    this.display = null;
    this.displayReconnectTimer = null;
    this.controllerSockets = new Map();
    this.controllerReconnectTimers = new Map();
    this.isClosed = false;
    this.closedReason = null;
    this.replacementRoomCode = null;
    this.lastControllerGameBroadcastAt = 0;
    this.currentResultOverlay = null;
    this.pendingHighlightCaptures = new Map();
    this.lastOverlayRoundId = null;
    this.lastPhase = this.state.state.phase;
    this.ready = this.initialize();
  }

  async initialize() {
    const qrCodeDataUrl = await QRCode.toDataURL(this.joinUrl, { margin: 1, width: 320 });
    this.state.setQrCodeDataUrl(qrCodeDataUrl);
  }

  isSocketOpen(ws) {
    return ws && ws.readyState === SOCKET_OPEN;
  }

  send(ws, type, payload = {}) {
    if (!this.isSocketOpen(ws)) {
      return false;
    }
    if (typeof ws.bufferedAmount === "number" && ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      return false;
    }
    ws.send(JSON.stringify(createMessage(type, payload)));
    return true;
  }

  buildRoomState() {
    return {
      roomCode: this.roomCode,
      joinUrl: this.joinUrl,
      qrCodeDataUrl: this.state.state.qrCodeDataUrl,
      displayConnected: Boolean(this.display && this.isSocketOpen(this.display.ws)),
      isClosed: this.isClosed,
      closedReason: this.closedReason,
      replacementRoomCode: this.replacementRoomCode
    };
  }

  buildSelfState(ws) {
    const self = this.controllerSockets.get(ws) || null;
    if (!self) {
      return {
        clientType: CLIENT_TYPES.DISPLAY,
        playerId: null,
        sessionId: null
      };
    }
    return {
      clientType: CLIENT_TYPES.CONTROLLER,
      playerId: self.playerId,
      sessionId: self.sessionId
    };
  }

  buildUiPayload(ws) {
    return {
      room: this.buildRoomState(),
      self: this.buildSelfState(ws),
      serverTime: Date.now()
    };
  }

  buildGamePayload(ws, { full = false } = {}) {
    const isDisplay = this.display?.ws === ws;
    const includeInputs = isDisplay;
    const game = full
      ? this.state.getFullState({ includeInputs })
      : this.state.getDeltaState({ includeInputs });
    return {
      game,
      serverTime: Date.now(),
      snapshotKind: full ? "full" : "delta"
    };
  }

  buildResultOverlayPayload() {
    if (this.currentResultOverlay) {
      return this.currentResultOverlay;
    }
    return {
      roundId: this.state.state.roundId,
      winner: this.state.state.winner,
      summary: "",
      items: [],
      overlayMode: "hidden"
    };
  }

  buildResultSummary() {
    return buildRoundSummary({
      winner: this.state.state.winner,
      recentEvents: this.state.state.recentEvents || []
    });
  }

  createResultOverlay() {
    const summary = this.buildResultSummary();
    const items = this.consumePendingCaptures(this.state.state.roundId);
    this.currentResultOverlay = {
      roundId: this.state.state.roundId,
      winner: this.state.state.winner,
      summary,
      items,
      overlayMode: items.length > 0 ? "summary-with-images" : "summary-only"
    };
    this.lastOverlayRoundId = this.state.state.roundId;
    this.logger("room-session", "create-result-overlay", {
      roomCode: this.roomCode,
      roundId: this.state.state.roundId,
      winner: this.state.state.winner,
      overlayMode: this.currentResultOverlay.overlayMode,
      itemCount: items.length
    });
  }

  normalizeCapturePayload(payload = {}, roundId) {
    const imageBase64 = String(payload.imageBase64 || "");
    if (!/^data:image\/(?:jpeg|png|webp);base64,/.test(imageBase64)) {
      return null;
    }
    const captureId = String(payload.captureId || "").trim() || `capture-${Date.now()}`;
    return {
      captureId,
      caption: payload.caption || "Big screen highlight",
      eventType: String(payload.eventType || "round-end"),
      capturedAt: Number(payload.capturedAt || Date.now()),
      roundId,
      filename: payload.filename || `waveform-attack-${this.roomCode}-${roundId.slice(0, 8)}-display.jpg`,
      imageBase64
    };
  }

  sortHighlightItems(items) {
    items.sort((left, right) => {
      const leftPriority = HIGHLIGHT_EVENT_PRIORITIES[left.eventType] || 0;
      const rightPriority = HIGHLIGHT_EVENT_PRIORITIES[right.eventType] || 0;
      if (leftPriority !== rightPriority) {
        return rightPriority - leftPriority;
      }
      const leftSequence = getCaptureSequenceRank(left.captureId);
      const rightSequence = getCaptureSequenceRank(right.captureId);
      if (leftSequence !== rightSequence) {
        return leftSequence - rightSequence;
      }
      return (left.capturedAt || 0) - (right.capturedAt || 0);
    });
    return items.slice(0, MAX_HIGHLIGHT_SNAPSHOTS_PER_ROUND);
  }

  cachePendingCapture(roundId, nextItem) {
    const previousItems = this.pendingHighlightCaptures.get(roundId) || [];
    const existingIndex = previousItems.findIndex((item) => item.captureId === nextItem.captureId);
    const nextItems = existingIndex >= 0 ? [...previousItems] : [...previousItems, nextItem];
    if (existingIndex >= 0) {
      nextItems[existingIndex] = nextItem;
    }
    this.pendingHighlightCaptures.set(roundId, nextItems);
  }

  consumePendingCaptures(roundId) {
    const items = this.pendingHighlightCaptures.get(roundId) || [];
    this.pendingHighlightCaptures.delete(roundId);
    return this.sortHighlightItems([...items]);
  }

  applyDisplayCapture(payload = {}) {
    const payloadRoundId = String(payload.roundId || "");
    if (!payloadRoundId || payloadRoundId !== this.state.state.roundId) {
      return false;
    }

    const nextItem = this.normalizeCapturePayload(payload, payloadRoundId);
    if (!nextItem) {
      return false;
    }

    if (!this.currentResultOverlay || this.currentResultOverlay.roundId !== payloadRoundId) {
      this.cachePendingCapture(payloadRoundId, nextItem);
      return true;
    }

    const previousItems = Array.isArray(this.currentResultOverlay.items) ? this.currentResultOverlay.items : [];
    const existingIndex = previousItems.findIndex((item) => item.captureId === nextItem.captureId);
    const nextItems = existingIndex >= 0 ? [...previousItems] : [...previousItems, nextItem];
    if (existingIndex >= 0) {
      nextItems[existingIndex] = nextItem;
    }
    this.currentResultOverlay = {
      ...this.currentResultOverlay,
      items: this.sortHighlightItems(nextItems),
      overlayMode: "summary-with-images"
    };
    this.broadcastResultOverlay();
    return true;
  }

  handleDisplayKeepalive(payload = {}) {
    this.logger("room-session", "display-keepalive", {
      roomCode: this.roomCode,
      sentAt: Number(payload.sentAt || Date.now())
    });
  }

  sendInitialState(ws) {
    this.send(ws, MSG_TYPES.UI_STATE, this.buildUiPayload(ws));
    this.send(ws, MSG_TYPES.GAME_STATE, this.buildGamePayload(ws, { full: true }));
    const overlayPayload = this.buildResultOverlayPayload();
    this.send(ws, MSG_TYPES.HIGHLIGHTS, overlayPayload);
  }

  broadcastUiState() {
    if (this.display?.ws) {
      this.send(this.display.ws, MSG_TYPES.UI_STATE, this.buildUiPayload(this.display.ws));
    }
    this.controllerSockets.forEach((_meta, ws) => {
      this.send(ws, MSG_TYPES.UI_STATE, this.buildUiPayload(ws));
    });
  }

  broadcastDisplayGameState({ full = false } = {}) {
    if (!this.display?.ws) {
      return;
    }
    this.send(this.display.ws, MSG_TYPES.GAME_STATE, this.buildGamePayload(this.display.ws, { full }));
  }

  broadcastControllerGameState({ full = false, force = false } = {}) {
    const now = Date.now();
    if (!force && !full && now - this.lastControllerGameBroadcastAt < CONTROLLER_GAME_STATE_INTERVAL_MS) {
      return;
    }
    this.lastControllerGameBroadcastAt = now;
    this.controllerSockets.forEach((_meta, ws) => {
      this.send(ws, MSG_TYPES.GAME_STATE, this.buildGamePayload(ws, { full }));
    });
  }

  broadcastAllState({ full = false, forceController = false } = {}) {
    this.broadcastUiState();
    this.broadcastDisplayGameState({ full });
    this.broadcastControllerGameState({ full, force: forceController || full });
  }

  broadcastResultOverlay() {
    const payload = this.buildResultOverlayPayload();
    this.controllerSockets.forEach((_meta, ws) => {
      this.send(ws, MSG_TYPES.HIGHLIGHTS, payload);
    });
    if (this.display?.ws) {
      this.send(this.display.ws, MSG_TYPES.HIGHLIGHTS, payload);
    }
  }

  syncResultOverlayForPhase() {
    if (this.state.state.phase === "RESULT") {
      if (this.lastOverlayRoundId !== this.state.state.roundId) {
        this.createResultOverlay();
        this.broadcastResultOverlay();
      }
      return;
    }

    if (this.state.state.phase !== "RESULT" && this.lastPhase === "RESULT" && !this.currentResultOverlay) {
      this.createResultOverlay();
      this.broadcastResultOverlay();
    }
  }

  registerDisplay(ws, payload = {}) {
    this.isClosed = false;
    this.closedReason = null;
    this.replacementRoomCode = null;

    if (this.displayReconnectTimer) {
      clearTimeout(this.displayReconnectTimer);
      this.displayReconnectTimer = null;
    }

    if (this.display?.ws && this.display.ws !== ws && this.isSocketOpen(this.display.ws)) {
      this.display.ws.close(4000, "display-replaced");
    }

    this.display = { ws };
    this.state.setDisplayMetrics({ aspectRatio: Number(payload.aspectRatio) || null });
    this.logger("room-session", "display-connected", {
      roomCode: this.roomCode,
      aspectRatio: Number(payload.aspectRatio) || null
    });
    this.sendInitialState(ws);
    this.broadcastControllerGameState({ full: true, force: true });
  }

  registerController(ws, { name, sessionId }) {
    if (this.isClosed) {
      this.send(ws, MSG_TYPES.ROOM_CLOSED, {
        roomCode: this.roomCode,
        replacementRoomCode: this.replacementRoomCode,
        reason: this.closedReason || "room-closed"
      });
      return null;
    }

    const normalizedSessionId = String(sessionId || "").trim();
    const existingPlayer = this.state.state.players.find((player) => player.sessionId === normalizedSessionId);

    if (existingPlayer) {
      const reconnectTimer = this.controllerReconnectTimers.get(existingPlayer.id);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        this.controllerReconnectTimers.delete(existingPlayer.id);
      }
      this.controllerSockets.set(ws, {
        playerId: existingPlayer.id,
        sessionId: normalizedSessionId,
        name: existingPlayer.name
      });
      this.logger("room-session", "controller-reconnected", {
        roomCode: this.roomCode,
        playerId: existingPlayer.id,
        sessionId: normalizedSessionId,
        name: existingPlayer.name
      });
      this.sendInitialState(ws);
      this.broadcastUiState();
      return existingPlayer;
    }

    const player = this.state.addPlayer(name, normalizedSessionId);
    if (!player) {
      this.send(ws, MSG_TYPES.ROOM_ERROR, {
        message: "Room is full.",
        roomCode: this.roomCode
      });
      return null;
    }

    this.controllerSockets.set(ws, {
      playerId: player.id,
      sessionId: normalizedSessionId,
      name: player.name
    });
    this.logger("room-session", "controller-connected", {
      roomCode: this.roomCode,
      playerId: player.id,
      sessionId: normalizedSessionId,
      name: player.name
    });
    this.sendInitialState(ws);
    this.broadcastAllState({ full: true, forceController: true });
    return player;
  }

  unregisterSocket(ws) {
    if (this.display?.ws === ws) {
      this.display = null;
      this.logger("room-session", "display-disconnected", { roomCode: this.roomCode });
      if (!this.isClosed) {
        this.displayReconnectTimer = setTimeout(() => {
          this.close({
            reason: "display-disconnected",
            replacementRoomCode: null
          });
        }, DISPLAY_RECONNECT_GRACE_MS);
      }
      this.broadcastUiState();
      this.emitRoomEmptyIfNeeded();
      return;
    }

    const controller = this.controllerSockets.get(ws);
    if (!controller) {
      return;
    }

    this.controllerSockets.delete(ws);
    this.logger("room-session", "controller-disconnected", {
      roomCode: this.roomCode,
      playerId: controller.playerId,
      sessionId: controller.sessionId
    });
    const timer = setTimeout(() => {
      this.controllerReconnectTimers.delete(controller.playerId);
      this.state.removePlayer(controller.playerId);
      this.broadcastAllState({ full: true, forceController: true });
      this.emitRoomEmptyIfNeeded();
    }, CONTROLLER_RECONNECT_GRACE_MS);

    this.controllerReconnectTimers.set(controller.playerId, timer);
    this.broadcastAllState({ full: true, forceController: true });
    this.emitRoomEmptyIfNeeded();
  }

  leaveController(ws) {
    const controller = this.controllerSockets.get(ws);
    if (!controller) {
      return;
    }

    this.controllerSockets.delete(ws);
    this.logger("room-session", "controller-left", {
      roomCode: this.roomCode,
      playerId: controller.playerId,
      sessionId: controller.sessionId
    });
    const reconnectTimer = this.controllerReconnectTimers.get(controller.playerId);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      this.controllerReconnectTimers.delete(controller.playerId);
    }

    this.state.removePlayer(controller.playerId);
    this.broadcastAllState({ full: true, forceController: true });
    this.emitRoomEmptyIfNeeded();
  }

  emitRoomEmptyIfNeeded() {
    if (this.display) {
      return;
    }
    if (this.controllerSockets.size > 0) {
      return;
    }
    if (this.controllerReconnectTimers.size > 0) {
      return;
    }
    if (this.displayReconnectTimer) {
      return;
    }
    this.onRoomEmpty?.(this.roomCode);
  }

  close({ reason = "room-closed", replacementRoomCode = null } = {}) {
    this.logger("room-session", "close-room", {
      roomCode: this.roomCode,
      reason,
      replacementRoomCode
    });
    this.isClosed = true;
    this.closedReason = reason;
    this.replacementRoomCode = replacementRoomCode || null;

    if (this.displayReconnectTimer) {
      clearTimeout(this.displayReconnectTimer);
      this.displayReconnectTimer = null;
    }

    this.controllerReconnectTimers.forEach((timer) => clearTimeout(timer));
    this.controllerReconnectTimers.clear();

    this.controllerSockets.forEach((_meta, ws) => {
      this.send(ws, MSG_TYPES.ROOM_CLOSED, {
        roomCode: this.roomCode,
        replacementRoomCode: this.replacementRoomCode,
        reason: this.closedReason
      });
    });

    this.display = null;
    this.controllerSockets.clear();
    this.currentResultOverlay = null;
    this.pendingHighlightCaptures.clear();
    this.lastOverlayRoundId = null;
    this.state.state.players.slice().forEach((player) => {
      this.state.removePlayer(player.id);
    });
    this.emitRoomEmptyIfNeeded();
  }

  handleMessage(ws, message) {
    switch (message.type) {
      case MSG_TYPES.SET_ROLE: {
        const playerId = this.controllerSockets.get(ws)?.playerId || null;
        const result = this.state.chooseRole(playerId, message.payload?.role);
        this.logger("room-session", "set-role", {
          roomCode: this.roomCode,
          playerId,
          role: message.payload?.role,
          ok: result?.ok ?? false,
          reason: result?.reason || null
        });
        if (!result?.ok) {
          this.send(ws, MSG_TYPES.ROOM_ERROR, { message: result?.reason || "Unable to choose role." });
        }
        this.broadcastAllState({ full: true, forceController: true });
        break;
      }
      case MSG_TYPES.READY: {
        const playerId = this.controllerSockets.get(ws)?.playerId || null;
        const result = this.state.setReady(playerId);
        this.logger("room-session", "set-ready", {
          roomCode: this.roomCode,
          playerId,
          ok: result?.ok ?? false,
          reason: result?.reason || null
        });
        if (!result?.ok) {
          this.send(ws, MSG_TYPES.ROOM_ERROR, { message: result?.reason || "Unable to ready up." });
        }
        this.broadcastAllState({ full: true, forceController: true });
        break;
      }
      case MSG_TYPES.CONTINUE: {
        const isDisplay = this.display?.ws === ws;
        const isAttacker = this.state.getPlayer(this.controllerSockets.get(ws)?.playerId)?.role === ROLES.ATTACKER;
        if (this.state.state.phase === "RESULT" && (isDisplay || isAttacker)) {
          this.state.continueFromResult();
          this.broadcastAllState({ full: true, forceController: true });
        }
        break;
      }
      case MSG_TYPES.DISPLAY_CAPTURE: {
        const isDisplay = this.display?.ws === ws;
        if (isDisplay) {
          this.applyDisplayCapture(message.payload || {});
        }
        break;
      }
      case MSG_TYPES.DISPLAY_KEEPALIVE: {
        if (this.display?.ws === ws) {
          this.handleDisplayKeepalive(message.payload || {});
        }
        break;
      }
      case MSG_TYPES.FACE_SNAPSHOT: {
        const playerId = this.controllerSockets.get(ws)?.playerId || null;
        this.state.updateFaceSnapshot(playerId, message.payload || {});
        break;
      }
      case MSG_TYPES.INPUT: {
        const playerId = this.controllerSockets.get(ws)?.playerId || null;
        this.state.setInput(playerId, message.payload?.action, message.payload?.pressed);
        break;
      }
      case MSG_TYPES.AUDIO: {
        const playerId = this.controllerSockets.get(ws)?.playerId || null;
        const player = this.state.getPlayer(playerId);
        if (player?.role === ROLES.ATTACKER) {
          const trace = this.state.updateAudio(message.payload || {});
          // Always log compact pitch trace to terminal (~200ms throttle)
          const nowMs = Date.now();
          if (trace && nowMs - (this._lastPitchLogAt || 0) >= 200) {
            this._lastPitchLogAt = nowMs;
            const amp = message.payload?.amplitudeNorm;
            const voiced = message.payload?.voiced ? "1" : "0";
            const bandStr = Number.isInteger(trace.dominantBandIndex) ? String(trace.dominantBandIndex) : "--";
            const ampStr = Number.isFinite(amp) ? Number(amp).toFixed(2) : "--";
            const rawHzStr = Number.isFinite(trace.rawFundamentalHz) ? Math.round(trace.rawFundamentalHz) : "--";
            const fundamentalHzStr = Number.isFinite(trace.fundamentalHz) ? Math.round(trace.fundamentalHz) : "--";
            const hzStr = Number.isFinite(trace.dominantBandHz) ? Math.round(trace.dominantBandHz) : "--";
            const rangeStr = trace.profileRangeHz ? `${Math.round(trace.profileRangeHz.lowHz)}-${Math.round(trace.profileRangeHz.highHz)}` : "--";
            const bandRangeStr = trace.bandRange ? `${Math.round(trace.bandRange.startHz)}-${Math.round(trace.bandRange.endHz)}` : "--";
            const levelsStr = Array.isArray(trace.levels) ? trace.levels.map((level) => Math.round(level * 9)).join("") : "--";
            console.log(`[PITCH] voiced=${voiced} rawHz=${rawHzStr} fundamentalHz=${fundamentalHzStr} dominantBand=${bandStr} dominantBandHz=${hzStr} bandHz=${bandRangeStr} amp=${ampStr} profileRange=${rangeStr} levels=${levelsStr} phase=${this.state.state.phase}`);
          }
        }
        break;
      }
      case MSG_TYPES.ATTACKER_SETUP: {
        const playerId = this.controllerSockets.get(ws)?.playerId || null;
        this.state.updateAttackerSetup(playerId, message.payload || {});
        this.logger("room-session", "attacker-setup", {
          roomCode: this.roomCode,
          playerId,
          hasMicPermission: Boolean(message.payload?.hasMicPermission),
          environmentPreset: message.payload?.environmentPreset || null,
          sensitivityPreset: message.payload?.sensitivityPreset || null
        });
        this.broadcastAllState({ full: true, forceController: true });
        break;
      }
      case MSG_TYPES.LEAVE: {
        this.leaveController(ws);
        break;
      }
      default:
        this.logger("room-session", "unknown-message-type", { type: message.type, roomCode: this.roomCode });
        break;
    }
  }

  tick() {
    if (this.isClosed) {
      return;
    }
    const previousPhase = this.state.state.phase;
    this.state.tick();
    if (this.state.state.phase !== previousPhase) {
      this.logger("room-session", "phase-change", {
        roomCode: this.roomCode,
        from: previousPhase,
        to: this.state.state.phase,
        roundId: this.state.state.roundId,
        winner: this.state.state.winner
      });
    }
    this.syncResultOverlayForPhase();
    this.broadcastDisplayGameState();
    this.broadcastControllerGameState();
    this.lastPhase = this.state.state.phase;
  }
}
