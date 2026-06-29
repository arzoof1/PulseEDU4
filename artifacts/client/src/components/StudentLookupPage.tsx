// Student Lookup — a search-first "one-stop-shop" snapshot. Staff type a
// name (or local SIS id), pick a student, and get the whole-child Student
// Profile rendered READ-ONLY, plus the one editable field: a parent-facing
// "Message for this week's HeartBEAT" that surfaces on the Friday family
// communication (PDF + email).
//
// Visibility is enforced server-side on every endpoint:
//   - GET  /api/student-lookup/search        (own roster vs school-wide)
//   - GET  /api/students/:id                 (current note + identity)
//   - PUT  /api/student-lookup/:id/heartbeat-note
//   - GET  /api/insights/students/:id/profile (the embedded StudentProfile)
//
// NO FLEID forward-facing: search results and the snapshot only ever render
// localSisId; the canonical studentId is used solely as the lookup key.

import { useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";
import StudentProfile from "./StudentProfile";
import StudentPicker from "./StudentPicker";

interface SearchHit {
  studentId: string;
  localSisId: string | null;
  firstName: string;
  lastName: string;
  grade: number;
}

interface Props {
  onBack: () => void;
  // Gated to pickup/dismissal managers — when true the StudentProfile's
  // car-rider/dismissal status becomes editable; otherwise read-only.
  canManageDismissal?: boolean;
}

const MAX_NOTE_LEN = 1000;

function gradeLabel(grade: number): string {
  if (grade === 0) return "K";
  return `Grade ${grade}`;
}

export default function StudentLookupPage({
  onBack,
  canManageDismissal = false,
}: Props) {
  const [selected, setSelected] = useState<SearchHit | null>(null);

  // Shared async search — same endpoint + visibility scope as before.
  const fetchHits = async (q: string): Promise<SearchHit[]> => {
    const r = await authFetch(
      `/api/student-lookup/search?q=${encodeURIComponent(q)}`,
    );
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body?.error || "Search failed");
    }
    const data = (await r.json()) as { students: SearchHit[] };
    return data.students ?? [];
  };

  if (selected) {
    return (
      <div>
        <SnapshotView
          hit={selected}
          onBackToSearch={() => setSelected(null)}
          canManageDismissal={canManageDismissal}
        />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <div>
          <h2 style={{ margin: 0 }}>Student Profile</h2>
          <p style={{ margin: "4px 0 0", color: "var(--muted)" }}>
            Search a student for a read-only one-stop snapshot.
          </p>
        </div>
        <button className="btn-secondary" onClick={onBack}>
          ← Back
        </button>
      </div>

      <StudentPicker
        mode="async"
        fetcher={fetchHits}
        debounceMs={250}
        onSelect={(hit) => setSelected(hit)}
        getKey={(hit) => hit.studentId}
        getPrimary={(hit) => `${hit.lastName}, ${hit.firstName}`}
        renderMeta={(hit) =>
          `${gradeLabel(hit.grade)} · ID ${hit.localSisId ?? "—"}`
        }
        placeholder="Search by first name, last name, or SIS ID…"
        emptyText="No students found. Teachers can only look up students on their own roster."
        autoFocus
        clearable={false}
        minWidth="100%"
        style={{ display: "block" }}
        inputStyle={{
          padding: "12px 14px",
          fontSize: 16,
          borderRadius: 10,
          border: "1px solid var(--border)",
          boxSizing: "border-box",
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Snapshot view — the editable HeartBEAT note card on top, then the
// read-only StudentProfile (all edit affordances disabled).
// ---------------------------------------------------------------------------
function SnapshotView({
  hit,
  onBackToSearch,
  canManageDismissal,
}: {
  hit: SearchHit;
  onBackToSearch: () => void;
  canManageDismissal: boolean;
}) {
  // HeartBEAT note editor is collapsed by default — staff open it only when
  // they want to leave a parent-facing message for this week's HeartBEAT.
  const [showNote, setShowNote] = useState(false);
  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <button
          className="btn-secondary"
          onClick={() => setShowNote((v) => !v)}
        >
          {showNote
            ? "Hide HeartBEAT message"
            : "✏️ Leave a message for this week's HeartBEAT"}
        </button>
      </div>
      {showNote && <HeartbeatNoteCard studentId={hit.studentId} />}
      <StudentProfile
        studentId={hit.studentId}
        onBack={onBackToSearch}
        backLabel="← Back to search"
        canManageDismissal={canManageDismissal}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// HeartBEAT note editor — the ONE editable field on this page. Loads the
// current note from /api/students/:id and saves via the dedicated PUT.
// ---------------------------------------------------------------------------
function HeartbeatNoteCard({ studentId }: { studentId: string }) {
  const [note, setNote] = useState("");
  const [original, setOriginal] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    (async () => {
      try {
        const r = await authFetch(
          `/api/student-lookup/${encodeURIComponent(studentId)}/heartbeat-note`,
        );
        if (!r.ok) throw new Error("Could not load the current message.");
        const data = await r.json();
        if (cancelled) return;
        const current = typeof data?.message === "string" ? data.message : "";
        setNote(current);
        setOriginal(current);
        setUpdatedAt(
          typeof data?.updatedAt === "string" ? data.updatedAt : null,
        );
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Load failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [studentId]);

  const dirty = note !== original;

  async function save() {
    setSaving(true);
    setError("");
    try {
      const r = await authFetch(
        `/api/student-lookup/${encodeURIComponent(studentId)}/heartbeat-note`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: note }),
        },
      );
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.error || "Could not save the message.");
      }
      const data = await r.json();
      const saved = typeof data?.message === "string" ? data.message : "";
      setNote(saved);
      setOriginal(saved);
      setUpdatedAt(typeof data?.updatedAt === "string" ? data.updatedAt : null);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        border: "1px solid var(--accent, #6366f1)",
        background: "var(--accent-soft, #f5f5ff)",
        borderRadius: 12,
        padding: 16,
        marginBottom: 16,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 8,
        }}
      >
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>
            Message for this week's HeartBEAT
          </div>
          <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 2 }}>
            A short, parent-facing note. It appears on this student's Friday
            HeartBEAT email and PDF. Leave blank to send no message.
          </div>
        </div>
        <span style={{ fontSize: 22 }} aria-hidden>
          💜
        </span>
      </div>

      <textarea
        value={note}
        disabled={loading || saving}
        maxLength={MAX_NOTE_LEN}
        onChange={(e) => {
          setNote(e.target.value);
          setSavedAt(null);
        }}
        placeholder={
          loading ? "Loading…" : "e.g. Ava had a wonderful week in reading group!"
        }
        rows={4}
        style={{
          width: "100%",
          padding: "10px 12px",
          fontSize: 14,
          borderRadius: 8,
          border: "1px solid var(--border)",
          boxSizing: "border-box",
          resize: "vertical",
          fontFamily: "inherit",
        }}
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginTop: 8,
        }}
      >
        <div style={{ fontSize: 12, color: "var(--muted)" }}>
          {note.length}/{MAX_NOTE_LEN}
          {updatedAt && (
            <>
              {" · "}Last saved {new Date(updatedAt).toLocaleString()}
            </>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {savedAt && !dirty && (
            <span style={{ color: "var(--positive, #15803d)", fontSize: 13 }}>
              Saved ✓
            </span>
          )}
          {dirty && (
            <button
              className="btn-secondary"
              disabled={saving}
              onClick={() => {
                setNote(original);
                setSavedAt(null);
              }}
            >
              Discard
            </button>
          )}
          <button
            className="btn-secondary"
            disabled={loading || saving || note.length === 0}
            onClick={() => {
              setNote("");
              setSavedAt(null);
            }}
          >
            Clear
          </button>
          <button
            className="btn-primary"
            disabled={loading || saving || !dirty}
            onClick={save}
          >
            {saving ? "Saving…" : "Save message"}
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            marginTop: 8,
            color: "var(--negative, #b91c1c)",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
