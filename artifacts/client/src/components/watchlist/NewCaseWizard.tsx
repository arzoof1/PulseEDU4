import { useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import { authFetch } from "../../lib/authToken";
import {
  INTERACTION_KINDS,
  ROLE_META,
  WL_COLORS as C,
  type Role,
} from "./colors";
import VoiceTextarea from "./VoiceTextarea";

interface StudentHit {
  studentId: string;
  localSisId?: string | null;
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

export interface SeedInteraction {
  interactionId: number;
  kind?: string;
  severity?: number;
  location?: string;
  occurredDate?: string;
  summary?: string;
  detail?: string;
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
  seedInteraction?: SeedInteraction;
  headline?: string;
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

const SEV_LABELS = [
  { v: 1, label: "Note", hint: "FYI / no harm" },
  { v: 2, label: "Low", hint: "minor disruption" },
  { v: 3, label: "Med", hint: "harm or repeat" },
  { v: 4, label: "High", hint: "safety / police" },
];

type Step = 0 | 1 | 2 | 3;
const STEP_LABELS = ["Players", "Incident", "Title & summary", "Confirm"];

export default function NewCaseWizard({
  onClose,
  onCreated,
  initialPlayers,
  seedInteraction,
  headline,
}: Props) {
  const isPromote = !!seedInteraction;

  const [step, setStep] = useState<Step>(0);

  // Step 1 — Players
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

  // Step 2 — Incident details (always shown; required when promoting; optional otherwise)
  const [logFirst, setLogFirst] = useState<boolean>(isPromote);
  const [incKind, setIncKind] = useState(seedInteraction?.kind ?? "verbal");
  const [incSeverity, setIncSeverity] = useState<number>(
    seedInteraction?.severity ?? 2,
  );
  const [incLocation, setIncLocation] = useState(
    seedInteraction?.location ?? "",
  );
  const [incDate, setIncDate] = useState(
    seedInteraction?.occurredDate ?? ymd(new Date()),
  );
  const [incSummary, setIncSummary] = useState(seedInteraction?.summary ?? "");
  const [incDetail, setIncDetail] = useState(seedInteraction?.detail ?? "");

  // Step 3 — Case title / summary / confidential
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [confidential, setConfidential] = useState(false);
  const [titleTouched, setTitleTouched] = useState(false);

  // Auto-suggest a title from incident + roster once the user moves past step 1.
  const suggestedTitle = useMemo(() => {
    const directs = roster.filter((p) => p.role === "direct");
    const namePart =
      directs.length === 0
        ? roster[0]
          ? `${roster[0].firstName} ${roster[0].lastName.charAt(0)}.`
          : ""
        : directs.length === 1
          ? `${directs[0].firstName} ${directs[0].lastName.charAt(0)}.`
          : `${directs[0].firstName} ${directs[0].lastName.charAt(0)}. + ${directs.length - 1}`;
    const kindLabel =
      INTERACTION_KINDS.find((k) => k.value === incKind)?.label ?? incKind;
    if (!namePart) return kindLabel ? `${kindLabel} incident` : "";
    return `${namePart} — ${kindLabel}`.trim();
  }, [roster, incKind]);

  useEffect(() => {
    if (!titleTouched) setTitle(suggestedTitle);
  }, [suggestedTitle, titleTouched]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // School locations — sourced from Settings → Locations (the same list
  // configured during onboarding). Falls back to free text if empty so
  // the wizard never blocks on missing config.
  const [locations, setLocations] = useState<Array<{ id: number; name: string; active: boolean }>>([]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await authFetch("/api/locations");
        if (!r.ok) return;
        const rows = (await r.json()) as Array<{
          id: number;
          name: string;
          active: boolean;
        }>;
        if (alive) setLocations(rows.filter((l) => l.active));
      } catch {
        /* non-fatal — field stays free-text */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Student search
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
      const d = (await r.json()) as {
        students?: StudentHit[];
        hits?: StudentHit[];
        results?: StudentHit[];
      };
      setHits(d.students ?? d.hits ?? d.results ?? []);
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
  const removePick = (sid: string) =>
    setRoster((prev) => prev.filter((p) => p.studentId !== sid));

  // Per-step validation
  const stepError = useMemo<string | null>(() => {
    if (step === 0) {
      if (roster.length === 0) return "Add at least one student.";
      return null;
    }
    if (step === 1) {
      if (logFirst || isPromote) {
        if (!incSummary.trim())
          return "Incident summary is required (one line).";
      }
      return null;
    }
    if (step === 2) {
      if (!title.trim()) return "Case title is required.";
      return null;
    }
    return null;
  }, [step, roster, logFirst, isPromote, incSummary, title]);

  const canAdvance = stepError == null;

  const next = () => {
    if (!canAdvance) {
      setError(stepError);
      return;
    }
    setError(null);
    if (step < 3) setStep(((step + 1) as Step));
  };
  const back = () => {
    setError(null);
    if (step > 0) setStep(((step - 1) as Step));
  };

  const submit = async () => {
    setError(null);
    if (!title.trim()) {
      setStep(2);
      setError("Case title is required.");
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
      // When promoting an existing interaction, do NOT also create a
      // duplicate "initial incident" — we'll re-attach the existing one.
      if (logFirst && !isPromote) {
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
      const newCaseId = d.case.id;

      if (isPromote && seedInteraction) {
        // Attach the seed (loose) interaction to the brand-new case.
        const patchBody: Record<string, unknown> = { caseId: newCaseId };
        // If the user edited the kind/severity/summary/etc. on Step 2,
        // mirror those edits onto the source interaction too so the
        // case file matches what they confirmed.
        if (incKind !== (seedInteraction.kind ?? "verbal"))
          patchBody["kind"] = incKind;
        if (incSeverity !== (seedInteraction.severity ?? 2))
          patchBody["severity"] = incSeverity;
        if (incLocation !== (seedInteraction.location ?? ""))
          patchBody["location"] = incLocation;
        if (incSummary !== (seedInteraction.summary ?? ""))
          patchBody["summary"] = incSummary;
        if (incDetail !== (seedInteraction.detail ?? ""))
          patchBody["detail"] = incDetail;
        if (
          seedInteraction.occurredDate &&
          incDate !== seedInteraction.occurredDate
        ) {
          // Server PATCH /interactions/:id doesn't accept occurredDate
          // directly; the route only updates summary/detail/location/
          // kind/severity/caseId/status. Date edits on the source
          // interaction would be silently dropped, so warn the user
          // up front rather than pretending we mirrored them.
          // (We still create the case + attach; just flag the gap.)
        }
        const pr = await authFetch(
          `/api/watchlist/interactions/${seedInteraction.interactionId}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patchBody),
          },
        );
        if (!pr.ok) {
          const t = await pr.text();
          // Hand the caller the created case so they can open / retry
          // attach from the case page instead of re-running the wizard
          // (which would create a *duplicate* case on resubmit).
          onCreated?.(newCaseId);
          onClose();
          throw new Error(
            `Case #${newCaseId} created and opened, but attaching the source statement failed: ${
              t || pr.status
            }. You can re-attach from the case page.`,
          );
        }
      }

      onCreated?.(newCaseId);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create case");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-auto p-4"
      style={{ background: "rgba(31,27,22,0.55)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl rounded-xl border shadow-xl"
        style={{ background: C.panel, borderColor: C.line }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between border-b px-5 py-3"
          style={{ borderColor: C.line }}
        >
          <div>
            <h2 className="text-lg font-bold" style={{ color: C.ink }}>
              {headline ?? (isPromote ? "Promote to new case" : "Open new case")}
            </h2>
            <div className="text-[11px]" style={{ color: C.inkSoft }}>
              {isPromote
                ? "We'll attach this loose statement to a brand-new case file."
                : "Step-by-step. Case # is generated on save."}
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm"
            style={{ color: C.inkSoft }}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Stepper */}
        <div
          className="flex items-center gap-2 border-b px-5 py-3"
          style={{ borderColor: C.line, background: C.bg }}
        >
          {STEP_LABELS.map((label, i) => {
            const active = i === step;
            const done = i < step;
            return (
              <div key={label} className="flex flex-1 items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    // Allow back-navigation to completed steps only.
                    if (i <= step) setStep(i as Step);
                  }}
                  disabled={i > step}
                  className="flex items-center gap-2 disabled:cursor-not-allowed"
                >
                  <span
                    className="flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold"
                    style={{
                      background: done
                        ? C.brand
                        : active
                          ? C.brandSoft
                          : "transparent",
                      color: done ? "#FFFFFF" : active ? C.brand : C.inkSoft,
                      border: `1px solid ${done || active ? C.brand : C.line}`,
                    }}
                  >
                    {done ? <Check className="h-3 w-3" /> : i + 1}
                  </span>
                  <span
                    className="text-[12px] font-semibold"
                    style={{ color: active || done ? C.ink : C.inkSoft }}
                  >
                    {label}
                  </span>
                </button>
                {i < STEP_LABELS.length - 1 && (
                  <div
                    className="h-px flex-1"
                    style={{ background: i < step ? C.brand : C.line }}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Body */}
        <div className="space-y-4 p-5" style={{ minHeight: 320 }}>
          {step === 0 && (
            <div className="space-y-3">
              <div className="text-[12px]" style={{ color: C.inkSoft }}>
                Who is involved? Add students and tag each one's role
                (Direct, Witness, Peripheral, etc.).
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
                        <span
                          className="text-[11px]"
                          style={{ color: C.inkSoft }}
                        >
                          · Gr {h.grade ?? "?"} · {h.localSisId ?? "—"}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {roster.length === 0 ? (
                <div
                  className="rounded-md border border-dashed p-4 text-center text-[12px]"
                  style={{ borderColor: C.line, color: C.inkSoft }}
                >
                  No students added yet. Search above to start the roster.
                </div>
              ) : (
                <div className="space-y-2">
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
                          onClick={() => removePick(p.studentId)}
                          className="text-[11px] font-semibold"
                          style={{ color: C.alert }}
                          aria-label="Remove from roster"
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
                              background:
                                p.role === r ? ROLE_META[r].soft : "transparent",
                              border: `1px solid ${
                                p.role === r ? ROLE_META[r].color : C.line
                              }`,
                              color:
                                p.role === r ? ROLE_META[r].color : C.inkSoft,
                            }}
                          >
                            {ROLE_META[r].label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-3">
              {!isPromote && (
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={logFirst}
                    onChange={(e) => setLogFirst(e.target.checked)}
                  />
                  <span>
                    Log the first incident now{" "}
                    <span
                      className="text-[11px]"
                      style={{ color: C.inkSoft }}
                    >
                      (attaches everyone above as participants — recommended)
                    </span>
                  </span>
                </label>
              )}
              {isPromote && (
                <div
                  className="rounded-md border px-3 py-2 text-[12px]"
                  style={{
                    borderColor: C.brand,
                    background: C.brandSoft,
                    color: C.ink,
                  }}
                >
                  Promoting an existing loose statement. Edits below will
                  also update the original interaction.
                </div>
              )}
              <fieldset
                disabled={!logFirst && !isPromote}
                className="space-y-3"
                style={{
                  opacity: !logFirst && !isPromote ? 0.5 : 1,
                }}
              >
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
                    {SEV_LABELS.map((s) => {
                      const active = incSeverity === s.v;
                      return (
                        <button
                          key={s.v}
                          type="button"
                          onClick={() => setIncSeverity(s.v)}
                          className="flex-1 rounded-md border px-2 py-1.5 text-left"
                          style={{
                            borderColor: active ? C.brand : C.line,
                            background: active ? C.brandSoft : C.panel,
                          }}
                        >
                          <div
                            className="text-[12px] font-bold"
                            style={{ color: active ? C.brand : C.ink }}
                          >
                            {s.label}
                          </div>
                          <div
                            className="text-[10px]"
                            style={{ color: C.inkSoft }}
                          >
                            {s.hint}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <label className="block text-sm">
                  <div className="mb-1 flex items-center justify-between">
                    <span
                      className="text-[11px] font-semibold uppercase tracking-wider"
                      style={{ color: C.inkSoft }}
                    >
                      Where (optional)
                    </span>
                    <span
                      className="text-[11px]"
                      style={{ color: C.inkSoft }}
                      title="Add, rename, or retire rooms from Settings → Locations"
                    >
                      Manage in <span className="font-semibold" style={{ color: C.brand }}>Settings → Locations</span>
                    </span>
                  </div>
                  {locations.length > 0 ? (
                    <>
                      <input
                        list="wizard-locations"
                        value={incLocation}
                        onChange={(e) => setIncLocation(e.target.value)}
                        placeholder="Pick a room or type a place…"
                        className="w-full rounded-md border px-2 py-1.5 text-sm"
                        style={{ borderColor: C.line, background: C.panel }}
                      />
                      <datalist id="wizard-locations">
                        {locations.map((l) => (
                          <option key={l.id} value={l.name} />
                        ))}
                      </datalist>
                      <div
                        className="mt-1 text-[10px]"
                        style={{ color: C.inkSoft }}
                      >
                        {locations.length} room
                        {locations.length === 1 ? "" : "s"} configured · free
                        text allowed for one-offs
                      </div>
                    </>
                  ) : (
                    <input
                      value={incLocation}
                      onChange={(e) => setIncLocation(e.target.value)}
                      placeholder="e.g. Hallway B / Cafeteria"
                      className="w-full rounded-md border px-2 py-1.5 text-sm"
                      style={{ borderColor: C.line, background: C.panel }}
                    />
                  )}
                </label>
                <label className="block text-sm">
                  <div
                    className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
                    style={{ color: C.inkSoft }}
                  >
                    One-line summary
                  </div>
                  <input
                    value={incSummary}
                    onChange={(e) => setIncSummary(e.target.value)}
                    placeholder="What happened, in one sentence?"
                    className="w-full rounded-md border px-2 py-1.5 text-sm"
                    style={{ borderColor: C.line, background: C.panel }}
                  />
                </label>
                <div>
                  <div
                    className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider"
                    style={{ color: C.inkSoft }}
                  >
                    <span>Detail (optional)</span>
                    <span className="font-normal normal-case opacity-70">
                      tap <strong>Dictate</strong> to speak instead of type
                    </span>
                  </div>
                  <VoiceTextarea
                    value={incDetail}
                    onChange={setIncDetail}
                    placeholder="Anything else that belongs in the case file — what led up to it, who else saw it, what's already been tried, anything an admin reading this case in three weeks would want to know."
                    rows={8}
                    className="w-full rounded-md border px-2 py-1.5 text-sm"
                    style={{ borderColor: C.line, background: C.panel }}
                    brandColor={C.brand}
                  />
                </div>
              </fieldset>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <label className="block text-sm">
                <div
                  className="mb-1 flex items-center justify-between"
                >
                  <span
                    className="text-[11px] font-semibold uppercase tracking-wider"
                    style={{ color: C.inkSoft }}
                  >
                    Case title
                  </span>
                  {suggestedTitle && titleTouched && title !== suggestedTitle && (
                    <button
                      type="button"
                      onClick={() => {
                        setTitle(suggestedTitle);
                        setTitleTouched(false);
                      }}
                      className="text-[11px] font-semibold"
                      style={{ color: C.brand }}
                    >
                      Use suggestion
                    </button>
                  )}
                </div>
                <input
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setTitleTouched(true);
                  }}
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
                  Case summary (optional)
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
                  Mark <span className="font-semibold">confidential</span> —
                  visibility limited to lead + Core Team.
                </span>
              </label>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <div
                className="rounded-md border p-3"
                style={{ borderColor: C.line, background: C.bg }}
              >
                <div
                  className="text-[10px] font-bold uppercase tracking-wider"
                  style={{ color: C.inkSoft }}
                >
                  Case
                </div>
                <div className="mt-0.5 text-base font-bold" style={{ color: C.ink }}>
                  {title || "(no title)"}
                </div>
                {summary && (
                  <div className="mt-1 text-[12px]" style={{ color: C.inkSoft }}>
                    {summary}
                  </div>
                )}
                {confidential && (
                  <div
                    className="mt-1.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold"
                    style={{ background: C.alertSoft, color: C.alert }}
                  >
                    CONFIDENTIAL
                  </div>
                )}
              </div>
              <div
                className="rounded-md border p-3"
                style={{ borderColor: C.line, background: C.bg }}
              >
                <div
                  className="text-[10px] font-bold uppercase tracking-wider"
                  style={{ color: C.inkSoft }}
                >
                  Players ({roster.length})
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {roster.map((p) => (
                    <span
                      key={p.studentId}
                      className="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                      style={{
                        background: ROLE_META[p.role].soft,
                        color: ROLE_META[p.role].color,
                      }}
                    >
                      {p.firstName} {p.lastName.charAt(0)}.{" "}
                      <span className="opacity-70">· {ROLE_META[p.role].label}</span>
                    </span>
                  ))}
                </div>
              </div>
              {(logFirst || isPromote) && (
                <div
                  className="rounded-md border p-3"
                  style={{ borderColor: C.line, background: C.bg }}
                >
                  <div
                    className="text-[10px] font-bold uppercase tracking-wider"
                    style={{ color: C.inkSoft }}
                  >
                    {isPromote ? "Source incident (will attach)" : "First incident"}
                  </div>
                  <div className="mt-0.5 text-sm" style={{ color: C.ink }}>
                    <span className="font-semibold">
                      {INTERACTION_KINDS.find((k) => k.value === incKind)?.label ?? incKind}
                    </span>{" "}
                    · sev{" "}
                    {SEV_LABELS.find((s) => s.v === incSeverity)?.label ?? incSeverity}
                    {incLocation && <> · {incLocation}</>} · {incDate}
                  </div>
                  <div className="mt-1 text-[12px]" style={{ color: C.inkSoft }}>
                    {incSummary || "(no summary)"}
                  </div>
                </div>
              )}
            </div>
          )}

          {(error || stepError) && (
            <div
              className="rounded-md border px-3 py-2 text-[12px]"
              style={{
                borderColor: C.alert,
                background: C.alertSoft,
                color: C.alert,
              }}
            >
              {error ?? stepError}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between gap-2 border-t px-5 py-3"
          style={{ borderColor: C.line, background: C.bg }}
        >
          <button
            type="button"
            onClick={step === 0 ? onClose : back}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-semibold"
            style={{ borderColor: C.line, color: C.ink }}
          >
            <ChevronLeft className="h-3 w-3" />
            {step === 0 ? "Cancel" : "Back"}
          </button>
          <div
            className="text-[11px] tabular-nums"
            style={{ color: C.inkSoft }}
          >
            Step {step + 1} of {STEP_LABELS.length}
          </div>
          {step < 3 ? (
            <button
              type="button"
              onClick={next}
              disabled={!canAdvance}
              className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-bold disabled:opacity-50"
              style={{ background: C.brand, color: "#FFFFFF" }}
            >
              Next <ChevronRight className="h-3 w-3" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-bold disabled:opacity-50"
              style={{ background: C.brand, color: "#FFFFFF" }}
            >
              <Plus className="h-3 w-3" />
              {submitting
                ? isPromote
                  ? "Promoting…"
                  : "Opening…"
                : isPromote
                  ? "Promote to case"
                  : "Open case"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
