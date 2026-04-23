import * as THREE from "three";
import { ARENA } from "../../shared/constants.js";

function polarToPosition(angle, radius, height = 0) {
  return new THREE.Vector3(Math.cos(angle) * radius, height, Math.sin(angle) * radius);
}

function sampleRingPoints(radius, height, count) {
  const points = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    points.push(polarToPosition(angle, radius, height));
  }
  return points;
}

function getBoxCorners(box) {
  return [
    new THREE.Vector3(box.min.x, box.min.y, box.min.z),
    new THREE.Vector3(box.min.x, box.min.y, box.max.z),
    new THREE.Vector3(box.min.x, box.max.y, box.min.z),
    new THREE.Vector3(box.min.x, box.max.y, box.max.z),
    new THREE.Vector3(box.max.x, box.min.y, box.min.z),
    new THREE.Vector3(box.max.x, box.min.y, box.max.z),
    new THREE.Vector3(box.max.x, box.max.y, box.min.z),
    new THREE.Vector3(box.max.x, box.max.y, box.max.z)
  ];
}

function getMeshSurfacePoints(mesh) {
  const geometry = mesh.geometry;
  const positions = geometry?.getAttribute?.("position");
  if (!positions || positions.count === 0) {
    return [];
  }

  const points = [];
  const worldPoint = new THREE.Vector3();
  for (let index = 0; index < positions.count; index += 1) {
    worldPoint.fromBufferAttribute(positions, index);
    points.push(worldPoint.clone().applyMatrix4(mesh.matrixWorld));
  }
  return points;
}

function getFountainReadableCapPoints(arena = ARENA) {
  const jetRadius = arena.fountainRadius + arena.fountainJetBottomRadius;
  const points = sampleRingPoints(jetRadius, arena.spectatorFraming.readableJetTopY, 12);
  points.push(new THREE.Vector3(0, arena.spectatorFraming.readableJetTopY, 0));
  return points;
}

export function getSpectatorFramingGeometry({ frameObjects, arena = ARENA }) {
  const meshBounds = new THREE.Box3();
  const bounds = new THREE.Box3();
  const meshPoints = [];
  const allowancePoints = [];
  const fitPoints = [];

  for (const object of frameObjects) {
    object.updateWorldMatrix(true, true);
    const objectPoints = [];

    object.traverse((node) => {
      if (!node.isMesh) {
        return;
      }
      objectPoints.push(...getMeshSurfacePoints(node));
    });

    if (!objectPoints.length) {
      const objectBounds = new THREE.Box3().setFromObject(object);
      if (objectBounds.isEmpty()) {
        return;
      }
      objectPoints.push(...getBoxCorners(objectBounds));
    }

    for (const point of objectPoints) {
      meshBounds.expandByPoint(point);
      bounds.expandByPoint(point);
      meshPoints.push(point);
      fitPoints.push(point);
    }
  }

  for (const point of getFountainReadableCapPoints(arena)) {
    bounds.expandByPoint(point);
    allowancePoints.push(point);
    fitPoints.push(point);
  }

  return { bounds, meshBounds, meshPoints, allowancePoints, fitPoints };
}

export function getProjectedPointBounds(points, camera) {
  if (!points.length) {
    return null;
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const point of points) {
    const projected = point.clone().project(camera);
    minX = Math.min(minX, projected.x);
    maxX = Math.max(maxX, projected.x);
    minY = Math.min(minY, projected.y);
    maxY = Math.max(maxY, projected.y);
  }

  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2
  };
}

function getCameraBasis(direction) {
  const forward = direction.clone().multiplyScalar(-1);
  const worldUp = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(forward, worldUp).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  return { forward, right, up };
}

function getFitDistance(points, target, basis, fov, aspectRatio, safeFrame) {
  const verticalHalfFov = THREE.MathUtils.degToRad(fov / 2);
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * aspectRatio);
  const effectiveHorizontalHalfFov = Math.atan(Math.tan(horizontalHalfFov) * safeFrame.width);
  const effectiveVerticalHalfFov = Math.atan(Math.tan(verticalHalfFov) * safeFrame.height);
  const horizontalTan = Math.tan(effectiveHorizontalHalfFov);
  const verticalTan = Math.tan(effectiveVerticalHalfFov);

  let distance = 0;
  for (const point of points) {
    const offset = point.clone().sub(target);
    const localX = offset.dot(basis.right);
    const localY = offset.dot(basis.up);
    const localZ = offset.dot(basis.forward);
    distance = Math.max(
      distance,
      -localZ + Math.abs(localX) / horizontalTan,
      -localZ + Math.abs(localY) / verticalTan
    );
  }

  return distance;
}

function getTopAllowanceDistance(points, target, basis, fov, aspectRatio, allowanceTop) {
  if (!points.length) {
    return 0;
  }

  const verticalHalfFov = THREE.MathUtils.degToRad(fov / 2);
  const effectiveVerticalHalfFov = Math.atan(Math.tan(verticalHalfFov) * allowanceTop);
  const verticalTan = Math.tan(effectiveVerticalHalfFov);

  let distance = 0;
  for (const point of points) {
    const offset = point.clone().sub(target);
    const localY = Math.max(0, offset.dot(basis.up));
    const localZ = offset.dot(basis.forward);
    distance = Math.max(distance, -localZ + localY / verticalTan);
  }

  return distance;
}

function buildFrameCandidate(targetY, { arena, aspectRatio, direction, frameGeometry, fov }) {
  const target = new THREE.Vector3(arena.spectatorStandCamera.target.x, targetY, arena.spectatorStandCamera.target.z);
  const basis = getCameraBasis(direction);
  const meshDistance = getFitDistance(frameGeometry.meshPoints, target, basis, fov, aspectRatio, arena.spectatorFraming.safeFrame);
  const allowanceDistance = getTopAllowanceDistance(
    frameGeometry.allowancePoints,
    target,
    basis,
    fov,
    aspectRatio,
    arena.spectatorFraming.allowanceTop ?? 0.94
  );
  const distance = Math.max(meshDistance, allowanceDistance);
  const position = target.clone().addScaledVector(direction, distance);
  const camera = new THREE.PerspectiveCamera(fov, aspectRatio, 0.1, 100);
  camera.position.copy(position);
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  const meshBounds = getProjectedPointBounds(frameGeometry.meshPoints, camera);
  const allowanceBounds = getProjectedPointBounds(frameGeometry.allowancePoints, camera);

  return {
    position,
    target,
    fov,
    bounds: frameGeometry.bounds.clone(),
    meshBounds,
    allowanceBounds,
    compositionBounds: meshBounds
  };
}

export function resolveSpectatorFrame({ aspectRatio, frameGeometry, arena = ARENA }) {
  const seed = arena.spectatorStandCamera;
  const direction = new THREE.Vector3(
    seed.position.x - seed.target.x,
    seed.position.y - seed.target.y,
    seed.position.z - seed.target.z
  ).normalize();
  const fov = seed.fov;
  const minTargetY = arena.spectatorFraming.targetYRange.min;
  const maxTargetY = arena.spectatorFraming.targetYRange.max;
  const scanSteps = Math.max(4, arena.spectatorFraming.targetYSearchSteps || 24);
  const refineSteps = Math.max(4, arena.spectatorFraming.targetYIterations || 12);

  let bestFrame = null;
  let previousFrame = null;
  let lowBracket = null;
  let highBracket = null;

  for (let index = 0; index <= scanSteps; index += 1) {
    const t = index / scanSteps;
    const targetY = minTargetY + (maxTargetY - minTargetY) * t;
    const frame = buildFrameCandidate(targetY, { arena, aspectRatio, direction, frameGeometry, fov });
    if (!bestFrame || Math.abs(frame.meshBounds.centerY) < Math.abs(bestFrame.meshBounds.centerY)) {
      bestFrame = frame;
    }
    if (previousFrame) {
      const previousCenter = previousFrame.meshBounds.centerY;
      const currentCenter = frame.meshBounds.centerY;
      if ((previousCenter <= 0 && currentCenter >= 0) || (previousCenter >= 0 && currentCenter <= 0)) {
        lowBracket = previousFrame;
        highBracket = frame;
        break;
      }
    }
    previousFrame = frame;
  }

  if (lowBracket && highBracket) {
    let low = lowBracket;
    let high = highBracket;
    for (let iteration = 0; iteration < refineSteps; iteration += 1) {
      const targetY = (low.target.y + high.target.y) / 2;
      const frame = buildFrameCandidate(targetY, { arena, aspectRatio, direction, frameGeometry, fov });
      if (Math.abs(frame.meshBounds.centerY) < Math.abs(bestFrame.meshBounds.centerY)) {
        bestFrame = frame;
      }
      if (Math.abs(frame.meshBounds.centerY) < 0.0005) {
        bestFrame = frame;
        break;
      }
      if ((low.meshBounds.centerY <= 0 && frame.meshBounds.centerY >= 0)
        || (low.meshBounds.centerY >= 0 && frame.meshBounds.centerY <= 0)) {
        high = frame;
      } else {
        low = frame;
      }
    }
  }

  return bestFrame;
}
