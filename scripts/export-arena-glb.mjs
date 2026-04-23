import fs from "node:fs/promises";
import path from "node:path";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { ARENA } from "../shared/protocol.js";

if (typeof globalThis.FileReader === "undefined") {
  globalThis.FileReader = class FileReader {
    constructor() {
      this.result = null;
      this.error = null;
      this.onloadend = null;
    }

    async readAsArrayBuffer(blob) {
      try {
        this.result = await blob.arrayBuffer();
        this.#finish();
      } catch (error) {
        this.error = error;
        this.#finish();
      }
    }

    async readAsDataURL(blob) {
      try {
        const arrayBuffer = await blob.arrayBuffer();
        const mimeType = blob.type || "application/octet-stream";
        const base64 = Buffer.from(arrayBuffer).toString("base64");
        this.result = `data:${mimeType};base64,${base64}`;
        this.#finish();
      } catch (error) {
        this.error = error;
        this.#finish();
      }
    }

    #finish() {
      if (typeof this.onloadend === "function") {
        this.onloadend();
      }
    }
  };
}

function polarToPosition(angle, radius, height = 0) {
  return new THREE.Vector3(Math.cos(angle) * radius, height, Math.sin(angle) * radius);
}

function createArenaReferenceScene() {
  const scene = new THREE.Scene();
  scene.name = "ShutterShyArenaReference";

  const arena = new THREE.Group();
  arena.name = "ArenaReference";
  scene.add(arena);

  const plaza = new THREE.Mesh(
    new THREE.CylinderGeometry(ARENA.plazaTopRadius, ARENA.plazaBottomRadius, ARENA.plazaHeight, 64),
    new THREE.MeshStandardMaterial({ color: "#efd3aa", roughness: 0.95 })
  );
  plaza.name = "Plaza";
  arena.add(plaza);

  const ringMaterial = new THREE.MeshStandardMaterial({ color: "#b97f4f", roughness: 0.98 });
  for (const radius of ARENA.ringRadii) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, ARENA.ringTubeRadius, 18, 96), ringMaterial);
    ring.name = `Ring_${String(radius).replace(".", "_")}`;
    ring.rotation.x = Math.PI / 2;
    ring.position.y = ARENA.ringY;
    arena.add(ring);
  }

  const pedestal = new THREE.Mesh(
    new THREE.CylinderGeometry(ARENA.pedestalTopRadius, ARENA.pedestalBottomRadius, ARENA.pedestalHeight, 48),
    new THREE.MeshStandardMaterial({ color: "#efe3cf", roughness: 0.9 })
  );
  pedestal.name = "Pedestal";
  pedestal.position.y = ARENA.pedestalY;
  arena.add(pedestal);

  const fountainBase = new THREE.Mesh(
    new THREE.CylinderGeometry(ARENA.fountainBaseTopRadius, ARENA.fountainBaseBottomRadius, ARENA.fountainBaseHeight, 48),
    new THREE.MeshStandardMaterial({ color: "#b8d4df", roughness: 0.4, metalness: 0.05 })
  );
  fountainBase.name = "FountainBase";
  fountainBase.position.y = ARENA.fountainBaseY;
  arena.add(fountainBase);

  const waterMaterial = new THREE.MeshStandardMaterial({
    color: "#d7f7ff",
    transparent: true,
    opacity: 0.82,
    emissive: "#9adfff",
    emissiveIntensity: 0.18
  });
  for (let index = 0; index < ARENA.fountainJetCount; index += 1) {
    const jet = new THREE.Mesh(
      new THREE.CylinderGeometry(ARENA.fountainJetTopRadius, ARENA.fountainJetBottomRadius, ARENA.fountainJetHeight, 20),
      waterMaterial.clone()
    );
    jet.name = `FountainJet_${index + 1}`;
    const angle = (index / ARENA.fountainJetCount) * Math.PI * 2;
    jet.position.copy(polarToPosition(angle, ARENA.fountainRadius, ARENA.fountainJetY));
    arena.add(jet);
  }

  const center = new THREE.Object3D();
  center.name = "ArenaCenter";
  center.position.set(0, 0, 0);
  arena.add(center);

  const surfaceCenter = new THREE.Object3D();
  surfaceCenter.name = "ArenaSurfaceCenter";
  surfaceCenter.position.set(0, ARENA.plazaHeight / 2, 0);
  arena.add(surfaceCenter);

  const spectatorCamera = new THREE.PerspectiveCamera(
    ARENA.spectatorProductionCamera.fov,
    16 / 9,
    0.1,
    100
  );
  spectatorCamera.name = "SpectatorProductionCamera";
  spectatorCamera.position.set(
    ARENA.spectatorProductionCamera.position.x,
    ARENA.spectatorProductionCamera.position.y,
    ARENA.spectatorProductionCamera.position.z
  );
  spectatorCamera.lookAt(
    ARENA.spectatorProductionCamera.target.x,
    ARENA.spectatorProductionCamera.target.y,
    ARENA.spectatorProductionCamera.target.z
  );
  spectatorCamera.updateMatrixWorld(true);
  scene.add(spectatorCamera);

  scene.updateMatrixWorld(true);
  return scene;
}

async function exportArenaGlb() {
  const scene = createArenaReferenceScene();
  const exporter = new GLTFExporter();
  const glb = await exporter.parseAsync(scene, {
    binary: true,
    onlyVisible: true
  });

  if (!(glb instanceof ArrayBuffer)) {
    throw new Error("Expected GLB binary output from GLTFExporter.");
  }

  const outputDir = path.resolve("exports");
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "arena-reference.glb");
  await fs.writeFile(outputPath, Buffer.from(glb));

  console.log(`Exported arena reference GLB to ${outputPath}`);
}

exportArenaGlb().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
