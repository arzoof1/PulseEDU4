import { useEffect, useMemo, useRef, useState } from "react";

// Spotlight — fair, fast, "pull a name from the hat" picker for whole-class
// engagement. Pulls from the teacher's CURRENT-period roster (so attendance
// + period-matching is implicit), excludes a no-repeat tail tracked
// server-side, and pairs the pick with a school-managed prompt card.

interface BellPeriod {
  periodNumber: number;
  startTime: string;
  endTime: string;
}

interface RosterStudent {
  studentId: string;
  firstName: string | null;
  lastName: string | null;
}

interface Prompt {
  id: number;
  text: string;
  active: boolean;
  sortOrder: number;
}

interface PickResult {
  pick: {
    studentId: string;
    firstName: string | null;
    lastName: string | null;
  };
  prompt: { id: number; text: string } | null;
  poolSize: number;
}

type SpinState =
  | { kind: "idle" }
  | { kind: "spinning"; cyclingName: string }
  | { kind: "result"; pick: PickResult };

interface SpotlightPanelProps {
  isAdmin: boolean;
}

export default function SpotlightPanel({ isAdmin }: SpotlightPanelProps) {
  const [periods, setPeriods] = useState<BellPeriod[]>([]);
  const [activePeriod, setActivePeriod] = useState<number | null>(null);
  const [roster, setRoster] = useState<RosterStudent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [skipIds, setSkipIds] = useState<string[]>([]);
  const [spin, setSpin] = useState<SpinState>({ kind: "idle" });
  const [promptsModalOpen, setPromptsModalOpen] = useState(false);

  const spinTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Detect current period from the school's default bell schedule. The
  // server already has the matching helper but we mirror the light bit
  // here so the UI can show "Period 3" without a round-trip first.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/bell-schedules/active", {
          credentials: "include",
        });
        if (!res.ok) {
          // No bell schedule — Spotlight still works if a period is
          // chosen manually via the dropdown.
          setPeriods([]);
          return;
        }
        const data = (await res.json()) as { periods?: BellPeriod[] };
        if (cancelled) return;
        const ps = (data.periods ?? []).slice().sort(
          (a, b) => a.periodNumber - b.periodNumber,
        );
        setPeriods(ps);
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, "0");
        const mm = String(now.getMinutes()).padStart(2, "0");
        const nowHm = `${hh}:${mm}`;
        const live = ps.find(
          (p) => nowHm >= p.startTime && nowHm < p.endTime,
        );
        setActivePeriod(live?.periodNumber ?? ps[0]?.periodNumber ?? null);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Reload the roster whenever the chosen period changes. Reset skip list
  // too — "absent" is per-class-session.
  useEffect(() => {
    if (activePeriod == null) {
      setRoster([]);
      return;
    }
    let cancelled = false;
    setSkipIds([]);
    setSpin({ kind: "idle" });
    (async () => {
      try {
        const res = await fetch(
          `/api/teacher-roster?period=${encodeURIComponent(String(activePeriod))}`,
          { credentials: "include" },
        );
        if (!res.ok) {
          if (!cancelled) setRoster([]);
          return;
        }
        const data = (await res.json()) as {
          students?: RosterStudent[];
          rows?: RosterStudent[];
        };
        const list = data.students ?? data.rows ?? [];
        if (!cancelled) setRoster(list);
      } catch {
        if (!cancelled) setRoster([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activePeriod]);

  const candidateIds = useMemo(
    () => roster.map((r) => r.studentId),
    [roster],
  );

  function stopSpin() {
    if (spinTimerRef.current) {
      clearInterval(spinTimerRef.current);
      spinTimerRef.current = null;
    }
  }
  useEffect(() => () => stopSpin(), []);

  async function pick() {
    if (candidateIds.length === 0) {
      setError(
        "No students in the current-period roster. Pick a different period or check your class schedule.",
      );
      return;
    }
    setError(null);
    stopSpin();
    // Visual reel — cycle random names while we wait for the server.
    const names = roster.map(
      (r) => r.firstName ?? r.studentId,
    );
    const cycle = () => {
      if (names.length === 0) return "";
      return names[Math.floor(Math.random() * names.length)] ?? "";
    };
    setSpin({ kind: "spinning", cyclingName: cycle() });
    spinTimerRef.current = setInterval(() => {
      setSpin({ kind: "spinning", cyclingName: cycle() });
    }, 80);

    const startedAt = Date.now();
    try {
      const res = await fetch("/api/spotlight/pick", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidateStudentIds: candidateIds,
          skipStudentIds: skipIds,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        stopSpin();
        setSpin({ kind: "idle" });
        setError(body.error ?? `Pick failed (${res.status})`);
        return;
      }
      // Hold the spin a beat so the animation reads as "thinking" rather
      // than a strobe — minimum 1.4s total.
      const elapsed = Date.now() - startedAt;
      const wait = Math.max(0, 1400 - elapsed);
      setTimeout(() => {
        stopSpin();
        setSpin({ kind: "result", pick: body as PickResult });
      }, wait);
    } catch (e) {
      stopSpin();
      setSpin({ kind: "idle" });
      setError(e instanceof Error ? e.message : "Pick failed");
    }
  }

  async function rerollPrompt() {
    if (spin.kind !== "result") return;
    try {
      const res = await fetch("/api/spotlight/prompt", {
        credentials: "include",
      });
      if (!res.ok) return;
      const body = (await res.json()) as {
        prompt: { id: number; text: string } | null;
      };
      setSpin({
        kind: "result",
        pick: { ...spin.pick, prompt: body.prompt },
      });
    } catch {
      // ignore
    }
  }

  function markAbsentAndRepick() {
    if (spin.kind !== "result") return;
    const id = spin.pick.pick.studentId;
    setSkipIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setSpin({ kind: "idle" });
    // Defer one tick so skipIds state lands before the next pick fires.
    setTimeout(() => void pick(), 0);
  }

  return (
    <div style={{ padding: "1.25rem", maxWidth: 760, margin: "0 auto" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "0.5rem",
          gap: "0.75rem",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h2 style={{ margin: 0 }}>Spotlight</h2>
          <div style={{ fontSize: "0.85rem", opacity: 0.7 }}>
            Fair, random call-on for your current-period class.
          </div>
        </div>
        {isAdmin && (
          <button
            type="button"
            onClick={() => setPromptsModalOpen(true)}
            style={{
              background: "transparent",
              border: "1px solid #cbd5e1",
              borderRadius: 8,
              padding: "0.45rem 0.75rem",
              fontSize: "0.85rem",
              cursor: "pointer",
            }}
          >
            ⚙ Manage prompts
          </button>
        )}
      </div>

      <div
        className="card"
        style={{
          padding: "1rem",
          display: "flex",
          gap: "0.75rem",
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: "1rem",
        }}
      >
        <div style={{ fontWeight: 600 }}>Period:</div>
        {periods.length === 0 ? (
          <div style={{ fontSize: "0.85rem", opacity: 0.7 }}>
            {loading
              ? "Loading bell schedule…"
              : "No bell schedule configured. Set up School Settings → Bell Schedules to use Spotlight."}
          </div>
        ) : (
          <select
            value={activePeriod ?? ""}
            onChange={(e) => setActivePeriod(Number(e.target.value))}
            style={{
              padding: "0.4rem 0.6rem",
              borderRadius: 8,
              border: "1px solid #cbd5e1",
            }}
          >
            {periods.map((p) => (
              <option key={p.periodNumber} value={p.periodNumber}>
                Period {p.periodNumber} ({p.startTime}–{p.endTime})
              </option>
            ))}
          </select>
        )}
        <div style={{ marginLeft: "auto", fontSize: "0.85rem", opacity: 0.75 }}>
          {roster.length} student{roster.length === 1 ? "" : "s"} in roster
          {skipIds.length > 0 ? ` · ${skipIds.length} marked absent` : ""}
        </div>
      </div>

      <div
        className="card"
        style={{
          padding: "2rem 1.5rem",
          textAlign: "center",
          minHeight: 320,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          background:
            spin.kind === "result"
              ? "linear-gradient(135deg, #1d4ed8, #4f46e5)"
              : "#f8fafc",
          color: spin.kind === "result" ? "#fff" : "inherit",
          transition: "background 0.4s ease",
        }}
      >
        {spin.kind === "idle" && (
          <>
            <div style={{ fontSize: "3rem" }} aria-hidden>
              🎯
            </div>
            <div style={{ fontSize: "1.1rem", opacity: 0.8 }}>
              Ready to call on someone fair and square?
            </div>
            <button
              type="button"
              onClick={() => void pick()}
              disabled={roster.length === 0}
              style={{
                background: roster.length === 0 ? "#94a3b8" : "#1d4ed8",
                color: "#fff",
                border: "none",
                borderRadius: 12,
                padding: "1rem 2rem",
                fontSize: "1.15rem",
                fontWeight: 700,
                cursor: roster.length === 0 ? "not-allowed" : "pointer",
                boxShadow: "0 6px 20px rgba(29,78,216,0.3)",
              }}
            >
              Pick a student
            </button>
            {skipIds.length > 0 && (
              <button
                type="button"
                onClick={() => setSkipIds([])}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#1d4ed8",
                  fontSize: "0.85rem",
                  cursor: "pointer",
                  textDecoration: "underline",
                }}
              >
                Reset absent list ({skipIds.length})
              </button>
            )}
          </>
        )}

        {spin.kind === "spinning" && (
          <>
            <div
              style={{
                fontSize: "0.85rem",
                letterSpacing: "0.15em",
                textTransform: "uppercase",
                opacity: 0.7,
              }}
            >
              Picking…
            </div>
            <div
              style={{
                fontSize: "clamp(2.5rem, 7vw, 4rem)",
                fontWeight: 800,
                lineHeight: 1.1,
                minHeight: "1.2em",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {spin.cyclingName || "…"}
            </div>
          </>
        )}

        {spin.kind === "result" && (
          <>
            <div
              style={{
                fontSize: "0.85rem",
                letterSpacing: "0.15em",
                textTransform: "uppercase",
                opacity: 0.85,
              }}
            >
              Spotlight
            </div>
            <div
              style={{
                fontSize: "clamp(2.5rem, 7vw, 4.5rem)",
                fontWeight: 800,
                lineHeight: 1.1,
              }}
            >
              {spin.pick.pick.firstName ?? spin.pick.pick.studentId}{" "}
              {spin.pick.pick.lastName ?? ""}
            </div>
            {spin.pick.prompt && (
              <div
                style={{
                  background: "rgba(0,0,0,0.18)",
                  borderRadius: 12,
                  padding: "1rem 1.25rem",
                  fontSize: "1.15rem",
                  lineHeight: 1.4,
                  maxWidth: 560,
                }}
              >
                {spin.pick.prompt.text}
              </div>
            )}
            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                flexWrap: "wrap",
                justifyContent: "center",
                marginTop: "0.5rem",
              }}
            >
              <button
                type="button"
                onClick={() => void pick()}
                style={resultBtn(true)}
              >
                Pick again
              </button>
              <button
                type="button"
                onClick={() => void rerollPrompt()}
                style={resultBtn(false)}
              >
                New prompt
              </button>
              <button
                type="button"
                onClick={markAbsentAndRepick}
                style={resultBtn(false)}
              >
                They're absent — re-pick
              </button>
            </div>
          </>
        )}
      </div>

      {error && (
        <div
          style={{
            marginTop: "0.75rem",
            padding: "0.65rem 0.85rem",
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            borderRadius: 8,
            fontSize: "0.9rem",
          }}
        >
          {error}
        </div>
      )}

      {promptsModalOpen && (
        <PromptsManagerModal onClose={() => setPromptsModalOpen(false)} />
      )}
    </div>
  );
}

function resultBtn(primary: boolean): React.CSSProperties {
  return {
    background: primary ? "#fff" : "transparent",
    color: primary ? "#1d4ed8" : "#fff",
    border: primary ? "none" : "1px solid rgba(255,255,255,0.55)",
    borderRadius: 10,
    padding: "0.7rem 1.1rem",
    fontWeight: 700,
    fontSize: "0.95rem",
    cursor: "pointer",
  };
}

function PromptsManagerModal({ onClose }: { onClose: () => void }) {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [newText, setNewText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savingNew, setSavingNew] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/spotlight/prompts", {
        credentials: "include",
      });
      if (res.ok) {
        const body = (await res.json()) as { prompts: Prompt[] };
        setPrompts(body.prompts);
      }
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function add() {
    if (!newText.trim()) return;
    setSavingNew(true);
    setError(null);
    try {
      const res = await fetch("/api/spotlight/prompts", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: newText.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? `Failed (${res.status})`);
        return;
      }
      setNewText("");
      await load();
    } finally {
      setSavingNew(false);
    }
  }

  async function toggle(p: Prompt) {
    await fetch(`/api/spotlight/prompts/${p.id}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !p.active }),
    });
    await load();
  }

  async function remove(p: Prompt) {
    if (!confirm(`Delete prompt: "${p.text}"?`)) return;
    await fetch(`/api/spotlight/prompts/${p.id}`, {
      method: "DELETE",
      credentials: "include",
    });
    await load();
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          borderRadius: 12,
          width: "min(640px, 95vw)",
          maxHeight: "85vh",
          overflowY: "auto",
          padding: "1.25rem",
          boxShadow: "0 20px 50px rgba(0,0,0,0.3)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "0.75rem",
          }}
        >
          <h3 style={{ margin: 0 }}>Spotlight prompts</h3>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              fontSize: "1.4rem",
              cursor: "pointer",
              lineHeight: 1,
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div
          style={{
            fontSize: "0.85rem",
            opacity: 0.7,
            marginBottom: "0.75rem",
          }}
        >
          One of these is shown alongside the picked student's name. Inactive
          prompts are kept but never drawn.
        </div>
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
          <input
            type="text"
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            placeholder="Add a new prompt…"
            style={{
              flex: 1,
              padding: "0.55rem 0.7rem",
              border: "1px solid #cbd5e1",
              borderRadius: 8,
              fontSize: "0.95rem",
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
          />
          <button
            type="button"
            onClick={() => void add()}
            disabled={savingNew || !newText.trim()}
            style={{
              background: "#1d4ed8",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "0.55rem 1rem",
              fontWeight: 600,
              cursor: savingNew || !newText.trim() ? "not-allowed" : "pointer",
              opacity: savingNew || !newText.trim() ? 0.6 : 1,
            }}
          >
            Add
          </button>
        </div>
        {error && (
          <div
            style={{
              marginBottom: "0.75rem",
              padding: "0.55rem 0.7rem",
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#991b1b",
              borderRadius: 8,
              fontSize: "0.85rem",
            }}
          >
            {error}
          </div>
        )}
        {loading ? (
          <div style={{ opacity: 0.6 }}>Loading…</div>
        ) : (
          prompts.map((p) => (
            <div
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                padding: "0.55rem 0.65rem",
                background: p.active ? "#f8fafc" : "#fafafa",
                border: "1px solid #e5e7eb",
                borderRadius: 8,
                marginBottom: "0.4rem",
                opacity: p.active ? 1 : 0.55,
              }}
            >
              <div style={{ flex: 1, fontSize: "0.95rem" }}>{p.text}</div>
              <button
                type="button"
                onClick={() => void toggle(p)}
                style={{
                  background: "transparent",
                  border: "1px solid #cbd5e1",
                  borderRadius: 6,
                  padding: "0.3rem 0.55rem",
                  fontSize: "0.8rem",
                  cursor: "pointer",
                }}
              >
                {p.active ? "Disable" : "Enable"}
              </button>
              <button
                type="button"
                onClick={() => void remove(p)}
                style={{
                  background: "transparent",
                  border: "1px solid #ef4444",
                  color: "#ef4444",
                  borderRadius: 6,
                  padding: "0.3rem 0.55rem",
                  fontSize: "0.8rem",
                  cursor: "pointer",
                }}
              >
                Delete
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
