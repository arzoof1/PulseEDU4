import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { authFetch } from "../lib/authToken";

// =============================================================================
// TicketingAdminPage — front-office admin module for the Event Ticketing
// feature. Mounted as the Settings → "Event Tickets" tile (family-signage
// group). Mirrors the Tours module pattern: authFetch directly (no OpenAPI
// codegen), inline styles matching the staff app.
//
// Flow: create an event → allocate a per-student quota by grade (with
// overrides/excludes) → review the preview → commit (generates tokens) →
// send (one separate email per student) → work the "couldn't send" list with
// the office handout PDFs → mint a no-login scanner link for volunteers →
// watch the live "X of Y admitted" board at the gate.
// =============================================================================

type EventStatus = "draft" | "published" | "closed";

type EventSummary = {
  grants: number;
  allocated: number;
  tickets: number;
  used: number;
  emailed: number;
  noEmail: number;
  failed: number;
  printed: number;
};

type TicketEvent = {
  id: number;
  name: string;
  description: string | null;
  eventDate: string | null;
  startTime: string | null;
  location: string | null;
  capacity: number | null;
  status: EventStatus;
  eventDayOnly: boolean;
  createdAt: string;
  updatedAt: string;
  summary: EventSummary | null;
};

type Grant = {
  grantId: number;
  studentId: number;
  studentExtId: string;
  name: string;
  grade: number | null;
  quota: number;
  guardianEmail: string | null;
  guardianName: string | null;
  hasEmail: boolean;
  emailStatus: string;
  emailSentAt: string | null;
  emailError: string | null;
  printedAt: string | null;
  ticketsTotal: number;
  ticketsUsed: number;
};

type PreviewRow = {
  studentId: number;
  studentExtId: string;
  name: string;
  grade: number;
  guardianEmail: string | null;
  guardianName: string | null;
  hasEmail: boolean;
  quota: number;
};

type ScannerLink = {
  id: number;
  eventId: number;
  label: string;
  gateLabel: string | null;
  active: boolean;
  createdAt: string;
  deactivatedAt: string | null;
  scanUrl?: string;
};

// The same responsibility message families receive on email + PDF + portal,
// shown here so the office knows exactly what each guardian is told.
const RESPONSIBILITY_HEADLINE =
  "One scan = admitted. Please protect these codes.";
const RESPONSIBILITY_LINES = [
  "Each code can be scanned ONCE. The first scan is admitted at the door; any later scan of the same code is turned away as “already used.”",
  "Codes are yours to share with the family attending together — but whoever holds a code can use it. If the same code reaches more than one person, only the first to arrive gets in.",
  "Treat each code like a cash ticket. Screenshots, printouts, and the PDF all scan the same, so only share what you mean to give away.",
];

async function downloadPdf(url: string, fallbackName: string) {
  // Authed PDFs/blobs can't open in the preview iframe (session cookie is
  // blocked; window.open(blob) renders blank). Download to disk instead —
  // see replit.md Gotchas.
  const res = await authFetch(url);
  if (!res.ok) {
    alert(`Could not generate PDF (${res.status})`);
    return;
  }
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") || "";
  const m = disposition.match(/filename="([^"]+)"/);
  const name = m?.[1] || fallbackName;
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

export default function TicketingAdminPage() {
  const [events, setEvents] = useState<TicketEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await authFetch("/api/ticketing/events");
      if (!res.ok) {
        setErr(`Could not load events (${res.status})`);
        return;
      }
      const data = (await res.json()) as { events: TicketEvent[] };
      setEvents(data.events);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  if (openId !== null) {
    return (
      <EventDetail
        eventId={openId}
        onBack={() => {
          setOpenId(null);
          void loadEvents();
        }}
      />
    );
  }

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Event Tickets</h2>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        Free-ticket events (8th-grade promotion, graduation, etc.). Allocate a
        per-student quota by grade, email each guardian their QR tickets, and
        scan at the gate.
      </p>

      <ResponsibilityCard />

      <CreateEventForm onCreated={(id) => setOpenId(id)} />

      {err && <div style={errBox}>{err}</div>}
      {loading ? (
        <div style={{ color: "var(--text-subtle)" }}>Loading events…</div>
      ) : events.length === 0 ? (
        <div style={{ color: "var(--text-subtle)" }}>
          No events yet. Create your first event above.
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {events.map((ev) => (
            <EventCard key={ev.id} ev={ev} onOpen={() => setOpenId(ev.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ResponsibilityCard() {
  return (
    <div
      style={{
        border: "1px solid var(--border, #2a3447)",
        borderLeft: "3px solid #6366f1",
        borderRadius: 8,
        padding: "0.75rem 0.9rem",
        margin: "0.75rem 0 1rem",
        background: "rgba(99,102,241,0.06)",
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 4 }}>
        What families are told: {RESPONSIBILITY_HEADLINE}
      </div>
      <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: 13 }}>
        {RESPONSIBILITY_LINES.map((l, i) => (
          <li key={i} style={{ marginBottom: 2 }}>
            {l}
          </li>
        ))}
      </ul>
      <div style={{ fontSize: 12, color: "var(--text-subtle)", marginTop: 6 }}>
        This exact wording appears on the email, the printable PDF, and the
        Parent Portal.
      </div>
    </div>
  );
}

const STATUS_META: Record<EventStatus, { label: string; color: string }> = {
  draft: { label: "Draft", color: "#64748b" },
  published: { label: "Published", color: "#16a34a" },
  closed: { label: "Closed", color: "#b45309" },
};

function StatusPill({ status }: { status: EventStatus }) {
  const m = STATUS_META[status];
  return (
    <span
      style={{
        background: m.color,
        color: "#fff",
        borderRadius: 999,
        padding: "0.1rem 0.55rem",
        fontSize: 12,
        fontWeight: 700,
      }}
    >
      {m.label}
    </span>
  );
}

function EventCard({ ev, onOpen }: { ev: TicketEvent; onOpen: () => void }) {
  const s = ev.summary;
  const attendancePct =
    s && s.tickets > 0 ? Math.round((s.used / s.tickets) * 100) : 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        ...cardBtn,
        textAlign: "left",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem",
        }}
      >
        <div style={{ fontWeight: 700, fontSize: "1.05rem" }}>{ev.name}</div>
        <StatusPill status={ev.status} />
      </div>
      <div style={{ fontSize: 13, color: "var(--text-subtle)", marginTop: 2 }}>
        {ev.eventDate || "No date set"}
        {ev.startTime ? ` · ${ev.startTime}` : ""}
        {ev.location ? ` · ${ev.location}` : ""}
        {ev.capacity !== null ? ` · cap ${ev.capacity}` : ""}
      </div>
      {s && (
        <div style={statRow}>
          <Stat label="Students" value={s.grants} />
          <Stat label="Tickets" value={s.tickets} />
          <Stat label="Emailed" value={s.emailed} />
          <Stat label="No email" value={s.noEmail} warn={s.noEmail > 0} />
          <Stat label="Failed" value={s.failed} warn={s.failed > 0} />
          <Stat
            label="Admitted"
            value={`${s.used}${s.tickets ? ` (${attendancePct}%)` : ""}`}
          />
        </div>
      )}
    </button>
  );
}

function Stat({
  label,
  value,
  warn,
}: {
  label: string;
  value: number | string;
  warn?: boolean;
}) {
  return (
    <div style={{ minWidth: 70 }}>
      <div
        style={{
          fontWeight: 700,
          fontSize: 16,
          color: warn ? "#dc2626" : "inherit",
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-subtle)" }}>{label}</div>
    </div>
  );
}

function CreateEventForm({ onCreated }: { onCreated: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [location, setLocation] = useState("");
  const [capacity, setCapacity] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) {
      setErr("Event name is required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await authFetch("/api/ticketing/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          eventDate: eventDate || null,
          startTime: startTime || null,
          location: location || null,
          capacity: capacity ? Number(capacity) : null,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setErr(data.error || `Create failed (${res.status})`);
        return;
      }
      const data = (await res.json()) as { event: TicketEvent };
      onCreated(data.event.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{ ...primaryBtn, marginBottom: "1rem" }}
      >
        + Create event
      </button>
    );
  }

  return (
    <div style={panel}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>New event</div>
      <div style={formGrid}>
        <Field label="Event name *">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="8th Grade Promotion"
            style={input}
          />
        </Field>
        <Field label="Date">
          <input
            type="date"
            value={eventDate}
            onChange={(e) => setEventDate(e.target.value)}
            style={input}
          />
        </Field>
        <Field label="Start time">
          <input
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            placeholder="6:00 PM"
            style={input}
          />
        </Field>
        <Field label="Location">
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Main gym"
            style={input}
          />
        </Field>
        <Field label="Capacity (optional)">
          <input
            type="number"
            min={0}
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            placeholder="No cap"
            style={input}
          />
        </Field>
      </div>
      {err && <div style={errBox}>{err}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          style={primaryBtn}
        >
          {busy ? "Creating…" : "Create event"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          style={secondaryBtn}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// Event detail
// ===========================================================================
function EventDetail({
  eventId,
  onBack,
}: {
  eventId: number;
  onBack: () => void;
}) {
  const [ev, setEv] = useState<TicketEvent | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busyMsg, setBusyMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await authFetch(`/api/ticketing/events/${eventId}`);
      if (!res.ok) {
        setErr(`Could not load event (${res.status})`);
        return;
      }
      const data = (await res.json()) as { event: TicketEvent; grants: Grant[] };
      setEv(data.event);
      setGrants(data.grants);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  const patchEvent = async (patch: Record<string, unknown>) => {
    const res = await authFetch(`/api/ticketing/events/${eventId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) await load();
    else alert(`Update failed (${res.status})`);
  };

  if (loading && !ev) {
    return (
      <div className="card">
        <BackBar onBack={onBack} />
        <div style={{ color: "var(--text-subtle)" }}>Loading…</div>
      </div>
    );
  }
  if (!ev) {
    return (
      <div className="card">
        <BackBar onBack={onBack} />
        <div style={errBox}>{err || "Event not found"}</div>
      </div>
    );
  }

  const s = ev.summary;

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <BackBar onBack={onBack} />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.5rem",
          flexWrap: "wrap",
        }}
      >
        <h2 style={{ margin: 0 }}>{ev.name}</h2>
        <StatusPill status={ev.status} />
      </div>
      <div style={{ fontSize: 13, color: "var(--text-subtle)", marginTop: 4 }}>
        {ev.eventDate || "No date"}
        {ev.startTime ? ` · ${ev.startTime}` : ""}
        {ev.location ? ` · ${ev.location}` : ""}
      </div>

      {busyMsg && <div style={infoBox}>{busyMsg}</div>}
      {err && <div style={errBox}>{err}</div>}

      {/* Live attendance board */}
      <LiveBoard eventId={eventId} capacity={ev.capacity} />

      {/* Event controls */}
      <div style={panel}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Event settings</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {ev.status !== "published" && (
            <button
              type="button"
              style={primaryBtn}
              onClick={() => patchEvent({ status: "published" })}
            >
              Publish
            </button>
          )}
          {ev.status === "published" && (
            <button
              type="button"
              style={secondaryBtn}
              onClick={() => patchEvent({ status: "closed" })}
            >
              Close event
            </button>
          )}
          {ev.status === "closed" && (
            <button
              type="button"
              style={secondaryBtn}
              onClick={() => patchEvent({ status: "published" })}
            >
              Re-open
            </button>
          )}
          <CapacityEditor
            current={ev.capacity}
            onSave={(c) => patchEvent({ capacity: c })}
          />
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
            }}
          >
            <input
              type="checkbox"
              checked={ev.eventDayOnly}
              onChange={(e) => patchEvent({ eventDayOnly: e.target.checked })}
            />
            Valid on event day only
          </label>
        </div>
      </div>

      {/* Allocation */}
      <AllocationPanel
        eventId={eventId}
        onCommitted={async () => {
          setBusyMsg(null);
          await load();
        }}
      />

      {/* Delivery */}
      {s && s.grants > 0 && (
        <DeliveryPanel
          eventId={eventId}
          event={ev}
          summary={s}
          onChanged={load}
          setBusyMsg={setBusyMsg}
        />
      )}

      {/* Scanner links */}
      <ScannerLinksPanel eventId={eventId} />

      {/* Grants table */}
      {grants.length > 0 && (
        <GrantsTable eventId={eventId} grants={grants} event={ev} onChanged={load} />
      )}
    </div>
  );
}

function LiveBoard({
  eventId,
  capacity,
}: {
  eventId: number;
  capacity: number | null;
}) {
  const [counts, setCounts] = useState<{
    admitted: number;
    total: number;
    capacity: number | null;
    capacityWarning: boolean;
    atCapacity: boolean;
    overCapacity: boolean;
  } | null>(null);

  const refresh = useCallback(async () => {
    const res = await authFetch(`/api/ticketing/events/${eventId}/counts`);
    if (res.ok) setCounts(await res.json());
  }, [eventId]);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(refresh, 5000);
    return () => window.clearInterval(t);
  }, [refresh]);

  if (!counts) return null;
  const cap = counts.capacity ?? capacity;
  const warn = counts.overCapacity
    ? { txt: "OVER CAPACITY", bg: "#dc2626" }
    : counts.atCapacity
      ? { txt: "AT CAPACITY", bg: "#dc2626" }
      : counts.capacityWarning
        ? { txt: "NEARLY FULL", bg: "#b45309" }
        : null;
  return (
    <div
      style={{
        ...panel,
        display: "flex",
        alignItems: "center",
        gap: 16,
        flexWrap: "wrap",
      }}
    >
      <div>
        <div style={{ fontSize: 28, fontWeight: 800 }}>
          {counts.admitted}
          {cap !== null ? (
            <span style={{ fontSize: 18, color: "var(--text-subtle)" }}>
              {" "}
              / {cap}
            </span>
          ) : (
            <span style={{ fontSize: 18, color: "var(--text-subtle)" }}>
              {" "}
              admitted
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-subtle)" }}>
          {cap !== null ? "Admitted of capacity" : `${counts.total} tickets issued`}
          {" · updates live"}
        </div>
      </div>
      {warn && (
        <span
          style={{
            background: warn.bg,
            color: "#fff",
            borderRadius: 999,
            padding: "0.25rem 0.75rem",
            fontSize: 13,
            fontWeight: 700,
          }}
        >
          {warn.txt}
        </span>
      )}
    </div>
  );
}

function CapacityEditor({
  current,
  onSave,
}: {
  current: number | null;
  onSave: (c: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(current?.toString() ?? "");
  if (!editing) {
    return (
      <button
        type="button"
        style={secondaryBtn}
        onClick={() => {
          setVal(current?.toString() ?? "");
          setEditing(true);
        }}
      >
        {current !== null ? `Capacity: ${current}` : "Set capacity"}
      </button>
    );
  }
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <input
        type="number"
        min={0}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder="No cap"
        style={{ ...input, width: 110 }}
      />
      <button
        type="button"
        style={primaryBtn}
        onClick={() => {
          onSave(val ? Number(val) : null);
          setEditing(false);
        }}
      >
        Save
      </button>
      <button
        type="button"
        style={secondaryBtn}
        onClick={() => setEditing(false)}
      >
        Cancel
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------
const GRADE_OPTIONS = [
  { v: 0, label: "K" },
  ...Array.from({ length: 12 }, (_, i) => ({ v: i + 1, label: `${i + 1}` })),
];

function AllocationPanel({
  eventId,
  onCommitted,
}: {
  eventId: number;
  onCommitted: () => void | Promise<void>;
}) {
  const [grades, setGrades] = useState<Set<number>>(new Set());
  const [quota, setQuota] = useState("4");
  const [rows, setRows] = useState<PreviewRow[] | null>(null);
  const [overrides, setOverrides] = useState<Map<number, number>>(new Map());
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const toggleGrade = (g: number) => {
    setGrades((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  };

  const buildBody = () => ({
    grades: [...grades],
    quota: Number(quota),
    overrides: [...overrides.entries()].map(([studentId, q]) => ({
      studentId,
      quota: q,
    })),
    excludeStudentIds: [...excluded],
  });

  const preview = async () => {
    if (grades.size === 0) {
      setErr("Select at least one grade");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await authFetch(
        `/api/ticketing/events/${eventId}/allocate/preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildBody()),
        },
      );
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(d.error || `Preview failed (${res.status})`);
        return;
      }
      const data = (await res.json()) as { rows: PreviewRow[] };
      setRows(data.rows);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await authFetch(
        `/api/ticketing/events/${eventId}/allocate/commit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildBody()),
        },
      );
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(d.error || `Commit failed (${res.status})`);
        return;
      }
      setRows(null);
      setOverrides(new Map());
      setExcluded(new Set());
      await onCommitted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const totals = useMemo(() => {
    if (!rows) return null;
    const active = rows.filter((r) => !excluded.has(r.studentId));
    const tickets = active.reduce(
      (acc, r) => acc + (overrides.get(r.studentId) ?? r.quota),
      0,
    );
    return {
      students: active.length,
      tickets,
      withEmail: active.filter((r) => r.hasEmail).length,
      withoutEmail: active.filter((r) => !r.hasEmail).length,
    };
  }, [rows, overrides, excluded]);

  if (!open) {
    return (
      <div style={panel}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={{ fontWeight: 700 }}>Allocate tickets</div>
          <button type="button" style={primaryBtn} onClick={() => setOpen(true)}>
            Allocate by grade
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={panel}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>Allocate tickets</div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 13, marginBottom: 4 }}>Grades</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {GRADE_OPTIONS.map((g) => (
            <button
              key={g.v}
              type="button"
              onClick={() => toggleGrade(g.v)}
              style={{
                ...chip,
                background: grades.has(g.v) ? "#4338ca" : "transparent",
                color: grades.has(g.v) ? "#fff" : "inherit",
              }}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>
      <Field label="Tickets per student (default quota)">
        <input
          type="number"
          min={0}
          max={50}
          value={quota}
          onChange={(e) => setQuota(e.target.value)}
          style={{ ...input, width: 120 }}
        />
      </Field>
      {err && <div style={errBox}>{err}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button type="button" style={secondaryBtn} onClick={preview} disabled={busy}>
          {busy ? "Working…" : "Preview"}
        </button>
        {rows && (
          <button type="button" style={primaryBtn} onClick={commit} disabled={busy}>
            {busy ? "Working…" : `Commit allocation`}
          </button>
        )}
        <button type="button" style={secondaryBtn} onClick={() => setOpen(false)}>
          Close
        </button>
      </div>

      {rows && totals && (
        <div style={{ marginTop: 12 }}>
          <div style={statRow}>
            <Stat label="Students" value={totals.students} />
            <Stat label="Tickets" value={totals.tickets} />
            <Stat label="With email" value={totals.withEmail} />
            <Stat
              label="No email"
              value={totals.withoutEmail}
              warn={totals.withoutEmail > 0}
            />
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-subtle)",
              margin: "4px 0 8px",
            }}
          >
            Adjust a single student's quota or exclude them below. Committing is
            idempotent — re-running keeps already-issued codes stable.
          </div>
          <div style={{ maxHeight: 320, overflow: "auto" }}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={th}>Student</th>
                  <th style={th}>Gr</th>
                  <th style={th}>Email?</th>
                  <th style={th}>Quota</th>
                  <th style={th}>Exclude</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isExcluded = excluded.has(r.studentId);
                  return (
                    <tr key={r.studentId} style={{ opacity: isExcluded ? 0.4 : 1 }}>
                      <td style={td}>{r.name}</td>
                      <td style={td}>{r.grade === 0 ? "K" : r.grade}</td>
                      <td style={td}>
                        {r.hasEmail ? (
                          "✓"
                        ) : (
                          <span style={{ color: "#dc2626" }}>none</span>
                        )}
                      </td>
                      <td style={td}>
                        <input
                          type="number"
                          min={0}
                          max={50}
                          value={overrides.get(r.studentId) ?? r.quota}
                          disabled={isExcluded}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            setOverrides((prev) => {
                              const next = new Map(prev);
                              next.set(r.studentId, v);
                              return next;
                            });
                          }}
                          style={{ ...input, width: 64, padding: "4px 6px" }}
                        />
                      </td>
                      <td style={td}>
                        <input
                          type="checkbox"
                          checked={isExcluded}
                          onChange={(e) => {
                            setExcluded((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(r.studentId);
                              else next.delete(r.studentId);
                              return next;
                            });
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delivery (send + handouts + report)
// ---------------------------------------------------------------------------
type DeliveryReport = {
  counts: {
    total: number;
    noEmail: number;
    failed: number;
    pending: number;
    printed: number;
  };
  undelivered: Array<{
    grantId: number;
    name: string;
    grade: number | null;
    quota: number;
    guardianEmail: string | null;
    emailStatus: string;
    reason: string;
  }>;
};

function DeliveryPanel({
  eventId,
  event,
  summary,
  onChanged,
  setBusyMsg,
}: {
  eventId: number;
  event: TicketEvent;
  summary: EventSummary;
  onChanged: () => void | Promise<void>;
  setBusyMsg: (m: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<DeliveryReport | null>(null);

  const send = async (resendSent: boolean) => {
    if (
      !confirm(
        resendSent
          ? "Re-send to EVERY guardian (including those already sent)?"
          : "Send tickets to all guardians who haven't received them yet?",
      )
    )
      return;
    setBusy(true);
    setBusyMsg("Sending emails…");
    try {
      const res = await authFetch(`/api/ticketing/events/${eventId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resendSent }),
      });
      if (res.ok) {
        const d = (await res.json()) as {
          sent: number;
          skipped: number;
          failed: number;
          noEmail: number;
        };
        setBusyMsg(
          `Sent ${d.sent} · skipped ${d.skipped} · failed ${d.failed} · no email ${d.noEmail}`,
        );
      } else {
        setBusyMsg(`Send failed (${res.status})`);
      }
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const loadReport = async () => {
    const res = await authFetch(
      `/api/ticketing/events/${eventId}/report/delivery`,
    );
    if (res.ok) setReport(await res.json());
  };

  return (
    <div style={panel}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>Delivery</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button
          type="button"
          style={primaryBtn}
          disabled={busy}
          onClick={() => send(false)}
        >
          Email tickets to guardians
        </button>
        <button
          type="button"
          style={secondaryBtn}
          disabled={busy}
          onClick={() => send(true)}
        >
          Re-send to everyone
        </button>
        <button
          type="button"
          style={secondaryBtn}
          onClick={() =>
            downloadPdf(
              `/api/ticketing/events/${eventId}/handout.pdf`,
              `handout-no-email.pdf`,
            )
          }
        >
          Office handout (no-email families)
        </button>
        <button
          type="button"
          style={secondaryBtn}
          onClick={() =>
            downloadPdf(
              `/api/ticketing/events/${eventId}/handout.pdf?all=1`,
              `handout-all.pdf`,
            )
          }
        >
          Print ALL families
        </button>
        <button type="button" style={secondaryBtn} onClick={loadReport}>
          Couldn’t-send report
        </button>
      </div>
      <div style={{ fontSize: 12, color: "var(--text-subtle)", marginTop: 8 }}>
        Each student gets a SEPARATE email (siblings get one each). Families with
        no email on file appear on the handout + report so the office can hand
        them paper tickets.
      </div>

      {report && (
        <div style={{ marginTop: 12 }}>
          <div style={statRow}>
            <Stat label="Undelivered" value={report.undelivered.length} />
            <Stat label="No email" value={report.counts.noEmail} warn={report.counts.noEmail > 0} />
            <Stat label="Failed" value={report.counts.failed} warn={report.counts.failed > 0} />
            <Stat label="Pending" value={report.counts.pending} />
            <Stat label="Printed" value={report.counts.printed} />
          </div>
          {report.undelivered.length === 0 ? (
            <div style={{ color: "#16a34a", fontSize: 13 }}>
              Everyone with an email reached an inbox. 🎉
            </div>
          ) : (
            <div style={{ maxHeight: 280, overflow: "auto" }}>
              <table style={table}>
                <thead>
                  <tr>
                    <th style={th}>Student</th>
                    <th style={th}>Gr</th>
                    <th style={th}>Reason</th>
                    <th style={th}>Print</th>
                  </tr>
                </thead>
                <tbody>
                  {report.undelivered.map((r) => (
                    <tr key={r.grantId}>
                      <td style={td}>{r.name}</td>
                      <td style={td}>{r.grade === 0 ? "K" : r.grade}</td>
                      <td style={td}>{r.reason}</td>
                      <td style={td}>
                        <button
                          type="button"
                          style={miniBtn}
                          onClick={() =>
                            downloadPdf(
                              `/api/ticketing/grants/${r.grantId}/tickets.pdf`,
                              `tickets.pdf`,
                            )
                          }
                        >
                          PDF
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scanner links
// ---------------------------------------------------------------------------
function ScannerLinksPanel({ eventId }: { eventId: number }) {
  const [links, setLinks] = useState<ScannerLink[]>([]);
  const [newUrl, setNewUrl] = useState<string | null>(null);
  const [label, setLabel] = useState("Gate scanner");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await authFetch(
      `/api/ticketing/events/${eventId}/scanner-links`,
    );
    if (res.ok) {
      const d = (await res.json()) as { links: ScannerLink[] };
      setLinks(d.links);
    }
  }, [eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      const res = await authFetch(
        `/api/ticketing/events/${eventId}/scanner-links`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: label.trim() || "Gate scanner" }),
        },
      );
      if (res.ok) {
        const d = (await res.json()) as { link: ScannerLink };
        setNewUrl(d.link.scanUrl ?? null);
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async (id: number) => {
    if (!confirm("Deactivate this scanner link? Volunteers using it lose access."))
      return;
    const res = await authFetch(
      `/api/ticketing/scanner-links/${id}/deactivate`,
      { method: "POST" },
    );
    if (res.ok) await load();
  };

  return (
    <div style={panel}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>
        Volunteer scanner links (no login)
      </div>
      <div style={{ fontSize: 12, color: "var(--text-subtle)", marginBottom: 8 }}>
        Mint a link a volunteer opens on their own phone — no sign-in. Anyone
        with the link can scan this event's gate. Deactivate it after the event.
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (e.g. Main gate)"
          style={{ ...input, maxWidth: 220 }}
        />
        <button type="button" style={primaryBtn} disabled={busy} onClick={create}>
          {busy ? "…" : "Create link"}
        </button>
      </div>

      {newUrl && (
        <div style={{ ...infoBox, marginTop: 8 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            New scanner link (copy it now — it isn’t shown again):
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <code
              style={{
                flex: 1,
                wordBreak: "break-all",
                fontSize: 12,
                background: "rgba(0,0,0,0.2)",
                padding: "4px 6px",
                borderRadius: 6,
              }}
            >
              {newUrl}
            </code>
            <button
              type="button"
              style={miniBtn}
              onClick={() => {
                void navigator.clipboard?.writeText(newUrl);
              }}
            >
              Copy
            </button>
          </div>
        </div>
      )}

      {links.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Label</th>
                <th style={th}>Status</th>
                <th style={th}>Created</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.id}>
                  <td style={td}>{l.label}</td>
                  <td style={td}>
                    {l.active ? (
                      <span style={{ color: "#16a34a" }}>Active</span>
                    ) : (
                      <span style={{ color: "var(--text-subtle)" }}>
                        Deactivated
                      </span>
                    )}
                  </td>
                  <td style={td}>
                    {new Date(l.createdAt).toLocaleDateString()}
                  </td>
                  <td style={td}>
                    {l.active && (
                      <button
                        type="button"
                        style={dangerMiniBtn}
                        onClick={() => deactivate(l.id)}
                      >
                        Deactivate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grants table (per-student)
// ---------------------------------------------------------------------------
const EMAIL_STATUS_META: Record<string, { label: string; color: string }> = {
  sent: { label: "Sent", color: "#16a34a" },
  pending: { label: "Pending", color: "#64748b" },
  no_email: { label: "No email", color: "#dc2626" },
  failed: { label: "Failed", color: "#dc2626" },
  bounced: { label: "Bounced", color: "#dc2626" },
  printed: { label: "Printed", color: "#0891b2" },
};

function GrantsTable({
  eventId,
  grants,
  event,
  onChanged,
}: {
  eventId: number;
  grants: Grant[];
  event: TicketEvent;
  onChanged: () => void | Promise<void>;
}) {
  const [filter, setFilter] = useState("");
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return grants;
    return grants.filter((g) => g.name.toLowerCase().includes(q));
  }, [grants, filter]);

  const exportCsv = () => {
    const header = [
      "student_id",
      "name",
      "grade",
      "guardian_email",
      "email_status",
      "tickets_total",
      "tickets_used",
      "printed",
    ];
    const lines = grants.map((g) =>
      [
        g.studentExtId,
        `"${g.name.replace(/"/g, '""')}"`,
        g.grade ?? "",
        g.guardianEmail ?? "",
        g.emailStatus,
        g.ticketsTotal,
        g.ticketsUsed,
        g.printedAt ? "yes" : "no",
      ].join(","),
    );
    const csv = [header.join(","), ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `attendees-${event.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const sendOne = async (grantId: number) => {
    const res = await authFetch(`/api/ticketing/grants/${grantId}/send`, {
      method: "POST",
    });
    if (res.ok) await onChanged();
    else alert(`Send failed (${res.status})`);
  };

  const voidGrant = async (grantId: number) => {
    if (!confirm("Void this family's UNUSED tickets? Used tickets are kept."))
      return;
    const res = await authFetch(`/api/ticketing/grants/${grantId}/void`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (res.ok) await onChanged();
  };

  const reissue = async (grantId: number) => {
    if (
      !confirm(
        "Reissue? This voids all current valid codes and mints fresh ones (used tickets untouched). The family must be re-sent or re-printed.",
      )
    )
      return;
    const res = await authFetch(`/api/ticketing/grants/${grantId}/reissue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (res.ok) await onChanged();
  };

  return (
    <div style={panel}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <div style={{ fontWeight: 700 }}>Students ({grants.length})</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name"
            style={{ ...input, maxWidth: 200 }}
          />
          <button type="button" style={secondaryBtn} onClick={exportCsv}>
            Export CSV
          </button>
        </div>
      </div>
      <div style={{ maxHeight: 460, overflow: "auto" }}>
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>Student</th>
              <th style={th}>Gr</th>
              <th style={th}>Email</th>
              <th style={th}>Status</th>
              <th style={th}>Used</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((g) => {
              const m =
                EMAIL_STATUS_META[g.emailStatus] ?? {
                  label: g.emailStatus,
                  color: "#64748b",
                };
              return (
                <tr key={g.grantId}>
                  <td style={td}>{g.name}</td>
                  <td style={td}>{g.grade === 0 ? "K" : g.grade}</td>
                  <td style={{ ...td, fontSize: 12 }}>
                    {g.guardianEmail || (
                      <span style={{ color: "#dc2626" }}>none</span>
                    )}
                  </td>
                  <td style={td}>
                    <span style={{ color: m.color, fontWeight: 600 }}>
                      {m.label}
                    </span>
                  </td>
                  <td style={td}>
                    {g.ticketsUsed}/{g.ticketsTotal}
                  </td>
                  <td style={td}>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        style={miniBtn}
                        onClick={() =>
                          downloadPdf(
                            `/api/ticketing/grants/${g.grantId}/tickets.pdf`,
                            `tickets-${g.name}.pdf`,
                          )
                        }
                      >
                        Print
                      </button>
                      {g.hasEmail && (
                        <button
                          type="button"
                          style={miniBtn}
                          onClick={() => sendOne(g.grantId)}
                        >
                          Send
                        </button>
                      )}
                      <button
                        type="button"
                        style={miniBtn}
                        onClick={() => reissue(g.grantId)}
                      >
                        Reissue
                      </button>
                      <button
                        type="button"
                        style={dangerMiniBtn}
                        onClick={() => voidGrant(g.grantId)}
                      >
                        Void
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------
function BackBar({ onBack }: { onBack: () => void }) {
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <button type="button" onClick={onBack} style={secondaryBtn}>
        ← All events
      </button>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block", fontSize: 13 }}>
      <div style={{ marginBottom: 4, color: "var(--text-subtle)" }}>{label}</div>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const cardBtn: CSSProperties = {
  display: "block",
  width: "100%",
  padding: "0.85rem 1rem",
  border: "1px solid var(--border, #2a3447)",
  borderRadius: 10,
  background: "var(--card-bg, rgba(255,255,255,0.03))",
  color: "inherit",
  font: "inherit",
  cursor: "pointer",
};
const panel: CSSProperties = {
  border: "1px solid var(--border, #2a3447)",
  borderRadius: 10,
  padding: "0.9rem 1rem",
  margin: "1rem 0",
  background: "var(--card-bg, rgba(255,255,255,0.02))",
};
const statRow: CSSProperties = {
  display: "flex",
  gap: 18,
  marginTop: 8,
  flexWrap: "wrap",
};
const formGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
  gap: "0.75rem",
};
const input: CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.6rem",
  borderRadius: 8,
  border: "1px solid var(--border, #334155)",
  background: "var(--input-bg, #0f172a)",
  color: "inherit",
  font: "inherit",
};
const primaryBtn: CSSProperties = {
  padding: "0.5rem 0.9rem",
  borderRadius: 8,
  border: "none",
  background: "#4338ca",
  color: "#fff",
  fontWeight: 600,
  cursor: "pointer",
};
const secondaryBtn: CSSProperties = {
  padding: "0.5rem 0.9rem",
  borderRadius: 8,
  border: "1px solid var(--border, #334155)",
  background: "transparent",
  color: "inherit",
  fontWeight: 600,
  cursor: "pointer",
};
const miniBtn: CSSProperties = {
  padding: "0.25rem 0.5rem",
  borderRadius: 6,
  border: "1px solid var(--border, #334155)",
  background: "transparent",
  color: "inherit",
  fontSize: 12,
  cursor: "pointer",
};
const dangerMiniBtn: CSSProperties = {
  ...miniBtn,
  borderColor: "#dc2626",
  color: "#dc2626",
};
const chip: CSSProperties = {
  padding: "0.3rem 0.7rem",
  borderRadius: 999,
  border: "1px solid var(--border, #334155)",
  cursor: "pointer",
  font: "inherit",
  fontSize: 13,
};
const table: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
};
const th: CSSProperties = {
  textAlign: "left",
  padding: "0.4rem 0.5rem",
  borderBottom: "1px solid var(--border, #2a3447)",
  color: "var(--text-subtle)",
  fontSize: 12,
  position: "sticky",
  top: 0,
  background: "var(--card-bg, #111827)",
};
const td: CSSProperties = {
  padding: "0.4rem 0.5rem",
  borderBottom: "1px solid var(--border, #1f2937)",
};
const errBox: CSSProperties = {
  background: "rgba(220,38,38,0.1)",
  border: "1px solid #dc2626",
  color: "#fca5a5",
  borderRadius: 8,
  padding: "0.5rem 0.7rem",
  margin: "0.5rem 0",
  fontSize: 13,
};
const infoBox: CSSProperties = {
  background: "rgba(8,145,178,0.1)",
  border: "1px solid #0891b2",
  borderRadius: 8,
  padding: "0.5rem 0.7rem",
  margin: "0.5rem 0",
  fontSize: 13,
};
