import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../../lib/authToken";
import { INTERACTION_KINDS, ROLE_META, WL_COLORS, type Role } from "./colors";

interface StudentHit {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: string | null;
}

interface CaseLite {
  id: number;
  caseNumber: number;
  title: string;
  status: string;
}

interface Participant {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: string | null;
  role: Role;
  notes: string;
}

interface Props {
  onClose: () => void;
  onCreated?: (interactionId: number) => void;
  initialCaseId?: number | null;
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export default function LogInteractionModal({ onClose, onCreated, initialCaseId }: Props) {
  const [kind, setKind] = useState<string>("verbal");
  const [severity, setSeverity] = useState(2);
  const [location, setLocation] = useState("");
  const [occurredDate, setOccurredDate] = useState(ymd(new Date()));
  const [summary, setSummary] = useState("");
  const [detail, setDetail] = useState("");
  const [caseId, setCaseId] = useState<number | null>(initialCaseId ?? null);
  const [cases, setCases] = useState<CaseLite[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<StudentHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await authFetch("/api/watchlist/cases");
      if (!alive || !r.ok) return;
      const d = (await r.json()) as { cases: CaseLite[] };
      setCases(d.cases.filter((c) => c.status !== "closed"));
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (search.trim().length < 2) {
      setHits([]);
      return;
    }
    let alive = true;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await authFetch(
          `/api/student-finder/search?q=${encodeURIComponent(search.trim())}`,
        );
        if (!alive || !r.ok) return;
        const d = (await r.json()) as { hits?: StudentHit[]; results?: StudentHit[] };
        setHits(d.hits ?? d.results ?? []);
      } finally {
        if (alive) setSearching(false);
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [search]);

  const addParticipant = (h: StudentHit) => {
    if (participants.some((p) => p.studentId === h.studentId)) return;
    setParticipants((prev) => [
      ...prev,
      {
        studentId: h.studentId,
        firstName: h.firstName,
        lastName: h.lastName,
        grade: h.grade,
        role: "peripheral",
        notes: "",
      },
    ]);
    setSearch("");
    setHits([]);
  };

  const setRole = (sid: string, role: Role) =>
    setParticipants((prev) => prev.map((p) => (p.studentId === sid ? { ...p, role } : p)));
  const setNotes = (sid: string, notes: string) =>
    setParticipants((prev) => prev.map((p) => (p.studentId === sid ? { ...p, notes } : p)));
  const removeP = (sid: string) =>
    setParticipants((prev) => prev.filter((p) => p.studentId !== sid));

  const submit = async () => {
    setError(null);
    if (!summary.trim()) {
      setError("Summary is required.");
      return;
    }
    setSubmitting(true);
    try {
      const r = await authFetch("/api/watchlist/interactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          severity,
          location,
          occurredDate,
          summary,
          detail,
          caseId,
          participants: participants.map((p) => ({
            studentId: p.studentId,
            role: p.role,
            notes: p.notes,
          })),
        }),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(t || `Failed (${r.status})`);
      }
      const d = (await r.json()) as { interaction: { id: number } };
      onCreated?.(d.interaction.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to log interaction");
    } finally {
      setSubmitting(false);
    }
  };

  const sevLabels = useMemo(
    () => [
      { v: 1, label: "Note" },
      { v: 2, label: "Low" },
      { v: 3, label: "Med" },
      { v: 4, label: "High" },
    ],
    [],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-auto p-4"
      style={{ background: "rgba(31,27,22,0.55)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl border shadow-xl"
        style={{ background: WL_COLORS.panel, borderColor: WL_COLORS.line }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between border-b px-5 py-3"
          style={{ borderColor: WL_COLORS.line }}
        >
          <h2 className="text-lg font-bold" style={{ color: WL_COLORS.ink }}>
            Log interaction
          </h2>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm"
            style={{ color: WL_COLORS.inkSoft }}
          >
            Close
          </button>
        </div>

        <div className="space-y-4 p-5">
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <div
                className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
                style={{ color: WL_COLORS.inkSoft }}
              >
                Kind
              </div>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                className="w-full rounded-md border px-2 py-1.5 text-sm"
                style={{ borderColor: WL_COLORS.line, background: WL_COLORS.bg }}
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
                style={{ color: WL_COLORS.inkSoft }}
              >
                When
              </div>
              <input
                type="date"
                value={occurredDate}
                onChange={(e) => setOccurredDate(e.target.value)}
                className="w-full rounded-md border px-2 py-1.5 text-sm"
                style={{ borderColor: WL_COLORS.line, background: WL_COLORS.bg }}
              />
            </label>
          </div>

          <div>
            <div
              className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: WL_COLORS.inkSoft }}
            >
              Severity
            </div>
            <div className="flex gap-2">
              {sevLabels.map((s) => (
                <button
                  key={s.v}
                  type="button"
                  onClick={() => setSeverity(s.v)}
                  className="rounded-md border px-3 py-1 text-xs font-semibold"
                  style={{
                    borderColor: severity === s.v ? WL_COLORS.ink : WL_COLORS.line,
                    background: severity === s.v ? WL_COLORS.ink : "transparent",
                    color: severity === s.v ? "#fff" : WL_COLORS.ink,
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
              style={{ color: WL_COLORS.inkSoft }}
            >
              Location
            </div>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Cafeteria, B-wing hallway, Bus 14"
              className="w-full rounded-md border px-2 py-1.5 text-sm"
              style={{ borderColor: WL_COLORS.line, background: WL_COLORS.bg }}
            />
          </label>

          <label className="block text-sm">
            <div
              className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: WL_COLORS.inkSoft }}
            >
              Summary
            </div>
            <input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="One-line description"
              className="w-full rounded-md border px-2 py-1.5 text-sm"
              style={{ borderColor: WL_COLORS.line, background: WL_COLORS.bg }}
            />
          </label>

          <label className="block text-sm">
            <div
              className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: WL_COLORS.inkSoft }}
            >
              Detail (optional)
            </div>
            <textarea
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              rows={3}
              className="w-full rounded-md border px-2 py-1.5 text-sm"
              style={{ borderColor: WL_COLORS.line, background: WL_COLORS.bg }}
            />
          </label>

          <label className="block text-sm">
            <div
              className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: WL_COLORS.inkSoft }}
            >
              Link to case (optional)
            </div>
            <select
              value={caseId ?? ""}
              onChange={(e) => setCaseId(e.target.value ? Number(e.target.value) : null)}
              className="w-full rounded-md border px-2 py-1.5 text-sm"
              style={{ borderColor: WL_COLORS.line, background: WL_COLORS.bg }}
            >
              <option value="">— No case (loose incident)</option>
              {cases.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.caseNumber} · {c.title}
                </option>
              ))}
            </select>
          </label>

          <div>
            <div
              className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: WL_COLORS.inkSoft }}
            >
              Participants
            </div>
            <div className="relative">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search students by name or ID…"
                className="w-full rounded-md border px-2 py-1.5 text-sm"
                style={{ borderColor: WL_COLORS.line, background: WL_COLORS.bg }}
              />
              {hits.length > 0 && (
                <div
                  className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border shadow-md"
                  style={{ borderColor: WL_COLORS.line, background: WL_COLORS.panel }}
                >
                  {hits.map((h) => (
                    <button
                      key={h.studentId}
                      type="button"
                      onClick={() => addParticipant(h)}
                      className="block w-full px-3 py-1.5 text-left text-sm hover:bg-[--hov]"
                      style={
                        {
                          ["--hov" as never]: WL_COLORS.bg,
                          color: WL_COLORS.ink,
                        } as React.CSSProperties
                      }
                    >
                      {h.firstName} {h.lastName}{" "}
                      <span className="text-[11px]" style={{ color: WL_COLORS.inkSoft }}>
                        · Gr {h.grade ?? "?"} · {h.studentId}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {searching && search.length >= 2 && hits.length === 0 && (
                <div className="mt-1 text-[11px]" style={{ color: WL_COLORS.inkSoft }}>
                  Searching…
                </div>
              )}
            </div>

            {participants.length > 0 && (
              <div className="mt-2 space-y-2">
                {participants.map((p) => (
                  <div
                    key={p.studentId}
                    className="rounded-md border p-2"
                    style={{ borderColor: WL_COLORS.line, background: WL_COLORS.bg }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">
                          {p.firstName} {p.lastName}{" "}
                          <span
                            className="text-[11px] font-normal"
                            style={{ color: WL_COLORS.inkSoft }}
                          >
                            · Gr {p.grade ?? "?"}
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeP(p.studentId)}
                        className="text-[11px] font-semibold"
                        style={{ color: WL_COLORS.alert }}
                      >
                        Remove
                      </button>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <span
                        className="text-[11px] font-semibold uppercase tracking-wider"
                        style={{ color: WL_COLORS.inkSoft }}
                      >
                        Role
                      </span>
                      {(Object.keys(ROLE_META) as Role[]).map((r) => (
                        <button
                          key={r}
                          type="button"
                          onClick={() => setRole(p.studentId, r)}
                          className="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                          style={{
                            background: p.role === r ? ROLE_META[r].soft : "transparent",
                            border: `1px solid ${
                              p.role === r ? ROLE_META[r].color : WL_COLORS.line
                            }`,
                            color: p.role === r ? ROLE_META[r].color : WL_COLORS.inkSoft,
                          }}
                        >
                          {ROLE_META[r].label}
                        </button>
                      ))}
                    </div>
                    <input
                      value={p.notes}
                      onChange={(e) => setNotes(p.studentId, e.target.value)}
                      placeholder="Notes (optional)"
                      className="mt-1.5 w-full rounded-md border px-2 py-1 text-xs"
                      style={{ borderColor: WL_COLORS.line, background: WL_COLORS.panel }}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && (
            <div
              className="rounded-md px-3 py-2 text-sm font-semibold"
              style={{ background: WL_COLORS.alertSoft, color: WL_COLORS.alert }}
            >
              {error}
            </div>
          )}
        </div>

        <div
          className="flex items-center justify-end gap-2 border-t px-5 py-3"
          style={{ borderColor: WL_COLORS.line, background: WL_COLORS.bg }}
        >
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-sm font-semibold"
            style={{ borderColor: WL_COLORS.line, color: WL_COLORS.ink }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="rounded-md px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: WL_COLORS.brand }}
          >
            {submitting ? "Saving…" : "Save interaction"}
          </button>
        </div>
      </div>
    </div>
  );
}
