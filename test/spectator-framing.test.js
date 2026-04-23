import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { ARENA } from "../shared/constants.js";
import { getProjectedPointBounds, getSpectatorFramingGeometry, resolveSpectatorFrame } from "../clients/common/spectatorFraming.js";

const aspectRatios = [
  { label: "16:9", value: 16 / 9 },
  { label: "display", value: 1572 / 933 },
  { label: "wide", value: 21 / 9 },
  { label: "tall", value: 4 / 5 }
];

function buildFrameObjects() {
  const floor = new THREE.Group();
  const frameObjects = [];

  const plaza = new THREE.Mesh(
    new THREE.CylinderGeometry(ARENA.plazaTopRadius, ARENA.plazaBottomRadius, ARENA.plazaHeight, 64)
  );
  floor.add(plaza);
  frameObjects.push(plaza);

  for (const radius of ARENA.ringRadii) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, ARENA.ringTubeRadius, 18, 96));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = ARENA.ringY;
    floor.add(ring);
    frameObjects.push(ring);
  }

  const pedestal = new THREE.Mesh(
    new THREE.CylinderGeometry(ARENA.pedestalTopRadius, ARENA.pedestalBottomRadius, ARENA.pedestalHeight, 48)
  );
  pedestal.position.y = ARENA.pedestalY;
  floor.add(pedestal);
  frameObjects.push(pedestal);

  const fountainBase = new THREE.Mesh(
    new THREE.CylinderGeometry(ARENA.fountainBaseTopRadius, ARENA.fountainBaseBottomRadius, ARENA.fountainBaseHeight, 48)
  );
  fountainBase.position.y = ARENA.fountainBaseY;
  floor.add(fountainBase);
  frameObjects.push(fountainBase);

  floor.updateMatrixWorld(true);
  return frameObjects;
}

test("spectator framing centers the arena body while keeping fountain allowance in view", () => {
  const frameGeometry = getSpectatorFramingGeometry({ frameObjects: buildFrameObjects(), arena: ARENA });

  for (const aspect of aspectRatios) {
    const frame = resolveSpectatorFrame({ aspectRatio: aspect.value, frameGeometry, arena: ARENA });
    const camera = new THREE.PerspectiveCamera(frame.fov, aspect.value, 0.1, 100);
    camera.position.copy(frame.position);
    camera.lookAt(frame.target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const meshBounds = getProjectedPointBounds(frameGeometry.meshPoints, camera);
    const allowanceBounds = getProjectedPointBounds(frameGeometry.allowancePoints, camera);
    const direction = frame.target.clone().sub(frame.position).normalize();

    assert.ok(Math.abs(meshBounds.centerX) < 0.01, `${aspect.label} should stay horizontally centered`);
    assert.ok(Math.abs(meshBounds.centerY) < 0.03, `${aspect.label} should keep arena body vertically near center`);
    assert.ok(meshBounds.minX >= -ARENA.spectatorFraming.safeFrame.width - 0.02, `${aspect.label} arena should fit inside horizontal safe frame`);
    assert.ok(meshBounds.maxX <= ARENA.spectatorFraming.safeFrame.width + 0.02, `${aspect.label} arena should fit inside horizontal safe frame`);
    assert.ok(meshBounds.minY >= -ARENA.spectatorFraming.safeFrame.height - 0.02, `${aspect.label} arena should fit inside vertical safe frame`);
    assert.ok(meshBounds.maxY <= ARENA.spectatorFraming.safeFrame.height + 0.02, `${aspect.label} arena should fit inside vertical safe frame`);
    assert.ok(allowanceBounds.maxY <= (ARENA.spectatorFraming.allowanceTop ?? 0.94) + 0.02, `${aspect.label} allowance should respect top headroom`);
    assert.ok(Math.abs(meshBounds.centerY) <= Math.abs(allowanceBounds.centerY), `${aspect.label} allowance should not pull arena body farther from center`);
    assert.ok(frame.position.y > 0 && frame.position.z > 0, `${aspect.label} should remain in a stand-view position`);
    assert.ok(Math.abs(direction.y) > 0.2 && Math.abs(direction.y) < 0.75, `${aspect.label} should not become top-down`);
  }
});
