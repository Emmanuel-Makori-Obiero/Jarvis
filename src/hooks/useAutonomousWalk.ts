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
 * Drives the teacher window's autonomous "walk to a random spot on
 * screen, idle a while, repeat" behavior. Paused automatically while
 * the user is dragging the window or Jarvis is talking — those cases
 * are passed in rather than tracked here so this hook stays a pure
 * function of "is something else in control right now?".
 *
 * Returns `walking`, a plain boolean the caller uses to decide which
 * animation clip to play — no state machine leaks past this hook.
 */
export function useAutonomousWalk(suspended: boolean): boolean {
  const [walking, setWalking] = useState(false);
  const rafRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const bridge = getBridge();

    function clearTimers() {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      rafRef.current = null;
      timeoutRef.current = null;
    }

    async function scheduleNextWalk() {
      if (cancelled || suspended) return;
      const pause = MIN_PAUSE_MS + Math.random() * (MAX_PAUSE_MS - MIN_PAUSE_MS);
      timeoutRef.current = window.setTimeout(() => {
        void walkToRandomSpot();
      }, pause);
    }

    async function walkToRandomSpot() {
      if (cancelled || suspended || !bridge.getTeacherBounds || !bridge.setTeacherPosition) {
        return;
      }
      const bounds = await bridge.getTeacherBounds();
      if (cancelled || suspended) return;

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
        void scheduleNextWalk();
        return;
      }

      setWalking(true);
      const durationMs = (distance / WALK_SPEED_PX_PER_SEC) * 1000;
      const startTime = performance.now();

      function step(now: number) {
        if (cancelled || suspended) {
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
          void scheduleNextWalk();
        }
      }

      rafRef.current = requestAnimationFrame(step);
    }

    clearTimers();
    if (!suspended) {
      void scheduleNextWalk();
    }

    return () => {
      cancelled = true;
      clearTimers();
      // Reset on the way out (suspend starting, or unmount) rather than
      // synchronously at the top of the next effect run.
      setWalking(false);
    };
  }, [suspended]);

  return walking;
}
