import { CLIENT_TYPES, MSG_TYPES, ROOM_CODE_LENGTH, normalizeRoomCode } from "../shared/protocol.js";
import { COPY } from "../shared/copy.js";
import { RoomSession } from "./roomSession.js";

function randomRoomCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export class RoomRegistry {
  constructor({ publicOrigin, logger = () => {} }) {
    this.publicOrigin = publicOrigin;
    this.logger = logger;
    this.rooms = new Map();
    this.socketMeta = new Map();
  }

  getRoom(roomCode) {
    const normalized = normalizeRoomCode(roomCode);
    if (!normalized) {
      return null;
    }
    return this.rooms.get(normalized) || null;
  }

  async createRoom(preferredCode = null) {
    let roomCode = normalizeRoomCode(preferredCode);
    while (!roomCode || roomCode.length < ROOM_CODE_LENGTH || this.rooms.has(roomCode)) {
      roomCode = randomRoomCode();
    }
    const room = new RoomSession({
      roomCode,
      publicOrigin: this.publicOrigin,
      logger: this.logger,
      onRoomEmpty: (code) => {
        if (this.rooms.has(code)) {
          this.rooms.delete(code);
        }
      }
    });
    this.rooms.set(roomCode, room);
    this.logger("room", "created", { roomCode });
    await room.ready;
    return room;
  }

  bindSocket(ws, meta) {
    this.socketMeta.set(ws, meta);
  }

  clearRoomSocketMeta(roomCode) {
    for (const [ws, meta] of this.socketMeta.entries()) {
      if (meta.roomCode === roomCode) {
        this.socketMeta.delete(ws);
      }
    }
  }

  closeRoom(roomCode, { reason = "room-reset", replacementRoomCode = null, excludeSockets = [] } = {}) {
    const room = this.getRoom(roomCode);
    if (!room) {
      return null;
    }
    room.close({ reason, replacementRoomCode, excludeSockets });
    this.clearRoomSocketMeta(room.roomCode);
    this.rooms.delete(room.roomCode);
    return room;
  }

  unbindSocket(ws) {
    const meta = this.socketMeta.get(ws);
    if (!meta) {
      return;
    }
    if (meta.clientType === CLIENT_TYPES.DISPLAY) {
      this.closeRoom(meta.roomCode, { reason: "display-disconnected" });
      return;
    }
    this.socketMeta.delete(ws);
    const room = this.rooms.get(meta.roomCode);
    room?.unregisterSocket(ws);
  }

  sendError(ws, message, roomCode = null) {
    if (ws.readyState !== 1) {
      return;
    }
    ws.send(JSON.stringify({ type: MSG_TYPES.ROOM_ERROR, payload: { message, roomCode } }));
  }

  async registerDisplay(ws, payload = {}) {
    const existing = this.socketMeta.get(ws);
    if (existing) {
      this.unbindSocket(ws);
    }
    const room = await this.createRoom(payload.roomCode);
    this.bindSocket(ws, { clientType: CLIENT_TYPES.DISPLAY, roomCode: room.roomCode });
    room.registerDisplay(ws);
    return room;
  }

  async registerController(ws, payload = {}) {
    const roomCode = normalizeRoomCode(payload.roomCode);
    if (!roomCode || roomCode.length < ROOM_CODE_LENGTH) {
      this.sendError(ws, COPY.errors.invalidRoomCode, roomCode || null);
      return null;
    }
    const sessionId = String(payload.sessionId || "").trim();
    if (!sessionId) {
      this.sendError(ws, COPY.errors.missingSessionId, roomCode);
      return null;
    }
    const room = this.getRoom(roomCode);
    if (!room) {
      this.sendError(ws, COPY.errors.roomNotFound, roomCode);
      return null;
    }
    const existing = this.socketMeta.get(ws);
    if (existing) {
      this.unbindSocket(ws);
    }
    const player = room.registerController(ws, {
      name: payload.name,
      sessionId
    });
    if (!player) {
      return null;
    }
    this.bindSocket(ws, {
      clientType: CLIENT_TYPES.CONTROLLER,
      roomCode,
      sessionId,
      playerId: player.id
    });
    return room;
  }

  async replaceDisplayRoom(ws, payload = {}) {
    const meta = this.socketMeta.get(ws);
    if (!meta || meta.clientType !== CLIENT_TYPES.DISPLAY) {
      return null;
    }
    const previousRoom = this.rooms.get(meta.roomCode);
    const nextRoom = await this.createRoom(payload.roomCode);
    this.bindSocket(ws, { clientType: CLIENT_TYPES.DISPLAY, roomCode: nextRoom.roomCode });
    nextRoom.registerDisplay(ws);
    this.logger("room", "display-replaced-room", {
      previousRoomCode: previousRoom?.roomCode || null,
      nextRoomCode: nextRoom.roomCode
    });
    if (previousRoom) {
      this.closeRoom(previousRoom.roomCode, {
        reason: "display-new-room",
        replacementRoomCode: nextRoom.roomCode,
        excludeSockets: [ws]
      });
    }
    return nextRoom;
  }

  async handleHello(ws, payload = {}) {
    if (payload.clientType === CLIENT_TYPES.DISPLAY) {
      return this.registerDisplay(ws, payload);
    }
    if (payload.clientType === CLIENT_TYPES.CONTROLLER) {
      return this.registerController(ws, payload);
    }
    this.sendError(ws, "Unknown client type.");
    return null;
  }

  handleRoomMessage(ws, message) {
    const meta = this.socketMeta.get(ws);
    if (!meta) {
      this.sendError(ws, "Send HELLO before other messages.");
      return;
    }
    if (message.type === MSG_TYPES.DISPLAY_NEW_ROOM) {
      this.replaceDisplayRoom(ws, message.payload || {});
      return;
    }
    if (message.type === MSG_TYPES.LEAVE && meta.clientType === CLIENT_TYPES.CONTROLLER) {
      const room = this.getRoom(meta.roomCode);
      room?.leaveController(ws);
      this.socketMeta.delete(ws);
      return;
    }
    const room = this.getRoom(meta.roomCode);
    if (!room) {
      this.sendError(ws, COPY.roomClosed.unavailable, meta.roomCode);
      this.socketMeta.delete(ws);
      return;
    }
    room.handleControllerMessage(ws, message);
  }

  tick() {
    for (const room of this.rooms.values()) {
      room.tick();
    }
  }
}
