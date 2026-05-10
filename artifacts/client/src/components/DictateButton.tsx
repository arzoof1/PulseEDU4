import { useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";

// Minimal local types for the Web Speech API. lib.dom.d.ts in our TS
// version doesn't ship them, and we only touch a tiny surface area, so
// declaring just what we use is cheaper than pulling in
// @types/dom-speech-recognition.
type SpeechRecognitionAlternativeLike = { transcript: string };
type SpeechRecognitionResultLike = {
  isFinal: boolean;
  0?: SpeechRecognitionAlternativeLike;
  [index: number]: SpeechRecognitionAlternativeLike | undefined;
};
type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResultLike };
};
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  // Some implementations (Chrome) expose abort() which releases the
  // mic immediately and suppresses any further callbacks; prefer it
  // over stop() at unmount so a late onresult can't fire after the
  // host component has unmounted.
  abort?: () => void;
};

interface Props {
  // Called with finalized recognized text, separated from the previous
  // value with a sensible space so dictated phrases flow into existing
  // typed text without colliding.
  onAppend: (chunk: string) => void;
  // Optional visual size — "sm" (default) is the compact pill used in
  // tag/edit forms; "md" is the slightly larger one used in the footage
  // quick-add modal.
  size?: "sm" | "md";
  // Optional CSS for the inner button container (border, color, etc.)
  // so the host can match its surrounding palette.
  borderColor?: string;
  inkSoft?: string;
  panelBg?: string;
  alertColor?: string;
}

// Reusable Web Speech API toggle button. Hides itself when the browser
// doesn't support speech recognition (e.g. Firefox) — we'd rather not
// show a button that does nothing. Caller controls where the recognized
// text lands via `onAppend`. Cleans up the recognition session on
// unmount so a closed modal doesn't leave the mic icon active.
export default function DictateButton({
  onAppend,
  size = "sm",
  borderColor = "#E5E7EB",
  inkSoft = "#6B7280",
  panelBg = "#FFFFFF",
  alertColor = "#9F1D1D",
}: Props) {
  const [dictating, setDictating] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // Track the latest onAppend in a ref so the long-lived
  // SpeechRecognition.onresult handler always calls the current closure
  // — without this an inline arrow on the parent (e.g. one that closes
  // over fresh state) would be stale by the time speech results arrive.
  const onAppendRef = useRef(onAppend);
  useEffect(() => {
    onAppendRef.current = onAppend;
  }, [onAppend]);

  const speechCtor =
    typeof window === "undefined"
      ? null
      : (window as unknown as {
          SpeechRecognition?: new () => SpeechRecognitionLike;
          webkitSpeechRecognition?: new () => SpeechRecognitionLike;
        }).SpeechRecognition ??
        (window as unknown as {
          webkitSpeechRecognition?: new () => SpeechRecognitionLike;
        }).webkitSpeechRecognition ??
        null;

  useEffect(() => {
    return () => {
      const r = recognitionRef.current;
      if (!r) return;
      // Detach callbacks first so any in-flight result that fires
      // between abort() and GC can't reach into the unmounted host.
      r.onresult = null;
      r.onerror = null;
      r.onend = null;
      try {
        // Prefer abort() — releases the mic immediately and suppresses
        // pending results. Fall back to stop() on engines without it.
        if (typeof r.abort === "function") r.abort();
        else r.stop();
      } catch {
        // ignore — recognition may already be stopped
      }
      recognitionRef.current = null;
    };
  }, []);

  function toggle() {
    if (!speechCtor) return;
    if (dictating) {
      const r = recognitionRef.current;
      try {
        r?.stop();
      } catch {
        // ignore
      }
      setDictating(false);
      return;
    }
    try {
      const rec = new speechCtor();
      rec.lang =
        (typeof navigator !== "undefined" && navigator.language) || "en-US";
      rec.continuous = true;
      rec.interimResults = false;
      rec.onresult = (event: SpeechRecognitionEventLike) => {
        let chunk = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result?.isFinal && result[0]) {
            chunk += result[0].transcript;
          }
        }
        chunk = chunk.trim();
        if (chunk) onAppendRef.current(chunk);
      };
      rec.onerror = () => {
        setDictating(false);
        recognitionRef.current = null;
      };
      rec.onend = () => {
        setDictating(false);
        recognitionRef.current = null;
      };
      rec.start();
      recognitionRef.current = rec;
      setDictating(true);
    } catch {
      setDictating(false);
    }
  }

  if (!speechCtor) return null;

  const padding = size === "md" ? "px-2 py-0.5" : "px-1.5 py-0.5";
  const fontSize = size === "md" ? "text-[11px]" : "text-[10px]";
  const iconClass = size === "md" ? "h-3 w-3" : "h-2.5 w-2.5";

  return (
    <button
      type="button"
      onClick={toggle}
      className={`inline-flex items-center gap-1 rounded-md border ${padding} ${fontSize} font-semibold`}
      style={{
        borderColor: dictating ? alertColor : borderColor,
        color: dictating ? alertColor : inkSoft,
        background: dictating ? "#FEF2F2" : panelBg,
      }}
      aria-pressed={dictating}
      aria-label={dictating ? "Stop dictation" : "Start dictation"}
      title={
        dictating
          ? "Stop dictation"
          : "Dictate (uses your browser's speech recognition)"
      }
    >
      {dictating ? (
        <>
          <MicOff className={iconClass} />
          <span>Listening…</span>
        </>
      ) : (
        <>
          <Mic className={iconClass} />
          <span>Dictate</span>
        </>
      )}
    </button>
  );
}

// Helper for callers: smart space-aware append so dictated phrases
// don't collide with existing typed text. Exported so non-textarea
// callers can reuse the same join semantics.
export function appendDictated(prev: string, chunk: string): string {
  if (!prev) return chunk;
  const sep = /[.!?\s]$/.test(prev) ? "" : " ";
  return prev + sep + chunk;
}
