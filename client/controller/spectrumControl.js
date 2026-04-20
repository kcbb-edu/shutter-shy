import { AUDIO, WORLD } from "../../shared/protocol.js";
import { getLogBandRangeForIndex } from "../../shared/utils.js";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function quantile(values, q) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = clamp(Math.round((sorted.length - 1) * q), 0, sorted.length - 1);
  return sorted[index];
}

function clampProfileRange(lowHz, highHz) {
  let nextLow = lowHz;
  let nextHigh = highHz;

  if (nextHigh - nextLow < AUDIO.profileMinSpanHz) {
    const mid = (nextLow + nextHigh) / 2;
    nextLow = mid - AUDIO.profileMinSpanHz / 2;
    nextHigh = mid + AUDIO.profileMinSpanHz / 2;
  }

  if (nextHigh - nextLow > AUDIO.profileMaxSpanHz) {
    const mid = (nextLow + nextHigh) / 2;
    nextLow = mid - AUDIO.profileMaxSpanHz / 2;
    nextHigh = mid + AUDIO.profileMaxSpanHz / 2;
  }

  if (nextLow < AUDIO.analysisMinHz) {
    const delta = AUDIO.analysisMinHz - nextLow;
    nextLow += delta;
    nextHigh += delta;
  }
  if (nextHigh > AUDIO.analysisMaxHz) {
    const delta = nextHigh - AUDIO.analysisMaxHz;
    nextLow -= delta;
    nextHigh -= delta;
  }

  return {
    lowHz: clamp(nextLow, AUDIO.analysisMinHz, AUDIO.analysisMaxHz),
    highHz: clamp(nextHigh, AUDIO.analysisMinHz + AUDIO.profileMinSpanHz, AUDIO.analysisMaxHz)
  };
}

function dbToEnergy(db) {
  if (!Number.isFinite(db) || db <= -160) {
    return 0;
  }
  return 10 ** (db / 20);
}

function getBinHz(binIndex, sampleRate, fftSize) {
  return (binIndex * sampleRate) / fftSize;
}

function sampleEnergyNearHz(frequencyData, sampleRate, fftSize, targetHz, widthRatio = 0.08) {
  if (!Number.isFinite(targetHz) || targetHz <= 0) {
    return 0;
  }
  const minHz = targetHz * (1 - widthRatio);
  const maxHz = targetHz * (1 + widthRatio);
  let energy = 0;
  for (let index = 0; index < frequencyData.length; index += 1) {
    const hz = getBinHz(index, sampleRate, fftSize);
    if (hz < minHz || hz > maxHz) {
      continue;
    }
    energy += dbToEnergy(frequencyData[index]);
  }
  return energy;
}

function getLogBandIndexForHz(hz, minHz, maxHz, bandCount = WORLD.eqBandCount) {
  if (!Number.isFinite(hz)) {
    return null;
  }
  const safeMin = Math.max(minHz, 1);
  const safeMax = Math.max(maxHz, safeMin + 1);
  const clampedHz = clamp(hz, safeMin, safeMax * 0.999999);
  const logMin = Math.log2(safeMin);
  const logMax = Math.log2(safeMax);
  const ratio = (Math.log2(clampedHz) - logMin) / Math.max(logMax - logMin, 0.01);
  return clamp(Math.floor(clamp(ratio, 0, 0.999999) * bandCount), 0, bandCount - 1);
}

function aggregateBandEnergies(frequencyData, sampleRate, fftSize, lowHz, highHz, bandCount = WORLD.eqBandCount, tiltPower = 0) {
  const levels = Array.from({ length: bandCount }, () => 0);
  const logMin = Math.log2(Math.max(lowHz, 1));
  const logMax = Math.log2(Math.max(highHz, lowHz + 1));
  for (let index = 0; index < frequencyData.length; index += 1) {
    const hz = getBinHz(index, sampleRate, fftSize);
    if (hz < lowHz || hz > highHz) {
      continue;
    }
    const logHz = Math.log2(Math.max(hz, 1));
    const ratio = (logHz - logMin) / Math.max(logMax - logMin, 0.01);
    const bandIndex = clamp(Math.floor(clamp(ratio, 0, 0.999999) * bandCount), 0, bandCount - 1);
    const tilt = tiltPower > 0 ? Math.max(0.28, (lowHz / Math.max(hz, lowHz)) ** tiltPower) : 1;
    levels[bandIndex] += dbToEnergy(frequencyData[index]) * tilt;
  }
  return levels;
}

function normalizeBandEnergies(levels) {
  const peak = Math.max(...levels, 0);
  if (peak <= 0) {
    return levels;
  }
  return levels.map((level) => level / peak);
}

function shapeControlLevels(rawBandLevels, dominantBandIndex) {
  if (!Number.isInteger(dominantBandIndex)) {
    return Array.from({ length: rawBandLevels.length }, () => 0);
  }
  return rawBandLevels.map((_level, index) => {
    const distance = Math.abs(index - dominantBandIndex);
    if (distance === 0) {
      return 1;
    }
    if (distance === 1) {
      return WORLD.eqNeighborDecay;
    }
    return 0;
  });
}

function pickDominantBandIndex(levels) {
  const peak = Math.max(...levels, 0);
  if (peak <= 0) {
    return null;
  }
  const threshold = peak * 0.58;
  let weightedTotal = 0;
  let weightSum = 0;
  levels.forEach((level, index) => {
    if (level < threshold) {
      return;
    }
    weightedTotal += level * index;
    weightSum += level;
  });
  if (weightSum <= 0) {
    return levels.reduce((bestIndex, level, index, all) => (level > all[bestIndex] ? index : bestIndex), 0);
  }
  return clamp(Math.round(weightedTotal / weightSum), 0, levels.length - 1);
}

function estimateFundamentalHz(timeData, sampleRate, minHz, maxHz) {
  if (!timeData || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return null;
  }
  const minLag = Math.max(2, Math.floor(sampleRate / Math.max(maxHz, minHz + 1)));
  const maxLag = Math.min(timeData.length - 2, Math.floor(sampleRate / Math.max(minHz, 1)));
  if (maxLag <= minLag + 2) {
    return null;
  }

  let mean = 0;
  for (let index = 0; index < timeData.length; index += 1) {
    mean += timeData[index];
  }
  mean /= timeData.length;

  const centered = new Float32Array(timeData.length);
  let energy = 0;
  for (let index = 0; index < timeData.length; index += 1) {
    const value = timeData[index] - mean;
    centered[index] = value;
    energy += value * value;
  }
  if (energy / timeData.length < 1e-6) {
    return null;
  }

  const difference = new Float32Array(maxLag + 1);
  const cmndf = new Float32Array(maxLag + 1);
  cmndf[0] = 1;
  let runningSum = 0;
  for (let lag = 1; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let index = 0; index < centered.length - lag; index += 1) {
      const delta = centered[index] - centered[index + lag];
      sum += delta * delta;
    }
    difference[lag] = sum;
    runningSum += sum;
    cmndf[lag] = runningSum > 0 ? (sum * lag) / runningSum : 1;
  }

  let bestLag = -1;
  let bestValue = Infinity;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const value = cmndf[lag];
    if (value < 0.16) {
      bestLag = lag;
      while (bestLag + 1 <= maxLag && cmndf[bestLag + 1] < cmndf[bestLag]) {
        bestLag += 1;
      }
      break;
    }
    if (value < bestValue) {
      bestValue = value;
      bestLag = lag;
    }
  }
  if (bestLag < 0) {
    return null;
  }

  const previous = bestLag > minLag ? cmndf[bestLag - 1] : cmndf[bestLag];
  const current = cmndf[bestLag];
  const next = bestLag < maxLag ? cmndf[bestLag + 1] : cmndf[bestLag];
  const denominator = previous + next - (2 * current);
  const offset = Math.abs(denominator) > 1e-6 ? (previous - next) / (2 * denominator) : 0;
  const refinedLag = bestLag + clamp(offset, -0.5, 0.5);
  const hz = sampleRate / refinedLag;
  return Number.isFinite(hz) ? clamp(hz, minHz, maxHz) : null;
}

function correctLowOctaveBias(fundamentalHz, frequencyData, sampleRate, fftSize, minHz, maxHz) {
  if (!Number.isFinite(fundamentalHz)) {
    return null;
  }
  const doubledHz = fundamentalHz * 2;
  if (doubledHz > maxHz) {
    return fundamentalHz;
  }
  const nearFloor = fundamentalHz <= minHz * 1.18;
  if (!nearFloor) {
    return fundamentalHz;
  }
  const baseEnergy = sampleEnergyNearHz(frequencyData, sampleRate, fftSize, fundamentalHz);
  const doubledEnergy = sampleEnergyNearHz(frequencyData, sampleRate, fftSize, doubledHz);
  if (doubledEnergy > baseEnergy * 1.45) {
    return doubledHz;
  }
  return fundamentalHz;
}

export function stabilizeSpectrumFrame(previousLevels, frame, profileLowHz, profileHighHz) {
  const priorLevels = Array.isArray(previousLevels) && previousLevels.length === WORLD.eqBandCount
    ? previousLevels
    : Array.from({ length: WORLD.eqBandCount }, () => 0);
  const stableBandLevels = frame.voiced
    ? frame.rawBandLevels.map((level, index) => {
        const previous = priorLevels[index] || 0;
        const factor = level >= previous ? 0.48 : 0.22;
        return previous + (level - previous) * factor;
      })
    : Array.from({ length: WORLD.eqBandCount }, () => 0);
  const dominantBandIndex = frame.voiced ? frame.dominantBandIndex : null;
  const dominantBandRange = Number.isInteger(dominantBandIndex)
    ? getLogBandRangeForIndex(dominantBandIndex, profileLowHz, profileHighHz, WORLD.eqBandCount)
    : null;

  return {
    ...frame,
    rawBandLevels: stableBandLevels,
    dominantBandIndex,
    dominantBandHz: dominantBandRange ? (dominantBandRange.startHz + dominantBandRange.endHz) / 2 : null,
    controlBandLevels: shapeControlLevels(stableBandLevels, dominantBandIndex)
  };
}

export function smoothBandPosition(previousPosition, nextIndex, voiced) {
  if (!voiced || !Number.isInteger(nextIndex)) {
    return Number.isFinite(previousPosition) ? previousPosition : null;
  }
  if (!Number.isFinite(previousPosition)) {
    return nextIndex;
  }
  const delta = clamp(nextIndex - previousPosition, -1.25, 1.25);
  const stepped = previousPosition + delta;
  if (Math.abs(nextIndex - previousPosition) <= 1) {
    return nextIndex;
  }
  return clamp(stepped, 0, WORLD.eqBandCount - 1);
}

export function updateSpectrumProfile(currentProfile, dominantHz, now, { voiced, canAdapt, expandOnly = false }) {
  const existingSamples = Array.isArray(currentProfile.samples) ? currentProfile.samples : [];
  const nextSamples = voiced && canAdapt && Number.isFinite(dominantHz)
    ? [...existingSamples, { hz: dominantHz, t: now }]
    : [...existingSamples];
  const cutoff = now - 2000;
  const recentSamples = nextSamples.filter((sample) => sample.t > cutoff);
  const sampleHz = recentSamples.map((sample) => sample.hz);

  if (sampleHz.length < 3) {
    return {
      ...currentProfile,
      samples: recentSamples
    };
  }

  const qLow = quantile(sampleHz, AUDIO.profileQuantileLow);
  const qHigh = quantile(sampleHz, AUDIO.profileQuantileHigh);
  const pad = Math.max(24, (qHigh - qLow) * AUDIO.profilePadRatio);
  const limited = clampProfileRange(qLow - pad, qHigh + pad);

  if (expandOnly) {
    const currentLow = Number.isFinite(currentProfile.lowHz) ? currentProfile.lowHz : limited.lowHz;
    const currentHigh = Number.isFinite(currentProfile.highHz) ? currentProfile.highHz : limited.highHz;
    return {
      lowHz: Math.min(currentLow, limited.lowHz),
      highHz: Math.max(currentHigh, limited.highHz),
      samples: recentSamples,
      ready: true
    };
  }

  return {
    lowHz: limited.lowHz,
    highHz: limited.highHz,
    samples: recentSamples,
    ready: true
  };
}

export function computeSpectrumFrame({
  timeData,
  frequencyData,
  sampleRate,
  fftSize,
  profileLowHz,
  profileHighHz,
  amplitudeNorm,
  voicedLatch = false
}) {
  const probeEnergies = aggregateBandEnergies(
    frequencyData,
    sampleRate,
    fftSize,
    AUDIO.analysisMinHz,
    AUDIO.analysisMaxHz,
    AUDIO.analysisProbeBandCount,
    AUDIO.probeBandTiltPower
  );
  const probeTotalEnergy = probeEnergies.reduce((sum, level) => sum + level, 0);
  const probePeakEnergy = Math.max(...probeEnergies, 0);
  const probePeakIndex = probeEnergies.findIndex((level) => level === probePeakEnergy);
  const probePeakShare = probeTotalEnergy > 0 ? probePeakEnergy / probeTotalEnergy : 0;
  const dominantProbeRange = probePeakIndex >= 0
    ? getLogBandRangeForIndex(probePeakIndex, AUDIO.analysisMinHz, AUDIO.analysisMaxHz, AUDIO.analysisProbeBandCount)
    : null;
  const voicedAmplitudeFloor = voicedLatch ? AUDIO.voicedOffAmplitudeFloor : AUDIO.voicedOnAmplitudeFloor;
  const voiced = amplitudeNorm > voicedAmplitudeFloor
    && probeTotalEnergy > 0.001
    && (probePeakShare >= AUDIO.voicedBandShareFloor || amplitudeNorm >= AUDIO.voicedLoudAmplitudeFloor);
  const fundamentalLowHz = Math.max(AUDIO.minHz, profileLowHz * 0.68);
  const fundamentalHighHz = Math.min(AUDIO.maxHz, profileHighHz * 1.18);
  const rawFundamentalHz = voiced
    ? estimateFundamentalHz(timeData, sampleRate, fundamentalLowHz, fundamentalHighHz)
    : null;
  const fundamentalHz = voiced
    ? correctLowOctaveBias(rawFundamentalHz, frequencyData, sampleRate, fftSize, fundamentalLowHz, fundamentalHighHz)
    : null;

  const rawBandEnergies = voiced
    ? aggregateBandEnergies(frequencyData, sampleRate, fftSize, profileLowHz, profileHighHz, WORLD.eqBandCount, AUDIO.rawBandTiltPower)
    : Array.from({ length: WORLD.eqBandCount }, () => 0);
  const rawBandLevels = normalizeBandEnergies(rawBandEnergies);
  const dominantBandIndex = voiced
    ? (getLogBandIndexForHz(fundamentalHz, profileLowHz, profileHighHz, WORLD.eqBandCount) ?? pickDominantBandIndex(rawBandLevels))
    : null;
  const dominantBandRange = Number.isInteger(dominantBandIndex)
    ? getLogBandRangeForIndex(dominantBandIndex, profileLowHz, profileHighHz, WORLD.eqBandCount)
    : null;
  const controlBandLevels = shapeControlLevels(rawBandLevels, dominantBandIndex);

  return {
    voiced,
    peakRatio: probePeakShare,
    totalEnergy: probeTotalEnergy,
    dominantHz: fundamentalHz ?? (dominantProbeRange ? (dominantProbeRange.startHz + dominantProbeRange.endHz) / 2 : null),
    rawFundamentalHz,
    fundamentalHz,
    dominantBandIndex,
    dominantBandHz: dominantBandRange ? (dominantBandRange.startHz + dominantBandRange.endHz) / 2 : null,
    rawBandLevels,
    controlBandLevels
  };
}

export function createDefaultSpectrumProfile() {
  return {
    lowHz: AUDIO.defaultProfileLowHz,
    highHz: AUDIO.defaultProfileHighHz,
    samples: [],
    ready: false
  };
}
