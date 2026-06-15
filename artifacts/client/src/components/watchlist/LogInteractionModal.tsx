import { useEffect, useMemo, useState } from "react";
import { Settings2 } from "lucide-react";
import { authFetch } from "../../lib/authToken";
import { formatCaseNumber } from "../../lib/caseNumber";
import { INTERACTION_KINDS, ROLE_META, WL_COLORS, type Role } from "./colors";
import MentionTextarea from "./MentionTextarea";

interface StudentHit {
  studentId: string;
  localSisId?: string | null;
  firstName: string;
  lastName: string;
  grade: string | null;
}

interface CaseLite {
  id: number;
  caseNumber: number;
  schoolYearLabel?: string;
  title: string;
  status: string;
}

export interface QuickEntry {
  id: number;
  label: string;
  kind: string;
  severity: number;
  location: string;
  summaryTemplate: string;
  sortOrder: number;
  active: boolean;
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
  initialParticipants?: Array<{
    studentId: string;
    firstName: string;
    lastName: string;
    grade: string | null;
    role?: Role;
  }>;
  initialKind?: string;
  initialSeverity?: number;
  titleOverride?: string;
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export default function LogInteractionModal({
  onClose,
  onCreated,
  initialCaseId,
  initialParticipants,
  initialKind,
  initialSeverity,
  titleOverride,
}: Props) {
  const [kind, setKind] = useState<string>(initialKind ?? "verbal");
  const [severity, setSeverity] = useState(initialSeverity ?? 2);
  const [location, setLocation] = useState("");
  const [occurredDate, setOccurredDate] = useState(ymd(new Date()));
  const [summary, setSummary] = useState("");
  const [detail, setDetail] = useState("");
  const [caseId, setCaseId] = useState<number | null>(initialCaseId ?? null);
  const [cases, setCases] = useState<CaseLite[]>([]);
  const [participants, setParticipants] = useState<Participant[]>(
    (initialParticipants ?? []).map((p) => ({
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
  const [searching, setSearching] = useState(false);
  // Witness author — the student giving the statement. Required.
  const [witness, setWitness] = useState<StudentHit | null>(null);
  const [witnessSearch, setWitnessSearch] = useState("");
  const [witnessHits, setWitnessHits] = useState<StudentHit[]>([]);
  const [witnessSearching, setWitnessSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quickEntries, setQuickEntries] = useState<QuickEntry[]>([]);
  const [showManage, setShowManage] = useState(false);
  // Holds the last-applied quick-entry id so the dropdown actually
  // *shows* the user's selection. Clears when the user manually edits
  // any of the fields the template touches (kind/sev/location/summary)
  // so the dropdown doesn't lie about what's currently in the form.
  const [selectedQuickEntryId, setSelectedQuickEntryId] = useState<number | null>(null);

  const loadQuickEntries = async () => {
    const r = await authFetch("/api/watchlist/quick-entries");
    if (!r.ok) return;
    const d = (await r.json()) as { entries: QuickEntry[] };
    setQuickEntries(d.entries);
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await authFetch("/api/watchlist/cases");
      if (!alive || !r.ok) return;
      const d = (await r.json()) as { cases: CaseLite[] };
      setCases(d.cases.filter((c) => c.status !== "closed"));
    })();
    void loadQuickEntries();
    return () => {
      alive = false;
    };
  }, []);

  const applyQuickEntry = (id: number) => {
    const q = quickEntries.find((x) => x.id === id);
    if (!q) return;
    setKind(q.kind);
    setSeverity(q.severity);
    if (q.location) setLocation(q.location);
    if (q.summaryTemplate) setSummary(q.summaryTemplate);
    setSelectedQuickEntryId(id);
  };

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
        const d = (await r.json()) as {
          students?: StudentHit[];
          hits?: StudentHit[];
          results?: StudentHit[];
        };
        setHits(d.students ?? d.hits ?? d.results ?? []);
      } finally {
        if (alive) setSearching(false);
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [search]);

  // Mirror of the participant search, scoped to picking the witness
  // author. Kept separate so the two pickers don't share dropdown state.
  useEffect(() => {
    if (witnessSearch.trim().length < 2) {
      setWitnessHits([]);
      return;
    }
    let alive = true;
    setWitnessSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await authFetch(
          `/api/student-finder/search?q=${encodeURIComponent(witnessSearch.trim())}`,
        );
        if (!alive || !r.ok) return;
        const d = (await r.json()) as {
          students?: StudentHit[];
          hits?: StudentHit[];
          results?: StudentHit[];
        };
        setWitnessHits(d.students ?? d.hits ?? d.results ?? []);
      } finally {
        if (alive) setWitnessSearching(false);
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [witnessSearch]);

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
    if (!witness) {
      setError("Pick the student giving this statement.");
      return;
    }
    if (!summary.trim()) {
      setError("Summary is required.");
      return;
    }
    if (!detail.trim()) {
      setError("Student statement is required — that's the body of the entry.");
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
          witnessStudentId: witness.studentId,
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
      setError(e instanceof Error ? e.message : "Failed to log statement");
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
            {titleOverride ?? "Log new statement"}
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
          {/* Witness author — required. Top of the form so it's the first
              thing the user fills in: a statement always belongs to a
              specific student. */}
          <div>
            <div
              className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: WL_COLORS.inkSoft }}
            >
              Statement from{" "}
              <span style={{ color: WL_COLORS.alert }}>*</span>
              <span className="ml-1 font-normal normal-case opacity-70">
                (the student giving this statement)
              </span>
            </div>
            {witness ? (
              <div
                className="flex items-center justify-between rounded-md border px-3 py-2"
                style={{ borderColor: WL_COLORS.line, background: WL_COLORS.bg }}
              >
                <div className="text-sm font-semibold" style={{ color: WL_COLORS.ink }}>
                  {witness.firstName} {witness.lastName}{" "}
                  <span
                    className="text-[11px] font-normal"
                    style={{ color: WL_COLORS.inkSoft }}
                  >
                    · Gr {witness.grade ?? "?"} · {witness.localSisId ?? "—"}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setWitness(null);
                    setWitnessSearch("");
                    setWitnessHits([]);
                  }}
                  className="text-[11px] font-semibold"
                  style={{ color: WL_COLORS.alert }}
                >
                  Change
                </button>
              </div>
            ) : (
              <div className="relative">
                <input
                  value={witnessSearch}
                  onChange={(e) => setWitnessSearch(e.target.value)}
                  placeholder="Search students by name or ID…"
                  className="w-full rounded-md border px-2 py-1.5 text-sm"
                  style={{ borderColor: WL_COLORS.line, background: WL_COLORS.bg }}
                />
                {witnessHits.length > 0 && (
                  <div
                    className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border shadow-md"
                    style={{ borderColor: WL_COLORS.line, background: WL_COLORS.panel }}
                  >
                    {witnessHits.map((h) => (
                      <button
                        key={h.studentId}
                        type="button"
                        onClick={() => {
                          setWitness(h);
                          setWitnessSearch("");
                          setWitnessHits([]);
                        }}
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
                          · Gr {h.grade ?? "?"} · {h.localSisId ?? "—"}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {witnessSearching && witnessSearch.length >= 2 && witnessHits.length === 0 && (
                  <div className="mt-1 text-[11px]" style={{ color: WL_COLORS.inkSoft }}>
                    Searching…
                  </div>
                )}
              </div>
            )}
          </div>

          <div>
            <div
              className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: WL_COLORS.inkSoft }}
            >
              <span>
                Quick entry{" "}
                <span className="font-normal normal-case opacity-70">
                  (pre-fills the form)
                </span>
              </span>
              <button
                type="button"
                onClick={() => setShowManage(true)}
                className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-bold normal-case tracking-normal"
                style={{ color: WL_COLORS.brand }}
                title="Manage quick-entry catalog (Core Team)"
              >
                <Settings2 className="h-3 w-3" /> Manage
              </button>
            </div>
            <select
              value={selectedQuickEntryId ?? ""}
              onChange={(e) => {
                const id = Number(e.target.value);
                if (id) {
                  applyQuickEntry(id);
                } else {
                  setSelectedQuickEntryId(null);
                }
              }}
              className="w-full rounded-md border px-2 py-1.5 text-sm"
              style={{ borderColor: WL_COLORS.line, background: WL_COLORS.bg }}
            >
              <option value="">
                {quickEntries.length === 0
                  ? "— No templates yet — click Manage to add one"
                  : "— Pick a template —"}
              </option>
              {quickEntries
                .filter((q) => q.active)
                .map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.label} · {q.kind} · sev {q.severity}
                    {q.location ? ` · ${q.location}` : ""}
                  </option>
                ))}
            </select>
            {selectedQuickEntryId !== null && (
              <div className="mt-1 text-[11px]" style={{ color: WL_COLORS.brand }}>
                Template applied — Kind, Severity, Location, and Summary
                were pre-filled. Edit any field below to override.
              </div>
            )}
          </div>

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

          <div className="block text-sm">
            <div
              className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: WL_COLORS.inkSoft }}
            >
              Student statement <span style={{ color: WL_COLORS.alert }}>*</span>
              <span className="ml-1 font-normal normal-case opacity-70">
                — tap <strong>Dictate</strong> to speak, or type <strong>@</strong> (or use <strong>+ Tag student</strong>) to tag another student mentioned by name
              </span>
            </div>
            <MentionTextarea
              value={detail}
              onChange={setDetail}
              rows={6}
              placeholder="Type the student's account in their own words. Tap Dictate to speak it instead. When they name another student, type @ to tag that student so the case automatically links them."
              className="w-full rounded-md border px-2 py-1.5 text-sm"
              style={{ borderColor: WL_COLORS.line, background: WL_COLORS.bg }}
              brandColor={WL_COLORS.brand}
            />
          </div>

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
              <option value="">— No case (statement goes to intake)</option>
              {cases.map((c) => (
                <option key={c.id} value={c.id}>
                  {formatCaseNumber(c)} · {c.title}
                </option>
              ))}
            </select>
          </label>

          <div>
            <div
              className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: WL_COLORS.inkSoft }}
            >
              Participants{" "}
              <span className="font-normal normal-case opacity-70">
                (add as many as needed — search, click, repeat)
              </span>
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
                        · Gr {h.grade ?? "?"} · {h.localSisId ?? "—"}
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
              style={{ background: WL_COLORS.alert, color: "#FFFFFF" }}
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
            className="rounded-md px-3 py-1.5 text-sm font-bold disabled:opacity-50"
            style={{ background: WL_COLORS.brand, color: "#FFFFFF" }}
          >
            {submitting ? "Saving…" : "Save statement"}
          </button>
        </div>
      </div>
      {showManage && (
        <ManageQuickEntriesModal
          entries={quickEntries}
          onClose={() => setShowManage(false)}
          onChanged={() => void loadQuickEntries()}
        />
      )}
    </div>
  );
}

function ManageQuickEntriesModal({
  entries,
  onClose,
  onChanged,
}: {
  entries: QuickEntry[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<number | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Local draft for new entry
  const [draft, setDraft] = useState({
    label: "",
    kind: "verbal",
    severity: 2,
    location: "",
    summaryTemplate: "",
  });
  // Local edit drafts keyed by id
  const [edits, setEdits] = useState<Record<number, Partial<QuickEntry>>>({});

  const update = async (id: number, patch: Partial<QuickEntry>) => {
    setBusy(id);
    setError(null);
    try {
      const r = await authFetch(`/api/watchlist/quick-entries/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(await r.text());
      onChanged();
      setEdits((p) => {
        const n = { ...p };
        delete n[id];
        return n;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: number) => {
    if (!confirm("Delete this quick entry? Existing logged interactions are unaffected.")) return;
    setBusy(id);
    try {
      const r = await authFetch(`/api/watchlist/quick-entries/${id}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error(await r.text());
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    if (!draft.label.trim()) {
      setError("Label is required.");
      return;
    }
    setBusy("new");
    setError(null);
    try {
      const r = await authFetch("/api/watchlist/quick-entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, sortOrder: entries.length }),
      });
      if (!r.ok) throw new Error(await r.text());
      setDraft({ label: "", kind: "verbal", severity: 2, location: "", summaryTemplate: "" });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-auto p-4"
      style={{ background: "rgba(31,27,22,0.55)" }}
      onClick={onClose}
    >
      <div
        className="my-8 w-full max-w-3xl rounded-xl border shadow-xl"
        style={{ background: WL_COLORS.panel, borderColor: WL_COLORS.line }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between border-b px-5 py-3"
          style={{ borderColor: WL_COLORS.line }}
        >
          <div>
            <h2 className="text-lg font-bold" style={{ color: WL_COLORS.ink }}>
              Manage quick-entry catalog
            </h2>
            <p className="text-[11px]" style={{ color: WL_COLORS.inkSoft }}>
              Templates pre-fill the Log Statement form. Visible to all Core Team staff.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm"
            style={{ color: WL_COLORS.inkSoft }}
          >
            Close
          </button>
        </div>

        <div className="space-y-4 p-5">
          {/* Existing entries */}
          <div
            className="rounded-lg border"
            style={{ borderColor: WL_COLORS.line, background: WL_COLORS.bg }}
          >
            <div
              className="border-b px-3 py-2 text-[11px] font-semibold uppercase tracking-wider"
              style={{ borderColor: WL_COLORS.line, color: WL_COLORS.inkSoft }}
            >
              {entries.length} template{entries.length === 1 ? "" : "s"}
            </div>
            {entries.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm" style={{ color: WL_COLORS.inkSoft }}>
                No templates yet. Add your first below.
              </div>
            ) : (
              <div className="divide-y" style={{ borderColor: WL_COLORS.line }}>
                {entries.map((q) => {
                  const e = edits[q.id] ?? {};
                  const cur = { ...q, ...e };
                  return (
                    <div key={q.id} className="grid grid-cols-12 gap-2 px-3 py-2 text-sm">
                      <input
                        value={cur.label}
                        onChange={(ev) =>
                          setEdits((p) => ({ ...p, [q.id]: { ...e, label: ev.target.value } }))
                        }
                        className="col-span-3 rounded-md border px-2 py-1 text-sm"
                        style={{ borderColor: WL_COLORS.line, background: WL_COLORS.panel }}
                      />
                      <select
                        value={cur.kind}
                        onChange={(ev) =>
                          setEdits((p) => ({ ...p, [q.id]: { ...e, kind: ev.target.value } }))
                        }
                        className="col-span-2 rounded-md border px-2 py-1 text-sm"
                        style={{ borderColor: WL_COLORS.line, background: WL_COLORS.panel }}
                      >
                        {INTERACTION_KINDS.map((k) => (
                          <option key={k.value} value={k.value}>
                            {k.label}
                          </option>
                        ))}
                      </select>
                      <select
                        value={cur.severity}
                        onChange={(ev) =>
                          setEdits((p) => ({
                            ...p,
                            [q.id]: { ...e, severity: Number(ev.target.value) },
                          }))
                        }
                        className="col-span-1 rounded-md border px-2 py-1 text-sm"
                        style={{ borderColor: WL_COLORS.line, background: WL_COLORS.panel }}
                      >
                        {[1, 2, 3, 4].map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                      <input
                        value={cur.location}
                        placeholder="Location"
                        onChange={(ev) =>
                          setEdits((p) => ({ ...p, [q.id]: { ...e, location: ev.target.value } }))
                        }
                        className="col-span-2 rounded-md border px-2 py-1 text-sm"
                        style={{ borderColor: WL_COLORS.line, background: WL_COLORS.panel }}
                      />
                      <input
                        value={cur.summaryTemplate}
                        placeholder="Summary template"
                        onChange={(ev) =>
                          setEdits((p) => ({
                            ...p,
                            [q.id]: { ...e, summaryTemplate: ev.target.value },
                          }))
                        }
                        className="col-span-3 rounded-md border px-2 py-1 text-sm"
                        style={{ borderColor: WL_COLORS.line, background: WL_COLORS.panel }}
                      />
                      <div className="col-span-1 flex items-center justify-end gap-1">
                        {Object.keys(e).length > 0 && (
                          <button
                            type="button"
                            onClick={() => update(q.id, e)}
                            disabled={busy === q.id}
                            className="rounded-md px-2 py-1 text-[11px] font-bold disabled:opacity-50"
                            style={{ background: WL_COLORS.brand, color: "#FFFFFF" }}
                          >
                            Save
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => update(q.id, { active: !q.active })}
                          disabled={busy === q.id}
                          className="rounded-md border px-2 py-1 text-[11px] font-semibold"
                          style={{
                            borderColor: WL_COLORS.line,
                            color: q.active ? WL_COLORS.ink : WL_COLORS.inkSoft,
                            opacity: q.active ? 1 : 0.6,
                          }}
                          title={q.active ? "Hide from picker" : "Show in picker"}
                        >
                          {q.active ? "On" : "Off"}
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(q.id)}
                          disabled={busy === q.id}
                          className="rounded-md px-2 py-1 text-[11px] font-semibold"
                          style={{ color: WL_COLORS.alert }}
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* New entry */}
          <div
            className="rounded-lg border p-3"
            style={{ borderColor: WL_COLORS.line, background: WL_COLORS.bg }}
          >
            <div
              className="mb-2 text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: WL_COLORS.inkSoft }}
            >
              Add a new template
            </div>
            <div className="grid grid-cols-12 gap-2 text-sm">
              <input
                value={draft.label}
                placeholder="Label (e.g. Bus 14 fight)"
                onChange={(ev) => setDraft((d) => ({ ...d, label: ev.target.value }))}
                className="col-span-3 rounded-md border px-2 py-1 text-sm"
                style={{ borderColor: WL_COLORS.line, background: WL_COLORS.panel }}
              />
              <select
                value={draft.kind}
                onChange={(ev) => setDraft((d) => ({ ...d, kind: ev.target.value }))}
                className="col-span-2 rounded-md border px-2 py-1 text-sm"
                style={{ borderColor: WL_COLORS.line, background: WL_COLORS.panel }}
              >
                {INTERACTION_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
              <select
                value={draft.severity}
                onChange={(ev) => setDraft((d) => ({ ...d, severity: Number(ev.target.value) }))}
                className="col-span-1 rounded-md border px-2 py-1 text-sm"
                style={{ borderColor: WL_COLORS.line, background: WL_COLORS.panel }}
              >
                {[1, 2, 3, 4].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <input
                value={draft.location}
                placeholder="Location"
                onChange={(ev) => setDraft((d) => ({ ...d, location: ev.target.value }))}
                className="col-span-2 rounded-md border px-2 py-1 text-sm"
                style={{ borderColor: WL_COLORS.line, background: WL_COLORS.panel }}
              />
              <input
                value={draft.summaryTemplate}
                placeholder="Summary template"
                onChange={(ev) => setDraft((d) => ({ ...d, summaryTemplate: ev.target.value }))}
                className="col-span-3 rounded-md border px-2 py-1 text-sm"
                style={{ borderColor: WL_COLORS.line, background: WL_COLORS.panel }}
              />
              <button
                type="button"
                onClick={create}
                disabled={busy === "new"}
                className="col-span-1 rounded-md px-2 py-1 text-[11px] font-bold disabled:opacity-50"
                style={{ background: WL_COLORS.brand, color: "#FFFFFF" }}
              >
                Add
              </button>
            </div>
          </div>

          {error && (
            <div
              className="rounded-md px-3 py-2 text-sm font-semibold"
              style={{ background: WL_COLORS.alert, color: "#FFFFFF" }}
            >
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
