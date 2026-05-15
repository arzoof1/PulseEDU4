import { useEffect, useRef, useState, type ReactNode } from "react";

// PrivacyGate — heavy-blur + drag-to-unlock confirmation that the
// screen is safe to display before revealing sensitive student data
// (e.g. Teacher Roster's FAST scores, ESE/504/ELL flags, safety plan
// indicators). The gate exists on EVERY entry to the protected page,
// regardless of which screen the teacher came from, because there is
// no reliable way for the app to know whether the device is currently
// mirrored to a projector / TV / Apple TV. The user is the source of
// truth.
//
// Design choices that are intentional:
//  - Backdrop is heavily blurred (not just dimmed) so a glance at the
//    screen by a student would not reveal any roster data even before
//    the teacher unlocks.
//  - Unlock is a *drag*, not a click, so it cannot be performed by
//    reflex / muscle memory. A teacher who autopilots through warning
//    dialogs by tapping Enter will be physically forced to slow down.
//  - Confirm label sits at the right edge of the slider so the
//    teacher's eyes track to the message in the middle on the way
//    there.
//  - Resetting per-mount: the parent should remount this component
//    each time the protected route is entered (e.g. via React `key`)
//    so the gate re-arms after every navigation.

interface PrivacyGateProps {
  // Headline shown above the message. Short, scannable.
  title?: string;
  // Body copy. Be specific about WHAT private data is on the next
  // screen so the teacher knows the cost of getting this wrong.
  message?: ReactNode;
  // Children render behind the gate from the moment the gate opens
  // (so the page is loading in the background). They are blurred
  // until the teacher drags to unlock.
  children: ReactNode;
}

export default function PrivacyGate({
  title = "Hold on — private student data ahead",
  message = (
    <>
      The next screen shows <strong>FAST scores, IEP/504/ELL flags, and
      safety plan indicators</strong> for your roster. Make sure this device
      is <strong>not</strong> being mirrored to a projector, TV, Apple TV,
      or any student-facing display before continuing.
    </>
  ),
  children,
}: PrivacyGateProps) {
  const [unlocked, setUnlocked] = useState(false);

  if (unlocked) return <>{children}</>;

  return (
    <>
      {/* Render the protected content behind the gate so it's already
          loading. The blur is applied via the overlay, not the
          children, so a brief subpixel slip on transition can never
          render unblurred data. */}
      <div aria-hidden="true">{children}</div>
      <GateOverlay
        title={title}
        message={message}
        onUnlock={() => setUnlocked(true)}
      />
    </>
  );
}

function GateOverlay({
  title,
  message,
  onUnlock,
}: {
  title: string;
  message: ReactNode;
  onUnlock: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "5vh 16px",
        background: "rgba(15, 23, 42, 0.55)",
        backdropFilter: "blur(18px) saturate(120%)",
        WebkitBackdropFilter: "blur(18px) saturate(120%)",
      }}
    >
      <div
        style={{
          background: "white",
          borderRadius: 16,
          width: "min(560px, 100%)",
          boxShadow: "0 30px 80px rgba(0,0,0,0.35)",
          border: "1px solid #fecaca",
          padding: "28px 28px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div
            aria-hidden="true"
            style={{
              fontSize: 28,
              width: 44,
              height: 44,
              borderRadius: "50%",
              background: "#fee2e2",
              color: "#991b1b",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flex: "0 0 44px",
            }}
          >
            ⚠️
          </div>
          <h2
            style={{
              margin: 0,
              fontSize: 20,
              color: "#7f1d1d",
              lineHeight: 1.25,
            }}
          >
            {title}
          </h2>
        </div>

        <div
          style={{
            fontSize: 15,
            lineHeight: 1.55,
            color: "#1f2937",
          }}
        >
          {message}
        </div>

        <SlideToUnlock onUnlock={onUnlock} />

        <div
          style={{
            fontSize: 12,
            color: "#64748b",
            textAlign: "center",
          }}
        >
          Slide the handle all the way to the right to confirm and view the
          page.
        </div>
      </div>
    </div>
  );
}

// Drag-to-unlock slider. iOS-style. Works with mouse + touch + keyboard
// (Right arrow nudges the handle, Enter when fully right unlocks — so
// the gate is still operable by users who can't drag).
function SlideToUnlock({ onUnlock }: { onUnlock: () => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0); // 0..1
  const draggingRef = useRef(false);
  const handleSize = 56;

  // Compute progress from a clientX position.
  const setFromClientX = (clientX: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const usable = rect.width - handleSize;
    if (usable <= 0) return;
    const raw = (clientX - rect.left - handleSize / 2) / usable;
    const clamped = Math.max(0, Math.min(1, raw));
    setProgress(clamped);
    if (clamped >= 0.995) {
      draggingRef.current = false;
      onUnlock();
    }
  };

  useEffect(() => {
    const onMove = (e: MouseEvent | TouchEvent) => {
      if (!draggingRef.current) return;
      const clientX =
        "touches" in e
          ? (e.touches[0]?.clientX ?? 0)
          : (e as MouseEvent).clientX;
      setFromClientX(clientX);
      e.preventDefault();
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      // Snap back if released before completion — forces a real drag,
      // not a half-hearted nudge.
      setProgress((p) => (p >= 0.995 ? p : 0));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") {
      setProgress((p) => Math.min(1, p + 0.1));
      e.preventDefault();
    } else if (e.key === "ArrowLeft") {
      setProgress((p) => Math.max(0, p - 0.1));
      e.preventDefault();
    } else if (e.key === "Enter" && progress >= 0.995) {
      onUnlock();
    }
  };

  // Color shifts from red → green as progress increases. Visual
  // reinforcement that the action is becoming more permissive.
  const trackBg = `linear-gradient(to right, #16a34a ${progress * 100}%, #fca5a5 ${progress * 100}%)`;

  return (
    <div
      ref={trackRef}
      role="slider"
      aria-label="Slide to confirm and view roster"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{
        position: "relative",
        height: handleSize + 8,
        borderRadius: (handleSize + 8) / 2,
        background: trackBg,
        border: "1px solid #fecaca",
        overflow: "hidden",
        userSelect: "none",
        touchAction: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: progress > 0.4 ? "white" : "#7f1d1d",
          fontWeight: 700,
          letterSpacing: 0.5,
          fontSize: 14,
          pointerEvents: "none",
          transition: "color 120ms",
        }}
      >
        {progress >= 0.995 ? "UNLOCKED" : "SLIDE TO VIEW ROSTER →"}
      </div>
      <div
        ref={handleRef}
        onMouseDown={(e) => {
          draggingRef.current = true;
          setFromClientX(e.clientX);
        }}
        onTouchStart={(e) => {
          draggingRef.current = true;
          const t = e.touches[0];
          if (t) setFromClientX(t.clientX);
        }}
        style={{
          position: "absolute",
          top: 4,
          left: `calc(${progress * 100}% - ${progress * handleSize}px)`,
          width: handleSize,
          height: handleSize,
          borderRadius: "50%",
          background: "white",
          boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "grab",
          fontSize: 22,
          color: "#7f1d1d",
          transition: draggingRef.current ? "none" : "left 200ms",
        }}
      >
        →
      </div>
    </div>
  );
}
