import { useEffect, useRef, useState } from "react";
import { authFetch } from "../lib/authToken";

// School badge for the top bar.
//
// For everyone: shows the active school as a pill ("Parrott").
// For SuperUsers: clicking the pill opens a list of schools to switch into.
// On a successful switch we hard-reload the page so every cached read
// (students, hall passes, tardies, PBIS, dashboards) refetches against the
// new school. We avoid in-process invalidation because the app uses many
// useState-backed lists that are loaded ad-hoc.
//
// "Acting as <school>" + an Exit button appears when SuperUsers have
// switched away from their home school. This is the recovery path so they
// never get stuck looking at someone else's data.

type School = {
  id: number;
  districtId: number;
  name: string;
  shortName: string | null;
  stateSchoolCode: string | null;
  isPrimary: boolean;
};

type Status = {
  homeSchoolId: number;
  activeSchoolId: number;
  isSwitched: boolean;
  canSwitch: boolean;
  schools: School[];
};

export function SchoolSwitcher() {
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    authFetch("/api/tenancy/schools")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Status | null) => {
        if (!cancelled) setStatus(data);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Close the popover on outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!popRef.current) return;
      if (!popRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  if (!status) return null;

  const active = status.schools.find((s) => s.id === status.activeSchoolId);
  const label = active?.shortName || active?.name || `School #${status.activeSchoolId}`;

  const switchTo = async (schoolId: number | null) => {
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch("/api/tenancy/switch-school", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schoolId }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? `Switch failed (HTTP ${res.status})`);
        setBusy(false);
        return;
      }
      // Hard reload so every screen refetches scoped data against the new
      // school. Cheaper than threading a query-key through every list.
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Switch failed");
      setBusy(false);
    }
  };

  const pillStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "0.25rem 0.6rem",
    borderRadius: 999,
    border: status.isSwitched
      ? "1px solid #e0a800"
      : "1px solid var(--border)",
    background: status.isSwitched ? "#fff8d8" : "transparent",
    color: status.isSwitched ? "#5a4500" : "inherit",
    fontSize: "0.85rem",
    cursor: status.canSwitch ? "pointer" : "default",
    whiteSpace: "nowrap",
  };

  return (
    <div style={{ position: "relative" }} ref={popRef}>
      <button
        type="button"
        title={
          status.isSwitched
            ? `Acting as ${active?.name ?? "another school"} — click to switch back`
            : (active?.name ?? "Active school")
        }
        onClick={() => status.canSwitch && setOpen((o) => !o)}
        disabled={busy}
        style={{ ...pillStyle, marginRight: 8 }}
      >
        <span aria-hidden style={{ fontSize: "0.7rem" }}>
          {status.isSwitched ? "⚠" : "🏫"}
        </span>
        <span>{label}</span>
        {status.canSwitch && (
          <span aria-hidden style={{ opacity: 0.6 }}>▾</span>
        )}
      </button>

      {status.isSwitched && (
        <button
          type="button"
          onClick={() => switchTo(null)}
          disabled={busy}
          style={{
            ...pillStyle,
            border: "1px solid #b08a00",
            background: "#fff",
            marginRight: 8,
          }}
          title="Return to your home school"
        >
          Exit switch
        </button>
      )}

      {open && status.canSwitch && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            minWidth: 260,
            background: "#fff",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            padding: 6,
            zIndex: 50,
          }}
        >
          <div
            style={{
              padding: "6px 8px",
              fontSize: "0.75rem",
              color: "#666",
              borderBottom: "1px solid var(--border)",
              marginBottom: 4,
            }}
          >
            Switch active school
          </div>
          {status.schools.map((s) => {
            const isActive = s.id === status.activeSchoolId;
            const isHome = s.id === status.homeSchoolId;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => switchTo(s.id === status.homeSchoolId ? null : s.id)}
                disabled={busy || isActive}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "0.4rem 0.6rem",
                  background: isActive ? "#e8f5ff" : "transparent",
                  border: "none",
                  borderRadius: 4,
                  cursor: isActive ? "default" : "pointer",
                  fontSize: "0.85rem",
                  color: "inherit",
                }}
              >
                <span style={{ fontWeight: isActive ? 600 : 400 }}>
                  {s.name}
                </span>
                {s.stateSchoolCode && (
                  <span style={{ marginLeft: 6, color: "#888", fontSize: "0.75rem" }}>
                    #{s.stateSchoolCode}
                  </span>
                )}
                {isHome && (
                  <span style={{ marginLeft: 6, color: "#0a7", fontSize: "0.7rem" }}>
                    HOME
                  </span>
                )}
              </button>
            );
          })}
          {error && (
            <div style={{ padding: "6px 8px", color: "#c00", fontSize: "0.75rem" }}>
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default SchoolSwitcher;
