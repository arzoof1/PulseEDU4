// Tier 2 weekly check-in form. Renders inside a modal (or wherever the
// parent slots it) and posts to /api/tier2-entries. The parent owns
// the open/close + which student is being logged.
//
// Cadence: Tier 2 is now WEEKLY (one entry per student-teacher per
// Mon-Fri week). The teacher picks the date their meeting actually
// happened, but only this week or last week (a 14-day backfill window).
// Core Team is exempt from the date window on the server.
//
// Behavior:
//   - For a teacher, sub-type is auto-filled from the student's active
//     Tier 2 plan and locked. For Core Team it's a free choice.
//   - The "Trusted Adult Intervention" picker is filtered to entries
//     tagged tier='2' (legacy untagged entries are also shown so existing
//     catalogs remain usable).
//   - The date input is constrained to weekdays in the
//     [thisMonday - 7 days, today] window.
import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";

interface TaiRow {
  id: number;
  name: string;
  category: string;
  active: boolean;
  tier: string | null;
}

interface PlanRow {
  id: number;
  studentId: string;
  tier: number;
  interventionSubType: string | null;
  closedAt: string | null;
}

interface Props {
  schoolId: number | null;
  studentId: string;
  studentName: string;
  isCoreTeam: boolean;
  defaultDate?: string; // YYYY-MM-DD; defaults to today
  onSaved: () => void;
  onCancel: () => void;
}

function todayLocalISO(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
}

function addDaysIso(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
}

// Monday-of-the-week containing today (in local time). Used as the
// floor of the back-date window: teachers can log this week or last
// week, so the earliest valid date is mondayOfThisWeek - 7 days.
function mondayOfThisWeek(): string {
  const d = new Date();
  const dow = d.getDay(); // 0 Sun..6 Sat
  const shift = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + shift);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
}

export default function Tier2DailyForm({
  studentId,
  studentName,
  isCoreTeam,
  defaultDate,
  onSaved,
  onCancel,
}: Props) {
  const [date, setDate] = useState<string>(defaultDate ?? todayLocalISO());
  // Non-Core-Team teachers are clamped to "this week + last week"
  // (matches the server-side back-date guard). Core Team is exempt
  // server-side, so we don't constrain the picker for them either —
  // they sometimes need to repair history.
  const minDate = useMemo(
    () => (isCoreTeam ? undefined : addDaysIso(mondayOfThisWeek(), -7)),
    [isCoreTeam],
  );
  const maxDate = useMemo(
    () => (isCoreTeam ? undefined : todayLocalISO()),
    [isCoreTeam],
  );
  const [subType, setSubType] = useState<"cico" | "group">("cico");
  const [subTypeLocked, setSubTypeLocked] = useState(false);
  const [tais, setTais] = useState<TaiRow[]>([]);
  const [taiId, setTaiId] = useState<number | "">("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Pull the student's active Tier 2 plan to derive the locked
        // sub-type for non-Core-Team teachers. Core Team can override.
        // Use the teacher-friendly probe endpoint so plain teachers
        // (who can't read the full /api/mtss-plans list) still get
        // the sub-type pre-fill.
        const planRes = await authFetch(
          `/api/mtss-plans/probe/${encodeURIComponent(studentId)}`,
        );
        if (planRes.ok) {
          const data = (await planRes.json()) as {
            plan: { tier: number; interventionSubType: string | null } | null;
          };
          const p = data.plan;
          if (!cancelled && p && p.tier === 2 && p.interventionSubType) {
            const st = p.interventionSubType.toLowerCase();
            if (st === "cico" || st === "group") {
              setSubType(st);
              if (!isCoreTeam) setSubTypeLocked(true);
            }
          }
        }
      } catch {
        /* non-fatal — keep default */
      }
      try {
        const taiRes = await authFetch("/api/trusted-adult-interventions");
        if (taiRes.ok) {
          const all = (await taiRes.json()) as TaiRow[];
          if (!cancelled) setTais(all);
        }
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [studentId, isCoreTeam]);

  const taiOptions = useMemo(
    () => tais.filter((t) => t.active && (!t.tier || t.tier === "2")),
    [tais],
  );

  const submit = async () => {
    setSubmitting(true);
    setMsg(null);
    try {
      const res = await authFetch("/api/tier2-entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId,
          entryDate: date,
          subType,
          trustedAdultInterventionId: taiId === "" ? null : taiId,
          notes,
        }),
      });
      if (!res.ok) {
        throw new Error((await res.text()) || "Save failed");
      }
      onSaved();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: "0.85rem" }}>
      <div style={{ fontSize: "1.1rem", fontWeight: 600 }}>
        Tier 2 — Weekly check-in for {studentName}
      </div>
      <div style={{ fontSize: "0.8rem", color: "#64748b", marginTop: -4 }}>
        Log one check-in per week. You can back-date to last week if the
        meeting already happened.
      </div>

      <label style={{ display: "grid", gap: 4 }}>
        <span style={{ fontSize: "0.85rem", color: "#475569" }}>
          Meeting date
        </span>
        <input
          type="date"
          value={date}
          min={minDate}
          max={maxDate}
          onChange={(e) => setDate(e.target.value)}
          style={{ padding: "0.4rem 0.6rem", borderRadius: 6, border: "1px solid #cbd5e1" }}
        />
      </label>

      <fieldset
        style={{
          border: "1px solid #e2e8f0",
          padding: "0.6rem 0.75rem",
          borderRadius: 8,
          opacity: subTypeLocked ? 0.85 : 1,
        }}
      >
        <legend style={{ fontSize: "0.85rem", color: "#475569", padding: "0 0.4rem" }}>
          Intervention type{subTypeLocked && " (set by plan)"}
        </legend>
        <label style={{ marginRight: "1rem" }}>
          <input
            type="radio"
            name="subType"
            checked={subType === "cico"}
            disabled={subTypeLocked}
            onChange={() => setSubType("cico")}
          />{" "}
          CICO (Check-In / Check-Out)
        </label>
        <label>
          <input
            type="radio"
            name="subType"
            checked={subType === "group"}
            disabled={subTypeLocked}
            onChange={() => setSubType("group")}
          />{" "}
          Behavior Group
        </label>
      </fieldset>

      <label style={{ display: "grid", gap: 4 }}>
        <span style={{ fontSize: "0.85rem", color: "#475569" }}>
          Trusted Adult Intervention (optional)
        </span>
        <select
          value={taiId === "" ? "" : String(taiId)}
          onChange={(e) =>
            setTaiId(e.target.value === "" ? "" : Number(e.target.value))
          }
          style={{ padding: "0.4rem 0.6rem", borderRadius: 6, border: "1px solid #cbd5e1" }}
        >
          <option value="">— None —</option>
          {taiOptions.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.category && t.category !== "Trusted Adult"
                ? ` (${t.category})`
                : ""}
            </option>
          ))}
        </select>
      </label>

      <label style={{ display: "grid", gap: 4 }}>
        <span style={{ fontSize: "0.85rem", color: "#475569" }}>Notes</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="What did you discuss this week? Which curriculum or program (e.g. WhyTry, Zones of Regulation) did you use?"
          style={{ padding: "0.4rem 0.6rem", borderRadius: 6, border: "1px solid #cbd5e1" }}
        />
      </label>

      {msg && (
        <div
          style={{
            padding: "0.4rem 0.6rem",
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#b91c1c",
            borderRadius: 6,
            fontSize: "0.9rem",
          }}
        >
          {msg}
        </div>
      )}

      <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
        <button type="button" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          style={{
            background: "#2563eb",
            color: "white",
            padding: "0.45rem 0.9rem",
            borderRadius: 6,
            border: "none",
            cursor: "pointer",
          }}
        >
          {submitting ? "Saving…" : "Save weekly check-in"}
        </button>
      </div>
    </div>
  );
}
