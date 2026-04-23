import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { RoomRegistry } from "./roomRegistry.js";
import { MSG_TYPES, TICK_MS, safeParseMessage } from "../shared/protocol.js";
import { logServerEvent } from "./debugLog.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist/client");
const runtimeEnvironment =
  process.env.NODE_ENV || (process.env.RENDER === "true" ? "production" : "development");
const isProduction = runtimeEnvironment === "production";
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const buildVersion = process.env.BUILD_VERSION || new Date().toISOString().replace(/[:.]/g, "-");
const HEARTBEAT_MS = 10000;

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
const publicHost =
  process.env.PUBLIC_HOST ||
  process.env.RENDER_EXTERNAL_HOSTNAME ||
  process.env.HOST ||
  "127.0.0.1";
const publicOrigin =
  process.env.PUBLIC_ORIGIN ||
  process.env.RENDER_EXTERNAL_URL ||
  `${protocol}://${publicHost}:${port}`;

const app = express();
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Shutter-Shy-Build", buildVersion);
  next();
});
app.use("/shared", express.static(path.join(rootDir, "shared")));

const viteServer = isProduction
  ? null
  : await (async () => {
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        server: { middlewareMode: true, hmr: false },
        appType: "custom"
      });
      app.use(vite.middlewares);
      return vite;
    })();

async function createHtmlHandler(templatePath, url) {
  if (isProduction) {
    const builtPath = path.join(distDir, "clients", templatePath);
    return (_req, res) => {
      res.sendFile(builtPath);
    };
  }
  return async (_req, res, next) => {
    try {
      const htmlPath = path.join(rootDir, "clients", templatePath);
      const raw = await fs.promises.readFile(htmlPath, "utf8");
      const transformed = await viteServer.transformIndexHtml(url, raw);
      res.status(200).set({ "Content-Type": "text/html" }).end(transformed);
    } catch (error) {
      next(error);
    }
  };
}

const displayHandler = await createHtmlHandler("display/index.html", "/display/");
const controllerHandler = await createHtmlHandler("controller/index.html", "/controller/");

if (isProduction) {
  app.use(express.static(distDir));
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    buildVersion,
    publicOrigin,
    transport: tlsPair ? "local-https" : "http-behind-proxy",
    localTlsEnabled
  });
});
app.get("/", (_req, res) => res.redirect("/display/"));
app.get("/display/", displayHandler);
app.get("/controller/", controllerHandler);

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
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  ws.on("message", async (rawMessage) => {
    const message = safeParseMessage(rawMessage.toString());
    if (!message?.type) {
      return;
    }
    if (message.type === MSG_TYPES.HELLO) {
      await roomRegistry.handleHello(ws, message.payload || {});
      return;
    }
    roomRegistry.handleRoomMessage(ws, message);
  });
  ws.on("close", () => {
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
  console.log(`Shutter Shy server listening on ${publicOrigin}`);
  console.log(`Display: ${publicOrigin}/display/`);
  console.log(`Controller: ${publicOrigin}/controller/`);
});
