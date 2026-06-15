import { useEffect, useRef, useState } from "react";
import { searchStudents, type StudentHit } from "./data";

// Debounced student typeahead. Renders local_sis_id only (never FLEID).
// Calls onPick with the full hit; the caller keeps studentId for joins.
export default function StudentSearchInput({
  onPick,
  placeholder = "Search students by name or SIS ID…",
  excludeIds,
}: {
  onPick: (hit: StudentHit) => void;
  placeholder?: string;
  excludeIds?: Set<string>;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<StudentHit[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 1) {
      setHits([]);
      return;
    }
    let cancelled = false;
    setBusy(true);
    const t = setTimeout(() => {
      searchStudents(term)
        .then((rows) => {
          if (cancelled) return;
          setHits(
            excludeIds ? rows.filter((r) => !excludeIds.has(r.studentId)) : rows,
          );
          setOpen(true);
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, excludeIds]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <input
        type="text"
        value={q}
        placeholder={placeholder}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => hits.length > 0 && setOpen(true)}
        style={{
          width: "100%",
          padding: "0.5rem 0.7rem",
          border: "1px solid #cbd5e1",
          borderRadius: 8,
          fontSize: "0.9rem",
          boxSizing: "border-box",
        }}
      />
      {open && (hits.length > 0 || busy) && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            background: "white",
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            zIndex: 50,
            maxHeight: 260,
            overflowY: "auto",
          }}
        >
          {busy && hits.length === 0 && (
            <div style={{ padding: "0.6rem 0.8rem", color: "#94a3b8" }}>
              Searching…
            </div>
          )}
          {hits.map((h) => (
            <button
              key={h.studentId}
              type="button"
              onClick={() => {
                onPick(h);
                setQ("");
                setHits([]);
                setOpen(false);
              }}
              style={{
                display: "flex",
                justifyContent: "space-between",
                width: "100%",
                textAlign: "left",
                border: "none",
                background: "white",
                padding: "0.55rem 0.8rem",
                cursor: "pointer",
                borderBottom: "1px solid #f1f5f9",
              }}
            >
              <span style={{ color: "#0f172a" }}>
                {h.lastName}, {h.firstName}
              </span>
              <span style={{ color: "#94a3b8", fontSize: "0.8rem" }}>
                {h.localSisId ?? "—"}
                {h.grade ? ` · Gr ${h.grade}` : ""}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
