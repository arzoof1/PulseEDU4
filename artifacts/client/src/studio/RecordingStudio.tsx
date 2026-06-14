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

const headerBar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "0.6rem 1rem",
  borderBottom: "1px solid #1f2937",
  flexShrink: 0,
};

const ctrlBar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "0.75rem 1.25rem",
  padding: "0.75rem 1rem",
  borderTop: "1px solid #1f2937",
  flexShrink: 0,
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

  // Acquire camera + mic once on mount.
  useEffect(() => {
    let cancelled = false;
    async function init() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setMediaError(
          "This browser can't access the camera. Try the latest Chrome, Edge, or Safari.",
        );
        return;
      }
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
          audio: true,
        });
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = s;
        setStream(s);
      } catch (err) {
        if (cancelled) return;
        const name = (err as DOMException)?.name;
        setMediaError(
          name === "NotAllowedError" || name === "SecurityError"
            ? "Camera and microphone access was blocked. If this page is inside the Replit preview, open it in its own browser tab, then allow access when prompted."
            : name === "NotFoundError"
              ? "No camera or microphone was found on this device."
              : "Couldn't start the camera. Please check your device and try again.",
        );
      }
    }
    void init();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

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
      setElapsed(e);
      elapsedRef.current = e;
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

  return (
    <div style={page}>
      <div style={headerBar}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 700 }}>
          <span
            style={{
              width: "0.6rem",
              height: "0.6rem",
              borderRadius: "50%",
              background: recording ? "#dc2626" : "#4b5563",
            }}
          />
          Recording Studio
        </div>
        <div style={{ fontVariantNumeric: "tabular-nums", fontSize: "1.05rem", color: timerColor, fontWeight: 700 }}>
          {fmt(elapsed)} <span style={{ color: "#6b7280", fontWeight: 500 }}>/ {fmt(MAX_SECONDS)}</span>
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button style={btn} onClick={() => setShowHelp(true)}>
            ? Help
          </button>
          <button
            style={btn}
            onClick={() => setEditingScript((v) => !v)}
            disabled={recording}
          >
            {editingScript ? "Done editing" : "Edit script"}
          </button>
          <button style={btn} onClick={() => (onClose ? onClose() : window.close())}>
            Close
          </button>
        </div>
      </div>

      <div style={{ position: "relative", flex: 1, background: "#000", overflow: "hidden" }}>
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: mirrorCam ? "scaleX(-1)" : "none",
          }}
        />

        {/* Teleprompter overlay */}
        {!editingScript && !recordedUrl && (
          <div
            ref={prompterRef}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: `${prompterHeight}px`,
              maxHeight: "85%",
              overflow: "hidden",
              padding: "1.5rem 8% 2rem",
              background: "linear-gradient(180deg, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.55) 70%, rgba(0,0,0,0) 100%)",
              transform: mirrorText ? "scaleX(-1)" : "none",
              pointerEvents: "none",
            }}
          >
            <div
              ref={prompterInnerRef}
              style={{
                fontSize: `${fontSize}px`,
                lineHeight,
                fontWeight: 600,
                textAlign: "center",
                whiteSpace: "pre-wrap",
                color: "#f9fafb",
                textShadow: "0 2px 8px rgba(0,0,0,0.8)",
                maxWidth: `${promptWidth}%`,
                marginLeft: "auto",
                marginRight: "auto",
                willChange: "transform",
                backfaceVisibility: "hidden",
                transform: "translateZ(0)",
              }}
            >
              {hasScript ? displayScript : "No script yet — use “Edit script” to add one, or record freely."}
            </div>
          </div>
        )}

        {/* Script editor */}
        {editingScript && (
          <div style={{ position: "absolute", inset: 0, background: "rgba(11,15,20,0.92)", padding: "1.5rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
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
          <div style={{ position: "absolute", inset: 0, background: "rgba(11,15,20,0.94)", padding: "1.5rem", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "1rem" }}>
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
      </div>

      {/* Controls */}
      {!recordedUrl && (
        <div style={ctrlBar}>
          {recording ? (
            <button
              style={{ ...btn, background: "#dc2626", borderColor: "#dc2626", minWidth: "120px" }}
              onClick={stopRecording}
            >
              ◼ Stop
            </button>
          ) : (
            <button
              style={{ ...btn, background: "#dc2626", borderColor: "#dc2626", minWidth: "120px" }}
              onClick={startRecording}
              disabled={!stream || editingScript}
            >
              ● Record
            </button>
          )}

          <button
            style={btn}
            onClick={() => setScrolling((s) => !s)}
            disabled={!hasScript || editingScript}
          >
            {scrolling ? "Pause script" : "Play script"}
          </button>
          <button
            style={btn}
            onClick={() => {
              setScrolling(false);
              resetScroll();
            }}
            disabled={!hasScript || editingScript}
          >
            Restart script
          </button>
          <button
            style={btn}
            onClick={() => {
              setScrolling(false);
              setEditingScript(true);
            }}
            disabled={recording}
          >
            ✎ Edit script
          </button>

          <label style={sliderLabel}>
            <span>Speed: {speed}</span>
            <input
              type="range"
              min={10}
              max={200}
              step={1}
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
            />
          </label>
          <label style={sliderLabel}>
            <span>Text size: {fontSize}px</span>
            <input
              type="range"
              min={24}
              max={80}
              step={2}
              value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
            />
          </label>
          <label style={sliderLabel}>
            <span>Line spacing: {lineHeight.toFixed(1)}</span>
            <input
              type="range"
              min={1}
              max={2.2}
              step={0.1}
              value={lineHeight}
              onChange={(e) => setLineHeight(Number(e.target.value))}
            />
          </label>
          <label style={sliderLabel}>
            <span>Reading width: {promptWidth}%</span>
            <input
              type="range"
              min={25}
              max={100}
              step={5}
              value={promptWidth}
              onChange={(e) => setPromptWidth(Number(e.target.value))}
            />
          </label>
          <label style={sliderLabel}>
            <span>Visible lines: {linesVisible}</span>
            <input
              type="range"
              min={1}
              max={8}
              step={1}
              value={linesVisible}
              onChange={(e) => setLinesVisible(Number(e.target.value))}
            />
          </label>

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

          <span
            style={{
              marginLeft: "auto",
              color: "#facc15",
              fontSize: "0.8rem",
              fontWeight: 600,
            }}
          >
            Space play/pause · ↑/↓ speed · R record/stop
          </span>
        </div>
      )}

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
