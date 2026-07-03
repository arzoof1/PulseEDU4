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

type ActiveCampaign = {
  id: number;
  name: string;
  startDate: string;
  windowDays: number;
  responsiblePeriod: number;
  completionRule: string;
  attemptsRequired: number;
  daysRemaining: number;
  myProgress: {
    total: number;
    done: number;
    remaining: number;
    excluded: number;
  };
};

type ActiveResp = {
  campaigns?: ActiveCampaign[];
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

  const campaigns = data?.campaigns ?? [];
  if (!visible || campaigns.length === 0) return null;
  const total = campaigns.reduce((n, c) => n + c.myProgress.total, 0);
  if (total === 0) return null; // no owned students — nothing to nudge
  const remaining = campaigns.reduce((n, c) => n + c.myProgress.remaining, 0);
  const done = campaigns.reduce((n, c) => n + c.myProgress.done, 0);
  const daysRemaining = campaigns.reduce(
    (m, c) => Math.min(m, c.daysRemaining),
    Infinity,
  );
  const complete = remaining <= 0;
  const single = campaigns.length === 1;
  const label = complete
    ? single
      ? `${campaigns[0].name}: all ${done} calls done — thank you!`
      : `All ${done} calls done across ${campaigns.length} campaigns — thank you!`
    : single
      ? `${campaigns[0].name}: ${remaining} of ${total} families left to call`
      : `${remaining} of ${total} families left to call across ${campaigns.length} campaigns`;
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
      <span style={{ fontWeight: 700, fontSize: 16 }}>{label}</span>
      <span style={{ marginLeft: "auto", fontWeight: 600, opacity: 0.9 }}>
        {Number.isFinite(daysRemaining) ? `${daysRemaining}d left · ` : ""}Open
        worklist →
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Worklist modal — the teacher's owned roster with one-tap "Log call".
// ---------------------------------------------------------------------------
type WorklistCampaign = {
  id: number;
  name: string;
  responsiblePeriod: number;
  completionRule: string;
  attemptsRequired: number;
  students: WorklistStudent[];
};

export function CallInitiativeWorklistModal({
  onClose,
}: {
  onClose: () => void;
}) {
  const [campaigns, setCampaigns] = useState<WorklistCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [logFor, setLogFor] = useState<CommLogStudent | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    authFetch("/api/communications/call-initiatives/worklist")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { campaigns?: WorklistCampaign[] } | null) => {
        setCampaigns(j?.campaigns ?? []);
      })
      .catch(() => setCampaigns([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const multiple = campaigns.length > 1;

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
            marginBottom: "0.75rem",
          }}
        >
          <h2 style={{ margin: 0 }}>
            {multiple ? "Call worklist" : campaigns[0]?.name ?? "Call Initiative"}
          </h2>
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

        {loading ? (
          <div style={{ color: "#94a3b8" }}>Loading…</div>
        ) : campaigns.length === 0 ? (
          <div style={{ color: "#94a3b8" }}>
            No families assigned to you right now.
          </div>
        ) : (
          <div
            style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}
          >
            {campaigns.map((c) => {
              const reachable = c.students.filter((s) => s.reachable);
              const done = reachable.filter((s) => s.done).length;
              const excluded = c.students.length - reachable.length;
              return (
                <div key={c.id}>
                  {multiple && (
                    <div
                      style={{
                        fontWeight: 700,
                        color: "#1e3a8a",
                        fontSize: "1rem",
                        marginBottom: "0.25rem",
                      }}
                    >
                      {c.name}
                    </div>
                  )}
                  <div
                    style={{
                      color: "#475569",
                      fontSize: "0.9rem",
                      marginBottom: "0.6rem",
                    }}
                  >
                    {done} of {reachable.length} families contacted
                    {excluded > 0
                      ? ` · ${excluded} excluded (no reachable number)`
                      : ""}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.4rem",
                    }}
                  >
                    {c.students.map((s) => (
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
                          <div
                            style={{ fontSize: "0.75rem", color: "#94a3b8" }}
                          >
                            {s.localSisId ?? "—"}
                            {s.attempts > 0
                              ? ` · ${s.attempts} attempt${
                                  s.attempts === 1 ? "" : "s"
                                }${
                                  s.lastOutcome
                                    ? ` · last: ${s.lastOutcome}`
                                    : ""
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
                </div>
              );
            })}
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
type AdminCampaign = {
  id: number;
  name: string;
  startDate: string;
  windowDays: number;
  responsiblePeriod: number;
  completionRule: string;
  attemptsRequired: number;
  daysRemaining: number;
  createdByName: string | null;
};

type EditableScript = { title: string; body: string };

export function CallInitiativeAdminPanel() {
  const [tab, setTab] = useState<"settings" | "scripts">("settings");

  // Settings tab — active campaign list + create form.
  const [campaigns, setCampaigns] = useState<AdminCampaign[]>([]);
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
  const [confirmEndId, setConfirmEndId] = useState<number | null>(null);
  const [endingId, setEndingId] = useState<number | null>(null);

  // Scripts tab — school-level library (max 5).
  const [scripts, setScripts] = useState<EditableScript[]>([]);
  const [scriptsLoading, setScriptsLoading] = useState(true);
  const [scriptsSaving, setScriptsSaving] = useState(false);
  const [scriptsError, setScriptsError] = useState<string | null>(null);
  const [scriptsSaved, setScriptsSaved] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    authFetch("/api/communications/call-initiatives/admin")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { campaigns?: AdminCampaign[] } | null) =>
        setCampaigns(j?.campaigns ?? []),
      )
      .catch(() => setCampaigns([]))
      .finally(() => setLoading(false));
  }, []);

  const loadScripts = useCallback(() => {
    setScriptsLoading(true);
    authFetch("/api/communications/call-scripts")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { scripts?: EditableScript[] } | null) =>
        setScripts(
          (j?.scripts ?? []).map((s) => ({ title: s.title, body: s.body })),
        ),
      )
      .catch(() => setScripts([]))
      .finally(() => setScriptsLoading(false));
  }, []);

  useEffect(() => {
    load();
    loadScripts();
  }, [load, loadScripts]);

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

  async function end(id: number) {
    setEndingId(id);
    try {
      await authFetch(`/api/communications/call-initiatives/${id}/end`, {
        method: "POST",
      });
      setConfirmEndId(null);
      load();
    } finally {
      setEndingId(null);
    }
  }

  function addScript() {
    if (scripts.length >= 5) return;
    setScriptsSaved(false);
    setScripts((prev) => [...prev, { title: "", body: "" }]);
  }

  function updateScript(i: number, patch: Partial<EditableScript>) {
    setScriptsSaved(false);
    setScripts((prev) =>
      prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
    );
  }

  function removeScript(i: number) {
    setScriptsSaved(false);
    setScripts((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function saveScripts() {
    for (const s of scripts) {
      if (!s.title.trim() || !s.body.trim()) {
        setScriptsError("Every script needs a title and a body.");
        return;
      }
    }
    setScriptsSaving(true);
    setScriptsError(null);
    setScriptsSaved(false);
    try {
      const res = await authFetch("/api/communications/call-scripts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scripts: scripts.map((s) => ({
            title: s.title.trim(),
            body: s.body.trim(),
          })),
        }),
      });
      if (res.ok) {
        const j = await res.json().catch(() => null);
        setScripts(
          (j?.scripts ?? []).map((s: EditableScript) => ({
            title: s.title,
            body: s.body,
          })),
        );
        setScriptsSaved(true);
      } else {
        const j = await res.json().catch(() => null);
        setScriptsError(j?.error ?? "Could not save scripts.");
      }
    } catch {
      setScriptsError("Could not save scripts.");
    } finally {
      setScriptsSaving(false);
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
  const tabStyle = (isActive: boolean): React.CSSProperties => ({
    padding: "0.4rem 0.9rem",
    borderRadius: "0.4rem 0.4rem 0 0",
    border: "1px solid #e2e8f0",
    borderBottom: isActive ? "2px solid #2563eb" : "1px solid #e2e8f0",
    background: isActive ? "#eff6ff" : "#f8fafc",
    color: isActive ? "#1e3a8a" : "#64748b",
    fontWeight: 700,
    cursor: "pointer",
  });

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Call Initiative</h2>

      <div style={{ display: "flex", gap: "0.4rem", marginBottom: "1rem" }}>
        <button
          type="button"
          onClick={() => setTab("settings")}
          style={tabStyle(tab === "settings")}
        >
          Settings
        </button>
        <button
          type="button"
          onClick={() => setTab("scripts")}
          style={tabStyle(tab === "scripts")}
        >
          Scripts
        </button>
      </div>

      {tab === "settings" ? (
        <>
          <div
            style={{ color: "#64748b", fontSize: "0.85rem", marginBottom: "1rem" }}
          >
            Launch a "call all families" campaign. Each student is assigned to the
            teacher of their responsible period; teachers see a banner and
            worklist until every reachable family is contacted. You can run
            several campaigns at once (e.g. different periods) and end any of them
            at any time.
          </div>

          {loading ? (
            <div style={{ color: "#94a3b8" }}>Loading…</div>
          ) : (
            campaigns.length > 0 && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.6rem",
                  marginBottom: "1.25rem",
                }}
              >
                <div style={{ fontWeight: 700, color: "#0f172a" }}>
                  Active campaigns ({campaigns.length})
                </div>
                {campaigns.map((c) => (
                  <div
                    key={c.id}
                    style={{
                      border: "1px solid #bfdbfe",
                      background: "#eff6ff",
                      borderRadius: "0.5rem",
                      padding: "1rem",
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 700,
                        fontSize: "1.05rem",
                        color: "#1e3a8a",
                      }}
                    >
                      {c.name}
                    </div>
                    <div
                      style={{
                        fontSize: "0.85rem",
                        color: "#475569",
                        marginTop: "0.3rem",
                      }}
                    >
                      Started {c.startDate} · {c.windowDays}-day window ·{" "}
                      {c.daysRemaining} days left · Period {c.responsiblePeriod} ·{" "}
                      Rule: {c.completionRule}
                      {c.completionRule === "balanced"
                        ? ` (Reached or ${c.attemptsRequired} attempts)`
                        : ""}
                    </div>
                    {confirmEndId === c.id ? (
                      <div
                        style={{
                          marginTop: "0.8rem",
                          display: "flex",
                          alignItems: "center",
                          gap: "0.6rem",
                          flexWrap: "wrap",
                        }}
                      >
                        <span
                          style={{ color: "#b91c1c", fontWeight: 600, fontSize: "0.85rem" }}
                        >
                          End this campaign now? Teachers stop seeing it.
                        </span>
                        <button
                          type="button"
                          disabled={endingId === c.id}
                          onClick={() => end(c.id)}
                          style={{
                            padding: "0.4rem 0.85rem",
                            borderRadius: "0.4rem",
                            border: "none",
                            background: "#dc2626",
                            color: "#fff",
                            cursor: "pointer",
                            fontWeight: 700,
                          }}
                        >
                          {endingId === c.id ? "Ending…" : "Yes, end campaign"}
                        </button>
                        <button
                          type="button"
                          disabled={endingId === c.id}
                          onClick={() => setConfirmEndId(null)}
                          style={{
                            padding: "0.4rem 0.85rem",
                            borderRadius: "0.4rem",
                            border: "1px solid #cbd5e1",
                            background: "#fff",
                            color: "#475569",
                            cursor: "pointer",
                            fontWeight: 600,
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmEndId(c.id)}
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
                    )}
                  </div>
                ))}
              </div>
            )
          )}

          <div style={{ fontWeight: 700, color: "#0f172a", marginBottom: "0.6rem" }}>
            {campaigns.length > 0 ? "Launch another campaign" : "Launch a campaign"}
          </div>
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
        </>
      ) : (
        <>
          <div
            style={{ color: "#64748b", fontSize: "0.85rem", marginBottom: "1rem" }}
          >
            Add up to 5 call scripts. Teachers can pull these up in a drawer while
            logging a call — for example, a positive-call outline or a difficult
            conversation guide.
          </div>

          {scriptsLoading ? (
            <div style={{ color: "#94a3b8" }}>Loading…</div>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.9rem",
                maxWidth: 720,
              }}
            >
              {scripts.length === 0 && (
                <div style={{ color: "#94a3b8", fontSize: "0.85rem" }}>
                  No scripts yet. Add one to help teachers on their calls.
                </div>
              )}
              {scripts.map((s, i) => (
                <div
                  key={i}
                  style={{
                    border: "1px solid #e2e8f0",
                    borderRadius: "0.5rem",
                    padding: "0.9rem",
                    background: "#f8fafc",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.6rem",
                      marginBottom: "0.5rem",
                    }}
                  >
                    <input
                      type="text"
                      value={s.title}
                      onChange={(e) => updateScript(i, { title: e.target.value })}
                      placeholder="Script title (e.g. Positive call home)"
                      style={{ ...inputStyle, fontWeight: 700 }}
                    />
                    <button
                      type="button"
                      onClick={() => removeScript(i)}
                      style={{
                        padding: "0.4rem 0.7rem",
                        borderRadius: "0.4rem",
                        border: "1px solid #fca5a5",
                        background: "#fff",
                        color: "#dc2626",
                        cursor: "pointer",
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                      }}
                    >
                      Delete
                    </button>
                  </div>
                  <textarea
                    value={s.body}
                    onChange={(e) => updateScript(i, { body: e.target.value })}
                    rows={4}
                    placeholder="Script body — what the teacher should say / cover…"
                    style={{ ...inputStyle, resize: "vertical" }}
                  />
                </div>
              ))}

              <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                <button
                  type="button"
                  onClick={addScript}
                  disabled={scripts.length >= 5}
                  style={{
                    padding: "0.5rem 1rem",
                    borderRadius: "0.4rem",
                    border: "1px dashed #2563eb",
                    background: "#fff",
                    color: scripts.length >= 5 ? "#94a3b8" : "#2563eb",
                    cursor: scripts.length >= 5 ? "not-allowed" : "pointer",
                    fontWeight: 700,
                  }}
                >
                  + Add script{scripts.length >= 5 ? " (max 5)" : ""}
                </button>
                <button
                  type="button"
                  onClick={saveScripts}
                  disabled={scriptsSaving}
                  style={{
                    padding: "0.5rem 1.1rem",
                    borderRadius: "0.4rem",
                    border: "none",
                    background: "#2563eb",
                    color: "#fff",
                    cursor: "pointer",
                    fontWeight: 700,
                  }}
                >
                  {scriptsSaving ? "Saving…" : "Save scripts"}
                </button>
                {scriptsSaved && (
                  <span style={{ color: "#16a34a", fontWeight: 600, fontSize: "0.85rem" }}>
                    Saved ✓
                  </span>
                )}
              </div>
              {scriptsError && (
                <div style={{ color: "#b91c1c", fontSize: "0.85rem" }}>
                  {scriptsError}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
