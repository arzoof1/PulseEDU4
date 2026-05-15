import { useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "../lib/authToken";

// "Where is this student right now?" — top-bar finder available to every
// signed-in staff member. The payload returned by /api/student-finder/* is
// intentionally limited to today's schedule + live location overrides
// (active hall pass, absent today). No academic / behavior / safety data —
// those have their own visibility models on the student profile and this
// screen must not become a side door around them.

interface SearchHit {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: number;
  // Current-period enrichment (server resolves the bell-schedule period
  // active right now, then joins each hit's section roster against it).
  // Null when no default bell schedule is configured or the lookup runs
  // outside the school day.
  currentPeriodName?: string | null;
  currentRoom?: string | null;
  currentTeacherName?: string | null;
  currentWorkExtension?: string | null;
}

interface StaffHit {
  id: number;
  displayName: string;
  email: string;
  role: string;
  defaultRoom: string | null;
  workExtension: string | null;
  cellPhone: string | null;
}

interface PeriodClass {
  courseName: string;
  teacherName: string;
  room: string | null;
  workExtension: string | null;
  cellPhone: string | null;
}

function PhoneLine({
  workExtension,
  cellPhone,
}: {
  workExtension: string | null;
  cellPhone: string | null;
}) {
  if (!workExtension && !cellPhone) return null;
  return (
    <div
      style={{
        fontSize: 11,
        color: "var(--muted, #64748b)",
        marginTop: 2,
        display: "flex",
        gap: 8,
        flexWrap: "wrap",
      }}
    >
      {workExtension && <span>📞 {workExtension}</span>}
      {cellPhone && <span>📱 {cellPhone}</span>}
    </div>
  );
}

interface PeriodRow {
  periodNumber: number;
  periodName: string;
  startTime: string | null;
  endTime: string | null;
  isCurrent: boolean;
  classes: PeriodClass[];
}

interface ActiveHallPass {
  id: number;
  destination: string;
  originRoom: string;
  teacherName: string;
  createdAt: string;
  maxDurationMinutes: number;
}

interface TodayPayload {
  student: SearchHit;
  today: string;
  now: string;
  scheduleName: string | null;
  periods: PeriodRow[];
  activeHallPass: ActiveHallPass | null;
  absentToday: boolean;
}

function fmtTime(hhmm: string | null): string {
  if (!hhmm) return "";
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const period = h >= 12 ? "p" : "a";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")}${period}`;
}

export function StudentFinderModal({
  onClose,
  initialQuery = "",
  initialStudentId,
}: {
  onClose: () => void;
  // When provided, the search field opens pre-populated with this string
  // and the typeahead fires immediately. Used by deep-links from the
  // network views' right panel ("Open in Student Finder") so a user
  // jumping from a sphere to the finder doesn't have to retype the name.
  initialQuery?: string;
  // When provided, the modal skips the search step entirely and loads
  // this student's schedule directly. Preferred over initialQuery for
  // deep-links from network/case views where we already know the
  // canonical studentId — avoids "no students match" misses caused by
  // search heuristics on a name we already resolved.
  initialStudentId?: string;
}) {
  const [mode, setMode] = useState<"students" | "staff">("students");
  const [query, setQuery] = useState(initialQuery);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [staffHits, setStaffHits] = useState<StaffHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<string | null>(
    initialStudentId ?? null,
  );
  const [today, setToday] = useState<TodayPayload | null>(null);
  const [loadingToday, setLoadingToday] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const currentRowRef = useRef<HTMLTableRowElement>(null);

  // Autofocus the search input on open.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Debounced typeahead. Mode flips between student and staff search;
  // the two share the same input + debounce so swapping tabs feels
  // instantaneous rather than re-firing a request.
  useEffect(() => {
    if (selected) return; // pause search once a student is loaded
    const q = query.trim();
    if (q.length < 1) {
      setHits([]);
      setStaffHits([]);
      return;
    }
    setSearching(true);
    const handle = window.setTimeout(async () => {
      try {
        if (mode === "students") {
          const r = await authFetch(
            `/api/student-finder/search?q=${encodeURIComponent(q)}`,
          );
          if (!r.ok) {
            setHits([]);
            setSearching(false);
            return;
          }
          const data = (await r.json()) as { students: SearchHit[] };
          setHits(data.students ?? []);
          setStaffHits([]);
        } else {
          const r = await authFetch(
            `/api/student-finder/staff-search?q=${encodeURIComponent(q)}`,
          );
          if (!r.ok) {
            setStaffHits([]);
            setSearching(false);
            return;
          }
          const data = (await r.json()) as { staff: StaffHit[] };
          setStaffHits(data.staff ?? []);
          setHits([]);
        }
      } catch {
        setHits([]);
        setStaffHits([]);
      } finally {
        setSearching(false);
      }
    }, 180);
    return () => window.clearTimeout(handle);
  }, [query, selected, mode]);

  // Load schedule when a student is picked.
  useEffect(() => {
    if (!selected) {
      setToday(null);
      return;
    }
    setLoadingToday(true);
    setError(null);
    (async () => {
      try {
        const r = await authFetch(
          `/api/student-finder/${encodeURIComponent(selected)}/today`,
        );
        if (!r.ok) {
          setError(
            r.status === 404
              ? "Student not found in your school."
              : `Could not load schedule (${r.status}).`,
          );
          setLoadingToday(false);
          return;
        }
        setToday((await r.json()) as TodayPayload);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoadingToday(false);
      }
    })();
  }, [selected]);

  const showingResults = !selected;
  const passMinutesElapsed = useMemo(() => {
    if (!today?.activeHallPass) return null;
    const started = new Date(today.activeHallPass.createdAt).getTime();
    if (!Number.isFinite(started)) return null;
    return Math.max(0, Math.round((Date.now() - started) / 60000));
  }, [today?.activeHallPass]);

  function jumpToNow() {
    currentRowRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Student Finder"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.55)",
        zIndex: 1100,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "5vh 16px",
        overflowY: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "white",
          borderRadius: 12,
          width: "min(820px, 100%)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
          display: "flex",
          flexDirection: "column",
          maxHeight: "90vh",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 18px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 20 }}>📍</span>
          <h2 style={{ margin: 0, fontSize: 18, flex: 1 }}>
            Student Finder
            {selected && today ? (
              <span
                style={{
                  fontWeight: 400,
                  color: "var(--muted, #64748b)",
                  marginLeft: 10,
                  fontSize: 14,
                }}
              >
                — {today.student.firstName} {today.student.lastName} (grade{" "}
                {today.student.grade})
              </span>
            ) : null}
          </h2>
          {selected ? (
            <button
              type="button"
              onClick={() => {
                setSelected(null);
                setToday(null);
                setError(null);
                window.setTimeout(() => inputRef.current?.focus(), 0);
              }}
              style={{
                background: "transparent",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "4px 10px",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              ← New search
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close finder"
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "4px 10px",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Close
          </button>
        </div>

        {/* Search OR schedule */}
        {showingResults ? (
          <div style={{ padding: "12px 18px 18px", overflowY: "auto" }}>
            {/* Mode tabs — students vs staff. Staff mode is for "what's
                Ms. Smith's room / extension?" lookups; it does not load
                a schedule, just shows the directory row inline. */}
            <div
              role="tablist"
              aria-label="Finder mode"
              style={{
                display: "flex",
                gap: 6,
                marginBottom: 10,
                borderBottom: "1px solid var(--border)",
              }}
            >
              {(["students", "staff"] as const).map((m) => {
                const active = mode === m;
                return (
                  <button
                    key={m}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => {
                      setMode(m);
                      // Clear the other mode's stale results so we don't
                      // briefly render student rows under the Staff tab
                      // (or vice-versa) until the new debounced search
                      // resolves.
                      setHits([]);
                      setStaffHits([]);
                    }}
                    style={{
                      background: "transparent",
                      border: "none",
                      borderBottom: `2px solid ${active ? "#0ea5e9" : "transparent"}`,
                      color: active ? "#0c4a6e" : "var(--muted, #64748b)",
                      fontWeight: active ? 700 : 500,
                      padding: "6px 10px",
                      cursor: "pointer",
                      fontSize: 13,
                      marginBottom: -1,
                    }}
                  >
                    {m === "students" ? "Students" : "Staff"}
                  </button>
                );
              })}
            </div>
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                mode === "students"
                  ? "Search by name or student ID…"
                  : "Search staff by name or email…"
              }
              style={{
                width: "100%",
                padding: "10px 12px",
                fontSize: 15,
                border: "1px solid var(--border)",
                borderRadius: 8,
                boxSizing: "border-box",
              }}
            />
            <div
              style={{
                marginTop: 4,
                fontSize: 12,
                color: "var(--muted, #64748b)",
                minHeight: 16,
              }}
            >
              {searching
                ? "Searching…"
                : query.trim().length === 0
                  ? mode === "students"
                    ? "Type a name or student ID to look up where they are right now."
                    : "Type a staff name or email to see room and extension."
                  : mode === "students"
                    ? hits.length === 0
                      ? "No students match that search."
                      : `${hits.length} match${hits.length === 1 ? "" : "es"}`
                    : staffHits.length === 0
                      ? "No staff match that search."
                      : `${staffHits.length} match${staffHits.length === 1 ? "" : "es"}`}
            </div>
            {mode === "staff" && staffHits.length > 0 && (
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: "10px 0 0",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  overflow: "hidden",
                }}
              >
                {staffHits.map((s) => (
                  <li
                    key={s.id}
                    style={{
                      borderBottom: "1px solid var(--border)",
                      padding: "10px 12px",
                      background: "white",
                      fontSize: 14,
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        gap: 10,
                        alignItems: "baseline",
                        flexWrap: "wrap",
                      }}
                    >
                      <strong>{s.displayName}</strong>
                      <span
                        style={{
                          color: "var(--muted, #64748b)",
                          fontSize: 12,
                        }}
                      >
                        {s.role}
                      </span>
                      <span
                        style={{
                          marginLeft: "auto",
                          color: "var(--muted, #64748b)",
                          fontSize: 12,
                        }}
                      >
                        {s.email}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: 14,
                        flexWrap: "wrap",
                        fontSize: 13,
                        color: "#334155",
                      }}
                    >
                      <span>🚪 Room {s.defaultRoom ?? "—"}</span>
                      <span>📞 Ext {s.workExtension ?? "—"}</span>
                      {s.cellPhone && <span>📱 {s.cellPhone}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {mode === "students" && hits.length > 0 && (
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: "10px 0 0",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  overflow: "hidden",
                }}
              >
                {hits.map((h) => {
                  const hasLocation =
                    h.currentRoom ||
                    h.currentWorkExtension ||
                    h.currentTeacherName;
                  return (
                    <li key={h.studentId}>
                      <button
                        type="button"
                        onClick={() => setSelected(h.studentId)}
                        style={{
                          width: "100%",
                          textAlign: "left",
                          background: "white",
                          border: "none",
                          borderBottom: "1px solid var(--border)",
                          padding: "10px 12px",
                          cursor: "pointer",
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                          fontSize: 14,
                        }}
                        onMouseEnter={(e) =>
                          (e.currentTarget.style.background = "#f8fafc")
                        }
                        onMouseLeave={(e) =>
                          (e.currentTarget.style.background = "white")
                        }
                      >
                        <div
                          style={{
                            display: "flex",
                            gap: 12,
                            alignItems: "baseline",
                          }}
                        >
                          <strong>
                            {h.lastName}, {h.firstName}
                          </strong>
                          <span style={{ color: "var(--muted, #64748b)" }}>
                            Grade {h.grade}
                          </span>
                          <span
                            style={{
                              color: "var(--muted, #64748b)",
                              marginLeft: "auto",
                              fontFamily:
                                "ui-monospace, SFMono-Regular, monospace",
                              fontSize: 12,
                            }}
                          >
                            {h.studentId}
                          </span>
                        </div>
                        {hasLocation && (
                          <div
                            style={{
                              display: "flex",
                              gap: 12,
                              flexWrap: "wrap",
                              fontSize: 12,
                              color: "#334155",
                            }}
                          >
                            {h.currentPeriodName && (
                              <span
                                style={{
                                  background: "var(--success-soft, #dcfce7)",
                                  color: "#065f46",
                                  fontWeight: 600,
                                  padding: "1px 6px",
                                  borderRadius: 4,
                                }}
                              >
                                NOW · {h.currentPeriodName}
                              </span>
                            )}
                            <span>🚪 Room {h.currentRoom ?? "—"}</span>
                            <span>
                              📞 Ext {h.currentWorkExtension ?? "—"}
                            </span>
                            {h.currentTeacherName && (
                              <span style={{ color: "var(--muted, #64748b)" }}>
                                {h.currentTeacherName}
                              </span>
                            )}
                          </div>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : (
          <div style={{ padding: "12px 18px 18px", overflowY: "auto" }}>
            {loadingToday && (
              <div style={{ color: "var(--muted, #64748b)" }}>
                Loading schedule…
              </div>
            )}
            {error && (
              <div
                role="alert"
                style={{
                  background: "#fee2e2",
                  color: "#991b1b",
                  padding: 10,
                  borderRadius: 8,
                  fontSize: 14,
                }}
              >
                {error}
              </div>
            )}
            {today && (
              <>
                {/* Live banners (highest-signal info first) */}
                {today.absentToday && (
                  <div
                    role="status"
                    style={{
                      background: "#fef3c7",
                      color: "#78350f",
                      border: "1px solid #f59e0b",
                      padding: "10px 12px",
                      borderRadius: 8,
                      marginBottom: 10,
                      fontSize: 14,
                    }}
                  >
                    <strong>Absent today.</strong> This student is marked
                    absent — they are not on campus.
                  </div>
                )}
                {today.activeHallPass && (
                  <div
                    role="status"
                    style={{
                      background: "var(--success-soft, #dcfce7)",
                      color: "#065f46",
                      border: "1px solid #16a34a",
                      padding: "10px 12px",
                      borderRadius: 8,
                      marginBottom: 10,
                      fontSize: 14,
                    }}
                  >
                    <strong>On a hall pass right now</strong> — to{" "}
                    {today.activeHallPass.destination} from{" "}
                    {today.activeHallPass.originRoom} ({" "}
                    {today.activeHallPass.teacherName})
                    {passMinutesElapsed !== null && (
                      <>
                        {" · "}
                        {passMinutesElapsed} min elapsed of{" "}
                        {today.activeHallPass.maxDurationMinutes}
                      </>
                    )}
                  </div>
                )}

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    margin: "4px 0 8px",
                    fontSize: 13,
                    color: "var(--muted, #64748b)",
                  }}
                >
                  <span>
                    {today.scheduleName
                      ? `Bell schedule: ${today.scheduleName}`
                      : "No bell schedule configured for this school."}{" "}
                    · Now {fmtTime(today.now)}
                  </span>
                  {today.periods.some((p) => p.isCurrent) && (
                    <button
                      type="button"
                      onClick={jumpToNow}
                      style={{
                        background: "var(--success-soft, #dcfce7)",
                        color: "#065f46",
                        border: "1px solid #16a34a",
                        borderRadius: 6,
                        padding: "3px 10px",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      Jump to now
                    </button>
                  )}
                </div>

                <table className="pulse-table" style={{ width: "100%" }}>
                  <thead>
                    <tr>
                      <th style={{ width: "18%" }}>Period</th>
                      <th style={{ width: "18%" }}>Time</th>
                      <th>Subject</th>
                      <th>Teacher</th>
                      <th style={{ width: "12%" }}>Room</th>
                    </tr>
                  </thead>
                  <tbody>
                    {today.periods.length === 0 && (
                      <tr>
                        <td
                          colSpan={5}
                          style={{
                            color: "var(--muted, #64748b)",
                            textAlign: "center",
                            padding: 16,
                          }}
                        >
                          No schedule data for this student.
                        </td>
                      </tr>
                    )}
                    {today.periods.map((p) => {
                      const noClass = p.classes.length === 0;
                      const rowStyle = p.isCurrent
                        ? { background: "var(--success-soft, #dcfce7)" }
                        : undefined;
                      // One row per (period × class) so co-taught periods
                      // surface every teacher cleanly. Periods with no
                      // class still show as a single row labeled "No
                      // scheduled class" — never dimmed (per the
                      // no-muting requirement).
                      if (noClass) {
                        return (
                          <tr
                            key={`p${p.periodNumber}`}
                            ref={p.isCurrent ? currentRowRef : undefined}
                            style={rowStyle}
                          >
                            <td>
                              <strong>{p.periodName}</strong>
                            </td>
                            <td>
                              {p.startTime
                                ? `${fmtTime(p.startTime)} – ${fmtTime(p.endTime)}`
                                : "—"}
                            </td>
                            <td colSpan={3} style={{ fontStyle: "italic" }}>
                              No scheduled class
                            </td>
                          </tr>
                        );
                      }
                      return p.classes.map((c, idx) => (
                        <tr
                          key={`p${p.periodNumber}-${idx}`}
                          ref={
                            p.isCurrent && idx === 0
                              ? currentRowRef
                              : undefined
                          }
                          style={rowStyle}
                        >
                          {idx === 0 ? (
                            <>
                              <td rowSpan={p.classes.length}>
                                <strong>{p.periodName}</strong>
                                {p.isCurrent && (
                                  <div
                                    style={{
                                      fontSize: 11,
                                      color: "#065f46",
                                      fontWeight: 600,
                                    }}
                                  >
                                    NOW
                                  </div>
                                )}
                              </td>
                              <td rowSpan={p.classes.length}>
                                {p.startTime
                                  ? `${fmtTime(p.startTime)} – ${fmtTime(
                                      p.endTime,
                                    )}`
                                  : "—"}
                              </td>
                            </>
                          ) : null}
                          <td>{c.courseName}</td>
                          <td>
                            {c.teacherName}
                            <PhoneLine
                              workExtension={c.workExtension}
                              cellPhone={c.cellPhone}
                            />
                          </td>
                          <td>{c.room ?? "—"}</td>
                        </tr>
                      ));
                    })}
                  </tbody>
                </table>

                <div
                  style={{
                    marginTop: 10,
                    fontSize: 12,
                    color: "var(--muted, #64748b)",
                  }}
                >
                  Schedule shows where the student is according to the bell
                  schedule. If they are on an active hall pass or marked
                  absent, the banner above is the more accurate location.
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
