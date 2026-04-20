import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { MSG_TYPES, TICK_MS, safeParseMessage } from "../shared/protocol.js";
import { logServerEvent } from "./debugLog.js";
import { RoomRegistry } from "./roomRegistry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const buildVersion = process.env.BUILD_VERSION || new Date().toISOString().replace(/[:.]/g, "-");
const HEARTBEAT_MS = 10000;
const runtimeEnvironment = process.env.NODE_ENV || "development";

function findMkcertPair() {
  if (process.env.DISABLE_TLS === "1") {
    return null;
  }
  const entries = fs.readdirSync(rootDir);
  const certFile = entries.find((entry) => entry.endsWith(".pem") && !entry.endsWith("-key.pem"));
  if (!certFile) {
    return null;
  }
  const keyFile = certFile.replace(/\.pem$/, "-key.pem");
  if (!entries.includes(keyFile)) {
    return null;
  }
  return {
    certPath: path.join(rootDir, certFile),
    keyPath: path.join(rootDir, keyFile)
  };
}

function shouldUseLocalTls() {
  if (process.env.ENABLE_LOCAL_TLS === "1") {
    return true;
  }
  if (process.env.ENABLE_LOCAL_TLS === "0") {
    return false;
  }
  if (process.env.RENDER === "true") {
    return false;
  }
  return runtimeEnvironment !== "production";
}

const localTlsEnabled = shouldUseLocalTls();
const tlsPair = localTlsEnabled ? findMkcertPair() : null;
const protocol = tlsPair ? "https" : "http";
const publicHost = process.env.PUBLIC_HOST || process.env.HOST || "127.0.0.1";
const publicOrigin = process.env.PUBLIC_ORIGIN || `${protocol}://${publicHost}:${port}`;

const app = express();
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("X-Waveform-Build", buildVersion);
  next();
});
app.use(express.static(path.join(rootDir, "client")));
app.use("/shared", express.static(path.join(rootDir, "shared")));
app.use("/pixi", express.static(path.join(rootDir, "node_modules/pixi.js/dist")));
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    buildVersion,
    publicOrigin,
    transport: tlsPair ? "local-https" : "http-behind-proxy",
    localTlsEnabled
  });
});
app.get("/", (_req, res) => {
  res.redirect("/display/");
});

const server = tlsPair
  ? https.createServer(
      {
        cert: fs.readFileSync(tlsPair.certPath),
        key: fs.readFileSync(tlsPair.keyPath)
      },
      app
    )
  : http.createServer(app);

const wss = new WebSocketServer({ server });
const roomRegistry = new RoomRegistry({
  publicOrigin,
  logger: logServerEvent
});

wss.on("connection", (ws) => {
  ws.isAlive = true;
  logServerEvent("ws", "connection-open");
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", async (rawMessage) => {
    const message = safeParseMessage(rawMessage.toString());
    if (!message?.type) {
      return;
    }

    if (message.type === MSG_TYPES.HELLO) {
      logServerEvent("ws", "hello", {
        clientType: message.payload?.clientType || null,
        roomCode: message.payload?.roomCode || null,
        sessionId: message.payload?.sessionId || null
      });
      await roomRegistry.handleHello(ws, message.payload || {});
      return;
    }

    roomRegistry.handleRoomMessage(ws, message);
  });

  ws.on("close", () => {
    logServerEvent("ws", "connection-close");
    roomRegistry.unbindSocket(ws);
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_MS);

setInterval(() => {
  roomRegistry.tick();
}, TICK_MS);

server.listen(port, host, () => {
  console.log(`Waveform Attack server listening on ${publicOrigin}`);
  console.log(`Build version: ${buildVersion}`);
  if (tlsPair) {
    console.log(`TLS certificate: ${tlsPair.certPath}`);
  } else {
    console.log("TLS certificate: disabled or not found, using HTTP");
  }
  console.log(`Display: ${publicOrigin}/display/`);
  console.log(`Controller: ${publicOrigin}/controller/`);
});
