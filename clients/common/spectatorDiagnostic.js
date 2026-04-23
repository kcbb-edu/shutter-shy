import * as THREE from "three";

export const SPECTATOR_DIAGNOSTIC_PALETTE = {
  background: "#08111f",
  fog: "#0d1828",
  roles: {
    plaza: "#f2d38b",
    ring: "#ff7a2f",
    pedestal: "#fff4dd",
    "fountain-base": "#43d9ff",
    fallback: "#7df9ff"
  }
};

function cloneSceneBackground(background) {
  return background?.clone ? background.clone() : background;
}

function collectUniqueMeshes(objects) {
  const meshes = [];
  const seen = new Set();

  for (const object of objects) {
    object.traverse((node) => {
      if (!node.isMesh || seen.has(node)) {
        return;
      }
      seen.add(node);
      meshes.push(node);
    });
  }

  return meshes;
}

function createDiagnosticMaterial(role, palette) {
  const color = palette.roles[role] || palette.roles.fallback;
  return new THREE.MeshBasicMaterial({ color });
}

export function applySpectatorDiagnosticPalette({ scene, arenaObjects, palette = SPECTATOR_DIAGNOSTIC_PALETTE }) {
  const state = {
    background: cloneSceneBackground(scene.background),
    fogColor: scene.fog instanceof THREE.Fog ? scene.fog.color.clone() : null,
    meshMaterials: new Map(),
    diagnosticMaterials: []
  };

  for (const mesh of collectUniqueMeshes(arenaObjects)) {
    state.meshMaterials.set(mesh, mesh.material);
    const diagnosticMaterial = createDiagnosticMaterial(mesh.userData?.spectatorDiagnosticRole, palette);
    state.diagnosticMaterials.push(diagnosticMaterial);
    mesh.material = diagnosticMaterial;
  }

  scene.background = new THREE.Color(palette.background);
  if (scene.fog instanceof THREE.Fog) {
    scene.fog.color.set(palette.fog);
  }

  return state;
}

export function restoreSpectatorDiagnosticPalette({ scene, state }) {
  scene.background = cloneSceneBackground(state.background);
  if (scene.fog instanceof THREE.Fog && state.fogColor) {
    scene.fog.color.copy(state.fogColor);
  }

  for (const [mesh, material] of state.meshMaterials) {
    mesh.material = material;
  }

  for (const material of state.diagnosticMaterials) {
    material.dispose();
  }
}
