import { useEffect, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { ContactShadows, Environment } from "@react-three/drei";
import * as THREE from "three";

// ---- This is a PLACEHOLDER avatar, not the final "realistic teacher" ----
//
// A truly realistic rigged human (the actual ask) needs a real 3D asset —
// something like a Ready Player Me export (free, realistic, already rigged
// for a humanoid skeleton) combined with Mixamo animations (free idle/talk/
// point/wave clips that retarget to any humanoid rig). Fetching and hosting
// those is a one-time setup step outside this sandbox (this environment's
// network allowlist can't reach readyplayer.me or mixamo.com to download a
// model for you). Everything below — the window, the drag handling, the
// idle/talking animation state machine, the IPC wiring to Jarvis's voice —
// is real and working; only the geometry is a stand-in.
//
// To swap in a real model once you have a `.glb` file:
//   1. Drop it in `public/models/teacher.glb`.
//   2. Replace <PlaceholderFigure /> below with:
//        const { scene, animations } = useGLTF("/models/teacher.glb");
//        const { actions } = useAnimations(animations, scene);
//        // then actions["Idle"]?.play() / actions["Talking"]?.play()
//        // depending on `speaking`, and <primitive object={scene} />
//      (both useGLTF and useAnimations come from @react-three/drei)

function PlaceholderFigure({ speaking }: { speaking: boolean }) {
  const headRef = useRef<THREE.Mesh>(null);
  const groupRef = useRef<THREE.Group>(null);
  const mouthRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const bobSpeed = speaking ? 6 : 1.5;
    const bobAmount = speaking ? 0.05 : 0.08;

    if (groupRef.current) {
      groupRef.current.position.y = Math.sin(t * bobSpeed) * bobAmount;
      groupRef.current.rotation.y = Math.sin(t * 0.6) * 0.15;
    }
    if (headRef.current) {
      headRef.current.rotation.z = Math.sin(t * bobSpeed * 0.7) * 0.03;
    }
    if (mouthRef.current) {
      // Crude "talking" cue until a real viseme-driven mouth exists.
      const scale = speaking ? 0.6 + Math.abs(Math.sin(t * 14)) * 0.6 : 0.4;
      mouthRef.current.scale.set(1, scale, 1);
    }
  });

  return (
    <group ref={groupRef} position={[0, -0.6, 0]}>
      {/* Torso */}
      <mesh position={[0, 0.35, 0]}>
        <capsuleGeometry args={[0.32, 0.55, 8, 16]} />
        <meshStandardMaterial color="#3b4a6b" roughness={0.5} />
      </mesh>
      {/* Head */}
      <mesh ref={headRef} position={[0, 1.05, 0]}>
        <sphereGeometry args={[0.28, 32, 32]} />
        <meshStandardMaterial color="#e8b98c" roughness={0.6} />
      </mesh>
      {/* Mouth (placeholder talking indicator) */}
      <mesh ref={mouthRef} position={[0, 0.95, 0.26]}>
        <boxGeometry args={[0.12, 0.05, 0.02]} />
        <meshStandardMaterial color="#7a2f2f" />
      </mesh>
      {/* Arms */}
      <mesh position={[-0.42, 0.35, 0]} rotation={[0, 0, 0.3]}>
        <capsuleGeometry args={[0.08, 0.5, 8, 16]} />
        <meshStandardMaterial color="#3b4a6b" roughness={0.5} />
      </mesh>
      <mesh position={[0.42, 0.35, 0]} rotation={[0, 0, -0.3]}>
        <capsuleGeometry args={[0.08, 0.5, 8, 16]} />
        <meshStandardMaterial color="#3b4a6b" roughness={0.5} />
      </mesh>
    </group>
  );
}

// Minimal typing for the two overlay-specific bridge methods, kept local so
// this file doesn't need to import Assistant.tsx's internal types.
interface TeacherBridge {
  onTeacherSpeakState?: (callback: (speaking: boolean) => void) => () => void;
  moveTeacherWindowBy?: (dx: number, dy: number) => void;
}

function getTeacherBridge(): TeacherBridge {
  return (window as unknown as { electronAPI?: TeacherBridge }).electronAPI ?? {};
}

export default function TeacherOverlay() {
  const [speaking, setSpeaking] = useState(false);
  const dragState = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const bridge = getTeacherBridge();
    const unsubscribe = bridge.onTeacherSpeakState?.(setSpeaking);
    return () => unsubscribe?.();
  }, []);

  function handlePointerDown(e: React.PointerEvent) {
    dragState.current = { x: e.clientX, y: e.clientY };
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!dragState.current) return;
    const dx = e.clientX - dragState.current.x;
    const dy = e.clientY - dragState.current.y;
    getTeacherBridge().moveTeacherWindowBy?.(dx, dy);
  }

  function handlePointerUp() {
    dragState.current = null;
  }

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      style={{ width: "100%", height: "100%", cursor: "grab" }}
    >
      <Canvas
        camera={{ position: [0, 0.3, 2.4], fov: 35 }}
        gl={{ alpha: true }}
        style={{ background: "transparent" }}
      >
        <ambientLight intensity={0.7} />
        <directionalLight position={[2, 3, 2]} intensity={1.1} />
        <Environment preset="city" />
        <PlaceholderFigure speaking={speaking} />
        <ContactShadows
          position={[0, -1.1, 0]}
          opacity={0.35}
          scale={2.5}
          blur={2.2}
          far={2}
        />
      </Canvas>
    </div>
  );
}
