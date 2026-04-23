import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { ARENA, DEFAULT_ARENA_THEME_ID, ROLES, normalizeAngle } from "../../shared/protocol.js";
import { getProjectedPointBounds, getSpectatorFramingGeometry } from "./spectatorFraming.js";
import { applySpectatorDiagnosticPalette, restoreSpectatorDiagnosticPalette } from "./spectatorDiagnostic.js";

type RoundPlayer = {
  id: string;
  name: string;
  role: string | null;
  color: string;
  laneIndex: number;
  angle: number;
  yaw: number;
  pitch: number;
  connected?: boolean;
  faceEnabled?: boolean;
  faceFrame?: { imageDataUrl: string } | null;
};

type RoundState = {
  phase: string;
  players: RoundPlayer[];
  fountains: Array<{ index: number; active: boolean; strength: number; angle: number; width?: number }>;
  photographerPlayerId: string | null;
  resolvedTheme?: ArenaThemeId | null;
};

type ArenaMode = "spectator" | "controller";
type ControllerViewMode = "idle" | "photographer" | "runner";
export type ArenaThemeId = "neon" | "synthwave";
type AvatarActionName = "idle" | "run" | "jump";
type AvatarClipMap = Record<AvatarActionName, THREE.AnimationClip>;
type AvatarAsset = {
  template: THREE.Object3D;
  clips: AvatarClipMap;
  materialHslByName: Map<string, { h: number; s: number; l: number }>;
};
type ThemePillarDatum = {
  angle: number;
  radius: number;
  phase: number;
  width: number;
  depth: number;
  heightBias: number;
  tintMix: number;
};
type ThemeCubeDatum = {
  angle: number;
  radius: number;
  height: number;
  phase: number;
  size: number;
  rotationSpeed: number;
  tilt: number;
  tintMix: number;
};
type ThemeParticleDatum = {
  angle: number;
  radius: number;
  baseY: number;
  travelHeight: number;
  phase: number;
  riseSpeed: number;
  drift: number;
};
type ThemeMountainDatum = {
  angle: number;
  radius: number;
  height: number;
  width: number;
  depth: number;
  phase: number;
  bobOffset: number;
  tintMix: number;
};

const GREEN_ROBOT_URL = "/models/GreenRobot.glb";
const AVATAR_TARGET_HEIGHT = ARENA.avatarHeight;
const AVATAR_MODEL_TARGET_HEIGHT = AVATAR_TARGET_HEIGHT * 2.4;
const RUNNER_PLATFORM_Y = ARENA.ringY + ARENA.ringTubeRadius + 0.03;
const PHOTOGRAPHER_PLATFORM_Y = ARENA.pedestalY + ARENA.pedestalHeight * 0.5 + 0.05;
const AVATAR_LABEL_Y = AVATAR_TARGET_HEIGHT * 1.28;
const AVATAR_LABEL_SCALE_X = AVATAR_TARGET_HEIGHT * 1.02;
const AVATAR_LABEL_SCALE_Y = AVATAR_TARGET_HEIGHT * 0.34;
const AVATAR_LABEL_BBOX_OFFSET_Y = AVATAR_TARGET_HEIGHT * 0.12;
const FACE_MASK_PLANE_OUTER_SIZE = AVATAR_TARGET_HEIGHT * 1.42;
const FACE_MASK_PLANE_INNER_SIZE = AVATAR_TARGET_HEIGHT * 1.12;
const FACE_MASK_BONE_LOCAL_X = 0;
const FACE_MASK_BONE_LOCAL_Y = AVATAR_TARGET_HEIGHT * 0.5;
const FACE_MASK_BONE_LOCAL_Z = AVATAR_TARGET_HEIGHT * 0.64;
const FACE_MASK_BONE_FORWARD_ROTATION_Y = 0;
const FACE_TEXTURE_UV_REPEAT = 0.7;
const FACE_TEXTURE_UV_CENTER_X = 0.5;
const FACE_TEXTURE_UV_CENTER_Y = 0.56;
const FACE_DEBUG_MARKER_ENABLED = false;
const FACE_DEBUG_MARKER_RADIUS_RATIO = 0.08;
const FOUNTAIN_BASE_TOP_Y = ARENA.fountainBaseY + ARENA.fountainBaseHeight * 0.5;
const FOUNTAIN_JET_ARC_SPAN = ((Math.PI * 2) / ARENA.fountainJetCount) * 1.0;
const FOUNTAIN_JET_RADIAL_THICKNESS = 1.05;
const FOUNTAIN_JET_MIN_SCALE_Y = 0.02;
const FOUNTAIN_JET_MAX_SCALE_Y = 0.7;
const FOUNTAIN_JET_ANIMATION_LERP = 0.14;
const ACTION_FADE_SECONDS = 0.18;
const MOVEMENT_EPSILON = 0.0008;
const MODEL_FORWARD_YAW_OFFSET = Math.PI;
const RUNNER_TURN_YAW_OFFSET = Math.PI / 4;
const PHOTOGRAPHER_YAW_OFFSET = -Math.PI / 2;
const NEON_THEME_BACKDROP = ARENA.themeBackdrop;
const SYNTHWAVE_THEME_BACKDROP = {
  enabledModes: {
    spectator: true,
    controllerPhotographer: true,
    controllerRunner: false
  },
  sun: {
    radius: 15,
    y: 15.5,
    z: -40
  },
  mountains: {
    count: 15,
    photographerCount: 8,
    radius: 21.5,
    radialJitter: 2.8,
    widthMin: 1.2,
    widthMax: 2.4,
    depthMin: 1.2,
    depthMax: 2.2,
    heightMin: 5.8,
    heightMax: 11.5,
    bobAmplitude: 0.18,
    bobSpeed: 0.12
  },
  particles: {
    count: 420,
    radiusMin: 9.5,
    radiusMax: 29,
    baseY: 0.35,
    heightMin: 7,
    heightMax: 18,
    riseSpeedMin: 0.08,
    riseSpeedMax: 0.2,
    driftMin: 0.08,
    driftMax: 0.34,
    size: 0.2
  },
  floatingCubes: {
    count: 18,
    photographerCount: 10,
    radiusMin: 7.4,
    radiusMax: 15.2,
    heightMin: 1.8,
    heightMax: 5.8,
    sizeMin: 0.3,
    sizeMax: 1.18,
    bobAmplitude: 0.22,
    bobSpeed: 0.78
  },
  grid: {
    size: 56,
    divisions: 28,
    loopLength: 16,
    scrollSpeed: 5.2,
    baseY: 0.16
  }
} as const;
const NEON_SCENE_BACKGROUND_COLOR = new THREE.Color("#081120");
const NEON_SCENE_FOG_COLOR = new THREE.Color("#0d1830");
const SYNTHWAVE_SCENE_BACKGROUND_COLOR = new THREE.Color("#8fd8ff");
const SYNTHWAVE_SCENE_FOG_COLOR = new THREE.Color("#ffe1b8");
const RAINBOW_FLOW_SPEED = 0.042;
const RAINBOW_FLOW_DENSITY = 0.92;
const RAINBOW_SATURATION = 0.84;
const RAINBOW_LIGHTNESS = 0.64;
const RAINBOW_WATER_LIGHTNESS = 0.56;
const NEON_GLOW_COLOR = new THREE.Color("#2adfff");
const SYNTHWAVE_GLOW_COLOR = new THREE.Color("#ff9ed8");
const THEME_GLOW_SIZE = 29;
const THEME_GLOW_Y = 0.18;
const SYNTHWAVE_THEME_STOPS = ["#49c6ff", "#ffe27a", "#ff8a7a"].map((color) => new THREE.Color(color));

const gltfLoader = new GLTFLoader();
let avatarAssetPromise: Promise<AvatarAsset> | null = null;
let faceMaskCircleTexture: THREE.Texture | null = null;
let arenaGlowTexture: THREE.Texture | null = null;
let neonSkyTexture: THREE.Texture | null = null;
let synthwaveSunTexture: THREE.Texture | null = null;
let synthwaveSkyTexture: THREE.Texture | null = null;
const tempAnchorWorldPosition = new THREE.Vector3();
const tempAnchorLocalPosition = new THREE.Vector3();
const tempThemeTransform = new THREE.Object3D();
const tempThemeColor = new THREE.Color();

function polarToPosition(angle: number, radius: number, height = 0) {
  return new THREE.Vector3(Math.cos(angle) * radius, height, Math.sin(angle) * radius);
}

function seededUnit(seed: number) {
  const value = Math.sin(seed * 12.9898) * 43758.5453123;
  return value - Math.floor(value);
}

function getRainbowThemeColor(angle: number, elapsedSeconds: number, lightness = RAINBOW_LIGHTNESS) {
  const hue = ((angle / (Math.PI * 2)) + elapsedSeconds * RAINBOW_FLOW_SPEED * RAINBOW_FLOW_DENSITY) % 1;
  return new THREE.Color().setHSL(hue < 0 ? hue + 1 : hue, RAINBOW_SATURATION, lightness);
}

function normalizeThemeId(themeId: unknown): ArenaThemeId {
  return themeId === "synthwave" ? "synthwave" : "neon";
}

function getThemePaletteColor(themeId: ArenaThemeId, angle: number, elapsedSeconds: number, lightness = RAINBOW_LIGHTNESS) {
  if (themeId === "neon") {
    return getRainbowThemeColor(angle, elapsedSeconds, lightness);
  }

  const normalizedAngle = (angle / (Math.PI * 2)) + elapsedSeconds * 0.026;
  const wrapped = ((normalizedAngle % 1) + 1) % 1;
  const scaled = wrapped * SYNTHWAVE_THEME_STOPS.length;
  const fromIndex = Math.floor(scaled) % SYNTHWAVE_THEME_STOPS.length;
  const toIndex = (fromIndex + 1) % SYNTHWAVE_THEME_STOPS.length;
  const mix = scaled - Math.floor(scaled);
  return SYNTHWAVE_THEME_STOPS[fromIndex].clone().lerp(SYNTHWAVE_THEME_STOPS[toIndex], mix).offsetHSL(0, 0, lightness - RAINBOW_LIGHTNESS);
}

function createTextTexture(label: string, color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#0a1020";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = color;
  context.font = "700 46px Avenir Next";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label.slice(0, 10), canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function getFaceMaskCircleTexture() {
  if (!faceMaskCircleTexture) {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext("2d")!;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#ffffff";
    context.beginPath();
    context.arc(canvas.width / 2, canvas.height / 2, canvas.width * 0.46, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#111111";
    context.beginPath();
    context.arc(canvas.width * 0.37, canvas.height * 0.39, canvas.width * 0.06, 0, Math.PI * 2);
    context.arc(canvas.width * 0.63, canvas.height * 0.39, canvas.width * 0.06, 0, Math.PI * 2);
    context.fill();
    context.lineWidth = canvas.width * 0.045;
    context.lineCap = "round";
    context.strokeStyle = "#111111";
    context.beginPath();
    context.arc(canvas.width / 2, canvas.height * 0.52, canvas.width * 0.14, 0.18 * Math.PI, 0.82 * Math.PI, false);
    context.stroke();
    faceMaskCircleTexture = new THREE.CanvasTexture(canvas);
    faceMaskCircleTexture.needsUpdate = true;
  }
  return faceMaskCircleTexture;
}

function getArenaGlowTexture() {
  if (!arenaGlowTexture) {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext("2d")!;
    const gradient = context.createRadialGradient(
      canvas.width * 0.5,
      canvas.height * 0.5,
      canvas.width * 0.04,
      canvas.width * 0.5,
      canvas.height * 0.5,
      canvas.width * 0.42
    );
    gradient.addColorStop(0, "rgba(255,255,255,0.78)");
    gradient.addColorStop(0.1, "rgba(255,255,255,0.36)");
    gradient.addColorStop(0.24, "rgba(255,255,255,0.14)");
    gradient.addColorStop(0.44, "rgba(255,255,255,0.04)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    arenaGlowTexture = new THREE.CanvasTexture(canvas);
    arenaGlowTexture.colorSpace = THREE.SRGBColorSpace;
    arenaGlowTexture.needsUpdate = true;
  }
  return arenaGlowTexture;
}

function getNeonSkyTexture() {
  if (!neonSkyTexture) {
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 1024;
    const context = canvas.getContext("2d")!;
    context.clearRect(0, 0, canvas.width, canvas.height);

    const vertical = context.createLinearGradient(0, 0, 0, canvas.height);
    vertical.addColorStop(0, "rgba(8,16,38,1)");
    vertical.addColorStop(0.45, "rgba(7,14,31,0.96)");
    vertical.addColorStop(1, "rgba(3,6,18,0.92)");
    context.fillStyle = vertical;
    context.fillRect(0, 0, canvas.width, canvas.height);

    const cyanBloom = context.createRadialGradient(
      canvas.width * 0.52,
      canvas.height * 0.8,
      canvas.width * 0.04,
      canvas.width * 0.52,
      canvas.height * 0.8,
      canvas.width * 0.42
    );
    cyanBloom.addColorStop(0, "rgba(42,223,255,0.24)");
    cyanBloom.addColorStop(0.52, "rgba(42,223,255,0.1)");
    cyanBloom.addColorStop(1, "rgba(42,223,255,0)");
    context.fillStyle = cyanBloom;
    context.fillRect(0, 0, canvas.width, canvas.height);

    const magentaBloom = context.createRadialGradient(
      canvas.width * 0.22,
      canvas.height * 0.24,
      canvas.width * 0.03,
      canvas.width * 0.22,
      canvas.height * 0.24,
      canvas.width * 0.3
    );
    magentaBloom.addColorStop(0, "rgba(255,92,214,0.18)");
    magentaBloom.addColorStop(0.58, "rgba(255,92,214,0.08)");
    magentaBloom.addColorStop(1, "rgba(255,92,214,0)");
    context.fillStyle = magentaBloom;
    context.fillRect(0, 0, canvas.width, canvas.height);

    neonSkyTexture = new THREE.CanvasTexture(canvas);
    neonSkyTexture.colorSpace = THREE.SRGBColorSpace;
    neonSkyTexture.needsUpdate = true;
  }
  return neonSkyTexture;
}

function getSynthwaveSunTexture() {
  if (!synthwaveSunTexture) {
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 1024;
    const context = canvas.getContext("2d")!;
    context.clearRect(0, 0, canvas.width, canvas.height);

    const radial = context.createRadialGradient(
      canvas.width * 0.48,
      canvas.height * 0.46,
      canvas.width * 0.05,
      canvas.width * 0.5,
      canvas.height * 0.5,
      canvas.width * 0.48
    );
    radial.addColorStop(0, "rgba(255,255,240,1)");
    radial.addColorStop(0.18, "rgba(255,245,181,0.98)");
    radial.addColorStop(0.54, "rgba(255,205,120,0.95)");
    radial.addColorStop(0.84, "rgba(255,160,122,0.9)");
    radial.addColorStop(1, "rgba(255,125,115,0.82)");
    context.fillStyle = radial;
    context.beginPath();
    context.arc(canvas.width / 2, canvas.height / 2, canvas.width * 0.44, 0, Math.PI * 2);
    context.fill();

    const rim = context.createRadialGradient(
      canvas.width * 0.5,
      canvas.height * 0.5,
      canvas.width * 0.3,
      canvas.width * 0.5,
      canvas.height * 0.5,
      canvas.width * 0.46
    );
    rim.addColorStop(0, "rgba(255,255,255,0)");
    rim.addColorStop(0.7, "rgba(255,255,255,0)");
    rim.addColorStop(1, "rgba(255,239,201,0.42)");
    context.fillStyle = rim;
    context.beginPath();
    context.arc(canvas.width / 2, canvas.height / 2, canvas.width * 0.44, 0, Math.PI * 2);
    context.fill();

    synthwaveSunTexture = new THREE.CanvasTexture(canvas);
    synthwaveSunTexture.colorSpace = THREE.SRGBColorSpace;
    synthwaveSunTexture.needsUpdate = true;
  }
  return synthwaveSunTexture;
}

function getSynthwaveSkyTexture() {
  if (!synthwaveSkyTexture) {
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 1024;
    const context = canvas.getContext("2d")!;

    const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, "rgba(111, 204, 255, 0.92)");
    gradient.addColorStop(0.42, "rgba(159, 223, 255, 0.78)");
    gradient.addColorStop(0.76, "rgba(255, 231, 186, 0.4)");
    gradient.addColorStop(1, "rgba(255, 214, 150, 0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);

    synthwaveSkyTexture = new THREE.CanvasTexture(canvas);
    synthwaveSkyTexture.colorSpace = THREE.SRGBColorSpace;
    synthwaveSkyTexture.needsUpdate = true;
  }
  return synthwaveSkyTexture;
}

function applyFaceTextureFrame(texture: THREE.Texture) {
  const repeat = FACE_TEXTURE_UV_REPEAT;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.repeat.set(repeat, repeat);
  texture.offset.set(
    FACE_TEXTURE_UV_CENTER_X - repeat * 0.5,
    FACE_TEXTURE_UV_CENTER_Y - repeat * 0.5
  );
  texture.needsUpdate = true;
}

function getSpectatorProductionFrame() {
  return {
    position: new THREE.Vector3(
      ARENA.spectatorProductionCamera.position.x,
      ARENA.spectatorProductionCamera.position.y,
      ARENA.spectatorProductionCamera.position.z
    ),
    target: new THREE.Vector3(
      ARENA.spectatorProductionCamera.target.x,
      ARENA.spectatorProductionCamera.target.y,
      ARENA.spectatorProductionCamera.target.z
    ),
    fov: ARENA.spectatorProductionCamera.fov,
    bounds: new THREE.Box3(),
    compositionBounds: {
      minX: 0,
      maxX: 0,
      minY: 0,
      maxY: 0,
      width: 0,
      height: 0,
      centerX: 0,
      centerY: 0
    }
  };
}

function getCenteredViewport(width: number, height: number, scale: number) {
  const clampedScale = Math.max(0.1, Math.min(scale || 1, 1));
  const viewportWidth = Math.max(1, Math.round(width * clampedScale));
  const viewportHeight = Math.max(1, Math.round(height * clampedScale));
  return {
    x: Math.floor((width - viewportWidth) / 2),
    y: Math.floor((height - viewportHeight) / 2),
    width: viewportWidth,
    height: viewportHeight
  };
}

function colorToHsl(color: THREE.ColorRepresentation) {
  const hsl = { h: 0, s: 0, l: 0 };
  new THREE.Color(color).getHSL(hsl);
  return hsl;
}

function getClipBySuffix(clips: THREE.AnimationClip[], suffix: string) {
  const clip = clips.find((entry) => entry.name.toLowerCase().endsWith(suffix));
  if (!clip) {
    throw new Error(`Missing GreenRobot clip: ${suffix}`);
  }
  return clip;
}

function normalizeBoneName(name: string) {
  return String(name || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function findAvatarBone(root: THREE.Object3D, matcher: (normalizedName: string) => boolean) {
  let found: THREE.Bone | null = null;
  root.traverse((node) => {
    if (found || !(node instanceof THREE.Bone)) {
      return;
    }
    if (matcher(normalizeBoneName(node.name))) {
      found = node;
    }
  });
  return found;
}

function loadAvatarAsset() {
  if (!avatarAssetPromise) {
    avatarAssetPromise = new Promise((resolve, reject) => {
      gltfLoader.load(
        GREEN_ROBOT_URL,
        (gltf) => {
          const materialHslByName = new Map<string, { h: number; s: number; l: number }>();
          gltf.scene.traverse((node) => {
            if (!(node instanceof THREE.Mesh)) {
              return;
            }
            node.castShadow = true;
            node.receiveShadow = true;
            const materials = Array.isArray(node.material) ? node.material : [node.material];
            for (const material of materials) {
              if (!(material instanceof THREE.MeshStandardMaterial) || materialHslByName.has(material.name)) {
                continue;
              }
              materialHslByName.set(material.name, colorToHsl(material.color));
            }
          });
          resolve({
            template: gltf.scene,
            clips: {
              idle: getClipBySuffix(gltf.animations, "idle"),
              jump: getClipBySuffix(gltf.animations, "jump"),
              run: getClipBySuffix(gltf.animations, "run")
            },
            materialHslByName
          });
        },
        undefined,
        reject
      );
    });
  }
  return avatarAssetPromise;
}

function recolorAvatarMaterials(root: THREE.Object3D, color: string, sourceHslByName: Map<string, { h: number; s: number; l: number }>) {
  const targetHsl = colorToHsl(color);
  const clonedMaterials = new Map<string, THREE.Material>();
  const ownedMaterials = new Set<THREE.Material>();
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) {
      return;
    }
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    const recolored = materials.map((material) => {
      if (!(material instanceof THREE.MeshStandardMaterial)) {
        return material;
      }
      const cacheKey = material.uuid;
      const existing = clonedMaterials.get(cacheKey);
      if (existing) {
        ownedMaterials.add(existing);
        return existing;
      }
      const clone = material.clone();
      const sourceHsl = sourceHslByName.get(material.name) || colorToHsl(material.color);
      clone.color.setHSL(
        targetHsl.h,
        THREE.MathUtils.clamp(Math.max(sourceHsl.s * 0.88, targetHsl.s * 0.65), 0.18, 1),
        THREE.MathUtils.clamp(sourceHsl.l * 0.94 + targetHsl.l * 0.08, 0.04, 0.9)
      );
      clone.needsUpdate = true;
      clonedMaterials.set(cacheKey, clone);
      ownedMaterials.add(clone);
      return clone;
    });
    node.material = Array.isArray(node.material) ? recolored : recolored[0];
  });
  return [...ownedMaterials];
}

function getAvatarVisibleBounds(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  const vertex = new THREE.Vector3();
  let hasRenderableMesh = false;

  root.traverse((node) => {
    if (node instanceof THREE.SkinnedMesh) {
      const positions = node.geometry.getAttribute("position");
      if (!positions) {
        return;
      }
      hasRenderableMesh = true;
      for (let index = 0; index < positions.count; index += 1) {
        vertex.fromBufferAttribute(positions, index);
        node.applyBoneTransform(index, vertex);
        vertex.applyMatrix4(node.matrixWorld);
        bounds.expandByPoint(vertex);
      }
      return;
    }
    if (node instanceof THREE.Mesh) {
      hasRenderableMesh = true;
      bounds.expandByObject(node);
    }
  });

  if (!hasRenderableMesh) {
    bounds.setFromObject(root);
  }
  return bounds;
}

function createFountainJetGeometry(centerAngle: number) {
  const outerRadius = ARENA.fountainRadius + FOUNTAIN_JET_RADIAL_THICKNESS * 0.5;
  const innerRadius = ARENA.fountainRadius - FOUNTAIN_JET_RADIAL_THICKNESS * 0.5;
  const startAngle = centerAngle - FOUNTAIN_JET_ARC_SPAN * 0.5;
  const endAngle = centerAngle + FOUNTAIN_JET_ARC_SPAN * 0.5;
  const footprint = new THREE.Shape();
  footprint.absarc(0, 0, outerRadius, startAngle, endAngle, false);
  footprint.absarc(0, 0, innerRadius, endAngle, startAngle, true);
  footprint.closePath();

  const geometry = new THREE.ExtrudeGeometry(footprint, {
    depth: ARENA.fountainJetHeight,
    steps: 1,
    bevelEnabled: false,
    curveSegments: 32
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -ARENA.fountainJetHeight * 0.5, 0);
  geometry.computeVertexNormals();
  return geometry;
}

function normalizeAvatarRoot(root: THREE.Object3D) {
  const initialBounds = getAvatarVisibleBounds(root);
  const initialHeight = Math.max(initialBounds.max.y - initialBounds.min.y, 0.001);
  const scale = AVATAR_MODEL_TARGET_HEIGHT / initialHeight;
  root.scale.setScalar(scale);
  root.updateMatrixWorld(true);

  const scaledBounds = getAvatarVisibleBounds(root);
  const centerX = (scaledBounds.min.x + scaledBounds.max.x) * 0.5;
  const centerZ = (scaledBounds.min.z + scaledBounds.max.z) * 0.5;
  root.position.x -= centerX;
  root.position.y -= scaledBounds.min.y;
  root.position.z -= centerZ;
  root.updateMatrixWorld(true);

  const normalizedBounds = getAvatarVisibleBounds(root);
  return {
    height: Math.max(normalizedBounds.max.y - normalizedBounds.min.y, 0.001)
  };
}

class AvatarView {
  group: THREE.Group;
  modelRoot: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Record<AvatarActionName, THREE.AnimationAction>;
  actionState: AvatarActionName = "idle";
  jumpQueuedState: AvatarActionName = "idle";
  faceMaskAnchor: THREE.Group;
  faceMaskGroup: THREE.Group;
  faceMaskOuter: THREE.Mesh;
  faceMaskInner: THREE.Mesh;
  faceMaskOuterMaterial: THREE.MeshBasicMaterial;
  faceMaskInnerMaterial: THREE.MeshBasicMaterial;
  debugHeadHook: THREE.Mesh;
  debugHeadHookMaterial: THREE.MeshBasicMaterial;
  debugBounds: THREE.Box3Helper;
  debugOriginMarker: THREE.Group;
  faceTexture: THREE.Texture | null = null;
  faceTextureRequestId = 0;
  avatarHeight: number;
  label: THREE.Sprite;
  labelTexture: THREE.Texture;
  headBone: THREE.Bone | null;
  currentFaceUrl = "";
  pendingFaceUrl = "";
  currentLabel = "";
  lastAngle = 0;
  lastLaneIndex = 0;
  lastRole: string | null = null;
  destroyed = false;
  debugMode = false;
  ownedMaterials: THREE.Material[];

  constructor(scene: THREE.Scene, asset: AvatarAsset, color: string, shadowsEnabled: boolean) {
    this.group = new THREE.Group();
    this.modelRoot = cloneSkinned(asset.template);
    const normalizedAvatar = normalizeAvatarRoot(this.modelRoot);
    this.avatarHeight = normalizedAvatar.height;
    this.modelRoot.rotation.y = MODEL_FORWARD_YAW_OFFSET;
    this.modelRoot.updateMatrixWorld(true);
    this.headBone = findAvatarBone(this.modelRoot, (name) => name.endsWith("head"));
    this.modelRoot.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        node.castShadow = shadowsEnabled;
        node.receiveShadow = shadowsEnabled;
      }
    });
    this.ownedMaterials = recolorAvatarMaterials(this.modelRoot, color, asset.materialHslByName);
    this.group.add(this.modelRoot);

    this.faceMaskAnchor = new THREE.Group();
    this.faceMaskGroup = new THREE.Group();
    this.faceMaskAnchor.position.set(FACE_MASK_BONE_LOCAL_X, FACE_MASK_BONE_LOCAL_Y, FACE_MASK_BONE_LOCAL_Z);
    this.faceMaskGroup.rotation.y = FACE_MASK_BONE_FORWARD_ROTATION_Y;
    this.faceMaskGroup.visible = false;
    this.faceMaskOuterMaterial = new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: true,
      depthTest: true,
      depthWrite: false
    });
    this.faceMaskInnerMaterial = new THREE.MeshBasicMaterial({
      color: "#ffffff",
      side: THREE.DoubleSide,
      transparent: true,
      depthTest: true,
      depthWrite: false
    });
    this.faceMaskOuter = new THREE.Mesh(
      new THREE.CircleGeometry(FACE_MASK_PLANE_OUTER_SIZE * 0.5, 48),
      this.faceMaskOuterMaterial
    );
    this.faceMaskOuter.renderOrder = 12;
    this.faceMaskInner = new THREE.Mesh(
      new THREE.CircleGeometry(FACE_MASK_PLANE_INNER_SIZE * 0.5, 48),
      this.faceMaskInnerMaterial
    );
    this.faceMaskInner.position.z = 0.001;
    this.faceMaskInner.renderOrder = 13;
    this.faceMaskGroup.add(this.faceMaskOuter, this.faceMaskInner);
    this.faceMaskAnchor.add(this.faceMaskGroup);
    this.debugHeadHookMaterial = new THREE.MeshBasicMaterial({
      color: "#ff00ff",
      depthTest: false,
      depthWrite: false
    });
    this.debugHeadHook = new THREE.Mesh(
      new THREE.SphereGeometry(this.avatarHeight * FACE_DEBUG_MARKER_RADIUS_RATIO, 16, 16),
      this.debugHeadHookMaterial
    );
    this.debugHeadHook.renderOrder = 9;
    this.debugHeadHook.visible = false;
    this.debugBounds = new THREE.Box3Helper(new THREE.Box3(), "#ffe066");
    this.debugBounds.visible = false;
    this.debugOriginMarker = new THREE.Group();
    this.debugOriginMarker.visible = false;
    const debugOriginSphere = new THREE.Mesh(
      new THREE.SphereGeometry(this.avatarHeight * 0.045, 16, 16),
      new THREE.MeshBasicMaterial({
        color: "#00e5ff",
        depthTest: false,
        depthWrite: false
      })
    );
    debugOriginSphere.renderOrder = 11;
    const debugOriginAxes = new THREE.AxesHelper(this.avatarHeight * 0.42);
    debugOriginAxes.renderOrder = 10;
    debugOriginAxes.traverse((node) => {
      const material = (node as THREE.LineSegments).material;
      if (material instanceof THREE.Material) {
        material.depthTest = false;
        material.depthWrite = false;
      }
    });
    this.debugOriginMarker.add(debugOriginAxes, debugOriginSphere);
    if (this.headBone) {
      this.headBone.add(this.faceMaskAnchor);
    } else {
      this.faceMaskAnchor.position.set(0, this.avatarHeight * 0.62, -this.avatarHeight * 0.08);
      this.group.add(this.faceMaskAnchor);
    }
    this.group.add(this.debugHeadHook);
    this.group.add(this.debugOriginMarker);
    scene.add(this.debugBounds);

    this.mixer = new THREE.AnimationMixer(this.modelRoot);
    this.actions = {
      idle: this.mixer.clipAction(asset.clips.idle),
      jump: this.mixer.clipAction(asset.clips.jump),
      run: this.mixer.clipAction(asset.clips.run)
    };
    this.actions.jump.loop = THREE.LoopOnce;
    this.actions.jump.clampWhenFinished = true;
    this.actions.idle.play();
    this.mixer.addEventListener("finished", this.handleAnimationFinished);

    this.labelTexture = createTextTexture("Player", "#f3f7ff");
    const labelMaterial = new THREE.SpriteMaterial({
      map: this.labelTexture,
      transparent: true,
      depthTest: true,
      depthWrite: false
    });
    this.label = new THREE.Sprite(labelMaterial);
    const labelBounds = getAvatarVisibleBounds(this.modelRoot);
    this.label.position.set(0, labelBounds.max.y + AVATAR_LABEL_BBOX_OFFSET_Y, 0);
    this.label.scale.set(AVATAR_LABEL_SCALE_X, AVATAR_LABEL_SCALE_Y, 1);
    this.label.renderOrder = 8;

    this.group.add(this.label);
    scene.add(this.group);
  }

  setDebugMode(enabled: boolean) {
    this.debugMode = enabled;
    this.debugBounds.visible = enabled;
    this.debugOriginMarker.visible = enabled;
    if (enabled) {
      this.updateDebugHelpers();
    }
  }

  handleAnimationFinished = (event: THREE.Event & { action?: THREE.AnimationAction }) => {
    if (event.action !== this.actions.jump || this.destroyed) {
      return;
    }
    this.fadeTo(this.jumpQueuedState, ACTION_FADE_SECONDS);
  };

  fadeTo(nextAction: AvatarActionName, duration: number) {
    if (this.actionState === nextAction) {
      return;
    }
    const current = this.actions[this.actionState];
    const next = this.actions[nextAction];
    next.enabled = true;
    next.reset();
    next.fadeIn(duration).play();
    current.fadeOut(duration);
    this.actionState = nextAction;
  }

  playJump(resumeAction: AvatarActionName) {
    this.jumpQueuedState = resumeAction;
    this.actions.idle.fadeOut(ACTION_FADE_SECONDS);
    this.actions.run.fadeOut(ACTION_FADE_SECONDS);
    this.actions.jump.enabled = true;
    this.actions.jump.reset().fadeIn(ACTION_FADE_SECONDS).play();
    this.actionState = "jump";
  }

  syncFaceMaskToHead() {
    this.faceMaskAnchor.getWorldPosition(tempAnchorWorldPosition);
    tempAnchorLocalPosition.copy(tempAnchorWorldPosition);
    this.group.worldToLocal(tempAnchorLocalPosition);
    this.debugHeadHook.position.copy(tempAnchorLocalPosition);
  }

  updateDebugHelpers() {
    if (!this.debugMode) {
      return;
    }
    this.modelRoot.updateMatrixWorld(true);
    this.debugBounds.box.copy(getAvatarVisibleBounds(this.modelRoot));
  }

  updateFaceMaskVisibility(player: RoundPlayer) {
    this.faceMaskGroup.visible = player.role === ROLES.RUNNER && player.faceEnabled !== false;
    this.debugHeadHook.visible = FACE_DEBUG_MARKER_ENABLED && player.role === ROLES.RUNNER;
  }

  updateFaceTexture(player: RoundPlayer, textureLoader: THREE.TextureLoader) {
    const faceEnabled = player.faceEnabled !== false;
    const nextFaceUrl = faceEnabled ? player.faceFrame?.imageDataUrl || "" : "";
    const nextTextureKey = nextFaceUrl || (faceEnabled ? "__placeholder__" : "");
    if (this.currentFaceUrl === nextTextureKey || this.pendingFaceUrl === nextTextureKey) {
      return;
    }
    this.pendingFaceUrl = nextTextureKey;
    const requestId = ++this.faceTextureRequestId;
    if (!faceEnabled) {
      const previousTexture = this.faceTexture;
      this.faceTexture = null;
      this.currentFaceUrl = "";
      this.pendingFaceUrl = "";
      this.faceMaskInnerMaterial.map = null;
      this.faceMaskInnerMaterial.color.set("#ffffff");
      this.faceMaskInnerMaterial.needsUpdate = true;
      previousTexture?.dispose();
      return;
    }
    if (!nextFaceUrl) {
      const previousTexture = this.faceTexture;
      this.faceTexture = null;
      this.currentFaceUrl = "__placeholder__";
      this.pendingFaceUrl = "";
      this.faceMaskInnerMaterial.color.set("#ffffff");
      this.faceMaskInnerMaterial.map = getFaceMaskCircleTexture();
      this.faceMaskInnerMaterial.needsUpdate = true;
      previousTexture?.dispose();
      return;
    }
    textureLoader.load(
      nextFaceUrl,
      (texture) => {
        if (this.destroyed || this.faceTextureRequestId !== requestId || this.pendingFaceUrl !== nextTextureKey) {
          texture.dispose();
          return;
        }
        texture.colorSpace = THREE.SRGBColorSpace;
        applyFaceTextureFrame(texture);
        const previousTexture = this.faceTexture;
        this.faceTexture = texture;
        this.currentFaceUrl = nextTextureKey;
        this.pendingFaceUrl = "";
        this.faceMaskInnerMaterial.color.set("#ffffff");
        this.faceMaskInnerMaterial.map = texture;
        this.faceMaskInnerMaterial.needsUpdate = true;
        previousTexture?.dispose();
      },
      undefined,
      () => {
        if (this.faceTextureRequestId !== requestId || this.pendingFaceUrl !== nextTextureKey) {
          return;
        }
        this.pendingFaceUrl = "";
        this.currentFaceUrl = "__placeholder__";
        this.faceMaskInnerMaterial.color.set("#ffffff");
        this.faceMaskInnerMaterial.map = getFaceMaskCircleTexture();
        this.faceMaskInnerMaterial.needsUpdate = true;
      }
    );
  }

  updateLabel(player: RoundPlayer) {
    if (this.currentLabel === player.name) {
      return;
    }
    this.currentLabel = player.name;
    this.labelTexture.dispose();
    this.labelTexture = createTextTexture(player.name, "#f3f7ff");
    const material = this.label.material as THREE.SpriteMaterial;
    material.map = this.labelTexture;
    material.needsUpdate = true;
  }

  updateAnimation(player: RoundPlayer) {
    if (this.lastRole === null) {
      this.actionState = "idle";
      this.actions.idle.reset().play();
      this.actions.run.stop();
      this.actions.jump.stop();
      return;
    }
    const nextBaseAction: AvatarActionName = player.role === ROLES.PHOTOGRAPHER
      ? "idle"
      : Math.abs(normalizeAngle(player.angle - this.lastAngle)) > MOVEMENT_EPSILON
        ? "run"
        : "idle";
    const laneChanged = this.lastRole === player.role && player.role === ROLES.RUNNER && player.laneIndex !== this.lastLaneIndex;
    if (laneChanged && this.actionState !== "jump") {
      this.playJump(nextBaseAction);
    } else if (this.actionState !== "jump") {
      this.fadeTo(nextBaseAction, ACTION_FADE_SECONDS);
    } else {
      this.jumpQueuedState = nextBaseAction;
    }
  }

  update(player: RoundPlayer, textureLoader: THREE.TextureLoader) {
    const radius = player.role === ROLES.PHOTOGRAPHER ? 0 : ARENA.runnerLanes[player.laneIndex] ?? ARENA.runnerLanes[1];
    const position = player.role === ROLES.PHOTOGRAPHER
      ? new THREE.Vector3(0, PHOTOGRAPHER_PLATFORM_Y, 0)
      : polarToPosition(player.angle, radius, RUNNER_PLATFORM_Y);
    const angleDelta = normalizeAngle(player.angle - this.lastAngle);
    const runnerTurnOffset = player.role === ROLES.RUNNER && Math.abs(angleDelta) > MOVEMENT_EPSILON
      ? Math.sign(angleDelta) * RUNNER_TURN_YAW_OFFSET
      : 0;
    this.group.position.copy(position);
    this.group.rotation.y = player.role === ROLES.PHOTOGRAPHER
      ? -player.yaw + PHOTOGRAPHER_YAW_OFFSET
      : normalizeAngle(-player.angle + Math.PI * 0.5 + runnerTurnOffset);
    this.updateAnimation(player);
    this.updateFaceMaskVisibility(player);
    this.updateFaceTexture(player, textureLoader);
    this.updateLabel(player);
    this.syncFaceMaskToHead();
    this.updateDebugHelpers();
    this.lastAngle = player.angle;
    this.lastLaneIndex = player.laneIndex;
    this.lastRole = player.role;
  }

  tick(deltaSeconds: number) {
    this.mixer.update(deltaSeconds);
    this.syncFaceMaskToHead();
    this.updateDebugHelpers();
  }

  dispose(scene: THREE.Scene) {
    this.destroyed = true;
    this.faceTextureRequestId += 1;
    this.mixer.removeEventListener("finished", this.handleAnimationFinished);
    this.mixer.stopAllAction();
    scene.remove(this.group);
    scene.remove(this.debugBounds);
    this.labelTexture.dispose();
    (this.label.material as THREE.SpriteMaterial).dispose();
    this.faceTexture?.dispose();
    this.faceMaskOuterMaterial.dispose();
    this.faceMaskInnerMaterial.dispose();
    this.faceMaskOuter.geometry.dispose();
    this.faceMaskInner.geometry.dispose();
    this.debugHeadHookMaterial.dispose();
    this.debugHeadHook.geometry.dispose();
    this.debugBounds.geometry.dispose();
    (this.debugBounds.material as THREE.Material).dispose();
    this.debugOriginMarker.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        node.geometry.dispose();
        if (node.material instanceof THREE.Material) {
          node.material.dispose();
        }
      }
    });
    for (const material of this.ownedMaterials) {
      material.dispose();
    }
  }
}

export class ArenaView {
  mode: ArenaMode;
  controllerViewMode: ControllerViewMode = "idle";
  activeThemeId: ArenaThemeId = normalizeThemeId(DEFAULT_ARENA_THEME_ID);
  focusPlayerId: string | null = null;
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  textureLoader: THREE.TextureLoader;
  hemisphereLight: THREE.HemisphereLight | null = null;
  sunlight: THREE.DirectionalLight | null = null;
  avatarAsset: AvatarAsset | null = null;
  avatarAssetError: Error | null = null;
  floor: THREE.Group;
  themeBackdropGroup: THREE.Group;
  neonBackdropGroup: THREE.Group;
  synthwaveBackdropGroup: THREE.Group;
  spectatorFrameObjects: THREE.Object3D[] = [];
  spectatorFrameGeometry = {
    bounds: new THREE.Box3(),
    meshBounds: new THREE.Box3(),
    meshPoints: [] as THREE.Vector3[],
    allowancePoints: [] as THREE.Vector3[],
    fitPoints: [] as THREE.Vector3[]
  };
  avatars = new Map<string, AvatarView>();
  fountains: THREE.Mesh[] = [];
  fountainBaseColorAngles: number[] = [];
  neonThemePillars: THREE.InstancedMesh | null = null;
  neonThemePillarData: ThemePillarDatum[] = [];
  neonThemeWaveRings: THREE.Mesh[] = [];
  neonThemeFloatingCubes: THREE.InstancedMesh | null = null;
  neonThemeCubeData: ThemeCubeDatum[] = [];
  neonThemeSky: THREE.Mesh | null = null;
  neonThemeGroundGlow: THREE.Mesh | null = null;
  synthwaveThemeGroundGlow: THREE.Mesh | null = null;
  synthwaveThemeSky: THREE.Mesh | null = null;
  synthwaveThemeSun: THREE.Mesh | null = null;
  synthwaveThemeParticles: THREE.Points | null = null;
  synthwaveThemeParticleData: ThemeParticleDatum[] = [];
  synthwaveThemeMountains: THREE.InstancedMesh | null = null;
  synthwaveThemeMountainData: ThemeMountainDatum[] = [];
  synthwaveThemeFloatingCubes: THREE.InstancedMesh | null = null;
  synthwaveThemeCubeData: ThemeCubeDatum[] = [];
  synthwaveThemeGrids: THREE.GridHelper[] = [];
  state: RoundState | null = null;
  themeElapsedSeconds = 0;
  rafId = 0;
  lastFrameAt = 0;
  dragState: { active: boolean; x: number; y: number } = { active: false, x: 0, y: 0 };
  fallbackYaw = 0;
  fallbackPitch = -0.05;
  active = false;
  currentPixelRatio = 1;
  spectatorFogEnabled = false;
  spectatorContrastMode = false;
  spectatorDiagnosticState: ReturnType<typeof applySpectatorDiagnosticPalette> | null = null;
  resolvedSpectatorFrame = getSpectatorProductionFrame();
  debugCamPos = new THREE.Vector3(
    ARENA.spectatorProductionCamera.position.x,
    ARENA.spectatorProductionCamera.position.y,
    ARENA.spectatorProductionCamera.position.z
  );
  debugCamTarget = new THREE.Vector3(
    ARENA.spectatorProductionCamera.target.x,
    ARENA.spectatorProductionCamera.target.y,
    ARENA.spectatorProductionCamera.target.z
  );
  debugCamFov = ARENA.spectatorProductionCamera.fov;
  debugOverrideCamera = false;   // when true: use the manual debug camera instead of spectator framing
  debugUseLookAt = true;
  debugRotX = -0.9;  // pitch  (look up/down)
  debugRotY = 0;     // yaw    (look left/right)
  debugRotZ = 0;     // roll   (tilt)
  avatarDebugMode = false;

  constructor(canvas: HTMLCanvasElement, mode: ArenaMode) {
    this.canvas = canvas;
    this.mode = mode;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.shadowMap.enabled = mode === "spectator";
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = NEON_SCENE_BACKGROUND_COLOR.clone();
    this.scene.fog = null;
    this.spectatorFogEnabled = false;
    this.camera = new THREE.PerspectiveCamera(mode === "spectator" ? 50 : 55, 1, 0.1, 100);
    this.camera.layers.set(0);
    this.textureLoader = new THREE.TextureLoader();
    this.floor = new THREE.Group();
    this.themeBackdropGroup = new THREE.Group();
    this.neonBackdropGroup = new THREE.Group();
    this.synthwaveBackdropGroup = new THREE.Group();
    this.scene.add(this.floor);
    this.scene.add(this.themeBackdropGroup);
    this.buildScene();
    this.setTheme(DEFAULT_ARENA_THEME_ID);
    this.updateThemeBackdrop(0);
    void this.ensureAvatarAsset();
    this.resize();
    window.addEventListener("resize", this.resize);
    if (mode === "controller") {
      this.attachDragControls();
    }
    this.applyRenderProfile();
  }

  async ensureAvatarAsset() {
    try {
      this.avatarAsset = await loadAvatarAsset();
      if (this.state) {
        this.setRoundState(this.state);
      }
    } catch (error) {
      this.avatarAssetError = error instanceof Error ? error : new Error("Failed to load GreenRobot.glb");
      console.error("[shutter-shy] failed to load GreenRobot avatar", this.avatarAssetError);
    }
  }

  applyRenderProfile() {
    let pixelRatio = Math.min(window.devicePixelRatio || 1, 1.8);
    if (this.mode === "controller") {
      if (this.controllerViewMode === "photographer") {
        pixelRatio = Math.min(window.devicePixelRatio || 1, 1.1);
      } else if (this.controllerViewMode === "runner") {
        pixelRatio = Math.min(window.devicePixelRatio || 1, 0.75);
      } else {
        pixelRatio = 1;
      }
    }
    this.currentPixelRatio = pixelRatio;
    this.renderer.setPixelRatio(pixelRatio);
  }

  getDisplayViewportCss() {
    const width = this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || this.canvas.parentElement?.clientHeight || window.innerHeight;
    return this.getMainViewport(width, height);
  }

  getDisplayViewportPixels() {
    return this.getMainViewport(this.renderer.domElement.width, this.renderer.domElement.height);
  }

  getMainViewport(width: number, height: number) {
    if (this.mode !== "spectator") {
      return { x: 0, y: 0, width, height };
    }
    return getCenteredViewport(width, height, ARENA.spectatorDisplayViewportScale || 1);
  }

  renderMainViewport() {
    const fullWidth = this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || window.innerWidth;
    const fullHeight = this.canvas.clientHeight || this.canvas.parentElement?.clientHeight || window.innerHeight;
    const viewport = this.getDisplayViewportCss();
    const backgroundColor = this.scene.background instanceof THREE.Color ? this.scene.background : new THREE.Color("#000000");
    const previousClearColor = new THREE.Color();
    const previousClearAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(previousClearColor);
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, fullWidth, fullHeight);
    this.renderer.setClearColor(backgroundColor, 1);
    this.renderer.clear();
    this.renderer.setClearColor(previousClearColor, previousClearAlpha);
    this.renderer.setViewport(viewport.x, viewport.y, viewport.width, viewport.height);
    this.renderer.setScissor(viewport.x, viewport.y, viewport.width, viewport.height);
    this.renderer.setScissorTest(true);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setScissorTest(false);
  }

  resize = () => {
    this.applyRenderProfile();
    const width = this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || this.canvas.parentElement?.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    if (this.mode === "controller" && this.controllerViewMode === "photographer") {
      this.camera.aspect = ARENA.captureAspectRatio;
    } else {
      this.camera.aspect = width / Math.max(height, 1);
    }
    this.camera.updateProjectionMatrix();
  };

  applySceneThemePalette(themeId: ArenaThemeId) {
    const background = themeId === "synthwave" ? SYNTHWAVE_SCENE_BACKGROUND_COLOR : NEON_SCENE_BACKGROUND_COLOR;
    this.scene.background = background.clone();
    if (this.hemisphereLight) {
      if (themeId === "synthwave") {
        this.hemisphereLight.color.set("#f7fbff");
        this.hemisphereLight.groundColor.set("#f1c6a1");
        this.hemisphereLight.intensity = 1.86;
      } else {
        this.hemisphereLight.color.set("#7ea2ff");
        this.hemisphereLight.groundColor.set("#050914");
        this.hemisphereLight.intensity = 1.28;
      }
    }
    if (this.sunlight) {
      if (themeId === "synthwave") {
        this.sunlight.color.set("#ffe0a8");
        this.sunlight.intensity = 1.82;
        this.sunlight.position.set(14, 26, 8);
      } else {
        this.sunlight.color.set("#ffd9fb");
        this.sunlight.intensity = 1.42;
        this.sunlight.position.set(9, 20, 12);
      }
    }
    this.updateArenaSurfacePalette(themeId);
  }

  updateArenaSurfacePalette(themeId: ArenaThemeId) {
    this.floor.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) {
        return;
      }
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        if (!(material instanceof THREE.MeshStandardMaterial)) {
          continue;
        }
        const role = node.userData.spectatorDiagnosticRole;
        if (themeId === "synthwave") {
          if (role === "plaza") {
            material.color.set("#f8fbff");
            material.emissive.set("#000000");
            material.emissiveIntensity = 0;
            material.roughness = 0.9;
            material.metalness = 0.05;
          } else if (role === "ring") {
            material.color.set("#ffd98a");
            material.emissive.set("#000000");
            material.emissiveIntensity = 0;
            material.roughness = 0.82;
            material.metalness = 0.1;
          } else if (role === "pedestal") {
            material.color.set("#ffb59f");
            material.emissive.set("#000000");
            material.emissiveIntensity = 0;
            material.roughness = 0.72;
            material.metalness = 0.08;
          } else if (role === "fountain-base") {
            material.color.set("#7ed6ff");
            material.emissive.set("#a3efff");
            material.emissiveIntensity = 0.18;
            material.roughness = 0.26;
            material.metalness = 0.06;
          }
        } else if (role === "plaza") {
          material.color.set("#294774");
          material.emissive.set("#0a1834");
          material.emissiveIntensity = 0.16;
          material.roughness = 0.88;
          material.metalness = 0.1;
        } else if (role === "ring") {
          material.color.set("#5f8fc4");
          material.emissive.set("#16345c");
          material.emissiveIntensity = 0.24;
          material.roughness = 0.84;
          material.metalness = 0.18;
        } else if (role === "pedestal") {
          material.color.set("#79a3d9");
          material.emissive.set("#11274b");
          material.emissiveIntensity = 0.2;
          material.roughness = 0.72;
          material.metalness = 0.14;
        } else if (role === "fountain-base") {
          material.color.set("#1a4567");
          material.emissive.set("#1762d8");
          material.emissiveIntensity = 0.3;
          material.roughness = 0.34;
          material.metalness = 0.1;
        }
      }
    });
  }

  setTheme(themeId: ArenaThemeId | string | null | undefined) {
    this.activeThemeId = normalizeThemeId(themeId || DEFAULT_ARENA_THEME_ID);
    if (!this.spectatorContrastMode) {
      this.applySceneThemePalette(this.activeThemeId);
    }
    if (!this.active) {
      this.renderStillFrame();
    }
  }

  buildScene() {
    const hemisphere = new THREE.HemisphereLight("#426d8e", "#030711", 1.08);
    this.hemisphereLight = hemisphere;
    this.scene.add(hemisphere);

    const sun = new THREE.DirectionalLight("#c8e8ff", 1.18);
    this.sunlight = sun;
    sun.position.set(12, 18, 10);
    sun.castShadow = this.mode === "spectator";
    if (sun.castShadow) {
      sun.shadow.mapSize.set(1024, 1024);
    }
    this.scene.add(sun);

    const plaza = new THREE.Mesh(
      new THREE.CylinderGeometry(ARENA.plazaTopRadius, ARENA.plazaBottomRadius, ARENA.plazaHeight, 64),
      new THREE.MeshStandardMaterial({
        color: "#253752",
        roughness: 0.95,
        metalness: 0.08
      })
    );
    plaza.userData.spectatorDiagnosticRole = "plaza";
    plaza.receiveShadow = true;
    this.floor.add(plaza);
    this.spectatorFrameObjects.push(plaza);

    const ringMaterial = new THREE.MeshStandardMaterial({
      color: "#4f7090",
      roughness: 0.92,
      metalness: 0.16
    });
    for (const radius of ARENA.ringRadii) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, ARENA.ringTubeRadius, 18, 96), ringMaterial);
      ring.userData.spectatorDiagnosticRole = "ring";
      ring.rotation.x = Math.PI / 2;
      ring.position.y = ARENA.ringY;
      this.floor.add(ring);
      this.spectatorFrameObjects.push(ring);
    }

    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(ARENA.pedestalTopRadius, ARENA.pedestalBottomRadius, ARENA.pedestalHeight, 48),
      new THREE.MeshStandardMaterial({
        color: "#6d839c",
        roughness: 0.82,
        metalness: 0.12
      })
    );
    pedestal.userData.spectatorDiagnosticRole = "pedestal";
    pedestal.position.y = ARENA.pedestalY;
    pedestal.receiveShadow = true;
    this.floor.add(pedestal);
    this.spectatorFrameObjects.push(pedestal);

    const fountainBase = new THREE.Mesh(
      new THREE.CylinderGeometry(ARENA.fountainBaseTopRadius, ARENA.fountainBaseBottomRadius, ARENA.fountainBaseHeight, 48),
      new THREE.MeshStandardMaterial({
        color: "#173a51",
        emissive: "#0b2536",
        emissiveIntensity: 0.22,
        roughness: 0.44,
        metalness: 0.08
      })
    );
    fountainBase.userData.spectatorDiagnosticRole = "fountain-base";
    fountainBase.position.y = ARENA.fountainBaseY;
    this.floor.add(fountainBase);
    this.spectatorFrameObjects.push(fountainBase);

    const waterMaterial = new THREE.MeshStandardMaterial({
      color: "#8cefff",
      emissive: "#42dfff",
      emissiveIntensity: 0.48,
      roughness: 0.14,
      metalness: 0.04
    });
    for (let index = 0; index < ARENA.fountainJetCount; index += 1) {
      const angle = (index / ARENA.fountainJetCount) * Math.PI * 2;
      const jet = new THREE.Mesh(
        createFountainJetGeometry(angle),
        waterMaterial.clone()
      );
      jet.scale.y = FOUNTAIN_JET_MIN_SCALE_Y;
      jet.position.y = FOUNTAIN_BASE_TOP_Y + (ARENA.fountainJetHeight * jet.scale.y) * 0.5;
      jet.castShadow = this.mode === "spectator";
      jet.receiveShadow = this.mode === "spectator";
      this.scene.add(jet);
      this.fountains.push(jet);
      this.fountainBaseColorAngles.push(angle);
    }

    this.buildThemeBackdrop();

    this.scene.updateMatrixWorld(true);
    this.spectatorFrameGeometry = getSpectatorFramingGeometry({
      frameObjects: this.spectatorFrameObjects,
      arena: ARENA
    });
    this.resolvedSpectatorFrame = getSpectatorProductionFrame();
  }

  buildThemeBackdrop() {
    this.themeBackdropGroup.add(this.neonBackdropGroup, this.synthwaveBackdropGroup);
    this.buildNeonThemeBackdrop();
    this.buildSynthwaveThemeBackdrop();
  }

  buildNeonThemeBackdrop() {
    this.neonThemeSky = new THREE.Mesh(
      new THREE.PlaneGeometry(86, 50, 1, 1),
      new THREE.MeshBasicMaterial({
        map: getNeonSkyTexture(),
        transparent: true,
        opacity: 0.88,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false
      })
    );
    this.neonThemeSky.position.set(0, 16.5, -46);
    this.neonThemeSky.renderOrder = -3;
    this.neonBackdropGroup.add(this.neonThemeSky);

    this.neonThemeGroundGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(THEME_GLOW_SIZE, THEME_GLOW_SIZE, 1, 1),
      new THREE.MeshBasicMaterial({
        map: getArenaGlowTexture(),
        color: NEON_GLOW_COLOR,
        transparent: true,
        opacity: 0.24,
        blending: THREE.AdditiveBlending,
        depthTest: true,
        depthWrite: false,
        toneMapped: false
      })
    );
    this.neonThemeGroundGlow.rotation.x = -Math.PI / 2;
    this.neonThemeGroundGlow.position.y = THEME_GLOW_Y;
    this.neonThemeGroundGlow.renderOrder = 1;
    this.neonBackdropGroup.add(this.neonThemeGroundGlow);

    const pillarGeometry = new THREE.BoxGeometry(1, 1, 1);
    pillarGeometry.translate(0, 0.5, 0);
    const pillarMaterial = new THREE.MeshBasicMaterial({
      color: "#ffffff",
      transparent: true,
      opacity: 0.96
    });
    pillarMaterial.toneMapped = false;
    this.neonThemePillars = new THREE.InstancedMesh(pillarGeometry, pillarMaterial, NEON_THEME_BACKDROP.pillars.count);
    this.neonThemePillars.castShadow = false;
    this.neonThemePillars.receiveShadow = false;
    this.neonBackdropGroup.add(this.neonThemePillars);

    for (let index = 0; index < NEON_THEME_BACKDROP.pillars.count; index += 1) {
      const widthJitter = 0.86 + seededUnit(index + 11) * 0.38;
      this.neonThemePillarData.push({
        angle: (index / NEON_THEME_BACKDROP.pillars.count) * Math.PI * 2 + (seededUnit(index + 21) - 0.5) * 0.08,
        radius: NEON_THEME_BACKDROP.pillars.radius + (seededUnit(index + 31) - 0.5) * NEON_THEME_BACKDROP.pillars.radialJitter,
        phase: seededUnit(index + 41) * Math.PI * 2,
        width: NEON_THEME_BACKDROP.pillars.width * widthJitter,
        depth: NEON_THEME_BACKDROP.pillars.depth * (0.9 + seededUnit(index + 51) * 0.32),
        heightBias: seededUnit(index + 61),
        tintMix: seededUnit(index + 71)
      });
      tempThemeColor.copy(getThemePaletteColor("neon", this.neonThemePillarData[index].angle, 0)).offsetHSL(0, 0, (this.neonThemePillarData[index].tintMix - 0.5) * 0.08);
      this.neonThemePillars.setColorAt(index, tempThemeColor);
    }
    this.neonThemePillars.instanceMatrix.needsUpdate = true;
    if (this.neonThemePillars.instanceColor) {
      this.neonThemePillars.instanceColor.needsUpdate = true;
    }

    for (let index = 0; index < NEON_THEME_BACKDROP.waveRings.count; index += 1) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(
          NEON_THEME_BACKDROP.waveRings.radii[index],
          NEON_THEME_BACKDROP.waveRings.tubeRadius,
          8,
          88
        ),
        new THREE.MeshBasicMaterial({
          color: getThemePaletteColor("neon", (index / Math.max(NEON_THEME_BACKDROP.waveRings.count, 1)) * Math.PI * 2, 0),
          wireframe: true,
          transparent: true,
          opacity: 0.88,
          depthWrite: false,
          toneMapped: false
        })
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = NEON_THEME_BACKDROP.waveRings.heights[index];
      ring.castShadow = false;
      ring.receiveShadow = false;
      this.neonThemeWaveRings.push(ring);
      this.neonBackdropGroup.add(ring);
    }

    const cubeGeometry = new THREE.BoxGeometry(1, 1, 1);
    const cubeMaterial = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      emissive: "#2ddfff",
      emissiveIntensity: 0.58,
      roughness: 0.26,
      metalness: 0.12
    });
    cubeMaterial.toneMapped = false;
    this.neonThemeFloatingCubes = new THREE.InstancedMesh(cubeGeometry, cubeMaterial, NEON_THEME_BACKDROP.floatingCubes.count);
    this.neonThemeFloatingCubes.castShadow = false;
    this.neonThemeFloatingCubes.receiveShadow = false;
    this.neonBackdropGroup.add(this.neonThemeFloatingCubes);

    for (let index = 0; index < NEON_THEME_BACKDROP.floatingCubes.count; index += 1) {
      const mix = seededUnit(index + 131);
      this.neonThemeCubeData.push({
        angle: seededUnit(index + 81) * Math.PI * 2,
        radius: THREE.MathUtils.lerp(
          NEON_THEME_BACKDROP.floatingCubes.radiusMin,
          NEON_THEME_BACKDROP.floatingCubes.radiusMax,
          seededUnit(index + 91)
        ),
        height: THREE.MathUtils.lerp(
          NEON_THEME_BACKDROP.floatingCubes.heightMin,
          NEON_THEME_BACKDROP.floatingCubes.heightMax,
          seededUnit(index + 101)
        ),
        phase: seededUnit(index + 111) * Math.PI * 2,
        size: THREE.MathUtils.lerp(
          NEON_THEME_BACKDROP.floatingCubes.sizeMin,
          NEON_THEME_BACKDROP.floatingCubes.sizeMax,
          seededUnit(index + 121)
        ),
        rotationSpeed: 0.18 + seededUnit(index + 141) * 0.28,
        tilt: (seededUnit(index + 151) - 0.5) * 0.75,
        tintMix: mix
      });
      tempThemeColor.copy(getThemePaletteColor("neon", this.neonThemeCubeData[index].angle, 0)).offsetHSL(0, 0, (mix - 0.5) * 0.08);
      this.neonThemeFloatingCubes.setColorAt(index, tempThemeColor);
    }
    this.neonThemeFloatingCubes.instanceMatrix.needsUpdate = true;
    if (this.neonThemeFloatingCubes.instanceColor) {
      this.neonThemeFloatingCubes.instanceColor.needsUpdate = true;
    }
  }

  buildSynthwaveThemeBackdrop() {
    this.synthwaveThemeSky = new THREE.Mesh(
      new THREE.PlaneGeometry(86, 52, 1, 1),
      new THREE.MeshBasicMaterial({
        map: getSynthwaveSkyTexture(),
        transparent: true,
        opacity: 0.72,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false
      })
    );
    this.synthwaveThemeSky.position.set(0, 17.5, -48);
    this.synthwaveThemeSky.renderOrder = -3;
    this.synthwaveBackdropGroup.add(this.synthwaveThemeSky);

    this.synthwaveThemeGroundGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(THEME_GLOW_SIZE + 6, THEME_GLOW_SIZE + 6, 1, 1),
      new THREE.MeshBasicMaterial({
        map: getArenaGlowTexture(),
        color: "#ffdca1",
        transparent: true,
        opacity: 0.12,
        blending: THREE.NormalBlending,
        depthTest: true,
        depthWrite: false,
        toneMapped: false
      })
    );
    this.synthwaveThemeGroundGlow.rotation.x = -Math.PI / 2;
    this.synthwaveThemeGroundGlow.position.y = THEME_GLOW_Y;
    this.synthwaveThemeGroundGlow.renderOrder = 1;
    this.synthwaveBackdropGroup.add(this.synthwaveThemeGroundGlow);

    this.synthwaveThemeSun = new THREE.Mesh(
      new THREE.CircleGeometry(SYNTHWAVE_THEME_BACKDROP.sun.radius, 96),
      new THREE.MeshBasicMaterial({
        map: getSynthwaveSunTexture(),
        transparent: true,
        opacity: 0.92,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false
      })
    );
    this.synthwaveThemeSun.position.set(0, SYNTHWAVE_THEME_BACKDROP.sun.y, SYNTHWAVE_THEME_BACKDROP.sun.z);
    this.synthwaveThemeSun.renderOrder = -1;
    this.synthwaveBackdropGroup.add(this.synthwaveThemeSun);

    const particleGeometry = new THREE.BufferGeometry();
    const particlePositions = new Float32Array(SYNTHWAVE_THEME_BACKDROP.particles.count * 3);
    const particleColors = new Float32Array(SYNTHWAVE_THEME_BACKDROP.particles.count * 3);
    for (let index = 0; index < SYNTHWAVE_THEME_BACKDROP.particles.count; index += 1) {
      const angle = seededUnit(index + 511) * Math.PI * 2;
      const radius = THREE.MathUtils.lerp(
        SYNTHWAVE_THEME_BACKDROP.particles.radiusMin,
        SYNTHWAVE_THEME_BACKDROP.particles.radiusMax,
        seededUnit(index + 521)
      );
      const travelHeight = THREE.MathUtils.lerp(
        SYNTHWAVE_THEME_BACKDROP.particles.heightMin,
        SYNTHWAVE_THEME_BACKDROP.particles.heightMax,
        seededUnit(index + 531)
      );
      const phase = seededUnit(index + 541);
      const riseSpeed = THREE.MathUtils.lerp(
        SYNTHWAVE_THEME_BACKDROP.particles.riseSpeedMin,
        SYNTHWAVE_THEME_BACKDROP.particles.riseSpeedMax,
        seededUnit(index + 551)
      );
      const drift = THREE.MathUtils.lerp(
        SYNTHWAVE_THEME_BACKDROP.particles.driftMin,
        SYNTHWAVE_THEME_BACKDROP.particles.driftMax,
        seededUnit(index + 561)
      );
      this.synthwaveThemeParticleData.push({
        angle,
        radius,
        baseY: SYNTHWAVE_THEME_BACKDROP.particles.baseY,
        travelHeight,
        phase,
        riseSpeed,
        drift
      });
      particlePositions[index * 3] = Math.cos(angle) * radius;
      particlePositions[index * 3 + 1] = SYNTHWAVE_THEME_BACKDROP.particles.baseY + travelHeight * phase;
      particlePositions[index * 3 + 2] = Math.sin(angle) * radius;
      tempThemeColor.setHSL(
        seededUnit(index + 571) > 0.55
          ? THREE.MathUtils.lerp(0.09, 0.14, seededUnit(index + 581))
          : THREE.MathUtils.lerp(0.53, 0.57, seededUnit(index + 581)),
        THREE.MathUtils.lerp(0.68, 0.9, seededUnit(index + 591)),
        THREE.MathUtils.lerp(0.72, 0.9, seededUnit(index + 601))
      );
      particleColors[index * 3] = tempThemeColor.r;
      particleColors[index * 3 + 1] = tempThemeColor.g;
      particleColors[index * 3 + 2] = tempThemeColor.b;
    }
    particleGeometry.setAttribute("position", new THREE.BufferAttribute(particlePositions, 3));
    particleGeometry.setAttribute("color", new THREE.BufferAttribute(particleColors, 3));
    this.synthwaveThemeParticles = new THREE.Points(
      particleGeometry,
      new THREE.PointsMaterial({
        size: SYNTHWAVE_THEME_BACKDROP.particles.size,
        transparent: true,
        opacity: 0.72,
        vertexColors: true,
        depthWrite: false,
        toneMapped: false,
        sizeAttenuation: true
      })
    );
    this.synthwaveBackdropGroup.add(this.synthwaveThemeParticles);

    const mountainGeometry = new THREE.ConeGeometry(2, 4, 4);
    mountainGeometry.translate(0, 1, 0);
    mountainGeometry.rotateY(Math.PI / 4);
    const mountainMaterial = new THREE.MeshBasicMaterial({
      color: "#dff7ff",
      wireframe: false,
      transparent: true,
      opacity: 0.08,
      blending: THREE.NormalBlending,
      depthWrite: false,
      toneMapped: false
    });
    this.synthwaveThemeMountains = new THREE.InstancedMesh(mountainGeometry, mountainMaterial, SYNTHWAVE_THEME_BACKDROP.mountains.count);
    this.synthwaveThemeMountains.castShadow = false;
    this.synthwaveThemeMountains.receiveShadow = false;
    this.synthwaveBackdropGroup.add(this.synthwaveThemeMountains);

    for (let index = 0; index < SYNTHWAVE_THEME_BACKDROP.mountains.count; index += 1) {
      const mix = seededUnit(index + 411);
      this.synthwaveThemeMountainData.push({
        angle: (index / SYNTHWAVE_THEME_BACKDROP.mountains.count) * Math.PI * 2 + (seededUnit(index + 421) - 0.5) * 0.12,
        radius: SYNTHWAVE_THEME_BACKDROP.mountains.radius + (seededUnit(index + 431) - 0.5) * SYNTHWAVE_THEME_BACKDROP.mountains.radialJitter,
        height: THREE.MathUtils.lerp(
          SYNTHWAVE_THEME_BACKDROP.mountains.heightMin,
          SYNTHWAVE_THEME_BACKDROP.mountains.heightMax,
          seededUnit(index + 441)
        ),
        width: THREE.MathUtils.lerp(
          SYNTHWAVE_THEME_BACKDROP.mountains.widthMin,
          SYNTHWAVE_THEME_BACKDROP.mountains.widthMax,
          seededUnit(index + 451)
        ),
        depth: THREE.MathUtils.lerp(
          SYNTHWAVE_THEME_BACKDROP.mountains.depthMin,
          SYNTHWAVE_THEME_BACKDROP.mountains.depthMax,
          seededUnit(index + 461)
        ),
        phase: seededUnit(index + 471) * Math.PI * 2,
        bobOffset: seededUnit(index + 481),
        tintMix: mix
      });
      tempThemeColor.copy("#dff7ff");
      this.synthwaveThemeMountains.setColorAt(index, tempThemeColor);
    }
    this.synthwaveThemeMountains.instanceMatrix.needsUpdate = true;
    if (this.synthwaveThemeMountains.instanceColor) {
      this.synthwaveThemeMountains.instanceColor.needsUpdate = true;
    }

    const cubeGeometry = new THREE.BoxGeometry(1, 1, 1);
    const cubeMaterial = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      emissive: "#ffd3b4",
      emissiveIntensity: 0.12,
      roughness: 0.42,
      metalness: 0.04
    });
    this.synthwaveThemeFloatingCubes = new THREE.InstancedMesh(
      cubeGeometry,
      cubeMaterial,
      SYNTHWAVE_THEME_BACKDROP.floatingCubes.count
    );
    this.synthwaveThemeFloatingCubes.castShadow = false;
    this.synthwaveThemeFloatingCubes.receiveShadow = false;
    this.synthwaveBackdropGroup.add(this.synthwaveThemeFloatingCubes);

    for (let index = 0; index < SYNTHWAVE_THEME_BACKDROP.floatingCubes.count; index += 1) {
      const angle = seededUnit(index + 611) * Math.PI * 2;
      const radius = THREE.MathUtils.lerp(
        SYNTHWAVE_THEME_BACKDROP.floatingCubes.radiusMin,
        SYNTHWAVE_THEME_BACKDROP.floatingCubes.radiusMax,
        seededUnit(index + 621)
      );
      const height = THREE.MathUtils.lerp(
        SYNTHWAVE_THEME_BACKDROP.floatingCubes.heightMin,
        SYNTHWAVE_THEME_BACKDROP.floatingCubes.heightMax,
        seededUnit(index + 631)
      );
      const size = THREE.MathUtils.lerp(
        SYNTHWAVE_THEME_BACKDROP.floatingCubes.sizeMin,
        SYNTHWAVE_THEME_BACKDROP.floatingCubes.sizeMax,
        seededUnit(index + 641)
      );
      const tintMix = seededUnit(index + 651);
      this.synthwaveThemeCubeData.push({
        angle,
        radius,
        height,
        phase: seededUnit(index + 661) * Math.PI * 2,
        size,
        rotationSpeed: THREE.MathUtils.lerp(0.1, 0.32, seededUnit(index + 671)),
        tilt: THREE.MathUtils.lerp(-0.42, 0.42, seededUnit(index + 681)),
        tintMix
      });
      tempThemeColor.setHSL(
        tintMix > 0.56
          ? THREE.MathUtils.lerp(0.53, 0.58, seededUnit(index + 691))
          : THREE.MathUtils.lerp(0.05, 0.1, seededUnit(index + 691)),
        THREE.MathUtils.lerp(0.54, 0.76, seededUnit(index + 701)),
        THREE.MathUtils.lerp(0.62, 0.8, seededUnit(index + 711))
      );
      this.synthwaveThemeFloatingCubes.setColorAt(index, tempThemeColor);
    }
    this.synthwaveThemeFloatingCubes.instanceMatrix.needsUpdate = true;
    if (this.synthwaveThemeFloatingCubes.instanceColor) {
      this.synthwaveThemeFloatingCubes.instanceColor.needsUpdate = true;
    }

    for (let index = 0; index < 2; index += 1) {
      const grid = new THREE.GridHelper(
        SYNTHWAVE_THEME_BACKDROP.grid.size,
        SYNTHWAVE_THEME_BACKDROP.grid.divisions,
        "#ffffff",
        "#ffffff"
      );
      const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
      for (const material of materials) {
        if (material instanceof THREE.Material) {
          material.transparent = true;
          material.opacity = index === 0 ? 0.06 : 0.03;
          material.blending = THREE.NormalBlending;
          material.depthWrite = false;
          material.toneMapped = false;
        }
      }
      grid.position.y = SYNTHWAVE_THEME_BACKDROP.grid.baseY + index * 0.06;
      grid.rotation.y = index === 0 ? 0 : Math.PI / SYNTHWAVE_THEME_BACKDROP.grid.divisions;
      this.synthwaveThemeGrids.push(grid);
      this.synthwaveBackdropGroup.add(grid);
    }
  }

  updateThemeBackdrop(elapsedSeconds: number) {
    this.themeElapsedSeconds = elapsedSeconds;
    const neonEnabled = !!NEON_THEME_BACKDROP?.enabled
      && (
        (this.mode === "spectator" && NEON_THEME_BACKDROP.enabledModes.spectator)
        || (this.mode === "controller" && this.controllerViewMode === "photographer" && NEON_THEME_BACKDROP.enabledModes.controllerPhotographer)
        || (this.mode === "controller" && this.controllerViewMode === "runner" && NEON_THEME_BACKDROP.enabledModes.controllerRunner)
      );
    const synthwaveEnabled = (
      (this.mode === "spectator" && SYNTHWAVE_THEME_BACKDROP.enabledModes.spectator)
      || (this.mode === "controller" && this.controllerViewMode === "photographer" && SYNTHWAVE_THEME_BACKDROP.enabledModes.controllerPhotographer)
      || (this.mode === "controller" && this.controllerViewMode === "runner" && SYNTHWAVE_THEME_BACKDROP.enabledModes.controllerRunner)
    );
    const showBackdrop = !this.spectatorContrastMode
      && ((this.activeThemeId === "neon" && neonEnabled) || (this.activeThemeId === "synthwave" && synthwaveEnabled));

    this.themeBackdropGroup.visible = showBackdrop;
    this.neonBackdropGroup.visible = showBackdrop && this.activeThemeId === "neon";
    this.synthwaveBackdropGroup.visible = showBackdrop && this.activeThemeId === "synthwave";
    if (!showBackdrop) {
      return;
    }

    if (this.activeThemeId === "synthwave") {
      this.updateSynthwaveThemeBackdrop(elapsedSeconds);
      return;
    }
    this.updateNeonThemeBackdrop(elapsedSeconds);
  }

  updateNeonThemeBackdrop(elapsedSeconds: number) {
    const photographerMode = this.mode === "controller" && this.controllerViewMode === "photographer";
    const activePillarCount = photographerMode ? NEON_THEME_BACKDROP.pillars.photographerCount : NEON_THEME_BACKDROP.pillars.count;
    const activeWaveRingCount = photographerMode ? NEON_THEME_BACKDROP.waveRings.photographerCount : NEON_THEME_BACKDROP.waveRings.count;
    const activeCubeCount = photographerMode ? NEON_THEME_BACKDROP.floatingCubes.photographerCount : NEON_THEME_BACKDROP.floatingCubes.count;

    if (this.neonThemePillars) {
      for (let index = 0; index < this.neonThemePillarData.length; index += 1) {
        if (index < activePillarCount) {
          const pillar = this.neonThemePillarData[index];
          const animatedHeight = NEON_THEME_BACKDROP.pillars.baseHeight
            + pillar.heightBias * NEON_THEME_BACKDROP.pillars.heightVariance
            + Math.sin(elapsedSeconds * NEON_THEME_BACKDROP.pillars.bobSpeed + pillar.phase) * NEON_THEME_BACKDROP.pillars.bobAmplitude;
          tempThemeTransform.position.set(
            Math.cos(pillar.angle) * pillar.radius,
            ARENA.plazaHeight * 0.5,
            Math.sin(pillar.angle) * pillar.radius
          );
          tempThemeTransform.rotation.set(0, pillar.angle + Math.PI * 0.5, 0);
          tempThemeTransform.scale.set(pillar.width, animatedHeight, pillar.depth);
          tempThemeColor.copy(getThemePaletteColor("neon", pillar.angle, elapsedSeconds)).offsetHSL(0, 0, (pillar.tintMix - 0.5) * 0.08);
          this.neonThemePillars.setColorAt(index, tempThemeColor);
        } else {
          tempThemeTransform.position.set(0, -100, 0);
          tempThemeTransform.rotation.set(0, 0, 0);
          tempThemeTransform.scale.set(0.0001, 0.0001, 0.0001);
        }
        tempThemeTransform.updateMatrix();
        this.neonThemePillars.setMatrixAt(index, tempThemeTransform.matrix);
      }
      this.neonThemePillars.instanceMatrix.needsUpdate = true;
      if (this.neonThemePillars.instanceColor) {
        this.neonThemePillars.instanceColor.needsUpdate = true;
      }
    }

    if (this.neonThemeSky?.material instanceof THREE.MeshBasicMaterial) {
      this.neonThemeSky.material.opacity = 0.84 + Math.sin(elapsedSeconds * 0.04) * 0.03;
    }
    if (this.neonThemeGroundGlow?.material instanceof THREE.MeshBasicMaterial) {
      this.neonThemeGroundGlow.material.opacity = 0.22 + Math.sin(elapsedSeconds * 0.18) * 0.02;
    }

    for (let index = 0; index < this.neonThemeWaveRings.length; index += 1) {
      const ring = this.neonThemeWaveRings[index];
      ring.visible = index < activeWaveRingCount;
      if (!ring.visible) {
        continue;
      }
      const direction = index % 2 === 0 ? 1 : -1;
      const pulse = 1 + Math.sin(elapsedSeconds * (0.18 + index * 0.03) + index * 0.9) * NEON_THEME_BACKDROP.waveRings.pulseAmount;
      ring.scale.setScalar(pulse);
      ring.rotation.x = Math.PI / 2;
      ring.rotation.z = elapsedSeconds * NEON_THEME_BACKDROP.waveRings.rotationSpeed * direction;
      const ringMaterial = ring.material;
      if (ringMaterial instanceof THREE.MeshBasicMaterial) {
        ringMaterial.color.copy(getThemePaletteColor("neon", (index / Math.max(this.neonThemeWaveRings.length, 1)) * Math.PI * 2, elapsedSeconds, 0.66));
      }
    }

    if (this.neonThemeFloatingCubes) {
      for (let index = 0; index < this.neonThemeCubeData.length; index += 1) {
        if (index < activeCubeCount) {
          const cube = this.neonThemeCubeData[index];
          const bob = Math.sin(elapsedSeconds * NEON_THEME_BACKDROP.floatingCubes.bobSpeed + cube.phase) * NEON_THEME_BACKDROP.floatingCubes.bobAmplitude;
          tempThemeTransform.position.set(
            Math.cos(cube.angle) * cube.radius,
            cube.height + bob,
            Math.sin(cube.angle) * cube.radius
          );
          tempThemeTransform.rotation.set(
            cube.tilt,
            elapsedSeconds * cube.rotationSpeed + cube.phase,
            cube.tilt * 0.6
          );
          tempThemeTransform.scale.setScalar(cube.size);
          tempThemeColor.copy(getThemePaletteColor("neon", cube.angle, elapsedSeconds)).offsetHSL(0, 0, (cube.tintMix - 0.5) * 0.08);
          this.neonThemeFloatingCubes.setColorAt(index, tempThemeColor);
        } else {
          tempThemeTransform.position.set(0, -100, 0);
          tempThemeTransform.rotation.set(0, 0, 0);
          tempThemeTransform.scale.set(0.0001, 0.0001, 0.0001);
        }
        tempThemeTransform.updateMatrix();
        this.neonThemeFloatingCubes.setMatrixAt(index, tempThemeTransform.matrix);
      }
      this.neonThemeFloatingCubes.instanceMatrix.needsUpdate = true;
      if (this.neonThemeFloatingCubes.instanceColor) {
        this.neonThemeFloatingCubes.instanceColor.needsUpdate = true;
      }
    }
  }

  updateSynthwaveThemeBackdrop(elapsedSeconds: number) {
    const photographerMode = this.mode === "controller" && this.controllerViewMode === "photographer";
    const activeMountainCount = 0;
    const activeCubeCount = photographerMode
      ? SYNTHWAVE_THEME_BACKDROP.floatingCubes.photographerCount
      : SYNTHWAVE_THEME_BACKDROP.floatingCubes.count;

    if (this.synthwaveThemeGroundGlow?.material instanceof THREE.MeshBasicMaterial) {
      this.synthwaveThemeGroundGlow.material.opacity = 0.1 + Math.sin(elapsedSeconds * 0.22) * 0.015;
    }
    if (this.synthwaveThemeSky?.material instanceof THREE.MeshBasicMaterial) {
      this.synthwaveThemeSky.material.opacity = 0.68 + Math.sin(elapsedSeconds * 0.05) * 0.02;
    }
    if (this.synthwaveThemeSun?.material instanceof THREE.MeshBasicMaterial) {
      this.synthwaveThemeSun.material.opacity = 0.94 + Math.sin(elapsedSeconds * 0.08) * 0.015;
    }
    if (this.synthwaveThemeSun) {
      this.synthwaveThemeSun.scale.setScalar(1 + Math.sin(elapsedSeconds * 0.06) * 0.01);
    }
    if (this.synthwaveThemeParticles) {
      const positionAttribute = this.synthwaveThemeParticles.geometry.getAttribute("position");
      if (positionAttribute instanceof THREE.BufferAttribute) {
        for (let index = 0; index < this.synthwaveThemeParticleData.length; index += 1) {
          const particle = this.synthwaveThemeParticleData[index];
          const riseProgress = (elapsedSeconds * particle.riseSpeed + particle.phase) % 1;
          const driftOffset = Math.sin(elapsedSeconds * 0.42 + particle.phase * Math.PI * 2) * particle.drift;
          positionAttribute.setXYZ(
            index,
            Math.cos(particle.angle) * (particle.radius + driftOffset),
            particle.baseY + riseProgress * particle.travelHeight,
            Math.sin(particle.angle) * (particle.radius + Math.cos(elapsedSeconds * 0.35 + particle.phase * Math.PI * 2) * particle.drift)
          );
        }
        positionAttribute.needsUpdate = true;
      }
    }

    if (this.synthwaveThemeMountains) {
      for (let index = 0; index < this.synthwaveThemeMountainData.length; index += 1) {
        if (index < activeMountainCount) {
          const mountain = this.synthwaveThemeMountainData[index];
          const bob = Math.sin(elapsedSeconds * SYNTHWAVE_THEME_BACKDROP.mountains.bobSpeed + mountain.phase) * SYNTHWAVE_THEME_BACKDROP.mountains.bobAmplitude;
          tempThemeTransform.position.set(
            Math.cos(mountain.angle) * mountain.radius,
            ARENA.plazaHeight * 0.5 + mountain.bobOffset * 0.18,
            Math.sin(mountain.angle) * mountain.radius
          );
          tempThemeTransform.rotation.set(0, mountain.angle + Math.PI * 0.35, 0);
          tempThemeTransform.scale.set(mountain.width, mountain.height + bob, mountain.depth);
          tempThemeColor.copy(getThemePaletteColor("synthwave", mountain.angle, elapsedSeconds, 0.6)).offsetHSL(0, 0, (mountain.tintMix - 0.5) * 0.05);
          this.synthwaveThemeMountains.setColorAt(index, tempThemeColor);
        } else {
          tempThemeTransform.position.set(0, -100, 0);
          tempThemeTransform.rotation.set(0, 0, 0);
          tempThemeTransform.scale.set(0.0001, 0.0001, 0.0001);
        }
        tempThemeTransform.updateMatrix();
        this.synthwaveThemeMountains.setMatrixAt(index, tempThemeTransform.matrix);
      }
      this.synthwaveThemeMountains.instanceMatrix.needsUpdate = true;
      if (this.synthwaveThemeMountains.instanceColor) {
        this.synthwaveThemeMountains.instanceColor.needsUpdate = true;
      }
    }
    if (this.synthwaveThemeFloatingCubes) {
      for (let index = 0; index < this.synthwaveThemeCubeData.length; index += 1) {
        if (index < activeCubeCount) {
          const cube = this.synthwaveThemeCubeData[index];
          const bob = Math.sin(elapsedSeconds * SYNTHWAVE_THEME_BACKDROP.floatingCubes.bobSpeed + cube.phase)
            * SYNTHWAVE_THEME_BACKDROP.floatingCubes.bobAmplitude;
          tempThemeTransform.position.set(
            Math.cos(cube.angle) * cube.radius,
            cube.height + bob,
            Math.sin(cube.angle) * cube.radius
          );
          tempThemeTransform.rotation.set(
            cube.tilt + Math.sin(elapsedSeconds * 0.18 + cube.phase) * 0.05,
            elapsedSeconds * cube.rotationSpeed + cube.phase,
            cube.tilt * 0.7
          );
          tempThemeTransform.scale.setScalar(cube.size);
          tempThemeColor.setHSL(
            cube.tintMix > 0.56 ? 0.55 : 0.08,
            cube.tintMix > 0.56 ? 0.66 : 0.72,
            0.68 + Math.sin(elapsedSeconds * 0.2 + cube.phase) * 0.05
          );
          this.synthwaveThemeFloatingCubes.setColorAt(index, tempThemeColor);
        } else {
          tempThemeTransform.position.set(0, -100, 0);
          tempThemeTransform.rotation.set(0, 0, 0);
          tempThemeTransform.scale.set(0.0001, 0.0001, 0.0001);
        }
        tempThemeTransform.updateMatrix();
        this.synthwaveThemeFloatingCubes.setMatrixAt(index, tempThemeTransform.matrix);
      }
      this.synthwaveThemeFloatingCubes.instanceMatrix.needsUpdate = true;
      if (this.synthwaveThemeFloatingCubes.instanceColor) {
        this.synthwaveThemeFloatingCubes.instanceColor.needsUpdate = true;
      }
    }

    for (let index = 0; index < this.synthwaveThemeGrids.length; index += 1) {
      const grid = this.synthwaveThemeGrids[index];
      grid.visible = false;
      const offset = ((elapsedSeconds * SYNTHWAVE_THEME_BACKDROP.grid.scrollSpeed) + index * (SYNTHWAVE_THEME_BACKDROP.grid.loopLength * 0.5))
        % SYNTHWAVE_THEME_BACKDROP.grid.loopLength;
      grid.position.z = SYNTHWAVE_THEME_BACKDROP.grid.loopLength * 0.5 - offset;
      grid.position.y = SYNTHWAVE_THEME_BACKDROP.grid.baseY + index * 0.06;
    }
  }

  attachDragControls() {
    const start = (x: number, y: number) => {
      this.dragState = { active: true, x, y };
    };
    const move = (x: number, y: number) => {
      if (!this.dragState.active) {
        return;
      }
      const dx = x - this.dragState.x;
      const dy = y - this.dragState.y;
      this.fallbackYaw = normalizeAngle(this.fallbackYaw - dx * 0.008);
      this.fallbackPitch = Math.max(ARENA.pitchClamp.min, Math.min(ARENA.pitchClamp.max, this.fallbackPitch - dy * 0.006));
      this.dragState.x = x;
      this.dragState.y = y;
    };
    this.canvas.addEventListener("pointerdown", (event) => start(event.clientX, event.clientY));
    this.canvas.addEventListener("pointermove", (event) => move(event.clientX, event.clientY));
    this.canvas.addEventListener("pointerup", () => {
      this.dragState.active = false;
    });
    this.canvas.addEventListener("pointerleave", () => {
      this.dragState.active = false;
    });
  }

  setRoundState(nextState: RoundState) {
    this.state = nextState;
    this.updateCamera();
    const activeIds = new Set(nextState.players.map((player) => player.id));
    for (const [id, avatar] of this.avatars) {
      if (!activeIds.has(id)) {
        avatar.dispose(this.scene);
        this.avatars.delete(id);
      }
    }

    for (const player of nextState.players) {
      if (!player.role) {
        continue;
      }
      let avatar = this.avatars.get(player.id);
      if (!avatar && this.avatarAsset) {
        avatar = new AvatarView(this.scene, this.avatarAsset, player.color, this.renderer.shadowMap.enabled);
        avatar.setDebugMode(this.avatarDebugMode);
        this.avatars.set(player.id, avatar);
      }
      if (!avatar) {
        continue;
      }
      avatar.update(player, this.textureLoader);
      avatar.group.visible = !(this.mode === "controller" && this.focusPlayerId === player.id);
      if (this.mode === "spectator" && this.spectatorContrastMode) {
        avatar.group.visible = false;
      }
    }
    if (!this.active) {
      this.renderStillFrame();
    }
  }

  setControllerView(nextMode: ControllerViewMode, focusPlayerId: string | null = null) {
    this.controllerViewMode = nextMode;
    this.focusPlayerId = focusPlayerId;
    this.resize();
    if (this.state) {
      this.setRoundState(this.state);
      return;
    }
    if (!this.active) {
      this.renderStillFrame();
    }
  }

  setCameraOrientation(yaw: number, pitch: number) {
    this.fallbackYaw = yaw;
    this.fallbackPitch = pitch;
  }

  setSpectatorContrastMode(enabled: boolean) {
    if (this.mode !== "spectator" || this.spectatorContrastMode === enabled) {
      return;
    }

    this.spectatorContrastMode = enabled;
    if (enabled) {
      this.spectatorDiagnosticState = applySpectatorDiagnosticPalette({
        scene: this.scene,
        arenaObjects: this.spectatorFrameObjects
      });
    } else if (this.spectatorDiagnosticState) {
      restoreSpectatorDiagnosticPalette({
        scene: this.scene,
        state: this.spectatorDiagnosticState
      });
      this.spectatorDiagnosticState = null;
      this.applySceneThemePalette(this.activeThemeId);
    }

    if (this.state) {
      this.setRoundState(this.state);
    }
    this.updateFountains();
  }

  setAvatarDebugMode(enabled: boolean) {
    this.avatarDebugMode = enabled;
    for (const avatar of this.avatars.values()) {
      avatar.setDebugMode(enabled);
    }
  }

  setActive(nextActive: boolean) {
    if (this.active === nextActive) {
      return;
    }
    this.active = nextActive;
    if (nextActive) {
      this.lastFrameAt = 0;
      console.debug(`[shutter-shy] ${this.mode === "spectator" ? "display" : "controller"}-3d-start`);
      this.renderLoop();
      return;
    }
    console.debug(`[shutter-shy] ${this.mode === "spectator" ? "display" : "controller"}-3d-stop`);
    window.cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.lastFrameAt = 0;
  }

  updateCamera() {
    if (this.mode === "spectator") {
      if (this.debugOverrideCamera) {
        this.camera.fov = this.debugCamFov;
        this.camera.updateProjectionMatrix();
        this.camera.position.copy(this.debugCamPos);
        if (this.debugUseLookAt) {
          this.camera.lookAt(this.debugCamTarget);
        } else {
          this.camera.rotation.order = "YXZ";
          this.camera.rotation.x = this.debugRotX;
          this.camera.rotation.y = this.debugRotY;
          this.camera.rotation.z = this.debugRotZ;
        }
      } else {
        const frame = getSpectatorProductionFrame();
        this.resolvedSpectatorFrame = frame;
        this.camera.fov = frame.fov;
        this.camera.updateProjectionMatrix();
        this.camera.position.copy(frame.position);
        this.camera.lookAt(frame.target);
      }
      return;
    }
    if (this.controllerViewMode === "runner") {
      const runner = this.state?.players?.find((player) => player.id === this.focusPlayerId);
      if (runner) {
        const radius = ARENA.runnerLanes[runner.laneIndex] ?? ARENA.runnerLanes[1];
        const cameraPosition = polarToPosition(runner.angle, radius, ARENA.cameraHeight);
        this.camera.position.copy(cameraPosition);
        this.camera.lookAt(0, 0.8, 0);
        return;
      }
    }
    this.camera.position.set(0, ARENA.cameraHeight, 0);
    const direction = new THREE.Vector3(
      Math.cos(this.fallbackPitch) * Math.cos(this.fallbackYaw),
      Math.sin(this.fallbackPitch),
      Math.cos(this.fallbackPitch) * Math.sin(this.fallbackYaw)
    );
    this.camera.lookAt(this.camera.position.clone().add(direction));
  }

  updateFountains() {
    const fountains = this.state?.fountains || [];
    for (let index = 0; index < this.fountains.length; index += 1) {
      const mesh = this.fountains[index];
      if (this.mode === "spectator" && this.spectatorContrastMode) {
        mesh.visible = false;
        continue;
      }
      const source = fountains[index];
      if (!source) {
        mesh.visible = false;
        continue;
      }
      const visible = source.active || source.strength > 0.02;
      mesh.visible = visible;
      if (!visible) {
        continue;
      }
      const targetScaleY = FOUNTAIN_JET_MIN_SCALE_Y + source.strength * (FOUNTAIN_JET_MAX_SCALE_Y - FOUNTAIN_JET_MIN_SCALE_Y);
      const nextScaleY = THREE.MathUtils.lerp(mesh.scale.y, targetScaleY, FOUNTAIN_JET_ANIMATION_LERP);
      mesh.scale.y = nextScaleY;
      mesh.scale.x = 1;
      mesh.scale.z = 1;
      mesh.position.y = FOUNTAIN_BASE_TOP_Y + (ARENA.fountainJetHeight * nextScaleY) * 0.5;
      const material = mesh.material;
      if (material instanceof THREE.MeshStandardMaterial) {
        const themeColor = getThemePaletteColor(this.activeThemeId, this.fountainBaseColorAngles[index] || 0, this.themeElapsedSeconds, RAINBOW_WATER_LIGHTNESS);
        const inactiveBlend = THREE.MathUtils.clamp(source.strength * 0.55 + (source.active ? 0.45 : 0.12), 0.12, 1);
        material.color.copy(themeColor).multiplyScalar(this.activeThemeId === "synthwave" ? 0.92 : 1.02);
        material.emissive.copy(themeColor).multiplyScalar(this.activeThemeId === "synthwave" ? 0.78 + inactiveBlend * 0.72 : 0.62 + inactiveBlend * 0.92);
        material.emissiveIntensity = this.activeThemeId === "synthwave"
          ? 0.34 + inactiveBlend * 0.42
          : 0.46 + inactiveBlend * 0.5;
      }
    }
  }

  getSpectatorCompositionBounds() {
    if (!this.spectatorFrameGeometry.meshPoints.length) {
      return null;
    }
    return getProjectedPointBounds(this.spectatorFrameGeometry.meshPoints, this.camera);
  }

  renderLoop = () => {
    if (!this.active) {
      return;
    }
    this.rafId = window.requestAnimationFrame(this.renderLoop);
    const now = performance.now();
    const deltaSeconds = this.lastFrameAt ? Math.min((now - this.lastFrameAt) / 1000, 0.1) : 0;
    this.lastFrameAt = now;
    this.updateCamera();
    for (const avatar of this.avatars.values()) {
      avatar.tick(deltaSeconds);
    }
    this.updateFountains();
    this.updateThemeBackdrop(now / 1000);
    this.renderMainViewport();
  };

  renderStillFrame() {
    this.updateCamera();
    for (const avatar of this.avatars.values()) {
      avatar.tick(0);
    }
    this.updateFountains();
    this.updateThemeBackdrop(performance.now() / 1000);
    this.renderMainViewport();
  }

  capturePhoto() {
    this.renderStillFrame();
    const parentWidth = this.canvas.clientWidth || window.innerWidth;
    const parentHeight = this.canvas.clientHeight || window.innerHeight;
    const previousAspect = this.camera.aspect;
    this.renderer.setSize(ARENA.captureWidth, ARENA.captureHeight, false);
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, ARENA.captureWidth, ARENA.captureHeight);
    this.camera.aspect = ARENA.captureAspectRatio;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
    const imageDataUrl = this.renderer.domElement.toDataURL("image/jpeg", 0.72);
    this.renderer.setSize(parentWidth, parentHeight, false);
    this.camera.aspect = previousAspect;
    this.camera.updateProjectionMatrix();
    this.renderMainViewport();
    return imageDataUrl;
  }

  // Returns the CSS-pixel screen position of a world point, plus NDC and
  // whether the point is in front of the camera.
  worldToScreen(wx: number, wy: number, wz: number) {
    const v = new THREE.Vector3(wx, wy, wz);
    v.project(this.camera);                      // → NDC  (-1..1, -1..1, -1..1)
    const viewport = this.getDisplayViewportCss();
    const screenX = viewport.x + (v.x * 0.5 + 0.5) * viewport.width;
    const screenY = viewport.y + (1 - (v.y * 0.5 + 0.5)) * viewport.height;   // flip Y for CSS
    return { ndcX: v.x, ndcY: v.y, ndcZ: v.z, screenX, screenY, inFront: v.z < 1 };
  }

  destroy() {
    this.active = false;
    window.cancelAnimationFrame(this.rafId);
    window.removeEventListener("resize", this.resize);
    for (const avatar of this.avatars.values()) {
      avatar.dispose(this.scene);
    }
    this.avatars.clear();
    if (this.spectatorDiagnosticState) {
      restoreSpectatorDiagnosticPalette({
        scene: this.scene,
        state: this.spectatorDiagnosticState
      });
      this.spectatorDiagnosticState = null;
    }
    this.neonThemeSky?.geometry.dispose();
    if (this.neonThemeSky?.material instanceof THREE.Material) {
      this.neonThemeSky.material.dispose();
    }
    this.neonThemeGroundGlow?.geometry.dispose();
    if (this.neonThemeGroundGlow?.material instanceof THREE.Material) {
      this.neonThemeGroundGlow.material.dispose();
    }
    this.neonThemePillars?.geometry.dispose();
    if (this.neonThemePillars?.material instanceof THREE.Material) {
      this.neonThemePillars.material.dispose();
    }
    for (const ring of this.neonThemeWaveRings) {
      ring.geometry.dispose();
      if (ring.material instanceof THREE.Material) {
        ring.material.dispose();
      }
    }
    this.neonThemeFloatingCubes?.geometry.dispose();
    if (this.neonThemeFloatingCubes?.material instanceof THREE.Material) {
      this.neonThemeFloatingCubes.material.dispose();
    }
    this.synthwaveThemeGroundGlow?.geometry.dispose();
    if (this.synthwaveThemeGroundGlow?.material instanceof THREE.Material) {
      this.synthwaveThemeGroundGlow.material.dispose();
    }
    this.synthwaveThemeSky?.geometry.dispose();
    if (this.synthwaveThemeSky?.material instanceof THREE.Material) {
      this.synthwaveThemeSky.material.dispose();
    }
    this.synthwaveThemeSun?.geometry.dispose();
    if (this.synthwaveThemeSun?.material instanceof THREE.Material) {
      this.synthwaveThemeSun.material.dispose();
    }
    this.synthwaveThemeParticles?.geometry.dispose();
    if (this.synthwaveThemeParticles?.material instanceof THREE.Material) {
      this.synthwaveThemeParticles.material.dispose();
    }
    this.synthwaveThemeMountains?.geometry.dispose();
    if (this.synthwaveThemeMountains?.material instanceof THREE.Material) {
      this.synthwaveThemeMountains.material.dispose();
    }
    this.synthwaveThemeFloatingCubes?.geometry.dispose();
    if (this.synthwaveThemeFloatingCubes?.material instanceof THREE.Material) {
      this.synthwaveThemeFloatingCubes.material.dispose();
    }
    for (const grid of this.synthwaveThemeGrids) {
      grid.geometry.dispose();
      const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
      for (const material of materials) {
        if (material instanceof THREE.Material) {
          material.dispose();
        }
      }
    }
    this.renderer.dispose();
  }
}
