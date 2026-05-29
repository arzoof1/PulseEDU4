import { useCallback, useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";

// =============================================================================
// TourAdminPage — staff-facing School Tours pipeline + brag-page editor.
//
// Three tabs:
//   Pipeline   — Kanban-style board (New→Contacted→Scheduled→Toured→Closed)
//                with a lead detail drawer (timeline, assign, schedule,
//                log contact/note, outcome, PDF leave-behinds).
//   Brag Page  — the public page editor + publish toggle + public URL.
//   Report     — outcome → enrollment conversion rollup.
//
// Gated server-side by canManageTours; this component assumes the caller is
// already authorized (App only renders it for settings-capable staff).
// =============================================================================

type Child = { name: string; grade: string };
type Status = "new" | "contacted" | "scheduled" | "toured" | "closed";
type Outcome = "enrolled" | "deciding" | "chose_other";

type Lead = {
  id: number;
  familyName: string;
  phone: string;
  email: string | null;
  children: Child[];
  interests: string;
  source: string | null;
  preferredLanguage: string;
  status: Status;
  outcome: Outcome | null;
  outcomeReason: string | null;
  assignedStaffId: number | null;
  assignedTo: string | null;
  tourScheduledAt: string | null;
  firstContactedAt: string | null;
  surveySubmittedAt: string | null;
  createdAt: string;
  responseMs: number;
  overdue: boolean;
};

type TimelineEvent = {
  id: number;
  eventType: string;
  channel: string | null;
  body: string;
  staffName: string | null;
  createdAt: string;
};

type Survey = {
  rating: number | null;
  liked: string;
  questions: string;
  comments: string;
  createdAt: string;
};

type LeadDetail = {
  lead: Lead & { surveyUrl: string };
  events: TimelineEvent[];
  survey: Survey | null;
};

const STATUS_ORDER: Status[] = [
  "new",
  "contacted",
  "scheduled",
  "toured",
  "closed",
];
const STATUS_LABEL: Record<Status, string> = {
  new: "New",
  contacted: "Contacted",
  scheduled: "Scheduled",
  toured: "Toured",
  closed: "Closed",
};
const STATUS_COLOR: Record<Status, string> = {
  new: "#dc2626",
  contacted: "#d97706",
  scheduled: "#2563eb",
  toured: "#7c3aed",
  closed: "#059669",
};
const OUTCOME_LABEL: Record<Outcome, string> = {
  enrolled: "Enrolled 🎉",
  deciding: "Still deciding",
  chose_other: "Chose elsewhere",
};

function fmtDuration(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
// Format a stored ISO instant as a local wall-clock value for a
// datetime-local input (YYYY-MM-DDTHH:mm). Using toISOString() here would
// show the UTC time instead of the school's local time.
function toLocalDatetimeInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

const cardBox: React.CSSProperties = {
  background: "var(--card-bg, #fff)",
  border: "1px solid var(--border, #e2e8f0)",
  borderRadius: 12,
  padding: 16,
};
const btn = (bg: string): React.CSSProperties => ({
  padding: "8px 14px",
  borderRadius: 8,
  border: "none",
  background: bg,
  color: "#fff",
  fontWeight: 600,
  cursor: "pointer",
  fontSize: 14,
});
const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 11px",
  borderRadius: 8,
  border: "1px solid var(--border, #cbd5e1)",
  fontSize: 14,
  boxSizing: "border-box",
  background: "var(--input-bg, #fff)",
  color: "inherit",
};

export default function TourAdminPage() {
  const [tab, setTab] = useState<"pipeline" | "page" | "report">("pipeline");
  return (
    <div style={{ padding: "0 4px" }}>
      <div
        style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}
      >
        {(
          [
            ["pipeline", "📋 Lead Pipeline"],
            ["page", "✨ Brag Page"],
            ["report", "📊 Outcomes"],
          ] as const
        ).map(([k, lbl]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            style={{
              padding: "9px 16px",
              borderRadius: 9,
              border: "1px solid var(--border, #e2e8f0)",
              background: tab === k ? "var(--accent, #2563eb)" : "transparent",
              color: tab === k ? "#fff" : "inherit",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {lbl}
          </button>
        ))}
      </div>
      {tab === "pipeline" && <Pipeline />}
      {tab === "page" && <BragEditor />}
      {tab === "report" && <Report />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// New-lead alert banner — app-wide, polls the unworked-new count and links
// straight to the pipeline. Rendered only for tour-notify staff.
// ---------------------------------------------------------------------------
export function TourLeadBanner({
  visible,
  onOpen,
}: {
  visible: boolean;
  onOpen: () => void;
}) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const fetchCount = async () => {
      try {
        const res = await authFetch("/api/tours/requests/new-count");
        if (!res.ok) return;
        const json = (await res.json()) as { count?: number };
        if (!cancelled) setCount(json.count ?? 0);
      } catch {
        /* silent — banner just stays hidden */
      }
    };
    void fetchCount();
    const t = window.setInterval(() => void fetchCount(), 60000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [visible]);

  if (!visible || count <= 0) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        width: "100%",
        border: "none",
        cursor: "pointer",
        textAlign: "left",
        background: "linear-gradient(90deg, #dc2626 0%, #ea580c 100%)",
        color: "#fff",
        padding: "12px 18px",
        borderRadius: 12,
        marginBottom: 14,
        display: "flex",
        alignItems: "center",
        gap: 12,
        boxShadow: "0 4px 14px rgba(220,38,38,0.3)",
      }}
    >
      <span style={{ fontSize: 24 }}>🔔</span>
      <span style={{ fontWeight: 700, fontSize: 16 }}>
        {count} new tour {count === 1 ? "request" : "requests"} waiting
      </span>
      <span style={{ marginLeft: "auto", fontWeight: 600, opacity: 0.9 }}>
        Open pipeline →
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Pipeline board + detail drawer
// ---------------------------------------------------------------------------
function Pipeline() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch("/api/tours/requests");
      if (res.ok) setLeads((await res.json()) as Lead[]);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const byStatus = useMemo(() => {
    const m: Record<Status, Lead[]> = {
      new: [],
      contacted: [],
      scheduled: [],
      toured: [],
      closed: [],
    };
    for (const l of leads) m[l.status]?.push(l);
    return m;
  }, [leads]);

  if (loading) return <div style={{ color: "#64748b" }}>Loading leads…</div>;

  if (leads.length === 0) {
    return (
      <div style={{ ...cardBox, textAlign: "center", padding: 40 }}>
        <div style={{ fontSize: 40 }}>🗒️</div>
        <h3 style={{ margin: "12px 0 6px" }}>No tour requests yet</h3>
        <p style={{ color: "#64748b", margin: 0 }}>
          Publish your Brag Page and share the link — new leads land here
          automatically.
        </p>
      </div>
    );
  }

  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 12,
          alignItems: "start",
        }}
      >
        {STATUS_ORDER.map((s) => (
          <div key={s}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 8,
                fontWeight: 700,
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  background: STATUS_COLOR[s],
                }}
              />
              {STATUS_LABEL[s]}
              <span style={{ color: "#94a3b8", fontWeight: 500 }}>
                {byStatus[s].length}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {byStatus[s].map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setOpenId(l.id)}
                  style={{
                    ...cardBox,
                    padding: 12,
                    textAlign: "left",
                    cursor: "pointer",
                    color: "inherit",
                    borderLeft: `3px solid ${STATUS_COLOR[s]}`,
                  }}
                >
                  <div style={{ fontWeight: 700 }}>{l.familyName}</div>
                  <div style={{ fontSize: 13, color: "#64748b" }}>
                    {l.children
                      .map((c) => `${c.name}${c.grade ? ` (${c.grade})` : ""}`)
                      .join(", ")}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      marginTop: 6,
                      flexWrap: "wrap",
                    }}
                  >
                    {l.overdue && (
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: "#fff",
                          background: "#dc2626",
                          borderRadius: 6,
                          padding: "1px 6px",
                        }}
                      >
                        ⏰ &gt;24h
                      </span>
                    )}
                    {l.assignedTo && (
                      <span style={{ fontSize: 11, color: "#64748b" }}>
                        👤 {l.assignedTo}
                      </span>
                    )}
                    {l.outcome && (
                      <span style={{ fontSize: 11, color: "#059669" }}>
                        {OUTCOME_LABEL[l.outcome]}
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {openId !== null && (
        <LeadDrawer
          id={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => void load()}
        />
      )}
    </>
  );
}

function LeadDrawer({
  id,
  onClose,
  onChanged,
}: {
  id: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<LeadDetail | null>(null);
  const [staff, setStaff] = useState<{ id: number; name: string }[]>([]);
  const [noteText, setNoteText] = useState("");
  const [noteKind, setNoteKind] = useState<"note" | "contact">("note");
  const [channel, setChannel] = useState("call");
  const [outcomeReason, setOutcomeReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await authFetch(`/api/tours/requests/${id}`);
    if (res.ok) setDetail((await res.json()) as LeadDetail);
  }, [id]);

  useEffect(() => {
    void load();
    void (async () => {
      const res = await authFetch("/api/tours/assignable-staff");
      if (res.ok) setStaff((await res.json()) as { id: number; name: string }[]);
    })();
  }, [load]);

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await authFetch(`/api/tours/requests/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await load();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const addEvent = async () => {
    if (!noteText.trim()) return;
    setBusy(true);
    try {
      await authFetch(`/api/tours/requests/${id}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventType: noteKind,
          channel: noteKind === "contact" ? channel : undefined,
          body: noteText.trim(),
        }),
      });
      setNoteText("");
      await load();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const downloadPdf = async (which: "brag-sheet" | "leave-behind") => {
    const res = await authFetch(`/api/tours/requests/${id}/${which}.pdf`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  const lead = detail?.lead;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.5)",
        display: "flex",
        justifyContent: "flex-end",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: "min(560px, 100%)",
          height: "100%",
          background: "var(--bg, #0f172a)",
          overflowY: "auto",
          padding: 20,
          boxSizing: "border-box",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {!lead ? (
          <div style={{ color: "#64748b" }}>Loading…</div>
        ) : (
          <>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "start",
              }}
            >
              <div>
                <h2 style={{ margin: "0 0 4px" }}>{lead.familyName}</h2>
                <div style={{ color: "#94a3b8", fontSize: 14 }}>
                  📞 {lead.phone}
                  {lead.email ? `  ·  ✉️ ${lead.email}` : ""}
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                style={{
                  border: "none",
                  background: "none",
                  color: "#94a3b8",
                  fontSize: 22,
                  cursor: "pointer",
                }}
              >
                ✕
              </button>
            </div>

            {/* meta chips */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0" }}>
              <span
                style={{
                  fontSize: 12,
                  background: STATUS_COLOR[lead.status],
                  color: "#fff",
                  borderRadius: 6,
                  padding: "3px 9px",
                  fontWeight: 600,
                }}
              >
                {STATUS_LABEL[lead.status]}
              </span>
              <span style={{ fontSize: 12, color: "#94a3b8" }}>
                ⏱️ Response: {fmtDuration(lead.responseMs)}
                {!lead.firstContactedAt && " (waiting)"}
              </span>
              {lead.preferredLanguage === "es" && (
                <span style={{ fontSize: 12, color: "#94a3b8" }}>🗣️ Español</span>
              )}
              {lead.source && (
                <span style={{ fontSize: 12, color: "#94a3b8" }}>
                  📍 {lead.source}
                </span>
              )}
            </div>

            <div style={{ ...cardBox, marginBottom: 12 }}>
              <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 4 }}>
                Student(s)
              </div>
              <div>
                {lead.children
                  .map((c) => `${c.name}${c.grade ? ` (Grade ${c.grade})` : ""}`)
                  .join(", ")}
              </div>
              {lead.interests && (
                <>
                  <div
                    style={{
                      fontSize: 13,
                      color: "#94a3b8",
                      margin: "10px 0 4px",
                    }}
                  >
                    Interested in
                  </div>
                  <div>{lead.interests}</div>
                </>
              )}
            </div>

            {/* status actions */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}>
                Move to
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {STATUS_ORDER.filter((s) => s !== "closed").map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={busy || lead.status === s}
                    onClick={() => void patch({ status: s })}
                    style={{
                      ...btn(lead.status === s ? "#475569" : STATUS_COLOR[s]),
                      opacity: lead.status === s ? 0.5 : 1,
                    }}
                  >
                    {STATUS_LABEL[s]}
                  </button>
                ))}
              </div>
            </div>

            {/* assign + schedule */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
                marginBottom: 12,
              }}
            >
              <div>
                <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}>
                  Owner
                </div>
                <select
                  style={inputStyle}
                  value={lead.assignedStaffId ?? ""}
                  onChange={(e) =>
                    void patch({
                      assignedStaffId: e.target.value
                        ? Number(e.target.value)
                        : null,
                    })
                  }
                >
                  <option value="">Unassigned</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}>
                  Tour time
                </div>
                <input
                  type="datetime-local"
                  style={inputStyle}
                  value={toLocalDatetimeInput(lead.tourScheduledAt)}
                  onChange={(e) =>
                    void patch({
                      tourScheduledAt: e.target.value
                        ? new Date(e.target.value).toISOString()
                        : null,
                    })
                  }
                />
              </div>
            </div>

            {/* outcome */}
            <div style={{ ...cardBox, marginBottom: 12 }}>
              <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}>
                Outcome (closes the lead)
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {(Object.keys(OUTCOME_LABEL) as Outcome[]).map((o) => (
                  <button
                    key={o}
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void patch({ outcome: o, outcomeReason: outcomeReason })
                    }
                    style={{
                      ...btn(lead.outcome === o ? "#059669" : "#334155"),
                    }}
                  >
                    {OUTCOME_LABEL[o]}
                  </button>
                ))}
              </div>
              <input
                style={{ ...inputStyle, marginTop: 8 }}
                placeholder="Optional note (why)…"
                value={outcomeReason}
                onChange={(e) => setOutcomeReason(e.target.value)}
              />
              {lead.outcome && lead.outcomeReason && (
                <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 6 }}>
                  {lead.outcomeReason}
                </div>
              )}
            </div>

            {/* PDFs */}
            <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => void downloadPdf("brag-sheet")}
                style={btn("#2563eb")}
              >
                🖨️ Brag sheet
              </button>
              <button
                type="button"
                onClick={() => void downloadPdf("leave-behind")}
                style={btn("#7c3aed")}
              >
                📄 QR leave-behind
              </button>
            </div>

            {/* survey */}
            {detail.survey && (
              <div style={{ ...cardBox, marginBottom: 16 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>
                  Post-tour survey{" "}
                  {detail.survey.rating ? `· ${detail.survey.rating}/5 ⭐` : ""}
                </div>
                {detail.survey.liked && (
                  <div style={{ fontSize: 14, marginBottom: 4 }}>
                    <strong>Liked:</strong> {detail.survey.liked}
                  </div>
                )}
                {detail.survey.questions && (
                  <div style={{ fontSize: 14, marginBottom: 4 }}>
                    <strong>Questions:</strong> {detail.survey.questions}
                  </div>
                )}
                {detail.survey.comments && (
                  <div style={{ fontSize: 14 }}>
                    <strong>More:</strong> {detail.survey.comments}
                  </div>
                )}
              </div>
            )}

            {/* log a contact / note */}
            <div style={{ ...cardBox, marginBottom: 16 }}>
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                {(["note", "contact"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setNoteKind(k)}
                    style={{
                      ...btn(noteKind === k ? "#2563eb" : "#334155"),
                      padding: "5px 12px",
                    }}
                  >
                    {k === "note" ? "Note" : "Log contact"}
                  </button>
                ))}
                {noteKind === "contact" && (
                  <select
                    style={{ ...inputStyle, width: "auto" }}
                    value={channel}
                    onChange={(e) => setChannel(e.target.value)}
                  >
                    <option value="call">Call</option>
                    <option value="text">Text</option>
                    <option value="email">Email</option>
                    <option value="in_person">In person</option>
                  </select>
                )}
              </div>
              <textarea
                style={{ ...inputStyle, minHeight: 60, resize: "vertical" }}
                placeholder={
                  noteKind === "contact"
                    ? "What happened on the call/text?"
                    : "Internal note…"
                }
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
              />
              <button
                type="button"
                onClick={() => void addEvent()}
                disabled={busy || !noteText.trim()}
                style={{ ...btn("#059669"), marginTop: 8 }}
              >
                Add to timeline
              </button>
            </div>

            {/* timeline */}
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Activity</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {detail.events
                .slice()
                .reverse()
                .map((e) => (
                  <div
                    key={e.id}
                    style={{
                      borderLeft: "2px solid var(--border, #334155)",
                      paddingLeft: 12,
                    }}
                  >
                    <div style={{ fontSize: 13 }}>{e.body}</div>
                    <div style={{ fontSize: 11, color: "#94a3b8" }}>
                      {fmtDate(e.createdAt)}
                      {e.staffName ? ` · ${e.staffName}` : ""}
                      {e.channel ? ` · ${e.channel}` : ""}
                    </div>
                  </div>
                ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Brag page editor
// ---------------------------------------------------------------------------
type PageData = {
  schoolName: string;
  schoolId: number;
  published: boolean;
  headline: string;
  subheadline: string;
  intro: string;
  sections: { title: string; body: string }[];
  programs: string[];
  electives: string[];
  proudOf: string[];
  photos: string[];
  ctaText: string;
  accentColor: string;
  contactEmail: string | null;
  contactPhone: string | null;
};

function ListEditor({
  label,
  items,
  onChange,
}: {
  label: string;
  items: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}>
        {label}
      </div>
      {items.map((it, i) => (
        <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <input
            style={inputStyle}
            value={it}
            onChange={(e) =>
              onChange(items.map((x, j) => (j === i ? e.target.value : x)))
            }
          />
          <button
            type="button"
            onClick={() => onChange(items.filter((_, j) => j !== i))}
            style={{ ...btn("#334155"), padding: "0 12px" }}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...items, ""])}
        style={{
          border: "none",
          background: "none",
          color: "var(--accent, #2563eb)",
          fontWeight: 600,
          cursor: "pointer",
          padding: 0,
        }}
      >
        + Add
      </button>
    </div>
  );
}

function BragEditor() {
  const [data, setData] = useState<PageData | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [publicUrl, setPublicUrl] = useState("");

  useEffect(() => {
    void (async () => {
      const res = await authFetch("/api/tours/page");
      if (res.ok) {
        const json = (await res.json()) as PageData;
        setData(json);
        setPublicUrl(`${window.location.origin}/tour/${json.schoolId}`);
      }
    })();
  }, []);

  const save = async () => {
    if (!data) return;
    setBusy(true);
    setSaved(false);
    try {
      const res = await authFetch("/api/tours/page", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) setSaved(true);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <div style={{ color: "#64748b" }}>Loading…</div>;
  const set = (patch: Partial<PageData>) =>
    setData((d) => (d ? { ...d, ...patch } : d));

  return (
    <div style={{ maxWidth: 720 }}>
      <div
        style={{
          ...cardBox,
          marginBottom: 14,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={data.published}
            onChange={(e) => set({ published: e.target.checked })}
          />
          <span style={{ fontWeight: 600 }}>
            {data.published ? "Published (live)" : "Draft (hidden)"}
          </span>
        </label>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <a
            href={publicUrl}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--accent, #2563eb)", fontSize: 13 }}
          >
            {publicUrl}
          </a>
          <button
            type="button"
            onClick={() => navigator.clipboard?.writeText(publicUrl)}
            style={{ ...btn("#334155"), padding: "5px 10px" }}
          >
            Copy
          </button>
        </div>
      </div>

      <div style={cardBox}>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}>
            Headline
          </div>
          <input
            style={inputStyle}
            value={data.headline}
            onChange={(e) => set({ headline: e.target.value })}
          />
        </div>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}>
            Subheadline
          </div>
          <input
            style={inputStyle}
            value={data.subheadline}
            onChange={(e) => set({ subheadline: e.target.value })}
          />
        </div>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}>
            Intro paragraph
          </div>
          <textarea
            style={{ ...inputStyle, minHeight: 80, resize: "vertical" }}
            value={data.intro}
            onChange={(e) => set({ intro: e.target.value })}
          />
        </div>

        <ListEditor
          label="Programs"
          items={data.programs}
          onChange={(programs) => set({ programs })}
        />
        <ListEditor
          label="Electives"
          items={data.electives}
          onChange={(electives) => set({ electives })}
        />
        <ListEditor
          label="What we're proud of"
          items={data.proudOf}
          onChange={(proudOf) => set({ proudOf })}
        />
        <ListEditor
          label="Photo URLs"
          items={data.photos}
          onChange={(photos) => set({ photos })}
        />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 10,
            marginBottom: 14,
          }}
        >
          <div>
            <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}>
              CTA button text
            </div>
            <input
              style={inputStyle}
              value={data.ctaText}
              onChange={(e) => set({ ctaText: e.target.value })}
            />
          </div>
          <div>
            <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}>
              Accent color
            </div>
            <input
              type="color"
              style={{ ...inputStyle, padding: 4, height: 40 }}
              value={data.accentColor}
              onChange={(e) => set({ accentColor: e.target.value })}
            />
          </div>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 10,
            marginBottom: 14,
          }}
        >
          <div>
            <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}>
              Contact phone
            </div>
            <input
              style={inputStyle}
              value={data.contactPhone ?? ""}
              onChange={(e) => set({ contactPhone: e.target.value })}
            />
          </div>
          <div>
            <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}>
              Contact email
            </div>
            <input
              style={inputStyle}
              value={data.contactEmail ?? ""}
              onChange={(e) => set({ contactEmail: e.target.value })}
            />
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            style={btn("var(--accent, #2563eb)")}
          >
            {busy ? "Saving…" : "Save brag page"}
          </button>
          {saved && <span style={{ color: "#059669" }}>✓ Saved</span>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Outcome report
// ---------------------------------------------------------------------------
type Summary = {
  total: number;
  byStatus: Record<string, number>;
  byOutcome: Record<string, number>;
  bySource: Record<string, number>;
  enrolled: number;
  toured: number;
  conversionRate: number;
};

function Report() {
  const [s, setS] = useState<Summary | null>(null);
  useEffect(() => {
    void (async () => {
      const res = await authFetch("/api/tours/outcomes/summary");
      if (res.ok) setS((await res.json()) as Summary);
    })();
  }, []);
  if (!s) return <div style={{ color: "#64748b" }}>Loading…</div>;

  const tile = (label: string, value: string | number, color: string) => (
    <div style={{ ...cardBox, textAlign: "center" }}>
      <div style={{ fontSize: 30, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 13, color: "#94a3b8" }}>{label}</div>
    </div>
  );

  return (
    <div style={{ maxWidth: 720 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        {tile("Total leads", s.total, "#2563eb")}
        {tile("Toured", s.toured, "#7c3aed")}
        {tile("Enrolled", s.enrolled, "#059669")}
        {tile("Conversion", `${s.conversionRate}%`, "#0ea5a4")}
      </div>

      <div style={{ ...cardBox, marginBottom: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>Pipeline</div>
        {STATUS_ORDER.map((st) => (
          <div
            key={st}
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "4px 0",
            }}
          >
            <span>{STATUS_LABEL[st]}</span>
            <strong>{s.byStatus[st] ?? 0}</strong>
          </div>
        ))}
      </div>

      <div style={cardBox}>
        <div style={{ fontWeight: 700, marginBottom: 10 }}>By source</div>
        {Object.entries(s.bySource).length === 0 ? (
          <div style={{ color: "#94a3b8" }}>No source data yet.</div>
        ) : (
          Object.entries(s.bySource)
            .sort((a, b) => b[1] - a[1])
            .map(([src, n]) => (
              <div
                key={src}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "4px 0",
                }}
              >
                <span>{src}</span>
                <strong>{n}</strong>
              </div>
            ))
        )}
      </div>
    </div>
  );
}
