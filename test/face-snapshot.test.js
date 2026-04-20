import test from "node:test";
import assert from "node:assert/strict";
import { GameState } from "../server/gameState.js";
import { ROLES } from "../shared/protocol.js";

test("game state stores and serializes a fresh face snapshot", () => {
  const game = new GameState("FACE");
  const player = game.addPlayer("Runner", "session-1");
  game.chooseRole(player.id, ROLES.PLAYER);

  const result = game.updateFaceSnapshot(player.id, {
    imageBase64: "data:image/jpeg;base64,ZmFrZQ==",
    capturedAt: Date.now(),
    shape: "circle"
  });

  const serialized = game.getFullState({ includeInputs: true }).players[0];
  assert.equal(result.ok, true);
  assert.equal(serialized.faceSnapshot?.shape, "circle");
  assert.match(serialized.faceSnapshot?.imageBase64 || "", /^data:image\/jpeg;base64,/);
});

test("multiple players can choose runner while attacker stays unique", () => {
  const game = new GameState("ROLES");
  const attacker = game.addPlayer("Attacker", "session-attacker");
  const runnerA = game.addPlayer("Runner A", "session-runner-a");
  const runnerB = game.addPlayer("Runner B", "session-runner-b");

  assert.equal(game.chooseRole(attacker.id, ROLES.ATTACKER).ok, true);
  assert.equal(game.chooseRole(runnerA.id, ROLES.PLAYER).ok, true);
  assert.equal(game.chooseRole(runnerB.id, ROLES.PLAYER).ok, true);

  const blocked = game.chooseRole(runnerA.id, ROLES.ATTACKER);
  assert.equal(blocked.ok, false);
  assert.equal(game.getPlayersByRole(ROLES.PLAYER).length, 2);
  assert.equal(game.getPlayersByRole(ROLES.ATTACKER).length, 1);
});
