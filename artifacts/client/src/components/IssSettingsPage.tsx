import { useEffect, useState, type CSSProperties } from "react";
import { authFetch } from "../lib/authToken";
import DisciplineReasonsAdmin from "./DisciplineReasonsAdmin";
import SchoolClosedDaysAdmin from "./SchoolClosedDaysAdmin";

interface SchoolSettings {
  issDailyCapacity: number | null;
  issCapacityBehavior: "soft" | "hard";
}

const card: CSSProperties = {
  padding: "1rem 1.1rem",
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: 10,
  background: "var(--surface, #fff)",
  marginBottom: "1rem",
};

const label: CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-subtle)",
  marginBottom: 4,
  textTransform: "uppercase",
  letterSpacing: 0.5,
};

export default function IssSettingsPage() {
  const [cap, setCap] = useState<number | "">("");
  const [behavior, setBehavior] = useState<"soft" | "hard">("soft");
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await authFetch("/api/school-settings");
      if (r.ok) {
        const d = (await r.json()) as Partial<SchoolSettings>;
        setCap(d.issDailyCapacity ?? "");
        setBehavior(d.issCapacityBehavior ?? "soft");
      }
    })();
  }, []);

  const save = async () => {
    setErr(null);
    setSaved(false);
    const body: Record<string, unknown> = {
      issDailyCapacity: cap === "" ? null : Number(cap),
      issCapacityBehavior: behavior,
    };
    const r = await authFetch("/api/school-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      setErr(await r.text());
      return;
    }
    setSaved(true);
  };

  return (
    <div>
      <h1 style={{ marginTop: 0 }}>ISS Settings</h1>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        Set the daily ISS seat capacity and the calendar of school-closed
        days (used to skip rollover and grey out the calendar). Manage the
        list of discipline reasons that show up in the Add ISS / OSS Log
        modal.
      </p>

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>Daily ISS capacity</h3>
        <div style={{ display: "grid", gap: "0.85rem", maxWidth: 380 }}>
          <div>
            <span style={label}>Capacity per day (blank = no limit)</span>
            <input
              type="number"
              min={0}
              value={cap}
              onChange={(e) =>
                setCap(e.target.value === "" ? "" : Number(e.target.value))
              }
              style={{
                width: 120,
                padding: "0.4rem 0.5rem",
                border: "1px solid #cbd5e1",
                borderRadius: 6,
                font: "inherit",
              }}
            />
          </div>
          <div>
            <span style={label}>Behavior at capacity</span>
            <div style={{ display: "flex", gap: 12 }}>
              {(["soft", "hard"] as const).map((b) => (
                <label
                  key={b}
                  style={{ display: "flex", gap: 6, alignItems: "center" }}
                >
                  <input
                    type="radio"
                    checked={behavior === b}
                    onChange={() => setBehavior(b)}
                  />
                  <span>
                    {b === "soft"
                      ? "Soft — warn but allow override"
                      : "Hard — block when full"}
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div>
            <button
              type="button"
              onClick={() => void save()}
              style={{
                background: "#1d4ed8",
                color: "white",
                border: "none",
                borderRadius: 6,
                padding: "0.5rem 1rem",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Save
            </button>
            {saved && (
              <span style={{ marginLeft: 10, color: "#15803d", fontSize: 13 }}>
                ✓ Saved
              </span>
            )}
            {err && (
              <span style={{ marginLeft: 10, color: "#b91c1c", fontSize: 13 }}>
                {err}
              </span>
            )}
          </div>
        </div>
      </div>

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>School-closed days</h3>
        <SchoolClosedDaysAdmin />
      </div>

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>Discipline reasons</h3>
        <DisciplineReasonsAdmin />
      </div>
    </div>
  );
}
