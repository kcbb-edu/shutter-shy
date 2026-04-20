# Waveform Attack

## Local run

Install dependencies and start the server:

```bash
npm install
npm start
```

By default, local development can use a repo-local mkcert pair if one is present. To force plain HTTP:

```bash
DISABLE_TLS=1 npm start
```

To force local HTTPS explicitly:

```bash
ENABLE_LOCAL_TLS=1 npm start
```

## Render deploy

Render should terminate HTTPS at the platform edge, so the app itself should run over HTTP inside the container.

Set these environment variables in Render:

```text
DISABLE_TLS=1
PUBLIC_ORIGIN=https://<your-service>.onrender.com
NODE_ENV=production
```

Recommended deploy flow:

1. Push this repo to GitHub.
2. Create the Render web service from `render.yaml`.
3. Let Render assign the initial `https://<service>.onrender.com` URL.
4. Set `PUBLIC_ORIGIN` to that exact URL.
5. Redeploy once so newly created rooms generate the correct QR code.

## Exhibition checklist

1. Open `/display/` 5 to 10 minutes before the session starts.
2. Confirm `/health` reports the expected `publicOrigin`.
3. Confirm the display QR code opens `/controller/?room=...` on the same Render hostname.
4. Confirm a phone can grant microphone access over HTTPS.
5. Keep the display tab open during the exhibition. It sends low-frequency WebSocket keepalives so Render Free does not spin down from idleness.
6. Close the display tab after the exhibition. Existing room cleanup logic will close the room when no display/controllers remain.
