import test from "node:test";
import assert from "node:assert/strict";
import { RoomSession } from "../server/roomSession.js";
import { ROLES } from "../shared/protocol.js";

test("room session builds a summary-only overlay before display capture arrives", async () => {
  const room = new RoomSession({
    roomCode: "1234",
    publicOrigin: "http://127.0.0.1:3000"
  });
  await room.ready;

  room.state.state.phase = "RESULT";
  room.state.state.winner = ROLES.ATTACKER;
  room.state.state.recentEvents = [
    {
      playerId: "runner-1",
      message: "Runner OUT",
      kind: "out",
      createdAt: Date.now()
    }
  ];

  room.createResultOverlay();
  const payload = room.buildResultOverlayPayload();

  assert.equal(payload.overlayMode, "summary-only");
  assert.equal(payload.winner, ROLES.ATTACKER);
  assert.equal(payload.items.length, 0);
  assert.match(payload.summary, /Attacker wins this round\./);
  assert.match(payload.summary, /Runner OUT/);
});

test("room session upgrades the overlay after a display screenshot arrives", async () => {
  const room = new RoomSession({
    roomCode: "9999",
    publicOrigin: "http://127.0.0.1:3000"
  });
  await room.ready;

  room.state.state.phase = "RESULT";
  room.state.state.winner = ROLES.ATTACKER;
  room.state.state.recentEvents = [];
  room.createResultOverlay();
  const applied = room.applyDisplayCapture({
    roundId: room.state.state.roundId,
    caption: "Big screen highlight",
    filename: "result.jpg",
    imageBase64: "data:image/jpeg;base64,ZmFrZQ=="
  });

  const payload = room.buildResultOverlayPayload();
  assert.equal(applied, true);
  assert.equal(payload.overlayMode, "summary-with-images");
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].filename, "result.jpg");
  assert.equal(payload.items[0].eventType, "round-end");
  assert.equal(payload.items[0].roundId, room.state.state.roundId);
});

test("room session keeps multiple display captures for the same round", async () => {
  const room = new RoomSession({
    roomCode: "9898",
    publicOrigin: "http://127.0.0.1:3000"
  });
  await room.ready;

  room.state.state.phase = "RESULT";
  room.state.state.winner = ROLES.ATTACKER;
  room.createResultOverlay();
  room.applyDisplayCapture({
    roundId: room.state.state.roundId,
    captureId: "arena-overview",
    filename: "overview.jpg",
    imageBase64: "data:image/jpeg;base64,ZmFrZQ=="
  });
  room.applyDisplayCapture({
    roundId: room.state.state.roundId,
    captureId: "life-lost-runner-1",
    eventType: "life-lost",
    capturedAt: 20,
    filename: "impact.jpg",
    imageBase64: "data:image/jpeg;base64,ZmFrZQ=="
  });

  const payload = room.buildResultOverlayPayload();
  assert.equal(payload.items.length, 2);
  assert.equal(payload.items[0].filename, "impact.jpg");
  assert.equal(payload.items[1].filename, "overview.jpg");
});

test("room session keeps display capture metadata for highlight bursts", async () => {
  const room = new RoomSession({
    roomCode: "5656",
    publicOrigin: "http://127.0.0.1:3000"
  });
  await room.ready;

  room.state.state.phase = "RESULT";
  room.state.state.winner = ROLES.ATTACKER;
  room.createResultOverlay();
  room.applyDisplayCapture({
    roundId: room.state.state.roundId,
    captureId: "life-lost-runner-1",
    caption: "Life lost",
    eventType: "life-lost",
    capturedAt: 123456789,
    filename: "life-lost.jpg",
    imageBase64: "data:image/jpeg;base64,ZmFrZQ=="
  });

  const payload = room.buildResultOverlayPayload();
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].captureId, "life-lost-runner-1");
  assert.equal(payload.items[0].eventType, "life-lost");
  assert.equal(payload.items[0].capturedAt, 123456789);
});

test("room session caches playing-phase captures until result overlay exists", async () => {
  const room = new RoomSession({
    roomCode: "3434",
    publicOrigin: "http://127.0.0.1:3000"
  });
  await room.ready;

  room.state.state.phase = "PLAYING";
  const appliedWhilePlaying = room.applyDisplayCapture({
    roundId: room.state.state.roundId,
    captureId: "round-start-test",
    eventType: "round-start",
    capturedAt: 10,
    filename: "start.jpg",
    imageBase64: "data:image/jpeg;base64,ZmFrZQ=="
  });

  assert.equal(appliedWhilePlaying, true);
  assert.equal(room.currentResultOverlay, null);

  room.state.state.phase = "RESULT";
  room.createResultOverlay();
  const payload = room.buildResultOverlayPayload();

  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].eventType, "round-start");
  assert.equal(payload.items[0].filename, "start.jpg");
});

test("room session sorts captures by event priority before round-end fillers", async () => {
  const room = new RoomSession({
    roomCode: "4646",
    publicOrigin: "http://127.0.0.1:3000"
  });
  await room.ready;

  room.state.state.phase = "RESULT";
  room.state.state.winner = ROLES.ATTACKER;
  room.createResultOverlay();
  room.applyDisplayCapture({
    roundId: room.state.state.roundId,
    captureId: "round-end-impact",
    eventType: "round-end",
    capturedAt: 50,
    filename: "round-end.jpg",
    imageBase64: "data:image/jpeg;base64,ZmFrZQ=="
  });
  room.applyDisplayCapture({
    roundId: room.state.state.roundId,
    captureId: "player-out-impact",
    eventType: "player-out",
    capturedAt: 40,
    filename: "player-out.jpg",
    imageBase64: "data:image/jpeg;base64,ZmFrZQ=="
  });

  const payload = room.buildResultOverlayPayload();
  assert.equal(payload.items[0].eventType, "player-out");
  assert.equal(payload.items[1].eventType, "round-end");
});

test("room session keeps the shared result overlay available after result phase ends", async () => {
  const room = new RoomSession({
    roomCode: "5678",
    publicOrigin: "http://127.0.0.1:3000"
  });
  await room.ready;

  room.state.state.phase = "RESULT";
  room.state.state.winner = ROLES.PLAYER;
  room.state.state.recentEvents = [];
  room.syncResultOverlayForPhase();

  const resultPayload = room.buildResultOverlayPayload();
  assert.equal(resultPayload.overlayMode, "summary-only");
  assert.equal(resultPayload.winner, ROLES.PLAYER);
  assert.equal(resultPayload.items.length, 0);

  room.lastPhase = "RESULT";
  room.state.state.phase = "ROLE_SELECT";
  room.syncResultOverlayForPhase();

  const persistedPayload = room.buildResultOverlayPayload();
  assert.equal(persistedPayload.overlayMode, "summary-only");
  assert.equal(persistedPayload.winner, ROLES.PLAYER);
  assert.match(persistedPayload.summary, /Runners survive this round\./);
});
