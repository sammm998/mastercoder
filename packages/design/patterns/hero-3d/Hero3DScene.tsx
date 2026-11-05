/**
 * The WebGL part of the 3D hero. Loaded only via React.lazy from Hero3D after load + idle, never on
 * reduced-motion or low-power devices. DPR is clamped to [1, 1.75] and adapts with drei's PerformanceMonitor.
 */
import { Canvas, useFrame } from "@react-three/fiber";
import { PerformanceMonitor } from "@react-three/drei";
import { useMemo, useRef, useState } from "react";
import { Color, Vector2, type Mesh } from "three";
import { cssVar, resolveColor } from "../_shared/motion";
import { fragmentShader, vertexShader } from "./shaders";

const MAX_DPR = 1.75;

function readPalette() {
  const pick = (name: string, fallback: string) => new Color(...resolveColor(cssVar(name, fallback)));
  return { a: pick("--color-accent", "#5b6cff"), b: pick("--color-accent-2", "#ff7a59"), c: pick("--color-text", "#ffffff") };
}

function Orb() {
  const mesh = useRef<Mesh>(null);
  const palette = useMemo(readPalette, []);
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uPointer: { value: new Vector2(0, 0) },
      uAmplitude: { value: 0.32 },
      uColorA: { value: palette.a },
      uColorB: { value: palette.b },
      uColorC: { value: palette.c },
    }),
    [palette],
  );
  useFrame((state, delta) => {
    uniforms.uTime.value += Math.min(delta, 0.05);
    uniforms.uPointer.value.lerp(state.pointer, 0.04);
    if (mesh.current) {
      mesh.current.rotation.y += delta * 0.08;
      mesh.current.rotation.x = uniforms.uPointer.value.y * 0.25;
    }
  });
  return (
    <mesh ref={mesh} scale={1.35}>
      <icosahedronGeometry args={[1, 64]} />
      <shaderMaterial uniforms={uniforms} vertexShader={vertexShader} fragmentShader={fragmentShader} />
    </mesh>
  );
}

export interface Hero3DSceneProps {
  /** Pause rendering when the hero is off-screen. */
  active: boolean;
  onReady?: () => void;
}

export default function Hero3DScene({ active, onReady }: Hero3DSceneProps) {
  const [dpr, setDpr] = useState(1.5);
  return (
    <Canvas
      dpr={[1, Math.min(dpr, MAX_DPR)]}
      frameloop={active ? "always" : "never"}
      camera={{ position: [0, 0, 4.2], fov: 38 }}
      gl={{ antialias: false, alpha: true, powerPreference: "high-performance" }}
      onCreated={() => onReady?.()}
      aria-hidden="true"
      tabIndex={-1}
    >
      <PerformanceMonitor onDecline={() => setDpr(1)} onIncline={() => setDpr(MAX_DPR)} />
      <Orb />
    </Canvas>
  );
}
