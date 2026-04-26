import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  Suspense,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
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
const MAX_TRAFFIC = 14;

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

interface InputState {
  steer: number; // -1 (left) to 1 (right)
  drift: boolean;
  nitro: boolean;
}

interface SharedRefs {
  input: React.MutableRefObject<InputState>;
  speedRef: React.MutableRefObject<number>;
  distanceRef: React.MutableRefObject<number>;
  nitroRef: React.MutableRefObject<number>;
  driftAngleRef: React.MutableRefObject<number>;
  carXRef: React.MutableRefObject<number>;
  crashedRef: React.MutableRefObject<boolean>;
  onCrash: () => void;
}

// ---------- Engine audio (synthesized) ----------
function useEngineAudio(speedRef: React.MutableRefObject<number>, active: boolean) {
  const ctxRef = useRef<AudioContext | null>(null);
  const oscRef = useRef<OscillatorNode | null>(null);
  const subOscRef = useRef<OscillatorNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);

  useEffect(() => {
    if (!active) return;
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new AC();
    ctxRef.current = ctx;

    const gain = ctx.createGain();
    gain.gain.value = 0.0;
    gain.connect(ctx.destination);

    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 80;
    osc.connect(gain);
    osc.start();

    const subOsc = ctx.createOscillator();
    subOsc.type = "square";
    subOsc.frequency.value = 40;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.4;
    subOsc.connect(subGain);
    subGain.connect(gain);
    subOsc.start();

    oscRef.current = osc;
    subOscRef.current = subOsc;
    gainRef.current = gain;

    let raf = 0;
    const tick = () => {
      const speed = speedRef.current;
      const t = Math.min(1, Math.max(0, speed / NITRO_MAX_SPEED));
      const freq = 70 + t * 380;
      if (oscRef.current && gainRef.current && ctxRef.current) {
        oscRef.current.frequency.setTargetAtTime(
          freq,
          ctxRef.current.currentTime,
          0.05,
        );
        if (subOscRef.current) {
          subOscRef.current.frequency.setTargetAtTime(
            freq * 0.5,
            ctxRef.current.currentTime,
            0.05,
          );
        }
        gainRef.current.gain.setTargetAtTime(
          0.06 + t * 0.1,
          ctxRef.current.currentTime,
          0.1,
        );
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      try {
        oscRef.current?.stop();
        subOscRef.current?.stop();
        ctxRef.current?.close();
      } catch {
        /* noop */
      }
      ctxRef.current = null;
      oscRef.current = null;
      subOscRef.current = null;
      gainRef.current = null;
    };
  }, [active, speedRef]);
}

// ---------- Player Car (primitives, cyberpunk styled) ----------
const PlayerCar = ({ refs }: { refs: SharedRefs }) => {
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
        color={"#ff2bd1"}
        intensity={1.6}
        distance={6}
        position={[0, -0.3, 0]}
      />

      {/* Main body — sleek wedge */}
      <mesh castShadow position={[0, 0.45, 0]}>
        <boxGeometry args={[1.7, 0.45, 3.6]} />
        <meshStandardMaterial
          color={"#0a0a18"}
          metalness={0.9}
          roughness={0.18}
          emissive={"#0e0a30"}
          emissiveIntensity={0.5}
        />
      </mesh>
      {/* Hood slope */}
      <mesh position={[0, 0.62, 0.95]} rotation={[-0.18, 0, 0]}>
        <boxGeometry args={[1.55, 0.1, 1.6]} />
        <meshStandardMaterial
          color={"#0a0a18"}
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
          emissive={"#00f6ff"}
          emissiveIntensity={0.18}
        />
      </mesh>
      {/* Roof spoiler ridge */}
      <mesh position={[0, 1.18, -0.3]}>
        <boxGeometry args={[0.18, 0.05, 1.2]} />
        <meshStandardMaterial
          color={"#00f6ff"}
          emissive={"#00f6ff"}
          emissiveIntensity={2.4}
        />
      </mesh>
      {/* Side neon strips */}
      {[-0.86, 0.86].map((x) => (
        <mesh key={x} position={[x, 0.45, 0]}>
          <boxGeometry args={[0.04, 0.06, 3.4]} />
          <meshStandardMaterial
            color={"#ff2bd1"}
            emissive={"#ff2bd1"}
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
        <meshStandardMaterial color={"#161028"} metalness={0.9} roughness={0.4} />
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
          <meshStandardMaterial color={"#0a0a10"} metalness={0.4} roughness={0.6} />
        </mesh>
      ))}
      {/* Nitro flames */}
      <mesh ref={flame1Ref} position={[-0.4, 0.42, -2.05]} scale={[0.7, 0.7, 0.6]}>
        <coneGeometry args={[0.18, 1.2, 16]} />
        <meshBasicMaterial
          color={"#00f6ff"}
          transparent
          opacity={0}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      <mesh ref={flame2Ref} position={[0.4, 0.42, -2.05]} scale={[0.7, 0.7, 0.6]}>
        <coneGeometry args={[0.18, 1.2, 16]} />
        <meshBasicMaterial
          color={"#ff2bd1"}
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
      {/* Stars */}
      <Stars />
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

// ---------- Traffic ----------
type TrafficCar = {
  laneIndex: number;
  z: number; // world z
  speed: number; // m/s (oncoming = negative relative to player)
  color: string;
  alive: boolean;
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

  return (
    <group ref={groupRef}>
      <mesh castShadow position={[0, 0.45, 0]}>
        <boxGeometry args={[1.6, 0.5, 3.2]} />
        <meshStandardMaterial
          color={"#0e0e1a"}
          metalness={0.85}
          roughness={0.25}
        />
      </mesh>
      <mesh position={[0, 0.85, -0.1]}>
        <boxGeometry args={[1.3, 0.4, 1.3]} />
        <meshStandardMaterial
          color={"#040810"}
          metalness={0.6}
          roughness={0.1}
        />
      </mesh>
      {/* Glowing accent stripe */}
      <mesh position={[0, 0.45, 1.61]}>
        <boxGeometry args={[1.4, 0.06, 0.04]} />
        <meshStandardMaterial
          color={carRef.current.color}
          emissive={carRef.current.color}
          emissiveIntensity={3}
        />
      </mesh>
      <mesh position={[0, 0.45, -1.61]}>
        <boxGeometry args={[1.4, 0.06, 0.04]} />
        <meshStandardMaterial
          color={"#ff003c"}
          emissive={"#ff003c"}
          emissiveIntensity={2}
        />
      </mesh>
      {/* Headlights toward player (player is +z forward; oncoming faces -z) */}
      {[-0.5, 0.5].map((x) => (
        <mesh key={x} position={[x, 0.5, -1.62]}>
          <boxGeometry args={[0.3, 0.08, 0.04]} />
          <meshStandardMaterial
            color={"#ffffff"}
            emissive={"#cfeaff"}
            emissiveIntensity={5}
          />
        </mesh>
      ))}
      <pointLight
        ref={headlightRef}
        color={"#cfeaff"}
        intensity={1.5}
        distance={20}
        position={[0, 0.6, -1.7]}
      />
      {/* Wheels (static) */}
      {[
        [-0.85, 0.32, 1.0],
        [0.85, 0.32, 1.0],
        [-0.85, 0.32, -1.1],
        [0.85, 0.32, -1.1],
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
        },
      });
    }
  }

  // Spawn loop
  useFrame((_, dt) => {
    const dist = refs.distanceRef.current;
    lastSpawnRef.current += dt;

    // Spawn cadence
    const interval = 0.55;
    if (lastSpawnRef.current > interval) {
      lastSpawnRef.current = 0;
      const free = carsRef.current.find((c) => !c.current.alive);
      if (free) {
        const lane = Math.floor(Math.random() * 4);
        free.current.laneIndex = lane;
        free.current.z = dist + 220 + Math.random() * 40;
        free.current.speed = -(8 + Math.random() * 16); // oncoming
        free.current.color =
          trafficColors[Math.floor(Math.random() * trafficColors.length)];
        free.current.alive = true;
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

    // Collision detection vs player (only when not crashed)
    if (!refs.crashedRef.current) {
      const px = refs.carXRef.current;
      for (const c of carsRef.current) {
        if (!c.current.alive) continue;
        const localZ = c.current.z - dist;
        const cx = LANE_X[c.current.laneIndex];
        if (Math.abs(localZ) < 2.0 && Math.abs(cx - px) < 1.6) {
          refs.crashedRef.current = true;
          refs.onCrash();
          break;
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

  useEffect(() => {
    camera.position.set(0, 4.5, -8.5);
    camera.lookAt(0, 1.5, 6);
  }, [camera]);

  useFrame(() => {
    const x = refs.carXRef.current;
    const speed = refs.speedRef.current;
    const speedFactor = Math.min(1, (speed - BASE_SPEED) / (NITRO_MAX_SPEED - BASE_SPEED));
    const back = -8 - speedFactor * 1.5;
    const up = 4.4 + speedFactor * 0.3;

    targetPos.current.set(x * 0.6, up, back);
    targetLook.current.set(x * 0.7, 1.2, 8);

    camera.position.lerp(targetPos.current, 0.12);
    camera.lookAt(targetLook.current);
  });
  return null;
};

// ---------- Game logic driver (in-canvas) ----------
const GameLogic = ({ refs }: { refs: SharedRefs }) => {
  useFrame((_, deltaRaw) => {
    const dt = Math.min(0.05, deltaRaw); // clamp dt for stability
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

    const input = refs.input.current;
    const drifting = input.drift;
    const boosting = input.nitro && refs.nitroRef.current > 0;

    // Nitro management
    if (boosting) {
      refs.nitroRef.current = Math.max(0, refs.nitroRef.current - NITRO_DRAIN * dt);
    } else {
      refs.nitroRef.current = Math.min(
        100,
        refs.nitroRef.current + NITRO_REGEN * dt,
      );
    }

    // Target speed
    let targetSpeed = MAX_SPEED;
    if (boosting) targetSpeed = NITRO_MAX_SPEED;
    if (drifting) targetSpeed = Math.min(targetSpeed, MAX_SPEED * 0.7);

    // Approach target speed
    if (refs.speedRef.current < targetSpeed) {
      refs.speedRef.current = Math.min(
        targetSpeed,
        refs.speedRef.current + ACCEL * dt * (boosting ? 1.6 : 1),
      );
    } else {
      const decel = drifting ? DRIFT_DECAY : ACCEL * 0.6;
      refs.speedRef.current = Math.max(
        targetSpeed,
        refs.speedRef.current - decel * dt,
      );
    }

    // Steering
    const steerInput = input.steer;
    const baseSteer = STEER_SPEED * (drifting ? DRIFT_STEER_BOOST : 1);
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

    // Distance traveled
    refs.distanceRef.current += refs.speedRef.current * dt;
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

// ---------- Top-level Scene ----------
const Scene = ({ refs }: { refs: SharedRefs }) => {
  return (
    <>
      <fog attach="fog" args={["#0a0420", 30, 240]} />
      <color attach="background" args={["#04031a"]} />
      <Lights />
      <Sky />
      <DistantSkyline />
      <Road refs={refs} />
      <Buildings refs={refs} />
      <Traffic refs={refs} />
      <PlayerCar refs={refs} />
      <CameraFollow refs={refs} />
      <GameLogic refs={refs} />
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
  onStart,
  onRestart,
  isMobile,
  input,
}: {
  state: GameState;
  speedRef: React.MutableRefObject<number>;
  distanceRef: React.MutableRefObject<number>;
  nitroRef: React.MutableRefObject<number>;
  bestRef: React.MutableRefObject<number>;
  onStart: () => void;
  onRestart: () => void;
  isMobile: boolean;
  input: React.MutableRefObject<InputState>;
}) => {
  const speedEl = useRef<HTMLDivElement>(null);
  const distEl = useRef<HTMLDivElement>(null);
  const nitroEl = useRef<HTMLDivElement>(null);
  const finalDistEl = useRef<HTMLSpanElement>(null);
  const finalSpeedEl = useRef<HTMLSpanElement>(null);
  const bestEl = useRef<HTMLSpanElement>(null);

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
      if (finalDistEl.current) {
        finalDistEl.current.textContent =
          (distanceRef.current / 1000).toFixed(2) + " KM";
      }
      if (finalSpeedEl.current) {
        finalSpeedEl.current.textContent =
          Math.round(speedRef.current * 3.6) + " KPH";
      }
      if (bestEl.current) {
        bestEl.current.textContent =
          (bestRef.current / 1000).toFixed(2) + " KM";
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [speedRef, distanceRef, nitroRef, bestRef]);

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

  return (
    <div className="hud">
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
          </div>
          <div className="glass rounded-lg px-4 py-2 text-center">
            <div
              className="text-base sm:text-xl font-black tracking-[0.35em] title-glow"
              style={{ fontFamily: "Orbitron, sans-serif" }}
            >
              LUCIDEX RACING
            </div>
            <div className="text-[10px] tracking-[0.3em] neon-pink opacity-80">
              NEO TOKYO ROUTE 7
            </div>
          </div>
          <div className="glass rounded-lg px-4 py-2 text-right">
            <div className="text-[10px] tracking-[0.3em] neon-pink opacity-80">
              BEST
            </div>
            <div className="text-2xl font-extrabold neon-text neon-pink">
              <span ref={bestEl}>0.00 KM</span>
            </div>
          </div>
        </div>
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

          {/* Mobile touch controls */}
          {isMobile && (
            <div className="flex items-end gap-2 sm:gap-3">
              <div
                className="touch-btn"
                onTouchStart={(e) => {
                  e.preventDefault();
                  press("left", true);
                }}
                onTouchEnd={(e) => {
                  e.preventDefault();
                  press("left", false);
                }}
                onTouchCancel={(e) => {
                  e.preventDefault();
                  press("left", false);
                }}
              >
                ◀
              </div>
              <div
                className="touch-btn"
                onTouchStart={(e) => {
                  e.preventDefault();
                  press("right", true);
                }}
                onTouchEnd={(e) => {
                  e.preventDefault();
                  press("right", false);
                }}
                onTouchCancel={(e) => {
                  e.preventDefault();
                  press("right", false);
                }}
              >
                ▶
              </div>
              <div
                className="touch-btn pink"
                onTouchStart={(e) => {
                  e.preventDefault();
                  press("drift", true);
                }}
                onTouchEnd={(e) => {
                  e.preventDefault();
                  press("drift", false);
                }}
                onTouchCancel={(e) => {
                  e.preventDefault();
                  press("drift", false);
                }}
              >
                DRIFT
              </div>
              <div
                className="touch-btn yellow"
                onTouchStart={(e) => {
                  e.preventDefault();
                  press("nitro", true);
                }}
                onTouchEnd={(e) => {
                  e.preventDefault();
                  press("nitro", false);
                }}
                onTouchCancel={(e) => {
                  e.preventDefault();
                  press("nitro", false);
                }}
              >
                NITRO
              </div>
            </div>
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

            <button className="menu-btn mt-8" onClick={onStart}>
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
                  MOBILE
                </div>
                <div>Tap ◀ ▶ to steer</div>
                <div>Tap DRIFT to slide</div>
                <div>Tap NITRO to boost</div>
              </div>
            </div>

            {bestRef.current > 0 && (
              <div className="mt-6 text-xs tracking-[0.3em] neon-yellow opacity-90">
                BEST DISTANCE · <span ref={bestEl}>0.00 KM</span>
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
            <div className="mt-4 text-[10px] tracking-[0.3em] neon-pink opacity-80">
              BEST · <span ref={bestEl}>0.00 KM</span>
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

  // Track top speed during play
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (speedRef.current > topSpeedRef.current) {
        topSpeedRef.current = speedRef.current;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Mobile detection
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const m =
      typeof window !== "undefined" &&
      ("ontouchstart" in window ||
        (navigator.maxTouchPoints && navigator.maxTouchPoints > 0));
    const small =
      typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches;
    setIsMobile(Boolean(m) || small);
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
    speedRef.current = BASE_SPEED;
    distanceRef.current = 0;
    nitroRef.current = 100;
    driftAngleRef.current = 0;
    carXRef.current = 0;
    crashedRef.current = false;
    topSpeedRef.current = BASE_SPEED;
    inputRef.current = { steer: 0, drift: false, nitro: false };
    setState("playing");
  }, []);

  const restart = useCallback(() => {
    startRace();
  }, [startRace]);

  const handleCrash = useCallback(() => {
    if (distanceRef.current > bestRef.current) {
      bestRef.current = distanceRef.current;
      try {
        localStorage.setItem(
          "lucidex.best",
          String(bestRef.current),
        );
      } catch {
        /* noop */
      }
    }
    setState("crashed");
  }, []);

  // Load best
  useEffect(() => {
    try {
      const v = localStorage.getItem("lucidex.best");
      if (v) bestRef.current = Number(v) || 0;
    } catch {
      /* noop */
    }
  }, []);

  // Engine audio
  useEngineAudio(speedRef, state === "playing");

  const refs: SharedRefs = {
    input: inputRef,
    speedRef,
    distanceRef,
    nitroRef,
    driftAngleRef,
    carXRef,
    crashedRef,
    onCrash: handleCrash,
  };

  return (
    <div
      className="fixed inset-0 overflow-hidden scanlines"
      style={{ background: "radial-gradient(circle at 50% 60%, #0a0420, #04030a 60%)" }}
    >
      <Canvas
        shadows={false}
        dpr={[1, 1.75]}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        camera={{ fov: 70, near: 0.1, far: 800, position: [0, 4.5, -8.5] }}
        frameloop={state === "playing" ? "always" : "demand"}
      >
        <Suspense fallback={null}>
          <Scene refs={refs} />
        </Suspense>
      </Canvas>

      <HUD
        state={state}
        speedRef={speedRef}
        distanceRef={distanceRef}
        nitroRef={nitroRef}
        bestRef={bestRef}
        onStart={startRace}
        onRestart={restart}
        isMobile={isMobile}
        input={inputRef}
      />
    </div>
  );
}
