import QRCode from "qrcode";
import { GameState } from "./gameState.js";
import { CLIENT_TYPES, MSG_TYPES, ROLES, createMessage } from "../shared/protocol.js";
import { COPY } from "../shared/copy.js";

const SOCKET_OPEN = 1;
const MAX_BUFFERED_BYTES = 512_000;

export class RoomSession {
  constructor({ roomCode, publicOrigin, onRoomEmpty, logger = () => {} }) {
    this.roomCode = roomCode;
    this.publicOrigin = publicOrigin;
    this.onRoomEmpty = onRoomEmpty;
    this.logger = logger;
    this.joinUrl = `${publicOrigin}/controller/?room=${roomCode}`;
    this.state = new GameState(roomCode);
    this.display = null;
    this.controllers = new Map();
    this.lastPhase = this.state.state.phase;
    this.lastShutterSequence = 0;
    this.lastBroadcastLobbyRevision = -1;
    this.lastBroadcastRoundRevision = -1;
    this.ready = this.initialize();
  }

  async initialize() {
    const qrCodeDataUrl = await QRCode.toDataURL(this.joinUrl, { margin: 1, width: 320 });
    this.state.setRoomInfo({ qrCodeDataUrl, joinUrl: this.joinUrl });
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

  sendRoomState(ws) {
    return this.send(ws, MSG_TYPES.ROOM_STATE, {
      room: this.state.getRoomState(),
      self: this.controllers.get(ws) ? this.state.getSelfState(this.controllers.get(ws).playerId) : { playerId: null, role: null }
    });
  }

  sendLobbyState(ws) {
    return this.send(ws, MSG_TYPES.LOBBY_STATE, this.state.getLobbyState());
  }

  sendRoundState(ws) {
    return this.send(ws, MSG_TYPES.ROUND_STATE, this.state.getRoundState());
  }

  sendGalleryState(ws) {
    return this.send(ws, MSG_TYPES.GALLERY_STATE, this.state.getGalleryState());
  }

  sendAllState(ws) {
    this.sendRoomState(ws);
    this.sendLobbyState(ws);
    this.sendRoundState(ws);
    this.sendGalleryState(ws);
  }

  getSockets() {
    return [
      ...(this.display?.ws ? [this.display.ws] : []),
      ...this.controllers.keys()
    ];
  }

  broadcastRoomState() {
    if (this.display?.ws) {
      this.sendRoomState(this.display.ws);
    }
    for (const ws of this.controllers.keys()) {
      this.sendRoomState(ws);
    }
  }

  broadcastLobbyState() {
    const payload = this.state.getLobbyState();
    this.lastBroadcastLobbyRevision = payload.lobbyRevision;
    if (this.display?.ws) {
      this.send(this.display.ws, MSG_TYPES.LOBBY_STATE, payload);
    }
    for (const ws of this.controllers.keys()) {
      this.send(ws, MSG_TYPES.LOBBY_STATE, payload);
    }
  }

  broadcastRoundState() {
    const payload = this.state.getRoundState();
    this.lastBroadcastRoundRevision = payload.roundRevision;
    if (this.display?.ws) {
      this.send(this.display.ws, MSG_TYPES.ROUND_STATE, payload);
    }
    for (const ws of this.controllers.keys()) {
      this.send(ws, MSG_TYPES.ROUND_STATE, payload);
    }
  }

  broadcastGalleryState() {
    const payload = this.state.getGalleryState();
    if (this.display?.ws) {
      this.send(this.display.ws, MSG_TYPES.GALLERY_STATE, payload);
    }
    for (const ws of this.controllers.keys()) {
      this.send(ws, MSG_TYPES.GALLERY_STATE, payload);
    }
  }

  registerDisplay(ws) {
    this.display = { ws };
    this.logger("display", "joined", { roomCode: this.roomCode });
    this.sendAllState(ws);
  }

  registerController(ws, { name, sessionId }) {
    const wasKnownSession = this.state.state.players.some((entry) => entry.sessionId === sessionId);
    const player = this.state.addOrReconnectPlayer(name, sessionId);
    if (!player) {
      this.send(ws, MSG_TYPES.ROOM_ERROR, { message: COPY.errors.roomFull });
      return null;
    }
    this.controllers.set(ws, { playerId: player.id, sessionId });
    this.logger("controller", wasKnownSession ? "rejoined" : "joined", {
      roomCode: this.roomCode,
      playerId: player.id,
      playerName: player.name,
      sessionId
    });
    this.sendAllState(ws);
    this.broadcastRoomState();
    this.broadcastLobbyState();
    this.broadcastRoundState();
    return player;
  }

  unregisterSocket(ws) {
    if (this.display?.ws === ws) {
      this.display = null;
      this.logger("display", "left", { roomCode: this.roomCode });
    }
    const meta = this.controllers.get(ws);
    if (meta) {
      this.state.disconnectPlayer(meta.playerId);
      const player = this.state.getPlayer(meta.playerId);
      this.logger("controller", "left", {
        roomCode: this.roomCode,
        playerId: meta.playerId,
        sessionId: meta.sessionId,
        playerName: player?.name || null
      });
      this.controllers.delete(ws);
    }
    this.broadcastRoomState();
    this.broadcastLobbyState();
    this.broadcastRoundState();
    if (!this.display && this.controllers.size === 0) {
      this.onRoomEmpty?.(this.roomCode);
    }
  }

  leaveController(ws) {
    const meta = this.controllers.get(ws);
    if (!meta) {
      return;
    }
    const player = this.state.getPlayer(meta.playerId);
    this.logger("controller", "leave-room", {
      roomCode: this.roomCode,
      playerId: meta.playerId,
      sessionId: meta.sessionId,
      playerName: player?.name || null
    });
    this.state.removePlayer(meta.playerId);
    this.controllers.delete(ws);
    this.broadcastRoomState();
    this.broadcastLobbyState();
    this.broadcastRoundState();
  }

  logPlayerAction(event, meta, details = {}) {
    const player = this.state.getPlayer(meta.playerId);
    this.logger("player", event, {
      roomCode: this.roomCode,
      roundId: this.state.state.roundId,
      playerId: meta.playerId,
      sessionId: meta.sessionId,
      playerName: player?.name || null,
      role: player?.role || null,
      ...details
    });
  }

  handleControllerMessage(ws, message) {
    const meta = this.controllers.get(ws);
    if (!meta) {
      return;
    }
    const { playerId } = meta;
    const payload = message.payload || {};
    switch (message.type) {
      case MSG_TYPES.LOAD_PROGRESS: {
        const before = this.state.getPlayer(playerId);
        const motionReadyBefore = Boolean(before?.setup?.motionReady);
        this.state.setLoadProgress(playerId, payload.progress, payload.setup || {});
        const after = this.state.getPlayer(playerId);
        if (!motionReadyBefore && after?.setup?.motionReady) {
          this.logPlayerAction("setup-complete", meta, { setup: "motion" });
        }
        this.broadcastRoomState();
        this.broadcastLobbyState();
        this.broadcastRoundState();
        return;
      }
      case MSG_TYPES.ROLE_SET: {
        const result = this.state.chooseRole(playerId, payload.role);
        if (!result.ok) {
          this.logPlayerAction("role-rejected", meta, { requestedRole: payload.role, reason: result.message });
          this.send(ws, MSG_TYPES.ROOM_ERROR, { message: result.message });
        } else {
          this.logPlayerAction(payload.role ? "role-claimed" : "role-released", meta, { role: payload.role || null });
        }
        this.broadcastRoomState();
        this.broadcastLobbyState();
        this.broadcastRoundState();
        return;
      }
      case MSG_TYPES.READY_SET: {
        const result = this.state.setReady(playerId, payload.ready);
        if (!result.ok) {
          this.logPlayerAction("ready-rejected", meta, { requestedReady: payload.ready, reason: result.message });
          this.send(ws, MSG_TYPES.ROOM_ERROR, { message: result.message });
        } else {
          this.logPlayerAction("ready-set", meta, { ready: payload.ready });
        }
        this.broadcastRoomState();
        this.broadcastLobbyState();
        this.broadcastRoundState();
        return;
      }
      case MSG_TYPES.THEME_SET: {
        const themeId = Object.prototype.hasOwnProperty.call(payload, "themeId") ? payload.themeId : null;
        this.logger("player", "theme-request", {
          roomCode: this.roomCode,
          roundId: this.state.state.roundId,
          playerId: meta.playerId,
          sessionId: meta.sessionId,
          requestedTheme: themeId,
          phase: this.state.state.phase
        });
        const result = this.state.setThemePreference(playerId, themeId);
        if (!result.ok) {
          this.logPlayerAction("theme-rejected", meta, { requestedTheme: themeId, reason: result.message });
          this.send(ws, MSG_TYPES.ROOM_ERROR, { message: result.message });
        } else {
          this.logPlayerAction("theme-set", meta, {
            themePreference: result.themePreference,
            resolvedTheme: result.resolvedTheme
          });
        }
        this.broadcastRoomState();
        this.broadcastLobbyState();
        this.broadcastRoundState();
        return;
      }
      case MSG_TYPES.FACE_FRAME: {
        const beforeHadFace = Boolean(this.state.getPlayer(playerId)?.faceFrame);
        const result = this.state.updateFaceFrame(playerId, payload);
        if (!result.ok) {
          this.logPlayerAction("face-frame-rejected", meta, { reason: result.message });
          this.send(ws, MSG_TYPES.ROOM_ERROR, { message: result.message });
        } else {
          if (!beforeHadFace) {
            this.logPlayerAction("setup-complete", meta, { setup: "face" });
          }
        }
        this.broadcastLobbyState();
        this.broadcastRoundState();
        return;
      }
      case MSG_TYPES.GALLERY_REVIEW_SET: {
        const result = this.state.setGalleryReview(playerId, Boolean(payload.open));
        if (!result.ok) {
          this.send(ws, MSG_TYPES.ROOM_ERROR, { message: result.message });
          return;
        }
        this.broadcastRoundState();
        this.broadcastGalleryState();
        if (result.reset) {
          this.logger("round", "lobby-reset", { roomCode: this.roomCode, reason: "all-galleries-closed" });
          this.broadcastRoomState();
          this.broadcastLobbyState();
          this.broadcastRoundState();
          this.broadcastGalleryState();
        }
        return;
      }
      case MSG_TYPES.CAMERA_MOTION:
        this.state.updatePhotographerMotion(playerId, payload);
        return;
      case MSG_TYPES.RUNNER_INPUT:
        this.state.updateRunnerInput(playerId, payload);
        return;
      case MSG_TYPES.SHUTTER: {
        const result = this.state.registerShutter(playerId, payload);
        if (!result.ok) {
          this.logPlayerAction("shutter-rejected", meta, { reason: result.message });
          this.send(ws, MSG_TYPES.ROOM_ERROR, { message: result.message });
          return;
        }
        this.logPlayerAction("shutter", meta, {
          photoId: result.photo.id,
          shutterSequence: result.photo.shutterSequence,
          visibleRunnerIds: result.debug.visibleRunnerIds,
          newRunnerIds: result.debug.newRunnerIds,
          blockedRunnerIds: result.debug.blockedRunnerIds,
          winnerChanged: result.debug.winnerChanged
        });
        this.send(ws, MSG_TYPES.PHOTO_RESULT, {
          photoId: result.photo.id,
          shutterSequence: result.photo.shutterSequence,
          createdAt: result.photo.createdAt,
          successful: result.photo.capturedRunnerIds.length > 0
        });
        this.broadcastRoundState();
        this.broadcastGalleryState();
        return;
      }
      default:
        return;
    }
  }

  tick() {
    const previousPhase = this.state.state.phase;
    const previousRoundId = this.state.state.roundId;
    const previousLobbyRevision = this.state.state.lobbyRevision;
    const previousRoundRevision = this.state.state.roundRevision;
    this.state.tick();
    if (this.state.state.phase !== previousPhase) {
      if (this.state.state.phase === "COUNTDOWN") {
        this.logger("round", "countdown-start", {
          roomCode: this.roomCode,
          roundId: previousRoundId
        });
      }
      if (this.state.state.phase === "PLAYING") {
        this.logger("round", "round-start", {
          roomCode: this.roomCode,
          roundId: this.state.state.roundId,
          resolvedTheme: this.state.state.resolvedTheme
        });
      }
      if (this.state.state.phase === "RESULTS") {
        this.logger("round", "summary", this.state.buildRoundDebugSummary());
      }
      if (this.state.state.phase === "LOBBY" && previousPhase === "RESULTS") {
        this.logger("round", "lobby-reset", { roomCode: this.roomCode });
      }
      this.lastPhase = this.state.state.phase;
      this.broadcastRoomState();
      this.broadcastLobbyState();
      this.broadcastGalleryState();
    }
    if (this.state.state.shutterSequence !== this.lastShutterSequence) {
      this.lastShutterSequence = this.state.state.shutterSequence;
    }
    if (this.state.state.roundRevision !== previousRoundRevision && this.state.state.roundRevision !== this.lastBroadcastRoundRevision) {
      this.broadcastRoundState();
    }
    if (this.state.state.lobbyRevision !== previousLobbyRevision && this.state.state.lobbyRevision !== this.lastBroadcastLobbyRevision) {
      this.broadcastLobbyState();
    }
  }

  close({ reason = "room-reset", replacementRoomCode = null, excludeSockets = [] } = {}) {
    const excluded = new Set(excludeSockets);
    this.logger("room", "closed", {
      roomCode: this.roomCode,
      reason,
      replacementRoomCode
    });
    if (this.display?.ws && !excluded.has(this.display.ws)) {
      this.send(this.display.ws, MSG_TYPES.ROOM_CLOSED, { reason, replacementRoomCode });
    }
    for (const ws of this.controllers.keys()) {
      if (!excluded.has(ws)) {
        this.send(ws, MSG_TYPES.ROOM_CLOSED, { reason, replacementRoomCode });
      }
    }
    this.display = null;
    this.controllers.clear();
    this.onRoomEmpty?.(this.roomCode);
  }
}
