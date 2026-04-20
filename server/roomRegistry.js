import { CLIENT_TYPES, MSG_TYPES, normalizeRoomCode } from "../shared/protocol.js";
import { RoomSession } from "./roomSession.js";

const ROOM_CODE_LENGTH = 4;

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

  async createRoom(preferredCode = null) {
    let roomCode = normalizeRoomCode(preferredCode);
    while (!roomCode || this.rooms.has(roomCode)) {
      roomCode = randomRoomCode();
    }
    const room = new RoomSession({
      roomCode,
      publicOrigin: this.publicOrigin,
      logger: this.logger,
      onRoomEmpty: (code) => {
        const current = this.rooms.get(code);
        if (current && current.controllerSockets.size === 0 && !current.display) {
          this.logger("room-registry", "delete-room", { roomCode: code });
          this.rooms.delete(code);
        }
      }
    });
    this.rooms.set(roomCode, room);
    this.logger("room-registry", "create-room", { roomCode });
    await room.ready;
    return room;
  }

  getRoom(roomCode) {
    const normalized = normalizeRoomCode(roomCode);
    if (!normalized) {
      return null;
    }
    return this.rooms.get(normalized) || null;
  }

  async getOrCreateRoom(roomCode = null) {
    const existing = this.getRoom(roomCode);
    if (existing) {
      return existing;
    }
    return this.createRoom(roomCode);
  }

  bindSocket(ws, meta) {
    this.socketMeta.set(ws, meta);
  }

  unbindSocket(ws) {
    const meta = this.socketMeta.get(ws);
    if (!meta) {
      return;
    }
    this.logger("room-registry", "unbind-socket", meta);
    this.socketMeta.delete(ws);
    const room = this.getRoom(meta.roomCode);
    room?.unregisterSocket(ws);
  }

  sendError(ws, message, roomCode = null) {
    if (ws.readyState !== 1) {
      return;
    }
    ws.send(
      JSON.stringify({
        type: MSG_TYPES.ROOM_ERROR,
        payload: {
          message,
          roomCode
        }
      })
    );
  }

  async registerDisplay(ws, payload = {}) {
    const previous = this.socketMeta.get(ws);
    if (previous) {
      this.unbindSocket(ws);
    }

    const room = await this.getOrCreateRoom(payload.roomCode);
    this.logger("room-registry", "register-display", { roomCode: room.roomCode });
    this.bindSocket(ws, {
      clientType: CLIENT_TYPES.DISPLAY,
      roomCode: room.roomCode
    });
    room.registerDisplay(ws, payload);
    return room;
  }

  async registerController(ws, payload = {}) {
    const roomCode = normalizeRoomCode(payload.roomCode);
    if (!roomCode || roomCode.length < ROOM_CODE_LENGTH) {
      this.sendError(ws, "Enter a valid room code.", roomCode || null);
      return null;
    }

    const sessionId = String(payload.sessionId || "").trim();
    if (!sessionId) {
      this.sendError(ws, "Missing session id.", roomCode);
      return null;
    }

    const room = this.getRoom(roomCode);
    if (!room) {
      this.sendError(ws, "Room not found.", roomCode);
      return null;
    }

    const previous = this.socketMeta.get(ws);
    if (previous) {
      this.unbindSocket(ws);
    }

    this.bindSocket(ws, {
      clientType: CLIENT_TYPES.CONTROLLER,
      roomCode,
      sessionId
    });

    const player = room.registerController(ws, {
      name: payload.name,
      sessionId
    });
    if (!player) {
      this.socketMeta.delete(ws);
      return null;
    }

    this.logger("room-registry", "register-controller", {
      roomCode,
      sessionId,
      playerId: player.id,
      role: player.role
    });

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

    const previousRoom = this.getRoom(meta.roomCode);
    const nextRoom = await this.createRoom(payload.roomCode);
    this.logger("room-registry", "replace-display-room", {
      previousRoomCode: previousRoom?.roomCode || null,
      nextRoomCode: nextRoom.roomCode
    });

    this.bindSocket(ws, {
      clientType: CLIENT_TYPES.DISPLAY,
      roomCode: nextRoom.roomCode
    });
    nextRoom.registerDisplay(ws, payload);

    previousRoom?.close({
      reason: "display-new-room",
      replacementRoomCode: nextRoom.roomCode
    });
    if (previousRoom) {
      this.rooms.delete(previousRoom.roomCode);
    }
    return nextRoom;
  }

  async handleHello(ws, payload = {}) {
    const clientType = payload.clientType;
    if (clientType === CLIENT_TYPES.DISPLAY) {
      return this.registerDisplay(ws, payload);
    }
    if (clientType === CLIENT_TYPES.CONTROLLER) {
      return this.registerController(ws, payload);
    }
    this.sendError(ws, "Unknown client type.");
    return null;
  }

  handleRoomMessage(ws, message) {
    const meta = this.socketMeta.get(ws);
    if (!meta) {
      this.sendError(ws, "Send HELLO before game messages.");
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
      this.sendError(ws, "Room is no longer available.", meta.roomCode);
      this.socketMeta.delete(ws);
      return;
    }

    room.handleMessage(ws, message);
  }

  tick() {
    this.rooms.forEach((room) => room.tick());
  }
}
