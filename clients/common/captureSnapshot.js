import * as THREE from "three";
import { ARENA } from "../../shared/protocol.js";

const tempProjectedPoint = new THREE.Vector3();
const tempCameraPosition = new THREE.Vector3();
const tempSamplePoint = new THREE.Vector3();
const tempRayDirection = new THREE.Vector3();
const CAPTURE_RAY_EPSILON = 0.05;

function isCapturePointInsideFrame(point, camera) {
  tempProjectedPoint.copy(point).project(camera);
  return tempProjectedPoint.z >= -1
    && tempProjectedPoint.z <= 1
    && Math.abs(tempProjectedPoint.x) <= 1
    && Math.abs(tempProjectedPoint.y) <= 1;
}

export function evaluateCaptureSnapshot({
  camera,
  targets = [],
  occluders = [],
  coverageThreshold = ARENA.captureVisibilityThreshold
}) {
  camera.updateMatrixWorld(true);
  camera.getWorldPosition(tempCameraPosition);

  const raycaster = new THREE.Raycaster();
  raycaster.layers.enable(1);
  const raycastObjects = [
    ...occluders.filter(Boolean),
    ...targets.flatMap((target) => target.raycastObjects || []).filter(Boolean)
  ];
  const capturedRunnerIds = [];
  const blockedRunnerIds = [];

  for (const target of targets) {
    let inFrameSamples = 0;
    let visibleSamples = 0;

    for (const samplePoint of target.samplePoints || []) {
      tempSamplePoint.copy(samplePoint);
      if (!isCapturePointInsideFrame(tempSamplePoint, camera)) {
        continue;
      }
      inFrameSamples += 1;
      tempRayDirection.copy(tempSamplePoint).sub(tempCameraPosition);
      const sampleDistance = tempRayDirection.length();
      if (sampleDistance <= Number.EPSILON) {
        visibleSamples += 1;
        continue;
      }

      tempRayDirection.normalize();
      raycaster.set(tempCameraPosition, tempRayDirection);
      raycaster.near = 0.001;
      raycaster.far = sampleDistance + CAPTURE_RAY_EPSILON;
      const firstHit = raycaster
        .intersectObjects(raycastObjects, false)
        .find((hit) => hit.distance <= sampleDistance + CAPTURE_RAY_EPSILON);

      if (firstHit?.object?.userData?.captureOwnerId === target.id) {
        visibleSamples += 1;
      }
    }

    if (!inFrameSamples) {
      continue;
    }

    const visibleCoverage = visibleSamples / inFrameSamples;
    if (visibleCoverage >= coverageThreshold) {
      capturedRunnerIds.push(target.id);
    } else {
      blockedRunnerIds.push(target.id);
    }
  }

  return {
    capturedRunnerIds,
    blockedRunnerIds
  };
}
