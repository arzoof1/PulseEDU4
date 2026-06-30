// Shared cross-dashboard filter bar for the 5 insights views
// (Academics, Behavior, Engagement, Equity, SEB/SEL).
//
// Renders:
//   - Teacher dropdown   — admins / core team see all teachers; plain
//                          teachers see just themselves (the API
//                          handles the gate).
//   - Period chip row    — only when a teacher is selected; lists the
//                          periods that teacher actually teaches.
//   - Flag toggles       — ESE, 504, Tier 2/3, BQ ELA, BQ Math.
//   - Clear all          — only enabled when at least one filter is set.
//
// State is owned by the parent dashboard (controlled component). The
// dashboard composes the resulting query string and re-fetches.

import { useEffect, useState } from "react";
import { TeacherPicker } from "./TeacherPicker";
import { authFetch } from "../lib/authToken";

export type InsightsFilterValue = {
  teacherId: number | null;
  period: number | null;
  ese: boolean;
  is504: boolean;
  tier: 2 | 3 | null;
  bqEla: boolean;
  bqMath: boolean;
};

export const EMPTY_FILTERS: InsightsFilterValue = {
  teacherId: null,
  period: null,
  ese: false,
  is504: false,
  tier: null,
  bqEla: false,
  bqMath: false,
};

export function hasAnyFilter(f: InsightsFilterValue): boolean {
  return (
    f.teacherId != null ||
    f.ese ||
    f.is504 ||
    f.tier != null ||
    f.bqEla ||
    f.bqMath
  );
}

// Serialize for URL params. Skips falsy / null values so the URL stays
// tidy when the bar is at defaults.
export function filtersToQuery(f: InsightsFilterValue): URLSearchParams {
  const qs = new URLSearchParams();
  if (f.teacherId != null) qs.set("teacher_id", String(f.teacherId));
  if (f.period != null) qs.set("period", String(f.period));
  if (f.ese) qs.set("ese", "1");
  if (f.is504) qs.set("is_504", "1");
  if (f.tier != null) qs.set("tier", String(f.tier));
  if (f.bqEla) qs.set("bq_ela", "1");
  if (f.bqMath) qs.set("bq_math", "1");
  return qs;
}

interface Teacher {
  id: number;
  displayName: string;
}

interface Props {
  value: InsightsFilterValue;
  onChange: (next: InsightsFilterValue) => void;
}

export default function InsightsFilterBar({ value, onChange }: Props) {
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [periods, setPeriods] = useState<number[]>([]);
  const [teachersLoading, setTeachersLoading] = useState(true);

  // Load teacher list once. Plain teachers get back just themselves
  // (1 row), admins get all teachers in the school.
  useEffect(() => {
    let cancelled = false;
    setTeachersLoading(true);
    authFetch("/api/teacher-roster/teachers")
      .then(async (r) => {
        if (!r.ok) return;
        const json = (await r.json()) as { teachers: Teacher[] };
        if (!cancelled) setTeachers(json.teachers ?? []);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setTeachersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // When teacher changes, fetch the periods that teacher actually
  // teaches so the period chip row only shows real options. We piggy-
  // back on /api/teacher-roster?teacher_id=N which returns the same
  // section list the roster page uses.
  useEffect(() => {
    if (value.teacherId == null) {
      setPeriods([]);
      return;
    }
    let cancelled = false;
    const qs = new URLSearchParams({ teacher_id: String(value.teacherId) });
    authFetch(`/api/teacher-roster?${qs.toString()}`)
      .then(async (r) => {
        if (!r.ok) return;
        const json = (await r.json()) as {
          sections?: { period: number }[];
        };
        if (cancelled) return;
        const set = new Set<number>();
        for (const s of json.sections ?? []) {
          if (typeof s.period === "number") set.add(s.period);
        }
        setPeriods([...set].sort((a, b) => a - b));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [value.teacherId]);

  const showTeacherPicker = teachers.length > 1;

  function update(patch: Partial<InsightsFilterValue>) {
    onChange({ ...value, ...patch });
  }

  function clearAll() {
    onChange(EMPTY_FILTERS);
  }

  const dirty = hasAnyFilter(value);

  return (
    <div style={containerStyle}>
      <div style={rowStyle}>
        {/* Teacher picker — only when there's more than one option. */}
        {showTeacherPicker && (
          <label style={labelStyle}>
            <span style={labelTextStyle}>Teacher</span>
            <TeacherPicker
              teachers={teachers}
              value={value.teacherId ?? null}
              allowEmpty
              emptyLabel="School-wide"
              disabled={teachersLoading}
              ariaLabel="Teacher"
              selectStyle={selectStyle}
              onChange={(next) => {
                // Clearing the teacher also clears the period.
                update({ teacherId: next, period: null });
              }}
            />
          </label>
        )}

        {/* Period chip row — only when a teacher is selected and they
            have at least one period. */}
        {value.teacherId != null && periods.length > 0 && (
          <div style={chipRowStyle} aria-label="Period">
            <span style={labelTextStyle}>Period</span>
            <button
              type="button"
              onClick={() => update({ period: null })}
              style={chipStyle(value.period == null)}
            >
              All
            </button>
            {periods.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => update({ period: p })}
                style={chipStyle(value.period === p)}
              >
                {p}
              </button>
            ))}
          </div>
        )}

        {/* Flag toggles. */}
        <div style={chipRowStyle} aria-label="Flags">
          <FlagChip
            label="ESE"
            active={value.ese}
            onClick={() => update({ ese: !value.ese })}
          />
          <FlagChip
            label="504"
            active={value.is504}
            onClick={() => update({ is504: !value.is504 })}
          />
          <FlagChip
            label="Tier 2+"
            active={value.tier === 2}
            onClick={() =>
              update({ tier: value.tier === 2 ? null : 2 })
            }
          />
          <FlagChip
            label="Tier 3"
            active={value.tier === 3}
            onClick={() =>
              update({ tier: value.tier === 3 ? null : 3 })
            }
          />
          <FlagChip
            label="BQ ELA"
            active={value.bqEla}
            onClick={() => update({ bqEla: !value.bqEla })}
          />
          <FlagChip
            label="BQ Math"
            active={value.bqMath}
            onClick={() => update({ bqMath: !value.bqMath })}
          />
        </div>

        {/* Clear all — disabled when nothing is set so the affordance
            isn't clickable noise. */}
        <button
          type="button"
          onClick={clearAll}
          disabled={!dirty}
          style={clearStyle(dirty)}
        >
          Clear all filters
        </button>
      </div>
    </div>
  );
}

function FlagChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={chipStyle(active)}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------
// Styles — kept inline to match the prevailing pattern in the
// dashboards (the project doesn't use a CSS-in-JS lib here).
// ---------------------------------------------------------------------

const containerStyle: React.CSSProperties = {
  marginTop: "0.75rem",
  marginBottom: "0.75rem",
  padding: "0.65rem 0.75rem",
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--surface-subtle, rgba(255,255,255,0.02))",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "0.75rem",
};

const labelStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.4rem",
};

const labelTextStyle: React.CSSProperties = {
  fontSize: "0.8rem",
  fontWeight: 600,
  color: "var(--text-subtle)",
};

const selectStyle: React.CSSProperties = {
  padding: "0.35rem 0.5rem",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: "0.85rem",
  minWidth: 180,
};

const chipRowStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.35rem",
  flexWrap: "wrap",
};

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: "0.3rem 0.65rem",
    borderRadius: 999,
    border: active
      ? "1px solid #2563eb"
      : "1px solid var(--border)",
    background: active ? "#2563eb" : "transparent",
    color: active ? "white" : "var(--text)",
    fontSize: "0.8rem",
    fontWeight: 600,
    cursor: "pointer",
    lineHeight: 1.2,
  };
}

function clearStyle(enabled: boolean): React.CSSProperties {
  return {
    marginLeft: "auto",
    padding: "0.35rem 0.7rem",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "transparent",
    color: enabled ? "var(--text)" : "var(--text-subtle)",
    fontSize: "0.8rem",
    cursor: enabled ? "pointer" : "default",
    opacity: enabled ? 1 : 0.55,
  };
}
