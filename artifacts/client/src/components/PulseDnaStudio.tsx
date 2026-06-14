// PulseDNA Studio (Phase 1) — Core-Team communication workspace.
//
// Two tabs:
//   1. PulseDNA Profile — the school's saved communication voice/policy. Paste
//      it, upload a .txt/.md/.pdf (parsed to text in the browser), edit, and
//      flip an enable/disable toggle. The server stores text only.
//   2. Create — turn a rough idea into a polished, ready-to-copy draft. The AI
//      is grounded in the active PulseDNA profile.
//
// Later phases add the recording studio + teleprompter (Phase 2) and video
// output/library/retention (Phase 3). Gated to Core Team under the familyComm
// license (same as Family Messages).
//
// Talks to /api/pulse-dna via authFetch (repo convention — no codegen).
import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import mammoth from "mammoth";
import { authFetch } from "../lib/authToken";
import RecordingStudio from "../studio/RecordingStudio";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface ProfileState {
  content: string;
  sourceName: string | null;
  enabled: boolean;
  updatedAt: string | null;
}

// A PulseDNA video as returned by the server (videoToClient shape).
export interface VideoItem {
  id: number;
  status: string; // processing | ready | failed | purged
  title: string | null;
  script: string;
  durationSec: number | null;
  sizeBytes: number | null;
  errorReason: string | null;
  sent: boolean;
  sentAt: string | null;
  retentionPostponed: boolean;
  purgeAfter: string | null;
  hasMp4: boolean;
  hasAudio: boolean;
  createdAt: string;
}

function formatDuration(sec: number | null): string {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const OUTPUT_TYPES = [
  "Family announcement",
  "Email to families",
  "Text message (SMS)",
  "Social media post",
  "Newsletter blurb",
  "Phone call script",
  "Video / teleprompter script",
] as const;

const AUDIENCES = [
  "All families",
  "Families of a grade level",
  "Staff",
  "Students",
  "Wider community",
] as const;

const TONES = [
  "Warm",
  "Professional",
  "Celebratory",
  "Reassuring",
  "Urgent",
  "Encouraging",
] as const;

const LANGUAGES = [
  "English",
  "Spanish",
  "Haitian Creole",
  "Portuguese",
  "French",
  "Vietnamese",
  "Arabic",
] as const;

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Extract plain text from an uploaded file in the browser. Supports .txt/.md
// directly, .pdf via pdfjs, and .docx via mammoth. The server only ever stores
// the resulting text.
async function extractTextFromFile(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (
    name.endsWith(".txt") ||
    name.endsWith(".md") ||
    file.type.startsWith("text/")
  ) {
    return file.text();
  }
  if (name.endsWith(".pdf") || file.type === "application/pdf") {
    const buf = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const parts: string[] = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const line = content.items
        .map((it) => ("str" in it ? (it as { str: string }).str : ""))
        .join(" ");
      parts.push(line);
    }
    return parts.join("\n\n").replace(/[ \t]+\n/g, "\n").trim();
  }
  if (name.endsWith(".docx") || file.type === DOCX_MIME) {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value.trim();
  }
  throw new Error(
    "Unsupported file. Upload a .txt, .md, .pdf, or .docx — or paste the text directly.",
  );
}

export default function PulseDnaStudio() {
  const [tab, setTab] = useState<"profile" | "create" | "library">("profile");
  const [showHelp, setShowHelp] = useState(false);

  return (
    <div>
      <div className="section-header-bar-teal" style={{ width: "100%", margin: 0 }} />
      <div className="section-header-band-hub" style={{ width: "100%", margin: 0 }} />

      <section className="card" style={{ overflow: "visible" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: "1rem",
          }}
        >
          <h2 style={{ marginTop: 0 }}>PulseDNA Studio</h2>
          <button className="btn" onClick={() => setShowHelp(true)}>
            ? Help
          </button>
        </div>
        <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
          Save your school's communication voice once, then turn rough ideas
          into polished, ready-to-send messages that sound like you.
        </p>
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
          <button
            className={tab === "profile" ? "btn primary" : "btn"}
            onClick={() => setTab("profile")}
          >
            PulseDNA Profile
          </button>
          <button
            className={tab === "create" ? "btn primary" : "btn"}
            onClick={() => setTab("create")}
          >
            Create a message
          </button>
          <button
            className={tab === "library" ? "btn primary" : "btn"}
            onClick={() => setTab("library")}
          >
            Video library
          </button>
        </div>
      </section>

      {tab === "profile" ? (
        <ProfileTab />
      ) : tab === "create" ? (
        <CreateTab />
      ) : (
        <VideoLibraryTab />
      )}

      {showHelp && <StudioHelpModal onClose={() => setShowHelp(false)} />}
    </div>
  );
}

// Page-level directions for the whole PulseDNA Studio (both tabs). The app's
// global "?" help bubble is grounded in the help knowledge base, but a direct
// in-page panel is faster for first-time users right where they are.
function StudioHelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-label="PulseDNA Studio help"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1.5rem",
        zIndex: 1000,
      }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(680px, 100%)",
          maxHeight: "86vh",
          overflowY: "auto",
          margin: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "1rem",
          }}
        >
          <h2 style={{ margin: 0 }}>How PulseDNA Studio works</h2>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>

        <h3>1. Save your school's voice (PulseDNA Profile)</h3>
        <ul style={helpUl}>
          <li>Open the <strong>PulseDNA Profile</strong> tab.</li>
          <li><strong>Upload</strong> a .txt, .md, .pdf, or .docx — or paste your text — describing your tone, values, and sign-off.</li>
          <li>Click <strong>Save profile</strong>. Toggle <strong>Use this profile when drafting</strong> on or off anytime.</li>
        </ul>

        <h3>2. Create a message</h3>
        <ul style={helpUl}>
          <li>On the <strong>Create a message</strong> tab, type what it's about — or click <strong>Dictate</strong> to speak it.</li>
          <li>Pick the <strong>output type</strong>, <strong>audience</strong>, <strong>tone</strong>, and <strong>language</strong>.</li>
          <li>Click <strong>Generate draft</strong>, then edit the result and copy it wherever you need it.</li>
        </ul>

        <h3>3. Record a video</h3>
        <ul style={helpUl}>
          <li>Click <strong>Record a video</strong> to open the studio with a teleprompter loaded from your draft.</li>
          <li>Allow the browser to use your <strong>camera</strong> and <strong>microphone</strong> the first time.</li>
          <li>Hit <strong>● Record</strong> to start, <strong>◼ Stop</strong> when done, then <strong>Use this take</strong> or <strong>Record again</strong>.</li>
          <li>Use <strong>Play script</strong> to scroll the teleprompter, and the sliders to set speed, text size, reading width, and visible lines.</li>
          <li>Inside the studio, click <strong>? Help</strong> (top right) for the full teleprompter guide.</li>
        </ul>

        <h3>Keyboard &amp; clicker shortcuts (in the studio)</h3>
        <ul style={helpUl}>
          <li><strong>Space</strong> — play / pause the scrolling script.</li>
          <li><strong>↑ / ↓</strong> (or Page Up / Page Down) — speed the script up / slow it down.</li>
          <li><strong>R</strong> — start / stop recording.</li>
          <li>A Bluetooth presentation clicker sends these same keys, so you can drive the studio from across the room.</li>
        </ul>

        <p style={{ color: "var(--text-subtle)", marginBottom: 0 }}>
          Tip: dictation and the camera need permission, which the Replit
          preview can block — if so, open the app in its own browser tab.
        </p>
      </div>
    </div>
  );
}

const helpUl: React.CSSProperties = {
  margin: "0.4rem 0 0.5rem",
  paddingLeft: "1.2rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.3rem",
  color: "var(--text)",
};

function ProfileTab() {
  const [profile, setProfile] = useState<ProfileState | null>(null);
  const [content, setContent] = useState("");
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const dirty =
    profile !== null &&
    (content !== profile.content ||
      enabled !== profile.enabled ||
      sourceName !== profile.sourceName);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch("/api/pulse-dna");
        if (!res.ok) throw new Error("Failed to load profile");
        const data = (await res.json()) as ProfileState;
        if (cancelled) return;
        setProfile(data);
        setContent(data.content);
        setSourceName(data.sourceName);
        setEnabled(data.enabled);
      } catch {
        if (!cancelled) setError("Could not load the PulseDNA profile.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleFile(file: File) {
    setError(null);
    setStatus(null);
    try {
      const text = await extractTextFromFile(file);
      if (!text.trim()) {
        setError("That file didn't contain any readable text.");
        return;
      }
      setContent(text);
      setSourceName(file.name);
      setStatus(`Loaded text from ${file.name}. Review it, then Save.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that file.");
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const res = await authFetch("/api/pulse-dna", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, sourceName, enabled }),
      });
      if (!res.ok) throw new Error("save failed");
      const data = (await res.json()) as ProfileState;
      setProfile(data);
      setContent(data.content);
      setSourceName(data.sourceName);
      setEnabled(data.enabled);
      setStatus("Saved.");
    } catch {
      setError("Could not save the profile. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <section className="card">
        <p style={{ color: "var(--text-subtle)" }}>Loading…</p>
      </section>
    );
  }

  return (
    <section className="card" style={{ overflow: "visible" }}>
      <h3 style={{ marginTop: 0 }}>Your school's communication profile</h3>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        Paste or upload the voice, values, and do/don't rules you want every
        message to follow. The AI uses this as background context when you
        create a message. You can edit or replace it anytime.
      </p>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          margin: "0.75rem 0",
          color: "var(--text)",
        }}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Use this profile when drafting messages
      </label>

      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={16}
        placeholder="e.g. We are Lincoln Middle School. Our voice is warm, direct, and hopeful. We always lead with care for students, avoid jargon, and sign off as 'The Lincoln Team.' We never share student names publicly…"
        style={{
          width: "100%",
          boxSizing: "border-box",
          fontFamily: "inherit",
          fontSize: "0.95rem",
          padding: "0.75rem",
          borderRadius: "8px",
          border: "1px solid var(--border)",
          resize: "vertical",
        }}
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          flexWrap: "wrap",
          marginTop: "0.5rem",
        }}
      >
        <span style={{ color: "var(--text-subtle)", fontSize: "0.85rem" }}>
          {content.length.toLocaleString()} characters
          {sourceName ? ` · from ${sourceName}` : ""}
          {profile?.updatedAt
            ? ` · last saved ${new Date(profile.updatedAt).toLocaleString()}`
            : ""}
        </span>
      </div>

      <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem", flexWrap: "wrap" }}>
        <button className="btn" onClick={() => fileRef.current?.click()}>
          Upload a file (.txt, .md, .pdf, .docx)
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={`.txt,.md,.pdf,.docx,text/plain,application/pdf,${DOCX_MIME}`}
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.target.value = "";
          }}
        />
        <button className="btn primary" onClick={() => void save()} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save profile"}
        </button>
      </div>

      {status && (
        <p style={{ color: "var(--success, #15803d)", marginTop: "0.75rem" }}>{status}</p>
      )}
      {error && (
        <p style={{ color: "var(--danger, #b91c1c)", marginTop: "0.75rem" }}>{error}</p>
      )}
    </section>
  );
}

// --- Voice-to-text (browser Web Speech API) -------------------------------
// Lets staff dictate the rough idea instead of typing. Uses the built-in
// SpeechRecognition API (Chrome/Edge/Safari) — no dependency, no API key. The
// mic is blocked inside the Replit preview iframe, so dictation works in the
// published app or when the app is opened in its own browser tab.
interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number } & Record<number, SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// Best-effort map from the chosen output language to a dictation locale. The
// speaker may use any language; this is just a sensible default.
const SPEECH_LOCALES: Record<string, string> = {
  English: "en-US",
  Spanish: "es-ES",
  "Haitian Creole": "ht-HT",
  Portuguese: "pt-BR",
  French: "fr-FR",
  Vietnamese: "vi-VN",
  Arabic: "ar-SA",
};

function CreateTab() {
  const [roughInput, setRoughInput] = useState("");
  const [outputType, setOutputType] = useState<string>(OUTPUT_TYPES[0]);
  const [audience, setAudience] = useState<string>(AUDIENCES[0]);
  const [tone, setTone] = useState<string>(TONES[0]);
  const [language, setLanguage] = useState<string>(LANGUAGES[0]);
  const [generating, setGenerating] = useState(false);
  const [output, setOutput] = useState("");
  const [usedPulseDna, setUsedPulseDna] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [listening, setListening] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const dictationBaseRef = useRef("");
  const finalTranscriptRef = useRef("");
  const speechSupported = getSpeechRecognitionCtor() !== null;
  const [studioOpen, setStudioOpen] = useState(false);
  const [studioScript, setStudioScript] = useState("");
  const [uploadState, setUploadState] = useState<
    "idle" | "uploading" | "processing" | "ready" | "error"
  >("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedVideo, setUploadedVideo] = useState<VideoItem | null>(null);
  // Media elements don't carry the Bearer token, so a plain <video src="/api/…">
  // 401s inside the Replit preview iframe. Fetch the MP4 bytes with authFetch
  // and play them from an object URL instead.
  const [readyVideoUrl, setReadyVideoUrl] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current != null) window.clearTimeout(pollRef.current);
    };
  }, []);

  useEffect(() => {
    if (uploadState !== "ready" || !uploadedVideo || !uploadedVideo.hasMp4) {
      return;
    }
    let revoked = false;
    let url: string | null = null;
    (async () => {
      try {
        const res = await authFetch(
          `/api/pulse-dna/videos/${uploadedVideo.id}/file?kind=mp4`,
        );
        if (!res.ok) return;
        const blob = await res.blob();
        if (revoked) return;
        url = URL.createObjectURL(blob);
        setReadyVideoUrl(url);
      } catch {
        /* swallow — the library tab is the reliable surface */
      }
    })();
    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
      setReadyVideoUrl(null);
    };
  }, [uploadState, uploadedVideo]);

  // Upload a kept take, register it, then poll until the server finishes
  // transcoding it to MP4 + audio.
  async function uploadTake(video: {
    blob: Blob;
    mimeType: string;
    durationSec: number;
  }) {
    setStudioOpen(false);
    // Cancel any in-flight poll from a previous take so we don't run two loops.
    if (pollRef.current != null) {
      window.clearTimeout(pollRef.current);
      pollRef.current = null;
    }
    setUploadState("uploading");
    setUploadError(null);
    setUploadedVideo(null);
    try {
      const urlRes = await authFetch("/api/pulse-dna/videos/upload-url", {
        method: "POST",
      });
      if (!urlRes.ok) throw new Error("upload-url failed");
      const { uploadURL, objectPath } = (await urlRes.json()) as {
        uploadURL: string;
        objectPath: string;
      };
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "content-type": video.mimeType || "video/webm" },
        body: video.blob,
      });
      if (!putRes.ok) throw new Error("upload failed");

      const regRes = await authFetch("/api/pulse-dna/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          objectPath,
          mimeType: video.mimeType || "video/webm",
          durationSec: Math.max(1, Math.round(video.durationSec)),
          sizeBytes: video.blob.size,
          script: studioScript,
        }),
      });
      if (!regRes.ok) throw new Error("register failed");
      const { id } = (await regRes.json()) as { id: number; status: string };

      setUploadState("processing");
      poll(id);
    } catch {
      setUploadState("error");
      setUploadError(
        "Couldn't save the recording. Please check your connection and try again.",
      );
    }
  }

  function poll(id: number) {
    const tick = async () => {
      try {
        const res = await authFetch(`/api/pulse-dna/videos/${id}`);
        if (!res.ok) throw new Error("poll failed");
        const v = (await res.json()) as VideoItem;
        if (v.status === "ready") {
          setUploadedVideo(v);
          setUploadState("ready");
          return;
        }
        if (v.status === "failed" || v.status === "purged") {
          setUploadState("error");
          setUploadError(
            v.errorReason ||
              "Processing failed. Please try recording again.",
          );
          return;
        }
        pollRef.current = window.setTimeout(tick, 2500);
      } catch {
        setUploadState("error");
        setUploadError("Lost contact while processing. Please try again.");
      }
    };
    pollRef.current = window.setTimeout(tick, 2000);
  }

  async function generate() {
    if (!roughInput.trim()) {
      setError("Tell the assistant what the message is about first.");
      return;
    }
    setGenerating(true);
    setError(null);
    setCopied(false);
    try {
      const res = await authFetch("/api/pulse-dna/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roughInput, outputType, audience, tone, language }),
      });
      if (res.status === 429) {
        setError("You're generating quickly — give it a moment and try again.");
        return;
      }
      if (!res.ok) throw new Error("draft failed");
      const data = (await res.json()) as { output: string; usedPulseDna: boolean };
      setOutput(data.output);
      setUsedPulseDna(data.usedPulseDna);
    } catch {
      setError("Could not generate a draft. Please try again.");
    } finally {
      setGenerating(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy — select the text and copy manually.");
    }
  }

  function startDictation() {
    if (recognitionRef.current) return;
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setSpeechError("Voice typing isn't supported in this browser.");
      return;
    }
    setSpeechError(null);
    const rec = new Ctor();
    rec.lang = SPEECH_LOCALES[language] ?? "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    // Anchor on the text already in the box; dictation appends after it.
    const base = roughInput.trim();
    dictationBaseRef.current = base ? base + " " : "";
    finalTranscriptRef.current = "";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0].transcript;
        if (r.isFinal) finalTranscriptRef.current += text;
        else interim += text;
      }
      setRoughInput(
        dictationBaseRef.current + finalTranscriptRef.current + interim,
      );
    };
    rec.onerror = (e) => {
      setSpeechError(
        e.error === "not-allowed" || e.error === "service-not-allowed"
          ? "Microphone access was blocked. Dictation can't run inside the Replit preview — open the app in its own tab and allow the mic."
          : e.error === "no-speech"
            ? "Didn't catch any speech — try again."
            : "Voice typing stopped unexpectedly. Please try again.",
      );
    };
    rec.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      setSpeechError("Couldn't start voice typing. Please try again.");
      setListening(false);
    }
  }

  function toggleDictation() {
    if (listening) recognitionRef.current?.stop();
    else startDictation();
  }

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
    };
  }, []);

  const selectStyle: React.CSSProperties = {
    padding: "0.5rem",
    borderRadius: "8px",
    border: "1px solid var(--border)",
    fontFamily: "inherit",
    fontSize: "0.95rem",
    background: "var(--surface, #fff)",
    color: "var(--text)",
  };

  return (
    <section className="card" style={{ overflow: "visible" }}>
      <h3 style={{ marginTop: 0 }}>Create a message</h3>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        Jot down the rough idea — the assistant turns it into a polished draft
        in your school's voice. Edit it, then copy it wherever you need it.
      </p>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem",
          marginBottom: "0.25rem",
        }}
      >
        <label style={{ fontWeight: 600, color: "var(--text)" }}>
          What's the message about?
        </label>
        {speechSupported && (
          <button
            type="button"
            className={listening ? "btn primary" : "btn"}
            onClick={toggleDictation}
            aria-pressed={listening}
            title="Dictate with your microphone"
            style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
          >
            <span
              aria-hidden
              style={{
                width: "0.5rem",
                height: "0.5rem",
                borderRadius: "50%",
                background: listening ? "#dc2626" : "currentColor",
                opacity: listening ? 1 : 0.6,
              }}
            />
            {listening ? "Stop dictation" : "Dictate"}
          </button>
        )}
      </div>
      <textarea
        value={roughInput}
        onChange={(e) => setRoughInput(e.target.value)}
        rows={5}
        placeholder="e.g. Picture day is next Tuesday. Students should wear their house colors. Order forms went home Friday and are due back by Monday."
        style={{
          width: "100%",
          boxSizing: "border-box",
          fontFamily: "inherit",
          fontSize: "0.95rem",
          padding: "0.75rem",
          borderRadius: "8px",
          border: "1px solid var(--border)",
          resize: "vertical",
        }}
      />
      {listening && (
        <p style={{ color: "var(--accent, #0d9488)", fontSize: "0.85rem", marginTop: "0.35rem" }}>
          Listening… speak now, then click "Stop dictation" when you're done.
        </p>
      )}
      {speechError && (
        <p style={{ color: "var(--danger, #b91c1c)", fontSize: "0.85rem", marginTop: "0.35rem" }}>
          {speechError}
        </p>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "0.75rem",
          margin: "1rem 0",
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", color: "var(--text)" }}>
          <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>Output type</span>
          <select value={outputType} onChange={(e) => setOutputType(e.target.value)} style={selectStyle}>
            {OUTPUT_TYPES.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", color: "var(--text)" }}>
          <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>Audience</span>
          <select value={audience} onChange={(e) => setAudience(e.target.value)} style={selectStyle}>
            {AUDIENCES.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", color: "var(--text)" }}>
          <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>Tone</span>
          <select value={tone} onChange={(e) => setTone(e.target.value)} style={selectStyle}>
            {TONES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", color: "var(--text)" }}>
          <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>Language</span>
          <select value={language} onChange={(e) => setLanguage(e.target.value)} style={selectStyle}>
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button className="btn primary" onClick={() => void generate()} disabled={generating}>
          {generating ? "Generating…" : output ? "Regenerate" : "Generate draft"}
        </button>
        <button
          className="btn"
          type="button"
          onClick={() => {
            setStudioScript(output || roughInput);
            setStudioOpen(true);
          }}
          title="Open the video recording studio with a teleprompter"
        >
          Record a video
        </button>
      </div>

      {error && (
        <p style={{ color: "var(--danger, #b91c1c)", marginTop: "0.75rem" }}>{error}</p>
      )}

      {output && (
        <div style={{ marginTop: "1.25rem" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "0.5rem",
            }}
          >
            <h4 style={{ margin: 0 }}>Draft</h4>
            <span style={{ color: "var(--text-subtle)", fontSize: "0.8rem" }}>
              {usedPulseDna
                ? "Grounded in your PulseDNA profile"
                : "PulseDNA profile not used (empty or disabled)"}
            </span>
          </div>
          <textarea
            value={output}
            onChange={(e) => setOutput(e.target.value)}
            rows={14}
            style={{
              width: "100%",
              boxSizing: "border-box",
              fontFamily: "inherit",
              fontSize: "0.95rem",
              padding: "0.75rem",
              borderRadius: "8px",
              border: "1px solid var(--border)",
              resize: "vertical",
              marginTop: "0.5rem",
            }}
          />
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
            <button className="btn" onClick={() => void copy()}>
              {copied ? "Copied!" : "Copy to clipboard"}
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setStudioScript(output);
                setStudioOpen(true);
              }}
              title="Read this draft on camera with a teleprompter"
            >
              Record a video with this script
            </button>
          </div>
        </div>
      )}

      {uploadState !== "idle" && (
        <div
          className="card"
          style={{
            marginTop: "1rem",
            background: "var(--surface-subtle, #f8fafc)",
          }}
        >
          {uploadState === "uploading" && (
            <p style={{ margin: 0, color: "var(--text)" }}>
              Uploading your recording…
            </p>
          )}
          {uploadState === "processing" && (
            <p style={{ margin: 0, color: "var(--text)" }}>
              Processing your video — this can take a minute. You can keep
              working; check the <strong>Video library</strong> tab anytime.
            </p>
          )}
          {uploadState === "error" && (
            <p style={{ margin: 0, color: "var(--danger, #b91c1c)" }}>
              {uploadError}
            </p>
          )}
          {uploadState === "ready" && uploadedVideo && (
            <div>
              <p style={{ marginTop: 0, color: "var(--text)", fontWeight: 600 }}>
                Your video is ready ({formatDuration(uploadedVideo.durationSec)}).
              </p>
              {readyVideoUrl ? (
                <video
                  src={readyVideoUrl}
                  controls
                  style={{
                    width: "100%",
                    maxWidth: "480px",
                    borderRadius: "8px",
                    background: "#000",
                  }}
                />
              ) : (
                <p style={{ margin: 0, color: "var(--text-subtle)" }}>
                  Loading preview…
                </p>
              )}
              <p
                style={{
                  color: "var(--text-subtle)",
                  fontSize: "0.85rem",
                  marginBottom: 0,
                }}
              >
                Find it under the <strong>Video library</strong> tab to download
                it or attach it to a family message. Unsent videos are kept for
                14 days.
              </p>
            </div>
          )}
        </div>
      )}

      {studioOpen && (
        <RecordingStudio
          initialScript={studioScript}
          onClose={() => setStudioOpen(false)}
          onKeepTake={(video) => void uploadTake(video)}
        />
      )}
    </section>
  );
}

// Video library — the school's recorded videos (newest first). Plays + downloads
// stream the authed bytes through authFetch → object URL (a plain media src 401s
// inside the Replit preview iframe), and offers postpone (unsent only) + delete.
function VideoLibraryTab() {
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  // Per-video inline player object URL + open state.
  const [players, setPlayers] = useState<
    Record<number, { url: string; open: boolean }>
  >({});
  const [loadingPlayer, setLoadingPlayer] = useState<number | null>(null);
  const urlsRef = useRef<string[]>([]);

  async function load() {
    try {
      const res = await authFetch("/api/pulse-dna/videos");
      if (!res.ok) {
        setError(`Could not load videos (${res.status})`);
        return;
      }
      const body = (await res.json()) as { videos?: VideoItem[] };
      setVideos(Array.isArray(body.videos) ? body.videos : []);
      setError(null);
    } catch {
      setError("Could not load videos");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    return () => {
      for (const u of urlsRef.current) URL.revokeObjectURL(u);
      urlsRef.current = [];
    };
  }, []);

  async function togglePlayer(v: VideoItem) {
    const existing = players[v.id];
    if (existing) {
      setPlayers((s) => ({ ...s, [v.id]: { ...existing, open: !existing.open } }));
      return;
    }
    if (loadingPlayer != null) return;
    setLoadingPlayer(v.id);
    try {
      const res = await authFetch(`/api/pulse-dna/videos/${v.id}/file?kind=mp4`);
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      urlsRef.current.push(url);
      setPlayers((s) => ({ ...s, [v.id]: { url, open: true } }));
    } catch {
      /* swallow */
    } finally {
      setLoadingPlayer(null);
    }
  }

  async function download(v: VideoItem, kind: "mp4" | "audio") {
    if (busyId != null) return;
    setBusyId(v.id);
    try {
      const res = await authFetch(
        `/api/pulse-dna/videos/${v.id}/file?kind=${kind}`,
      );
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        kind === "mp4" ? `pulsedna-video-${v.id}.mp4` : `pulsedna-audio-${v.id}.mp3`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      /* swallow */
    } finally {
      setBusyId(null);
    }
  }

  async function postpone(v: VideoItem) {
    if (busyId != null) return;
    setBusyId(v.id);
    try {
      const res = await authFetch(`/api/pulse-dna/videos/${v.id}/postpone`, {
        method: "POST",
      });
      if (res.ok) await load();
    } catch {
      /* swallow */
    } finally {
      setBusyId(null);
    }
  }

  async function remove(v: VideoItem) {
    if (busyId != null) return;
    if (
      !window.confirm(
        "Delete this video file? The written message and transcript are kept; only the video is removed.",
      )
    ) {
      return;
    }
    setBusyId(v.id);
    try {
      const res = await authFetch(`/api/pulse-dna/videos/${v.id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        // Drop any open player for this video and revoke its object URL.
        setPlayers((s) => {
          const existing = s[v.id];
          if (existing) URL.revokeObjectURL(existing.url);
          const next = { ...s };
          delete next[v.id];
          return next;
        });
        await load();
      }
    } catch {
      /* swallow */
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return (
      <section className="card" style={{ padding: 16 }}>
        <p style={{ margin: 0, color: "var(--text-subtle)" }}>Loading videos…</p>
      </section>
    );
  }

  return (
    <section className="card" style={{ padding: 16, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Video library</h3>
        <button type="button" className="btn" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {error && (
        <p style={{ margin: 0, color: "var(--danger, #b91c1c)" }}>{error}</p>
      )}
      {videos.length === 0 && !error && (
        <p style={{ margin: 0, color: "var(--text-subtle)" }}>
          No videos yet. Record one from the <strong>Create</strong> tab. Unsent
          videos are kept for 14 days; videos attached to a family message are
          kept for the school year.
        </p>
      )}
      {videos.map((v) => (
        <div
          key={v.id}
          style={{
            border: "1px solid var(--border, #e2e8f0)",
            borderRadius: 10,
            padding: 12,
            display: "grid",
            gap: 8,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "grid", gap: 2 }}>
              <strong style={{ color: "var(--text)" }}>
                {v.title || "Untitled video"}
              </strong>
              <span style={{ fontSize: "0.8rem", color: "var(--text-subtle)" }}>
                {formatDuration(v.durationSec)} · {formatBytes(v.sizeBytes)} ·{" "}
                {new Date(v.createdAt).toLocaleDateString()}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {v.sent ? (
                <span
                  style={{
                    fontSize: "0.75rem",
                    fontWeight: 600,
                    color: "#047857",
                  }}
                >
                  Sent · kept for the school year
                </span>
              ) : v.purgeAfter ? (
                <span
                  style={{ fontSize: "0.75rem", color: "var(--text-subtle)" }}
                >
                  Purges {new Date(v.purgeAfter).toLocaleDateString()}
                  {v.retentionPostponed ? " (postponed)" : ""}
                </span>
              ) : null}
            </div>
          </div>

          {v.status === "processing" && (
            <span style={{ fontSize: "0.85rem", color: "var(--text-subtle)" }}>
              Still processing…
            </span>
          )}
          {v.status === "failed" && (
            <span style={{ fontSize: "0.85rem", color: "var(--danger, #b91c1c)" }}>
              {v.errorReason || "Processing failed."}
            </span>
          )}

          {v.status === "ready" && (
            <>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {v.hasMp4 && (
                  <button
                    type="button"
                    className="btn"
                    disabled={loadingPlayer === v.id}
                    onClick={() => void togglePlayer(v)}
                  >
                    {loadingPlayer === v.id
                      ? "Opening…"
                      : players[v.id]?.open
                        ? "Hide"
                        : "Watch"}
                  </button>
                )}
                {v.hasMp4 && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busyId === v.id}
                    onClick={() => void download(v, "mp4")}
                  >
                    Download MP4
                  </button>
                )}
                {v.hasAudio && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busyId === v.id}
                    onClick={() => void download(v, "audio")}
                  >
                    Download audio
                  </button>
                )}
                {!v.sent && !v.retentionPostponed && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busyId === v.id}
                    onClick={() => void postpone(v)}
                  >
                    Keep 7 more days
                  </button>
                )}
                <button
                  type="button"
                  className="btn danger"
                  disabled={busyId === v.id}
                  onClick={() => void remove(v)}
                >
                  Delete
                </button>
              </div>
              {players[v.id]?.open && (
                <video
                  src={players[v.id].url}
                  controls
                  style={{
                    width: "100%",
                    maxWidth: 480,
                    borderRadius: 8,
                    background: "#000",
                  }}
                />
              )}
            </>
          )}
        </div>
      ))}
    </section>
  );
}
