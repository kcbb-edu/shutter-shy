import { WORLD } from "./constants.js";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getNormalizedEdgeDistance(index, bandCount) {
  if (bandCount <= 1) {
    return 1;
  }
  const center = (bandCount - 1) / 2;
  return Math.abs(index - center) / Math.max(center, 1);
}

export function getBandWeight(index, bandCount = WORLD.eqBandCount) {
  const edgeDistance = getNormalizedEdgeDistance(index, bandCount);
  return WORLD.eqCenterWidthMultiplier + (WORLD.eqEdgeWidthMultiplier - WORLD.eqCenterWidthMultiplier) * edgeDistance;
}

export function buildEqBands(layout, options = {}) {
  const gameplayWidth = layout?.gameplayWidth ?? WORLD.baseGameplayWidth;
  const bandCount = options.bandCount ?? WORLD.eqBandCount;
  const weights = Array.from({ length: bandCount }, (_, index) => getBandWeight(index, bandCount));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;

  let cursor = 0;
  return weights.map((weight, index) => {
    const width = (gameplayWidth * weight) / totalWeight;
    const startX = cursor;
    const endX = index === bandCount - 1 ? gameplayWidth : startX + width;
    cursor = endX;
    return {
      index,
      startX,
      endX,
      width: endX - startX,
      centerX: startX + (endX - startX) / 2,
      weight,
      targetHeight: 0,
      currentHeight: 0
    };
  });
}

export function getBandAtX(terrain, x) {
  if (!terrain || !Array.isArray(terrain.bars) || terrain.bars.length === 0 || !Number.isFinite(x)) {
    return null;
  }
  const bars = terrain.bars;
  const clampedX = clamp(x, bars[0].startX, bars[bars.length - 1].endX);
  for (const bar of bars) {
    if (clampedX >= bar.startX && clampedX <= bar.endX) {
      return bar;
    }
  }
  return bars[bars.length - 1] || null;
}

export function sampleTerrainTopY(terrain, x) {
  const bar = getBandAtX(terrain, x);
  if (!bar) {
    return 0.02;
  }
  return Math.max(0.02, terrain.baselineY - (bar.currentHeight || 0));
}

export function getBandIndexForFrequency(frequencyHz, minHz, maxHz, bandCount = WORLD.eqBandCount) {
  if (!Number.isFinite(frequencyHz) || !Number.isFinite(minHz) || !Number.isFinite(maxHz) || bandCount <= 0) {
    return null;
  }
  const span = Math.max(1, maxHz - minHz);
  const raw = (frequencyHz - minHz) / span;
  return clamp(Math.floor(clamp(raw, 0, 0.999999) * bandCount), 0, bandCount - 1);
}

export function getBandRangeForIndex(index, minHz, maxHz, bandCount = WORLD.eqBandCount) {
  if (!Number.isFinite(index) || !Number.isFinite(minHz) || !Number.isFinite(maxHz) || bandCount <= 0) {
    return null;
  }
  const span = Math.max(1, maxHz - minHz);
  const bandSpan = span / bandCount;
  const safeIndex = clamp(index, 0, bandCount - 1);
  const startHz = minHz + bandSpan * safeIndex;
  const endHz = safeIndex === bandCount - 1 ? maxHz : minHz + bandSpan * (safeIndex + 1);
  return {
    index: safeIndex,
    startHz,
    endHz
  };
}

export function getLogBandRangeForIndex(index, minHz, maxHz, bandCount = WORLD.eqBandCount) {
  if (!Number.isFinite(index) || !Number.isFinite(minHz) || !Number.isFinite(maxHz) || bandCount <= 0) {
    return null;
  }
  const safeMin = Math.max(minHz, 1);
  const safeMax = Math.max(maxHz, safeMin + 1);
  const logMin = Math.log2(safeMin);
  const logMax = Math.log2(safeMax);
  const span = Math.max(logMax - logMin, 0.01);
  const safeIndex = clamp(index, 0, bandCount - 1);
  const startLog = logMin + (span * safeIndex) / bandCount;
  const endLog = logMin + (span * (safeIndex + 1)) / bandCount;
  return {
    index: safeIndex,
    startHz: 2 ** startLog,
    endHz: safeIndex === bandCount - 1 ? safeMax : 2 ** endLog
  };
}

export function summarizeBars(terrain) {
  if (!terrain?.bars?.length) {
    return "";
  }
  return terrain.bars
    .map((bar) => `${bar.index}:${Math.round((bar.currentHeight || 0) / Math.max(WORLD.eqHeightMax, 0.0001) * 100)}`)
    .join(" ");
}
