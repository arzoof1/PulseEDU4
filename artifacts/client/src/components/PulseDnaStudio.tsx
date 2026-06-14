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
  const [tab, setTab] = useState<"profile" | "create">("profile");

  return (
    <div>
      <div className="section-header-bar-teal" style={{ width: "100%", margin: 0 }} />
      <div className="section-header-band-hub" style={{ width: "100%", margin: 0 }} />

      <section className="card" style={{ overflow: "visible" }}>
        <h2 style={{ marginTop: 0 }}>PulseDNA Studio</h2>
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
        </div>
      </section>

      {tab === "profile" ? <ProfileTab /> : <CreateTab />}
    </div>
  );
}

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
  const [videoReady, setVideoReady] = useState(false);

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

      {videoReady && (
        <p style={{ color: "var(--text-subtle)", marginTop: "0.75rem", fontSize: "0.85rem" }}>
          Video recorded and ready — sending it to families arrives in the next update.
        </p>
      )}

      {studioOpen && (
        <RecordingStudio
          initialScript={studioScript}
          onClose={() => setStudioOpen(false)}
          onKeepTake={() => setVideoReady(true)}
        />
      )}
    </section>
  );
}
