import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  applySpectatorDiagnosticPalette,
  restoreSpectatorDiagnosticPalette,
  SPECTATOR_DIAGNOSTIC_PALETTE
} from "../clients/common/spectatorDiagnostic.js";

test("spectator diagnostic palette restores original scene colors and materials", () => {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#f1dcc2");
  scene.fog = new THREE.Fog("#f1dcc2", 36, 96);

  const plazaMaterial = new THREE.MeshStandardMaterial({ color: "#efd3aa" });
  const ringMaterial = new THREE.MeshStandardMaterial({ color: "#b97f4f" });
  const plaza = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.5, 16), plazaMaterial);
  plaza.userData.spectatorDiagnosticRole = "plaza";
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.1, 8, 24), ringMaterial);
  ring.userData.spectatorDiagnosticRole = "ring";
  scene.add(plaza, ring);

  const diagnosticState = applySpectatorDiagnosticPalette({
    scene,
    arenaObjects: [plaza, ring]
  });

  assert.equal(scene.background.getHexString(), new THREE.Color(SPECTATOR_DIAGNOSTIC_PALETTE.background).getHexString());
  assert.equal(scene.fog.color.getHexString(), new THREE.Color(SPECTATOR_DIAGNOSTIC_PALETTE.fog).getHexString());
  assert.notEqual(plaza.material, plazaMaterial);
  assert.notEqual(ring.material, ringMaterial);

  restoreSpectatorDiagnosticPalette({ scene, state: diagnosticState });

  assert.equal(scene.background.getHexString(), new THREE.Color("#f1dcc2").getHexString());
  assert.equal(scene.fog.color.getHexString(), new THREE.Color("#f1dcc2").getHexString());
  assert.equal(plaza.material, plazaMaterial);
  assert.equal(ring.material, ringMaterial);
});
