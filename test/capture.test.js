import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { ARENA } from "../shared/protocol.js";
import { evaluateCaptureSnapshot } from "../clients/common/captureSnapshot.js";

function createCamera() {
  const camera = new THREE.PerspectiveCamera(55, ARENA.captureAspectRatio, 0.1, 100);
  camera.position.set(0, 1.1, 0);
  camera.lookAt(0, 1, -5);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

function createRunnerTarget({
  id = "runner-1",
  position = new THREE.Vector3(0, 1, -5),
  size = { width: 0.9, height: 1.8, depth: 0.6 }
} = {}) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(size.width, size.height, size.depth),
    new THREE.MeshBasicMaterial({ color: "#ffffff" })
  );
  mesh.position.copy(position);
  mesh.userData.captureOwnerId = id;
  mesh.updateMatrixWorld(true);

  const frontZ = size.depth * 0.5 - 0.01;
  const samplePoints = [
    new THREE.Vector3(0, size.height * 0.36, frontZ),
    new THREE.Vector3(0, 0, frontZ),
    new THREE.Vector3(-size.width * 0.32, 0, frontZ),
    new THREE.Vector3(size.width * 0.32, 0, frontZ),
    new THREE.Vector3(-size.width * 0.2, size.height * 0.32, frontZ),
    new THREE.Vector3(size.width * 0.2, size.height * 0.32, frontZ),
    new THREE.Vector3(0, -size.height * 0.24, frontZ)
  ].map((point) => mesh.localToWorld(point));

  return {
    mesh,
    target: {
      id,
      samplePoints,
      raycastObjects: [mesh]
    }
  };
}

function createOccluder(position, width, height, depth = 0.5) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, depth),
    new THREE.MeshBasicMaterial({ color: "#ff00ff" })
  );
  mesh.position.copy(position);
  mesh.updateMatrixWorld(true);
  return mesh;
}

test("capture snapshot marks a fully visible runner as captured", () => {
  const camera = createCamera();
  const { target } = createRunnerTarget();

  const result = evaluateCaptureSnapshot({
    camera,
    targets: [target],
    occluders: []
  });

  assert.deepEqual(result.capturedRunnerIds, [target.id]);
  assert.deepEqual(result.blockedRunnerIds, []);
});

test("capture snapshot marks a runner as blocked when arena geometry covers the frame", () => {
  const camera = createCamera();
  const { target } = createRunnerTarget();
  const wall = createOccluder(new THREE.Vector3(0, 1, -2.45), 1.6, 2.6);

  const result = evaluateCaptureSnapshot({
    camera,
    targets: [target],
    occluders: [wall]
  });

  assert.deepEqual(result.capturedRunnerIds, []);
  assert.deepEqual(result.blockedRunnerIds, [target.id]);
});

test("capture snapshot does not count a runner when only a small sliver is visible", () => {
  const camera = createCamera();
  const { target } = createRunnerTarget();
  const wall = createOccluder(new THREE.Vector3(-0.18, 1, -2.45), 1.18, 2.6);

  const result = evaluateCaptureSnapshot({
    camera,
    targets: [target],
    occluders: [wall]
  });

  assert.deepEqual(result.capturedRunnerIds, []);
  assert.deepEqual(result.blockedRunnerIds, [target.id]);
});

test("capture snapshot ignores runners that are outside the photo frame", () => {
  const camera = createCamera();
  const { target } = createRunnerTarget({
    position: new THREE.Vector3(3.4, 1, -5)
  });

  const result = evaluateCaptureSnapshot({
    camera,
    targets: [target],
    occluders: []
  });

  assert.deepEqual(result.capturedRunnerIds, []);
  assert.deepEqual(result.blockedRunnerIds, []);
});
