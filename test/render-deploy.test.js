import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { CLIENT_TYPES, MSG_TYPES } from "../shared/protocol.js";

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

test("render deploy settings expose the configured public origin in health and room join URLs", async (t) => {
  const port = 44200 + Math.floor(Math.random() * 1000);
  const localOrigin = `http://127.0.0.1:${port}`;
  const publicOrigin = "https://waveform-attack-demo.onrender.com";
  const wsOrigin = `ws://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      DISABLE_TLS: "1",
      PUBLIC_ORIGIN: publicOrigin
    },
    stdio: "pipe"
  });

  t.after(() => {
    server.kill("SIGTERM");
  });

  await waitForServer(localOrigin);

  const healthResponse = await fetch(`${localOrigin}/health`);
  const health = await healthResponse.json();
  assert.equal(health.ok, true);
  assert.equal(health.publicOrigin, publicOrigin);
  assert.equal(health.transport, "http-behind-proxy");
  assert.equal(health.localTlsEnabled, false);

  const display = createClient(wsOrigin);
  await display.openPromise;
  display.send(MSG_TYPES.HELLO, {
    clientType: CLIENT_TYPES.DISPLAY
  });
  const uiState = await display.waitFor((message) => message.type === MSG_TYPES.UI_STATE);
  const roomCode = uiState.payload.room.roomCode;
  assert.equal(uiState.payload.room.joinUrl, `${publicOrigin}/controller/?room=${roomCode}`);

  display.send(MSG_TYPES.DISPLAY_KEEPALIVE, { sentAt: Date.now() });
  await delay(100);
  assert.equal(display.ws.readyState, WebSocket.OPEN);

  display.close();
});
