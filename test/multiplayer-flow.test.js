import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { CLIENT_TYPES, GAME_PHASES, MSG_TYPES, ROLES } from "../shared/protocol.js";

function waitForServer(url, timeoutMs = 10000) {
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

  const openPromise = new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  return {
    ws,
    openPromise,
    send(type, payload = {}) {
      ws.send(JSON.stringify({ type, payload }));
    },
    waitFor(predicate, timeoutMs = 5000) {
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

test("display, attacker, and runner can complete the main room flow", async (t) => {
  const port = 43100 + Math.floor(Math.random() * 1000);
  const origin = `http://127.0.0.1:${port}`;
  const wsOrigin = `ws://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DISABLE_TLS: "1",
      PUBLIC_ORIGIN: origin,
      PUBLIC_HOST: "127.0.0.1"
    },
    stdio: "pipe"
  });

  t.after(() => {
    server.kill("SIGTERM");
  });

  await waitForServer(origin);

  const display = createClient(wsOrigin);
  await display.openPromise;
  display.send(MSG_TYPES.HELLO, {
    clientType: CLIENT_TYPES.DISPLAY
  });
  const displayUiState = await display.waitFor((message) => message.type === MSG_TYPES.UI_STATE);
  const roomCode = displayUiState.payload.room.roomCode;
  assert.equal(roomCode.length, 4);

  const attacker = createClient(wsOrigin);
  await attacker.openPromise;
  attacker.send(MSG_TYPES.HELLO, {
    clientType: CLIENT_TYPES.CONTROLLER,
    roomCode,
    name: "Attacker",
    sessionId: "attacker-session"
  });
  await attacker.waitFor((message) => message.type === MSG_TYPES.UI_STATE && message.payload.self.playerId);
  const attackerOverlayState = await attacker.waitFor((message) => message.type === MSG_TYPES.HIGHLIGHTS);
  assert.equal(attackerOverlayState.payload.overlayMode, "hidden");

  const runner = createClient(wsOrigin);
  await runner.openPromise;
  runner.send(MSG_TYPES.HELLO, {
    clientType: CLIENT_TYPES.CONTROLLER,
    roomCode,
    name: "Runner",
    sessionId: "runner-session"
  });
  const runnerUiState = await runner.waitFor((message) => message.type === MSG_TYPES.UI_STATE && message.payload.self.playerId);
  const runnerPlayerId = runnerUiState.payload.self.playerId;

  attacker.send(MSG_TYPES.SET_ROLE, { role: ROLES.ATTACKER });
  runner.send(MSG_TYPES.SET_ROLE, { role: ROLES.PLAYER });
  attacker.send(MSG_TYPES.ATTACKER_SETUP, {
    hasMicPermission: true,
    environmentPreset: "balanced",
    sensitivityPreset: "balanced",
    noiseGate: 0.018,
    ceiling: 0.18,
    status: "preset",
    skipped: true
  });
  attacker.send(MSG_TYPES.READY);
  runner.send(MSG_TYPES.READY);

  const playingState = await attacker.waitFor(
    (message) => message.type === MSG_TYPES.GAME_STATE && message.payload.game.phase === GAME_PHASES.PLAYING,
    7000
  );
  assert.equal(playingState.payload.game.phase, GAME_PHASES.PLAYING);

  attacker.send(MSG_TYPES.AUDIO, {
    dominantBandIndex: 5,
    dominantBandHz: 420,
    bandLevels: [0, 0, 0, 0, 0.35, 1, 0.35, 0, 0, 0, 0, 0],
    amplitudeNorm: 0.9,
    profileRangeHz: { lowHz: 140, highHz: 720 },
    voiced: true
  });
  const terrainState = await attacker.waitFor(
    (message) => message.type === MSG_TYPES.GAME_STATE && Number.isInteger(message.payload.game.terrain?.activeBandIndex),
    5000
  );
  assert.equal(Array.isArray(terrainState.payload.game.terrain?.bars), true);
  assert.equal(terrainState.payload.game.terrain.bars.length, 12);

  runner.close();
  await delay(250);

  const runnerReconnected = createClient(wsOrigin);
  await runnerReconnected.openPromise;
  runnerReconnected.send(MSG_TYPES.HELLO, {
    clientType: CLIENT_TYPES.CONTROLLER,
    roomCode,
    name: "Runner",
    sessionId: "runner-session"
  });
  const rejoinSnapshot = await runnerReconnected.waitFor(
    (message) => message.type === MSG_TYPES.UI_STATE && message.payload.self.playerId,
    5000
  );
  assert.equal(rejoinSnapshot.payload.self.playerId, runnerPlayerId);

  display.send(MSG_TYPES.DISPLAY_NEW_ROOM, {});
  const replaced = await attacker.waitFor(
    (message) => message.type === MSG_TYPES.ROOM_CLOSED && message.payload.replacementRoomCode,
    5000
  );
  assert.match(replaced.payload.replacementRoomCode, /^\d{4}$/);

  attacker.close();
  runnerReconnected.close();
  display.close();
});
