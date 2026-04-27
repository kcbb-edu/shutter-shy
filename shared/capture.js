import { ARENA, ROLES, normalizeAngle } from "./protocol.js";

export function getHorizontalFovRadians(aspectRatio = ARENA.captureAspectRatio) {
  return 2 * Math.atan(Math.tan(ARENA.cameraVerticalFovRadians / 2) * aspectRatio);
}

export function getRunnerVisibilitySampleAngles(targetAngle, halfWidth = ARENA.runnerBodyAnglePadding) {
  return [-1, -0.5, 0, 0.5, 1].map((multiplier) => normalizeAngle(targetAngle + halfWidth * multiplier));
}

export function isObstructedByFountains(fountains, targetAngle) {
  return fountains.some((jet) => {
    const padding = Math.max(0, ARENA.obstructionAnglePadding + (jet?.width || 0));
    return Boolean(jet?.active) && Math.abs(normalizeAngle(targetAngle - jet.angle)) <= padding;
  });
}

export function getRunnerObstructionCoverage(fountains, targetAngle, runnerHalfWidth = ARENA.runnerBodyAnglePadding) {
  const sampleAngles = getRunnerVisibilitySampleAngles(targetAngle, runnerHalfWidth);
  const obstructedSampleCount = sampleAngles.filter((sampleAngle) => isObstructedByFountains(fountains, sampleAngle)).length;
  return obstructedSampleCount / Math.max(sampleAngles.length, 1);
}

export function isRunnerFullyObstructed(fountains, targetAngle, runnerHalfWidth = ARENA.runnerBodyAnglePadding) {
  return getRunnerObstructionCoverage(fountains, targetAngle, runnerHalfWidth) >= ARENA.obstructionCoverageThreshold;
}

export function evaluatePhotographerShotLegacy({ players = [], fountains = [], yaw = 0 }) {
  const runners = players.filter((player) => player?.role === ROLES.RUNNER && player?.connected !== false);
  const horizontalFov = getHorizontalFovRadians(ARENA.captureAspectRatio);
  const capturedRunnerIds = runners
    .filter((runner) => {
      const delta = normalizeAngle(runner.angle - yaw);
      if (Math.abs(delta) > horizontalFov / 2 + ARENA.runnerBodyAnglePadding) {
        return false;
      }
      return !isRunnerFullyObstructed(fountains, runner.angle, ARENA.runnerBodyAnglePadding);
    })
    .map((runner) => runner.id);
  const blockedRunnerIds = runners
    .filter((runner) => !capturedRunnerIds.includes(runner.id))
    .filter((runner) => {
      const delta = normalizeAngle(runner.angle - yaw);
      return Math.abs(delta) <= horizontalFov / 2 + ARENA.runnerBodyAnglePadding
        && isRunnerFullyObstructed(fountains, runner.angle, ARENA.runnerBodyAnglePadding);
    })
    .map((runner) => runner.id);
  return {
    capturedRunnerIds,
    blockedRunnerIds
  };
}
