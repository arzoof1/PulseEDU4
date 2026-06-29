import { useCallback, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { authFetch } from "../lib/authToken";
import {
  HowToUseHelp,
  HowToSection,
  RoleSection,
  howtoListStyle,
} from "./HowToUseHelp";

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
type Status =
  | "new"
  | "contacted"
  | "scheduled"
  | "toured"
  | "deciding"
  | "closed";
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
  // Phase 2 lifecycle. overdueReason explains WHY a lead is flagged overdue;
  // followUpDueAt is the deciding-stage business-day clock; closedAt/archived
  // drive the auto-archive declutter.
  overdueReason?: string | null;
  followUpDueAt?: string | null;
  closedAt?: string | null;
  archived?: boolean;
  // Family's selected tour checkpoints, resolved to current labels.
  selectedCheckpoints?: string[];
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

type WalkStop = {
  checkpointKey: string;
  label: string;
  location: string;
  plannedMinutes: number;
  order: number;
  familyRequested: boolean;
  schoolHighlight: boolean;
  completedAt: string | null;
  note: string;
};

type WalkDetail = {
  walkUrl: string;
  walkToken: string;
  familyName: string;
  walk: {
    token: string;
    status: "pending" | "in_progress" | "completed" | "abandoned";
    startedAt: string | null;
    endedAt: string | null;
    guideStaffId: number | null;
    guideName: string | null;
  };
  stops: WalkStop[];
};

const STATUS_ORDER: Status[] = [
  "new",
  "contacted",
  "scheduled",
  "toured",
  "deciding",
  "closed",
];
const STATUS_LABEL: Record<Status, string> = {
  new: "New",
  contacted: "Contacted",
  scheduled: "Scheduled",
  toured: "Toured",
  deciding: "Still deciding",
  closed: "Closed",
};
const STATUS_COLOR: Record<Status, string> = {
  new: "#dc2626",
  contacted: "#d97706",
  scheduled: "#2563eb",
  toured: "#7c3aed",
  deciding: "#db2777",
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
// Short, reason-aware label for the red overdue badge on a lead card. The
// server returns overdueReason so the badge can say WHY the lead is flagged,
// not just ">24h" (which only made sense for the first-contact case).
function overdueBadgeLabel(reason?: string | null): string {
  switch (reason) {
    case "first_contact":
      return "No first contact";
    case "tour_not_logged":
      return "Tour not logged";
    case "follow_up":
      return "Follow-up due";
    default:
      return "Overdue";
  }
}
// Coerce a possibly-undefined/NaN numeric setting into an integer within
// [min,max], falling back to fallback. Mirrors the server-side clampInt so the
// inputs never show an out-of-range value the API would reject.
function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
// Human countdown to (or past) the deciding-stage follow-up due date.
function followUpCountdownLabel(dueIso: string): string {
  const due = new Date(dueIso).getTime();
  if (Number.isNaN(due)) return "Follow up";
  const diffMs = due - Date.now();
  const dayMs = 86_400_000;
  if (diffMs <= 0) {
    const overdueDays = Math.floor(-diffMs / dayMs);
    if (overdueDays >= 1) return `Follow-up ${overdueDays}d overdue`;
    return "Follow-up due";
  }
  const days = Math.ceil(diffMs / dayMs);
  return days <= 1 ? "Follow up by tomorrow" : `Follow up in ${days}d`;
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
  const [tab, setTab] = useState<
    "pipeline" | "page" | "report" | "feedback"
  >("pipeline");
  return (
    <div style={{ padding: "0 4px" }}>
      <HowToUseHelp title="How to use School Tours">
        <HowToSection title="The three tabs">
          <ul style={howtoListStyle}>
            <li>
              <strong>Lead Pipeline</strong> — work tour requests through
              New → Contacted → Scheduled → Toured → Closed, with owners and a
              response-time clock.
            </li>
            <li>
              <strong>Brag Page</strong> — edit your public tour page: text,
              flyers, photos, checkpoints, and font color. English text
              auto-translates to Spanish.
            </li>
            <li>
              <strong>Outcomes</strong> — the enrollment conversion report by
              outcome.
            </li>
          </ul>
        </HowToSection>
        <RoleSection
          for={["admin", "coreTeam"]}
          title="PDFs download to disk"
        >
          Brag-sheet, roadmap, and note-catcher PDFs download rather than open
          in a tab — that's intentional, since printing in the preview can
          freeze the app.
        </RoleSection>
      </HowToUseHelp>
      <div
        style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}
      >
        {(
          [
            ["pipeline", "📋 Lead Pipeline"],
            ["page", "✨ Brag Page"],
            ["report", "📊 Outcomes"],
            ["feedback", "💬 Feedback"],
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
      {tab === "feedback" && <FeedbackTab />}
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
      className="tour-lead-banner"
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
  const [view, setView] = useState<"active" | "archived">("active");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(
        view === "archived"
          ? "/api/tours/requests?view=archived"
          : "/api/tours/requests",
      );
      if (res.ok) setLeads((await res.json()) as Lead[]);
    } finally {
      setLoading(false);
    }
  }, [view]);
  useEffect(() => {
    void load();
  }, [load]);

  const byStatus = useMemo(() => {
    const m: Record<Status, Lead[]> = {
      new: [],
      contacted: [],
      scheduled: [],
      toured: [],
      deciding: [],
      closed: [],
    };
    for (const l of leads) m[l.status]?.push(l);
    return m;
  }, [leads]);

  const viewTabs = (
    <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
      {(
        [
          ["active", "Active pipeline"],
          ["archived", "Archived"],
        ] as const
      ).map(([v, lbl]) => {
        const active = view === v;
        return (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            style={{
              padding: "6px 14px",
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
  );

  if (loading)
    return (
      <>
        {viewTabs}
        <div style={{ color: "#64748b" }}>Loading leads…</div>
      </>
    );

  if (leads.length === 0) {
    return (
      <>
        {viewTabs}
        <div style={{ ...cardBox, textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 40 }}>🗒️</div>
          {view === "archived" ? (
            <>
              <h3 style={{ margin: "12px 0 6px" }}>Nothing archived yet</h3>
              <p style={{ color: "#64748b", margin: 0 }}>
                Closed tours move here automatically after the archive window
                you set in Settings.
              </p>
            </>
          ) : (
            <>
              <h3 style={{ margin: "12px 0 6px" }}>No tour requests yet</h3>
              <p style={{ color: "#64748b", margin: 0 }}>
                Publish your Brag Page and share the link — new leads land here
                automatically.
              </p>
            </>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      {viewTabs}
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
                        ⏰ {overdueBadgeLabel(l.overdueReason)}
                      </span>
                    )}
                    {l.status === "deciding" && l.followUpDueAt && (
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: "#fff",
                          background: l.overdue ? "#dc2626" : "#db2777",
                          borderRadius: 6,
                          padding: "1px 6px",
                        }}
                      >
                        📞 {followUpCountdownLabel(l.followUpDueAt)}
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

// Live tour walk — shown inside the lead drawer. Before a walk runs it offers a
// QR + link a guide can open on their phone (the printed roadmap carries the
// same QR). Once captured it shows who guided, total length, per-stop
// planned-vs-actual timings, and any staff notes flagged for the follow-up call.
function WalkSection({ walk, qr }: { walk: WalkDetail; qr: string }) {
  const started = !!walk.walk.startedAt;
  const ended = !!walk.walk.endedAt;
  const totalMs =
    walk.walk.startedAt && walk.walk.endedAt
      ? new Date(walk.walk.endedAt).getTime() -
        new Date(walk.walk.startedAt).getTime()
      : 0;
  const totalMin = totalMs > 0 ? Math.round(totalMs / 60000) : 0;
  const plannedMin = walk.stops.reduce((a, s) => a + (s.plannedMinutes || 0), 0);
  const completed = walk.stops.filter((s) => !!s.completedAt);

  // Per-stop actual = gap between consecutive completions in the order they
  // were actually checked off (chronological, NOT planned order — guides tap
  // out of sequence). The first completed stop is measured from the tour start.
  const actualByKey = new Map<string, number>();
  let prev = walk.walk.startedAt ? new Date(walk.walk.startedAt).getTime() : null;
  for (const s of walk.stops
    .filter((s) => !!s.completedAt)
    .sort(
      (a, b) =>
        new Date(a.completedAt!).getTime() - new Date(b.completedAt!).getTime(),
    )) {
    const t = new Date(s.completedAt!).getTime();
    if (prev != null) actualByKey.set(s.checkpointKey, Math.max(0, t - prev));
    prev = t;
  }

  const notes = walk.stops.filter((s) => s.note.trim());

  return (
    <div style={{ ...cardBox, marginBottom: 16 }}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>Live tour walk</div>

      {!started && (
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          {qr && (
            <img
              src={qr}
              alt="Scan to start the live tour"
              width={104}
              height={104}
              style={{ borderRadius: 8, border: "1px solid #e2e8f0" }}
            />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: "#475569", marginBottom: 8 }}>
              Scan with the guide’s phone (the printed roadmap has the same code)
              to check off each stop as you walk — works offline.
            </div>
            <a
              href={walk.walkUrl}
              target="_blank"
              rel="noreferrer"
              style={{
                ...btn("#0ea5a4"),
                display: "inline-block",
                textDecoration: "none",
              }}
            >
              Open live walk
            </a>
          </div>
        </div>
      )}

      {started && (
        <>
          <div style={{ fontSize: 14, marginBottom: 6 }}>
            <strong>Guide:</strong> {walk.walk.guideName ?? "—"}
            {ended ? (
              <>
                {"  ·  "}
                <strong>Length:</strong> {totalMin}m
                {plannedMin > 0 && (
                  <span style={{ color: "#94a3b8" }}>
                    {" "}
                    (planned ~{plannedMin}m)
                  </span>
                )}
              </>
            ) : (
              <span style={{ color: "#d97706" }}> · in progress…</span>
            )}
          </div>
          <div style={{ fontSize: 13, color: "#64748b", marginBottom: 8 }}>
            {completed.length} of {walk.stops.length} stops checked off.
          </div>

          {completed.length > 0 && (
            <div style={{ marginBottom: notes.length ? 10 : 0 }}>
              {[...walk.stops]
                .sort((a, b) => a.order - b.order)
                .map((s) => {
                  const actual = actualByKey.get(s.checkpointKey);
                  return (
                    <div
                      key={s.checkpointKey}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 8,
                        fontSize: 13,
                        padding: "3px 0",
                        color: s.completedAt ? "#1f2937" : "#cbd5e1",
                      }}
                    >
                      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {s.completedAt ? "✓" : "○"} {s.label}
                      </span>
                      <span style={{ flexShrink: 0, color: "#64748b" }}>
                        {s.completedAt && actual != null
                          ? `${Math.max(1, Math.round(actual / 60000))}m`
                          : "—"}
                        {s.plannedMinutes > 0 && (
                          <span style={{ color: "#cbd5e1" }}>
                            {" / "}~{s.plannedMinutes}m
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
            </div>
          )}

          {notes.length > 0 && (
            <div
              style={{
                marginTop: 6,
                paddingTop: 10,
                borderTop: "1px solid #e2e8f0",
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700, color: "#92400e", marginBottom: 4 }}>
                📌 Follow-up notes from the walk
              </div>
              {notes.map((s) => (
                <div key={s.checkpointKey} style={{ fontSize: 13, marginBottom: 4 }}>
                  <strong>{s.label}:</strong> {s.note}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
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
  const [walk, setWalk] = useState<WalkDetail | null>(null);
  const [walkQr, setWalkQr] = useState<string>("");
  const [staff, setStaff] = useState<{ id: number; name: string }[]>([]);
  const [noteText, setNoteText] = useState("");
  const [noteKind, setNoteKind] = useState<"note" | "contact">("note");
  const [channel, setChannel] = useState("call");
  const [outcomeReason, setOutcomeReason] = useState("");
  const [schedDraft, setSchedDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [packetBusy, setPacketBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await authFetch(`/api/tours/requests/${id}`);
    if (res.ok) {
      const data = (await res.json()) as LeadDetail;
      setDetail(data);
      setSchedDraft(toLocalDatetimeInput(data.lead.tourScheduledAt));
    }
  }, [id]);

  const loadWalk = useCallback(async () => {
    const res = await authFetch(`/api/tours/requests/${id}/walk`);
    if (!res.ok) return;
    const data = (await res.json()) as WalkDetail;
    setWalk(data);
    if (data.walkUrl) {
      try {
        setWalkQr(
          await QRCode.toDataURL(data.walkUrl, {
            margin: 1,
            width: 200,
            errorCorrectionLevel: "M",
          }),
        );
      } catch {
        /* QR is a convenience; the link still works without it */
      }
    }
  }, [id]);

  useEffect(() => {
    void load();
    void loadWalk();
    void (async () => {
      const res = await authFetch("/api/tours/assignable-staff");
      if (res.ok) setStaff((await res.json()) as { id: number; name: string }[]);
    })();
  }, [load, loadWalk]);

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

  // Download the PDF to disk, then the user opens it to print. We must NOT
  // open it in a new tab or call window.print(): the PDF route is fetched with
  // a Bearer token (the session cookie is blocked inside the Replit preview
  // iframe), so a plain new-tab navigation can't authenticate, and a blob URL
  // opened in a top-level tab renders blank because the blob belongs to the
  // iframe's opaque origin. An earlier window.open(...).print() also deadlocked
  // and froze the whole app. A blob download triggered from THIS document is
  // the only path that works reliably in both the preview and production.
  const downloadPdf = async (
    which:
      | "brag-sheet"
      | "leave-behind"
      | "roadmap"
      | "roadmap-short"
      | "note-catcher",
  ) => {
    const res = await authFetch(`/api/tours/requests/${id}/${which}.pdf`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download =
      which === "brag-sheet"
        ? "brag-sheet.pdf"
        : which === "roadmap"
          ? "tour-roadmap.pdf"
          : which === "roadmap-short"
            ? "tour-roadmap-1page.pdf"
            : which === "note-catcher"
              ? "tour-note-catcher.pdf"
              : "share-your-feedback.pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  // Complete packet: the server merges all four PDFs into one document (tour
  // order) so the guide gets a single print job. Same blob-download path as
  // downloadPdf for the same iframe-auth reasons.
  const downloadPacket = async () => {
    setPacketBusy(true);
    try {
      const res = await authFetch(`/api/tours/requests/${id}/packet.pdf`);
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "tour-packet.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } finally {
      setPacketBusy(false);
    }
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
              {lead.selectedCheckpoints &&
                lead.selectedCheckpoints.length > 0 && (
                  <>
                    <div
                      style={{
                        fontSize: 13,
                        color: "#94a3b8",
                        margin: "10px 0 4px",
                      }}
                    >
                      Tour stops selected
                    </div>
                    <div
                      style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
                    >
                      {lead.selectedCheckpoints.map((c, i) => (
                        <span
                          key={i}
                          style={{
                            fontSize: 12,
                            background: "rgba(37,99,235,0.12)",
                            color: "#1e40af",
                            border: "1px solid rgba(37,99,235,0.25)",
                            borderRadius: 6,
                            padding: "3px 9px",
                          }}
                        >
                          {c}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              {lead.interests && (
                <>
                  <div
                    style={{
                      fontSize: 13,
                      color: "#94a3b8",
                      margin: "10px 0 4px",
                    }}
                  >
                    Anything else
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
              {lead.status === "deciding" && lead.followUpDueAt && (
                <div
                  style={{
                    fontSize: 13,
                    marginTop: 8,
                    fontWeight: 600,
                    color: lead.overdue ? "#fca5a5" : "#f9a8d4",
                  }}
                >
                  📞 {followUpCountdownLabel(lead.followUpDueAt)} ·{" "}
                  <span style={{ fontWeight: 400, color: "#94a3b8" }}>
                    due {fmtDate(lead.followUpDueAt)}. Logging a contact resets
                    the clock.
                  </span>
                </div>
              )}
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

            {/* Complete packet — every leave-behind merged into one print job,
                in tour order. Individual buttons stay below for reprints. */}
            <div style={{ marginBottom: 8 }}>
              <button
                type="button"
                onClick={() => void downloadPacket()}
                disabled={packetBusy}
                style={{
                  ...btn("#1d4ed8"),
                  width: "100%",
                  justifyContent: "center",
                  fontSize: 15,
                  padding: "11px 16px",
                  opacity: packetBusy ? 0.6 : 1,
                  cursor: packetBusy ? "wait" : "pointer",
                }}
              >
                {packetBusy
                  ? "Building packet…"
                  : "🗂️ Print Complete Tour Packet (PDF)"}
              </button>
            </div>
            <div
              style={{
                fontSize: 12,
                color: "#94a3b8",
                marginBottom: 10,
              }}
            >
              One file, in tour order: brag sheet → roadmap → note catcher →
              feedback page.
            </div>

            {/* PDFs — download the file, then open it to print. Kept as
                individual pages so any one can be reprinted if lost or damaged. */}
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "#94a3b8",
                marginBottom: 6,
              }}
            >
              Or print an individual page
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => void downloadPdf("brag-sheet")}
                style={btn("#2563eb")}
              >
                ⬇️ Brag sheet (PDF)
              </button>
              <button
                type="button"
                onClick={() => void downloadPdf("roadmap")}
                style={btn("#0ea5a4")}
              >
                ⬇️ Tour roadmap (PDF)
              </button>
              <button
                type="button"
                onClick={() => void downloadPdf("roadmap-short")}
                style={btn("#0d9488")}
              >
                ⬇️ Roadmap — 1-page (PDF)
              </button>
              <button
                type="button"
                onClick={() => void downloadPdf("note-catcher")}
                style={btn("#0891b2")}
              >
                ⬇️ Family note catcher (PDF)
              </button>
              <button
                type="button"
                onClick={() => void downloadPdf("leave-behind")}
                style={btn("#7c3aed")}
              >
                ⬇️ Share Your Feedback page (PDF)
              </button>
            </div>
            <div
              style={{
                fontSize: 12,
                color: "#94a3b8",
                marginBottom: 16,
              }}
            >
              Downloads the PDF — open it from your downloads to print
              (Ctrl/⌘+P).
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

            {/* live tour walk — QR to start, results once captured */}
            {walk && <WalkSection walk={walk} qr={walkQr} />}

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
  checkpoints: TourCheckpointItem[];
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
  // School-level: 'all' sends assignment SMS to the new owner; 'urgent' mutes
  // routine assignment texts (email still goes out).
  tourSmsScope: "all" | "urgent";
  // Phase 2 "never lose a lead" SLA settings.
  tourFirstContactHours: number;
  tourFollowUpBusinessDays: number;
  tourArchiveDays: number;
  tourEscalationEnabled: boolean;
  // Phase 3 "close the loop with families" — automated family nurture cadence.
  tourFamilyNurtureEnabled: boolean;
  tourReminderLeadHours: number;
};

type TourFlyerItem = { key: string; label: string; kind: "image" | "pdf" };

type TourCheckpointItem = {
  key: string;
  label: string;
  location: string;
  talkingPoints: string;
  minutes: number;
  // When true, this stop is added to EVERY tour roadmap regardless of what the
  // family selects (a school highlight). Families see it as "always included."
  alwaysInclude: boolean;
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

// Editor for the admin-configured tour checkpoints. Each row is a stop on the
// campus tour: label (shown to families as a checkbox on the public form),
// plus staff-facing location, talking points, and an estimated duration that
// flow into the printed Tour Roadmap. Keys are assigned server-side; new rows
// send an empty key and the server mints one on save.
function CheckpointEditor({
  items,
  onChange,
}: {
  items: TourCheckpointItem[];
  onChange: (next: TourCheckpointItem[]) => void;
}) {
  const update = (i: number, patch: Partial<TourCheckpointItem>) =>
    onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = items.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 4 }}>
        Tour checkpoints
      </div>
      <div style={{ fontSize: 12, color: "#64748b", marginBottom: 8 }}>
        Stops families can pick on the request form. Location, talking points,
        and minutes are staff-only and print on the Tour Roadmap.
      </div>
      {items.map((c, i) => (
        <div
          key={c.key || i}
          style={{
            border: "1px solid #334155",
            borderRadius: 10,
            padding: 12,
            marginBottom: 10,
          }}
        >
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <input
              style={{ ...inputStyle, fontWeight: 600 }}
              placeholder="Checkpoint label (e.g. STEM / Robotics Lab)"
              value={c.label}
              onChange={(e) => update(i, { label: e.target.value })}
            />
            <button
              type="button"
              onClick={() => move(i, -1)}
              disabled={i === 0}
              title="Move up"
              style={{ ...btn("#334155"), padding: "0 10px", opacity: i === 0 ? 0.4 : 1 }}
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => move(i, 1)}
              disabled={i === items.length - 1}
              title="Move down"
              style={{
                ...btn("#334155"),
                padding: "0 10px",
                opacity: i === items.length - 1 ? 0.4 : 1,
              }}
            >
              ↓
            </button>
            <button
              type="button"
              onClick={() => onChange(items.filter((_, j) => j !== i))}
              title="Remove"
              style={{ ...btn("#7f1d1d"), padding: "0 12px" }}
            >
              ✕
            </button>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "2fr 1fr",
              gap: 6,
              marginBottom: 8,
            }}
          >
            <input
              style={inputStyle}
              placeholder="Location (e.g. Building B, Room 204)"
              value={c.location}
              onChange={(e) => update(i, { location: e.target.value })}
            />
            <input
              style={inputStyle}
              type="number"
              min={0}
              max={240}
              placeholder="Minutes"
              value={c.minutes ? String(c.minutes) : ""}
              onChange={(e) =>
                update(i, {
                  minutes: Math.max(
                    0,
                    Math.min(240, Number.parseInt(e.target.value, 10) || 0),
                  ),
                })
              }
            />
          </div>
          <textarea
            style={{ ...inputStyle, minHeight: 56, resize: "vertical" }}
            placeholder="Talking points for the guide (what to highlight at this stop)"
            value={c.talkingPoints}
            onChange={(e) => update(i, { talkingPoints: e.target.value })}
          />
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 8,
              fontSize: 13,
              color: "#cbd5e1",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={c.alwaysInclude}
              onChange={(e) => update(i, { alwaysInclude: e.target.checked })}
            />
            Always include on every tour (school highlight)
          </label>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          onChange([
            ...items,
            {
              key: "",
              label: "",
              location: "",
              talkingPoints: "",
              minutes: 0,
              alwaysInclude: false,
            },
          ])
        }
        style={{
          border: "none",
          background: "none",
          color: "var(--accent, #2563eb)",
          fontWeight: 600,
          cursor: "pointer",
          padding: 0,
        }}
      >
        + Add checkpoint
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

type BragSaveResult =
  | { ok: true; warnings?: string[]; photos?: string[]; flyers?: TourFlyerItem[] }
  | { ok: false; error: string };

function BragEditor() {
  const [data, setData] = useState<PageData | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const [publicUrl, setPublicUrl] = useState("");
  const [copied, setCopied] = useState(false);

  // Copy the public brag-page URL with visible feedback. navigator.clipboard
  // can be undefined or rejected inside the Replit preview iframe (it requires
  // a secure, allowed context), so fall back to a hidden textarea + execCommand
  // so the button always works and always confirms.
  const copyPublicUrl = async () => {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(publicUrl);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = publicUrl;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ok = document.execCommand("copy");
        ta.remove();
      } catch {
        ok = false;
      }
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  useEffect(() => {
    void (async () => {
      const res = await authFetch("/api/tours/page");
      if (res.ok) {
        const json = (await res.json()) as PageData;
        // Defensive defaults for the new fields so an older API response
        // can't break the uploader UI.
        json.flyers = Array.isArray(json.flyers) ? json.flyers : [];
        json.photos = Array.isArray(json.photos) ? json.photos : [];
        json.checkpoints = (
          Array.isArray(json.checkpoints) ? json.checkpoints : []
        ).map((c) => ({ ...c, alwaysInclude: c.alwaysInclude === true }));
        json.tourSmsScope = json.tourSmsScope === "urgent" ? "urgent" : "all";
        json.tourFirstContactHours = clampNum(json.tourFirstContactHours, 1, 720, 24);
        json.tourFollowUpBusinessDays = clampNum(
          json.tourFollowUpBusinessDays,
          1,
          30,
          3,
        );
        json.tourArchiveDays = clampNum(json.tourArchiveDays, 1, 365, 3);
        json.tourEscalationEnabled = json.tourEscalationEnabled !== false;
        json.tourFamilyNurtureEnabled = json.tourFamilyNurtureEnabled === true;
        json.tourReminderLeadHours = clampNum(
          json.tourReminderLeadHours,
          1,
          168,
          24,
        );
        json.textPlacement = json.textPlacement === "bottom" ? "bottom" : "top";
        json.headerTextColor = /^#[0-9a-fA-F]{6}$/.test(json.headerTextColor)
          ? json.headerTextColor
          : "#ffffff";
        setData(json);
        setPublicUrl(`${window.location.origin}/tour/${json.schoolId}`);
      }
    })();
  }, []);

  const persist = async (payload: PageData): Promise<BragSaveResult> => {
    const res = await authFetch("/api/tours/page", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => null)) as {
      error?: string;
      warnings?: string[];
      photos?: string[];
      flyers?: TourFlyerItem[];
    } | null;
    if (!res.ok) {
      return {
        ok: false,
        error:
          body?.error ??
          "Could not save the brag page. Please try again.",
      };
    }
    return {
      ok: true,
      warnings: body?.warnings,
      photos: body?.photos,
      flyers: body?.flyers,
    };
  };

  const applySaveResult = (result: BragSaveResult) => {
    if (!result.ok) {
      setSaveError(result.error);
      setSaveWarning(null);
      setSaved(false);
      return false;
    }
    setSaveError(null);
    setSaveWarning(result.warnings?.[0] ?? null);
    if (result.photos || result.flyers) {
      setData((cur) =>
        cur
          ? {
              ...cur,
              ...(result.photos ? { photos: result.photos } : {}),
              ...(result.flyers ? { flyers: result.flyers } : {}),
            }
          : cur,
      );
    }
    setSaved(true);
    return true;
  };

  const save = async () => {
    if (!data) return;
    setBusy(true);
    setSaved(false);
    setSaveError(null);
    setSaveWarning(null);
    try {
      applySaveResult(await persist(data));
    } finally {
      setBusy(false);
    }
  };

  // The Live/Hidden toggle saves immediately so flipping it actually
  // publishes (or hides) the page right away — no separate Save needed.
  const togglePublished = async () => {
    if (!data || busy) return;
    const prev = data;
    const next = { ...data, published: !data.published };
    setData(next);
    setBusy(true);
    setSaved(false);
    setSaveError(null);
    setSaveWarning(null);
    try {
      const result = await persist(next);
      if (!applySaveResult(result)) setData(prev);
    } catch {
      setData(prev);
      setSaveError("Could not save the brag page. Please try again.");
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
            onClick={() => void copyPublicUrl()}
            style={{
              ...btn(copied ? "#16a34a" : "#334155"),
              padding: "5px 10px",
              transition: "background 0.2s ease",
            }}
          >
            {copied ? "✓ Copied!" : "Copy"}
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
        <CheckpointEditor
          items={data.checkpoints}
          onChange={(checkpoints) => set({ checkpoints })}
        />

        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}>
            Assignment text alerts
          </div>
          <div style={{ fontSize: 12, color: "#64748b", marginBottom: 8 }}>
            When a tour lead is assigned, the new owner always gets an email.
            Choose whether they also get a text message.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {(
              [
                ["all", "Text on every assignment"],
                ["urgent", "Email only (no routine texts)"],
              ] as const
            ).map(([value, lbl]) => {
              const active = data.tourSmsScope === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => set({ tourSmsScope: value })}
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

        {/* Phase 2 "never lose a lead" SLA settings. */}
        <div
          style={{
            ...cardBox,
            marginBottom: 18,
            borderLeft: "3px solid #db2777",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            Follow-up &amp; escalation
          </div>
          <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>
            Set how long a lead can sit before it counts as overdue, how long the
            “Still deciding” follow-up clock runs, and when closed tours archive
            off the board.
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
            }}
          >
            <label style={{ display: "block" }}>
              <div
                style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}
              >
                First-contact window (hours)
              </div>
              <input
                type="number"
                min={1}
                max={720}
                style={inputStyle}
                value={data.tourFirstContactHours}
                onChange={(e) =>
                  set({
                    tourFirstContactHours: clampNum(
                      e.target.value,
                      1,
                      720,
                      24,
                    ),
                  })
                }
              />
            </label>
            <label style={{ display: "block" }}>
              <div
                style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}
              >
                Follow-up window (business days)
              </div>
              <input
                type="number"
                min={1}
                max={30}
                style={inputStyle}
                value={data.tourFollowUpBusinessDays}
                onChange={(e) =>
                  set({
                    tourFollowUpBusinessDays: clampNum(
                      e.target.value,
                      1,
                      30,
                      3,
                    ),
                  })
                }
              />
            </label>
            <label style={{ display: "block" }}>
              <div
                style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}
              >
                Archive closed tours after (days)
              </div>
              <input
                type="number"
                min={1}
                max={365}
                style={inputStyle}
                value={data.tourArchiveDays}
                onChange={(e) =>
                  set({
                    tourArchiveDays: clampNum(e.target.value, 1, 365, 3),
                  })
                }
              />
            </label>
          </div>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginTop: 14,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={data.tourEscalationEnabled}
              onChange={(e) =>
                set({ tourEscalationEnabled: e.target.checked })
              }
            />
            <span style={{ fontSize: 14 }}>
              Email overdue leads to the owner (CC principal/coordinator)
            </span>
          </label>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginTop: 14,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={data.tourFamilyNurtureEnabled}
              onChange={(e) =>
                set({ tourFamilyNurtureEnabled: e.target.checked })
              }
            />
            <span style={{ fontSize: 14 }}>
              Send families automatic nurture emails (tour reminder, post-tour
              thank-you &amp; survey, "still deciding" check-in, enrollment
              welcome)
            </span>
          </label>
          {data.tourFamilyNurtureEnabled && (
            <label style={{ display: "block", marginTop: 12 }}>
              <div
                style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}
              >
                Send the pre-tour reminder this many hours ahead
              </div>
              <input
                type="number"
                min={1}
                max={168}
                style={{ ...inputStyle, maxWidth: 160 }}
                value={data.tourReminderLeadHours}
                onChange={(e) =>
                  set({
                    tourReminderLeadHours: clampNum(e.target.value, 1, 168, 24),
                  })
                }
              />
            </label>
          )}
        </div>

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

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            style={btn("var(--accent, #2563eb)")}
          >
            {busy ? "Saving…" : "Save brag page"}
          </button>
          {saved && <span style={{ color: "#059669" }}>✓ Saved</span>}
          {saveError && (
            <span style={{ color: "#f87171", fontSize: 13 }}>{saveError}</span>
          )}
          {saveWarning && !saveError && (
            <span style={{ color: "#fbbf24", fontSize: 13 }}>{saveWarning}</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Outcome report
// ---------------------------------------------------------------------------
type GuideRollup = {
  guideId: number;
  guideName: string | null;
  tours: number;
  enrolled: number;
  conversionRate: number | null;
  avgRating: number | null;
  avgResponseMin: number | null;
  walks: number;
  avgMinutes: number | null;
  avgPlannedMinutes: number | null;
};
type Summary = {
  total: number;
  byStatus: Record<string, number>;
  byOutcome: Record<string, number>;
  bySource: Record<string, number>;
  enrolled: number;
  toured: number;
  conversionRate: number;
  walksCompleted: number;
  avgTourMinutes: number | null;
  byGuide: GuideRollup[];
};

function formatResponse(min: number | null): string {
  if (min == null) return "—";
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 1440) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}

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
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 12,
            marginBottom: 12,
          }}
        >
          {tile("Walks completed", s.walksCompleted, "#2563eb")}
          {tile(
            "Avg tour length",
            s.avgTourMinutes != null ? `${s.avgTourMinutes} min` : "—",
            "#7c3aed",
          )}
        </div>
        {s.walksCompleted === 0 && (
          <div style={{ color: "#94a3b8", fontSize: 13 }}>
            Tour-length + pacing fill in once a guide finishes a live walk from
            the roadmap QR.
          </div>
        )}
      </div>

      <div style={{ ...cardBox, marginBottom: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>By tour guide</div>
        <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 10 }}>
          Read with the tour count in mind — a guide with only 1–2 tours is a
          small sample, not a ranking.
        </div>
        {s.byGuide.length === 0 ? (
          <div style={{ color: "#94a3b8" }}>No guide attributed yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 13,
              }}
            >
              <thead>
                <tr style={{ color: "#94a3b8", textAlign: "left" }}>
                  <th style={{ padding: "4px 8px 4px 0" }}>Guide</th>
                  <th style={{ padding: "4px 8px", textAlign: "right" }}>
                    Tours
                  </th>
                  <th style={{ padding: "4px 8px", textAlign: "right" }}>
                    Enrolled
                  </th>
                  <th style={{ padding: "4px 8px", textAlign: "right" }}>
                    Conversion
                  </th>
                  <th style={{ padding: "4px 8px", textAlign: "right" }}>
                    Avg rating
                  </th>
                  <th style={{ padding: "4px 8px", textAlign: "right" }}>
                    Avg response
                  </th>
                  <th style={{ padding: "4px 8px", textAlign: "right" }}>
                    Pacing (act/plan)
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.byGuide.map((g) => (
                  <tr
                    key={g.guideId}
                    style={{ borderTop: "1px solid var(--border, #e2e8f0)" }}
                  >
                    <td style={{ padding: "6px 8px 6px 0", fontWeight: 600 }}>
                      {g.guideName ?? "Unknown guide"}
                    </td>
                    <td style={{ padding: "6px 8px", textAlign: "right" }}>
                      {g.tours}
                    </td>
                    <td style={{ padding: "6px 8px", textAlign: "right" }}>
                      {g.enrolled}
                    </td>
                    <td
                      style={{
                        padding: "6px 8px",
                        textAlign: "right",
                        fontWeight: 700,
                        color:
                          g.conversionRate == null
                            ? "#94a3b8"
                            : g.conversionRate >= 50
                              ? "#059669"
                              : "inherit",
                      }}
                    >
                      {g.conversionRate == null ? "—" : `${g.conversionRate}%`}
                    </td>
                    <td style={{ padding: "6px 8px", textAlign: "right" }}>
                      {g.avgRating == null ? "—" : `${g.avgRating}★`}
                    </td>
                    <td style={{ padding: "6px 8px", textAlign: "right" }}>
                      {formatResponse(g.avgResponseMin)}
                    </td>
                    <td style={{ padding: "6px 8px", textAlign: "right" }}>
                      {g.avgMinutes == null
                        ? "—"
                        : g.avgPlannedMinutes == null
                          ? `${g.avgMinutes}m`
                          : `${g.avgMinutes} / ${g.avgPlannedMinutes}m`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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

// ---------------------------------------------------------------------------
// Feedback tab — every family's post-tour survey + themed "Top wonderings"
// ---------------------------------------------------------------------------
type FeedbackTheme = {
  key: string;
  label: string;
  count: number;
  examples: string[];
};
type FeedbackSurvey = {
  requestId: number;
  familyName: string;
  guideName: string | null;
  rating: number | null;
  liked: string;
  questions: string;
  comments: string;
  submittedAt: string;
};
type FeedbackData = {
  avgRating: number | null;
  surveyCount: number;
  surveys: FeedbackSurvey[];
  themes: FeedbackTheme[];
};

function FeedbackTab() {
  const [d, setD] = useState<FeedbackData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const res = await authFetch("/api/tours/feedback");
        if (res.ok) setD((await res.json()) as FeedbackData);
        else setErr(`Could not load feedback (${res.status}).`);
      } catch {
        setErr("Could not load feedback.");
      }
    })();
  }, []);

  if (err) return <div style={{ color: "#dc2626" }}>{err}</div>;
  if (!d) return <div style={{ color: "#94a3b8" }}>Loading feedback…</div>;

  const fmtDate = (iso: string) => {
    const dt = new Date(iso);
    return isNaN(dt.getTime()) ? "" : dt.toLocaleDateString();
  };

  return (
    <div>
      <style>{`@media print {
        .tours-feedback-noprint { display: none !important; }
        .tours-feedback-card { break-inside: avoid; }
      }`}</style>
      <div
        className="tours-feedback-noprint"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 14,
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: 13, color: "#94a3b8" }}>
          {d.surveyCount === 0
            ? "No post-tour surveys returned yet."
            : `${d.surveyCount} survey${d.surveyCount === 1 ? "" : "s"} returned`}
          {d.avgRating != null && ` · ${d.avgRating}★ average`}
        </div>
        <button
          type="button"
          onClick={() => window.print()}
          style={{
            padding: "8px 16px",
            borderRadius: 9,
            border: "1px solid var(--border, #e2e8f0)",
            background: "var(--accent, #2563eb)",
            color: "#fff",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          🖨️ Print
        </button>
      </div>

      {d.themes.length > 0 && (
        <div style={{ ...cardBox, marginBottom: 16 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            Top wonderings
          </div>
          <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 12 }}>
            What families keep asking — across survey questions, comments, and
            guide walk notes. Prep answers for the ones at the top.
          </div>
          {d.themes.map((t) => (
            <div
              key={t.key}
              className="tours-feedback-card"
              style={{
                padding: "8px 0",
                borderTop: "1px solid var(--border, #e2e8f0)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <strong>{t.label}</strong>
                <span
                  style={{
                    background: "var(--accent, #2563eb)",
                    color: "#fff",
                    borderRadius: 999,
                    padding: "1px 10px",
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  {t.count}
                </span>
              </div>
              {t.examples.length > 0 && (
                <ul
                  style={{
                    margin: "6px 0 0",
                    paddingLeft: 18,
                    fontSize: 13,
                    color: "#64748b",
                  }}
                >
                  {t.examples.map((ex, i) => (
                    <li key={i}>“{ex}”</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ ...cardBox }}>
        <div style={{ fontWeight: 700, marginBottom: 12 }}>
          Every family's survey
        </div>
        {d.surveys.length === 0 ? (
          <div style={{ color: "#94a3b8" }}>
            Surveys appear here once families complete the post-tour survey QR.
          </div>
        ) : (
          d.surveys.map((sv) => (
            <div
              key={sv.requestId}
              className="tours-feedback-card"
              style={{
                padding: "12px 0",
                borderTop: "1px solid var(--border, #e2e8f0)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <strong>{sv.familyName}</strong>
                <span style={{ fontSize: 12, color: "#94a3b8" }}>
                  {sv.guideName ? `Guide: ${sv.guideName} · ` : ""}
                  {fmtDate(sv.submittedAt)}
                </span>
              </div>
              {sv.rating != null && (
                <div style={{ margin: "4px 0", color: "#f59e0b" }}>
                  {"★".repeat(sv.rating)}
                  <span style={{ color: "#cbd5e1" }}>
                    {"★".repeat(Math.max(0, 5 - sv.rating))}
                  </span>
                </div>
              )}
              {sv.liked.trim() && (
                <div style={{ fontSize: 13, marginTop: 4 }}>
                  <span style={{ color: "#94a3b8" }}>Liked: </span>
                  {sv.liked}
                </div>
              )}
              {sv.questions.trim() && (
                <div style={{ fontSize: 13, marginTop: 4 }}>
                  <span style={{ color: "#94a3b8" }}>Still wondering: </span>
                  {sv.questions}
                </div>
              )}
              {sv.comments.trim() && (
                <div style={{ fontSize: 13, marginTop: 4 }}>
                  <span style={{ color: "#94a3b8" }}>Comments: </span>
                  {sv.comments}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
