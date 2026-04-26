// Drill-in panel for "students in this band" — opened by clicking on
// a band/segment in an insights chart (e.g., the L1..L5 placement bars
// on the Academics dashboard).
//
// Renders as a right-side overlay panel rather than a modal dialog so
// the user keeps the chart in view for context. Click the dim layer or
// the close button to dismiss; ESC closes too. Scroll-locks the body
// while open.

import { useEffect } from "react";

interface Student {
  studentId: string;
  studentName: string;
  grade?: number | null;
  pm1?: number | null;
  pm3?: number;
}

interface Props {
  open: boolean;
  title: string;
  subtitle?: string;
  students: Student[];
  truncated?: boolean;
  total?: number;
  loading?: boolean;
  error?: string;
  onClose: () => void;
  onOpenProfile: (studentId: string) => void;
  // Optional column config for the score table — defaults to ELA/Math
  // PM3 columns. Different dashboards can pass different columns.
  scoreColumns?: { key: "pm1" | "pm3"; label: string }[];
}

const DEFAULT_COLUMNS: { key: "pm1" | "pm3"; label: string }[] = [
  { key: "pm1", label: "PM1" },
  { key: "pm3", label: "PM3" },
];

export default function BandStudentsDrawer({
  open,
  title,
  subtitle,
  students,
  truncated,
  total,
  loading,
  error,
  onClose,
  onOpenProfile,
  scoreColumns = DEFAULT_COLUMNS,
}: Props) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div style={overlayStyle} onClick={onClose} role="dialog" aria-modal="true">
      <div
        style={panelStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={headerStyle}>
          <div>
            <h3 style={{ margin: 0, fontSize: "1.05rem" }}>{title}</h3>
            {subtitle && (
              <p
                style={{
                  margin: "0.2rem 0 0",
                  color: "var(--text-subtle)",
                  fontSize: "0.85rem",
                }}
              >
                {subtitle}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={closeBtnStyle}
          >
            ×
          </button>
        </div>

        <div style={bodyStyle}>
          {loading && (
            <p style={{ color: "var(--text-subtle)" }}>Loading…</p>
          )}
          {error && (
            <p style={{ color: "var(--danger, #dc2626)" }}>{error}</p>
          )}
          {!loading && !error && students.length === 0 && (
            <p style={{ color: "var(--text-subtle)" }}>
              No students match this band with the current filters.
            </p>
          )}
          {!loading && !error && students.length > 0 && (
            <>
              <p style={countLineStyle}>
                {total != null
                  ? `${total} student${total === 1 ? "" : "s"}`
                  : `${students.length} student${students.length === 1 ? "" : "s"}`}
                {truncated ? ` — showing first ${students.length}` : ""}
              </p>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Student</th>
                    <th style={thStyleNum}>Grade</th>
                    {scoreColumns.map((c) => (
                      <th key={c.key} style={thStyleNum}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {students.map((s) => (
                    <tr key={s.studentId}>
                      <td style={tdStyle}>
                        <button
                          type="button"
                          onClick={() => onOpenProfile(s.studentId)}
                          style={linkBtnStyle}
                        >
                          {s.studentName}
                        </button>
                      </td>
                      <td style={tdStyleNum}>
                        {s.grade != null
                          ? s.grade === 0
                            ? "K"
                            : s.grade
                          : "—"}
                      </td>
                      {scoreColumns.map((c) => (
                        <td key={c.key} style={tdStyleNum}>
                          {s[c.key] != null ? s[c.key] : "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.45)",
  zIndex: 1000,
  display: "flex",
  justifyContent: "flex-end",
};

const panelStyle: React.CSSProperties = {
  width: "min(520px, 100%)",
  background: "var(--surface, #0f172a)",
  borderLeft: "1px solid var(--border)",
  boxShadow: "-8px 0 24px rgba(0,0,0,0.4)",
  display: "flex",
  flexDirection: "column",
  maxHeight: "100vh",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  padding: "1rem 1.1rem",
  borderBottom: "1px solid var(--border)",
};

const closeBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--text)",
  fontSize: "1.6rem",
  lineHeight: 1,
  cursor: "pointer",
  padding: "0 0.25rem",
};

const bodyStyle: React.CSSProperties = {
  padding: "0.9rem 1.1rem",
  overflowY: "auto",
  flex: 1,
};

const countLineStyle: React.CSSProperties = {
  margin: "0 0 0.6rem",
  color: "var(--text-subtle)",
  fontSize: "0.85rem",
};

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.9rem",
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.4rem 0.5rem",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-subtle)",
  fontWeight: 600,
};

const thStyleNum: React.CSSProperties = {
  ...thStyle,
  textAlign: "right",
};

const tdStyle: React.CSSProperties = {
  padding: "0.4rem 0.5rem",
  borderBottom: "1px solid var(--border)",
};

const tdStyleNum: React.CSSProperties = {
  ...tdStyle,
  textAlign: "right",
};

const linkBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#2563eb",
  cursor: "pointer",
  padding: 0,
  font: "inherit",
  textAlign: "left",
};
