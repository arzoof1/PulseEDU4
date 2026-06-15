import { useEffect, useRef, useState } from "react";

// In-browser barcode/QR scanner modal.
//
// Strategy: prefer the native `BarcodeDetector` API (Chrome/Edge on
// modern devices — almost zero overhead, no big WASM payload). When it
// isn't available (Safari, Firefox) we lazy-load `@zxing/browser` and
// run its multi-format reader. Lazy-loading keeps the kiosk's initial
// JS payload small for the 95% of activations that never open the
// scanner.
//
// On a successful decode we vibrate (where supported), call onScan
// with the raw text, and close. The caller is responsible for any
// parsing (e.g. extracting `?signin=<id>` from a URL form).

type Phase = "starting" | "scanning" | "error";

interface Props {
  onScan: (text: string) => void;
  onCancel: () => void;
  // "environment" (default) targets the rear camera on phones for
  // student badge scanning. "user" targets the front-facing camera,
  // which is what a laptop / desktop kiosk needs when a teacher
  // holds their activation card up to the screen.
  facingMode?: "environment" | "user";
  label?: string;
  // When true, render in-flow (no fullscreen dark backdrop) so the scanner
  // can sit inside a column alongside other content — e.g. the attendance
  // kiosk, where the live name feed must stay visible while scanning.
  embedded?: boolean;
}

// Minimal subset of the BarcodeDetector API we actually use.
interface NativeDetector {
  detect(
    source: HTMLVideoElement,
  ): Promise<
    Array<{ rawValue: string; boundingBox?: { width: number; height: number } }>
  >;
}

declare global {
  interface Window {
    BarcodeDetector?: new (opts?: { formats?: string[] }) => NativeDetector;
  }
}

export function CameraScanner({
  onScan,
  onCancel,
  facingMode = "environment",
  label,
  embedded = false,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Tracks whether we've already fired onScan so a slow zxing controls
  // teardown doesn't deliver a second result after the parent has
  // already closed us.
  const firedRef = useRef(false);
  // Latest onScan in a ref so the mount effect doesn't depend on it.
  // The parent (KioskBody) re-renders every 1s from a clock tick, which
  // would otherwise tear down + restart getUserMedia every second and
  // leave the <video> permanently black.
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const [phase, setPhase] = useState<Phase>("starting");
  const [errorMsg, setErrorMsg] = useState<string>("");
  // True while a code is detected but not yet confirmed across enough frames —
  // tints the reticle green so the user knows to hold steady.
  const [locking, setLocking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let rafId: number | null = null;
    // Holds either the native BarcodeDetector instance or the zxing
    // controls returned by decodeFromVideoDevice. Either way, cleanup
    // is best-effort.
    let zxingControls: { stop: () => void } | null = null;

    function deliver(text: string) {
      if (firedRef.current) return;
      const cleaned = text.trim();
      if (!cleaned) return;
      firedRef.current = true;
      try {
        navigator.vibrate?.(80);
      } catch {
        // ignore — vibration is best-effort
      }
      onScanRef.current(cleaned);
    }

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play().catch(() => {});
        setPhase("scanning");

        // -------- Native BarcodeDetector path --------
        if (typeof window.BarcodeDetector === "function") {
          const detector = new window.BarcodeDetector({
            formats: ["qr_code", "code_128", "ean_13", "code_39"],
          });
          // Stabilization: only fire after the SAME value decodes on a few
          // consecutive frames AND the code is large enough in frame. This
          // stops the scanner from firing on the first flickering edge-read
          // before the code is actually held steady in view.
          let lastVal: string | null = null;
          let stable = 0;
          const MIN_STABLE = 3;
          let lockUi = false;
          const setLockUi = (on: boolean) => {
            if (on !== lockUi) {
              lockUi = on;
              if (!cancelled) setLocking(on);
            }
          };
          const tick = async () => {
            if (cancelled || firedRef.current) return;
            try {
              const codes = await detector.detect(video);
              // Prefer the largest candidate (closest / most centered).
              let best:
                | { rawValue: string; boundingBox?: { width: number } }
                | null = null;
              for (const c of codes) {
                if (!c.rawValue) continue;
                if (
                  !best ||
                  (c.boundingBox?.width ?? 0) > (best.boundingBox?.width ?? 0)
                ) {
                  best = c;
                }
              }
              const vw = video.videoWidth || 0;
              const bigEnough =
                !best?.boundingBox ||
                vw === 0 ||
                best.boundingBox.width >= vw * 0.2;
              if (best && bigEnough) {
                if (best.rawValue === lastVal) {
                  stable += 1;
                } else {
                  lastVal = best.rawValue;
                  stable = 1;
                }
                setLockUi(true);
                if (stable >= MIN_STABLE) {
                  setLockUi(false);
                  deliver(best.rawValue);
                  return;
                }
              } else {
                lastVal = null;
                stable = 0;
                setLockUi(false);
              }
            } catch {
              // BarcodeDetector throws transiently on some frames —
              // keep ticking, don't surface to user.
            }
            rafId = requestAnimationFrame(tick);
          };
          rafId = requestAnimationFrame(tick);
          return;
        }

        // -------- Lazy zxing fallback --------
        const mod = await import("@zxing/browser");
        if (cancelled) return;
        const reader = new mod.BrowserMultiFormatReader();
        // Same idea as the native path: require two consecutive identical
        // decodes before firing so a single noisy frame can't trigger early.
        let zLast: string | null = null;
        let zStable = 0;
        let zLockUi = false;
        const setZLockUi = (on: boolean) => {
          if (on !== zLockUi) {
            zLockUi = on;
            if (!cancelled) setLocking(on);
          }
        };
        const controls = await reader.decodeFromVideoElement(
          video,
          (result, _err, ctrls) => {
            if (firedRef.current) return;
            if (result) {
              const txt = result.getText();
              if (txt === zLast) {
                zStable += 1;
              } else {
                zLast = txt;
                zStable = 1;
              }
              setZLockUi(true);
              if (zStable >= 2) {
                setZLockUi(false);
                deliver(txt);
                try {
                  ctrls.stop();
                } catch {
                  // ignore
                }
              }
            }
          },
        );
        zxingControls = controls;
      } catch (err) {
        if (cancelled) return;
        const msg =
          err instanceof Error ? err.message : "Camera unavailable";
        setErrorMsg(msg);
        setPhase("error");
      }
    }

    void start();

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      try {
        zxingControls?.stop();
      } catch {
        // ignore
      }
      const stream = streamRef.current;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
    // Intentionally mount-once. facingMode and onScan are captured via
    // initial closure / ref; changing them mid-session would require a
    // remount anyway (new camera device, different consumer).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      role={embedded ? "group" : "dialog"}
      aria-modal={embedded ? undefined : "true"}
      aria-label="Scan badge"
      style={
        embedded
          ? {
              width: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              padding: 0,
            }
          : {
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.85)",
              zIndex: 100,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: "1rem",
            }
      }
    >
      <div
        style={{
          color: "#fff",
          fontSize: "0.95rem",
          marginBottom: "0.75rem",
          opacity: 0.85,
        }}
      >
        {phase === "starting" && "Starting camera…"}
        {phase === "scanning" &&
          (locking ? "Hold steady…" : (label ?? "Point the camera at the badge"))}
        {phase === "error" && `Camera error: ${errorMsg}`}
      </div>
      <div
        style={{
          position: "relative",
          width: embedded ? "100%" : "min(560px, 92vw)",
          aspectRatio: "4 / 3",
          background: "#000",
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
        }}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            background: "#000",
          }}
        />
        {/* Reticle */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: "15%",
            border: `2px solid ${
              locking ? "rgba(34,197,94,0.95)" : "rgba(255,255,255,0.7)"
            }`,
            borderRadius: 12,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.25)",
            pointerEvents: "none",
          }}
        />
      </div>
      <button
        type="button"
        onClick={onCancel}
        style={{
          marginTop: "1.25rem",
          background: "#fff",
          color: "#111",
          border: "none",
          borderRadius: 999,
          padding: "0.85rem 2rem",
          fontSize: "1rem",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Cancel
      </button>
    </div>
  );
}

export default CameraScanner;
