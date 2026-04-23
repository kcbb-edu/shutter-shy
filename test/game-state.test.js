import test from "node:test";
import assert from "node:assert/strict";
import { GameState } from "../server/gameState.js";
import { COUNTDOWN_SECONDS, GAME_PHASES, RESULTS_SECONDS, ROLES, ROUND_SECONDS } from "../shared/protocol.js";

function createPreparedGame() {
  const game = new GameState("1234");
  const photographer = game.addOrReconnectPlayer("Photo", "photo-session");
  const runnerA = game.addOrReconnectPlayer("Runner A", "runner-a");
  const runnerB = game.addOrReconnectPlayer("Runner B", "runner-b");
  const runnerC = game.addOrReconnectPlayer("Runner C", "runner-c");

  game.chooseRole(photographer.id, ROLES.PHOTOGRAPHER);
  game.chooseRole(runnerA.id, ROLES.RUNNER);
  game.chooseRole(runnerB.id, ROLES.RUNNER);
  game.chooseRole(runnerC.id, ROLES.RUNNER);

  for (const player of [photographer, runnerA, runnerB, runnerC]) {
    game.setLoadProgress(player.id, 100, player.id === photographer.id ? { motionReady: true } : {});
  }
  for (const runner of [runnerA, runnerB, runnerC]) {
    game.updateFaceFrame(runner.id, {
      imageDataUrl: "data:image/jpeg;base64,ZmFrZQ==",
      capturedAt: Date.now()
    });
  }
  for (const player of [photographer, runnerA, runnerB, runnerC]) {
    const result = game.setReady(player.id, true);
    assert.equal(result.ok, true);
  }

  game.tick(game.lastTickAt + COUNTDOWN_SECONDS * 1000 + 10);
  assert.equal(game.state.phase, GAME_PHASES.PLAYING);
  return { game, photographer, runnerA, runnerB, runnerC };
}

test("runners need face frames before ready", () => {
  const game = new GameState("1234");
  const runner = game.addOrReconnectPlayer("Runner", "runner");
  game.chooseRole(runner.id, ROLES.RUNNER);
  game.setLoadProgress(runner.id, 100, {
    faceEnabled: true,
    faceReady: false
  });
  const result = game.setReady(runner.id, true);
  assert.equal(result.ok, false);
});

test("photographer needs motion permission before ready", () => {
  const game = new GameState("1234");
  const photographer = game.addOrReconnectPlayer("Photo", "photo");
  game.chooseRole(photographer.id, ROLES.PHOTOGRAPHER);
  game.setLoadProgress(photographer.id, 100);
  const result = game.setReady(photographer.id, true);
  assert.equal(result.ok, false);
});

test("runner can ready without a face frame when face mapping is skipped", () => {
  const game = new GameState("1234");
  const runner = game.addOrReconnectPlayer("Runner", "runner");
  game.chooseRole(runner.id, ROLES.RUNNER);
  game.setLoadProgress(runner.id, 100, {
    faceEnabled: false,
    faceReady: true
  });
  const result = game.setReady(runner.id, true);
  assert.equal(result.ok, true);
});

test("offline players do not block ready or countdown", () => {
  const game = new GameState("1234");
  const photographer = game.addOrReconnectPlayer("Photo", "photo");
  const runner = game.addOrReconnectPlayer("Runner", "runner");
  const staleRunner = game.addOrReconnectPlayer("Stale Runner", "stale-runner");

  game.chooseRole(photographer.id, ROLES.PHOTOGRAPHER);
  game.chooseRole(runner.id, ROLES.RUNNER);
  game.chooseRole(staleRunner.id, ROLES.RUNNER);

  game.setLoadProgress(photographer.id, 100, { motionReady: true });
  game.setLoadProgress(runner.id, 100, { faceEnabled: false, faceReady: true });
  game.setLoadProgress(staleRunner.id, 100, { faceEnabled: false, faceReady: true });

  game.disconnectPlayer(staleRunner.id);

  assert.equal(game.getLobbyState().minimumRequirementsMet, true);
  assert.equal(game.setReady(photographer.id, true).ok, true);
  assert.equal(game.setReady(runner.id, true).ok, true);
  assert.equal(game.state.phase, GAME_PHASES.COUNTDOWN);
});

test("runner face texture defaults off again after lobby reset", () => {
  const game = new GameState("1234");
  const runner = game.addOrReconnectPlayer("Runner", "runner");
  game.chooseRole(runner.id, ROLES.RUNNER);
  game.setLoadProgress(runner.id, 100, {
    faceEnabled: true,
    faceReady: true
  });
  game.updateFaceFrame(runner.id, {
    imageDataUrl: "data:image/jpeg;base64,ZmFrZQ==",
    capturedAt: Date.now()
  });

  game.resetForLobby();

  const lobbyPlayer = game.getLobbyState().players.find((player) => player.id === runner.id);
  assert.equal(lobbyPlayer.setup.faceEnabled, false);
  assert.equal(lobbyPlayer.setup.faceReady, true);
});

test("round state exposes runner face-enabled flag", () => {
  const game = new GameState("1234");
  const runner = game.addOrReconnectPlayer("Runner", "runner");
  game.chooseRole(runner.id, ROLES.RUNNER);
  game.setLoadProgress(runner.id, 100, {
    faceEnabled: true,
    faceReady: false
  });

  const roundPlayer = game.getRoundState().players.find((player) => player.id === runner.id);
  assert.equal(roundPlayer.faceEnabled, true);
});

test("photographer manual theme updates lobby preview immediately", () => {
  const game = new GameState("1234");
  const photographer = game.addOrReconnectPlayer("Photo", "photo");
  game.chooseRole(photographer.id, ROLES.PHOTOGRAPHER);

  const result = game.setThemePreference(photographer.id, "synthwave");

  assert.equal(result.ok, true);
  assert.equal(game.getRoomState().themePreference, "synthwave");
  assert.equal(game.getLobbyState().themePreference, "synthwave");
  assert.equal(game.getLobbyState().resolvedTheme, "synthwave");
});

test("random theme keeps preview until round start, then resolves once", () => {
  const originalRandom = Math.random;
  Math.random = () => 0.99;
  try {
    const game = new GameState("1234");
    const photographer = game.addOrReconnectPlayer("Photo", "photo");
    const runner = game.addOrReconnectPlayer("Runner", "runner");

    game.chooseRole(photographer.id, ROLES.PHOTOGRAPHER);
    game.chooseRole(runner.id, ROLES.RUNNER);
    game.setThemePreference(photographer.id, "neon");
    game.setThemePreference(photographer.id, null);
    assert.equal(game.getLobbyState().themePreference, null);
    assert.equal(game.getLobbyState().resolvedTheme, "neon");

    game.setLoadProgress(photographer.id, 100, { motionReady: true });
    game.setLoadProgress(runner.id, 100, { faceEnabled: false, faceReady: true });
    assert.equal(game.setReady(photographer.id, true).ok, true);
    assert.equal(game.setReady(runner.id, true).ok, true);

    game.tick(game.lastTickAt + COUNTDOWN_SECONDS * 1000 + 10);

    assert.equal(game.state.phase, GAME_PHASES.PLAYING);
    assert.equal(game.getRoundState().themePreference, null);
    assert.equal(game.getRoundState().resolvedTheme, "synthwave");
  } finally {
    Math.random = originalRandom;
  }
});

test("lobby and round state expose monotonic revisions", () => {
  const game = new GameState("1234");
  const initialLobbyRevision = game.getLobbyState().lobbyRevision;
  const initialRoundRevision = game.getRoundState().roundRevision;
  const runner = game.addOrReconnectPlayer("Runner", "runner");

  game.chooseRole(runner.id, ROLES.RUNNER);

  assert.ok(game.getLobbyState().lobbyRevision > initialLobbyRevision);
  assert.ok(game.getRoundState().roundRevision > initialRoundRevision);
});

test("photographer captures unique runners only once", () => {
  const { game, photographer, runnerA, runnerB, runnerC } = createPreparedGame();
  runnerA.angle = 0;
  runnerB.angle = 0.12;
  runnerC.angle = 1.8;
  photographer.yaw = 0;

  game.state.fountains.forEach((jet) => {
    jet.active = false;
  });

  const firstShot = game.registerShutter(photographer.id, {
    imageDataUrl: "data:image/jpeg;base64,ZmFrZQ=="
  });
  assert.equal(firstShot.ok, true);
  assert.deepEqual(firstShot.photo.newRunnerIds.sort(), [runnerA.id, runnerB.id].sort());
  assert.equal(game.state.capturedRunnerIds.length, 2);
  game.state.nextShutterAt = Date.now() - 1;

  const secondShot = game.registerShutter(photographer.id, {
    imageDataUrl: "data:image/jpeg;base64,ZmFrZQ=="
  });
  assert.equal(secondShot.ok, true);
  assert.equal(secondShot.photo.newRunnerIds.length, 0);
  assert.equal(game.state.capturedRunnerIds.length, 2);
  assert.equal(game.getGalleryState().items.length, 2);
  assert.equal(game.state.phase, GAME_PHASES.PLAYING);
});

test("server rejects shutter events during cooldown", () => {
  const { game, photographer, runnerA } = createPreparedGame();
  runnerA.angle = 0;
  photographer.yaw = 0;
  game.state.fountains.forEach((jet) => {
    jet.active = false;
  });

  const firstShot = game.registerShutter(photographer.id, {
    imageDataUrl: "data:image/jpeg;base64,ZmFrZQ=="
  });
  assert.equal(firstShot.ok, true);

  const secondShot = game.registerShutter(photographer.id, {
    imageDataUrl: "data:image/jpeg;base64,ZmFrZQ=="
  });
  assert.equal(secondShot.ok, false);
  assert.equal(secondShot.message, "快門冷卻中。");
  assert.equal(game.getGalleryState().items.length, 1);
});

test("active fountain can block an otherwise visible runner", () => {
  const { game, photographer, runnerA } = createPreparedGame();
  runnerA.angle = 0;
  photographer.yaw = 0;
  game.state.fountains.forEach((jet, index) => {
    jet.active = index === 0;
    jet.angle = index === 0 ? 0 : Math.PI;
  });
  const shot = game.registerShutter(photographer.id, {
    imageDataUrl: "data:image/jpeg;base64,ZmFrZQ=="
  });
  assert.equal(shot.ok, true);
  assert.equal(shot.photo.capturedRunnerIds.includes(runnerA.id), false);
  assert.equal(game.getGalleryState().items.length, 0);
});

test("runner does not count once most of the body width is covered by fountain", () => {
  const { game, photographer, runnerA } = createPreparedGame();
  runnerA.angle = 0.16;
  photographer.yaw = 0;
  game.state.fountains.forEach((jet, index) => {
    jet.active = index === 0;
    jet.angle = index === 0 ? 0 : Math.PI;
    jet.width = 0.02;
  });

  const shot = game.registerShutter(photographer.id, {
    imageDataUrl: "data:image/jpeg;base64,ZmFrZQ=="
  });

  assert.equal(shot.ok, true);
  assert.equal(shot.photo.capturedRunnerIds.includes(runnerA.id), false);
  assert.equal(shot.photo.blockedRunnerIds.includes(runnerA.id), true);
});

test("runner still counts when less than the obstruction threshold is covered", () => {
  const { game, photographer, runnerA } = createPreparedGame();
  runnerA.angle = 0.22;
  photographer.yaw = 0;
  game.state.fountains.forEach((jet, index) => {
    jet.active = index === 0;
    jet.angle = index === 0 ? 0 : Math.PI;
    jet.width = 0.02;
  });

  const shot = game.registerShutter(photographer.id, {
    imageDataUrl: "data:image/jpeg;base64,ZmFrZQ=="
  });

  assert.equal(shot.ok, true);
  assert.equal(shot.photo.capturedRunnerIds.includes(runnerA.id), true);
});

test("round finishes for runners when timer expires", () => {
  const { game } = createPreparedGame();
  for (let elapsed = 0; elapsed <= ROUND_SECONDS * 1000 + 500; elapsed += 1000) {
    game.tick(game.lastTickAt + 1000);
    if (game.state.phase === GAME_PHASES.RESULTS) {
      break;
    }
  }
  assert.equal(game.state.phase, GAME_PHASES.RESULTS);
  assert.equal(game.state.winner, "runners");
});

test("capturing every runner does not end the round early", () => {
  const { game, photographer, runnerA, runnerB, runnerC } = createPreparedGame();
  runnerA.angle = 0;
  runnerB.angle = 0.08;
  runnerC.angle = -0.1;
  photographer.yaw = 0;
  game.state.fountains.forEach((jet) => {
    jet.active = false;
  });

  const shot = game.registerShutter(photographer.id, {
    imageDataUrl: "data:image/jpeg;base64,ZmFrZQ=="
  });

  assert.equal(shot.ok, true);
  assert.deepEqual(game.state.capturedRunnerIds.sort(), [runnerA.id, runnerB.id, runnerC.id].sort());
  assert.equal(game.state.phase, GAME_PHASES.PLAYING);

  game.tick(game.lastTickAt + ROUND_SECONDS * 1000 + 20);
  assert.equal(game.state.phase, GAME_PHASES.RESULTS);
  assert.equal(game.state.winner, "photographer");
});

test("results reset early when all connected controllers close the gallery", () => {
  const { game, photographer, runnerA, runnerB, runnerC } = createPreparedGame();
  runnerA.angle = 0;
  runnerB.angle = 0.08;
  runnerC.angle = -0.1;
  photographer.yaw = 0;
  game.state.fountains.forEach((jet) => {
    jet.active = false;
  });

  game.registerShutter(photographer.id, {
    imageDataUrl: "data:image/jpeg;base64,ZmFrZQ=="
  });
  game.tick(game.lastTickAt + ROUND_SECONDS * 1000 + 20);

  assert.equal(game.state.phase, GAME_PHASES.RESULTS);
  assert.equal(game.setGalleryReview(photographer.id, false).reset, false);
  assert.equal(game.state.phase, GAME_PHASES.RESULTS);
  assert.equal(game.setGalleryReview(runnerA.id, false).reset, false);
  assert.equal(game.setGalleryReview(runnerB.id, false).reset, false);
  assert.equal(game.setGalleryReview(runnerC.id, false).reset, true);
  assert.equal(game.state.phase, GAME_PHASES.LOBBY);
});

test("disconnected player is removed after the grace period", () => {
  const game = new GameState("1234");
  const runner = game.addOrReconnectPlayer("Runner", "runner");

  game.disconnectPlayer(runner.id, 1_000);
  assert.equal(game.getPlayer(runner.id)?.connected, false);

  game.tick(8_999, 8_000);
  assert.ok(game.getPlayer(runner.id));

  game.tick(9_001, 2);
  assert.equal(game.getPlayer(runner.id), null);
});

test("reconnecting player loses photographer role if another online player claimed it", () => {
  const game = new GameState("1234");
  const originalPhotographer = game.addOrReconnectPlayer("Photo", "photo");
  const replacementPhotographer = game.addOrReconnectPlayer("Backup Photo", "backup-photo");

  game.chooseRole(originalPhotographer.id, ROLES.PHOTOGRAPHER);
  game.disconnectPlayer(originalPhotographer.id);
  game.chooseRole(replacementPhotographer.id, ROLES.PHOTOGRAPHER);

  const rejoined = game.addOrReconnectPlayer("Photo", "photo");

  assert.equal(rejoined.id, originalPhotographer.id);
  assert.equal(rejoined.connected, true);
  assert.equal(rejoined.role, null);
  assert.equal(game.getPhotographer()?.id, replacementPhotographer.id);
});

test("releasing photographer role makes it available again", () => {
  const game = new GameState("1234");
  const photographer = game.addOrReconnectPlayer("Photo", "photo");
  const runner = game.addOrReconnectPlayer("Runner", "runner");

  assert.equal(game.chooseRole(photographer.id, ROLES.PHOTOGRAPHER).ok, true);
  assert.equal(game.getRoleAvailability().photographerAvailable, false);

  assert.equal(game.chooseRole(photographer.id, null).ok, true);
  assert.equal(game.getRoleAvailability().photographerAvailable, true);
  assert.equal(game.chooseRole(runner.id, ROLES.PHOTOGRAPHER).ok, true);
});

test("resetting lobby clears roles for a fresh role-pick flow", () => {
  const { game } = createPreparedGame();
  game.finishRound("runners");
  game.tick(game.lastTickAt + (RESULTS_SECONDS + 1) * 1000);

  assert.equal(game.state.phase, GAME_PHASES.LOBBY);
  assert.equal(game.state.players.every((player) => player.role === null), true);
});

test("gallery state groups successful photos by runner", () => {
  const { game, photographer, runnerA, runnerB } = createPreparedGame();
  runnerA.angle = 0;
  runnerB.angle = 0.03;
  photographer.yaw = 0;
  game.state.fountains.forEach((jet) => {
    jet.active = false;
  });

  const shot = game.registerShutter(photographer.id, {
    imageDataUrl: "data:image/jpeg;base64,ZmFrZQ=="
  });

  assert.equal(shot.ok, true);
  const gallery = game.getGalleryState();
  const runnerAGroup = gallery.runnerGroups.find((entry) => entry.playerId === runnerA.id);
  const runnerBGroup = gallery.runnerGroups.find((entry) => entry.playerId === runnerB.id);
  assert.equal(runnerAGroup.photos.length, 1);
  assert.equal(runnerBGroup.photos.length, 1);
  assert.equal(runnerAGroup.photos[0].id, runnerBGroup.photos[0].id);
});

test("shutter uses the capture-time camera yaw instead of stale motion state", () => {
  const { game, photographer, runnerA } = createPreparedGame();
  runnerA.angle = 0.12;
  photographer.yaw = -1.2;
  game.state.fountains.forEach((jet) => {
    jet.active = false;
  });

  const shot = game.registerShutter(photographer.id, {
    imageDataUrl: "data:image/jpeg;base64,ZmFrZQ==",
    yaw: 0.12,
    pitch: -0.05
  });

  assert.equal(shot.ok, true);
  assert.equal(shot.photo.capturedRunnerIds.includes(runnerA.id), true);
});
