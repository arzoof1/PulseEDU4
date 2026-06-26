import { useCallback, useEffect, useRef, useState } from "react";
import { openRecordingStudio, STUDIO_SCRIPT_KEY } from "./launch";

// Locked product decision: 5-minute maximum recording length.
const MAX_SECONDS = 5 * 60;

// Reference px/sec the teleprompter animation is built at; live speed is applied
// as a playbackRate multiple of this so changing speed never resets position.
const SCROLL_BASE_SPEED = 100;

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];
  return candidates.find((t) => {
    try {
      return MediaRecorder.isTypeSupported(t);
    } catch {
      return false;
    }
  });
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const page: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  // Sit above the app's global floating "?" help bubble (z-index ~1200) so it
  // doesn't bleed through and cover the studio's own controls. The studio has
  // its own "? Help" in the header.
  zIndex: 2000,
  background: "#0b0f14",
  color: "#e5e7eb",
  display: "flex",
  flexDirection: "column",
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
};

// Floating circular button (top-corner Close / Help) layered over the camera.
const roundBtn: React.CSSProperties = {
  position: "absolute",
  top: "0.9rem",
  left: "0.9rem",
  width: "2.4rem",
  height: "2.4rem",
  borderRadius: "50%",
  border: "none",
  background: "rgba(17,24,39,0.6)",
  backdropFilter: "blur(6px)",
  WebkitBackdropFilter: "blur(6px)",
  color: "#fff",
  fontSize: "1.1rem",
  fontWeight: 700,
  cursor: "pointer",
  zIndex: 18,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

// Compact icon button used for the collapsible adjusters + transport controls.
const iconBtnBase: React.CSSProperties = {
  appearance: "none",
  border: "1px solid rgba(255,255,255,0.18)",
  background: "rgba(17,24,39,0.55)",
  backdropFilter: "blur(6px)",
  WebkitBackdropFilter: "blur(6px)",
  color: "#fff",
  borderRadius: "12px",
  width: "3.1rem",
  height: "3.1rem",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "2px",
  cursor: "pointer",
  flexShrink: 0,
  padding: 0,
};

const iconBtnActive: React.CSSProperties = {
  background: "rgba(37,99,235,0.85)",
  borderColor: "#2563eb",
};

const btn: React.CSSProperties = {
  appearance: "none",
  border: "1px solid #374151",
  background: "#1f2937",
  color: "#e5e7eb",
  padding: "0.5rem 0.9rem",
  borderRadius: "8px",
  fontSize: "0.9rem",
  fontWeight: 600,
  cursor: "pointer",
};

const sliderLabel: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.15rem",
  fontSize: "0.75rem",
  color: "#9ca3af",
  minWidth: "140px",
};

const checkLabel: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.4rem",
  fontSize: "0.8rem",
  color: "#cbd5e1",
  cursor: "pointer",
};

type AdjusterKey = "speed" | "font" | "spacing" | "width" | "lines" | "more";

interface RecordingStudioProps {
  // When rendered in-app, the parent passes the teleprompter script and gets
  // the kept take back via onKeepTake. When rendered standalone at /studio
  // (fallback for camera-blocked browsers), all props are absent and the
  // script is read from localStorage.
  initialScript?: string;
  onClose?: () => void;
  onKeepTake?: (video: { blob: Blob; mimeType: string; durationSec: number }) => void;
}

export default function RecordingStudio({
  initialScript,
  onClose,
  onKeepTake,
}: RecordingStudioProps) {
  const [script, setScript] = useState("");
  const [editingScript, setEditingScript] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const [kept, setKept] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const [scrolling, setScrolling] = useState(false);
  const [speed, setSpeed] = useState(40); // px/sec
  const [fontSize, setFontSize] = useState(36); // px
  const [lineHeight, setLineHeight] = useState(1.3);
  const [promptWidth, setPromptWidth] = useState(55); // % of screen width
  const [linesVisible, setLinesVisible] = useState(3);
  const [condenseBlanks, setCondenseBlanks] = useState(true);
  const [mirrorCam, setMirrorCam] = useState(true);
  const [mirrorText, setMirrorText] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const prompterRef = useRef<HTMLDivElement | null>(null);
  const prompterInnerRef = useRef<HTMLDivElement | null>(null);
  const animRef = useRef<Animation | null>(null);
  const timerRef = useRef<number | null>(null);
  const recordedUrlRef = useRef<string | null>(null);
  const recordedBlobRef = useRef<Blob | null>(null);
  const recordingRef = useRef(false);
  const elapsedRef = useRef(0);
  const mountedRef = useRef(true);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const meterRafRef = useRef<number | null>(null);
  const lastClipRef = useRef(0);

  const [level, setLevel] = useState(0);
  const [clipping, setClipping] = useState(false);

  // Layout orientation drives where the floating controls sit (bottom strip in
  // portrait, right rail in landscape). Separate from the *capture* orientation
  // above — this is purely about chrome placement.
  const [viewportPortrait, setViewportPortrait] = useState<boolean>(() =>
    typeof window === "undefined"
      ? true
      : (window.matchMedia?.("(orientation: portrait)").matches ??
        window.innerHeight > window.innerWidth),
  );
  // Which adjuster popover is open (only one at a time); null = none open.
  const [openAdjuster, setOpenAdjuster] = useState<AdjusterKey | null>(null);

  useEffect(() => {
    document.title = "Recording Studio · PulseEDU";
    if (initialScript != null) {
      setScript(initialScript);
      return;
    }
    try {
      const s = localStorage.getItem(STUDIO_SCRIPT_KEY);
      if (s) setScript(s);
    } catch {
      // ignore storage failures
    }
  }, [initialScript]);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  // Whether the current viewport is portrait — drives the capture aspect so a
  // phone/iPad records portrait when held vertically, landscape when sideways.
  const isPortrait = useCallback(
    () =>
      window.matchMedia?.("(orientation: portrait)").matches ??
      window.innerHeight > window.innerWidth,
    [],
  );

  // The orientation the LIVE stream is currently captured in, so the rotation
  // listener can skip re-acquiring when nothing actually changed.
  const captureOrientationRef = useRef<"portrait" | "landscape" | null>(null);
  // Guards against overlapping getUserMedia calls (rapid rotations).
  const acquiringRef = useRef(false);

  // Stop the mic-level meter (rAF loop + analyser + audio context).
  const stopMeter = useCallback(() => {
    if (meterRafRef.current != null) {
      cancelAnimationFrame(meterRafRef.current);
      meterRafRef.current = null;
    }
    analyserRef.current?.disconnect();
    analyserRef.current = null;
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      void audioCtxRef.current.close().catch(() => {});
    }
    audioCtxRef.current = null;
  }, []);

  // Tap the mic for a live level meter. The analyser is connected to the source
  // ONLY (never to destination) so the user doesn't hear themselves. The rAF
  // loop reads time-domain samples to compute RMS (meter fill) and peak (clip).
  const startMeter = useCallback((s: MediaStream) => {
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const source = ctx.createMediaStreamSource(s);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;

      const data = new Float32Array(analyser.fftSize);
      const tick = () => {
        const a = analyserRef.current;
        if (!a || !mountedRef.current) return;
        a.getFloatTimeDomainData(data);
        let sumSquares = 0;
        let peak = 0;
        for (let i = 0; i < data.length; i++) {
          const v = data[i];
          sumSquares += v * v;
          const abs = Math.abs(v);
          if (abs > peak) peak = abs;
        }
        const rms = Math.sqrt(sumSquares / data.length);
        // Scale RMS to a 0–1 meter range; ~0.5 RMS is already very hot.
        const next = Math.min(1, rms * 2.2);
        setLevel(next);
        const now = Date.now();
        if (peak >= 0.98) lastClipRef.current = now;
        setClipping(now - lastClipRef.current < 1000);
        meterRafRef.current = requestAnimationFrame(tick);
      };
      meterRafRef.current = requestAnimationFrame(tick);
    } catch {
      // Audio metering is best-effort; ignore failures.
    }
  }, []);

  // Acquire (or re-acquire) the camera + mic for the given orientation. Captures
  // in the device's current orientation — a phone/iPad held vertically records a
  // portrait frame, not a cropped landscape one. Tears down any prior stream +
  // meter first, then swaps the new stream in.
  const acquireStream = useCallback(
    async (portrait: boolean) => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setMediaError(
          "This browser can't access the camera. Try the latest Chrome, Edge, or Safari.",
        );
        return;
      }
      if (acquiringRef.current) return;
      acquiringRef.current = true;
      const longEdge = { ideal: 1280 };
      const shortEdge = { ideal: 720 };
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: {
            width: portrait ? shortEdge : longEdge,
            height: portrait ? longEdge : shortEdge,
            facingMode: "user",
          },
          audio: true,
        });
        if (!mountedRef.current) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        // Swap the live stream: stop the old meter + tracks, then attach new.
        stopMeter();
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = s;
        captureOrientationRef.current = portrait ? "portrait" : "landscape";
        setStream(s);
        setMediaError(null);
        startMeter(s);
      } catch (err) {
        if (!mountedRef.current) return;
        const name = (err as DOMException)?.name;
        setMediaError(
          name === "NotAllowedError" || name === "SecurityError"
            ? "Camera and microphone access was blocked. If this page is inside the Replit preview, open it in its own browser tab, then allow access when prompted."
            : name === "NotFoundError"
              ? "No camera or microphone was found on this device."
              : "Couldn't start the camera. Please check your device and try again.",
        );
      } finally {
        acquiringRef.current = false;
      }
    },
    [startMeter, stopMeter],
  );

  // Acquire camera + mic on mount (in the current orientation).
  useEffect(() => {
    mountedRef.current = true;
    void acquireStream(isPortrait());
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      stopMeter();
    };
  }, [acquireStream, isPortrait, stopMeter]);

  // Live re-acquisition: when the device rotates, re-open the camera in the new
  // orientation so the frame follows the device. Skipped while recording (never
  // swap the stream mid-take) or while reviewing a finished clip.
  useEffect(() => {
    const onOrientation = () => {
      if (recordingRef.current || recordedUrlRef.current) return;
      const want = isPortrait() ? "portrait" : "landscape";
      if (captureOrientationRef.current === want) return;
      void acquireStream(want === "portrait");
    };
    const mq = window.matchMedia?.("(orientation: portrait)");
    mq?.addEventListener?.("change", onOrientation);
    window.addEventListener("orientationchange", onOrientation);
    return () => {
      mq?.removeEventListener?.("change", onOrientation);
      window.removeEventListener("orientationchange", onOrientation);
    };
  }, [acquireStream, isPortrait]);

  // Track viewport orientation for control placement (bottom strip in portrait,
  // right rail in landscape). Layout-only, cheap state update.
  useEffect(() => {
    const update = () => setViewportPortrait(isPortrait());
    update();
    const mq = window.matchMedia?.("(orientation: portrait)");
    mq?.addEventListener?.("change", update);
    window.addEventListener("resize", update);
    return () => {
      mq?.removeEventListener?.("change", update);
      window.removeEventListener("resize", update);
    };
  }, [isPortrait]);

  // Attach the live stream to the preview element.
  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  // Teleprompter scroll is driven by the Web Animations API animating a
  // translateY transform on the script, NOT by setting scrollTop each rAF
  // frame. A transform animation is handed to the COMPOSITOR thread, so it
  // keeps gliding smoothly even when the main thread is briefly busy (camera
  // encoding, the rest of the staff app polling/re-rendering underneath this
  // overlay). That main-thread contention is exactly what caused the script to
  // pause. Speed = playbackRate so changing it never restarts the position.
  //
  // Effect 1: build/rebuild the animation whenever the content geometry changes
  // (script text, font, width, visible-lines, etc.). Progress is preserved
  // across a rebuild so resizing mid-read doesn't snap the script back.
  useEffect(() => {
    const container = prompterRef.current;
    const inner = prompterInnerRef.current;

    const prev = animRef.current;
    let prevFraction = 0;
    if (prev) {
      const t = typeof prev.currentTime === "number" ? prev.currentTime : 0;
      const d = Number(prev.effect?.getComputedTiming().duration) || 0;
      prevFraction = d > 0 ? Math.min(1, t / d) : 0;
      prev.cancel();
      animRef.current = null;
    }

    if (!container || !inner) return;
    // Same distance the browser would allow scrollTop to travel.
    const distance = container.scrollHeight - container.clientHeight;
    if (distance < 1) return;

    const duration = (distance / SCROLL_BASE_SPEED) * 1000;
    // translate3d (not translateY) forces the element onto its own GPU layer so
    // the animation is driven by the COMPOSITOR thread. This is the difference
    // that matters: the staff app underneath keeps re-rendering on the main
    // thread (plain setInterval polling), and a main-thread animation visibly
    // pauses then jumps to catch up. A composited transform ignores that churn.
    const anim = inner.animate(
      [{ transform: "translate3d(0,0,0)" }, { transform: `translate3d(0,${-distance}px,0)` }],
      { duration, easing: "linear", fill: "both" },
    );
    anim.playbackRate = speed / SCROLL_BASE_SPEED;
    anim.currentTime = prevFraction * duration;
    anim.onfinish = () => setScrolling(false);
    if (scrolling) anim.play();
    else anim.pause();
    animRef.current = anim;

    return () => {
      anim.cancel();
      if (animRef.current === anim) animRef.current = null;
    };
    // `scrolling` is intentionally omitted — play/pause is handled in Effect 2
    // so toggling it doesn't tear down and rebuild the animation. The geometry
    // deps below are the raw state the prompter size/content derive from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [script, fontSize, lineHeight, promptWidth, linesVisible, condenseBlanks, editingScript, recordedUrl]);

  // Effect 2: play / pause without rebuilding (preserves position).
  useEffect(() => {
    const anim = animRef.current;
    if (!anim) return;
    if (scrolling) anim.play();
    else anim.pause();
  }, [scrolling]);

  // Effect 3: live speed changes map to playbackRate (no position reset).
  useEffect(() => {
    const anim = animRef.current;
    if (anim) anim.playbackRate = speed / SCROLL_BASE_SPEED;
  }, [speed]);

  // Full teardown on unmount: mark unmounted (so async recorder/getUserMedia
  // callbacks skip state writes), detach recorder handlers, stop any in-flight
  // recording, revoke the object URL, and clear the timer.
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      const rec = recorderRef.current;
      if (rec) {
        rec.ondataavailable = null;
        rec.onstop = null;
        if (rec.state !== "inactive") {
          try {
            rec.stop();
          } catch {
            // already stopped
          }
        }
      }
      if (recordedUrlRef.current) URL.revokeObjectURL(recordedUrlRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
      if (meterRafRef.current != null) {
        cancelAnimationFrame(meterRafRef.current);
        meterRafRef.current = null;
      }
      analyserRef.current?.disconnect();
      analyserRef.current = null;
      if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
        void audioCtxRef.current.close().catch(() => {});
      }
      audioCtxRef.current = null;
    };
  }, []);

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setRecording(false);
    setScrolling(false);
  }, []);

  const startRecording = useCallback(() => {
    if (!streamRef.current) return;
    if (recordedUrlRef.current) {
      URL.revokeObjectURL(recordedUrlRef.current);
      recordedUrlRef.current = null;
    }
    setRecordedUrl(null);
    setKept(false);
    chunksRef.current = [];
    const mimeType = pickMimeType();
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(
        streamRef.current,
        mimeType ? { mimeType } : undefined,
      );
    } catch {
      setMediaError("Video recording isn't supported in this browser.");
      return;
    }
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      const type = chunksRef.current[0]?.type || "video/webm";
      const blob = new Blob(chunksRef.current, { type });
      if (!mountedRef.current) return;
      recordedBlobRef.current = blob;
      const url = URL.createObjectURL(blob);
      recordedUrlRef.current = url;
      setRecordedUrl(url);
    };
    recorderRef.current = rec;
    rec.start();
    setRecording(true);
    setElapsed(0);
    elapsedRef.current = 0;
    resetScroll();
    setScrolling(true);
    const startedAt = Date.now();
    timerRef.current = window.setInterval(() => {
      const e = Math.floor((Date.now() - startedAt) / 1000);
      elapsedRef.current = e;
      setElapsed(e);
      if (e >= MAX_SECONDS) stopRecording();
    }, 250);
  }, [stopRecording]);

  // Send the teleprompter back to the top. With the WebAnimation driving a
  // transform, "top" = currentTime 0; we also clear any held transform in case
  // the animation hasn't been built yet (short script / not visible).
  function resetScroll() {
    const anim = animRef.current;
    if (anim) anim.currentTime = 0;
    const inner = prompterInnerRef.current;
    if (inner) inner.style.transform = "translateY(0px)";
  }

  function reRecord() {
    if (recordedUrlRef.current) {
      URL.revokeObjectURL(recordedUrlRef.current);
      recordedUrlRef.current = null;
    }
    recordedBlobRef.current = null;
    setRecordedUrl(null);
    setKept(false);
    setElapsed(0);
    elapsedRef.current = 0;
    resetScroll();
  }

  // From the review screen: drop the current take and jump straight back into
  // the script editor. The script text persists, so nothing is lost.
  function editScriptFromReview() {
    reRecord();
    setEditingScript(true);
  }

  function keepTake() {
    setKept(true);
    if (recordedBlobRef.current) {
      onKeepTake?.({
        blob: recordedBlobRef.current,
        mimeType: recordedBlobRef.current.type,
        durationSec: elapsedRef.current,
      });
    }
  }

  // Keyboard / Bluetooth presentation-remote shortcuts. Most remotes emit
  // standard keyboard events (Space/arrows/PageUp/PageDown), so a single
  // keydown handler covers them.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      switch (e.key) {
        case " ":
        case "Enter":
          e.preventDefault();
          setScrolling((s) => !s);
          break;
        case "ArrowUp":
        case "PageUp":
          e.preventDefault();
          setSpeed((v) => Math.min(200, v + 5));
          break;
        case "ArrowDown":
        case "PageDown":
          e.preventDefault();
          setSpeed((v) => Math.max(10, v - 5));
          break;
        case "r":
        case "R":
          e.preventDefault();
          if (recordingRef.current) stopRecording();
          else startRecording();
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [startRecording, stopRecording]);

  if (mediaError) {
    return (
      <div style={page}>
        <div style={{ margin: "auto", maxWidth: 540, padding: "2rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.4rem", marginBottom: "0.75rem" }}>Recording Studio</h1>
          <p style={{ color: "#fca5a5", lineHeight: 1.6 }}>{mediaError}</p>
          <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center", marginTop: "1rem", flexWrap: "wrap" }}>
            {onClose ? (
              <>
                <button
                  style={btn}
                  onClick={() => {
                    openRecordingStudio(script);
                    onClose();
                  }}
                >
                  Open in a new tab instead
                </button>
                <button style={btn} onClick={onClose}>
                  Close
                </button>
              </>
            ) : (
              <button style={btn} onClick={() => window.location.reload()}>
                Try again
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const remaining = MAX_SECONDS - elapsed;
  const timerColor = recording
    ? remaining <= 30
      ? "#fbbf24"
      : "#f87171"
    : "#9ca3af";
  const hasScript = script.trim().length > 0;
  // The AI draft often separates paragraphs with blank lines, which leave big
  // gaps on the teleprompter. Collapse runs of blank lines for the prompter
  // display only — the editable script keeps its original formatting.
  const displayScript = condenseBlanks
    ? script.replace(/\n{2,}/g, "\n")
    : script;
  // Clamp the prompter window to a chosen number of lines so the eye stays in a
  // tight band near the lens instead of travelling down the page. 56px ≈ the
  // container's top (1.5rem) + bottom (2rem) padding.
  const prompterHeight = Math.round(linesVisible * fontSize * lineHeight + 56);
  const portrait = viewportPortrait;
  const meterColor =
    clipping || level >= 0.85
      ? "#dc2626"
      : level >= 0.65
        ? "#facc15"
        : "#16a34a";

  // The six collapsible adjusters; each opens a single slider/toggle popover.
  const adjusters: Array<[AdjusterKey, string, string]> = [
    ["speed", "»", "Speed"],
    ["font", "A", "Size"],
    ["spacing", "≡", "Spacing"],
    ["width", "↔", "Width"],
    ["lines", "☰", "Lines"],
    ["more", "⋯", "More"],
  ];

  const adjusterButtons = adjusters.map(([key, glyph, label]) => {
    const active = openAdjuster === key;
    return (
      <button
        key={key}
        type="button"
        aria-label={label}
        onClick={() => setOpenAdjuster((cur) => (cur === key ? null : key))}
        style={{ ...iconBtnBase, ...(active ? iconBtnActive : null) }}
      >
        <span style={{ fontSize: "1.15rem", lineHeight: 1 }}>{glyph}</span>
        <span style={{ fontSize: "0.58rem", opacity: 0.9, fontWeight: 600 }}>
          {label}
        </span>
      </button>
    );
  });

  const timerChip = (
    <div
      style={{
        fontVariantNumeric: "tabular-nums",
        fontWeight: 800,
        fontSize: "0.95rem",
        color: timerColor,
        background: "rgba(0,0,0,0.5)",
        padding: "0.25rem 0.55rem",
        borderRadius: "8px",
        whiteSpace: "nowrap",
      }}
    >
      {fmt(elapsed)}
    </div>
  );

  const recordButton = (
    <button
      type="button"
      aria-label={recording ? "Stop recording" : "Start recording"}
      onClick={recording ? stopRecording : startRecording}
      disabled={!stream || editingScript}
      style={{
        width: "66px",
        height: "66px",
        borderRadius: "50%",
        border: "4px solid rgba(255,255,255,0.9)",
        background: !stream || editingScript ? "#7f1d1d" : "#dc2626",
        cursor: !stream || editingScript ? "default" : "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        padding: 0,
        boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
      }}
    >
      {recording ? (
        <span style={{ width: "22px", height: "22px", borderRadius: "5px", background: "#fff" }} />
      ) : null}
    </button>
  );

  const playPauseButton = (
    <button
      type="button"
      aria-label={scrolling ? "Pause script" : "Play script"}
      onClick={() => setScrolling((s) => !s)}
      disabled={!hasScript || editingScript}
      style={{ ...iconBtnBase, opacity: !hasScript || editingScript ? 0.4 : 1 }}
    >
      <span style={{ fontSize: "1.15rem", lineHeight: 1 }}>{scrolling ? "⏸" : "▶"}</span>
      <span style={{ fontSize: "0.58rem", opacity: 0.9, fontWeight: 600 }}>
        {scrolling ? "Pause" : "Play"}
      </span>
    </button>
  );

  const restartButton = (
    <button
      type="button"
      aria-label="Restart script"
      onClick={() => {
        setScrolling(false);
        resetScroll();
      }}
      disabled={!hasScript || editingScript}
      style={{ ...iconBtnBase, opacity: !hasScript || editingScript ? 0.4 : 1 }}
    >
      <span style={{ fontSize: "1.15rem", lineHeight: 1 }}>↻</span>
      <span style={{ fontSize: "0.58rem", opacity: 0.9, fontWeight: 600 }}>Restart</span>
    </button>
  );

  const flipButton = (
    <button
      type="button"
      aria-label="Mirror camera"
      onClick={() => setMirrorCam((v) => !v)}
      style={{ ...iconBtnBase, ...(mirrorCam ? iconBtnActive : null) }}
    >
      <span style={{ fontSize: "1.15rem", lineHeight: 1 }}>⇄</span>
      <span style={{ fontSize: "0.58rem", opacity: 0.9, fontWeight: 600 }}>Flip</span>
    </button>
  );

  // Popover body for whichever adjuster is open.
  const sliderField = (
    label: string,
    valueText: string,
    min: number,
    max: number,
    step: number,
    value: number,
    onChange: (v: number) => void,
  ) => (
    <label
      style={{
        ...sliderLabel,
        minWidth: portrait ? "68vw" : "240px",
        maxWidth: "340px",
        color: "#e5e7eb",
      }}
    >
      <span style={{ fontSize: "0.82rem", fontWeight: 600 }}>
        {label}: {valueText}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );

  let adjusterPanel: React.ReactNode = null;
  if (openAdjuster === "speed")
    adjusterPanel = sliderField("Speed", String(speed), 10, 200, 1, speed, setSpeed);
  else if (openAdjuster === "font")
    adjusterPanel = sliderField("Text size", `${fontSize}px`, 24, 80, 2, fontSize, setFontSize);
  else if (openAdjuster === "spacing")
    adjusterPanel = sliderField("Line spacing", lineHeight.toFixed(1), 1, 2.2, 0.1, lineHeight, setLineHeight);
  else if (openAdjuster === "width")
    adjusterPanel = sliderField("Reading width", `${promptWidth}%`, 25, 100, 5, promptWidth, setPromptWidth);
  else if (openAdjuster === "lines")
    adjusterPanel = sliderField("Visible lines", String(linesVisible), 1, 8, 1, linesVisible, setLinesVisible);
  else if (openAdjuster === "more")
    adjusterPanel = (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.6rem",
          minWidth: portrait ? "68vw" : "220px",
          maxWidth: "340px",
        }}
      >
        <label style={checkLabel}>
          <input type="checkbox" checked={mirrorCam} onChange={(e) => setMirrorCam(e.target.checked)} />
          Mirror camera
        </label>
        <label style={checkLabel}>
          <input type="checkbox" checked={mirrorText} onChange={(e) => setMirrorText(e.target.checked)} />
          Mirror text
        </label>
        <label style={checkLabel}>
          <input type="checkbox" checked={condenseBlanks} onChange={(e) => setCondenseBlanks(e.target.checked)} />
          Condense blank lines
        </label>
      </div>
    );

  return (
    <div style={page}>
      {/* Fullscreen camera */}
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        onClick={() => setOpenAdjuster(null)}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          background: "#000",
          transform: mirrorCam ? "scaleX(-1)" : "none",
        }}
      />

      {/* Close / Help */}
      <button
        type="button"
        aria-label="Close studio"
        onClick={() => (onClose ? onClose() : window.close())}
        style={roundBtn}
      >
        ✕
      </button>
      <button
        type="button"
        aria-label="Help"
        onClick={() => setShowHelp(true)}
        style={{ ...roundBtn, left: "auto", right: "0.9rem" }}
      >
        ?
      </button>

      {/* Recording indicator */}
      {recording && (
        <div
          style={{
            position: "absolute",
            top: "0.95rem",
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            gap: "0.4rem",
            padding: "0.28rem 0.7rem",
            borderRadius: "999px",
            background: "rgba(220,38,38,0.92)",
            color: "#fff",
            fontSize: "0.78rem",
            fontWeight: 800,
            letterSpacing: "0.04em",
            zIndex: 17,
          }}
        >
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#fff" }} />
          REC
        </div>
      )}

      {/* Teleprompter — large shadowed text directly over the video */}
      {!editingScript && !recordedUrl && (
        <div
          ref={prompterRef}
          style={{
            position: "absolute",
            top: portrait ? "3.6rem" : "1.4rem",
            left: portrait ? 0 : "1.5rem",
            right: portrait ? 0 : "auto",
            width: portrait ? "auto" : `${promptWidth}%`,
            maxWidth: portrait ? "100%" : "62%",
            height: `${prompterHeight}px`,
            maxHeight: portrait ? "50%" : "72%",
            overflow: "hidden",
            padding: portrait ? "0 1.1rem" : 0,
            transform: mirrorText ? "scaleX(-1)" : "none",
            pointerEvents: "none",
            zIndex: 8,
          }}
        >
          <div
            ref={prompterInnerRef}
            style={{
              fontSize: `${fontSize}px`,
              lineHeight,
              fontWeight: 700,
              textAlign: "left",
              whiteSpace: "pre-wrap",
              color: "#fff",
              textShadow: "0 2px 12px rgba(0,0,0,0.95), 0 0 3px rgba(0,0,0,0.85)",
              maxWidth: portrait ? `${promptWidth}%` : "100%",
              willChange: "transform",
              backfaceVisibility: "hidden",
              transform: "translateZ(0)",
            }}
          >
            {hasScript ? displayScript : "No script yet — tap “Edit” to add one, or just record."}
          </div>
        </div>
      )}

      {/* Edit pill */}
      {!editingScript && !recordedUrl && (
        <button
          type="button"
          onClick={() => {
            setScrolling(false);
            setEditingScript(true);
          }}
          disabled={recording}
          style={{
            position: "absolute",
            left: portrait ? "1.1rem" : "1.5rem",
            bottom: portrait ? "10.5rem" : "4.2rem",
            display: "inline-flex",
            alignItems: "center",
            gap: "0.3rem",
            padding: "0.35rem 0.7rem",
            borderRadius: "999px",
            border: "1px solid rgba(255,255,255,0.25)",
            background: "rgba(17,24,39,0.6)",
            backdropFilter: "blur(6px)",
            WebkitBackdropFilter: "blur(6px)",
            color: "#fff",
            fontSize: "0.8rem",
            fontWeight: 600,
            cursor: "pointer",
            zIndex: 14,
            opacity: recording ? 0.4 : 1,
          }}
        >
          ✎ Edit
        </button>
      )}

      {/* Mic level meter (vertical in portrait, horizontal in landscape) */}
      {stream &&
        !recordedUrl &&
        !editingScript &&
        (portrait ? (
          <div
            style={{
              position: "absolute",
              right: "0.7rem",
              top: "26%",
              height: "38%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "0.45rem",
              zIndex: 9,
              pointerEvents: "none",
            }}
          >
            <div
              style={{
                position: "relative",
                flex: 1,
                width: "8px",
                borderRadius: "4px",
                background: "rgba(17,24,39,0.8)",
                border: "1px solid rgba(148,163,184,0.25)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: `${Math.round(level * 100)}%`,
                  background: meterColor,
                  transition: "height 90ms linear, background-color 120ms linear",
                }}
              />
            </div>
            <span aria-hidden style={{ fontSize: "1rem" }}>
              🎙️
            </span>
          </div>
        ) : (
          <div
            style={{
              position: "absolute",
              left: "1.4rem",
              bottom: "1.3rem",
              width: "min(42%, 300px)",
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              zIndex: 9,
              pointerEvents: "none",
            }}
          >
            <span aria-hidden style={{ fontSize: "1rem" }}>
              🎙️
            </span>
            <div
              style={{
                position: "relative",
                flex: 1,
                height: "8px",
                borderRadius: "4px",
                background: "rgba(17,24,39,0.8)",
                border: "1px solid rgba(148,163,184,0.25)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: 0,
                  width: `${Math.round(level * 100)}%`,
                  background: meterColor,
                  transition: "width 90ms linear, background-color 120ms linear",
                }}
              />
            </div>
          </div>
        ))}

      {/* Script editor */}
      {editingScript && (
        <div style={{ position: "absolute", inset: 0, background: "rgba(11,15,20,0.94)", padding: "1.5rem", display: "flex", flexDirection: "column", gap: "0.75rem", zIndex: 30 }}>
          <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Teleprompter script</h2>
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            placeholder="Paste or type what you want to read on camera…"
            style={{
              flex: 1,
              width: "100%",
              boxSizing: "border-box",
              background: "#0f1620",
              color: "#e5e7eb",
              border: "1px solid #334155",
              borderRadius: "10px",
              padding: "1rem",
              fontSize: "1.05rem",
              lineHeight: 1.5,
              resize: "none",
              fontFamily: "inherit",
            }}
          />
          <div>
            <button style={{ ...btn, background: "#2563eb", borderColor: "#2563eb" }} onClick={() => setEditingScript(false)}>
              Done
            </button>
          </div>
        </div>
      )}

      {/* Review overlay */}
      {recordedUrl && (
        <div style={{ position: "absolute", inset: 0, background: "rgba(11,15,20,0.94)", padding: "1.5rem", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "1rem", zIndex: 30 }}>
          <h2 style={{ margin: 0, fontSize: "1.15rem" }}>Review your take</h2>
          <video
            src={recordedUrl}
            controls
            style={{ maxWidth: "min(100%, 900px)", maxHeight: "60vh", borderRadius: "10px", background: "#000" }}
          />
          {kept ? (
            <p style={{ color: "#86efac", margin: 0, textAlign: "center" }}>
              Take saved for this session. Sending it to families arrives in the next update.
            </p>
          ) : (
            <p style={{ color: "#9ca3af", margin: 0, textAlign: "center" }}>
              Happy with it? Keep this take, or record again.
            </p>
          )}
          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", justifyContent: "center" }}>
            <button style={btn} onClick={editScriptFromReview}>
              Edit script
            </button>
            <button style={btn} onClick={reRecord}>
              Record again
            </button>
            <button
              style={{ ...btn, background: "#16a34a", borderColor: "#16a34a" }}
              onClick={keepTake}
              disabled={kept}
            >
              {kept ? "Take kept" : "Use this take"}
            </button>
          </div>
        </div>
      )}

      {/* Adjuster popover (one at a time) */}
      {openAdjuster && !recordedUrl && !editingScript && (
        <div
          style={{
            position: "absolute",
            ...(portrait
              ? { left: "50%", bottom: "11rem", transform: "translateX(-50%)" }
              : { right: "7.2rem", top: "50%", transform: "translateY(-50%)" }),
            background: "rgba(15,22,32,0.97)",
            border: "1px solid #334155",
            borderRadius: "14px",
            padding: "0.95rem 1.1rem",
            maxWidth: "92vw",
            boxShadow: "0 18px 50px rgba(0,0,0,0.55)",
            zIndex: 22,
          }}
        >
          {adjusterPanel}
        </div>
      )}

      {/* Control cluster — bottom strip (portrait) / right rail (landscape) */}
      {!recordedUrl &&
        !editingScript &&
        (portrait ? (
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              padding: "0.7rem 0.7rem 1rem",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "0.65rem",
              zIndex: 16,
              background: "linear-gradient(0deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 100%)",
            }}
          >
            <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap", justifyContent: "center" }}>
              {adjusterButtons}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexWrap: "wrap",
                gap: "0.6rem",
              }}
            >
              {timerChip}
              {restartButton}
              {playPauseButton}
              {recordButton}
              {flipButton}
            </div>
          </div>
        ) : (
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              right: 0,
              width: "6.4rem",
              padding: "0.8rem 0.4rem",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "0.55rem",
              overflowY: "auto",
              zIndex: 16,
              background: "linear-gradient(90deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.5) 100%)",
            }}
          >
            {timerChip}
            {recordButton}
            {flipButton}
            {playPauseButton}
            {restartButton}
            <div style={{ width: "70%", height: "1px", background: "rgba(148,163,184,0.3)", margin: "0.15rem 0" }} />
            {adjusterButtons}
          </div>
        ))}

      {showHelp && <HelpPanel onClose={() => setShowHelp(false)} />}
    </div>
  );
}

/**
 * Self-contained directions panel for the studio. Lives inside the
 * full-screen overlay because the app's global "?" help bubble sits
 * behind this overlay and isn't aware of the studio (the studio has no
 * URL of its own). Plain static guidance — no AI round-trip needed.
 */
function HelpPanel({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-label="Recording studio help"
      onClick={onClose}
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(2,6,12,0.78)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1.5rem",
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(720px, 100%)",
          maxHeight: "86vh",
          overflowY: "auto",
          background: "#0f1620",
          border: "1px solid #334155",
          borderRadius: "14px",
          padding: "1.5rem 1.6rem 1.75rem",
          boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
          lineHeight: 1.5,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "1rem",
            marginBottom: "0.5rem",
          }}
        >
          <h2 style={{ margin: 0, fontSize: "1.2rem" }}>Recording studio — how it works</h2>
          <button style={btn} onClick={onClose}>
            Close
          </button>
        </div>
        <p style={{ color: "#9ca3af", marginTop: 0, fontSize: "0.9rem" }}>
          Look into the camera (the small lens at the top of your screen), not at the
          words. Keep the teleprompter near the top so your eyes stay close to the lens.
        </p>

        <h3 style={helpHeading}>Record a video</h3>
        <ol style={helpList}>
          <li>Hit <strong>● Record</strong> to start. The timer turns red and counts up to the 5-minute limit.</li>
          <li>When you’re done, hit <strong>◼ Stop</strong>.</li>
          <li>Review your take, then choose <strong>Use this take</strong> to keep it or <strong>Record again</strong> to retry.</li>
        </ol>

        <h3 style={helpHeading}>Use the teleprompter</h3>
        <ol style={helpList}>
          <li><strong>Edit script</strong> (top right) to paste or type what you want to read.</li>
          <li><strong>Play script</strong> starts the text scrolling; <strong>Pause script</strong> stops it.</li>
          <li><strong>Restart script</strong> jumps back to the top.</li>
          <li>You can start scrolling before or after you hit Record — they’re independent.</li>
        </ol>

        <h3 style={helpHeading}>Dial in the reading experience</h3>
        <ul style={helpList}>
          <li><strong>Speed</strong> — how fast the text scrolls. Nudge it a point or two at a time until it matches your pace.</li>
          <li><strong>Text size</strong> — bigger is easier to read from a step back.</li>
          <li><strong>Line spacing</strong> — more space between lines if they feel crowded.</li>
          <li><strong>Reading width</strong> — narrows the text into a center column so your eyes stay by the lens.</li>
          <li><strong>Visible lines</strong> — limits how many lines show at once. Set it low (2–3) so you read across, not down the page.</li>
          <li><strong>Mirror camera / Mirror text</strong> — flip the picture or the words (handy with a glass teleprompter rig).</li>
          <li><strong>Condense blank lines</strong> — closes the gaps an AI draft leaves between paragraphs.</li>
        </ul>

        <h3 style={helpHeading}>Keyboard & clicker shortcuts</h3>
        <ul style={helpList}>
          <li><strong>Space</strong> — play / pause the script.</li>
          <li><strong>↑ / ↓</strong> (or Page Up / Page Down) — speed up / slow down.</li>
          <li><strong>R</strong> — start / stop recording.</li>
          <li>A Bluetooth presentation clicker sends these same keys, so you can drive the studio from across the room.</li>
        </ul>

        <p style={{ color: "#9ca3af", fontSize: "0.85rem", marginBottom: 0 }}>
          Tip: do one practice run with <strong>Play script</strong> before you hit
          Record so the speed feels natural.
        </p>
      </div>
    </div>
  );
}

const helpHeading: React.CSSProperties = {
  margin: "1.1rem 0 0.4rem",
  fontSize: "0.95rem",
  color: "#e5e7eb",
};

const helpList: React.CSSProperties = {
  margin: "0 0 0.4rem",
  paddingLeft: "1.2rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.3rem",
  color: "#cbd5e1",
  fontSize: "0.9rem",
};
