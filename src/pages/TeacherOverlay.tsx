import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { ContactShadows, Environment, useGLTF, useAnimations } from "@react-three/drei";
import * as THREE from "three";
import { useAutonomousWalk } from "../hooks/useAutonomousWalk";

// Real converted Mixamo assets:
//   teacher.glb       - full skinned mesh + skeleton
//   teacher-idle.glb  - same skeleton, "Sad Idle" clip only (mesh stripped)
//   teacher-walk.glb  - same skeleton, "Walking Left Turn" clip only (mesh stripped)
// All three share the same rig, so the idle/walk clips retarget cleanly
// onto the base mesh's skeleton via useAnimations.
const MODEL_URL = "/models/teacher.glb";
const IDLE_URL = "/models/teacher-idle.glb";
const WALK_URL = "/models/teacher-walk.glb";

function TeacherModel({ speaking, walking }: { speaking: boolean; walking: boolean }) {
  const groupRef = useRef<THREE.Group>(null);
  const { scene } = useGLTF(MODEL_URL);
  const { animations: idleAnimations } = useGLTF(IDLE_URL);
  const { animations: walkAnimations } = useGLTF(WALK_URL);

  // Clone the scene per-instance so remounts don't fight over shared state.
  const clonedScene = useMemo(() => scene.clone(true), [scene]);
  const clips = useMemo(
    () => [...idleAnimations, ...walkAnimations],
    [idleAnimations, walkAnimations],
  );
  const { actions } = useAnimations(clips, clonedScene);

  useEffect(() => {
    // Both clips are named "mixamo.com" (Mixamo's default export name), so
    // disambiguate by array position instead of by clip name.
    const idleAction = idleAnimations[0] ? actions[idleAnimations[0].name] : undefined;
    const walkAction = walkAnimations[0] ? actions[walkAnimations[0].name] : undefined;
    if (!idleAction || !walkAction) return;

    idleAction.reset().fadeIn(0.3).play();
    walkAction.reset().fadeIn(0.3).play();
    idleAction.setEffectiveWeight(walking ? 0 : 1);
    walkAction.setEffectiveWeight(walking ? 1 : 0);

    return () => {
      idleAction.fadeOut(0.2);
      walkAction.fadeOut(0.2);
    };
  }, [actions, idleAnimations, walkAnimations, walking]);

  // Crude talking cue layered on top of whichever body animation is
  // playing, same idea as the old placeholder had, until real visemes exist.
  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    if (speaking) {
      const t = clock.getElapsedTime();
      groupRef.current.rotation.z = Math.sin(t * 10) * 0.01;
    } else {
      groupRef.current.rotation.z = 0;
    }
  });

  return (
    <group ref={groupRef} position={[0, -0.9, 0]} scale={1.1}>
      <primitive object={clonedScene} />
    </group>
  );
}

useGLTF.preload(MODEL_URL);
useGLTF.preload(IDLE_URL);
useGLTF.preload(WALK_URL);

// Minimal typing for the overlay-specific bridge methods, kept local so
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
  const [dragging, setDragging] = useState(false);
  const dragState = useRef<{ x: number; y: number } | null>(null);

  // The avatar walks on its own whenever nothing else has claimed it -
  // not while the user is dragging it, and not while it's talking.
  const walking = useAutonomousWalk(dragging || speaking);

  useEffect(() => {
    const bridge = getTeacherBridge();
    const unsubscribe = bridge.onTeacherSpeakState?.(setSpeaking);
    return () => unsubscribe?.();
  }, []);

  function handlePointerDown(e: React.PointerEvent) {
    dragState.current = { x: e.clientX, y: e.clientY };
    setDragging(true);
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!dragState.current) return;
    const dx = e.clientX - dragState.current.x;
    const dy = e.clientY - dragState.current.y;
    dragState.current = { x: e.clientX, y: e.clientY };
    getTeacherBridge().moveTeacherWindowBy?.(dx, dy);
  }

  function handlePointerUp() {
    dragState.current = null;
    setDragging(false);
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
        <TeacherModel speaking={speaking} walking={walking} />
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
