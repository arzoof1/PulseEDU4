import { useEffect, useState } from "react";
import { Plus, Clock, CheckCircle2, XCircle, MinusCircle } from "lucide-react";
import { authFetch } from "../../lib/authToken";

// Investigators record "we know we need this video" here.
// PulseEDU does NOT request footage on the user's behalf — schools
// route those asks over Microsoft Teams DM (or walkie to the bus
// garage) and there is no Teams integration today. This panel
// exists purely so a stale case immediately shows the gap and a
// timestamped record of who asked for what.
//
// Same admin-only audience as the video evidence panel — server
// gates every route behind `isCaseInvestigator`.

const SOURCES = [
  { value: "bus", label: "Bus" },
  { value: "hallway_camera", label: "Hallway camera" },
  { value: "classroom_camera", label: "Classroom camera" },
  { value: "cafeteria_camera", label: "Cafeteria camera" },
  { value: "exterior_camera", label: "Exterior camera" },
  { value: "external", label: "External (police / SRO / parent)" },
  { value: "other", label: "Other" },
] as const;
type Source = (typeof SOURCES)[number]["value"];

type Status = "requested" | "received" | "unavailable" | "cancelled";

interface FootageRequest {
  id: number;
  caseId: number;
  source: Source;
  locationText: string | null;
  windowStart: string;
  windowEnd: string | null;
  reason: string;
  status: Status;
  requestedByName: string | null;
  requestedAt: string;
  fulfilledByName: string | null;
  fulfilledAt: string | null;
  fulfillmentNote: string | null;
  linkedClipId: number | null;
}

interface Props {
  caseId: number;
  brandColor: string;
  panelBg: string;
  pageBg: string;
  lineColor: string;
  inkSoft: string;
}

function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate(),
  )}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(v: string): string {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

function sourceLabel(s: Source): string {
  return SOURCES.find((o) => o.value === s)?.label ?? s;
}

function statusBadge(status: Status): {
  bg: string;
  fg: string;
  icon: React.ReactNode;
  label: string;
} {
  switch (status) {
    case "requested":
      return {
        bg: "#FEF3C7",
        fg: "#92400E",
        icon: <Clock className="h-3 w-3" />,
        label: "Pending",
      };
    case "received":
      return {
        bg: "#DCFCE7",
        fg: "#166534",
        icon: <CheckCircle2 className="h-3 w-3" />,
        label: "Received",
      };
    case "unavailable":
      return {
        bg: "#FEE2E2",
        fg: "#991B1B",
        icon: <XCircle className="h-3 w-3" />,
        label: "Unavailable",
      };
    case "cancelled":
      return {
        bg: "#F3F4F6",
        fg: "#4B5563",
        icon: <MinusCircle className="h-3 w-3" />,
        label: "Cancelled",
      };
  }
}

function fmtWindow(start: string, end: string | null): string {
  const s = new Date(start);
  if (!end) return s.toLocaleString();
  const e = new Date(end);
  // Same day → show date once.
  if (
    s.getFullYear() === e.getFullYear() &&
    s.getMonth() === e.getMonth() &&
    s.getDate() === e.getDate()
  ) {
    return `${s.toLocaleString()} – ${e.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }
  return `${s.toLocaleString()} – ${e.toLocaleString()}`;
}

export default function FootageRequestsPanel({
  caseId,
  brandColor,
  panelBg,
  pageBg,
  lineColor,
  inkSoft,
}: Props) {
  const [rows, setRows] = useState<FootageRequest[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [showAdd, setShowAdd] = useState(false);
  const [newSource, setNewSource] = useState<Source>("hallway_camera");
  const [newLocation, setNewLocation] = useState("");
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");
  const [newReason, setNewReason] = useState("");

  // Per-row resolution form (status change + note).
  const [resolveFor, setResolveFor] = useState<number | null>(null);
  const [resolveStatus, setResolveStatus] = useState<Status>("received");
  const [resolveNote, setResolveNote] = useState("");

  async function load() {
    setError(null);
    try {
      const r = await authFetch(
        `/api/watchlist/cases/${caseId}/footage-requests`,
        { credentials: "include" },
      );
      if (r.status === 403) {
        setForbidden(true);
        setRows([]);
        return;
      }
      setForbidden(false);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { requests: FootageRequest[] };
      setRows(data.requests);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setRows([]);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  function resetAdd() {
    setShowAdd(false);
    setNewSource("hallway_camera");
    setNewLocation("");
    setNewStart("");
    setNewEnd("");
    setNewReason("");
  }

  async function add() {
    if (!newStart || newReason.trim().length < 3) return;
    setSaving(true);
    setError(null);
    try {
      const r = await authFetch(
        `/api/watchlist/cases/${caseId}/footage-requests`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: newSource,
            locationText: newLocation.trim(),
            windowStart: fromLocalInput(newStart),
            windowEnd: newEnd ? fromLocalInput(newEnd) : null,
            reason: newReason.trim(),
          }),
        },
      );
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      resetAdd();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function startResolve(row: FootageRequest) {
    setResolveFor(row.id);
    setResolveStatus("received");
    setResolveNote("");
  }

  async function saveResolve(id: number) {
    setSaving(true);
    setError(null);
    try {
      const r = await authFetch(`/api/watchlist/footage-requests/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: resolveStatus,
          fulfillmentNote: resolveNote.trim(),
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      setResolveFor(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function reopen(id: number) {
    setSaving(true);
    setError(null);
    try {
      const r = await authFetch(`/api/watchlist/footage-requests/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "requested", fulfillmentNote: "" }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reopen failed");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number) {
    if (
      !window.confirm(
        "Remove this footage request? It will no longer appear on the case file.",
      )
    )
      return;
    setSaving(true);
    setError(null);
    try {
      const r = await authFetch(`/api/watchlist/footage-requests/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setSaving(false);
    }
  }

  const pendingCount = rows?.filter((r) => r.status === "requested").length ?? 0;
  const totalCount = rows?.length ?? 0;

  // Hide the panel entirely when the user is not an investigator —
  // server returns 403 and we cleared rows above.
  if (rows == null) return null;
  // Hide the panel entirely for non-admin viewers — same audience
  // gating as the parent VideoEvidencePanel.
  if (forbidden) return null;

  return (
    <div
      className="mt-3 rounded-lg border p-3"
      style={{ borderColor: lineColor, background: pageBg }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4" style={{ color: brandColor }} />
          <div className="text-sm font-bold">Footage requests</div>
          {totalCount > 0 && (
            <span
              className="rounded-full px-2 py-0.5 text-[10px] font-bold"
              style={{
                background: pendingCount > 0 ? "#FEF3C7" : "#F3F4F6",
                color: pendingCount > 0 ? "#92400E" : "#4B5563",
              }}
              title={
                pendingCount > 0
                  ? `${pendingCount} pending of ${totalCount} total`
                  : `${totalCount} resolved`
              }
            >
              {pendingCount > 0
                ? `${pendingCount} pending`
                : `${totalCount} resolved`}
            </span>
          )}
        </div>
        {!showAdd && (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold"
            style={{ background: panelBg, color: brandColor }}
          >
            <Plus className="h-3 w-3" /> Request footage
          </button>
        )}
      </div>

      <div className="mt-1 text-[11px]" style={{ color: inkSoft }}>
        Internal record only — PulseEDU does not send the request.
        Make the ask in Teams, then log it here so the case file
        shows what's outstanding.
      </div>

      {error && (
        <div
          className="mt-2 rounded-md border px-2 py-1 text-xs"
          style={{
            borderColor: "#FCA5A5",
            background: "#FEF2F2",
            color: "#991B1B",
          }}
        >
          {error}
        </div>
      )}

      {showAdd && (
        <div
          className="mt-2 rounded-md border p-2"
          style={{ borderColor: lineColor, background: panelBg }}
        >
          <div className="grid gap-2 md:grid-cols-2">
            <label className="text-xs font-semibold">
              Source
              <select
                value={newSource}
                onChange={(e) => setNewSource(e.target.value as Source)}
                className="mt-1 w-full rounded-md border px-2 py-1 text-sm font-normal"
                style={{ borderColor: lineColor, background: panelBg }}
              >
                {SOURCES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-semibold">
              Location / camera (optional)
              <input
                type="text"
                value={newLocation}
                onChange={(e) => setNewLocation(e.target.value)}
                placeholder="Bus 12 · 200 wing west · Caf north entry"
                className="mt-1 w-full rounded-md border px-2 py-1 text-sm font-normal"
                style={{ borderColor: lineColor, background: panelBg }}
              />
            </label>
            <label className="text-xs font-semibold">
              Window start
              <input
                type="datetime-local"
                value={newStart}
                onChange={(e) => setNewStart(e.target.value)}
                className="mt-1 w-full rounded-md border px-2 py-1 text-sm font-normal"
                style={{ borderColor: lineColor, background: panelBg }}
              />
            </label>
            <label className="text-xs font-semibold">
              Window end (optional)
              <input
                type="datetime-local"
                value={newEnd}
                onChange={(e) => setNewEnd(e.target.value)}
                className="mt-1 w-full rounded-md border px-2 py-1 text-sm font-normal"
                style={{ borderColor: lineColor, background: panelBg }}
              />
            </label>
          </div>
          <label className="mt-2 block text-xs font-semibold">
            What we need / why
            <textarea
              value={newReason}
              onChange={(e) => setNewReason(e.target.value)}
              rows={2}
              placeholder="Students fled bus 12 after dismissal Tuesday; need view of rear seats."
              className="mt-1 w-full rounded-md border px-2 py-1 text-sm font-normal"
              style={{ borderColor: lineColor, background: panelBg }}
            />
          </label>
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={resetAdd}
              disabled={saving}
              className="rounded-md px-3 py-1 text-xs font-semibold"
              style={{
                background: panelBg,
                color: brandColor,
                border: `1px solid ${lineColor}`,
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void add()}
              disabled={saving || !newStart || newReason.trim().length < 3}
              className="rounded-md px-3 py-1 text-xs font-bold disabled:opacity-50"
              style={{ background: brandColor, color: "#FFFFFF" }}
            >
              {saving ? "Saving…" : "Log request"}
            </button>
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <div className="mt-2 space-y-2">
          {rows.map((r) => {
            const badge = statusBadge(r.status);
            return (
              <div
                key={r.id}
                className="rounded-md border p-2 text-xs"
                style={{ borderColor: lineColor, background: panelBg }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold"
                        style={{ background: badge.bg, color: badge.fg }}
                      >
                        {badge.icon}
                        {badge.label}
                      </span>
                      <span className="font-semibold">
                        {sourceLabel(r.source)}
                        {r.locationText ? ` · ${r.locationText}` : ""}
                      </span>
                    </div>
                    <div className="mt-1" style={{ color: inkSoft }}>
                      {fmtWindow(r.windowStart, r.windowEnd)}
                    </div>
                    <div className="mt-1">{r.reason}</div>
                    <div className="mt-1 text-[10px]" style={{ color: inkSoft }}>
                      Requested by {r.requestedByName ?? "—"} ·{" "}
                      {new Date(r.requestedAt).toLocaleString()}
                      {r.fulfilledAt && r.fulfilledByName && (
                        <>
                          {" · "}
                          Resolved by {r.fulfilledByName} ·{" "}
                          {new Date(r.fulfilledAt).toLocaleString()}
                        </>
                      )}
                    </div>
                    {r.fulfillmentNote && (
                      <div
                        className="mt-1 rounded border px-2 py-1"
                        style={{
                          borderColor: lineColor,
                          background: pageBg,
                          color: inkSoft,
                        }}
                      >
                        {r.fulfillmentNote}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-1">
                    {r.status === "requested" ? (
                      <>
                        <button
                          type="button"
                          onClick={() => startResolve(r)}
                          className="rounded-md px-2 py-1 text-[10px] font-semibold"
                          style={{
                            background: brandColor,
                            color: "#FFFFFF",
                          }}
                        >
                          Resolve
                        </button>
                        <button
                          type="button"
                          onClick={() => void remove(r.id)}
                          className="rounded-md px-2 py-1 text-[10px] font-semibold"
                          style={{
                            background: panelBg,
                            color: brandColor,
                            border: `1px solid ${lineColor}`,
                          }}
                        >
                          Remove
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => void reopen(r.id)}
                          className="rounded-md px-2 py-1 text-[10px] font-semibold"
                          style={{
                            background: panelBg,
                            color: brandColor,
                            border: `1px solid ${lineColor}`,
                          }}
                        >
                          Reopen
                        </button>
                        <button
                          type="button"
                          onClick={() => void remove(r.id)}
                          className="rounded-md px-2 py-1 text-[10px] font-semibold"
                          style={{
                            background: "#FEF2F2",
                            color: "#991B1B",
                            border: "1px solid #FCA5A5",
                          }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {resolveFor === r.id && (
                  <div
                    className="mt-2 rounded-md border p-2"
                    style={{ borderColor: lineColor, background: pageBg }}
                  >
                    <label className="block text-[11px] font-semibold">
                      Outcome
                      <select
                        value={resolveStatus}
                        onChange={(e) =>
                          setResolveStatus(e.target.value as Status)
                        }
                        className="mt-1 w-full rounded-md border px-2 py-1 text-xs font-normal"
                        style={{ borderColor: lineColor, background: panelBg }}
                      >
                        <option value="received">Received</option>
                        <option value="unavailable">Unavailable</option>
                        <option value="cancelled">Cancelled</option>
                      </select>
                    </label>
                    <label className="mt-2 block text-[11px] font-semibold">
                      Note (optional)
                      <textarea
                        value={resolveNote}
                        onChange={(e) => setResolveNote(e.target.value)}
                        rows={2}
                        placeholder="Saved as 'cam 1 east wing 11:23'… or 'bus garage retains 7 days'…"
                        className="mt-1 w-full rounded-md border px-2 py-1 text-xs font-normal"
                        style={{ borderColor: lineColor, background: panelBg }}
                      />
                    </label>
                    <div className="mt-2 flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setResolveFor(null)}
                        disabled={saving}
                        className="rounded-md px-2 py-1 text-[11px] font-semibold"
                        style={{
                          background: panelBg,
                          color: brandColor,
                          border: `1px solid ${lineColor}`,
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => void saveResolve(r.id)}
                        disabled={saving}
                        className="rounded-md px-2 py-1 text-[11px] font-bold disabled:opacity-50"
                        style={{ background: brandColor, color: "#FFFFFF" }}
                      >
                        {saving ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Convenience: keep `toLocalInput` exported in case the parent ever
// wants to seed window pickers from a related clip's timestamps.
export { toLocalInput };
