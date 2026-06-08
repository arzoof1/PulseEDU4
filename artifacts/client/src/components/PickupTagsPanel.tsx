import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { authFetch } from "../lib/authToken";
import { searchStudents } from "../lib/students";

// =============================================================================
// PickupTagsPanel — in-app Pickup Tag Printing
//
// Office staff + Core Team need to print pickup tags from inside the
// staff app without remembering the `/pickup/admin` URL (which is also
// admin-gated). This panel mirrors the print actions of
// AuthorizationsAdminPage but limits itself to *read + print* — no
// issuing, no toggle, no dismissal-mode editor. Those stay on the
// admin URL.
//
// Server gate is `canManagePickup` in lib/coreTeam.ts (admin / Core
// Team / counselor / front-office secretary / confidential secretary).
// The client-side gate (canManagePickupClient in App.tsx) mirrors that
// boolean exactly so the nav item disappears for teachers.
// =============================================================================

type AuthRow = {
  id: number;
  studentId: number;
  parentId: number | null;
  guardianLabel: string;
  pickupNumber: string;
  restrictedFrom: boolean;
  active: boolean;
  parentDisplayName: string | null;
};

type StudentHit = {
  id: number;
  studentId: string;
  firstName: string;
  lastName: string;
  gradeLevel?: string | null;
};

type TeacherOption = {
  id: number;
  displayName: string;
};

const wrap: CSSProperties = {
  padding: "1.25rem 1.5rem",
  maxWidth: 960,
};

const card: CSSProperties = {
  padding: "1rem 1.1rem",
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: 10,
  background: "var(--surface, #fff)",
  marginBottom: "1rem",
};

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-subtle, #6b7280)",
  marginBottom: 4,
  textTransform: "uppercase",
  letterSpacing: 0.5,
};

const inputStyle: CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--border, #d1d5db)",
  fontSize: 14,
  minWidth: 180,
};

const primaryBtn: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 8,
  background: "var(--brand, #2563eb)",
  color: "#fff",
  border: "none",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

const secondaryBtn: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 8,
  background: "var(--surface, #fff)",
  color: "var(--text, #111827)",
  border: "1px solid var(--border, #d1d5db)",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

const smallBtn: CSSProperties = {
  padding: "4px 10px",
  borderRadius: 6,
  background: "var(--surface, #fff)",
  color: "var(--text, #111827)",
  border: "1px solid var(--border, #d1d5db)",
  fontSize: 13,
  cursor: "pointer",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 14,
};

const th: CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  borderBottom: "1px solid var(--border, #e5e7eb)",
  color: "var(--text-subtle, #6b7280)",
  fontWeight: 600,
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

const td: CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid var(--border-soft, #f3f4f6)",
};

const infoBox: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  background: "var(--surface-soft, #f3f4f6)",
  fontSize: 13,
  marginTop: 8,
};

export default function PickupTagsPanel() {
  const [studentDbIdInput, setStudentDbIdInput] = useState("");
  const [studentDbId, setStudentDbId] = useState<number | null>(null);
  const [studentLabel, setStudentLabel] = useState<string>("");
  const [auths, setAuths] = useState<AuthRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Name typeahead. Debounced /api/students?q= against the same search
  // the Admin Hub discipline modal uses — prefix-matches first/last
  // name and student_id, school-scoped server-side. Picking a hit
  // populates studentDbId (numeric PK), which the existing load path
  // already consumes; we keep the manual DB-id input as an escape
  // hatch for tickets that already cite an internal id.
  const [nameQ, setNameQ] = useState("");
  const [hits, setHits] = useState<StudentHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [showHits, setShowHits] = useState(false);
  const searchSeq = useRef(0);

  // Teacher picker. Loaded once from /api/teacher-roster/teachers
  // (Core Team sees every active teacher with a non-planning section;
  // teachers themselves see only themselves — but they're gated out
  // of this panel entirely so the dropdown effectively serves admins
  // and office staff). Local filter on displayName is plenty for
  // typical school sizes (<200 teachers); no debounce needed.
  const [teachers, setTeachers] = useState<TeacherOption[]>([]);
  const [teacherQ, setTeacherQ] = useState("");
  const [showTeacherHits, setShowTeacherHits] = useState(false);
  const [teacherBusy, setTeacherBusy] = useState(false);
  // Resolved teacher + tag-id set. Selecting a teacher only LOADS the
  // ids (count is shown to the user), then explicit Download/View
  // buttons trigger the PDF — the prior "click name → instant
  // download" surprised users who wanted to confirm the count first.
  const [selectedTeacher, setSelectedTeacher] =
    useState<TeacherOption | null>(null);
  const [teacherAuthIds, setTeacherAuthIds] = useState<number[]>([]);
  const [teacherStudentCount, setTeacherStudentCount] = useState(0);

  const refresh = useCallback(async (sid: number) => {
    setLoading(true);
    try {
      const res = await authFetch(
        `/api/pickup/authorizations?studentDbId=${sid}`,
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg(b.error ?? `Load failed (${res.status})`);
        setAuths([]);
        return;
      }
      const data = (await res.json()) as { authorizations: AuthRow[] };
      setAuths(data.authorizations);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (studentDbId !== null) void refresh(studentDbId);
  }, [studentDbId, refresh]);

  const loadStudent = () => {
    const n = Number(studentDbIdInput);
    if (!Number.isInteger(n) || n <= 0) {
      setMsg("Enter a numeric student database id");
      return;
    }
    setMsg(null);
    setStudentLabel(`Student #${n}`);
    setStudentDbId(n);
  };

  // Debounced name search. Aborts stale responses with searchSeq so a
  // slow earlier request can't overwrite a faster later one.
  useEffect(() => {
    const q = nameQ.trim();
    if (q.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    const mySeq = ++searchSeq.current;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const data = await searchStudents<StudentHit>(q, 12);
        if (mySeq !== searchSeq.current) return;
        setHits(data);
      } finally {
        if (mySeq === searchSeq.current) setSearching(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [nameQ]);

  // One-shot teacher load on mount. Quiet failure: the by-teacher
  // card simply stays empty if the endpoint is unreachable.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch(`/api/teacher-roster/teachers`);
        if (!res.ok) return;
        const data = (await res.json()) as { teachers: TeacherOption[] };
        if (cancelled) return;
        setTeachers(data.teachers ?? []);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredTeachers = (() => {
    const q = teacherQ.trim().toLowerCase();
    if (!q) return teachers.slice(0, 12);
    return teachers
      .filter((t) => (t.displayName ?? "").toLowerCase().includes(q))
      .slice(0, 12);
  })();

  // Load (but don't print) the tag-id set for a teacher. Surface the
  // count so the user can sanity-check before downloading 47 pages.
  const loadTagsForTeacher = async (t: TeacherOption) => {
    setMsg(null);
    setTeacherBusy(true);
    setSelectedTeacher(t);
    setTeacherAuthIds([]);
    setTeacherStudentCount(0);
    try {
      const res = await authFetch(
        `/api/pickup/authorizations/by-teacher?teacherId=${t.id}`,
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg(b.error ?? `Lookup failed (${res.status})`);
        return;
      }
      const data = (await res.json()) as {
        authorizationIds: number[];
        studentCount: number;
        rosterSize?: number;
      };
      setTeacherAuthIds(data.authorizationIds);
      setTeacherStudentCount(data.studentCount);
      if (data.authorizationIds.length === 0) {
        setMsg(
          `No active pickup tags on ${t.displayName}'s roster ` +
            `(${data.rosterSize ?? 0} students).`,
        );
      }
    } finally {
      setTeacherBusy(false);
      setShowTeacherHits(false);
    }
  };

  const teacherFilenameSlug = (t: TeacherOption | null) =>
    t ? t.displayName.replace(/[^a-z0-9]+/gi, "-") : "teacher";

  const downloadTeacherPdf = () => {
    if (!selectedTeacher || teacherAuthIds.length === 0) return;
    return downloadPdf(
      `/api/pickup/tags.pdf?ids=${teacherAuthIds.join(",")}`,
      `pickup-tags-${teacherFilenameSlug(selectedTeacher)}.pdf`,
    );
  };

  const viewTeacherPdf = () => {
    if (!selectedTeacher || teacherAuthIds.length === 0) return;
    return viewPdf(`/api/pickup/tags.pdf?ids=${teacherAuthIds.join(",")}`);
  };

  const pickStudent = (s: StudentHit) => {
    setStudentDbIdInput(String(s.id));
    setStudentLabel(
      `${s.lastName}, ${s.firstName} (${s.studentId}${s.gradeLevel ? ` · grade ${s.gradeLevel}` : ""})`,
    );
    setNameQ(`${s.firstName} ${s.lastName}`);
    setShowHits(false);
    setMsg(null);
    setStudentDbId(s.id);
  };

  // Fetch a tag-PDF response via authFetch (so the school-scoped
  // session cookie rides along — window.open() to the URL directly
  // would skip the cookie inside the Replit iframe and 401), then
  // hand back a same-origin blob: URL the caller can use for a
  // download anchor or a `_blank` window.open.
  const fetchPdfBlobUrl = async (url: string): Promise<string | null> => {
    setMsg(null);
    try {
      const res = await authFetch(url);
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg(b.error ?? `PDF failed (${res.status})`);
        return null;
      }
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  const downloadPdf = async (url: string, filename: string) => {
    const objectUrl = await fetchPdfBlobUrl(url);
    if (!objectUrl) return;
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  };

  // Open the PDF inline in a new tab so the user can preview before
  // printing. blob: URLs don't need cookies, so this works inside the
  // Replit iframe even though a direct window.open(url) would 401.
  const viewPdf = async (url: string) => {
    const objectUrl = await fetchPdfBlobUrl(url);
    if (!objectUrl) return;
    const w = window.open(objectUrl, "_blank", "noopener,noreferrer");
    if (!w) {
      setMsg(
        "Pop-up blocked — allow pop-ups for this site to view the PDF inline, or use Download instead.",
      );
    }
    // Revoke later than download because the new tab needs the URL
    // alive while the user is reading the PDF.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 5 * 60_000);
  };

  const printOne = (a: AuthRow) =>
    downloadPdf(
      `/api/pickup/authorizations/${a.id}/tag.pdf`,
      `pickup-tag-${a.pickupNumber}.pdf`,
    );

  const viewOne = (a: AuthRow) =>
    viewPdf(`/api/pickup/authorizations/${a.id}/tag.pdf`);

  const activeIdsForStudent = () =>
    auths.filter((a) => a.active).map((a) => a.id);

  const printActiveForStudent = () => {
    const ids = activeIdsForStudent();
    if (ids.length === 0) {
      setMsg("No active authorizations to print for this student.");
      return;
    }
    return downloadPdf(
      `/api/pickup/tags.pdf?ids=${ids.join(",")}`,
      `pickup-tags-student-${studentDbId}.pdf`,
    );
  };

  const viewActiveForStudent = () => {
    const ids = activeIdsForStudent();
    if (ids.length === 0) {
      setMsg("No active authorizations to view for this student.");
      return;
    }
    return viewPdf(`/api/pickup/tags.pdf?ids=${ids.join(",")}`);
  };

  const printAllActive = () =>
    downloadPdf(
      `/api/pickup/tags.pdf`,
      `pickup-tags-all-${new Date().toISOString().slice(0, 10)}.pdf`,
    );

  const viewAllActive = () => viewPdf(`/api/pickup/tags.pdf`);

  return (
    <div style={wrap}>
      <h2 style={{ marginTop: 0 }}>Pickup Tags — Print</h2>
      <p style={{ color: "var(--text-subtle, #6b7280)", marginTop: 0 }}>
        Reprint a single pickup tag, all tags for one student, or every
        active tag at this school. PDFs open as downloads.
      </p>

      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>
          School-wide
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={printAllActive}
            style={primaryBtn}
            title="Download one PDF containing every active pickup tag at this school."
          >
            Download PDF (school-wide)
          </button>
          <button
            onClick={viewAllActive}
            style={secondaryBtn}
            title="Open the PDF in a new tab to preview before printing."
          >
            View PDF
          </button>
        </div>
      </div>

      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>
          By teacher
        </div>
        <div
          style={{
            color: "var(--text-subtle, #6b7280)",
            fontSize: 13,
            marginBottom: 8,
          }}
        >
          Prints active tags for every student on the teacher's
          non-planning roster. Useful for homeroom stacks at the start
          of the year.
        </div>
        <div style={{ position: "relative", display: "inline-block" }}>
          <input
            value={teacherQ}
            onChange={(e) => {
              setTeacherQ(e.target.value);
              setShowTeacherHits(true);
            }}
            onFocus={() => setShowTeacherHits(true)}
            onBlur={() => {
              setTimeout(() => setShowTeacherHits(false), 150);
            }}
            style={{ ...inputStyle, minWidth: 320 }}
            placeholder={
              teachers.length === 0
                ? "Loading teachers…"
                : "Type a teacher name…"
            }
            disabled={teacherBusy}
            autoComplete="off"
          />
          {showTeacherHits && teachers.length > 0 && (
            <div
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                right: 0,
                marginTop: 4,
                background: "var(--surface, #fff)",
                border: "1px solid var(--border, #d1d5db)",
                borderRadius: 8,
                boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                maxHeight: 280,
                overflowY: "auto",
                zIndex: 20,
              }}
            >
              {filteredTeachers.length === 0 && (
                <div
                  style={{
                    padding: "8px 12px",
                    color: "var(--text-subtle, #6b7280)",
                    fontSize: 13,
                  }}
                >
                  No matches.
                </div>
              )}
              {filteredTeachers.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setTeacherQ(t.displayName);
                    void loadTagsForTeacher(t);
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "8px 12px",
                    background: "transparent",
                    border: "none",
                    borderBottom: "1px solid var(--border-soft, #f3f4f6)",
                    cursor: "pointer",
                    fontSize: 14,
                  }}
                >
                  {t.displayName}
                </button>
              ))}
            </div>
          )}
        </div>
        {teacherBusy && (
          <div
            style={{
              marginTop: 8,
              fontSize: 13,
              color: "var(--text-subtle, #6b7280)",
            }}
          >
            Loading tag list…
          </div>
        )}
        {!teacherBusy &&
          selectedTeacher &&
          teacherAuthIds.length > 0 && (
            <div
              style={{
                marginTop: 12,
                padding: "10px 12px",
                borderRadius: 8,
                background: "var(--surface-soft, #f3f4f6)",
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div style={{ fontSize: 13 }}>
                Found{" "}
                <strong>{teacherAuthIds.length} tag(s)</strong> for{" "}
                <strong>{teacherStudentCount} student(s)</strong> on{" "}
                <strong>{selectedTeacher.displayName}</strong>'s roster.
              </div>
              <div
                style={{ display: "flex", gap: 8, marginLeft: "auto" }}
              >
                <button
                  onClick={downloadTeacherPdf}
                  style={primaryBtn}
                  title="Download the homeroom tag stack as a PDF."
                >
                  Download PDF
                </button>
                <button
                  onClick={viewTeacherPdf}
                  style={secondaryBtn}
                  title="Open the PDF in a new tab to preview before printing."
                >
                  View PDF
                </button>
              </div>
            </div>
          )}
      </div>

      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>
          Look up a student
        </div>
        <div style={{ display: "flex", gap: 16, alignItems: "end", flexWrap: "wrap" }}>
          <label style={{ ...labelStyle, position: "relative" }}>
            Search by name or SIS id
            <input
              value={nameQ}
              onChange={(e) => {
                setNameQ(e.target.value);
                setShowHits(true);
              }}
              onFocus={() => setShowHits(true)}
              onBlur={() => {
                // Delay so an in-flight onMouseDown can fire before the
                // dropdown unmounts — otherwise the click is swallowed.
                setTimeout(() => setShowHits(false), 150);
              }}
              style={{ ...inputStyle, minWidth: 280 }}
              placeholder="Type at least 2 letters…"
              autoComplete="off"
            />
            {showHits && nameQ.trim().length >= 2 && (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  right: 0,
                  marginTop: 4,
                  background: "var(--surface, #fff)",
                  border: "1px solid var(--border, #d1d5db)",
                  borderRadius: 8,
                  boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                  maxHeight: 280,
                  overflowY: "auto",
                  zIndex: 20,
                }}
              >
                {searching && (
                  <div style={{ padding: "8px 12px", color: "var(--text-subtle, #6b7280)", fontSize: 13 }}>
                    Searching…
                  </div>
                )}
                {!searching && hits.length === 0 && (
                  <div style={{ padding: "8px 12px", color: "var(--text-subtle, #6b7280)", fontSize: 13 }}>
                    No matches.
                  </div>
                )}
                {hits.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onMouseDown={(e) => {
                      // Fire on mousedown so the click lands before the
                      // input's onBlur tears the dropdown down.
                      e.preventDefault();
                      pickStudent(s);
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "8px 12px",
                      background: "transparent",
                      border: "none",
                      borderBottom: "1px solid var(--border-soft, #f3f4f6)",
                      cursor: "pointer",
                      fontSize: 14,
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>
                      {s.lastName}, {s.firstName}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-subtle, #6b7280)" }}>
                      SIS #{s.studentId}
                      {s.gradeLevel ? ` · grade ${s.gradeLevel}` : ""}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </label>
          <span style={{ alignSelf: "center", color: "var(--text-subtle, #6b7280)", fontSize: 12 }}>
            or
          </span>
          <label style={labelStyle}>
            Student DB id
            <input
              value={studentDbIdInput}
              onChange={(e) => setStudentDbIdInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") loadStudent();
              }}
              style={inputStyle}
              placeholder="e.g. 12345"
            />
          </label>
          <button onClick={loadStudent} style={primaryBtn}>
            Load
          </button>
        </div>
        {msg && <div style={infoBox}>{msg}</div>}
      </div>

      {studentDbId !== null && (
        <div style={card}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
            }}
          >
            <div style={{ fontWeight: 600 }}>
              Authorizations for {studentLabel || `student #${studentDbId}`}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={printActiveForStudent}
                style={primaryBtn}
                title="Download all active tags for this student in one PDF."
                disabled={auths.filter((a) => a.active).length === 0}
              >
                Download all
              </button>
              <button
                onClick={viewActiveForStudent}
                style={secondaryBtn}
                title="Open the combined PDF in a new tab to preview."
                disabled={auths.filter((a) => a.active).length === 0}
              >
                View all
              </button>
            </div>
          </div>
          {loading ? (
            <div style={{ color: "var(--text-subtle, #6b7280)" }}>
              Loading…
            </div>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={th}>#</th>
                  <th style={th}>Guardian</th>
                  <th style={th}>Parent</th>
                  <th style={th}>Restricted</th>
                  <th style={th}>Active</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {auths.map((a) => (
                  <tr key={a.id}>
                    <td style={td}>{a.pickupNumber}</td>
                    <td style={td}>{a.guardianLabel}</td>
                    <td style={td}>
                      {a.parentDisplayName ?? a.parentId ?? "—"}
                    </td>
                    <td style={td}>{a.restrictedFrom ? "yes" : "no"}</td>
                    <td style={td}>{a.active ? "yes" : "no"}</td>
                    <td style={td}>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          onClick={() => printOne(a)}
                          style={smallBtn}
                          title="Download a single-tag PDF (reprint)."
                        >
                          Download
                        </button>
                        <button
                          onClick={() => viewOne(a)}
                          style={smallBtn}
                          title="Open the single-tag PDF in a new tab."
                        >
                          View
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {auths.length === 0 && (
                  <tr>
                    <td style={td} colSpan={6}>
                      No authorizations for this student.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
