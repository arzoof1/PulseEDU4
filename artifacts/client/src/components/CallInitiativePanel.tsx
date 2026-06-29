import React, { useCallback, useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";
import {
  CommunicationLogModal,
  type CommLogStudent,
} from "./PbisPointsHub";

// Call Initiative — a "call all families" campaign created by Core Team.
// Each student is owned by their responsible-period teacher. This file holds:
//   - CallInitiativeBanner: app-wide per-teacher progress nudge -> worklist.
//   - CallInitiativeWorklistModal: the teacher's roster + one-tap log.
//   - CallInitiativeAdminPanel: Core Team create / end a campaign.

type ActiveResp = {
  initiative: {
    id: number;
    name: string;
    startDate: string;
    windowDays: number;
    responsiblePeriod: number;
    completionRule: string;
    attemptsRequired: number;
    daysRemaining: number;
  } | null;
  myProgress?: {
    total: number;
    done: number;
    remaining: number;
    excluded: number;
  };
};

type WorklistStudent = {
  studentId: string;
  name: string;
  localSisId: string | null;
  attempts: number;
  reached: boolean;
  done: boolean;
  reachable: boolean;
  lastOutcome: string | null;
  lastContactedAt: string | null;
};

// ---------------------------------------------------------------------------
// Banner — surfaces the signed-in teacher's remaining calls. Polls so it
// disappears as they work the list.
// ---------------------------------------------------------------------------
export function CallInitiativeBanner({
  visible,
  onOpen,
}: {
  visible: boolean;
  onOpen: () => void;
}) {
  const [data, setData] = useState<ActiveResp | null>(null);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const fetch = () => {
      authFetch("/api/communications/call-initiatives/active")
        .then((r) => (r.ok ? r.json() : null))
        .then((j: ActiveResp | null) => {
          if (!cancelled) setData(j);
        })
        .catch(() => {});
    };
    fetch();
    const t = window.setInterval(fetch, 60000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [visible]);

  if (!visible || !data?.initiative || !data.myProgress) return null;
  const { remaining, total, done } = data.myProgress;
  if (total === 0) return null; // no owned students — nothing to nudge
  const complete = remaining <= 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        width: "100%",
        border: "none",
        cursor: "pointer",
        textAlign: "left",
        background: complete
          ? "linear-gradient(90deg, #16a34a 0%, #15803d 100%)"
          : "linear-gradient(90deg, #2563eb 0%, #1d4ed8 100%)",
        color: "#fff",
        padding: "12px 18px",
        borderRadius: 12,
        marginBottom: 14,
        display: "flex",
        alignItems: "center",
        gap: 12,
        boxShadow: "0 4px 14px rgba(37,99,235,0.3)",
      }}
    >
      <span style={{ fontSize: 24 }}>☎️</span>
      <span style={{ fontWeight: 700, fontSize: 16 }}>
        {complete
          ? `${data.initiative.name}: all ${done} calls done — thank you!`
          : `${data.initiative.name}: ${remaining} of ${total} families left to call`}
      </span>
      <span style={{ marginLeft: "auto", fontWeight: 600, opacity: 0.9 }}>
        {data.initiative.daysRemaining}d left · Open worklist →
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Worklist modal — the teacher's owned roster with one-tap "Log call".
// ---------------------------------------------------------------------------
export function CallInitiativeWorklistModal({
  onClose,
}: {
  onClose: () => void;
}) {
  const [students, setStudents] = useState<WorklistStudent[]>([]);
  const [initiativeName, setInitiativeName] = useState("");
  const [loading, setLoading] = useState(true);
  const [logFor, setLogFor] = useState<CommLogStudent | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    authFetch("/api/communications/call-initiatives/worklist")
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (j: { initiative: { name: string } | null; students?: WorklistStudent[] } | null) => {
          setStudents(j?.students ?? []);
          setInitiativeName(j?.initiative?.name ?? "Call Initiative");
        },
      )
      .catch(() => setStudents([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const reachable = students.filter((s) => s.reachable);
  const done = reachable.filter((s) => s.done).length;
  const excluded = students.length - reachable.length;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.55)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "3vh 1rem",
        zIndex: 1000,
        overflowY: "auto",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          borderRadius: "0.75rem",
          width: "min(720px, 100%)",
          maxHeight: "94vh",
          overflowY: "auto",
          padding: "1.25rem 1.5rem",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "0.5rem",
          }}
        >
          <h2 style={{ margin: 0 }}>{initiativeName}</h2>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: "none",
              background: "none",
              fontSize: "1.4rem",
              cursor: "pointer",
              color: "#64748b",
            }}
          >
            ×
          </button>
        </div>
        <div
          style={{
            color: "#475569",
            fontSize: "0.9rem",
            marginBottom: "1rem",
          }}
        >
          {done} of {reachable.length} families contacted
          {excluded > 0 ? ` · ${excluded} excluded (no reachable number)` : ""}
        </div>

        {loading ? (
          <div style={{ color: "#94a3b8" }}>Loading…</div>
        ) : students.length === 0 ? (
          <div style={{ color: "#94a3b8" }}>
            No families assigned to you for this campaign.
          </div>
        ) : (
          <div
            style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}
          >
            {students.map((s) => (
              <div
                key={s.studentId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.6rem",
                  padding: "0.55rem 0.7rem",
                  borderRadius: "0.5rem",
                  border: "1px solid #e2e8f0",
                  background: !s.reachable
                    ? "#f8fafc"
                    : s.done
                      ? "#f0fdf4"
                      : "#fff",
                  opacity: s.reachable ? 1 : 0.7,
                }}
              >
                <span style={{ fontSize: "1.1rem" }}>
                  {!s.reachable ? "🚫" : s.done ? "✅" : "⬜"}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, color: "#0f172a" }}>
                    {s.name}
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>
                    {s.localSisId ?? "—"}
                    {s.attempts > 0
                      ? ` · ${s.attempts} attempt${s.attempts === 1 ? "" : "s"}${
                          s.lastOutcome ? ` · last: ${s.lastOutcome}` : ""
                        }`
                      : ""}
                    {!s.reachable ? " · no reachable number" : ""}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={!s.reachable}
                  onClick={() =>
                    setLogFor({
                      id: 0,
                      studentId: s.studentId,
                      firstName: s.name.split(", ")[1] ?? s.name,
                      lastName: s.name.split(", ")[0] ?? "",
                    })
                  }
                  style={{
                    padding: "0.35rem 0.7rem",
                    borderRadius: "0.4rem",
                    border: "none",
                    background: s.reachable ? "#2563eb" : "#cbd5e1",
                    color: "#fff",
                    cursor: s.reachable ? "pointer" : "not-allowed",
                    fontWeight: 600,
                    fontSize: "0.8rem",
                  }}
                >
                  {s.done ? "Log again" : "Log call"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {logFor && (
        <CommunicationLogModal
          student={logFor}
          onClose={() => setLogFor(null)}
          onSaved={() => {
            setLogFor(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin panel — Core Team create / end a campaign.
// ---------------------------------------------------------------------------
export function CallInitiativeAdminPanel() {
  const [active, setActive] = useState<ActiveResp["initiative"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  });
  const [windowDays, setWindowDays] = useState(14);
  const [responsiblePeriod, setResponsiblePeriod] = useState(1);
  const [completionRule, setCompletionRule] = useState("balanced");
  const [attemptsRequired, setAttemptsRequired] = useState(2);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    authFetch("/api/communications/call-initiatives/active")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: ActiveResp | null) => setActive(j?.initiative ?? null))
      .catch(() => setActive(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    if (!name.trim()) {
      setError("Give the campaign a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await authFetch("/api/communications/call-initiatives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          startDate,
          windowDays,
          responsiblePeriod,
          completionRule,
          attemptsRequired,
        }),
      });
      if (res.ok) {
        setName("");
        load();
      } else {
        const j = await res.json().catch(() => null);
        setError(j?.error ?? "Could not create campaign.");
      }
    } catch {
      setError("Could not create campaign.");
    } finally {
      setSaving(false);
    }
  }

  async function end() {
    if (!active) return;
    setSaving(true);
    try {
      await authFetch(`/api/communications/call-initiatives/${active.id}/end`, {
        method: "POST",
      });
      load();
    } finally {
      setSaving(false);
    }
  }

  const labelStyle: React.CSSProperties = {
    fontSize: "0.8rem",
    fontWeight: 600,
    color: "#334155",
    display: "block",
    marginBottom: "0.25rem",
  };
  const inputStyle: React.CSSProperties = {
    padding: "0.45rem 0.6rem",
    borderRadius: "0.4rem",
    border: "1px solid #cbd5e1",
    width: "100%",
  };

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Call Initiative</h2>
      <div style={{ color: "#64748b", fontSize: "0.85rem", marginBottom: "1rem" }}>
        Launch a "call all families" campaign. Each student is assigned to the
        teacher of their responsible period; teachers see a banner and worklist
        until every reachable family is contacted.
      </div>

      {loading ? (
        <div style={{ color: "#94a3b8" }}>Loading…</div>
      ) : active ? (
        <div
          style={{
            border: "1px solid #bfdbfe",
            background: "#eff6ff",
            borderRadius: "0.5rem",
            padding: "1rem",
          }}
        >
          <div style={{ fontWeight: 700, fontSize: "1.05rem", color: "#1e3a8a" }}>
            {active.name}
          </div>
          <div style={{ fontSize: "0.85rem", color: "#475569", marginTop: "0.3rem" }}>
            Started {active.startDate} · {active.windowDays}-day window ·{" "}
            {active.daysRemaining} days left · Period {active.responsiblePeriod} ·{" "}
            Rule: {active.completionRule}
            {active.completionRule === "balanced"
              ? ` (Reached or ${active.attemptsRequired} attempts)`
              : ""}
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={end}
            style={{
              marginTop: "0.8rem",
              padding: "0.45rem 0.9rem",
              borderRadius: "0.4rem",
              border: "1px solid #dc2626",
              background: "#fff",
              color: "#dc2626",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            End campaign
          </button>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: "0.8rem",
            maxWidth: 720,
          }}
        >
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={labelStyle}>Campaign name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Q1 Positive Calls Home"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Start date</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Window (days)</label>
            <input
              type="number"
              min={1}
              max={120}
              value={windowDays}
              onChange={(e) => setWindowDays(Number(e.target.value))}
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Responsible period</label>
            <input
              type="number"
              min={1}
              max={12}
              value={responsiblePeriod}
              onChange={(e) => setResponsiblePeriod(Number(e.target.value))}
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Completion rule</label>
            <select
              value={completionRule}
              onChange={(e) => setCompletionRule(e.target.value)}
              style={inputStyle}
            >
              <option value="balanced">Balanced (Reached or N attempts)</option>
              <option value="strict">Strict (must reach)</option>
              <option value="any">Any logged contact</option>
            </select>
          </div>
          {completionRule === "balanced" && (
            <div>
              <label style={labelStyle}>Attempts required (N)</label>
              <input
                type="number"
                min={1}
                max={10}
                value={attemptsRequired}
                onChange={(e) => setAttemptsRequired(Number(e.target.value))}
                style={inputStyle}
              />
            </div>
          )}
          <div style={{ gridColumn: "1 / -1" }}>
            {error && (
              <div
                style={{
                  color: "#b91c1c",
                  fontSize: "0.85rem",
                  marginBottom: "0.5rem",
                }}
              >
                {error}
              </div>
            )}
            <button
              type="button"
              disabled={saving}
              onClick={create}
              style={{
                padding: "0.55rem 1.1rem",
                borderRadius: "0.4rem",
                border: "none",
                background: "#2563eb",
                color: "#fff",
                cursor: "pointer",
                fontWeight: 700,
              }}
            >
              {saving ? "Launching…" : "Launch campaign"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
