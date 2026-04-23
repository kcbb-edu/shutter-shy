# Shutter Shy

## Local run

Install dependencies, then start the server:

```bash
npm install
npm start
```

The Node server hosts both the WebSocket backend and the Vite-powered client pages on one port.

Routes:

```text
/display/
/controller/
/health
```

By default, local development uses a repo-local mkcert pair if one is present. To force plain HTTP:

```bash
DISABLE_TLS=1 npm start
```

To build the production client bundle:

```bash
npm run build
```

To run the test suite:

```bash
npm test
```

## Gameplay prototype

- One display opens the room and renders the full arena.
- One photographer phone rotates in place and takes photos.
- Up to three runner phones move around the ring.
- Fountain jets randomly block line of sight.
- Runners upload a face still that is mapped onto their avatar.
- The round lasts 30 seconds or ends early once all unique runners are captured.

## Exhibition checklist

1. Open `/display/` 5 to 10 minutes before the session starts.
2. Confirm `/health` reports the expected `publicOrigin`.
3. Confirm the display QR code opens `/controller/?room=...` on the same Render hostname.
4. Confirm runner phones can grant camera access over HTTPS.
5. Confirm the photographer phone can grant motion permission on Safari.
6. Keep the display tab open during the exhibition.
