import test from "node:test";
import assert from "node:assert/strict";
import { AUDIO, WORLD } from "../shared/protocol.js";
import { computeSpectrumFrame, createDefaultSpectrumProfile, smoothBandPosition, stabilizeSpectrumFrame, updateSpectrumProfile } from "../client/controller/spectrumControl.js";

function makeFrequencyData({ fftSize = 2048, sampleRate = 48000, peaks = [] }) {
  const data = new Float32Array(fftSize / 2);
  data.fill(-120);
  peaks.forEach(({ hz, db }) => {
    const bin = Math.round((hz * fftSize) / sampleRate);
    if (bin >= 0 && bin < data.length) {
      data[bin] = db;
    }
  });
  return data;
}

function makeTimeData({
  fftSize = 2048,
  sampleRate = 48000,
  components = []
}) {
  const data = new Float32Array(fftSize);
  for (let index = 0; index < fftSize; index += 1) {
    const time = index / sampleRate;
    let sample = 0;
    components.forEach(({ hz, gain = 1, phase = 0 }) => {
      sample += Math.sin((2 * Math.PI * hz * time) + phase) * gain;
    });
    data[index] = sample;
  }
  return data;
}

test("spectrum frame picks the strongest peak and shapes main + neighbor attack", () => {
  const frequencyData = makeFrequencyData({
    peaks: [
      { hz: 260, db: -26 },
      { hz: 440, db: -8 },
      { hz: 900, db: -35 }
    ]
  });

  const frame = computeSpectrumFrame({
    timeData: makeTimeData({
      components: [
        { hz: 220, gain: 1 },
        { hz: 440, gain: 0.5 }
      ]
    }),
    frequencyData,
    sampleRate: 48000,
    fftSize: 2048,
    profileLowHz: 140,
    profileHighHz: 720,
    amplitudeNorm: 0.9
  });

  assert.equal(frame.voiced, true);
  assert.ok(Number.isInteger(frame.dominantBandIndex));
  assert.equal(frame.controlBandLevels[frame.dominantBandIndex], 1);
  if (frame.dominantBandIndex > 0) {
    assert.equal(frame.controlBandLevels[frame.dominantBandIndex - 1], WORLD.eqNeighborDecay);
  }
  if (frame.dominantBandIndex < WORLD.eqBandCount - 1) {
    assert.equal(frame.controlBandLevels[frame.dominantBandIndex + 1], WORLD.eqNeighborDecay);
  }
});

test("broad voice-like harmonics still count as voiced even when no single FFT bin dominates", () => {
  const frequencyData = makeFrequencyData({
    peaks: [
      { hz: 280, db: -18 },
      { hz: 320, db: -19 },
      { hz: 360, db: -20 },
      { hz: 640, db: -24 },
      { hz: 960, db: -28 }
    ]
  });

  const frame = computeSpectrumFrame({
    timeData: makeTimeData({
      components: [
        { hz: 280, gain: 1 },
        { hz: 560, gain: 0.45 }
      ]
    }),
    frequencyData,
    sampleRate: 48000,
    fftSize: 2048,
    profileLowHz: 140,
    profileHighHz: 720,
    amplitudeNorm: 0.34
  });

  assert.equal(frame.voiced, true);
  assert.ok(Number.isInteger(frame.dominantBandIndex));
  assert.ok(frame.totalEnergy > 0);
});

test("spectrum profile uses robust voiced samples and ignores stale outliers", () => {
  let profile = createDefaultSpectrumProfile();
  profile = updateSpectrumProfile(profile, 180, 0, { voiced: true, canAdapt: true });
  profile = updateSpectrumProfile(profile, 210, 200, { voiced: true, canAdapt: true });
  profile = updateSpectrumProfile(profile, 260, 400, { voiced: true, canAdapt: true });
  profile = updateSpectrumProfile(profile, 980, 600, { voiced: true, canAdapt: true });
  profile = updateSpectrumProfile(profile, 240, 2700, { voiced: true, canAdapt: true });

  assert.ok(profile.ready);
  assert.ok(profile.highHz - profile.lowHz <= AUDIO.profileMaxSpanHz);
  assert.ok(profile.lowHz >= AUDIO.analysisMinHz);
  assert.ok(profile.highHz <= AUDIO.analysisMaxHz);
  assert.ok(profile.samples.every((sample) => sample.t > 700));
});

test("silent frames drop all control levels to zero", () => {
  const frequencyData = makeFrequencyData({ peaks: [] });
  const frame = computeSpectrumFrame({
    frequencyData,
    sampleRate: 48000,
    fftSize: 2048,
    profileLowHz: 140,
    profileHighHz: 720,
    amplitudeNorm: 0.01
  });

  assert.equal(frame.voiced, false);
  assert.deepEqual(frame.controlBandLevels, Array.from({ length: WORLD.eqBandCount }, () => 0));
});

test("moderate broad speech energy can still count as voiced at party-game amplitudes", () => {
  const frequencyData = makeFrequencyData({
    peaks: [
      { hz: 150, db: -32 },
      { hz: 190, db: -31 },
      { hz: 240, db: -30 },
      { hz: 310, db: -31 },
      { hz: 420, db: -34 }
    ]
  });
  const frame = computeSpectrumFrame({
    timeData: makeTimeData({
      components: [
        { hz: 190, gain: 1 },
        { hz: 380, gain: 0.55 }
      ]
    }),
    frequencyData,
    sampleRate: 48000,
    fftSize: 2048,
    profileLowHz: 140,
    profileHighHz: 720,
    amplitudeNorm: 0.12
  });

  assert.equal(frame.voiced, true);
  assert.ok(Number.isInteger(frame.dominantBandIndex));
});

test("voiced latch keeps adjacent frames stable during brief dips", () => {
  const frequencyData = makeFrequencyData({
    peaks: [
      { hz: 220, db: -28 },
      { hz: 260, db: -29 },
      { hz: 320, db: -32 }
    ]
  });
  const frame = computeSpectrumFrame({
    frequencyData,
    sampleRate: 48000,
    fftSize: 2048,
    profileLowHz: 140,
    profileHighHz: 720,
    amplitudeNorm: 0.03,
    voicedLatch: true
  });

  assert.equal(frame.voiced, true);
});

test("raw band tilt favors lower fundamental-like energy over a brighter overtone cluster", () => {
  const frequencyData = makeFrequencyData({
    peaks: [
      { hz: 190, db: -24 },
      { hz: 380, db: -20 },
      { hz: 570, db: -18 }
    ]
  });
  const frame = computeSpectrumFrame({
    timeData: makeTimeData({
      components: [
        { hz: 190, gain: 1 },
        { hz: 380, gain: 1.2 },
        { hz: 570, gain: 0.9 }
      ]
    }),
    frequencyData,
    sampleRate: 48000,
    fftSize: 2048,
    profileLowHz: 140,
    profileHighHz: 720,
    amplitudeNorm: 0.4
  });

  assert.ok(Number.isInteger(frame.dominantBandIndex));
  assert.ok(frame.dominantBandIndex <= 7);
});

test("fundamental estimator can place low voices into the left EQ bars", () => {
  const timeData = makeTimeData({
    components: [
      { hz: 118, gain: 1 },
      { hz: 236, gain: 0.6 },
      { hz: 354, gain: 0.35 }
    ]
  });
  const frequencyData = makeFrequencyData({
    peaks: [
      { hz: 118, db: -27 },
      { hz: 236, db: -21 },
      { hz: 354, db: -24 }
    ]
  });
  const frame = computeSpectrumFrame({
    timeData,
    frequencyData,
    sampleRate: 48000,
    fftSize: 2048,
    profileLowHz: 95,
    profileHighHz: 720,
    amplitudeNorm: 0.7
  });

  assert.equal(frame.voiced, true);
  assert.ok(frame.fundamentalHz >= 105 && frame.fundamentalHz <= 130);
  assert.ok(Number.isInteger(frame.dominantBandIndex));
  assert.ok(frame.dominantBandIndex <= 2);
});

test("low-octave correction can lift a floor-clamped estimate when the second harmonic dominates", () => {
  const timeData = makeTimeData({
    components: [
      { hz: 95, gain: 0.5 },
      { hz: 190, gain: 1 },
      { hz: 285, gain: 0.45 }
    ]
  });
  const frequencyData = makeFrequencyData({
    peaks: [
      { hz: 95, db: -34 },
      { hz: 190, db: -20 },
      { hz: 285, db: -26 }
    ]
  });
  const frame = computeSpectrumFrame({
    timeData,
    frequencyData,
    sampleRate: 48000,
    fftSize: 2048,
    profileLowHz: 95,
    profileHighHz: 325,
    amplitudeNorm: 0.85
  });

  assert.ok(Number.isFinite(frame.rawFundamentalHz));
  assert.ok(Number.isFinite(frame.fundamentalHz));
  assert.ok(frame.fundamentalHz >= frame.rawFundamentalHz);
  assert.ok(frame.fundamentalHz >= 150);
});

test("stabilized frame favors the energy centroid instead of jumping to a lone overtone band", () => {
  const frequencyData = makeFrequencyData({
    peaks: [
      { hz: 150, db: -18 },
      { hz: 210, db: -20 },
      { hz: 315, db: -19 },
      { hz: 450, db: -26 }
    ]
  });
  const frame = computeSpectrumFrame({
    frequencyData,
    sampleRate: 48000,
    fftSize: 2048,
    profileLowHz: 140,
    profileHighHz: 720,
    amplitudeNorm: 0.42
  });
  const stabilized = stabilizeSpectrumFrame(
    Array.from({ length: WORLD.eqBandCount }, () => 0),
    frame,
    140,
    720
  );

  assert.equal(stabilized.voiced, true);
  assert.ok(Number.isInteger(stabilized.dominantBandIndex));
  assert.ok(stabilized.dominantBandIndex >= 1);
  assert.ok(stabilized.dominantBandIndex <= 6);
});

test("band smoothing limits sudden leaps across distant EQ bars", () => {
  const smoothed = smoothBandPosition(1, 11, true);
  assert.ok(smoothed > 1);
  assert.ok(smoothed < 3);
  assert.equal(smoothBandPosition(smoothed, 2, true), 2);
});
