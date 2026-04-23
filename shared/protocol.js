import {
  ARENA,
  CLIENT_TYPES,
  COUNTDOWN_SECONDS,
  FACE_UPLOAD_INTERVAL_MS,
  GAME_PHASES,
  LOAD_READY_PERCENT,
  MAX_FACE_FRAME_BYTES,
  MAX_PHOTO_BYTES,
  MAX_PLAYERS,
  MAX_RUNNERS,
  PLAYER_COLORS,
  RESULTS_SECONDS,
  ROLES,
  ROOM_CODE_LENGTH,
  ROUND_SECONDS,
  SHUTTER_COOLDOWN_MS,
  TICK_MS,
  TICK_RATE
} from "./constants.js";

export {
  ARENA,
  CLIENT_TYPES,
  COUNTDOWN_SECONDS,
  FACE_UPLOAD_INTERVAL_MS,
  GAME_PHASES,
  LOAD_READY_PERCENT,
  MAX_FACE_FRAME_BYTES,
  MAX_PHOTO_BYTES,
  MAX_PLAYERS,
  MAX_RUNNERS,
  PLAYER_COLORS,
  RESULTS_SECONDS,
  ROLES,
  ROOM_CODE_LENGTH,
  ROUND_SECONDS,
  SHUTTER_COOLDOWN_MS,
  TICK_MS,
  TICK_RATE
};

export const MSG_TYPES = {
  HELLO: "HELLO",
  ROOM_STATE: "ROOM_STATE",
  LOBBY_STATE: "LOBBY_STATE",
  LOAD_PROGRESS: "LOAD_PROGRESS",
  ROLE_SET: "ROLE_SET",
  THEME_SET: "THEME_SET",
  READY_SET: "READY_SET",
  ROUND_STATE: "ROUND_STATE",
  RUNNER_INPUT: "RUNNER_INPUT",
  CAMERA_MOTION: "CAMERA_MOTION",
  SHUTTER: "SHUTTER",
  FACE_FRAME: "FACE_FRAME",
  PHOTO_RESULT: "PHOTO_RESULT",
  GALLERY_STATE: "GALLERY_STATE",
  GALLERY_REVIEW_SET: "GALLERY_REVIEW_SET",
  ROOM_ERROR: "ROOM_ERROR",
  ROOM_CLOSED: "ROOM_CLOSED",
  DISPLAY_NEW_ROOM: "DISPLAY_NEW_ROOM",
  LEAVE: "LEAVE"
};

export const ARENA_THEME_IDS = ["neon", "synthwave"];
export const DEFAULT_ARENA_THEME_ID = ARENA_THEME_IDS[0];

export function createMessage(type, payload = {}) {
  return { type, payload };
}

export function safeParseMessage(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function normalizeRoomCode(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-z0-9]/gi, "")
    .toUpperCase()
    .slice(0, ROOM_CODE_LENGTH);
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function isArenaThemeId(value) {
  return ARENA_THEME_IDS.includes(value);
}

export function roundSeconds(value, digits = 1) {
  return Number(Number(value || 0).toFixed(digits));
}

export function normalizeAngle(angle) {
  let value = angle;
  while (value <= -Math.PI) {
    value += Math.PI * 2;
  }
  while (value > Math.PI) {
    value -= Math.PI * 2;
  }
  return value;
}

export function isDataUrlWithinLimit(dataUrl, maxBytes) {
  if (!/^data:image\/(?:jpeg|png|webp);base64,/.test(String(dataUrl || ""))) {
    return false;
  }
  const base64 = dataUrl.split(",")[1] || "";
  return Buffer.byteLength(base64, "base64") <= maxBytes;
}
