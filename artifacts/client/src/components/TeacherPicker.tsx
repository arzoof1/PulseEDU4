import { useMemo, useState, type CSSProperties } from "react";
import {
  type TeacherOpt,
  DEPARTMENT_ORDER,
  deptOf,
  tintFor,
  presentDepartments,
} from "./teacherDepartments";

export type { TeacherOpt };

interface TeacherPickerProps {
  teachers: TeacherOpt[];
  value: number | null;
  onChange: (id: number | null) => void;
  // Show a leading blank/"all" option (e.g. for filters).
  allowEmpty?: boolean;
  emptyLabel?: string;
  // Show the "Dept:" quick-filter dropdown alongside the search box.
  showDeptFilter?: boolean;
  disabled?: boolean;
  searchPlaceholder?: string;
  // Style overrides for the inner <select>.
  selectStyle?: CSSProperties;
  // Style override for the outer wrapper.
  style?: CSSProperties;
  id?: string;
  ariaLabel?: string;
}

// One searchable, department-grouped, color-tinted teacher dropdown used
// everywhere a teacher is chosen. Keeps the natural department ordering;
// the search box only filters the visible options. The currently-selected
// teacher always stays visible (even when filtered out) so the control
// never appears to "lose" the selection mid-search.
export function TeacherPicker({
  teachers,
  value,
  onChange,
  allowEmpty = false,
  emptyLabel = "All teachers",
  showDeptFilter = false,
  disabled = false,
  searchPlaceholder = "Search teacher…",
  selectStyle,
  style,
  id,
  ariaLabel,
}: TeacherPickerProps) {
  const [search, setSearch] = useState("");
  const [deptFilter, setDeptFilter] = useState("");

  const presentDepts = useMemo(
    () => presentDepartments(teachers),
    [teachers],
  );

  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    return teachers.filter((t) => {
      // Always keep the selected teacher visible.
      if (t.id === value) return true;
      if (deptFilter && deptOf(t) !== deptFilter) return false;
      if (q) {
        const name = (t.displayName ?? `Staff #${t.id}`).toLowerCase();
        if (!name.includes(q)) return false;
      }
      return true;
    });
  }, [teachers, deptFilter, q, value]);

  const grouped = useMemo(() => {
    const g: Record<string, TeacherOpt[]> = {};
    for (const t of filtered) {
      (g[deptOf(t)] ??= []).push(t);
    }
    return g;
  }, [filtered]);

  const orderedDepts = DEPARTMENT_ORDER.filter((d) => grouped[d]?.length);
  const noMatches = !allowEmpty && filtered.length === 0;

  return (
    <div
      style={{
        display: "inline-flex",
        flexDirection: "column",
        gap: 4,
        ...style,
      }}
    >
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={searchPlaceholder}
        disabled={disabled}
        aria-label={ariaLabel ? `${ariaLabel} — search` : "Search teacher"}
        style={{ fontSize: 13, padding: "3px 6px" }}
      />
      <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
        {showDeptFilter && presentDepts.length > 1 && (
          <select
            value={deptFilter}
            onChange={(e) => setDeptFilter(e.target.value)}
            disabled={disabled}
            aria-label="Filter teachers by department"
            style={{
              fontSize: 13,
              background: deptFilter ? tintFor(deptFilter) : "#ffffff",
            }}
          >
            <option value="">All depts</option>
            {presentDepts.map((d) => (
              <option key={d} value={d} style={{ backgroundColor: tintFor(d) }}>
                {d}
              </option>
            ))}
          </select>
        )}
        <select
          id={id}
          value={value ?? ""}
          disabled={disabled || noMatches}
          aria-label={ariaLabel}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v ? Number(v) : null);
          }}
          style={selectStyle}
        >
          {allowEmpty && <option value="">{emptyLabel}</option>}
          {noMatches && <option value="">No matches</option>}
          {orderedDepts.map((d) => (
            <optgroup key={d} label={d}>
              {grouped[d]!.map((t) => (
                <option
                  key={t.id}
                  value={t.id}
                  style={{ backgroundColor: tintFor(d) }}
                >
                  {t.displayName ?? `Staff #${t.id}`}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
    </div>
  );
}
