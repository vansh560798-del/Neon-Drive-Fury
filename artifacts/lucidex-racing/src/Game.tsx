import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  Suspense,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  EffectComposer,
  Bloom,
  Vignette,
} from "@react-three/postprocessing";
import * as THREE from "three";

/* ============================================================
   LUCIDEX RACING — single-file cyberpunk arcade racer
   Built with React Three Fiber + Three.js
   ============================================================ */

// ---------- Constants ----------
const ROAD_HALF_WIDTH = 7; // playable width on each side of center
const LANE_X = [-4.5, -1.5, 1.5, 4.5]; // 4 lanes
const SEGMENT_LEN = 40; // length of each road / scenery segment
const NUM_SEGMENTS = 12; // recycled forward
const BUILDING_RECYCLE = 220; // distance behind camera before recycling
const TRAFFIC_RECYCLE = 240;
const MAX_TRAFFIC = 5;
const TRAFFIC_SPAWN_INTERVAL = 1.8; // seconds between spawn attempts

const BASE_SPEED = 38; // m/s minimum forward speed
const MAX_SPEED = 95; // m/s without nitro
const NITRO_MAX_SPEED = 140; // m/s with nitro
const ACCEL = 14; // accel toward target speed
const DRIFT_DECAY = 28; // decel during drift
const STEER_SPEED = 9; // sideways m/s when steering at full
const DRIFT_STEER_BOOST = 1.7;
const NITRO_DRAIN = 28; // % per second
const NITRO_REGEN = 14; // % per second (when not boosting)

type GameState = "menu" | "playing" | "crashed";
type GameMode = "easy" | "medium" | "hard" | "drift";

interface ModeConfig {
  label: string;
  color: string;
  speedMul: number;       // multiplier on MAX_SPEED / NITRO_MAX_SPEED
  baseSpeedMul: number;   // multiplier on BASE_SPEED
  spawnInterval: number;  // seconds between traffic spawn attempts
  trafficSpeedMul: number;
  nitroDrain: number;
  nitroRegen: number;
  driftBoosts: boolean;   // drift adds to nitro
  driftScoring: boolean;  // track + display drift score
}

const MODE_CONFIGS: Record<GameMode, ModeConfig> = {
  easy: {
    label: "EASY",
    color: "#7fff9e",
    speedMul: 0.85,
    baseSpeedMul: 0.95,
    spawnInterval: 2.6,
    trafficSpeedMul: 0.8,
    nitroDrain: 18,
    nitroRegen: 22,
    driftBoosts: false,
    driftScoring: false,
  },
  medium: {
    label: "MEDIUM",
    color: "#00f6ff",
    speedMul: 1.0,
    baseSpeedMul: 1.0,
    spawnInterval: 1.8,
    trafficSpeedMul: 1.0,
    nitroDrain: 28,
    nitroRegen: 14,
    driftBoosts: false,
    driftScoring: false,
  },
  hard: {
    label: "HARD",
    color: "#ff5577",
    speedMul: 1.18,
    baseSpeedMul: 1.1,
    spawnInterval: 1.0,
    trafficSpeedMul: 1.2,
    nitroDrain: 36,
    nitroRegen: 10,
    driftBoosts: false,
    driftScoring: false,
  },
  drift: {
    label: "DRIFT",
    color: "#ff2bd1",
    speedMul: 1.0,
    baseSpeedMul: 1.0,
    spawnInterval: 1.6,
    trafficSpeedMul: 0.9,
    nitroDrain: 22,
    nitroRegen: 0,
    driftBoosts: true,
    driftScoring: true,
  },
};

interface InputState {
  steer: number; // -1 (left) to 1 (right)
  drift: boolean;
  nitro: boolean;
}

// ---------- Car catalog ----------
// Each car is a visual + light stat differentiator.
// speedMul affects top/nitro speed (subtle: 0.94..1.10)
// accelMul affects acceleration ramp (0.9..1.15)
// gripMul affects steering responsiveness (0.92..1.15)
interface Car {
  id: string;
  name: string;
  body: string; // main chassis color
  trim: string; // hood/spoiler accent (also rear bumper diffuser tint)
  neon: string; // side strips + spoiler ridge
  canopy: string; // canopy emissive
  flameA: string; // primary nitro flame
  flameB: string; // secondary nitro flame
  underglow: string;
  rim: string; // wheel rim color
  speedMul: number;
  accelMul: number;
  gripMul: number;
}

const CARS: Car[] = [
  {
    id: "vortex",
    name: "Vortex",
    body: "#0a0a18",
    trim: "#161028",
    neon: "#ff2bd1",
    canopy: "#00f6ff",
    flameA: "#00f6ff",
    flameB: "#ff2bd1",
    underglow: "#ff2bd1",
    rim: "#0a0a10",
    speedMul: 1.0,
    accelMul: 1.0,
    gripMul: 1.0,
  },
  {
    id: "phantom",
    name: "Phantom",
    body: "#1a0030",
    trim: "#2a0050",
    neon: "#a855f7",
    canopy: "#c084fc",
    flameA: "#a855f7",
    flameB: "#7c3aed",
    underglow: "#a855f7",
    rim: "#150022",
    speedMul: 1.04,
    accelMul: 0.98,
    gripMul: 1.02,
  },
  {
    id: "blaze",
    name: "Blaze",
    body: "#2a0808",
    trim: "#400000",
    neon: "#ff5722",
    canopy: "#ff9248",
    flameA: "#ff7a00",
    flameB: "#ffd400",
    underglow: "#ff5722",
    rim: "#200505",
    speedMul: 1.08,
    accelMul: 1.05,
    gripMul: 0.94,
  },
  {
    id: "frost",
    name: "Frost",
    body: "#0a1a2a",
    trim: "#102540",
    neon: "#7ff7ff",
    canopy: "#bdf3ff",
    flameA: "#7ff7ff",
    flameB: "#ffffff",
    underglow: "#7ff7ff",
    rim: "#08111e",
    speedMul: 0.98,
    accelMul: 1.10,
    gripMul: 1.08,
  },
  {
    id: "viper",
    name: "Viper",
    body: "#02180a",
    trim: "#063018",
    neon: "#39ff14",
    canopy: "#9eff7a",
    flameA: "#39ff14",
    flameB: "#7ff7ff",
    underglow: "#39ff14",
    rim: "#021008",
    speedMul: 1.02,
    accelMul: 1.06,
    gripMul: 1.04,
  },
  {
    id: "solaris",
    name: "Solaris",
    body: "#2a1c00",
    trim: "#3a2a00",
    neon: "#ffe600",
    canopy: "#ffec5a",
    flameA: "#ffe600",
    flameB: "#ff7a00",
    underglow: "#ffe600",
    rim: "#1c1300",
    speedMul: 1.06,
    accelMul: 1.08,
    gripMul: 0.96,
  },
  {
    id: "spectre",
    name: "Spectre",
    body: "#080814",
    trim: "#16162a",
    neon: "#ffffff",
    canopy: "#dde7ff",
    flameA: "#ffffff",
    flameB: "#7ff7ff",
    underglow: "#dde7ff",
    rim: "#06060e",
    speedMul: 1.10,
    accelMul: 0.94,
    gripMul: 1.02,
  },
  {
    id: "rogue",
    name: "Rogue",
    body: "#150010",
    trim: "#28001f",
    neon: "#ff007a",
    canopy: "#ff5ab8",
    flameA: "#ff007a",
    flameB: "#a855f7",
    underglow: "#ff007a",
    rim: "#10000a",
    speedMul: 1.05,
    accelMul: 1.02,
    gripMul: 1.00,
  },
  {
    id: "tempest",
    name: "Tempest",
    body: "#001020",
    trim: "#001a35",
    neon: "#3b82f6",
    canopy: "#7fb6ff",
    flameA: "#3b82f6",
    flameB: "#7ff7ff",
    underglow: "#3b82f6",
    rim: "#000a14",
    speedMul: 1.03,
    accelMul: 1.04,
    gripMul: 1.06,
  },
  {
    id: "halo",
    name: "Halo",
    body: "#180018",
    trim: "#2a002a",
    neon: "#f0abfc",
    canopy: "#f8d4ff",
    flameA: "#f0abfc",
    flameB: "#ffffff",
    underglow: "#f0abfc",
    rim: "#100010",
    speedMul: 0.96,
    accelMul: 1.12,
    gripMul: 1.10,
  },
  {
    id: "onyx",
    name: "Onyx",
    body: "#000000",
    trim: "#0a0a0a",
    neon: "#22d3ee",
    canopy: "#67e8f9",
    flameA: "#22d3ee",
    flameB: "#0ea5e9",
    underglow: "#22d3ee",
    rim: "#000000",
    speedMul: 1.07,
    accelMul: 1.00,
    gripMul: 1.05,
  },
  {
    id: "carbon",
    name: "Carbon",
    body: "#101010",
    trim: "#1a1a1a",
    neon: "#ff003c",
    canopy: "#ff5577",
    flameA: "#ff003c",
    flameB: "#ff7a00",
    underglow: "#ff003c",
    rim: "#0a0a0a",
    speedMul: 1.10,
    accelMul: 1.05,
    gripMul: 0.92,
  },
  {
    id: "mirage",
    name: "Mirage",
    body: "#0a2818",
    trim: "#103828",
    neon: "#10b981",
    canopy: "#5ef0b8",
    flameA: "#10b981",
    flameB: "#7ff7ff",
    underglow: "#10b981",
    rim: "#061a10",
    speedMul: 1.00,
    accelMul: 1.08,
    gripMul: 1.08,
  },
  {
    id: "neon",
    name: "Neon",
    body: "#180a28",
    trim: "#26104a",
    neon: "#e879f9",
    canopy: "#f0abfc",
    flameA: "#e879f9",
    flameB: "#22d3ee",
    underglow: "#e879f9",
    rim: "#100620",
    speedMul: 1.02,
    accelMul: 1.06,
    gripMul: 1.04,
  },
  {
    id: "pulse",
    name: "Pulse",
    body: "#1a1a00",
    trim: "#2a2800",
    neon: "#facc15",
    canopy: "#fde68a",
    flameA: "#facc15",
    flameB: "#ff5722",
    underglow: "#facc15",
    rim: "#101000",
    speedMul: 1.04,
    accelMul: 1.10,
    gripMul: 0.98,
  },
];

const CARS_BY_ID: Record<string, Car> = Object.fromEntries(
  CARS.map((c) => [c.id, c]),
);

interface SharedRefs {
  input: React.MutableRefObject<InputState>;
  speedRef: React.MutableRefObject<number>;
  distanceRef: React.MutableRefObject<number>;
  nitroRef: React.MutableRefObject<number>;
  driftAngleRef: React.MutableRefObject<number>;
  carXRef: React.MutableRefObject<number>;
  crashedRef: React.MutableRefObject<boolean>;
  modeRef: React.MutableRefObject<ModeConfig>;
  carRef: React.MutableRefObject<Car>;
  driftScoreRef: React.MutableRefObject<number>;
  // Power-up state
  shieldRef: React.MutableRefObject<number>; // # of shield charges
  multiplierTimerRef: React.MutableRefObject<number>; // seconds remaining of 2x
  comboRef: React.MutableRefObject<number>; // current near-miss combo count
  comboTimerRef: React.MutableRefObject<number>; // seconds since last near miss
  comboPulseRef: React.MutableRefObject<number>; // 0..1, decays — used for HUD flash
  pickupTakenRef: React.MutableRefObject<{ kind: PickupKind | null; pulse: number }>;
  onCrash: () => void;
  onPickup: (kind: PickupKind) => void;
  onNearMiss: (combo: number) => void;
  onShieldAbsorb: () => void;
}

// ---------- Audio system (synthesized, no external files) ----------
// Builds a single AudioContext with layered engine, wind, drift screech,
// nitro whoosh, crash boom, and UI click sounds.

interface AudioApi {
  resume: () => void;
  setEngine: (speed: number, boosting: boolean, drifting: boolean) => void;
  setEngineActive: (on: boolean) => void;
  triggerNitro: () => void;
  triggerCrash: () => void;
  triggerClick: () => void;
  triggerStart: () => void;
  triggerPickup: (kind: PickupKind) => void;
  triggerNearMiss: (combo: number) => void;
  triggerShield: () => void;
  setMuted: (m: boolean) => void;
  isMuted: () => boolean;
}

type PickupKind = "nitro" | "multiplier" | "shield";

function buildWhiteNoiseBuffer(ctx: AudioContext, seconds = 2) {
  const sampleRate = ctx.sampleRate;
  const length = sampleRate * seconds;
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function createAudio(): AudioApi {
  const AC =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  const ctx = new AC();
  const master = ctx.createGain();
  master.gain.value = 0.85;
  master.connect(ctx.destination);

  let muted = false;

  // ---- Engine: 4 layered oscillators + LFO modulation ----
  const engineGain = ctx.createGain();
  engineGain.gain.value = 0;
  // Lowpass to keep it warm
  const engineFilter = ctx.createBiquadFilter();
  engineFilter.type = "lowpass";
  engineFilter.frequency.value = 1800;
  engineFilter.Q.value = 0.6;
  engineGain.connect(engineFilter);
  engineFilter.connect(master);

  const oscSub = ctx.createOscillator();
  oscSub.type = "sawtooth";
  oscSub.frequency.value = 45;
  const subGain = ctx.createGain();
  subGain.gain.value = 0.55;
  oscSub.connect(subGain);
  subGain.connect(engineGain);
  oscSub.start();

  const oscMain = ctx.createOscillator();
  oscMain.type = "sawtooth";
  oscMain.frequency.value = 90;
  const mainGain = ctx.createGain();
  mainGain.gain.value = 0.5;
  oscMain.connect(mainGain);
  mainGain.connect(engineGain);
  oscMain.start();

  const oscHigh = ctx.createOscillator();
  oscHigh.type = "square";
  oscHigh.frequency.value = 180;
  const highGain = ctx.createGain();
  highGain.gain.value = 0.18;
  oscHigh.connect(highGain);
  highGain.connect(engineGain);
  oscHigh.start();

  const oscRoar = ctx.createOscillator();
  oscRoar.type = "triangle";
  oscRoar.frequency.value = 60;
  const roarGain = ctx.createGain();
  roarGain.gain.value = 0.35;
  oscRoar.connect(roarGain);
  roarGain.connect(engineGain);
  oscRoar.start();

  // LFO that modulates main osc frequency for revvy grit
  const lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = 18;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 6;
  lfo.connect(lfoGain);
  lfoGain.connect(oscMain.frequency);
  lfo.start();

  // ---- Engine grit: bandpassed noise mixed in ----
  const noiseBuffer = buildWhiteNoiseBuffer(ctx, 3);
  const engineNoise = ctx.createBufferSource();
  engineNoise.buffer = noiseBuffer;
  engineNoise.loop = true;
  const engineNoiseFilter = ctx.createBiquadFilter();
  engineNoiseFilter.type = "bandpass";
  engineNoiseFilter.frequency.value = 350;
  engineNoiseFilter.Q.value = 1.4;
  const engineNoiseGain = ctx.createGain();
  engineNoiseGain.gain.value = 0.0;
  engineNoise.connect(engineNoiseFilter);
  engineNoiseFilter.connect(engineNoiseGain);
  engineNoiseGain.connect(engineGain);
  engineNoise.start();

  // ---- Wind whoosh: speed-driven filtered noise ----
  const windSrc = ctx.createBufferSource();
  windSrc.buffer = noiseBuffer;
  windSrc.loop = true;
  const windFilter = ctx.createBiquadFilter();
  windFilter.type = "lowpass";
  windFilter.frequency.value = 600;
  windFilter.Q.value = 0.4;
  const windGain = ctx.createGain();
  windGain.gain.value = 0.0;
  windSrc.connect(windFilter);
  windFilter.connect(windGain);
  windGain.connect(master);
  windSrc.start();

  // ---- Drift screech: bandpass noise w/ resonance ----
  const driftSrc = ctx.createBufferSource();
  driftSrc.buffer = noiseBuffer;
  driftSrc.loop = true;
  const driftFilter = ctx.createBiquadFilter();
  driftFilter.type = "bandpass";
  driftFilter.frequency.value = 2400;
  driftFilter.Q.value = 8;
  const driftGain = ctx.createGain();
  driftGain.gain.value = 0.0;
  driftSrc.connect(driftFilter);
  driftFilter.connect(driftGain);
  driftGain.connect(master);
  driftSrc.start();

  let active = false;

  const setEngineActive = (on: boolean) => {
    active = on;
    if (!on) {
      const t = ctx.currentTime;
      engineGain.gain.setTargetAtTime(0, t, 0.1);
      windGain.gain.setTargetAtTime(0, t, 0.1);
      driftGain.gain.setTargetAtTime(0, t, 0.05);
    }
  };

  const setEngine = (speed: number, boosting: boolean, drifting: boolean) => {
    if (!active || muted) return;
    const t = Math.min(1, Math.max(0, speed / NITRO_MAX_SPEED));
    const baseFreq = 65 + t * 360 + (boosting ? 60 : 0);
    const time = ctx.currentTime;
    oscMain.frequency.setTargetAtTime(baseFreq, time, 0.05);
    oscHigh.frequency.setTargetAtTime(baseFreq * 2, time, 0.05);
    oscSub.frequency.setTargetAtTime(baseFreq * 0.5, time, 0.05);
    oscRoar.frequency.setTargetAtTime(baseFreq * 0.75, time, 0.08);
    engineNoiseFilter.frequency.setTargetAtTime(
      300 + t * 1400,
      time,
      0.08,
    );
    engineNoiseGain.gain.setTargetAtTime(
      0.04 + t * 0.08 + (boosting ? 0.04 : 0),
      time,
      0.1,
    );
    engineFilter.frequency.setTargetAtTime(
      900 + t * 2400 + (boosting ? 800 : 0),
      time,
      0.08,
    );
    lfo.frequency.setTargetAtTime(14 + t * 26, time, 0.1);
    engineGain.gain.setTargetAtTime(
      0.18 + t * 0.18 + (boosting ? 0.05 : 0),
      time,
      0.1,
    );
    // Wind scales harder with speed
    windFilter.frequency.setTargetAtTime(400 + t * 3200, time, 0.1);
    windGain.gain.setTargetAtTime(0.04 + t * 0.18, time, 0.12);
    // Drift screech only when drifting
    driftGain.gain.setTargetAtTime(drifting ? 0.18 : 0, time, drifting ? 0.04 : 0.08);
    driftFilter.frequency.setTargetAtTime(
      2200 + (drifting ? Math.random() * 600 : 0),
      time,
      0.05,
    );
  };

  const triggerNitro = () => {
    if (muted) return;
    const t = ctx.currentTime;
    // Whoosh: filtered noise burst
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const filt = ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.frequency.setValueAtTime(200, t);
    filt.frequency.exponentialRampToValueAtTime(4000, t + 0.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    src.connect(filt);
    filt.connect(g);
    g.connect(master);
    src.start(t);
    src.stop(t + 0.75);

    // Bass thump
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.4);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(0.6, t + 0.03);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    o.connect(og);
    og.connect(master);
    o.start(t);
    o.stop(t + 0.55);
  };

  const triggerCrash = () => {
    if (muted) return;
    const t = ctx.currentTime;
    // Big noise burst
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const filt = ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.frequency.setValueAtTime(2200, t);
    filt.frequency.exponentialRampToValueAtTime(180, t + 0.9);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.85, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    src.connect(filt);
    filt.connect(g);
    g.connect(master);
    src.start(t);
    src.stop(t + 1.5);

    // Sub rumble
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(80, t);
    sub.frequency.exponentialRampToValueAtTime(35, t + 1.2);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0, t);
    sg.gain.linearRampToValueAtTime(0.7, t + 0.04);
    sg.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    sub.connect(sg);
    sg.connect(master);
    sub.start(t);
    sub.stop(t + 1.5);

    // Metallic clang (bandpass noise, short)
    const clang = ctx.createBufferSource();
    clang.buffer = noiseBuffer;
    const cFilt = ctx.createBiquadFilter();
    cFilt.type = "bandpass";
    cFilt.frequency.value = 3200;
    cFilt.Q.value = 6;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0, t);
    cg.gain.linearRampToValueAtTime(0.5, t + 0.005);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    clang.connect(cFilt);
    cFilt.connect(cg);
    cg.connect(master);
    clang.start(t);
    clang.stop(t + 0.4);
  };

  const triggerClick = () => {
    if (muted) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "square";
    o.frequency.setValueAtTime(880, t);
    o.frequency.exponentialRampToValueAtTime(1320, t + 0.07);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.18, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + 0.15);
  };

  const triggerStart = () => {
    if (muted) return;
    const t = ctx.currentTime;
    // Rising synth chord — three tones
    [440, 660, 880].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.setValueAtTime(f, t + i * 0.06);
      o.frequency.exponentialRampToValueAtTime(f * 1.5, t + 0.5 + i * 0.06);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + i * 0.06);
      g.gain.linearRampToValueAtTime(0.14, t + 0.05 + i * 0.06);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.7 + i * 0.06);
      const f1 = ctx.createBiquadFilter();
      f1.type = "lowpass";
      f1.frequency.value = 1800;
      o.connect(f1);
      f1.connect(g);
      g.connect(master);
      o.start(t + i * 0.06);
      o.stop(t + 0.8 + i * 0.06);
    });
    // Engine ignition rev
    const rev = ctx.createOscillator();
    rev.type = "sawtooth";
    rev.frequency.setValueAtTime(60, t);
    rev.frequency.exponentialRampToValueAtTime(280, t + 0.6);
    rev.frequency.exponentialRampToValueAtTime(120, t + 1.1);
    const rg = ctx.createGain();
    rg.gain.setValueAtTime(0, t);
    rg.gain.linearRampToValueAtTime(0.3, t + 0.05);
    rg.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
    rev.connect(rg);
    rg.connect(master);
    rev.start(t);
    rev.stop(t + 1.25);
  };

  const triggerPickup = (kind: PickupKind) => {
    if (muted) return;
    const t = ctx.currentTime;
    // Tonal arpeggio per pickup kind for clear feedback
    const palette: Record<PickupKind, number[]> = {
      nitro: [880, 1175, 1568],     // bright cyan-feel: A5, D6, G6
      multiplier: [988, 1244, 1865], // yellow zing: B5, D#6, A#6
      shield: [659, 880, 1108],     // warm pink: E5, A5, C#6
    };
    const notes = palette[kind];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.setValueAtTime(f, t + i * 0.045);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + i * 0.045);
      g.gain.linearRampToValueAtTime(0.22, t + i * 0.045 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.045 + 0.32);
      const flt = ctx.createBiquadFilter();
      flt.type = "lowpass";
      flt.frequency.value = 4800;
      o.connect(flt);
      flt.connect(g);
      g.connect(master);
      o.start(t + i * 0.045);
      o.stop(t + i * 0.045 + 0.36);
    });
    // Soft sparkle: quick filtered noise
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer;
    const nf = ctx.createBiquadFilter();
    nf.type = "highpass";
    nf.frequency.value = 3200;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(0.18, t + 0.02);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    n.connect(nf);
    nf.connect(ng);
    ng.connect(master);
    n.start(t);
    n.stop(t + 0.3);
  };

  const triggerNearMiss = (combo: number) => {
    if (muted) return;
    const t = ctx.currentTime;
    // Whoosh that gets a touch brighter as combo climbs
    const c = Math.min(10, Math.max(1, combo));
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const flt = ctx.createBiquadFilter();
    flt.type = "bandpass";
    flt.frequency.setValueAtTime(900 + c * 120, t);
    flt.frequency.exponentialRampToValueAtTime(2200 + c * 200, t + 0.18);
    flt.Q.value = 5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.22, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    src.connect(flt);
    flt.connect(g);
    g.connect(master);
    src.start(t);
    src.stop(t + 0.3);
    // Tiny "tick" tone that rises with combo
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(660 + c * 50, t);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(0.1, t + 0.01);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    o.connect(og);
    og.connect(master);
    o.start(t);
    o.stop(t + 0.2);
  };

  const triggerShield = () => {
    if (muted) return;
    const t = ctx.currentTime;
    // Glassy descending shimmer for shield absorbing a hit
    [1760, 1320, 990].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(f, t + i * 0.04);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + i * 0.04);
      g.gain.linearRampToValueAtTime(0.28, t + i * 0.04 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.04 + 0.55);
      o.connect(g);
      g.connect(master);
      o.start(t + i * 0.04);
      o.stop(t + i * 0.04 + 0.6);
    });
    // Bright noise burst
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer;
    const nf = ctx.createBiquadFilter();
    nf.type = "bandpass";
    nf.frequency.value = 2400;
    nf.Q.value = 2;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(0.32, t + 0.01);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    n.connect(nf);
    nf.connect(ng);
    ng.connect(master);
    n.start(t);
    n.stop(t + 0.55);
  };

  const resume = () => {
    if (ctx.state === "suspended") void ctx.resume();
  };

  const setMuted = (m: boolean) => {
    muted = m;
    master.gain.setTargetAtTime(m ? 0 : 0.85, ctx.currentTime, 0.05);
  };
  const isMuted = () => muted;

  return {
    resume,
    setEngine,
    setEngineActive,
    triggerNitro,
    triggerCrash,
    triggerClick,
    triggerStart,
    triggerPickup,
    triggerNearMiss,
    triggerShield,
    setMuted,
    isMuted,
  };
}

function useAudioApi(): React.MutableRefObject<AudioApi | null> {
  const apiRef = useRef<AudioApi | null>(null);
  useEffect(() => {
    apiRef.current = createAudio();
    // Restore mute preference
    try {
      const m = localStorage.getItem("lucidex.muted");
      if (m === "1") apiRef.current.setMuted(true);
    } catch {
      /* noop */
    }
    // Resume context on first user gesture
    const onGesture = () => apiRef.current?.resume();
    window.addEventListener("pointerdown", onGesture, { passive: true });
    window.addEventListener("keydown", onGesture);
    window.addEventListener("touchstart", onGesture, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
      window.removeEventListener("touchstart", onGesture);
    };
  }, []);
  return apiRef;
}

// Live engine sync — runs every frame
function useEngineSync(
  audioRef: React.MutableRefObject<AudioApi | null>,
  speedRef: React.MutableRefObject<number>,
  inputRef: React.MutableRefObject<InputState>,
  active: boolean,
) {
  useEffect(() => {
    if (!audioRef.current) return;
    audioRef.current.setEngineActive(active);
  }, [active, audioRef]);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const api = audioRef.current;
      if (api && active) {
        const boosting =
          inputRef.current.nitro && speedRef.current > BASE_SPEED + 5;
        api.setEngine(speedRef.current, boosting, inputRef.current.drift);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, audioRef, speedRef, inputRef]);
}

// ---------- Player Car (primitives, cyberpunk styled) ----------
const PlayerCar = ({ refs, car }: { refs: SharedRefs; car: Car }) => {
  const groupRef = useRef<THREE.Group>(null);
  const wheelsRef = useRef<THREE.Mesh[]>([]);
  const flame1Ref = useRef<THREE.Mesh>(null);
  const flame2Ref = useRef<THREE.Mesh>(null);
  const underglowRef = useRef<THREE.PointLight>(null);

  useFrame((_, dt) => {
    const g = groupRef.current;
    if (!g) return;

    const speed = refs.speedRef.current;
    const x = refs.carXRef.current;
    const driftAngle = refs.driftAngleRef.current;

    g.position.x = x;
    g.position.z = 0;
    g.rotation.y = driftAngle;
    // small body tilt while steering / drifting
    const targetRoll = -driftAngle * 0.4 - refs.input.current.steer * 0.08;
    g.rotation.z = THREE.MathUtils.lerp(g.rotation.z, targetRoll, 0.12);
    const targetPitch = -Math.min(0.06, Math.max(-0.04, (speed - BASE_SPEED) / 1500));
    g.rotation.x = THREE.MathUtils.lerp(g.rotation.x, targetPitch, 0.12);

    // wheels spin
    const wheelSpeed = speed * 0.25;
    wheelsRef.current.forEach((w) => {
      if (w) w.rotation.x -= wheelSpeed * dt;
    });

    // nitro flame visible when boosting
    const boosting = refs.input.current.nitro && refs.nitroRef.current > 0;
    const targetFlame = boosting ? 1 : 0;
    [flame1Ref.current, flame2Ref.current].forEach((m) => {
      if (!m) return;
      const s = THREE.MathUtils.lerp(m.scale.z, targetFlame, 0.25);
      m.scale.set(0.7 + s * 0.6, 0.7 + s * 0.6, 0.6 + s * 1.8);
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.opacity = s;
    });

    if (underglowRef.current) {
      underglowRef.current.intensity = 1.6 + (boosting ? 2.2 : 0);
    }
  });

  return (
    <group ref={groupRef} position={[0, 0.5, 0]}>
      {/* Underglow */}
      <pointLight
        ref={underglowRef}
        color={car.underglow}
        intensity={1.6}
        distance={6}
        position={[0, -0.3, 0]}
      />

      {/* Main body — sleek wedge */}
      <mesh castShadow position={[0, 0.45, 0]}>
        <boxGeometry args={[1.7, 0.45, 3.6]} />
        <meshStandardMaterial
          color={car.body}
          metalness={0.9}
          roughness={0.18}
          emissive={car.trim}
          emissiveIntensity={0.5}
        />
      </mesh>
      {/* Hood slope */}
      <mesh position={[0, 0.62, 0.95]} rotation={[-0.18, 0, 0]}>
        <boxGeometry args={[1.55, 0.1, 1.6]} />
        <meshStandardMaterial
          color={car.body}
          metalness={0.9}
          roughness={0.2}
        />
      </mesh>
      {/* Cockpit canopy */}
      <mesh position={[0, 0.95, -0.05]}>
        <boxGeometry args={[1.35, 0.45, 1.6]} />
        <meshStandardMaterial
          color={"#040810"}
          metalness={0.6}
          roughness={0.05}
          envMapIntensity={1}
          emissive={car.canopy}
          emissiveIntensity={0.18}
        />
      </mesh>
      {/* Roof spoiler ridge */}
      <mesh position={[0, 1.18, -0.3]}>
        <boxGeometry args={[0.18, 0.05, 1.2]} />
        <meshStandardMaterial
          color={car.canopy}
          emissive={car.canopy}
          emissiveIntensity={2.4}
        />
      </mesh>
      {/* Side neon strips */}
      {[-0.86, 0.86].map((x) => (
        <mesh key={x} position={[x, 0.45, 0]}>
          <boxGeometry args={[0.04, 0.06, 3.4]} />
          <meshStandardMaterial
            color={car.neon}
            emissive={car.neon}
            emissiveIntensity={3}
          />
        </mesh>
      ))}
      {/* Front headlights */}
      {[-0.55, 0.55].map((x) => (
        <mesh key={`hl-${x}`} position={[x, 0.55, 1.82]}>
          <boxGeometry args={[0.35, 0.1, 0.05]} />
          <meshStandardMaterial
            color={"#ffffff"}
            emissive={"#cfeaff"}
            emissiveIntensity={4}
          />
        </mesh>
      ))}
      <spotLight
        color={"#cfeaff"}
        position={[0, 0.7, 1.85]}
        target-position={[0, 0, 30]}
        angle={0.5}
        penumbra={0.6}
        intensity={3}
        distance={45}
      />
      {/* Rear lights */}
      {[-0.6, 0.6].map((x) => (
        <mesh key={`rl-${x}`} position={[x, 0.55, -1.82]}>
          <boxGeometry args={[0.45, 0.08, 0.06]} />
          <meshStandardMaterial
            color={"#ff003c"}
            emissive={"#ff003c"}
            emissiveIntensity={3.5}
          />
        </mesh>
      ))}
      {/* Rear bumper diffuser */}
      <mesh position={[0, 0.25, -1.85]}>
        <boxGeometry args={[1.5, 0.15, 0.1]} />
        <meshStandardMaterial color={car.trim} metalness={0.9} roughness={0.4} />
      </mesh>
      {/* Wheels */}
      {[
        [-0.85, 0.32, 1.1],
        [0.85, 0.32, 1.1],
        [-0.85, 0.32, -1.2],
        [0.85, 0.32, -1.2],
      ].map(([x, y, z], i) => (
        <mesh
          key={i}
          ref={(m) => {
            if (m) wheelsRef.current[i] = m;
          }}
          position={[x as number, y as number, z as number]}
          rotation={[0, 0, Math.PI / 2]}
          castShadow
        >
          <cylinderGeometry args={[0.32, 0.32, 0.28, 22]} />
          <meshStandardMaterial color={car.rim} metalness={0.4} roughness={0.6} />
        </mesh>
      ))}
      {/* Nitro flames */}
      <mesh ref={flame1Ref} position={[-0.4, 0.42, -2.05]} scale={[0.7, 0.7, 0.6]}>
        <coneGeometry args={[0.18, 1.2, 16]} />
        <meshBasicMaterial
          color={car.flameA}
          transparent
          opacity={0}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      <mesh ref={flame2Ref} position={[0.4, 0.42, -2.05]} scale={[0.7, 0.7, 0.6]}>
        <coneGeometry args={[0.18, 1.2, 16]} />
        <meshBasicMaterial
          color={car.flameB}
          transparent
          opacity={0}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
};

// ---------- Road (recycled segments) ----------
const Road = ({ refs }: { refs: SharedRefs }) => {
  const segGroup = useRef<THREE.Group>(null);
  const dashGroup = useRef<THREE.Group>(null);
  const NUM_DASHES = 80;

  // Shared materials
  const asphaltMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: "#070710",
        roughness: 0.95,
        metalness: 0.1,
      }),
    [],
  );
  const curbMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: "#00f6ff",
        emissive: "#00f6ff",
        emissiveIntensity: 1.8,
      }),
    [],
  );
  const dashMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: "#ffffff",
        emissive: "#ffd6ff",
        emissiveIntensity: 1.2,
      }),
    [],
  );

  const segments = useMemo(
    () =>
      Array.from({ length: NUM_SEGMENTS }, (_, i) => ({
        z: i * SEGMENT_LEN - 80,
      })),
    [],
  );

  const dashes = useMemo(
    () =>
      Array.from({ length: NUM_DASHES }, (_, i) => ({
        z: i * 8 - 80,
        x: 0,
      })),
    [],
  );

  useFrame(() => {
    const dist = refs.distanceRef.current;
    if (segGroup.current) {
      const totalLen = NUM_SEGMENTS * SEGMENT_LEN;
      segGroup.current.children.forEach((child, i) => {
        const baseZ = segments[i].z;
        let z = baseZ - (dist % totalLen);
        // wrap
        while (z < dist - 80 - dist) z += totalLen;
        // simpler: position relative to camera-following world
        child.position.z = baseZ - dist;
        // when far behind, push forward
        while (child.position.z < -SEGMENT_LEN * 2) {
          child.position.z += totalLen;
          segments[i].z += totalLen;
        }
      });
    }

    if (dashGroup.current) {
      const totalLen = NUM_DASHES * 8;
      dashGroup.current.children.forEach((child, i) => {
        child.position.z = dashes[i].z - dist;
        while (child.position.z < -16) {
          child.position.z += totalLen;
          dashes[i].z += totalLen;
        }
      });
    }
  });

  return (
    <group>
      {/* Ground plane far below as dark void */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.02, 0]}
        receiveShadow
      >
        <planeGeometry args={[600, 4000]} />
        <meshStandardMaterial color={"#02020a"} />
      </mesh>

      {/* Road segments */}
      <group ref={segGroup}>
        {segments.map((seg, i) => (
          <group key={i} position={[0, 0, seg.z]}>
            <mesh
              receiveShadow
              position={[0, 0, 0]}
              rotation={[-Math.PI / 2, 0, 0]}
              material={asphaltMat}
            >
              <planeGeometry args={[ROAD_HALF_WIDTH * 2, SEGMENT_LEN]} />
            </mesh>
            {/* Glowing curbs */}
            <mesh
              position={[-ROAD_HALF_WIDTH - 0.05, 0.05, 0]}
              material={curbMat}
            >
              <boxGeometry args={[0.1, 0.1, SEGMENT_LEN]} />
            </mesh>
            <mesh
              position={[ROAD_HALF_WIDTH + 0.05, 0.05, 0]}
              material={curbMat}
            >
              <boxGeometry args={[0.1, 0.1, SEGMENT_LEN]} />
            </mesh>
            {/* Lane separators (subtle) */}
            {[-3, 0, 3].map((x) => (
              <mesh
                key={x}
                position={[x, 0.005, 0]}
                rotation={[-Math.PI / 2, 0, 0]}
              >
                <planeGeometry args={[0.05, SEGMENT_LEN]} />
                <meshStandardMaterial
                  color={"#1a1a3a"}
                  emissive={"#1a1a3a"}
                  emissiveIntensity={0.4}
                />
              </mesh>
            ))}
          </group>
        ))}
      </group>

      {/* Center dashes */}
      <group ref={dashGroup}>
        {dashes.map((d, i) => (
          <mesh
            key={i}
            position={[0, 0.01, d.z]}
            rotation={[-Math.PI / 2, 0, 0]}
            material={dashMat}
          >
            <planeGeometry args={[0.18, 3]} />
          </mesh>
        ))}
      </group>
    </group>
  );
};

// ---------- Buildings (procedural city) ----------
type BuildingDatum = {
  side: -1 | 1;
  z: number;
  width: number;
  depth: number;
  height: number;
  color: string;
  emissive: string;
  emissiveIntensity: number;
  windowCols: number;
  windowRows: number;
};

const palette = ["#1a1040", "#280a3a", "#0a0a30", "#150a3a", "#1f0a30"];
const neonColors = ["#00f6ff", "#ff2bd1", "#9b30ff", "#ffe600", "#6effaa"];

function buildBuildingData(seedZ: number): BuildingDatum {
  const side: -1 | 1 = Math.random() > 0.5 ? -1 : 1;
  const width = 6 + Math.random() * 8;
  const depth = 6 + Math.random() * 10;
  const height = 8 + Math.random() * 60;
  const color = palette[Math.floor(Math.random() * palette.length)];
  const emissive = neonColors[Math.floor(Math.random() * neonColors.length)];
  return {
    side,
    z: seedZ,
    width,
    depth,
    height,
    color,
    emissive,
    emissiveIntensity: 0.3 + Math.random() * 1.0,
    windowCols: Math.max(2, Math.floor(width / 1.4)),
    windowRows: Math.max(3, Math.floor(height / 2.5)),
  };
}

const Building = ({ data }: { data: BuildingDatum }) => {
  const xBase = data.side * (ROAD_HALF_WIDTH + 4 + data.width / 2);
  // Window pattern as instanced points (small emissive boxes)
  const windowPositions = useMemo(() => {
    const arr: { x: number; y: number; z: number; lit: boolean }[] = [];
    const wSpacingX = data.width / (data.windowCols + 1);
    const wSpacingY = data.height / (data.windowRows + 1);
    for (let r = 1; r <= data.windowRows; r++) {
      for (let c = 1; c <= data.windowCols; c++) {
        arr.push({
          x: -data.width / 2 + c * wSpacingX,
          y: r * wSpacingY,
          z: data.depth / 2 + 0.02,
          lit: Math.random() > 0.35,
        });
      }
    }
    return arr;
  }, [data]);

  return (
    <group position={[xBase, 0, data.z]}>
      {/* Body */}
      <mesh castShadow receiveShadow position={[0, data.height / 2, 0]}>
        <boxGeometry args={[data.width, data.height, data.depth]} />
        <meshStandardMaterial
          color={data.color}
          roughness={0.7}
          metalness={0.4}
          emissive={data.emissive}
          emissiveIntensity={data.emissiveIntensity * 0.15}
        />
      </mesh>
      {/* Roof neon strip */}
      <mesh position={[0, data.height + 0.1, 0]}>
        <boxGeometry args={[data.width * 0.7, 0.15, data.depth * 0.7]} />
        <meshStandardMaterial
          color={data.emissive}
          emissive={data.emissive}
          emissiveIntensity={3.5}
        />
      </mesh>
      {/* Vertical neon trim on the road-facing edge */}
      <mesh position={[0, data.height / 2, data.depth / 2 + 0.06]}>
        <boxGeometry args={[0.12, data.height * 0.95, 0.12]} />
        <meshStandardMaterial
          color={data.emissive}
          emissive={data.emissive}
          emissiveIntensity={2.4}
        />
      </mesh>
      {/* Window grid */}
      {windowPositions.map((w, i) => (
        <mesh key={i} position={[w.x, w.y, w.z]}>
          <boxGeometry args={[0.45, 0.55, 0.05]} />
          <meshStandardMaterial
            color={w.lit ? data.emissive : "#0a0a18"}
            emissive={w.lit ? data.emissive : "#000000"}
            emissiveIntensity={w.lit ? 1.6 : 0}
          />
        </mesh>
      ))}
    </group>
  );
};

const Buildings = ({ refs }: { refs: SharedRefs }) => {
  const groupRef = useRef<THREE.Group>(null);
  const buildingsRef = useRef<BuildingDatum[]>([]);

  if (buildingsRef.current.length === 0) {
    // initial set spread across length
    let z = -120;
    for (let i = 0; i < 60; i++) {
      buildingsRef.current.push(buildBuildingData(z));
      z += 12 + Math.random() * 8;
    }
  }

  useFrame(() => {
    const g = groupRef.current;
    if (!g) return;
    const dist = refs.distanceRef.current;

    g.children.forEach((child, i) => {
      const data = buildingsRef.current[i];
      const localZ = data.z - dist;
      child.position.z = localZ;

      // recycle: if behind camera by BUILDING_RECYCLE, push ahead
      if (localZ < -BUILDING_RECYCLE) {
        // farthest forward
        const maxZ = Math.max(...buildingsRef.current.map((b) => b.z));
        const newData = buildBuildingData(maxZ + 10 + Math.random() * 10);
        buildingsRef.current[i] = newData;
      }
    });
  });

  return (
    <group ref={groupRef}>
      {buildingsRef.current.map((b, i) => (
        <Building key={i} data={b} />
      ))}
    </group>
  );
};

// ---------- Distant skyline silhouette ----------
const DistantSkyline = () => {
  const skylineL = useMemo(() => {
    const arr: { h: number; w: number; x: number }[] = [];
    let cur = -300;
    while (cur < 300) {
      const w = 4 + Math.random() * 12;
      arr.push({ h: 20 + Math.random() * 80, w, x: cur + w / 2 });
      cur += w + 1;
    }
    return arr;
  }, []);
  const skylineR = useMemo(() => {
    const arr: { h: number; w: number; x: number }[] = [];
    let cur = -300;
    while (cur < 300) {
      const w = 4 + Math.random() * 12;
      arr.push({ h: 20 + Math.random() * 80, w, x: cur + w / 2 });
      cur += w + 1;
    }
    return arr;
  }, []);

  return (
    <group>
      <group position={[0, 0, -260]}>
        {skylineL.map((b, i) => (
          <mesh key={`l-${i}`} position={[b.x, b.h / 2, 0]}>
            <boxGeometry args={[b.w, b.h, 2]} />
            <meshStandardMaterial
              color={"#06031a"}
              emissive={"#3a0a52"}
              emissiveIntensity={0.5}
            />
          </mesh>
        ))}
      </group>
      <group position={[0, 0, -200]}>
        {skylineR.map((b, i) => (
          <mesh key={`r-${i}`} position={[b.x * 0.8, b.h / 2.2, 0]}>
            <boxGeometry args={[b.w * 0.7, b.h * 0.85, 2]} />
            <meshStandardMaterial
              color={"#070420"}
              emissive={"#0a3050"}
              emissiveIntensity={0.45}
            />
          </mesh>
        ))}
      </group>
    </group>
  );
};

// ---------- Sky / horizon glow ----------
const Sky = () => {
  return (
    <group>
      {/* Skydome */}
      <mesh>
        <sphereGeometry args={[500, 32, 16]} />
        <meshBasicMaterial side={THREE.BackSide} color={"#04031a"} />
      </mesh>
      {/* Horizon sun glow */}
      <mesh position={[0, 30, -300]}>
        <planeGeometry args={[400, 200]} />
        <meshBasicMaterial
          color={"#ff2bd1"}
          transparent
          opacity={0.18}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      <mesh position={[0, 8, -290]}>
        <planeGeometry args={[600, 80]} />
        <meshBasicMaterial
          color={"#9b30ff"}
          transparent
          opacity={0.22}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      <mesh position={[0, 2, -280]}>
        <planeGeometry args={[800, 30]} />
        <meshBasicMaterial
          color={"#00f6ff"}
          transparent
          opacity={0.35}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      {/* Giant ringed planet hanging over the horizon */}
      <GiantPlanet />
      {/* Stars */}
      <Stars />
    </group>
  );
};

// ---------- Giant cyberpunk planet with rings ----------
const GiantPlanet = () => {
  const groupRef = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (groupRef.current) groupRef.current.rotation.z += dt * 0.05;
  });
  return (
    <group position={[-90, 70, -260]} rotation={[0.2, 0.3, 0.4]}>
      {/* Planet body */}
      <mesh>
        <sphereGeometry args={[28, 32, 32]} />
        <meshBasicMaterial color={"#3a1a55"} />
      </mesh>
      {/* Bright rim glow */}
      <mesh>
        <sphereGeometry args={[29.5, 24, 24]} />
        <meshBasicMaterial
          color={"#ff2bd1"}
          transparent
          opacity={0.18}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.BackSide}
        />
      </mesh>
      {/* Rotating ring system */}
      <group ref={groupRef}>
        <mesh rotation={[Math.PI / 2.4, 0, 0]}>
          <ringGeometry args={[36, 50, 64]} />
          <meshBasicMaterial
            color={"#00f6ff"}
            transparent
            opacity={0.55}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
        <mesh rotation={[Math.PI / 2.4, 0, 0]}>
          <ringGeometry args={[52, 58, 64]} />
          <meshBasicMaterial
            color={"#ff2bd1"}
            transparent
            opacity={0.4}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      </group>
      {/* Soft halo light to wash the scene */}
      <pointLight color={"#ff2bd1"} intensity={0.8} distance={400} />
    </group>
  );
};

const Stars = () => {
  const points = useMemo(() => {
    const positions = new Float32Array(800 * 3);
    for (let i = 0; i < 800; i++) {
      const r = 380 + Math.random() * 80;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(0.3 + Math.random() * 0.6);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    return positions;
  }, []);
  return (
    <points>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[points, 3]}
        />
      </bufferGeometry>
      <pointsMaterial
        color={"#cfeaff"}
        size={1.4}
        sizeAttenuation
        transparent
        opacity={0.9}
        depthWrite={false}
      />
    </points>
  );
};

// ---------- Pickups (collectible power-ups) ----------
type Pickup = {
  kind: PickupKind;
  laneIndex: number;
  z: number;
  alive: boolean;
};

const MAX_PICKUPS = 4;
const PICKUP_SPAWN_INTERVAL = 4.2; // seconds between spawn attempts
const PICKUP_RECYCLE = 240;
// Color per pickup kind for materials + HUD
const PICKUP_COLORS: Record<PickupKind, string> = {
  nitro: "#7ff7ff",
  multiplier: "#ffe600",
  shield: "#ff2bd1",
};

const PickupMesh = ({
  pickupRef,
}: {
  pickupRef: React.MutableRefObject<Pickup>;
}) => {
  const groupRef = useRef<THREE.Group>(null);
  const haloRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    const g = groupRef.current;
    if (!g) return;
    g.visible = pickupRef.current.alive;
    if (!pickupRef.current.alive) return;
    const t = state.clock.elapsedTime;
    g.rotation.y = t * 2.4;
    g.position.y = 1.4 + Math.sin(t * 3) * 0.12;
    if (haloRef.current) {
      const s = 1 + Math.sin(t * 4) * 0.08;
      haloRef.current.scale.set(s, s, s);
    }
  });

  const kind = pickupRef.current.kind;
  const color = PICKUP_COLORS[kind];

  return (
    <group ref={groupRef}>
      {/* Glowing halo ring (always present, color-coded) */}
      <mesh ref={haloRef} rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.85, 1.15, 28]} />
        <meshBasicMaterial color={color} transparent opacity={0.75} side={THREE.DoubleSide} />
      </mesh>
      {/* Inner shape changes per pickup kind */}
      {kind === "nitro" && (
        <>
          {/* Cyan octahedral fuel cell */}
          <mesh>
            <octahedronGeometry args={[0.5, 0]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={2.4}
              metalness={0.3}
              roughness={0.25}
            />
          </mesh>
        </>
      )}
      {kind === "multiplier" && (
        <>
          {/* Yellow x2 — torus star */}
          <mesh>
            <torusKnotGeometry args={[0.34, 0.13, 64, 8]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={2.6}
              metalness={0.4}
              roughness={0.2}
            />
          </mesh>
        </>
      )}
      {kind === "shield" && (
        <>
          {/* Pink shield orb */}
          <mesh>
            <icosahedronGeometry args={[0.55, 0]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={2.2}
              metalness={0.5}
              roughness={0.2}
            />
          </mesh>
        </>
      )}
      <pointLight color={color} intensity={3.2} distance={14} />
    </group>
  );
};

const Pickups = ({ refs }: { refs: SharedRefs }) => {
  const groupRef = useRef<THREE.Group>(null);
  const itemsRef = useRef<React.MutableRefObject<Pickup>[]>([]);
  const lastSpawnRef = useRef(0);

  if (itemsRef.current.length === 0) {
    for (let i = 0; i < MAX_PICKUPS; i++) {
      itemsRef.current.push({
        current: {
          kind: "nitro",
          laneIndex: 0,
          z: -9999,
          alive: false,
        },
      });
    }
  }

  useFrame((_, dt) => {
    if (refs.crashedRef.current) return;
    const dist = refs.distanceRef.current;
    lastSpawnRef.current += dt;

    // Spawn cadence
    if (lastSpawnRef.current > PICKUP_SPAWN_INTERVAL) {
      lastSpawnRef.current = 0;
      const free = itemsRef.current.find((p) => !p.current.alive);
      if (free) {
        // Weighted kind selection: nitro 55%, multiplier 30%, shield 15%
        const r = Math.random();
        const kind: PickupKind =
          r < 0.55 ? "nitro" : r < 0.85 ? "multiplier" : "shield";
        free.current.kind = kind;
        free.current.laneIndex = Math.floor(Math.random() * 4);
        free.current.z = dist + 200 + Math.random() * 60;
        free.current.alive = true;
      }
    }

    // Update + recycle
    itemsRef.current.forEach((p) => {
      if (!p.current.alive) return;
      const localZ = p.current.z - dist;
      if (localZ < -PICKUP_RECYCLE * 0.1) p.current.alive = false;
    });

    // Apply transforms
    if (groupRef.current) {
      groupRef.current.children.forEach((child, i) => {
        const p = itemsRef.current[i].current;
        const targetX = LANE_X[p.laneIndex];
        child.position.x = targetX;
        child.position.z = p.z - dist;
      });
    }

    // Pickup collision vs player
    const px = refs.carXRef.current;
    for (const p of itemsRef.current) {
      if (!p.current.alive) continue;
      const localZ = p.current.z - dist;
      const cx = LANE_X[p.current.laneIndex];
      if (Math.abs(localZ) < 2.0 && Math.abs(cx - px) < 1.4) {
        const kind = p.current.kind;
        p.current.alive = false;
        if (kind === "nitro") {
          refs.nitroRef.current = Math.min(100, refs.nitroRef.current + 35);
        } else if (kind === "multiplier") {
          // Stack up to 8 seconds
          refs.multiplierTimerRef.current = Math.min(
            8,
            refs.multiplierTimerRef.current + 5,
          );
        } else if (kind === "shield") {
          refs.shieldRef.current = Math.min(2, refs.shieldRef.current + 1);
        }
        refs.pickupTakenRef.current = { kind, pulse: 1 };
        refs.onPickup(kind);
      }
    }
  });

  return (
    <group ref={groupRef}>
      {itemsRef.current.map((p, i) => (
        <PickupMesh key={i} pickupRef={p} />
      ))}
    </group>
  );
};

// ---------- Traffic ----------
type TrafficCar = {
  laneIndex: number;
  z: number; // world z
  speed: number; // m/s (oncoming = negative relative to player)
  color: string;
  alive: boolean;
  passed: boolean; // tracked for near-miss scoring
};

const trafficColors = ["#ff2bd1", "#00f6ff", "#ffe600", "#6effaa", "#ff5050", "#ffffff"];

const TrafficCarMesh = ({
  carRef,
}: {
  carRef: React.MutableRefObject<TrafficCar>;
}) => {
  const groupRef = useRef<THREE.Group>(null);
  const headlightRef = useRef<THREE.PointLight>(null);

  useFrame(() => {
    if (groupRef.current) {
      groupRef.current.visible = carRef.current.alive;
    }
  });

  const color = carRef.current.color;
  return (
    <group ref={groupRef}>
      {/* Body — vivid colored so it pops against the dark road */}
      <mesh castShadow position={[0, 0.55, 0]}>
        <boxGeometry args={[1.8, 0.7, 3.4]} />
        <meshStandardMaterial
          color={color}
          metalness={0.6}
          roughness={0.35}
          emissive={color}
          emissiveIntensity={0.55}
        />
      </mesh>
      {/* Glowing roof beacon — visible from far away */}
      <mesh position={[0, 1.2, 0]}>
        <boxGeometry args={[1.4, 0.18, 1.6]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={4}
        />
      </mesh>
      {/* Cockpit canopy */}
      <mesh position={[0, 1.0, -0.1]}>
        <boxGeometry args={[1.45, 0.4, 1.4]} />
        <meshStandardMaterial
          color={"#040810"}
          metalness={0.6}
          roughness={0.1}
          emissive={color}
          emissiveIntensity={0.3}
        />
      </mesh>
      {/* Bright accent stripes around the body */}
      <mesh position={[0, 0.55, 1.71]}>
        <boxGeometry args={[1.6, 0.12, 0.05]} />
        <meshStandardMaterial
          color={"#ffffff"}
          emissive={"#ffffff"}
          emissiveIntensity={3.5}
        />
      </mesh>
      <mesh position={[0, 0.55, -1.71]}>
        <boxGeometry args={[1.6, 0.12, 0.05]} />
        <meshStandardMaterial
          color={"#ff003c"}
          emissive={"#ff003c"}
          emissiveIntensity={3.5}
        />
      </mesh>
      {/* Side neon trim */}
      {[-0.91, 0.91].map((x) => (
        <mesh key={x} position={[x, 0.55, 0]}>
          <boxGeometry args={[0.04, 0.1, 3.2]} />
          <meshStandardMaterial
            color={"#ffffff"}
            emissive={color}
            emissiveIntensity={2.5}
          />
        </mesh>
      ))}
      {/* Headlights toward player (player is +z forward; oncoming faces -z) */}
      {[-0.55, 0.55].map((x) => (
        <mesh key={x} position={[x, 0.6, -1.72]}>
          <boxGeometry args={[0.4, 0.14, 0.05]} />
          <meshStandardMaterial
            color={"#ffffff"}
            emissive={"#ffffff"}
            emissiveIntensity={6}
          />
        </mesh>
      ))}
      <pointLight
        ref={headlightRef}
        color={color}
        intensity={3}
        distance={28}
        position={[0, 1.0, 0]}
      />
      <spotLight
        color={"#ffffff"}
        position={[0, 0.7, -1.75]}
        target-position={[0, 0, -25]}
        angle={0.7}
        penumbra={0.7}
        intensity={3.5}
        distance={35}
      />
      {/* Wheels (static) */}
      {[
        [-0.95, 0.32, 1.1],
        [0.95, 0.32, 1.1],
        [-0.95, 0.32, -1.2],
        [0.95, 0.32, -1.2],
      ].map(([x, y, z], i) => (
        <mesh
          key={i}
          position={[x as number, y as number, z as number]}
          rotation={[0, 0, Math.PI / 2]}
        >
          <cylinderGeometry args={[0.32, 0.32, 0.25, 16]} />
          <meshStandardMaterial color={"#0a0a10"} metalness={0.4} roughness={0.6} />
        </mesh>
      ))}
    </group>
  );
};

const Traffic = ({ refs }: { refs: SharedRefs }) => {
  const groupRef = useRef<THREE.Group>(null);
  const carsRef = useRef<React.MutableRefObject<TrafficCar>[]>([]);
  const lastSpawnRef = useRef(0);

  if (carsRef.current.length === 0) {
    for (let i = 0; i < MAX_TRAFFIC; i++) {
      carsRef.current.push({
        current: {
          laneIndex: Math.floor(Math.random() * 4),
          z: -9999,
          speed: 0,
          color: trafficColors[Math.floor(Math.random() * trafficColors.length)],
          alive: false,
          passed: false,
        },
      });
    }
  }

  // Spawn loop
  useFrame((_, dt) => {
    const dist = refs.distanceRef.current;
    lastSpawnRef.current += dt;
    const cfg = refs.modeRef.current;

    // Spawn cadence (mode-tuned)
    if (lastSpawnRef.current > cfg.spawnInterval) {
      lastSpawnRef.current = 0;
      const free = carsRef.current.find((c) => !c.current.alive);
      if (free) {
        const lane = Math.floor(Math.random() * 4);
        free.current.laneIndex = lane;
        free.current.z = dist + 220 + Math.random() * 40;
        free.current.speed = -(8 + Math.random() * 16) * cfg.trafficSpeedMul;
        free.current.color =
          trafficColors[Math.floor(Math.random() * trafficColors.length)];
        free.current.alive = true;
        free.current.passed = false;
      }
    }

    // Update positions / recycle
    carsRef.current.forEach((c) => {
      if (!c.current.alive) return;
      c.current.z += c.current.speed * dt;
      // Random small lane changes
      if (Math.random() < 0.0008) {
        const dir = Math.random() > 0.5 ? 1 : -1;
        const newLane = Math.max(0, Math.min(3, c.current.laneIndex + dir));
        c.current.laneIndex = newLane;
      }
      const localZ = c.current.z - dist;
      if (localZ < -TRAFFIC_RECYCLE * 0.2) {
        c.current.alive = false;
      }
    });

    // Apply transforms to group children
    if (groupRef.current) {
      groupRef.current.children.forEach((child, i) => {
        const c = carsRef.current[i].current;
        const targetX = LANE_X[c.laneIndex];
        child.position.x = THREE.MathUtils.lerp(child.position.x, targetX, 0.08);
        child.position.z = c.z - dist;
      });
    }

    // Collision + near-miss detection (only when not crashed)
    if (!refs.crashedRef.current) {
      const px = refs.carXRef.current;
      for (const c of carsRef.current) {
        if (!c.current.alive) continue;
        const localZ = c.current.z - dist;
        const cx = LANE_X[c.current.laneIndex];
        const dx = Math.abs(cx - px);

        // Hard collision
        if (Math.abs(localZ) < 2.0 && dx < 1.6) {
          if (refs.shieldRef.current > 0) {
            // Shield absorbs the hit and vaporizes the traffic car
            refs.shieldRef.current -= 1;
            c.current.alive = false;
            refs.onShieldAbsorb();
          } else {
            refs.crashedRef.current = true;
            refs.onCrash();
            break;
          }
        }

        // Near-miss: counted once per car as it passes the player at close lateral
        // distance but NOT inside the collision box. Window is just behind the
        // player so the player has clearly committed to the gap.
        if (
          !c.current.passed &&
          localZ < 0 &&
          localZ > -3.5 &&
          dx < 2.6 &&
          dx >= 1.6
        ) {
          c.current.passed = true;
          refs.comboRef.current += 1;
          refs.comboTimerRef.current = 0;
          refs.comboPulseRef.current = 1;
          refs.onNearMiss(refs.comboRef.current);
        }
      }
    }
  });

  return (
    <group ref={groupRef}>
      {carsRef.current.map((c, i) => (
        <TrafficCarMesh key={i} carRef={c} />
      ))}
    </group>
  );
};

// ---------- Camera follow ----------
const CameraFollow = ({ refs }: { refs: SharedRefs }) => {
  const { camera } = useThree();
  const targetPos = useRef(new THREE.Vector3(0, 4.5, -8.5));
  const targetLook = useRef(new THREE.Vector3(0, 1.5, 6));
  const crashShakeRef = useRef(0);
  const wasCrashed = useRef(false);
  const fovBaseRef = useRef(70);

  useEffect(() => {
    camera.position.set(0, 4.5, -8.5);
    camera.lookAt(0, 1.5, 6);
    if ((camera as THREE.PerspectiveCamera).fov) {
      fovBaseRef.current = (camera as THREE.PerspectiveCamera).fov;
    }
  }, [camera]);

  useFrame((state) => {
    const x = refs.carXRef.current;
    const speed = refs.speedRef.current;
    const speedFactor = Math.min(
      1,
      (speed - BASE_SPEED) / (NITRO_MAX_SPEED - BASE_SPEED),
    );
    const back = -8 - speedFactor * 1.5;
    const up = 4.4 + speedFactor * 0.3;

    targetPos.current.set(x * 0.6, up, back);
    targetLook.current.set(x * 0.7, 1.2, 8);

    camera.position.lerp(targetPos.current, 0.12);
    camera.lookAt(targetLook.current);

    // ---- Camera shake ----
    // Trigger a strong shake on the rising edge of crash
    if (refs.crashedRef.current && !wasCrashed.current) {
      crashShakeRef.current = 1;
    }
    wasCrashed.current = refs.crashedRef.current;
    if (crashShakeRef.current > 0) crashShakeRef.current = Math.max(0, crashShakeRef.current - 0.025);

    const boosting =
      refs.input.current.nitro &&
      refs.nitroRef.current > 0 &&
      speed > BASE_SPEED + 5;
    const boostShake = boosting ? speedFactor * 0.18 : 0;
    const totalShake = crashShakeRef.current * 0.9 + boostShake;
    const t = state.clock.elapsedTime;
    if (totalShake > 0.001) {
      camera.position.x += Math.sin(t * 47) * totalShake;
      camera.position.y += Math.cos(t * 53) * totalShake * 0.6;
    }

    // Speed FOV pump — feels much faster
    const cam = camera as THREE.PerspectiveCamera;
    if (cam.isPerspectiveCamera) {
      const targetFov = fovBaseRef.current + speedFactor * 14 + (boosting ? 4 : 0);
      cam.fov += (targetFov - cam.fov) * 0.08;
      cam.updateProjectionMatrix();
    }
  });
  return null;
};

// ---------- Game logic driver (in-canvas) ----------
// Combo resets after this many seconds without a new near-miss
const COMBO_TIMEOUT = 3.0;

const GameLogic = ({ refs }: { refs: SharedRefs }) => {
  useFrame((_, deltaRaw) => {
    const dt = Math.min(0.05, deltaRaw); // clamp dt for stability

    // Decay HUD pulse refs (always)
    refs.comboPulseRef.current = Math.max(
      0,
      refs.comboPulseRef.current - dt * 2.4,
    );
    if (refs.pickupTakenRef.current.pulse > 0) {
      refs.pickupTakenRef.current.pulse = Math.max(
        0,
        refs.pickupTakenRef.current.pulse - dt * 1.6,
      );
    }

    if (refs.crashedRef.current) {
      // Decelerate during crash
      refs.speedRef.current = Math.max(
        0,
        refs.speedRef.current - 70 * dt,
      );
      refs.distanceRef.current += refs.speedRef.current * dt;
      // gentle drift sway
      refs.driftAngleRef.current = THREE.MathUtils.lerp(
        refs.driftAngleRef.current,
        0,
        0.05,
      );
      return;
    }

    // Multiplier timer decay
    if (refs.multiplierTimerRef.current > 0) {
      refs.multiplierTimerRef.current = Math.max(
        0,
        refs.multiplierTimerRef.current - dt,
      );
    }

    // Combo timeout — reset combo if no near-miss in COMBO_TIMEOUT seconds
    if (refs.comboRef.current > 0) {
      refs.comboTimerRef.current += dt;
      if (refs.comboTimerRef.current > COMBO_TIMEOUT) {
        refs.comboRef.current = 0;
        refs.comboTimerRef.current = 0;
      }
    }

    const input = refs.input.current;
    const drifting = input.drift;
    const boosting = input.nitro && refs.nitroRef.current > 0;
    const cfg = refs.modeRef.current;

    // Nitro management
    if (boosting) {
      refs.nitroRef.current = Math.max(
        0,
        refs.nitroRef.current - cfg.nitroDrain * dt,
      );
    } else {
      refs.nitroRef.current = Math.min(
        100,
        refs.nitroRef.current + cfg.nitroRegen * dt,
      );
    }
    // Drift mode: drifting refills nitro
    if (cfg.driftBoosts && drifting && refs.speedRef.current > BASE_SPEED) {
      refs.nitroRef.current = Math.min(
        100,
        refs.nitroRef.current + 24 * dt,
      );
    }
    // Score multiplier (2x while pickup is active)
    const scoreMul = refs.multiplierTimerRef.current > 0 ? 2 : 1;

    // Drift mode: track drift score (drift seconds × speed factor × multiplier)
    if (cfg.driftScoring && drifting) {
      const sf = Math.max(0.4, refs.speedRef.current / MAX_SPEED);
      refs.driftScoreRef.current += dt * 100 * sf * scoreMul;
    }

    // Target speed (mode + car tuned)
    const car = refs.carRef.current;
    const modeMax = MAX_SPEED * cfg.speedMul * car.speedMul;
    const modeNitroMax = NITRO_MAX_SPEED * cfg.speedMul * car.speedMul;
    let targetSpeed = modeMax;
    if (boosting) targetSpeed = modeNitroMax;
    if (drifting) targetSpeed = Math.min(targetSpeed, modeMax * 0.7);

    // Approach target speed (car accelMul affects ramp)
    if (refs.speedRef.current < targetSpeed) {
      refs.speedRef.current = Math.min(
        targetSpeed,
        refs.speedRef.current + ACCEL * car.accelMul * dt * (boosting ? 1.6 : 1),
      );
    } else {
      const decel = drifting ? DRIFT_DECAY : ACCEL * 0.6;
      refs.speedRef.current = Math.max(
        targetSpeed,
        refs.speedRef.current - decel * dt,
      );
    }

    // Steering (car gripMul affects responsiveness)
    const steerInput = input.steer;
    const baseSteer =
      STEER_SPEED * car.gripMul * (drifting ? DRIFT_STEER_BOOST : 1);
    refs.carXRef.current += steerInput * baseSteer * dt;
    // clamp inside road
    refs.carXRef.current = Math.max(
      -ROAD_HALF_WIDTH + 0.9,
      Math.min(ROAD_HALF_WIDTH - 0.9, refs.carXRef.current),
    );

    // Drift angle
    const driftTarget = drifting
      ? -steerInput * 0.55
      : -steerInput * 0.18;
    refs.driftAngleRef.current = THREE.MathUtils.lerp(
      refs.driftAngleRef.current,
      driftTarget,
      drifting ? 0.18 : 0.12,
    );

    // Distance traveled (with score multiplier applied)
    refs.distanceRef.current += refs.speedRef.current * dt * scoreMul;
  });
  return null;
};

// ---------- Lighting + fog ----------
const Lights = () => {
  return (
    <>
      <ambientLight intensity={0.35} color={"#7080ff"} />
      <directionalLight
        color={"#9bb0ff"}
        position={[20, 40, -10]}
        intensity={0.6}
        castShadow={false}
      />
      <hemisphereLight
        color={"#ff80e0"}
        groundColor={"#0a0030"}
        intensity={0.45}
      />
    </>
  );
};

// ---------- Animated neon ground grid ----------
const NeonGrid = ({ refs }: { refs: SharedRefs }) => {
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uOffset: { value: 0 },
      uColorA: { value: new THREE.Color("#00f6ff") },
      uColorB: { value: new THREE.Color("#ff2bd1") },
    }),
    [],
  );
  useFrame((_, dt) => {
    uniforms.uTime.value += dt;
    uniforms.uOffset.value += refs.speedRef.current * dt * 0.04;
  });
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0.02, 100]}
    >
      <planeGeometry args={[260, 600, 1, 1]} />
      <shaderMaterial
        ref={matRef}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        uniforms={uniforms}
        vertexShader={`
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `}
        fragmentShader={`
          varying vec2 vUv;
          uniform float uTime;
          uniform float uOffset;
          uniform vec3 uColorA;
          uniform vec3 uColorB;
          void main() {
            // Horizon fade
            float depthFade = smoothstep(0.0, 0.6, vUv.y) * smoothstep(1.0, 0.85, vUv.y);
            // Skip the road area (center ~6% of width)
            float roadMask = smoothstep(0.025, 0.045, abs(vUv.x - 0.5));
            // Grid lines
            float fx = abs(fract((vUv.x - 0.5) * 18.0 + 0.5) - 0.5);
            float fy = abs(fract(vUv.y * 28.0 - uOffset) - 0.5);
            float lineX = smoothstep(0.04, 0.0, fx);
            float lineY = smoothstep(0.04, 0.0, fy);
            float grid = max(lineX, lineY);
            // Color shift
            float t = 0.5 + 0.5 * sin(uTime * 0.6 + vUv.y * 4.0);
            vec3 col = mix(uColorB, uColorA, t);
            float alpha = grid * depthFade * roadMask * 0.85;
            gl_FragColor = vec4(col * (1.5 + grid), alpha);
          }
        `}
      />
    </mesh>
  );
};

// ---------- Flying drones with blinking lights ----------
const Drones = ({ refs }: { refs: SharedRefs }) => {
  const NUM = 8;
  const drones = useMemo(() => {
    return new Array(NUM).fill(0).map((_, i) => ({
      side: i % 2 === 0 ? -1 : 1,
      offset: (i / NUM) * 600,
      x: (Math.random() - 0.5) * 60,
      y: 18 + Math.random() * 22,
      z: Math.random() * 600 - 100,
      speed: 0.4 + Math.random() * 0.8,
      blinkPhase: Math.random() * Math.PI * 2,
      color: i % 3 === 0 ? "#ff2bd1" : i % 3 === 1 ? "#00f6ff" : "#ffd23a",
    }));
  }, []);
  const refsArr = useRef<THREE.Group[]>([]);
  useFrame((state, dt) => {
    const playerZ = refs.distanceRef.current;
    const t = state.clock.elapsedTime;
    drones.forEach((d, i) => {
      const g = refsArr.current[i];
      if (!g) return;
      // Drift slowly across the sky
      d.x += d.speed * dt * d.side * 2;
      if (d.x > 50) d.x = -50;
      if (d.x < -50) d.x = 50;
      // Recycle z relative to player
      const relZ = d.z - playerZ;
      if (relZ < -100) d.z += 600;
      if (relZ > 500) d.z -= 600;
      g.position.set(d.x, d.y + Math.sin(t * 0.5 + d.offset) * 0.6, d.z - playerZ);
    });
  });
  return (
    <group>
      {drones.map((d, i) => (
        <group
          key={i}
          ref={(g) => {
            if (g) refsArr.current[i] = g;
          }}
        >
          {/* Body */}
          <mesh>
            <boxGeometry args={[0.8, 0.18, 0.4]} />
            <meshStandardMaterial
              color={"#0a0a18"}
              emissive={d.color}
              emissiveIntensity={0.6}
              metalness={0.6}
              roughness={0.4}
            />
          </mesh>
          {/* Beacon */}
          <mesh position={[0, -0.15, 0]}>
            <sphereGeometry args={[0.12, 8, 8]} />
            <meshBasicMaterial color={d.color} />
          </mesh>
        </group>
      ))}
    </group>
  );
};

// ---------- Holographic billboards floating between buildings ----------
const Holograms = ({ refs }: { refs: SharedRefs }) => {
  const holos = useMemo(() => {
    return new Array(10).fill(0).map((_, i) => ({
      side: i % 2 === 0 ? -1 : 1,
      x: (i % 2 === 0 ? -1 : 1) * (12 + Math.random() * 6),
      y: 6 + Math.random() * 8,
      z: i * 80 + Math.random() * 40,
      rot: (Math.random() - 0.5) * 0.4,
      scale: 1 + Math.random() * 0.7,
      color: i % 3 === 0 ? "#00f6ff" : i % 3 === 1 ? "#ff2bd1" : "#a26bff",
      label: ["FRZN", "NEO", "LCDX", "RUSH", "▲▼", "404", "XTC", "VCTR", "■■■", "◆◆◆"][i % 10],
    }));
  }, []);
  const refsArr = useRef<THREE.Group[]>([]);
  const matsRef = useRef<THREE.MeshBasicMaterial[]>([]);
  useFrame((state) => {
    const playerZ = refs.distanceRef.current;
    const t = state.clock.elapsedTime;
    holos.forEach((h, i) => {
      const g = refsArr.current[i];
      if (!g) return;
      const relZ = h.z - playerZ;
      if (relZ < -50) h.z += 800;
      if (relZ > 750) h.z -= 800;
      g.position.set(h.x, h.y + Math.sin(t * 1.5 + i) * 0.3, h.z - playerZ);
      g.rotation.y = h.rot + Math.sin(t * 0.4 + i) * 0.15;
      const mat = matsRef.current[i];
      if (mat) {
        // Glitch flicker
        const flicker = Math.random() < 0.04 ? 0.2 : 1;
        mat.opacity = (0.55 + 0.25 * Math.sin(t * 3 + i)) * flicker;
      }
    });
  });
  return (
    <group>
      {holos.map((h, i) => (
        <group
          key={i}
          ref={(g) => {
            if (g) refsArr.current[i] = g;
          }}
          scale={h.scale}
        >
          {/* Holographic frame */}
          <mesh>
            <planeGeometry args={[3.2, 1.8]} />
            <meshBasicMaterial
              ref={(m) => {
                if (m) matsRef.current[i] = m;
              }}
              color={h.color}
              transparent
              opacity={0.6}
              blending={THREE.AdditiveBlending}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
          {/* Border bars */}
          <mesh position={[0, 0.95, 0.01]}>
            <planeGeometry args={[3.2, 0.08]} />
            <meshBasicMaterial color={h.color} side={THREE.DoubleSide} />
          </mesh>
          <mesh position={[0, -0.95, 0.01]}>
            <planeGeometry args={[3.2, 0.08]} />
            <meshBasicMaterial color={h.color} side={THREE.DoubleSide} />
          </mesh>
          {/* Inner scan lines */}
          {[-0.4, 0, 0.4].map((y, k) => (
            <mesh key={k} position={[0, y, 0.02]}>
              <planeGeometry args={[2.6, 0.04]} />
              <meshBasicMaterial
                color={"#ffffff"}
                transparent
                opacity={0.4}
                side={THREE.DoubleSide}
              />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
};

// ---------- Speed lines streaking past camera at high speed ----------
const SpeedLines = ({ refs }: { refs: SharedRefs }) => {
  const NUM = 25;
  const groupRef = useRef<THREE.Group>(null);
  const linesData = useMemo(() => {
    return new Array(NUM).fill(0).map(() => ({
      x: (Math.random() - 0.5) * 30,
      y: 1 + Math.random() * 8,
      z: Math.random() * 80 - 40,
    }));
  }, []);
  // Shared geometry & material (one instance for all lines)
  const geom = useMemo(() => new THREE.PlaneGeometry(0.05, 4), []);
  const sharedMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    [],
  );
  useFrame((_, dt) => {
    const speed = refs.speedRef.current;
    const intensity = Math.max(
      0,
      (speed - BASE_SPEED) / (NITRO_MAX_SPEED - BASE_SPEED),
    );
    sharedMat.opacity = intensity * 0.75;
    if (!groupRef.current) return;
    const move = speed * dt * 1.6;
    groupRef.current.children.forEach((child) => {
      const m = child as THREE.Mesh;
      m.position.z -= move;
      if (m.position.z < -20) {
        m.position.z = 60 + Math.random() * 20;
        m.position.x = (Math.random() - 0.5) * 30;
        m.position.y = 1 + Math.random() * 8;
      }
    });
  });
  return (
    <group ref={groupRef}>
      {linesData.map((d, i) => (
        <mesh
          key={i}
          position={[d.x, d.y, d.z]}
          geometry={geom}
          material={sharedMat}
        />
      ))}
    </group>
  );
};

// ---------- Nitro shockwave ring that pulses out from car when boosting ----------
const NitroShockwave = ({ refs }: { refs: SharedRefs }) => {
  const groupRef = useRef<THREE.Group>(null);
  const ringRefs = useRef<THREE.Mesh[]>([]);
  const NUM_RINGS = 3;
  const rings = useRef(
    new Array(NUM_RINGS).fill(0).map((_, i) => ({
      age: i * 0.4,
      active: false,
    })),
  );
  useFrame((_, dt) => {
    const boosting =
      refs.input.current.nitro &&
      refs.nitroRef.current > 0 &&
      refs.speedRef.current > BASE_SPEED + 5;
    rings.current.forEach((r, i) => {
      if (boosting && !r.active && r.age > 0.3) {
        r.active = true;
        r.age = 0;
      }
      if (r.active) {
        r.age += dt * 1.6;
        if (r.age > 1) {
          r.active = false;
          r.age = 0;
        }
      } else if (boosting) {
        r.age += dt;
      }
      const m = ringRefs.current[i];
      if (m) {
        if (r.active) {
          const s = 0.5 + r.age * 6;
          m.scale.set(s, s, s);
          const mat = m.material as THREE.MeshBasicMaterial;
          mat.opacity = (1 - r.age) * 0.7;
          m.visible = true;
        } else {
          m.visible = false;
        }
      }
    });
    // Position behind car
    if (groupRef.current) {
      groupRef.current.position.x = refs.carXRef.current;
      groupRef.current.position.z = -1.8;
    }
  });
  return (
    <group ref={groupRef} position={[0, 0.5, -1.8]}>
      {new Array(NUM_RINGS).fill(0).map((_, i) => (
        <mesh
          key={i}
          ref={(m) => {
            if (m) ringRefs.current[i] = m;
          }}
          rotation={[Math.PI / 2, 0, 0]}
          visible={false}
        >
          <ringGeometry args={[0.4, 0.55, 32]} />
          <meshBasicMaterial
            color={i % 2 === 0 ? "#00f6ff" : "#ff2bd1"}
            transparent
            opacity={0}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
};

// ---------- Postprocessing stack: bloom + vignette (lightweight) ----------
const PostFX = () => {
  return (
    <EffectComposer multisampling={0}>
      <Bloom
        intensity={1.0}
        luminanceThreshold={0.45}
        luminanceSmoothing={0.5}
        radius={0.6}
      />
      <Vignette eskil={false} offset={0.22} darkness={0.85} />
    </EffectComposer>
  );
};

// ---------- Overhead neon arches you fly through ----------
const NeonArches = ({ refs }: { refs: SharedRefs }) => {
  const NUM = 4;
  const SPACING = 140;
  const arches = useMemo(() => {
    return new Array(NUM).fill(0).map((_, i) => ({
      z: i * SPACING + 40,
      colorA: i % 2 === 0 ? "#00f6ff" : "#ff2bd1",
      colorB: i % 2 === 0 ? "#ff2bd1" : "#00f6ff",
      phase: Math.random() * Math.PI * 2,
    }));
  }, []);
  const groupRefs = useRef<THREE.Group[]>([]);
  const matRefs = useRef<THREE.MeshBasicMaterial[]>([]);
  useFrame((state) => {
    const playerZ = refs.distanceRef.current;
    const t = state.clock.elapsedTime;
    arches.forEach((a, i) => {
      const g = groupRefs.current[i];
      if (!g) return;
      const relZ = a.z - playerZ;
      if (relZ < -40) a.z += NUM * SPACING;
      if (relZ > NUM * SPACING) a.z -= NUM * SPACING;
      g.position.z = a.z - playerZ;
      // pulse the inner ring
      const m = matRefs.current[i];
      if (m) {
        m.opacity = 0.55 + 0.4 * Math.sin(t * 4 + a.phase);
      }
    });
  });
  return (
    <group>
      {arches.map((a, i) => (
        <group
          key={i}
          ref={(g) => {
            if (g) groupRefs.current[i] = g;
          }}
          position={[0, 0, a.z]}
        >
          {/* Top horizontal beam */}
          <mesh position={[0, 9, 0]}>
            <boxGeometry args={[18, 0.5, 1.2]} />
            <meshStandardMaterial
              color={"#1a0d2a"}
              metalness={0.7}
              roughness={0.4}
              emissive={a.colorA}
              emissiveIntensity={0.4}
            />
          </mesh>
          {/* Glowing inner band on the beam */}
          <mesh position={[0, 8.65, 0.62]}>
            <boxGeometry args={[17.5, 0.18, 0.05]} />
            <meshBasicMaterial
              ref={(m) => {
                if (m) matRefs.current[i] = m;
              }}
              color={a.colorA}
              transparent
              opacity={0.8}
            />
          </mesh>
          {/* Side pillars */}
          {[-9, 9].map((x) => (
            <group key={x} position={[x, 0, 0]}>
              <mesh position={[0, 4.5, 0]}>
                <boxGeometry args={[0.6, 9, 0.8]} />
                <meshStandardMaterial
                  color={"#1a0d2a"}
                  metalness={0.7}
                  roughness={0.4}
                  emissive={a.colorB}
                  emissiveIntensity={0.5}
                />
              </mesh>
              <mesh position={[Math.sign(x) * 0.31, 4.5, 0]}>
                <boxGeometry args={[0.05, 8.6, 0.18]} />
                <meshBasicMaterial color={a.colorB} />
              </mesh>
              {/* Base footing */}
              <mesh position={[0, 0.2, 0]}>
                <boxGeometry args={[1.2, 0.4, 1.4]} />
                <meshStandardMaterial color={"#08050f"} metalness={0.6} roughness={0.5} />
              </mesh>
            </group>
          ))}
          {/* Cross hanging banner */}
          <mesh position={[0, 7.6, 0.4]}>
            <planeGeometry args={[6, 0.6]} />
            <meshBasicMaterial color={a.colorA} transparent opacity={0.5} />
          </mesh>
        </group>
      ))}
    </group>
  );
};

// ---------- Lightning storm: occasional sky flashes + directional light ----------
const LightningStorm = () => {
  const lightRef = useRef<THREE.DirectionalLight>(null);
  const flashRef = useRef<THREE.Mesh>(null);
  const stateRef = useRef({ next: 4, t: 0, intensity: 0, x: 1 });
  useFrame((_, dt) => {
    const s = stateRef.current;
    s.t += dt;
    if (s.t > s.next) {
      s.t = 0;
      s.next = 5 + Math.random() * 8;
      s.intensity = 1;
      s.x = Math.random() < 0.5 ? -1 : 1;
    }
    s.intensity = Math.max(0, s.intensity - dt * 4);
    // Multi-flicker pattern
    const flicker = s.intensity > 0.2
      ? s.intensity * (0.5 + 0.5 * Math.sin(s.t * 80))
      : s.intensity;
    if (lightRef.current) {
      lightRef.current.intensity = flicker * 4;
      lightRef.current.position.set(s.x * 200, 200, -200);
    }
    if (flashRef.current) {
      const mat = flashRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = flicker * 0.45;
      flashRef.current.position.set(s.x * 180, 90, -270);
    }
  });
  return (
    <group>
      <directionalLight
        ref={lightRef}
        color={"#bfeaff"}
        intensity={0}
        position={[200, 200, -200]}
      />
      {/* Fake bright cloud where the lightning is */}
      <mesh ref={flashRef} position={[180, 90, -270]}>
        <planeGeometry args={[200, 120]} />
        <meshBasicMaterial
          color={"#dff7ff"}
          transparent
          opacity={0}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
};

// ---------- Floating embers / atmospheric particles ----------
const Embers = ({ refs }: { refs: SharedRefs }) => {
  const NUM = 80;
  const pointsRef = useRef<THREE.Points>(null);
  const positions = useMemo(() => {
    const arr = new Float32Array(NUM * 3);
    for (let i = 0; i < NUM; i++) {
      arr[i * 3 + 0] = (Math.random() - 0.5) * 80;
      arr[i * 3 + 1] = Math.random() * 20 + 1;
      arr[i * 3 + 2] = Math.random() * 200 - 50;
    }
    return arr;
  }, []);
  const velocities = useMemo(() => {
    const arr = new Float32Array(NUM * 3);
    for (let i = 0; i < NUM; i++) {
      arr[i * 3 + 0] = (Math.random() - 0.5) * 0.8;
      arr[i * 3 + 1] = 0.4 + Math.random() * 0.6;
      arr[i * 3 + 2] = (Math.random() - 0.5) * 0.4;
    }
    return arr;
  }, []);
  useFrame((_, dt) => {
    const geom = pointsRef.current?.geometry;
    if (!geom) return;
    const attr = geom.attributes.position as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const speed = refs.speedRef.current;
    for (let i = 0; i < NUM; i++) {
      arr[i * 3 + 0] += velocities[i * 3 + 0] * dt;
      arr[i * 3 + 1] += velocities[i * 3 + 1] * dt;
      // particles get pushed back relative to player movement
      arr[i * 3 + 2] += velocities[i * 3 + 2] * dt - speed * dt * 0.55;
      // recycle
      if (arr[i * 3 + 2] < -30) {
        arr[i * 3 + 0] = (Math.random() - 0.5) * 80;
        arr[i * 3 + 1] = 0.5 + Math.random() * 4;
        arr[i * 3 + 2] = 150 + Math.random() * 60;
      }
      if (arr[i * 3 + 1] > 22) {
        arr[i * 3 + 1] = 0.5;
      }
    }
    attr.needsUpdate = true;
  });
  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[positions, 3]}
        />
      </bufferGeometry>
      <pointsMaterial
        size={0.18}
        color={"#ffae3a"}
        transparent
        opacity={0.85}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        sizeAttenuation
      />
    </points>
  );
};

// ---------- Boost trail: bright streaks behind car when nitroing ----------
const BoostTrail = ({ refs }: { refs: SharedRefs }) => {
  const groupRef = useRef<THREE.Group>(null);
  const matRefs = useRef<THREE.MeshBasicMaterial[]>([]);
  const HISTORY = 10;
  const history = useRef(
    new Array(HISTORY).fill(0).map(() => ({ x: 0, age: 999 })),
  );
  const tickRef = useRef(0);
  useFrame((_, dt) => {
    const boosting =
      refs.input.current.nitro &&
      refs.nitroRef.current > 0 &&
      refs.speedRef.current > BASE_SPEED + 5;
    tickRef.current += dt;
    if (boosting && tickRef.current > 0.05) {
      tickRef.current = 0;
      // Push new history entry at current car x
      history.current.unshift({ x: refs.carXRef.current, age: 0 });
      history.current.pop();
    }
    history.current.forEach((h, i) => {
      h.age += dt;
      const m = matRefs.current[i];
      const g = groupRef.current?.children[i];
      if (!m || !g) return;
      const fade = Math.max(0, 1 - h.age * 1.6);
      m.opacity = fade * 0.85;
      g.position.x = h.x;
      g.position.y = 0.45;
      g.position.z = -2 - i * 1.4;
      const mesh = g as THREE.Mesh;
      mesh.scale.x = 0.3 + (1 - fade) * 0.6;
    });
  });
  return (
    <group ref={groupRef}>
      {new Array(HISTORY).fill(0).map((_, i) => (
        <mesh key={i} position={[0, 0.45, -2 - i * 1.4]}>
          <planeGeometry args={[1.6, 1.0]} />
          <meshBasicMaterial
            ref={(m) => {
              if (m) matRefs.current[i] = m;
            }}
            color={i % 2 === 0 ? "#00f6ff" : "#ff2bd1"}
            transparent
            opacity={0}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
};

// ---------- Top-level Scene ----------
const Scene = ({ refs, car }: { refs: SharedRefs; car: Car }) => {
  return (
    <>
      <fog attach="fog" args={["#0a0420", 30, 240]} />
      <color attach="background" args={["#04031a"]} />
      <Lights />
      <LightningStorm />
      <Sky />
      <DistantSkyline />
      <NeonGrid refs={refs} />
      <Road refs={refs} />
      <Buildings refs={refs} />
      <NeonArches refs={refs} />
      <Holograms refs={refs} />
      <Drones refs={refs} />
      <Embers refs={refs} />
      <Traffic refs={refs} />
      <Pickups refs={refs} />
      <PlayerCar refs={refs} car={car} />
      <BoostTrail refs={refs} />
      <NitroShockwave refs={refs} />
      <SpeedLines refs={refs} />
      <CameraFollow refs={refs} />
      <GameLogic refs={refs} />
      <PostFX />
    </>
  );
};

// ---------- HUD overlay ----------
const HUD = ({
  state,
  speedRef,
  distanceRef,
  nitroRef,
  bestRef,
  driftScoreRef,
  shieldRef,
  multiplierTimerRef,
  comboRef,
  comboPulseRef,
  pickupTakenRef,
  onStart,
  onRestart,
  isMobile,
  input,
  muted,
  onToggleMute,
  showTouch,
  onToggleTouch,
  mode,
  onSelectMode,
  carId,
  onSelectCar,
}: {
  state: GameState;
  speedRef: React.MutableRefObject<number>;
  distanceRef: React.MutableRefObject<number>;
  nitroRef: React.MutableRefObject<number>;
  bestRef: React.MutableRefObject<number>;
  driftScoreRef: React.MutableRefObject<number>;
  shieldRef: React.MutableRefObject<number>;
  multiplierTimerRef: React.MutableRefObject<number>;
  comboRef: React.MutableRefObject<number>;
  comboPulseRef: React.MutableRefObject<number>;
  pickupTakenRef: React.MutableRefObject<{ kind: PickupKind | null; pulse: number }>;
  onStart: () => void;
  onRestart: () => void;
  isMobile: boolean;
  input: React.MutableRefObject<InputState>;
  muted: boolean;
  onToggleMute: () => void;
  showTouch: boolean;
  onToggleTouch: () => void;
  mode: GameMode;
  onSelectMode: (m: GameMode) => void;
  carId: string;
  onSelectCar: (id: string) => void;
}) => {
  const selectedCar = CARS_BY_ID[carId] ?? CARS[0];
  const carIndex = Math.max(
    0,
    CARS.findIndex((c) => c.id === selectedCar.id),
  );
  const goPrevCar = () => {
    const i = (carIndex - 1 + CARS.length) % CARS.length;
    onSelectCar(CARS[i].id);
  };
  const goNextCar = () => {
    const i = (carIndex + 1) % CARS.length;
    onSelectCar(CARS[i].id);
  };
  const speedEl = useRef<HTMLDivElement>(null);
  const distEl = useRef<HTMLDivElement>(null);
  const nitroEl = useRef<HTMLDivElement>(null);
  const finalDistEl = useRef<HTMLSpanElement>(null);
  const finalSpeedEl = useRef<HTMLSpanElement>(null);
  const bestEl = useRef<HTMLSpanElement>(null);
  const driftScoreEl = useRef<HTMLDivElement>(null);
  const finalDriftEl = useRef<HTMLSpanElement>(null);
  // Power-up + combo HUD elements
  const powerupsEl = useRef<HTMLDivElement>(null);
  const shieldPillEl = useRef<HTMLDivElement>(null);
  const shieldCountEl = useRef<HTMLSpanElement>(null);
  const multiPillEl = useRef<HTMLDivElement>(null);
  const multiBarEl = useRef<HTMLDivElement>(null);
  const multiTimeEl = useRef<HTMLSpanElement>(null);
  const comboEl = useRef<HTMLDivElement>(null);
  const comboNumEl = useRef<HTMLSpanElement>(null);
  const pickupFlashEl = useRef<HTMLDivElement>(null);

  const cfg = MODE_CONFIGS[mode];
  const isDriftMode = cfg.driftScoring;

  // Update HUD via raf so it doesn't trigger React renders
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      if (speedEl.current) {
        const kph = Math.round(speedRef.current * 3.6);
        speedEl.current.textContent = String(kph).padStart(3, "0");
      }
      if (distEl.current) {
        distEl.current.textContent =
          (distanceRef.current / 1000).toFixed(2) + " KM";
      }
      if (nitroEl.current) {
        nitroEl.current.style.width = nitroRef.current.toFixed(1) + "%";
      }
      if (driftScoreEl.current) {
        driftScoreEl.current.textContent =
          Math.round(driftScoreRef.current).toLocaleString() + " PTS";
      }
      if (finalDistEl.current) {
        finalDistEl.current.textContent =
          (distanceRef.current / 1000).toFixed(2) + " KM";
      }
      if (finalSpeedEl.current) {
        finalSpeedEl.current.textContent =
          Math.round(speedRef.current * 3.6) + " KPH";
      }
      if (finalDriftEl.current) {
        finalDriftEl.current.textContent =
          Math.round(driftScoreRef.current).toLocaleString() + " PTS";
      }
      if (bestEl.current) {
        bestEl.current.textContent = isDriftMode
          ? Math.round(bestRef.current).toLocaleString() + " PTS"
          : (bestRef.current / 1000).toFixed(2) + " KM";
      }

      // ----- Power-up status pills -----
      const shield = shieldRef.current;
      const multi = multiplierTimerRef.current;
      const combo = comboRef.current;
      const cPulse = comboPulseRef.current;

      // Shield pill: hidden when 0 charges
      if (shieldPillEl.current) {
        shieldPillEl.current.style.opacity = shield > 0 ? "1" : "0";
        shieldPillEl.current.style.transform =
          shield > 0 ? "translateY(0)" : "translateY(6px)";
      }
      if (shieldCountEl.current) {
        shieldCountEl.current.textContent = shield > 1 ? `×${shield}` : "";
      }

      // Multiplier pill: hidden when timer is 0
      if (multiPillEl.current) {
        multiPillEl.current.style.opacity = multi > 0 ? "1" : "0";
        multiPillEl.current.style.transform =
          multi > 0 ? "translateY(0)" : "translateY(6px)";
      }
      if (multiBarEl.current) {
        // 8s max; show drain bar
        const pct = Math.min(100, (multi / 8) * 100);
        multiBarEl.current.style.width = pct.toFixed(1) + "%";
      }
      if (multiTimeEl.current) {
        multiTimeEl.current.textContent = multi > 0 ? multi.toFixed(1) + "s" : "";
      }

      // Combo counter — appears at 2+ near misses, scales/glows on pulse
      if (comboEl.current) {
        const visible = combo >= 2;
        comboEl.current.style.opacity = visible ? "1" : "0";
        const scale = visible ? 1 + cPulse * 0.35 : 0.85;
        comboEl.current.style.transform = `translate(-50%, 0) scale(${scale.toFixed(3)})`;
        const glow = 8 + cPulse * 26;
        comboEl.current.style.textShadow = `0 0 ${glow}px #ff2bd1, 0 0 ${glow * 1.5}px #ff2bd1`;
      }
      if (comboNumEl.current) {
        comboNumEl.current.textContent = "×" + combo;
      }

      // Pickup flash text near top of screen
      const pk = pickupTakenRef.current;
      if (pickupFlashEl.current) {
        const p = pk.pulse;
        pickupFlashEl.current.style.opacity = p > 0 ? p.toFixed(3) : "0";
        pickupFlashEl.current.style.transform =
          `translate(-50%, ${(1 - p) * -10}px) scale(${(1 + p * 0.18).toFixed(3)})`;
        if (p > 0 && pk.kind) {
          const labels: Record<PickupKind, string> = {
            nitro: "+ NITRO",
            multiplier: "× 2 SCORE",
            shield: "SHIELD UP",
          };
          const colors: Record<PickupKind, string> = {
            nitro: "#7ff7ff",
            multiplier: "#ffe600",
            shield: "#ff2bd1",
          };
          pickupFlashEl.current.textContent = labels[pk.kind];
          pickupFlashEl.current.style.color = colors[pk.kind];
          pickupFlashEl.current.style.textShadow = `0 0 12px ${colors[pk.kind]}, 0 0 24px ${colors[pk.kind]}`;
        }
      }

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [
    speedRef,
    distanceRef,
    nitroRef,
    bestRef,
    driftScoreRef,
    isDriftMode,
    shieldRef,
    multiplierTimerRef,
    comboRef,
    comboPulseRef,
    pickupTakenRef,
  ]);

  // Touch button handlers
  const press = useCallback(
    (key: "left" | "right" | "drift" | "nitro", down: boolean) => {
      const i = input.current;
      if (key === "left") i.steer = down ? -1 : 0;
      if (key === "right") i.steer = down ? 1 : 0;
      if (key === "drift") i.drift = down;
      if (key === "nitro") i.nitro = down;
    },
    [input],
  );

  // Pointer-event handlers for touch buttons (work with finger, mouse, pen)
  const pointer = useCallback(
    (key: "left" | "right" | "drift" | "nitro") => ({
      onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* noop */
        }
        press(key, true);
      },
      onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        press(key, false);
      },
      onPointerCancel: () => press(key, false),
      onPointerLeave: (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.buttons === 0) return;
        press(key, false);
      },
      onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    }),
    [press],
  );

  return (
    <div className="hud">
      {/* Top-right corner buttons: mute + touch controls toggle */}
      <div
        className="absolute top-3 right-3 z-50 flex flex-col gap-2 pointer-events-auto"
        style={{ marginTop: state === "playing" ? "70px" : "0" }}
      >
        <button
          type="button"
          onClick={onToggleMute}
          title={muted ? "Unmute" : "Mute"}
          className="glass rounded-full w-10 h-10 flex items-center justify-center"
          style={{
            color: muted ? "#ff5577" : "#7ff7ff",
            textShadow: muted ? "0 0 8px #ff5577" : "0 0 8px #7ff7ff",
            fontSize: "18px",
            lineHeight: 1,
          }}
        >
          {muted ? "🔇" : "🔊"}
        </button>
        <button
          type="button"
          onClick={onToggleTouch}
          title={showTouch ? "Hide touch controls" : "Show touch controls"}
          className="glass rounded-full w-10 h-10 flex items-center justify-center"
          style={{
            color: showTouch ? "#ff2bd1" : "#7ff7ff",
            textShadow: showTouch ? "0 0 8px #ff2bd1" : "0 0 8px #7ff7ff",
            fontSize: "16px",
            lineHeight: 1,
          }}
        >
          🎮
        </button>
      </div>

      {/* Top bar */}
      {state === "playing" && (
        <div className="absolute top-3 left-3 right-3 flex items-start justify-between">
          <div className="glass rounded-lg px-4 py-2">
            <div className="text-[10px] tracking-[0.3em] neon-cyan opacity-80">
              DISTANCE
            </div>
            <div
              ref={distEl}
              className="text-2xl font-extrabold neon-text neon-cyan"
            >
              0.00 KM
            </div>
            {isDriftMode && (
              <>
                <div
                  className="text-[10px] tracking-[0.3em] mt-1"
                  style={{ color: cfg.color, opacity: 0.85 }}
                >
                  DRIFT SCORE
                </div>
                <div
                  ref={driftScoreEl}
                  className="text-xl font-extrabold neon-text"
                  style={{
                    color: cfg.color,
                    textShadow: `0 0 8px ${cfg.color}, 0 0 16px ${cfg.color}`,
                  }}
                >
                  0 PTS
                </div>
              </>
            )}
          </div>
          <div className="glass rounded-lg px-4 py-2 text-center">
            <div
              className="text-base sm:text-xl font-black tracking-[0.35em] title-glow"
              style={{ fontFamily: "Orbitron, sans-serif" }}
            >
              LUCIDEX RACING
            </div>
            <div
              className="text-[10px] tracking-[0.3em] opacity-90 mt-0.5"
              style={{ color: cfg.color, textShadow: `0 0 6px ${cfg.color}` }}
            >
              MODE · {cfg.label}
            </div>
          </div>
          <div className="glass rounded-lg px-4 py-2 text-right">
            <div className="text-[10px] tracking-[0.3em] neon-pink opacity-80">
              BEST
            </div>
            <div className="text-2xl font-extrabold neon-text neon-pink">
              <span ref={bestEl}>{isDriftMode ? "0 PTS" : "0.00 KM"}</span>
            </div>
          </div>
        </div>
      )}

      {/* Power-up status pills (under top-left distance card) */}
      {state === "playing" && (
        <div
          ref={powerupsEl}
          className="absolute left-3 top-[88px] flex flex-col gap-2"
          style={{ pointerEvents: "none", zIndex: 40 }}
        >
          {/* Shield pill */}
          <div
            ref={shieldPillEl}
            className="glass rounded-full px-3 py-1.5 flex items-center gap-2 transition-all duration-200"
            style={{
              opacity: 0,
              borderColor: "rgba(255, 43, 209, 0.55)",
              boxShadow: "0 0 14px rgba(255, 43, 209, 0.45)",
            }}
          >
            <span style={{ fontSize: "16px" }}>🛡</span>
            <span
              className="text-[10px] tracking-[0.25em] font-bold"
              style={{ color: "#ff2bd1", textShadow: "0 0 8px #ff2bd1" }}
            >
              SHIELD
            </span>
            <span
              ref={shieldCountEl}
              className="text-[11px] font-extrabold"
              style={{ color: "#ff2bd1" }}
            />
          </div>
          {/* Multiplier pill (with drain bar) */}
          <div
            ref={multiPillEl}
            className="glass rounded-full px-3 py-1.5 flex items-center gap-2 transition-all duration-200"
            style={{
              opacity: 0,
              minWidth: "150px",
              borderColor: "rgba(255, 230, 0, 0.55)",
              boxShadow: "0 0 14px rgba(255, 230, 0, 0.45)",
            }}
          >
            <span
              className="text-[12px] font-black tracking-[0.18em]"
              style={{ color: "#ffe600", textShadow: "0 0 8px #ffe600" }}
            >
              ×2
            </span>
            <div
              className="flex-1 h-1.5 rounded-full overflow-hidden"
              style={{ background: "rgba(255,230,0,0.18)" }}
            >
              <div
                ref={multiBarEl}
                className="h-full rounded-full"
                style={{
                  background:
                    "linear-gradient(90deg, #ffe600, #fff175)",
                  boxShadow: "0 0 8px #ffe600",
                  width: "0%",
                  transition: "width 0.12s linear",
                }}
              />
            </div>
            <span
              ref={multiTimeEl}
              className="text-[10px] tabular-nums font-bold"
              style={{ color: "#ffe600", minWidth: "32px", textAlign: "right" }}
            />
          </div>
        </div>
      )}

      {/* Combo counter — center-top, glows pink */}
      {state === "playing" && (
        <div
          ref={comboEl}
          className="absolute left-1/2 select-none"
          style={{
            top: "calc(50% - 80px)",
            transform: "translate(-50%, 0) scale(0.85)",
            opacity: 0,
            color: "#ff2bd1",
            fontFamily: "Orbitron, sans-serif",
            fontWeight: 900,
            fontSize: "44px",
            letterSpacing: "0.08em",
            textShadow: "0 0 12px #ff2bd1, 0 0 24px #ff2bd1",
            transition: "opacity 0.18s ease",
            pointerEvents: "none",
            zIndex: 40,
          }}
        >
          COMBO <span ref={comboNumEl}>×0</span>
        </div>
      )}

      {/* Pickup flash text — appears briefly above the combo */}
      {state === "playing" && (
        <div
          ref={pickupFlashEl}
          className="absolute left-1/2 select-none"
          style={{
            top: "calc(50% - 140px)",
            transform: "translate(-50%, 0)",
            opacity: 0,
            color: "#7ff7ff",
            fontFamily: "Orbitron, sans-serif",
            fontWeight: 900,
            fontSize: "26px",
            letterSpacing: "0.18em",
            textShadow: "0 0 12px #7ff7ff",
            pointerEvents: "none",
            zIndex: 40,
          }}
        />
      )}

      {/* Bottom HUD: speedometer + nitro */}
      {state === "playing" && (
        <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between gap-3">
          {/* Speedometer */}
          <div className="glass rounded-2xl px-5 py-3 min-w-[180px]">
            <div className="text-[10px] tracking-[0.3em] neon-cyan opacity-80">
              SPEED
            </div>
            <div className="flex items-baseline gap-2">
              <div
                ref={speedEl}
                className="text-5xl sm:text-6xl font-black neon-text neon-cyan tabular-nums"
                style={{ fontFamily: "Orbitron, sans-serif" }}
              >
                000
              </div>
              <div className="text-xs tracking-[0.25em] neon-cyan opacity-80">
                KPH
              </div>
            </div>
          </div>

          {/* On-screen controls (touch / mouse / pen) */}
          {state === "playing" && showTouch && (
            <>
              {/* Left thumb cluster: steering arrows */}
              <div className="touch-cluster touch-cluster-left">
                <div className="touch-btn" {...pointer("left")}>◀</div>
                <div className="touch-btn" {...pointer("right")}>▶</div>
              </div>
              {/* Right thumb cluster: drift + nitro */}
              <div className="touch-cluster touch-cluster-right">
                <div className="touch-btn pink" {...pointer("drift")}>
                  DRIFT
                </div>
                <div className="touch-btn yellow" {...pointer("nitro")}>
                  NITRO
                </div>
              </div>
            </>
          )}

          {/* Nitro gauge */}
          <div className="glass rounded-2xl px-5 py-3 min-w-[180px]">
            <div className="flex items-center justify-between">
              <div className="text-[10px] tracking-[0.3em] neon-yellow opacity-80">
                NITRO
              </div>
              <div className="text-[10px] tracking-[0.3em] neon-yellow opacity-80">
                [SPACE]
              </div>
            </div>
            <div className="gauge-bar mt-2 neon-yellow">
              <div ref={nitroEl} className="gauge-fill" style={{ width: "100%" }} />
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-[10px] tracking-[0.3em] neon-pink opacity-80">
                DRIFT [SHIFT]
              </span>
            </div>
          </div>
        </div>
      )}

      {/* MENU */}
      {state === "menu" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6">
          <div className="absolute inset-0 bg-black/55" />
          <div className="relative z-10 max-w-xl">
            <div
              className="text-[10px] sm:text-xs tracking-[0.6em] neon-cyan opacity-80 mb-3"
              style={{ fontFamily: "Orbitron, sans-serif" }}
            >
              NEO TOKYO • 2099 • ROUTE 7
            </div>
            <h1
              className="text-5xl sm:text-7xl font-black title-glow pulse-neon"
              style={{ fontFamily: "Orbitron, sans-serif", letterSpacing: "0.15em" }}
            >
              LUCIDEX
            </h1>
            <h2
              className="text-3xl sm:text-5xl font-black neon-text neon-pink mt-1"
              style={{ fontFamily: "Orbitron, sans-serif", letterSpacing: "0.5em" }}
            >
              RACING
            </h2>
            <p className="mt-6 text-sm sm:text-base text-cyan-100/80 leading-relaxed">
              Outrun the chrome city. Drift through neon traffic, ignite the nitro,
              and chase your distance record before the grid catches you.
            </p>

            <div className="mt-7">
              <div className="text-[10px] tracking-[0.5em] neon-cyan opacity-80 mb-2">
                SELECT MODE
              </div>
              <div className="grid grid-cols-4 gap-2">
                {(Object.keys(MODE_CONFIGS) as GameMode[]).map((m) => {
                  const c = MODE_CONFIGS[m];
                  const active = m === mode;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => onSelectMode(m)}
                      className="glass rounded-lg py-2 text-[11px] sm:text-xs font-bold tracking-[0.2em] pointer-events-auto transition-transform"
                      style={{
                        color: c.color,
                        border: active
                          ? `1px solid ${c.color}`
                          : "1px solid rgba(255,255,255,0.08)",
                        boxShadow: active
                          ? `0 0 14px ${c.color}, inset 0 0 14px ${c.color}33`
                          : "none",
                        textShadow: `0 0 6px ${c.color}`,
                        transform: active ? "translateY(-1px)" : "none",
                        fontFamily: "Orbitron, sans-serif",
                      }}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
              <div
                className="mt-2 text-[10px] tracking-[0.25em] opacity-80"
                style={{ color: cfg.color, textShadow: `0 0 6px ${cfg.color}` }}
              >
                {mode === "easy" &&
                  "RELAXED PACE · LIGHT TRAFFIC · EASY NITRO"}
                {mode === "medium" && "BALANCED RUN · CLASSIC NEO TOKYO"}
                {mode === "hard" &&
                  "DENSE TRAFFIC · FAST RIVALS · TIGHT NITRO"}
                {mode === "drift" &&
                  "DRIFT TO SCORE · DRIFTS REFILL NITRO · POINTS = BEST"}
              </div>
            </div>

            {/* ---------- Car selector ---------- */}
            <div className="mt-6">
              <div className="text-[10px] tracking-[0.5em] neon-pink opacity-80 mb-2">
                SELECT CAR
              </div>
              <div
                className="glass rounded-xl p-3 flex items-center gap-3"
                style={{
                  border: `1px solid ${selectedCar.neon}55`,
                  boxShadow: `0 0 18px ${selectedCar.neon}33, inset 0 0 18px ${selectedCar.neon}1a`,
                }}
              >
                <button
                  type="button"
                  onClick={goPrevCar}
                  className="px-3 py-2 rounded-md font-bold pointer-events-auto"
                  style={{
                    color: selectedCar.neon,
                    background: "rgba(0,0,0,0.35)",
                    border: `1px solid ${selectedCar.neon}55`,
                    textShadow: `0 0 6px ${selectedCar.neon}`,
                  }}
                  aria-label="Previous car"
                >
                  ◀
                </button>

                <div className="flex-1 min-w-0">
                  {/* Car name + index */}
                  <div className="flex items-baseline justify-between gap-2">
                    <div
                      className="text-base sm:text-lg font-bold tracking-[0.2em] truncate"
                      style={{
                        color: selectedCar.neon,
                        textShadow: `0 0 8px ${selectedCar.neon}`,
                        fontFamily: "Orbitron, sans-serif",
                      }}
                    >
                      {selectedCar.name.toUpperCase()}
                    </div>
                    <div className="text-[10px] tracking-[0.3em] opacity-70 flex-shrink-0">
                      {String(carIndex + 1).padStart(2, "0")} /{" "}
                      {String(CARS.length).padStart(2, "0")}
                    </div>
                  </div>

                  {/* Color swatches */}
                  <div className="flex items-center gap-1.5 mt-1.5">
                    {[
                      selectedCar.body,
                      selectedCar.neon,
                      selectedCar.canopy,
                      selectedCar.flameA,
                      selectedCar.flameB,
                    ].map((col, i) => (
                      <span
                        key={i}
                        className="inline-block w-3 h-3 rounded-sm"
                        style={{
                          background: col,
                          boxShadow: `0 0 6px ${col}`,
                        }}
                      />
                    ))}
                  </div>

                  {/* Stat bars */}
                  <div className="grid grid-cols-3 gap-2 mt-2 text-[10px]">
                    {[
                      { label: "SPD", val: selectedCar.speedMul, color: "#ff5722" },
                      { label: "ACC", val: selectedCar.accelMul, color: "#7ff7ff" },
                      { label: "GRIP", val: selectedCar.gripMul, color: "#39ff14" },
                    ].map((s) => {
                      // map ~0.9..1.15 to 0..1
                      const pct = Math.max(
                        0,
                        Math.min(1, (s.val - 0.9) / 0.25),
                      );
                      return (
                        <div key={s.label}>
                          <div className="flex justify-between opacity-80 mb-0.5">
                            <span style={{ color: s.color }}>{s.label}</span>
                            <span className="opacity-70">
                              {s.val.toFixed(2)}
                            </span>
                          </div>
                          <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${pct * 100}%`,
                                background: s.color,
                                boxShadow: `0 0 6px ${s.color}`,
                              }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={goNextCar}
                  className="px-3 py-2 rounded-md font-bold pointer-events-auto"
                  style={{
                    color: selectedCar.neon,
                    background: "rgba(0,0,0,0.35)",
                    border: `1px solid ${selectedCar.neon}55`,
                    textShadow: `0 0 6px ${selectedCar.neon}`,
                  }}
                  aria-label="Next car"
                >
                  ▶
                </button>
              </div>

              {/* Car dot strip */}
              <div className="flex items-center justify-center gap-1.5 mt-2 flex-wrap">
                {CARS.map((c, i) => {
                  const active = c.id === selectedCar.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => onSelectCar(c.id)}
                      className="pointer-events-auto rounded-full transition-all"
                      title={c.name}
                      style={{
                        width: active ? 12 : 8,
                        height: active ? 12 : 8,
                        background: c.neon,
                        boxShadow: active
                          ? `0 0 8px ${c.neon}, 0 0 14px ${c.neon}`
                          : `0 0 4px ${c.neon}88`,
                        opacity: active ? 1 : 0.55,
                        border: active
                          ? `1px solid ${c.canopy}`
                          : "1px solid transparent",
                      }}
                      aria-label={`Select ${c.name} (car ${i + 1})`}
                    />
                  );
                })}
              </div>
            </div>

            <button className="menu-btn mt-6" onClick={onStart}>
              ▶ Start Race
            </button>

            <div className="mt-8 grid grid-cols-2 gap-4 text-xs sm:text-sm text-cyan-100/85">
              <div className="glass rounded-lg p-3 text-left">
                <div className="neon-cyan font-bold tracking-widest mb-2">
                  KEYBOARD
                </div>
                <div>← → · Steer</div>
                <div>SHIFT · Drift</div>
                <div>SPACE · Nitro</div>
              </div>
              <div className="glass rounded-lg p-3 text-left">
                <div className="neon-pink font-bold tracking-widest mb-2">
                  TOUCH
                </div>
                <div>Tap ◀ ▶ to steer</div>
                <div>Tap DRIFT to slide</div>
                <div>Tap NITRO to boost</div>
                <div className="mt-1 opacity-70 text-[10px] tracking-widest">
                  TAP 🎮 TO {showTouch ? "HIDE" : "SHOW"} ON-SCREEN
                </div>
              </div>
            </div>

            {/* Pickups + combo legend */}
            <div className="mt-4 glass rounded-lg p-3 text-left text-xs sm:text-sm">
              <div className="neon-yellow font-bold tracking-widest mb-2">
                PICKUPS &amp; COMBO
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block w-3 h-3 rounded-full"
                    style={{
                      background: "#7ff7ff",
                      boxShadow: "0 0 10px #7ff7ff",
                    }}
                  />
                  <span style={{ color: "#7ff7ff" }}>NITRO refill</span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block w-3 h-3 rounded-full"
                    style={{
                      background: "#ffe600",
                      boxShadow: "0 0 10px #ffe600",
                    }}
                  />
                  <span style={{ color: "#ffe600" }}>×2 SCORE 5s</span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block w-3 h-3 rounded-full"
                    style={{
                      background: "#ff2bd1",
                      boxShadow: "0 0 10px #ff2bd1",
                    }}
                  />
                  <span style={{ color: "#ff2bd1" }}>SHIELD (+1 hit)</span>
                </div>
              </div>
              <div className="mt-2 opacity-80">
                Squeeze past traffic to chain near-miss COMBOs.
              </div>
            </div>

            {bestRef.current > 0 && (
              <div className="mt-6 text-xs tracking-[0.3em] neon-yellow opacity-90">
                {isDriftMode ? "BEST DRIFT" : "BEST DISTANCE"} ·{" "}
                <span ref={bestEl}>{isDriftMode ? "0 PTS" : "0.00 KM"}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* CRASHED */}
      {state === "crashed" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6">
          <div className="absolute inset-0 bg-black/65" />
          <div className="relative z-10 max-w-md glass rounded-2xl px-8 py-7">
            <h2
              className="text-5xl font-black neon-text neon-pink pulse-neon"
              style={{ fontFamily: "Orbitron, sans-serif", letterSpacing: "0.2em" }}
            >
              CRASHED
            </h2>
            <p className="text-sm text-cyan-100/70 mt-2 tracking-widest">
              SYSTEM RECOVERY · STANDBY
            </p>
            <div
              className="text-[10px] tracking-[0.4em] mt-2 opacity-90"
              style={{ color: cfg.color, textShadow: `0 0 6px ${cfg.color}` }}
            >
              MODE · {cfg.label}
            </div>
            <div className="mt-5 grid grid-cols-2 gap-4 text-left">
              <div>
                <div className="text-[10px] tracking-[0.3em] neon-cyan opacity-80">
                  DISTANCE
                </div>
                <div className="text-2xl font-extrabold neon-text neon-cyan">
                  <span ref={finalDistEl}>0.00 KM</span>
                </div>
              </div>
              <div>
                <div className="text-[10px] tracking-[0.3em] neon-yellow opacity-80">
                  TOP SPEED
                </div>
                <div className="text-2xl font-extrabold neon-text neon-yellow">
                  <span ref={finalSpeedEl}>0 KPH</span>
                </div>
              </div>
            </div>
            {isDriftMode && (
              <div className="mt-4 text-left">
                <div
                  className="text-[10px] tracking-[0.3em] opacity-85"
                  style={{ color: cfg.color }}
                >
                  DRIFT SCORE
                </div>
                <div
                  className="text-3xl font-extrabold neon-text"
                  style={{
                    color: cfg.color,
                    textShadow: `0 0 8px ${cfg.color}, 0 0 16px ${cfg.color}`,
                  }}
                >
                  <span ref={finalDriftEl}>0 PTS</span>
                </div>
              </div>
            )}
            <div className="mt-4 text-[10px] tracking-[0.3em] neon-pink opacity-80">
              BEST · <span ref={bestEl}>{isDriftMode ? "0 PTS" : "0.00 KM"}</span>
            </div>
            <button className="menu-btn mt-6" onClick={onRestart}>
              ↻ Race Again
            </button>
          </div>
        </div>
      )}

      <div className="crt-vignette" />
    </div>
  );
};

// ---------- Main exported component ----------
export default function Game() {
  const [state, setState] = useState<GameState>("menu");
  const [muted, setMutedState] = useState(false);
  const [mode, setMode] = useState<GameMode>("medium");
  const [carId, setCarId] = useState<string>(() => {
    try {
      const v = localStorage.getItem("lucidex.car");
      if (v && CARS_BY_ID[v]) return v;
    } catch {
      /* noop */
    }
    return CARS[0].id;
  });
  const selectedCar = CARS_BY_ID[carId] ?? CARS[0];

  // Shared refs (mutable, no React re-renders)
  const inputRef = useRef<InputState>({ steer: 0, drift: false, nitro: false });
  const speedRef = useRef(0);
  const distanceRef = useRef(0);
  const nitroRef = useRef(100);
  const driftAngleRef = useRef(0);
  const carXRef = useRef(0);
  const crashedRef = useRef(false);
  const bestRef = useRef(0);
  const topSpeedRef = useRef(0);
  const nitroPrevRef = useRef(false);
  const modeRef = useRef<ModeConfig>(MODE_CONFIGS.medium);
  const carRef = useRef<Car>(selectedCar);
  const driftScoreRef = useRef(0);

  // Keep carRef live with the latest selection (used by GameLogic for stats)
  useEffect(() => {
    carRef.current = selectedCar;
    try {
      localStorage.setItem("lucidex.car", selectedCar.id);
    } catch {
      /* noop */
    }
  }, [selectedCar]);

  const onSelectCar = useCallback((id: string) => {
    if (CARS_BY_ID[id]) setCarId(id);
  }, []);
  // Power-up + combo state refs
  const shieldRef = useRef(0);
  const multiplierTimerRef = useRef(0);
  const comboRef = useRef(0);
  const comboTimerRef = useRef(0);
  const comboPulseRef = useRef(0);
  const pickupTakenRef = useRef<{ kind: PickupKind | null; pulse: number }>({
    kind: null,
    pulse: 0,
  });

  // Audio
  const audioRef = useAudioApi();

  // Track top speed + nitro press edge detection
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (speedRef.current > topSpeedRef.current) {
        topSpeedRef.current = speedRef.current;
      }
      // Nitro whoosh on press edge while playing & nitro available
      const pressed = inputRef.current.nitro && nitroRef.current > 5;
      if (
        pressed &&
        !nitroPrevRef.current &&
        state === "playing" &&
        !crashedRef.current
      ) {
        audioRef.current?.triggerNitro();
      }
      nitroPrevRef.current = pressed;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state, audioRef]);

  // Mobile detection + touch-controls toggle
  const [isMobile, setIsMobile] = useState(false);
  const [showTouch, setShowTouch] = useState(false);
  useEffect(() => {
    const hasTouch =
      typeof window !== "undefined" &&
      ("ontouchstart" in window ||
        (navigator.maxTouchPoints && navigator.maxTouchPoints > 0));
    const coarse =
      typeof window !== "undefined" &&
      window.matchMedia("(pointer: coarse)").matches;
    const small =
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 900px)").matches;
    const mobile = Boolean(hasTouch) || coarse || small;
    setIsMobile(mobile);
    let initial = mobile;
    try {
      const v = localStorage.getItem("lucidex.touchControls");
      if (v === "1") initial = true;
      else if (v === "0") initial = false;
    } catch {
      /* noop */
    }
    setShowTouch(initial);
  }, []);

  // Auto-enable touch controls the first time the user actually touches the screen
  useEffect(() => {
    if (showTouch) return;
    const onFirstTouch = () => {
      setShowTouch(true);
      try {
        localStorage.setItem("lucidex.touchControls", "1");
      } catch {
        /* noop */
      }
    };
    window.addEventListener("touchstart", onFirstTouch, {
      passive: true,
      once: true,
    });
    return () => window.removeEventListener("touchstart", onFirstTouch);
  }, [showTouch]);

  const toggleTouch = useCallback(() => {
    setShowTouch((v) => {
      const next = !v;
      try {
        localStorage.setItem("lucidex.touchControls", next ? "1" : "0");
      } catch {
        /* noop */
      }
      return next;
    });
  }, []);

  // Keyboard input
  useEffect(() => {
    const setSteer = () => {
      const left = keysRef.current.has("ArrowLeft") || keysRef.current.has("KeyA");
      const right = keysRef.current.has("ArrowRight") || keysRef.current.has("KeyD");
      inputRef.current.steer = left && !right ? -1 : right && !left ? 1 : 0;
    };
    const keysRef = { current: new Set<string>() };
    const onDown = (e: KeyboardEvent) => {
      const code = e.code;
      keysRef.current.add(code);
      if (code === "ShiftLeft" || code === "ShiftRight") inputRef.current.drift = true;
      if (code === "Space") {
        inputRef.current.nitro = true;
        e.preventDefault();
      }
      if ((code === "Enter" || code === "Space") && state === "menu") {
        e.preventDefault();
        startRace();
      }
      if (code === "Enter" && state === "crashed") restart();
      setSteer();
    };
    const onUp = (e: KeyboardEvent) => {
      const code = e.code;
      keysRef.current.delete(code);
      if (code === "ShiftLeft" || code === "ShiftRight") inputRef.current.drift = false;
      if (code === "Space") inputRef.current.nitro = false;
      setSteer();
    };
    window.addEventListener("keydown", onDown, { passive: false });
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Touch swipe steering on the canvas surface (when not using on-screen buttons)
  useEffect(() => {
    if (!isMobile) return;
    let touchStartX = 0;
    let touchStartY = 0;
    let lastSteerTouchId: number | null = null;
    const onStart = (e: TouchEvent) => {
      // Steering swipe should originate in the upper half of the screen
      // to avoid conflicts with the on-screen control buttons.
      const t = e.changedTouches[0];
      if (!t) return;
      if (t.clientY > window.innerHeight * 0.6) return;
      touchStartX = t.clientX;
      touchStartY = t.clientY;
      lastSteerTouchId = t.identifier;
    };
    const onMove = (e: TouchEvent) => {
      if (lastSteerTouchId === null) return;
      const t = Array.from(e.changedTouches).find(
        (x) => x.identifier === lastSteerTouchId,
      );
      if (!t) return;
      const dx = t.clientX - touchStartX;
      const norm = Math.max(-1, Math.min(1, dx / 90));
      // Apply steering only if vertical movement is small (so it feels like steer)
      const dy = Math.abs(t.clientY - touchStartY);
      if (dy < 100) {
        inputRef.current.steer = norm;
      }
    };
    const onEnd = (e: TouchEvent) => {
      const t = Array.from(e.changedTouches).find(
        (x) => x.identifier === lastSteerTouchId,
      );
      if (!t) return;
      lastSteerTouchId = null;
      inputRef.current.steer = 0;
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [isMobile]);

  const startRace = useCallback(() => {
    const cfg = MODE_CONFIGS[mode];
    modeRef.current = cfg;
    carRef.current = selectedCar;
    const startSpeed = BASE_SPEED * cfg.baseSpeedMul * selectedCar.speedMul;
    speedRef.current = startSpeed;
    distanceRef.current = 0;
    nitroRef.current = 100;
    driftAngleRef.current = 0;
    carXRef.current = 0;
    crashedRef.current = false;
    topSpeedRef.current = startSpeed;
    driftScoreRef.current = 0;
    // Reset all power-up + combo state on each race
    shieldRef.current = 0;
    multiplierTimerRef.current = 0;
    comboRef.current = 0;
    comboTimerRef.current = 0;
    comboPulseRef.current = 0;
    pickupTakenRef.current = { kind: null, pulse: 0 };
    inputRef.current = { steer: 0, drift: false, nitro: false };
    audioRef.current?.resume();
    audioRef.current?.triggerStart();
    setState("playing");
  }, [audioRef, mode, selectedCar]);

  const restart = useCallback(() => {
    startRace();
  }, [startRace]);

  const handleCrash = useCallback(() => {
    const cfg = modeRef.current;
    const score = cfg.driftScoring
      ? driftScoreRef.current
      : distanceRef.current;
    if (score > bestRef.current) {
      bestRef.current = score;
      try {
        localStorage.setItem(`lucidex.best.${mode}`, String(bestRef.current));
      } catch {
        /* noop */
      }
    }
    audioRef.current?.triggerCrash();
    setState("crashed");
  }, [audioRef, mode]);

  const toggleMute = useCallback(() => {
    setMutedState((m) => {
      const next = !m;
      audioRef.current?.setMuted(next);
      try {
        localStorage.setItem("lucidex.muted", next ? "1" : "0");
      } catch {
        /* noop */
      }
      if (!next) audioRef.current?.triggerClick();
      return next;
    });
  }, [audioRef]);

  const handleStartClick = useCallback(() => {
    audioRef.current?.resume();
    audioRef.current?.triggerClick();
    startRace();
  }, [audioRef, startRace]);

  const handleRestartClick = useCallback(() => {
    audioRef.current?.triggerClick();
    restart();
  }, [audioRef, restart]);

  // ---- Power-up + near-miss audio callbacks (pass-through to AudioApi) ----
  const handlePickup = useCallback(
    (kind: PickupKind) => {
      audioRef.current?.triggerPickup(kind);
    },
    [audioRef],
  );
  const handleNearMiss = useCallback(
    (combo: number) => {
      audioRef.current?.triggerNearMiss(combo);
    },
    [audioRef],
  );
  const handleShieldAbsorb = useCallback(() => {
    audioRef.current?.triggerShield();
  }, [audioRef]);

  // Load best (per mode), and migrate the legacy distance key into "medium"
  useEffect(() => {
    try {
      const legacy = localStorage.getItem("lucidex.best");
      if (legacy && !localStorage.getItem("lucidex.best.medium")) {
        localStorage.setItem("lucidex.best.medium", legacy);
      }
      const v = localStorage.getItem(`lucidex.best.${mode}`);
      bestRef.current = v ? Number(v) || 0 : 0;
    } catch {
      bestRef.current = 0;
    }
  }, [mode]);

  // Keep modeRef live with current selection for the next race
  useEffect(() => {
    modeRef.current = MODE_CONFIGS[mode];
  }, [mode]);

  // Engine audio
  useEngineSync(audioRef, speedRef, inputRef, state === "playing");

  const refs: SharedRefs = {
    input: inputRef,
    speedRef,
    distanceRef,
    nitroRef,
    driftAngleRef,
    carXRef,
    crashedRef,
    modeRef,
    carRef,
    driftScoreRef,
    shieldRef,
    multiplierTimerRef,
    comboRef,
    comboTimerRef,
    comboPulseRef,
    pickupTakenRef,
    onCrash: handleCrash,
    onPickup: handlePickup,
    onNearMiss: handleNearMiss,
    onShieldAbsorb: handleShieldAbsorb,
  };

  return (
    <div
      className="fixed inset-0 overflow-hidden scanlines"
      style={{ background: "radial-gradient(circle at 50% 60%, #0a0420, #04030a 60%)" }}
    >
      <Canvas
        shadows={false}
        dpr={[1, 1.4]}
        gl={{ antialias: false, powerPreference: "high-performance" }}
        camera={{ fov: 70, near: 0.1, far: 800, position: [0, 4.5, -8.5] }}
        frameloop={state === "playing" ? "always" : "demand"}
      >
        <Suspense fallback={null}>
          <Scene refs={refs} car={selectedCar} />
        </Suspense>
      </Canvas>

      <HUD
        state={state}
        speedRef={speedRef}
        distanceRef={distanceRef}
        nitroRef={nitroRef}
        bestRef={bestRef}
        driftScoreRef={driftScoreRef}
        shieldRef={shieldRef}
        multiplierTimerRef={multiplierTimerRef}
        comboRef={comboRef}
        comboPulseRef={comboPulseRef}
        pickupTakenRef={pickupTakenRef}
        onStart={handleStartClick}
        onRestart={handleRestartClick}
        isMobile={isMobile}
        input={inputRef}
        muted={muted}
        onToggleMute={toggleMute}
        showTouch={showTouch}
        onToggleTouch={toggleTouch}
        mode={mode}
        onSelectMode={(m) => {
          audioRef.current?.triggerClick();
          setMode(m);
        }}
        carId={carId}
        onSelectCar={(id) => {
          audioRef.current?.triggerClick();
          onSelectCar(id);
        }}
      />
    </div>
  );
}
