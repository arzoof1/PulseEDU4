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
  if (!Number.isFinite(ms) || ms < 0) return "—";
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
  const [schedDraft, setSchedDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await authFetch(`/api/tours/requests/${id}`);
    if (res.ok) {
      const data = (await res.json()) as LeadDetail;
      setDetail(data);
      setSchedDraft(toLocalDatetimeInput(data.lead.tourScheduledAt));
    }
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

  // Open the PDF in a new tab for viewing / printing. We deliberately do NOT
  // call window.open(...).print() programmatically: inside the sandboxed
  // preview iframe a popup that retains a window.opener reference and is then
  // told to print() can deadlock the parent page (the home screen froze and
  // required a browser restart). Using an anchor with rel="noopener" fully
  // detaches the new tab, so the user prints from the PDF viewer's own toolbar
  // (Ctrl/⌘+P) without ever blocking the app.
  const openPdf = async (which: "brag-sheet" | "leave-behind") => {
    const res = await authFetch(`/api/tours/requests/${id}/${which}.pdf`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
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
                  value={schedDraft}
                  onChange={(e) => setSchedDraft(e.target.value)}
                  onBlur={() => {
                    const original = toLocalDatetimeInput(lead.tourScheduledAt);
                    if (schedDraft === original) return;
                    void patch({
                      tourScheduledAt: schedDraft
                        ? new Date(schedDraft).toISOString()
                        : null,
                    });
                  }}
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

            {/* PDFs — open in a new tab; print from the PDF viewer (Ctrl/⌘+P) */}
            <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => void openPdf("brag-sheet")}
                style={btn("#2563eb")}
              >
                🖨️ Print brag sheet
              </button>
              <button
                type="button"
                onClick={() => void openPdf("leave-behind")}
                style={btn("#7c3aed")}
              >
                🖨️ Print post-tour document
              </button>
            </div>
            <div
              style={{
                fontSize: 12,
                color: "#94a3b8",
                marginBottom: 16,
              }}
            >
              Opens in a new tab — use your browser's print (Ctrl/⌘+P) or the
              viewer's download button to save.
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
  textPlacement: "top" | "bottom";
  flyers: TourFlyerItem[];
  ctaText: string;
  accentColor: string;
  headerTextColor: string;
  contactEmail: string | null;
  contactPhone: string | null;
};

type TourFlyerItem = { key: string; label: string; kind: "image" | "pdf" };

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

// Upload a file via the presigned-URL flow. Returns the object path to store
// on the record, or null on failure.
async function uploadTourFile(file: File): Promise<string | null> {
  try {
    const reqRes = await authFetch("/api/storage/uploads/request-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: file.name,
        size: file.size,
        contentType: file.type,
      }),
    });
    if (!reqRes.ok) return null;
    const { uploadURL, objectPath } = (await reqRes.json()) as {
      uploadURL: string;
      objectPath: string;
    };
    // Direct PUT to storage — plain fetch, no auth header (it's a signed URL).
    const putRes = await fetch(uploadURL, {
      method: "PUT",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    if (!putRes.ok) return null;
    return objectPath;
  } catch {
    return null;
  }
}

// Private object-storage assets can't be loaded via a bare <img src> (the
// read route requires an Authorization header), so fetch the bytes via
// authFetch and render a blob URL. External http(s) URLs are passed through.
function AuthImage({
  src,
  alt,
  style,
}: {
  src: string;
  alt?: string;
  style?: React.CSSProperties;
}) {
  const [url, setUrl] = useState("");
  const passthrough = /^https?:\/\//i.test(src);
  useEffect(() => {
    if (passthrough) {
      setUrl(src);
      return;
    }
    let revoked = false;
    let objUrl = "";
    void (async () => {
      try {
        const res = await authFetch(`/api/storage${src}`);
        if (!res.ok) return;
        const blob = await res.blob();
        objUrl = URL.createObjectURL(blob);
        if (!revoked) setUrl(objUrl);
      } catch {
        /* leave placeholder */
      }
    })();
    return () => {
      revoked = true;
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
  }, [src, passthrough]);
  return <img src={url || undefined} alt={alt ?? ""} style={style} />;
}

function PhotoUploader({
  photos,
  onChange,
}: {
  photos: string[];
  onChange: (next: string[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const onPick = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setErr("");
    setBusy(true);
    try {
      const added: string[] = [];
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        if (file.size > 10 * 1024 * 1024) {
          setErr(`"${file.name}" is over 10 MB and was skipped.`);
          continue;
        }
        const key = await uploadTourFile(file);
        if (key) added.push(key);
        else setErr(`"${file.name}" failed to upload.`);
      }
      if (added.length > 0) onChange([...photos, ...added]);
    } finally {
      setBusy(false);
    }
  };

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= photos.length) return;
    const next = [...photos];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const makeCover = (i: number) => {
    if (i === 0) return;
    const next = [...photos];
    const [picked] = next.splice(i, 1);
    next.unshift(picked);
    onChange(next);
  };
  const remove = (i: number) => onChange(photos.filter((_, j) => j !== i));

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}>
        Photos — drag the order with the arrows; the first photo is the cover
        families see first.
      </div>
      {photos.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
            gap: 10,
            marginBottom: 10,
          }}
        >
          {photos.map((p, i) => (
            <div
              key={`${p}-${i}`}
              style={{
                position: "relative",
                border: "1px solid #334155",
                borderRadius: 10,
                overflow: "hidden",
                background: "#0f172a",
              }}
            >
              <AuthImage
                src={p}
                style={{
                  width: "100%",
                  height: 110,
                  objectFit: "cover",
                  display: "block",
                  background: "#1e293b",
                }}
              />
              {i === 0 && (
                <div
                  style={{
                    position: "absolute",
                    top: 6,
                    left: 6,
                    background: "rgba(16,185,129,0.95)",
                    color: "#fff",
                    fontSize: 11,
                    fontWeight: 700,
                    padding: "2px 8px",
                    borderRadius: 999,
                  }}
                >
                  Cover
                </div>
              )}
              <div
                style={{
                  display: "flex",
                  gap: 4,
                  padding: 6,
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    type="button"
                    title="Move earlier"
                    onClick={() => move(i, -1)}
                    disabled={i === 0}
                    style={miniBtn(i === 0)}
                  >
                    ←
                  </button>
                  <button
                    type="button"
                    title="Move later"
                    onClick={() => move(i, 1)}
                    disabled={i === photos.length - 1}
                    style={miniBtn(i === photos.length - 1)}
                  >
                    →
                  </button>
                  {i !== 0 && (
                    <button
                      type="button"
                      title="Make cover"
                      onClick={() => makeCover(i)}
                      style={miniBtn(false)}
                    >
                      ★
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  title="Remove"
                  onClick={() => remove(i)}
                  style={{ ...miniBtn(false), color: "#fca5a5" }}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <label
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!busy) void onPick(e.dataTransfer.files);
        }}
        style={{
          display: "block",
          textAlign: "center",
          padding: "18px 16px",
          borderRadius: 12,
          border: `2px dashed ${dragOver ? "var(--accent, #2563eb)" : "#475569"}`,
          background: dragOver ? "rgba(37,99,235,0.08)" : "#0f172a",
          color: "#cbd5e1",
          cursor: busy ? "wait" : "pointer",
          opacity: busy ? 0.7 : 1,
          fontSize: 14,
        }}
      >
        {busy
          ? "Uploading…"
          : "＋ Drag photos here, or tap to choose files"}
        <input
          type="file"
          accept="image/*"
          multiple
          disabled={busy}
          onChange={(e) => {
            void onPick(e.target.files);
            e.target.value = "";
          }}
          style={{ display: "none" }}
        />
      </label>
      {err && (
        <div style={{ color: "#fca5a5", fontSize: 13, marginTop: 6 }}>{err}</div>
      )}
    </div>
  );
}

function FlyerUploader({
  flyers,
  onChange,
}: {
  flyers: TourFlyerItem[];
  onChange: (next: TourFlyerItem[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const onPick = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setErr("");
    setBusy(true);
    try {
      const added: TourFlyerItem[] = [];
      for (const file of Array.from(files)) {
        const isPdf = file.type === "application/pdf";
        const isImg = file.type.startsWith("image/");
        if (!isPdf && !isImg) {
          setErr(`"${file.name}" must be a PNG, JPG, or PDF.`);
          continue;
        }
        if (file.size > 10 * 1024 * 1024) {
          setErr(`"${file.name}" is over 10 MB and was skipped.`);
          continue;
        }
        const key = await uploadTourFile(file);
        if (key)
          added.push({ key, label: "", kind: isPdf ? "pdf" : "image" });
        else setErr(`"${file.name}" failed to upload.`);
      }
      if (added.length > 0) onChange([...flyers, ...added]);
    } finally {
      setBusy(false);
    }
  };

  const remove = (i: number) => onChange(flyers.filter((_, j) => j !== i));
  const setLabel = (i: number, label: string) =>
    onChange(flyers.map((f, j) => (j === i ? { ...f, label } : f)));

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}>
        Flyers (PNG, JPG, or PDF — up to 10 MB each). Shown in their own
        section lower on the page; families can tap to view, download, or print.
      </div>
      {flyers.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          {flyers.map((f, i) => (
            <div
              key={`${f.key}-${i}`}
              style={{
                display: "flex",
                gap: 10,
                alignItems: "center",
                marginBottom: 8,
                padding: 8,
                border: "1px solid #334155",
                borderRadius: 10,
                background: "#0f172a",
              }}
            >
              {f.kind === "image" ? (
                <AuthImage
                  src={f.key}
                  style={{
                    width: 46,
                    height: 60,
                    objectFit: "cover",
                    borderRadius: 6,
                    background: "#1e293b",
                    flex: "0 0 auto",
                  }}
                />
              ) : (
                <div
                  style={{
                    width: 46,
                    height: 60,
                    borderRadius: 6,
                    background: "#1e293b",
                    display: "grid",
                    placeItems: "center",
                    fontSize: 11,
                    fontWeight: 700,
                    color: "#f87171",
                    flex: "0 0 auto",
                  }}
                >
                  PDF
                </div>
              )}
              <input
                style={{ ...inputStyle, flex: 1 }}
                placeholder="Label (optional) — e.g. Band Program"
                value={f.label}
                onChange={(e) => setLabel(i, e.target.value)}
              />
              <button
                type="button"
                onClick={() => remove(i)}
                style={{ ...btn("#334155"), padding: "0 12px" }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <label
        style={{
          ...btn("var(--accent, #2563eb)"),
          display: "inline-block",
          cursor: busy ? "wait" : "pointer",
          opacity: busy ? 0.7 : 1,
        }}
      >
        {busy ? "Uploading…" : "＋ Upload flyer"}
        <input
          type="file"
          accept="image/png,image/jpeg,application/pdf"
          multiple
          disabled={busy}
          onChange={(e) => {
            void onPick(e.target.files);
            e.target.value = "";
          }}
          style={{ display: "none" }}
        />
      </label>
      {err && (
        <div style={{ color: "#fca5a5", fontSize: 13, marginTop: 6 }}>{err}</div>
      )}
    </div>
  );
}

function miniBtn(disabled: boolean): React.CSSProperties {
  return {
    border: "1px solid #475569",
    background: "#1e293b",
    color: disabled ? "#475569" : "#cbd5e1",
    borderRadius: 6,
    cursor: disabled ? "default" : "pointer",
    fontSize: 13,
    lineHeight: 1,
    padding: "4px 8px",
  };
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
        // Defensive defaults for the new fields so an older API response
        // can't break the uploader UI.
        json.flyers = Array.isArray(json.flyers) ? json.flyers : [];
        json.photos = Array.isArray(json.photos) ? json.photos : [];
        json.textPlacement = json.textPlacement === "bottom" ? "bottom" : "top";
        json.headerTextColor = /^#[0-9a-fA-F]{6}$/.test(json.headerTextColor)
          ? json.headerTextColor
          : "#ffffff";
        setData(json);
        setPublicUrl(`${window.location.origin}/tour/${json.schoolId}`);
      }
    })();
  }, []);

  const persist = async (payload: PageData) => {
    const res = await authFetch("/api/tours/page", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  };

  const save = async () => {
    if (!data) return;
    setBusy(true);
    setSaved(false);
    try {
      if (await persist(data)) setSaved(true);
    } finally {
      setBusy(false);
    }
  };

  // The Live/Hidden toggle saves immediately so flipping it actually
  // publishes (or hides) the page right away — no separate Save needed.
  const togglePublished = async () => {
    if (!data || busy) return;
    const next = { ...data, published: !data.published };
    setData(next);
    setBusy(true);
    setSaved(false);
    try {
      const ok = await persist(next);
      if (ok) setSaved(true);
      else setData(data); // revert on failure
    } catch {
      setData(data);
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
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            type="button"
            role="switch"
            aria-checked={data.published}
            aria-label={
              data.published
                ? "Page is live — click to hide"
                : "Page is hidden — click to publish"
            }
            onClick={() => void togglePublished()}
            disabled={busy}
            style={{
              position: "relative",
              width: 52,
              height: 28,
              borderRadius: 999,
              border: "none",
              cursor: busy ? "wait" : "pointer",
              padding: 0,
              flexShrink: 0,
              opacity: busy ? 0.6 : 1,
              background: data.published ? "#16a34a" : "#cbd5e1",
              transition: "background 0.15s ease",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 3,
                left: data.published ? 27 : 3,
                width: 22,
                height: 22,
                borderRadius: "50%",
                background: "#fff",
                boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
                transition: "left 0.15s ease",
              }}
            />
          </button>
          <span
            style={{
              fontWeight: 600,
              color: data.published ? "#16a34a" : "#64748b",
            }}
          >
            {data.published ? "🟢 Live" : "⚪ Hidden"}
          </span>
        </div>
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
        <PhotoUploader
          photos={data.photos}
          onChange={(photos) => set({ photos })}
        />

        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}>
            Headline &amp; intro placement
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {(
              [
                ["top", "Text above photos"],
                ["bottom", "Text below photos"],
              ] as const
            ).map(([value, lbl]) => {
              const active = data.textPlacement === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => set({ textPlacement: value })}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 999,
                    border: `1px solid ${active ? "var(--accent, #2563eb)" : "#334155"}`,
                    background: active ? "var(--accent, #2563eb)" : "transparent",
                    color: active ? "#fff" : "#cbd5e1",
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  {lbl}
                </button>
              );
            })}
          </div>
        </div>

        <FlyerUploader
          flyers={data.flyers}
          onChange={(flyers) => set({ flyers })}
        />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
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
          <div>
            <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}>
              Header font color
            </div>
            <input
              type="color"
              style={{ ...inputStyle, padding: 4, height: 40 }}
              value={data.headerTextColor}
              onChange={(e) => set({ headerTextColor: e.target.value })}
            />
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>
              Color of the headline &amp; intro text in the header. Pick a darker
              shade if your accent color is light, or keep white for dark accents.
            </div>
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
