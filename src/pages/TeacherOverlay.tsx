import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { ContactShadows, Environment, useGLTF, useAnimations } from "@react-three/drei";
import { SkeletonUtils } from "three-stdlib";
import * as THREE from "three";
import { useAutonomousWalk } from "../hooks/useAutonomousWalk";

// Real converted Mixamo assets:
//   teacher.glb       - full skinned mesh + skeleton
//   teacher-idle.glb  - same skeleton, "Sad Idle" clip only (mesh stripped)
//   teacher-walk.glb  - same skeleton, "Walking Left Turn" clip only (mesh
//                       stripped; horizontal root motion on the Hips bone
//                       is frozen so the character walks in place — actual
//                       on-screen traversal comes from the OS window
//                       itself moving, driven by useAutonomousWalk)
// All three share the same rig, so the idle/walk clips retarget cleanly
// onto the base mesh's skeleton via useAnimations.
//
// Paths are built from import.meta.env.BASE_URL (which vite.config.ts sets
// to "./") rather than hardcoded as "/models/...". In production the app is
// loaded via loadFile() under the file:// protocol, where a leading "/"
// resolves to the filesystem root, not the dist folder — that mismatch is
// why the model failed to load silently (no devtools on this window to
// surface the fetch error).
const MODEL_URL = `${import.meta.env.BASE_URL}models/teacher.glb`;
const IDLE_URL = `${import.meta.env.BASE_URL}models/teacher-idle.glb`;
const WALK_URL = `${import.meta.env.BASE_URL}models/teacher-walk.glb`;

function TeacherModel({
  speaking,
  walking,
  onHoverChange,
}: {
  speaking: boolean;
  walking: boolean;
  onHoverChange: (hovering: boolean) => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const { camera } = useThree();
  const { scene } = useGLTF(MODEL_URL);
  const { animations: idleAnimations } = useGLTF(IDLE_URL);
  const { animations: walkAnimations } = useGLTF(WALK_URL);

  // Clone the scene per-instance so remounts don't fight over shared state.
  // IMPORTANT: plain Object3D.clone() does not correctly clone a rigged/
  // skinned mesh — it duplicates the bone Object3Ds but never re-links
  // SkinnedMesh.skeleton.bones to point at the new ones, so the mesh keeps
  // reading its ORIGINAL (unanimated) skeleton while the mixer drives the
  // cloned-but-unused bones. That mismatch is what caused the frozen pose
  // and the mesh visibly deforming/ballooning as playback continued —
  // SkeletonUtils.clone() is the three.js-recommended way to clone rigged
  // models and keeps the skin binding intact.
  const clonedScene = useMemo(() => SkeletonUtils.clone(scene), [scene]);

  // Frame the camera from the model's ACTUAL bounding box, computed once
  // per load, rather than hardcoded numbers guessed to match one export.
  // Fixes "only half the body showing" — the previous fixed camera/group
  // offsets assumed a body height that didn't match this asset, so the
  // top or bottom got cropped by the viewport.
  useEffect(() => {
    const box = new THREE.Box3().setFromObject(clonedScene);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    if (groupRef.current) {
      // Sit the model on the ground plane (feet at y=0 in group-local
      // space) regardless of where the source asset's own origin was.
      groupRef.current.position.set(-center.x, -box.min.y, -center.z);
    }

    const perspCam = camera as THREE.PerspectiveCamera;
    const verticalFov = (perspCam.fov * Math.PI) / 180;
    // Higher margin = more empty space around the model = smaller-looking
    // avatar within the window (camera pulls back further to compensate).
    const margin = 3;
    const distanceForHeight = (size.y * margin) / (2 * Math.tan(verticalFov / 2));
    const distanceForWidth =
      (size.x * margin) / (2 * Math.tan(verticalFov / 2) * perspCam.aspect);
    const distance = Math.max(distanceForHeight, distanceForWidth);

    camera.position.set(0, size.y / 2, distance);
    camera.lookAt(0, size.y / 2, 0);
    perspCam.updateProjectionMatrix();
  }, [clonedScene, camera]);

  // Both Mixamo clips export under the same default name ("mixamo.com").
  // useAnimations keys its `actions` map by clip.name, so two clips with
  // an identical name collide there — one silently overwrites the other,
  // which is why only one animation was ever actually playing. Renaming
  // each clip uniquely (on a clone, so the cached useGLTF result isn't
  // mutated) fixes that.
  // These exports always include an empty "Take 001" placeholder clip
  // (0 tracks) alongside the real "mixamo.com" clip that actually carries
  // keyframes. Picking animations[0] silently grabs the empty one, so the
  // mixer plays with nothing bound and the character never moves. Select
  // by actual track content instead of trusting array order.
  const idleClip = useMemo(() => {
    const clip = idleAnimations.find((a) => a.tracks.length > 0)?.clone();
    if (clip) clip.name = "TeacherIdle";
    return clip;
  }, [idleAnimations]);
  const walkClip = useMemo(() => {
    const clip = walkAnimations.find((a) => a.tracks.length > 0)?.clone();
    if (clip) clip.name = "TeacherWalk";
    return clip;
  }, [walkAnimations]);
  const clips = useMemo(
    () => [idleClip, walkClip].filter((c): c is THREE.AnimationClip => Boolean(c)),
    [idleClip, walkClip],
  );
  const { actions } = useAnimations(clips, clonedScene);

  useEffect(() => {
    const idleAction = actions["TeacherIdle"];
    const walkAction = actions["TeacherWalk"];
    if (!idleAction || !walkAction) return;

    idleAction.reset().fadeIn(0.3).play();
    walkAction.reset().fadeIn(0.3).play();
    idleAction.setEffectiveWeight(walking ? 0 : 1);
    walkAction.setEffectiveWeight(walking ? 1 : 0);

    return () => {
      idleAction.fadeOut(0.2);
      walkAction.fadeOut(0.2);
    };
  }, [actions, walking]);

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
    <group ref={groupRef}>
      {/* onPointerOver/Out here are r3f's raycast-based pointer events —
          they fire only when the cursor is actually over the character's
          geometry, not just anywhere in the (much larger, mostly empty)
          window rectangle. That's what lets the window stay click-through
          everywhere except the avatar itself. */}
      <primitive
        object={clonedScene}
        onPointerOver={() => onHoverChange(true)}
        onPointerOut={() => onHoverChange(false)}
      />
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
  setTeacherIgnoreMouseEvents?: (ignore: boolean) => void;
  requestStartCall?: () => void;
  onTeacherAnnounce?: (callback: (text: string) => void) => () => void;
}

function getTeacherBridge(): TeacherBridge {
  return (window as unknown as { electronAPI?: TeacherBridge }).electronAPI ?? {};
}

export default function TeacherOverlay() {
  const [speaking, setSpeaking] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [cueToken, setCueToken] = useState(0);
  const [buttonHovering, setButtonHovering] = useState(false);
  const dragState = useRef<{ x: number; y: number } | null>(null);
  const announceTimeoutRef = useRef<number | null>(null);

  // The avatar walks on its own whenever nothing else has claimed it -
  // not while the user is dragging it, and not while it's talking.
  const walking = useAutonomousWalk(dragging || speaking, cueToken);

  useEffect(() => {
    const bridge = getTeacherBridge();
    const unsubscribe = bridge.onTeacherSpeakState?.(setSpeaking);
    return () => unsubscribe?.();
  }, []);

  // Jarvis tells us what it just did (opened an app, edited a file in VS
  // Code, etc.) — show it as a short caption above the character's head
  // and nudge it to walk over, as a "reacting to that" cue. There's no
  // real link to WHERE on screen that thing happened (see the note on
  // useAutonomousWalk's cueToken), so the caption is what actually carries
  // the information; the walk is just a visible gesture alongside it.
  useEffect(() => {
    const bridge = getTeacherBridge();
    const unsubscribe = bridge.onTeacherAnnounce?.((text) => {
      setAnnouncement(text);
      setCueToken((n) => n + 1);
      if (announceTimeoutRef.current !== null) window.clearTimeout(announceTimeoutRef.current);
      announceTimeoutRef.current = window.setTimeout(() => setAnnouncement(null), 4500);
    });
    return () => {
      unsubscribe?.();
      if (announceTimeoutRef.current !== null) window.clearTimeout(announceTimeoutRef.current);
    };
  }, []);

  // Click-through everywhere except the avatar itself: ignore mouse events
  // (letting clicks/scrolls fall through to whatever's underneath) unless
  // the cursor is actually over the rendered character, or the user is
  // mid-drag (kept true here too so a fast drag that briefly slips off the
  // mesh's raycast area doesn't drop the window instead of moving it).
  useEffect(() => {
    getTeacherBridge().setTeacherIgnoreMouseEvents?.(!(hovering || dragging || buttonHovering));
  }, [hovering, dragging, buttonHovering]);

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
      style={{ width: "100%", height: "100%", cursor: "grab", position: "relative" }}
    >
      {announcement && (
        <div
          style={{
            position: "absolute",
            top: 2,
            left: "50%",
            transform: "translateX(-50%)",
            maxWidth: "94%",
            padding: "4px 8px",
            borderRadius: 8,
            background: "rgba(20,20,24,0.85)",
            color: "#fff",
            fontSize: 10,
            lineHeight: 1.3,
            textAlign: "center",
            pointerEvents: "none",
            zIndex: 2,
          }}
        >
          {announcement}
        </div>
      )}

      {/* Small, always-available "start a live call" button — separate
          from the avatar itself so it doesn't get swallowed by drag
          handling. Only enables mouse events over its own tiny rect.
          stopPropagation on every pointer event here so the outer
          window-drag handler (bound on the wrapper div below) never
          treats a click on this button as the start of a drag. */}
      <button
        onPointerEnter={() => setButtonHovering(true)}
        onPointerLeave={() => setButtonHovering(false)}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerMove={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onClick={() => {
          console.log("[Jarvis teacher overlay] Talk to me clicked");
          const bridge = getTeacherBridge();
          if (!bridge.requestStartCall) {
            console.error(
              "[Jarvis teacher overlay] window.electronAPI.requestStartCall is missing — preload.cjs likely wasn't reloaded. Fully restart the Electron app (not just the Vite dev server) after editing main.cjs/preload.cjs.",
            );
            return;
          }
          bridge.requestStartCall();
        }}
        style={{
          position: "absolute",
          bottom: 4,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 2,
          fontSize: 9,
          padding: "3px 8px",
          borderRadius: 999,
          border: "1px solid rgba(255,255,255,0.25)",
          background: "rgba(20,20,24,0.85)",
          color: "#fff",
          cursor: "pointer",
        }}
      >
        Talk to me
      </button>

      <Canvas
        camera={{ position: [0, 1, 3], fov: 35 }}
        gl={{ alpha: true }}
        style={{ background: "transparent" }}
      >
        <ambientLight intensity={0.7} />
        <directionalLight position={[2, 3, 2]} intensity={1.1} />
        <Environment preset="city" />
        <TeacherModel speaking={speaking} walking={walking} onHoverChange={setHovering} />
        <ContactShadows
          position={[0, 0.01, 0]}
          opacity={0.35}
          scale={2.5}
          blur={2.2}
          far={2}
        />
      </Canvas>
    </div>
  );
}
