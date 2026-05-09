import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { authFetch } from "../../lib/authToken";
import { INTERACTION_KINDS, ROLE_META, WL_COLORS as C, type Role } from "./colors";
import VoiceTextarea from "./VoiceTextarea";

interface StudentHit {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: string | null;
}

interface RosterPick {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: string | null;
  role: Role;
  notes: string;
}

interface Props {
  onClose: () => void;
  onCreated?: (caseId: number) => void;
  initialPlayers?: Array<{
    studentId: string;
    firstName: string;
    lastName: string;
    grade: string | null;
    role?: Role;
  }>;
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export default function NewCaseModal({ onClose, onCreated, initialPlayers }: Props) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [confidential, setConfidential] = useState(false);
  const [roster, setRoster] = useState<RosterPick[]>(
    (initialPlayers ?? []).map((p) => ({
      studentId: p.studentId,
      firstName: p.firstName,
      lastName: p.lastName,
      grade: p.grade,
      role: p.role ?? "direct",
      notes: "",
    })),
  );
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<StudentHit[]>([]);

  const [logFirst, setLogFirst] = useState(false);
  const [incKind, setIncKind] = useState("verbal");
  const [incSeverity, setIncSeverity] = useState(2);
  const [incLocation, setIncLocation] = useState("");
  const [incDate, setIncDate] = useState(ymd(new Date()));
  const [incSummary, setIncSummary] = useState("");
  const [incDetail, setIncDetail] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (search.trim().length < 2) {
      setHits([]);
      return;
    }
    let alive = true;
    const t = setTimeout(async () => {
      const r = await authFetch(
        `/api/student-finder/search?q=${encodeURIComponent(search.trim())}`,
      );
      if (!alive || !r.ok) return;
      const d = (await r.json()) as { hits?: StudentHit[]; results?: StudentHit[] };
      setHits(d.hits ?? d.results ?? []);
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [search]);

  const addPick = (h: StudentHit) => {
    if (roster.some((r) => r.studentId === h.studentId)) return;
    setRoster((prev) => [
      ...prev,
      {
        studentId: h.studentId,
        firstName: h.firstName,
        lastName: h.lastName,
        grade: h.grade,
        role: "direct",
        notes: "",
      },
    ]);
    setSearch("");
    setHits([]);
  };

  const setRole = (sid: string, role: Role) =>
    setRoster((prev) => prev.map((p) => (p.studentId === sid ? { ...p, role } : p)));
  const setNotes = (sid: string, notes: string) =>
    setRoster((prev) => prev.map((p) => (p.studentId === sid ? { ...p, notes } : p)));
  const remove = (sid: string) =>
    setRoster((prev) => prev.filter((p) => p.studentId !== sid));

  const submit = async () => {
    setError(null);
    if (!title.trim()) {
      setError("Case title is required.");
      return;
    }
    if (logFirst && !incSummary.trim()) {
      setError("Initial-incident summary is required when 'Log first incident' is on.");
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        title: title.trim(),
        summary: summary.trim(),
        status: "open",
        confidential,
        players: roster.map((p) => ({
          studentId: p.studentId,
          role: p.role,
          notes: p.notes,
        })),
      };
      if (logFirst) {
        body["initialIncident"] = {
          kind: incKind,
          severity: incSeverity,
          location: incLocation,
          occurredDate: incDate,
          summary: incSummary,
          detail: incDetail,
        };
      }
      const r = await authFetch("/api/watchlist/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(t || `Failed (${r.status})`);
      }
      const d = (await r.json()) as { case: { id: number } };
      onCreated?.(d.case.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create case");
    } finally {
      setSubmitting(false);
    }
  };

  const sevLabels = [
    { v: 1, label: "Note" },
    { v: 2, label: "Low" },
    { v: 3, label: "Med" },
    { v: 4, label: "High" },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-auto p-4"
      style={{ background: "rgba(31,27,22,0.55)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl border shadow-xl"
        style={{ background: C.panel, borderColor: C.line }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between border-b px-5 py-3"
          style={{ borderColor: C.line }}
        >
          <div>
            <h2 className="text-lg font-bold" style={{ color: C.ink }}>
              Open new case
            </h2>
            <div className="text-[11px]" style={{ color: C.inkSoft }}>
              Case # is generated on save (per-school yearly sequence).
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm"
            style={{ color: C.inkSoft }}
          >
            Close
          </button>
        </div>

        <div className="space-y-4 p-5">
          <label className="block text-sm">
            <div
              className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: C.inkSoft }}
            >
              Title
            </div>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. 8th-grade hallway escalation"
              className="w-full rounded-md border px-2 py-1.5 text-sm"
              style={{ borderColor: C.line, background: C.bg }}
            />
          </label>

          <label className="block text-sm">
            <div
              className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: C.inkSoft }}
            >
              One-line summary (optional)
            </div>
            <input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="What is this case about, in a sentence?"
              className="w-full rounded-md border px-2 py-1.5 text-sm"
              style={{ borderColor: C.line, background: C.bg }}
            />
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={confidential}
              onChange={(e) => setConfidential(e.target.checked)}
            />
            <span>
              Mark <span className="font-semibold">confidential</span> — visibility
              limited to lead + Core Team.
            </span>
          </label>

          <div>
            <div
              className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: C.inkSoft }}
            >
              Initial roster ({roster.length})
            </div>
            <div className="relative">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search students by name or ID…"
                className="w-full rounded-md border px-2 py-1.5 text-sm"
                style={{ borderColor: C.line, background: C.bg }}
              />
              {hits.length > 0 && (
                <div
                  className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border shadow-md"
                  style={{ borderColor: C.line, background: C.panel }}
                >
                  {hits.map((h) => (
                    <button
                      key={h.studentId}
                      type="button"
                      onClick={() => addPick(h)}
                      className="block w-full px-3 py-1.5 text-left text-sm hover:bg-[--hov]"
                      style={
                        {
                          ["--hov" as never]: C.bg,
                          color: C.ink,
                        } as React.CSSProperties
                      }
                    >
                      {h.firstName} {h.lastName}{" "}
                      <span className="text-[11px]" style={{ color: C.inkSoft }}>
                        · Gr {h.grade ?? "?"} · {h.studentId}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {roster.length > 0 && (
              <div className="mt-2 space-y-2">
                {roster.map((p) => (
                  <div
                    key={p.studentId}
                    className="rounded-md border p-2"
                    style={{ borderColor: C.line, background: C.bg }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 truncate text-sm font-semibold">
                        {p.firstName} {p.lastName}{" "}
                        <span
                          className="text-[11px] font-normal"
                          style={{ color: C.inkSoft }}
                        >
                          · Gr {p.grade ?? "?"}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => remove(p.studentId)}
                        className="text-[11px] font-semibold"
                        style={{ color: C.alert }}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {(Object.keys(ROLE_META) as Role[]).map((r) => (
                        <button
                          key={r}
                          type="button"
                          onClick={() => setRole(p.studentId, r)}
                          className="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                          style={{
                            background: p.role === r ? ROLE_META[r].soft : "transparent",
                            border: `1px solid ${
                              p.role === r ? ROLE_META[r].color : C.line
                            }`,
                            color: p.role === r ? ROLE_META[r].color : C.inkSoft,
                          }}
                        >
                          {ROLE_META[r].label}
                        </button>
                      ))}
                    </div>
                    <input
                      value={p.notes}
                      onChange={(e) => setNotes(p.studentId, e.target.value)}
                      placeholder="Roster note (optional)"
                      className="mt-1.5 w-full rounded-md border px-2 py-1 text-xs"
                      style={{ borderColor: C.line, background: C.panel }}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div
            className="rounded-lg border p-3"
            style={{
              borderColor: logFirst ? C.brand : C.line,
              background: logFirst ? C.brandSoft : C.bg,
            }}
          >
            <label className="flex items-center gap-2 text-sm font-semibold">
              <input
                type="checkbox"
                checked={logFirst}
                onChange={(e) => setLogFirst(e.target.checked)}
              />
              <span>Log the first incident now</span>
              <span className="text-[11px] font-normal" style={{ color: C.inkSoft }}>
                (attaches all roster members as participants)
              </span>
            </label>
            {logFirst && (
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <label className="block text-sm">
                    <div
                      className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
                      style={{ color: C.inkSoft }}
                    >
                      Kind
                    </div>
                    <select
                      value={incKind}
                      onChange={(e) => setIncKind(e.target.value)}
                      className="w-full rounded-md border px-2 py-1.5 text-sm"
                      style={{ borderColor: C.line, background: C.panel }}
                    >
                      {INTERACTION_KINDS.map((k) => (
                        <option key={k.value} value={k.value}>
                          {k.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-sm">
                    <div
                      className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
                      style={{ color: C.inkSoft }}
                    >
                      When
                    </div>
                    <input
                      type="date"
                      value={incDate}
                      onChange={(e) => setIncDate(e.target.value)}
                      className="w-full rounded-md border px-2 py-1.5 text-sm"
                      style={{ borderColor: C.line, background: C.panel }}
                    />
                  </label>
                </div>
                <div>
                  <div
                    className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
                    style={{ color: C.inkSoft }}
                  >
                    Severity
                  </div>
                  <div className="flex gap-2">
                    {sevLabels.map((s) => (
                      <button
                        key={s.v}
                        type="button"
                        onClick={() => setIncSeverity(s.v)}
                        className="rounded-md border px-3 py-1 text-xs font-semibold"
                        style={{
                          borderColor: incSeverity === s.v ? C.ink : C.line,
                          background: incSeverity === s.v ? C.ink : "transparent",
                          color: incSeverity === s.v ? "#fff" : C.ink,
                        }}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="block text-sm">
                  <div
                    className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
                    style={{ color: C.inkSoft }}
                  >
                    Location
                  </div>
                  <input
                    value={incLocation}
                    onChange={(e) => setIncLocation(e.target.value)}
                    placeholder="e.g. Cafeteria, B-wing hallway"
                    className="w-full rounded-md border px-2 py-1.5 text-sm"
                    style={{ borderColor: C.line, background: C.panel }}
                  />
                </label>
                <label className="block text-sm">
                  <div
                    className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
                    style={{ color: C.inkSoft }}
                  >
                    Summary
                  </div>
                  <input
                    value={incSummary}
                    onChange={(e) => setIncSummary(e.target.value)}
                    placeholder="One-line description"
                    className="w-full rounded-md border px-2 py-1.5 text-sm"
                    style={{ borderColor: C.line, background: C.panel }}
                  />
                </label>
                <div className="block text-sm">
                  <div
                    className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
                    style={{ color: C.inkSoft }}
                  >
                    Detail (optional) — tap the mic to dictate
                  </div>
                  <VoiceTextarea
                    value={incDetail}
                    onChange={setIncDetail}
                    rows={3}
                    className="w-full rounded-md border px-2 py-1.5 text-sm"
                    style={{ borderColor: C.line, background: C.panel }}
                    brandColor={C.brand}
                  />
                </div>
              </div>
            )}
          </div>

          {error && (
            <div
              className="rounded-md px-3 py-2 text-sm font-semibold"
              style={{ background: C.alertSoft, color: C.alert }}
            >
              {error}
            </div>
          )}
        </div>

        <div
          className="flex items-center justify-end gap-2 border-t px-5 py-3"
          style={{ borderColor: C.line, background: C.bg }}
        >
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-sm font-semibold"
            style={{ borderColor: C.line, color: C.ink }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-bold text-white disabled:opacity-50"
            style={{ background: C.brand }}
          >
            <Plus className="h-3 w-3" /> {submitting ? "Opening…" : "Open case"}
          </button>
        </div>
      </div>
    </div>
  );
}
