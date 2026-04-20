import test from "node:test";
import assert from "node:assert/strict";
import { GameState, samplePlatformHeight } from "../server/gameState.js";
import { ROLES, WORLD } from "../shared/protocol.js";
import { getBandAtX, sampleTerrainTopY } from "../shared/utils.js";

function primeAttacker(game, attacker) {
  game.chooseRole(attacker.id, ROLES.ATTACKER);
  game.updateAttackerSetup(attacker.id, {
    hasMicPermission: true,
    status: "complete",
    profileLowHz: 140,
    profileHighHz: 720
  });
}

test("eq terrain maps frequencies into 12 weighted bands and serializes attacker band info", () => {
  const game = new GameState("EQ01");
  const attacker = game.addPlayer("Attacker", "attacker-session");
  primeAttacker(game, attacker);

  const low = game.updateAudio({ dominantBandIndex: 0, dominantBandHz: 160, bandLevels: [1, 0.35, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], amplitudeNorm: 1, voiced: true, profileRangeHz: { lowHz: 140, highHz: 720 } });
  assert.equal(low.dominantBandIndex, 0);

  const middle = game.updateAudio({ dominantBandIndex: 6, dominantBandHz: 470, bandLevels: [0, 0, 0, 0, 0, 0.35, 1, 0.35, 0, 0, 0, 0], amplitudeNorm: 1, voiced: true, profileRangeHz: { lowHz: 140, highHz: 720 } });
  assert.equal(middle.dominantBandIndex, 6);

  const high = game.updateAudio({ dominantBandIndex: 11, dominantBandHz: 690, bandLevels: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.35, 1], amplitudeNorm: 1, voiced: true, profileRangeHz: { lowHz: 140, highHz: 720 } });
  assert.equal(high.dominantBandIndex, 11);

  game.updateTerrain();
  const fullState = game.getFullState();
  assert.equal(fullState.terrain.bandCount, 12);
  assert.equal(fullState.terrain.bars.length, 12);
  assert.ok(fullState.terrain.bars[0].width > fullState.terrain.bars[5].width);
  assert.equal(fullState.terrain.bars[0].startX, 0);
  assert.equal(fullState.terrain.bars.at(-1).endX, fullState.layout.gameplayWidth);
  assert.equal(fullState.attackerSetup.lastDominantBandIndex, 11);
  assert.equal(Math.round(fullState.attackerSetup.lastDominantBandHz), 690);
});

test("eq terrain raises the hit band and only lightly raises neighbors", () => {
  const game = new GameState("EQ02");
  const attacker = game.addPlayer("Attacker", "attacker-session");
  primeAttacker(game, attacker);

  game.updateAudio({ dominantBandIndex: 6, dominantBandHz: 470, bandLevels: [0, 0, 0, 0, 0, 0.35, 1, 0.35, 0, 0, 0, 0], amplitudeNorm: 1, voiced: true, profileRangeHz: { lowHz: 140, highHz: 720 } });
  for (let index = 0; index < 8; index += 1) {
    game.updateTerrain();
  }

  const bars = game.state.terrain.bars;
  const active = bars[6].currentHeight;
  const neighbor = bars[5].currentHeight;
  const far = bars[3].currentHeight;
  assert.ok(active > neighbor);
  assert.ok(neighbor > 0);
  assert.equal(far, 0);
});

test("active EQ band can hit runners while other bands remain safe and respawn search avoids the spike", () => {
  const game = new GameState("EQ03");
  const attacker = game.addPlayer("Attacker", "attacker-session");
  const runner = game.addPlayer("Runner", "runner-session");
  primeAttacker(game, attacker);
  game.chooseRole(runner.id, ROLES.PLAYER);
  game.startRound();

  game.updateAudio({ dominantBandIndex: 6, dominantBandHz: 470, bandLevels: [0, 0, 0, 0, 0, 0.35, 1, 0.35, 0, 0, 0, 0], amplitudeNorm: 1, voiced: true, profileRangeHz: { lowHz: 140, highHz: 720 } });
  for (let index = 0; index < 10; index += 1) {
    game.updateTerrain();
  }

  const activeBand = game.state.terrain.bars[6];
  runner.x = activeBand.centerX;
  runner.y = samplePlatformHeight(game.state.layout, runner.x) - WORLD.playerHeight / 2;
  game.updatePlayers(0.016);
  assert.equal(runner.lastDeathCause, "wave");

  game.respawnRunner(runner);
  const respawnBand = getBandAtX(game.state.terrain, runner.x);
  const respawnFeet = samplePlatformHeight(game.state.layout, runner.x);
  assert.notEqual(respawnBand?.index, activeBand.index);
  assert.ok(sampleTerrainTopY(game.state.terrain, runner.x) > respawnFeet);
});

test("wave collision catches runners whose feet overlap the active bar edge", () => {
  const game = new GameState("EQ04");
  const attacker = game.addPlayer("Attacker", "attacker-session");
  const runner = game.addPlayer("Runner", "runner-session");
  primeAttacker(game, attacker);
  game.chooseRole(runner.id, ROLES.PLAYER);
  game.startRound();

  game.updateAudio({ dominantBandIndex: 6, dominantBandHz: 470, bandLevels: [0, 0, 0, 0, 0, 0.35, 1, 0.35, 0, 0, 0, 0], amplitudeNorm: 1, voiced: true, profileRangeHz: { lowHz: 140, highHz: 720 } });
  for (let index = 0; index < 10; index += 1) {
    game.updateTerrain();
  }

  const activeBand = game.state.terrain.bars[6];
  runner.x = activeBand.endX + WORLD.playerWidth * 0.2;
  runner.y = samplePlatformHeight(game.state.layout, runner.x) - WORLD.playerHeight / 2;
  game.updatePlayers(0.016);

  assert.equal(runner.lastDeathCause, "wave");
});
