import { useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";

interface Props {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
  brandColor?: string;
  disabled?: boolean;
}

type SR = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { results: { 0: { transcript: string } }[] }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SRCtor = new () => SR;

declare global {
  interface Window {
    SpeechRecognition?: SRCtor;
    webkitSpeechRecognition?: SRCtor;
  }
}

export default function VoiceTextarea({
  value,
  onChange,
  rows = 3,
  placeholder,
  className,
  style,
  brandColor = "#7A1F2B",
  disabled,
}: Props) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<SR | null>(null);
  const baseRef = useRef<string>("");

  useEffect(() => {
    const Ctor =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (Ctor) setSupported(true);
  }, []);

  const stop = () => {
    if (recRef.current) {
      try {
        recRef.current.stop();
      } catch {
        /* noop */
      }
      recRef.current = null;
    }
    setListening(false);
  };

  const start = () => {
    setError(null);
    const Ctor =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) return;
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = "en-US";
    const trimmed = value.trimEnd();
    baseRef.current = trimmed ? trimmed + " " : "";
    r.onresult = (e) => {
      let transcript = "";
      // SpeechRecognitionResultList is array-like
      const results = e.results as unknown as { 0: { transcript: string } }[];
      for (let i = 0; i < results.length; i++) {
        const seg = results[i];
        if (seg && seg[0]) transcript += seg[0].transcript;
      }
      onChange(baseRef.current + transcript);
    };
    r.onerror = (e) => {
      setError(e.error || "Mic error");
      setListening(false);
    };
    r.onend = () => setListening(false);
    try {
      r.start();
      recRef.current = r;
      setListening(true);
    } catch {
      setError("Could not start mic");
    }
  };

  useEffect(
    () => () => {
      stop();
    },
    [],
  );

  return (
    <div className="relative w-full">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        disabled={disabled}
        className={className}
        style={{ ...style, paddingRight: supported ? 36 : undefined }}
      />
      {supported && (
        <button
          type="button"
          onClick={listening ? stop : start}
          disabled={disabled}
          title={listening ? "Stop dictation" : "Dictate (voice to text)"}
          aria-label={listening ? "Stop dictation" : "Start dictation"}
          className="wl-mic-btn absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full border shadow-sm transition-colors disabled:opacity-50"
          style={{
            background: listening ? brandColor : "#FFFFFF",
            color: listening ? "#FFFFFF" : brandColor,
            borderColor: brandColor,
            animation: listening ? "wlMicPulse 1.2s ease-in-out infinite" : "none",
          }}
        >
          {listening ? (
            <MicOff className="h-3.5 w-3.5" />
          ) : (
            <Mic className="h-3.5 w-3.5" />
          )}
        </button>
      )}
      <style>{`@keyframes wlMicPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(122,31,43,0.55); } 50% { box-shadow: 0 0 0 6px rgba(122,31,43,0); } }`}</style>
      {error && (
        <div
          className="mt-1 text-[10px] font-semibold"
          style={{ color: brandColor }}
        >
          Mic: {error}
        </div>
      )}
    </div>
  );
}
