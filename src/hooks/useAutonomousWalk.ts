import { useEffect, useRef, useState } from "react";

interface TeacherBounds {
  screenWidth: number;
  screenHeight: number;
  x: number;
  y: number;
  winWidth: number;
  winHeight: number;
}

interface WalkBridge {
  getTeacherBounds?: () => Promise<TeacherBounds>;
  setTeacherPosition?: (x: number, y: number) => void;
}

function getBridge(): WalkBridge {
  return (window as unknown as { electronAPI?: WalkBridge }).electronAPI ?? {};
}

const WALK_SPEED_PX_PER_SEC = 90;
const MIN_PAUSE_MS = 2500;
const MAX_PAUSE_MS = 8000;

/**
 * Drives the teacher window's walking behavior: autonomous "walk to a
 * random spot, idle a while, repeat" by default, plus an on-demand mode
 * where something else (a tool call finishing, the "Talk to me" button)
 * can make it walk right now instead of waiting for the next random turn.
 *
 * `cueToken`: bump this (e.g. with a counter) any time you want the
 * character to immediately walk toward a nearby spot — used to give a
 * visible "reacting to what just happened" cue. There's no real spatial
 * link to any on-screen element (VS Code and other apps don't expose
 * their pixel positions to us), so this is a directional gesture, not a
 * literal "walk to the error" — paired with the caption bubble in
 * TeacherOverlay.tsx to carry the actual information.
 *
 * Returns `walking`, a plain boolean the caller uses to decide which
 * animation clip to play — no state machine leaks past this hook.
 */
export function useAutonomousWalk(suspended: boolean, cueToken?: number): boolean {
  const [walking, setWalking] = useState(false);
  const rafRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);

  function clearTimers() {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    rafRef.current = null;
    timeoutRef.current = null;
  }

  async function walkToRandomSpot(onArrive?: () => void) {
    const bridge = getBridge();
    if (cancelledRef.current || suspended || !bridge.getTeacherBounds || !bridge.setTeacherPosition) {
      return;
    }
    const bounds = await bridge.getTeacherBounds();
    if (cancelledRef.current || suspended) return;

    const maxX = Math.max(0, bounds.screenWidth - bounds.winWidth);
    const maxY = Math.max(0, bounds.screenHeight - bounds.winHeight);
    const targetX = Math.random() * maxX;
    const targetY = Math.random() * maxY;

    const startX = bounds.x;
    const startY = bounds.y;
    const dx = targetX - startX;
    const dy = targetY - startY;
    const distance = Math.hypot(dx, dy);

    if (distance < 4) {
      onArrive?.();
      return;
    }

    setWalking(true);
    const durationMs = (distance / WALK_SPEED_PX_PER_SEC) * 1000;
    const startTime = performance.now();

    function step(now: number) {
      if (cancelledRef.current || suspended) {
        setWalking(false);
        return;
      }
      const t = Math.min(1, (now - startTime) / durationMs);
      const x = startX + dx * t;
      const y = startY + dy * t;
      bridge.setTeacherPosition?.(x, y);

      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        setWalking(false);
        onArrive?.();
      }
    }

    rafRef.current = requestAnimationFrame(step);
  }

  // Autonomous idle-walk loop.
  useEffect(() => {
    cancelledRef.current = false;

    function scheduleNextWalk() {
      if (cancelledRef.current || suspended) return;
      const pause = MIN_PAUSE_MS + Math.random() * (MAX_PAUSE_MS - MIN_PAUSE_MS);
      timeoutRef.current = window.setTimeout(() => {
        void walkToRandomSpot(scheduleNextWalk);
      }, pause);
    }

    clearTimers();
    if (!suspended) scheduleNextWalk();

    return () => {
      cancelledRef.current = true;
      clearTimers();
      setWalking(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suspended]);

  // On-demand cue: interrupt whatever's pending and walk right now.
  useEffect(() => {
    if (cueToken === undefined || cueToken === 0 || suspended) return;
    clearTimers();
    void walkToRandomSpot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cueToken]);

  return walking;
}
