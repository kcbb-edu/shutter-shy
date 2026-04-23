import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import {
  CLIENT_TYPES,
  GAME_PHASES,
  MSG_TYPES,
  ROLES
} from "../shared/protocol.js";

function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise(async (resolve, reject) => {
    while (Date.now() - start < timeoutMs) {
      try {
        const response = await fetch(`${url}/health`);
        if (response.ok) {
          resolve();
          return;
        }
      } catch {}
      await delay(100);
    }
    reject(new Error("Server did not become ready in time."));
  });
}

function createClient(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];

  ws.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    messages.push(message);
    for (let index = 0; index < waiters.length; index += 1) {
      const waiter = waiters[index];
      if (waiter.predicate(message)) {
        waiters.splice(index, 1);
        waiter.resolve(message);
        index -= 1;
      }
    }
  });

  return {
    ws,
    openPromise: new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    }),
    send(type, payload = {}) {
      ws.send(JSON.stringify({ type, payload }));
    },
    waitFor(predicate, timeoutMs = 7000) {
      const existing = messages.find(predicate);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(new Error("Timed out waiting for message."));
        }, timeoutMs);
        waiters.push({
          predicate(message) {
            if (!predicate(message)) {
              return false;
            }
            clearTimeout(timeout);
            return true;
          },
          resolve
        });
      });
    },
    close() {
      ws.close();
    }
  };
}

test("display and controllers can join, ready up, and reach playing state", async (t) => {
  const port = 44000 + Math.floor(Math.random() * 1000);
  const origin = `http://127.0.0.1:${port}`;
  const wsOrigin = `ws://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PUBLIC_HOST: "127.0.0.1",
      PUBLIC_ORIGIN: origin,
      DISABLE_TLS: "1",
      NODE_ENV: "test"
    },
    stdio: "pipe"
  });

  t.after(() => {
    server.kill("SIGTERM");
  });

  await waitForServer(origin);

  const display = createClient(wsOrigin);
  await display.openPromise;
  display.send(MSG_TYPES.HELLO, { clientType: CLIENT_TYPES.DISPLAY });
  const roomState = await display.waitFor((message) => message.type === MSG_TYPES.ROOM_STATE);
  const roomCode = roomState.payload.room.roomCode;
  assert.match(roomCode, /^\d{4}$/);

  const photographer = createClient(wsOrigin);
  await photographer.openPromise;
  photographer.send(MSG_TYPES.HELLO, {
    clientType: CLIENT_TYPES.CONTROLLER,
    roomCode,
    name: "Photo",
    sessionId: "photo-session"
  });
  const photographerRoom = await photographer.waitFor((message) => message.type === MSG_TYPES.ROOM_STATE && message.payload.self.playerId);
  const photographerId = photographerRoom.payload.self.playerId;

  const runner = createClient(wsOrigin);
  await runner.openPromise;
  runner.send(MSG_TYPES.HELLO, {
    clientType: CLIENT_TYPES.CONTROLLER,
    roomCode,
    name: "Runner",
    sessionId: "runner-session"
  });
  const runnerRoom = await runner.waitFor((message) => message.type === MSG_TYPES.ROOM_STATE && message.payload.self.playerId);
  const runnerId = runnerRoom.payload.self.playerId;

  photographer.send(MSG_TYPES.LOAD_PROGRESS, { progress: 100 });
  runner.send(MSG_TYPES.LOAD_PROGRESS, { progress: 100 });
  photographer.send(MSG_TYPES.ROLE_SET, { role: ROLES.PHOTOGRAPHER });
  runner.send(MSG_TYPES.ROLE_SET, { role: ROLES.RUNNER });
  photographer.send(MSG_TYPES.THEME_SET, { themeId: "synthwave" });
  const themedLobby = await runner.waitFor(
    (message) => message.type === MSG_TYPES.LOBBY_STATE && message.payload.themePreference === "synthwave" && message.payload.resolvedTheme === "synthwave",
    7000
  );
  assert.equal(themedLobby.payload.themePreference, "synthwave");
  photographer.send(MSG_TYPES.LOAD_PROGRESS, { progress: 100, setup: { motionReady: true } });
  runner.send(MSG_TYPES.FACE_FRAME, {
    imageDataUrl: "data:image/jpeg;base64,ZmFrZQ==",
    capturedAt: Date.now()
  });
  photographer.send(MSG_TYPES.READY_SET, { ready: true });
  runner.send(MSG_TYPES.READY_SET, { ready: true });

  const playingState = await photographer.waitFor(
    (message) =>
      message.type === MSG_TYPES.ROUND_STATE &&
      message.payload.phase === GAME_PHASES.PLAYING &&
      message.payload.resolvedTheme === "synthwave" &&
      message.payload.photographerPlayerId === photographerId &&
      message.payload.players.some((player) => player.id === runnerId),
    10000
  );

  assert.equal(playingState.payload.phase, GAME_PHASES.PLAYING);

  display.close();
  const closedMessage = await photographer.waitFor(
    (message) => message.type === MSG_TYPES.ROOM_CLOSED && message.payload?.reason === "display-disconnected",
    5000
  );
  assert.equal(closedMessage.payload.reason, "display-disconnected");

  photographer.close();
  runner.close();
});
