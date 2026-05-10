import { useEffect, useState } from "react";
import {
  Plus,
  Trash2,
  Video,
  Save,
  X,
  ExternalLink,
  ShieldCheck,
  AlertTriangle,
} from "lucide-react";
import { authFetch } from "../../lib/authToken";
import DictateButton, { appendDictated } from "../DictateButton";
import CameraPicker from "../CameraPicker";
import FootageRequestsPanel from "./FootageRequestsPanel";

// Admin-only Phase 2 panel + Phase 2.1 player-tagging UI.
//
// The panel lists per-case video evidence and lets the admin link
// specific players to a clip with a confidence rating
// (`confirmed` / `inferred` / `possible`) plus an orthogonal
// "Cleared by footage" flag. Confirmed requires a justification —
// pre-filled with `Viewed by {staff name}` so the friction is "type
// more if it warrants it" rather than a hard stop. All routes are
// 403'd for non-admins server-side; we also gate the render so a
// teacher who somehow lands here sees nothing.

type Tier = "confirmed" | "inferred" | "possible";
const TIER_ORDER: Tier[] = ["confirmed", "inferred", "possible"];
const TIER_LABEL: Record<Tier, string> = {
  confirmed: "Confirmed",
  inferred: "Inferred",
  possible: "Possible",
};
const TIER_HINT: Record<Tier, string> = {
  confirmed: "Clearly visible performing the action on camera.",
  inferred: "In frame; action obscured but circumstances are strong.",
  possible: "In frame around the relevant time; role unclear.",
};

interface PlayerLink {
  id: number;
  evidenceId: number;
  studentId: string;
  confidence: Tier;
  clearedByFootage: boolean;
  reason: string | null;
  setByName: string | null;
  updatedAt: string;
}

interface EvidenceRow {
  id: number;
  schoolId: number;
  caseId: number;
  cameraLabel: string;
  timestampStart: string;
  timestampEnd: string | null;
  sourceUrl: string | null;
  notes: string | null;
  loggedByName: string | null;
  createdAt: string;
  players: PlayerLink[];
}

export interface CasePlayerLite {
  studentId: string;
  firstName: string;
  lastName: string;
}

interface Props {
  caseId: number;
  casePlayers: CasePlayerLite[];
  // Used as the default "Viewed by {name}" reason text when the admin
  // promotes a link to Confirmed.
  viewerName: string;
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

function tierBadgeStyle(t: Tier, brand: string): React.CSSProperties {
  switch (t) {
    case "confirmed":
      return { background: brand, color: "#FFFFFF", borderColor: brand };
    case "inferred":
      return { background: "#FFFFFF", color: brand, borderColor: brand };
    case "possible":
      return {
        background: "#FFFFFF",
        color: "#7A5C5C",
        borderColor: "#D9C7C7",
      };
  }
}

export default function VideoEvidencePanel({
  caseId,
  casePlayers,
  viewerName,
  brandColor,
  panelBg,
  pageBg,
  lineColor,
  inkSoft,
}: Props) {
  const [rows, setRows] = useState<EvidenceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newStart, setNewStart] = useState("");
  const [newEnd, setNewEnd] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editStart, setEditStart] = useState("");
  const [editEnd, setEditEnd] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editNotes, setEditNotes] = useState("");

  // Per-clip "tag a player" picker: which clip is currently in
  // tagging mode, and the form state for that pick.
  const [tagFor, setTagFor] = useState<number | null>(null);
  const [tagStudentId, setTagStudentId] = useState<string>("");
  const [tagTier, setTagTier] = useState<Tier>("inferred");
  const [tagCleared, setTagCleared] = useState(false);
  const [tagReason, setTagReason] = useState("");

  // Per-link inline edit (changing tier on an existing chip).
  const [editingLinkId, setEditingLinkId] = useState<number | null>(null);
  const [editLinkTier, setEditLinkTier] = useState<Tier>("inferred");
  const [editLinkCleared, setEditLinkCleared] = useState(false);
  const [editLinkReason, setEditLinkReason] = useState("");

  async function load() {
    setError(null);
    try {
      const r = await authFetch(
        `/api/watchlist/cases/${caseId}/video-evidence`,
        { credentials: "include" },
      );
      if (r.status === 403) {
        setRows([]);
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { evidence: EvidenceRow[] };
      setRows(data.evidence);
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
    setNewLabel("");
    setNewStart("");
    setNewEnd("");
    setNewUrl("");
    setNewNotes("");
    setShowAdd(false);
  }

  async function add() {
    if (!newLabel.trim() || !newStart) return;
    setSaving(true);
    setError(null);
    try {
      const r = await authFetch(
        `/api/watchlist/cases/${caseId}/video-evidence`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cameraLabel: newLabel.trim(),
            timestampStart: fromLocalInput(newStart),
            timestampEnd: newEnd ? fromLocalInput(newEnd) : "",
            sourceUrl: newUrl.trim(),
            notes: newNotes.trim(),
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

  function startEdit(row: EvidenceRow) {
    setEditingId(row.id);
    setEditLabel(row.cameraLabel);
    setEditStart(toLocalInput(row.timestampStart));
    setEditEnd(toLocalInput(row.timestampEnd));
    setEditUrl(row.sourceUrl ?? "");
    setEditNotes(row.notes ?? "");
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function saveEdit(id: number) {
    if (!editLabel.trim() || !editStart) return;
    setSaving(true);
    setError(null);
    try {
      const r = await authFetch(`/api/watchlist/video-evidence/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cameraLabel: editLabel.trim(),
          timestampStart: fromLocalInput(editStart),
          timestampEnd: editEnd ? fromLocalInput(editEnd) : null,
          sourceUrl: editUrl.trim(),
          notes: editNotes.trim(),
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      cancelEdit();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number) {
    if (
      !window.confirm(
        "Remove this video evidence entry and its player tags? The change will be recorded in the audit log.",
      )
    )
      return;
    setSaving(true);
    setError(null);
    try {
      const r = await authFetch(`/api/watchlist/video-evidence/${id}`, {
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

  function startTag(evidenceId: number) {
    setTagFor(evidenceId);
    setTagStudentId("");
    setTagTier("inferred");
    setTagCleared(false);
    setTagReason("");
  }
  function cancelTag() {
    setTagFor(null);
  }
  // When the admin selects "Confirmed", auto-fill the reason with
  // the viewer attribution. They can append details before saving.
  function onTierChange(next: Tier) {
    setTagTier(next);
    if (next === "confirmed" && !tagReason.trim()) {
      setTagReason(`Viewed by ${viewerName}`);
    }
  }

  async function saveTag() {
    if (tagFor == null || !tagStudentId) return;
    if (tagTier === "confirmed" && !tagReason.trim()) {
      setError("A reason is required when marking as Confirmed.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await authFetch(
        `/api/watchlist/video-evidence/${tagFor}/players`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            studentId: tagStudentId,
            confidence: tagTier,
            clearedByFootage: tagCleared,
            reason: tagReason.trim() || null,
          }),
        },
      );
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      cancelTag();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function startEditLink(p: PlayerLink) {
    setEditingLinkId(p.id);
    setEditLinkTier(p.confidence);
    setEditLinkCleared(p.clearedByFootage);
    setEditLinkReason(p.reason ?? "");
  }
  function cancelEditLink() {
    setEditingLinkId(null);
  }
  function onEditLinkTierChange(next: Tier) {
    setEditLinkTier(next);
    if (next === "confirmed" && !editLinkReason.trim()) {
      setEditLinkReason(`Viewed by ${viewerName}`);
    }
  }
  async function saveEditLink(linkId: number) {
    if (editLinkTier === "confirmed" && !editLinkReason.trim()) {
      setError("A reason is required when marking as Confirmed.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await authFetch(
        `/api/watchlist/video-evidence/players/${linkId}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            confidence: editLinkTier,
            clearedByFootage: editLinkCleared,
            reason: editLinkReason.trim() || null,
          }),
        },
      );
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      cancelEditLink();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function removeLink(linkId: number) {
    if (
      !window.confirm(
        "Remove this player tag from the clip? The change will be recorded in the audit log.",
      )
    )
      return;
    setSaving(true);
    setError(null);
    try {
      const r = await authFetch(
        `/api/watchlist/video-evidence/players/${linkId}`,
        {
          method: "DELETE",
          credentials: "include",
        },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setSaving(false);
    }
  }

  function playerName(studentId: string): string {
    const p = casePlayers.find((x) => x.studentId === studentId);
    return p ? `${p.firstName} ${p.lastName}` : studentId;
  }

  const hasRows = rows && rows.length > 0;

  return (
    <div
      className="rounded-xl border p-5"
      style={{ borderColor: lineColor, background: panelBg }}
    >
      <div className="flex items-baseline justify-between">
        <div className="flex items-center gap-2">
          <Video className="h-4 w-4" style={{ color: brandColor }} />
          <h2 className="text-lg font-bold tracking-tight">Video evidence</h2>
          <span
            className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
            style={{ background: "#FEF3C7", color: "#92400E" }}
            title="Visible to admins, Behavior Specialists, MTSS Coordinators, and Deans"
          >
            Investigators only
          </span>
        </div>
        {!showAdd && (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold"
            style={{ background: pageBg, color: brandColor }}
          >
            <Plus className="h-3 w-3" /> Add
          </button>
        )}
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

      <FootageRequestsPanel
        caseId={caseId}
        brandColor={brandColor}
        panelBg={panelBg}
        pageBg={pageBg}
        lineColor={lineColor}
        inkSoft={inkSoft}
      />

      {/* The legacy "Recent cameras" chip row that surfaced free-text
          labels from /watchlist/camera-labels was removed — it
          undermined the registry standardization goal by re-suggesting
          unregistered or typo'd names. The CameraPicker datalist now
          drives all camera selection. */}

      {showAdd && (
        <div
          className="mt-3 rounded-lg border p-3"
          style={{ borderColor: lineColor, background: pageBg }}
        >
          <div className="grid gap-2 md:grid-cols-2">
            <div className="text-xs font-semibold">
              <div className="mb-1">Camera</div>
              <CameraPicker
                value={newLabel}
                onChange={setNewLabel}
                borderColor={lineColor}
                bg={panelBg}
                inkSoft={inkSoft}
                required
              />
            </div>
            <label className="text-xs font-semibold">
              Source URL (optional)
              <input
                type="url"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="Link to clip in your camera system"
                className="mt-1 w-full rounded-md border px-2 py-1 text-sm font-normal"
                style={{ borderColor: lineColor, background: panelBg }}
              />
            </label>
            <label className="text-xs font-semibold">
              Footage start
              <input
                type="datetime-local"
                value={newStart}
                onChange={(e) => setNewStart(e.target.value)}
                className="mt-1 w-full rounded-md border px-2 py-1 text-sm font-normal"
                style={{ borderColor: lineColor, background: panelBg }}
              />
            </label>
            <label className="text-xs font-semibold">
              Footage end (optional)
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
            Notes (what to look for, who to focus on…)
            <textarea
              value={newNotes}
              onChange={(e) => setNewNotes(e.target.value)}
              rows={2}
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
              disabled={saving || !newLabel.trim() || !newStart}
              className="rounded-md px-3 py-1 text-xs font-bold disabled:opacity-50"
              style={{ background: brandColor, color: "#FFFFFF" }}
            >
              {saving ? "Saving…" : "Save evidence"}
            </button>
          </div>
        </div>
      )}

      <div className="mt-3 space-y-2">
        {!rows ? (
          <div className="text-sm" style={{ color: inkSoft }}>
            Loading…
          </div>
        ) : !hasRows ? (
          <div className="text-sm" style={{ color: inkSoft }}>
            No video evidence logged yet.
          </div>
        ) : (
          rows.map((r) =>
            editingId === r.id ? (
              <div
                key={r.id}
                className="rounded-lg border p-3"
                style={{ borderColor: brandColor, background: pageBg }}
              >
                <div className="grid gap-2 md:grid-cols-2">
                  <CameraPicker
                    value={editLabel}
                    onChange={setEditLabel}
                    borderColor={lineColor}
                    bg={panelBg}
                    inkSoft={inkSoft}
                  />
                  <input
                    type="url"
                    value={editUrl}
                    onChange={(e) => setEditUrl(e.target.value)}
                    placeholder="Source URL (optional)"
                    className="rounded-md border px-2 py-1 text-sm"
                    style={{ borderColor: lineColor, background: panelBg }}
                  />
                  <input
                    type="datetime-local"
                    value={editStart}
                    onChange={(e) => setEditStart(e.target.value)}
                    className="rounded-md border px-2 py-1 text-sm"
                    style={{ borderColor: lineColor, background: panelBg }}
                  />
                  <input
                    type="datetime-local"
                    value={editEnd}
                    onChange={(e) => setEditEnd(e.target.value)}
                    className="rounded-md border px-2 py-1 text-sm"
                    style={{ borderColor: lineColor, background: panelBg }}
                  />
                </div>
                <textarea
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  rows={2}
                  className="mt-2 w-full rounded-md border px-2 py-1 text-sm"
                  style={{ borderColor: lineColor, background: panelBg }}
                />
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={cancelEdit}
                    disabled={saving}
                    className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-semibold"
                    style={{
                      borderColor: lineColor,
                      background: panelBg,
                      color: brandColor,
                    }}
                  >
                    <X className="h-3 w-3" /> Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveEdit(r.id)}
                    disabled={saving || !editLabel.trim() || !editStart}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-bold disabled:opacity-50"
                    style={{ background: brandColor, color: "#FFFFFF" }}
                  >
                    <Save className="h-3 w-3" /> Save
                  </button>
                </div>
              </div>
            ) : (
              <div
                key={r.id}
                className="rounded-lg border p-3"
                style={{ borderColor: lineColor, background: pageBg }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-bold">
                      <Video
                        className="h-3.5 w-3.5"
                        style={{ color: brandColor }}
                      />
                      <span>{r.cameraLabel}</span>
                    </div>
                    <div className="mt-1 text-[11px]" style={{ color: inkSoft }}>
                      {new Date(r.timestampStart).toLocaleString()}
                      {r.timestampEnd
                        ? ` → ${new Date(r.timestampEnd).toLocaleString()}`
                        : " (single frame / open-ended)"}
                    </div>
                    {r.sourceUrl && (
                      <a
                        href={r.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold underline"
                        style={{ color: brandColor }}
                      >
                        Open in camera system
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                    {r.notes && (
                      <div
                        className="mt-2 whitespace-pre-wrap text-xs"
                        style={{ color: inkSoft }}
                      >
                        {r.notes}
                      </div>
                    )}

                    {/* Linked players strip — chips for each, "+ Tag player"
                        opens the picker. Skippable; defaults to Inferred. */}
                    <div
                      className="mt-3 border-t pt-2"
                      style={{ borderColor: lineColor }}
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className="text-[10px] font-bold uppercase"
                          style={{ color: inkSoft }}
                        >
                          Linked players:
                        </span>
                        {r.players.length === 0 && (
                          <span
                            className="text-[11px] italic"
                            style={{ color: inkSoft }}
                          >
                            none yet
                          </span>
                        )}
                        {r.players.map((p) =>
                          editingLinkId === p.id ? null : (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => startEditLink(p)}
                              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold"
                              style={tierBadgeStyle(p.confidence, brandColor)}
                              title={`${TIER_LABEL[p.confidence]}${
                                p.clearedByFootage ? " · cleared by footage" : ""
                              }${p.reason ? ` · ${p.reason}` : ""}`}
                            >
                              <Video className="h-3 w-3" />
                              <span>{playerName(p.studentId)}</span>
                              <span className="opacity-80">
                                · {TIER_LABEL[p.confidence]}
                              </span>
                              {p.clearedByFootage && (
                                <ShieldCheck className="h-3 w-3" />
                              )}
                            </button>
                          ),
                        )}
                        {tagFor !== r.id && (
                          <button
                            type="button"
                            onClick={() => startTag(r.id)}
                            className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold"
                            style={{
                              borderColor: lineColor,
                              color: brandColor,
                              background: panelBg,
                            }}
                          >
                            <Plus className="h-3 w-3" /> Tag player
                          </button>
                        )}
                      </div>

                      {/* Inline edit-link form */}
                      {r.players
                        .filter((p) => p.id === editingLinkId)
                        .map((p) => (
                          <div
                            key={`edit-${p.id}`}
                            className="mt-2 rounded-md border p-2"
                            style={{ borderColor: brandColor, background: panelBg }}
                          >
                            <div
                              className="text-[11px] font-bold"
                              style={{ color: brandColor }}
                            >
                              Edit tag — {playerName(p.studentId)}
                            </div>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {TIER_ORDER.map((t) => (
                                <button
                                  key={t}
                                  type="button"
                                  onClick={() => onEditLinkTierChange(t)}
                                  className="rounded-full border px-2 py-0.5 text-[11px] font-semibold"
                                  style={
                                    editLinkTier === t
                                      ? tierBadgeStyle(t, brandColor)
                                      : {
                                          borderColor: lineColor,
                                          color: inkSoft,
                                          background: pageBg,
                                        }
                                  }
                                  title={TIER_HINT[t]}
                                >
                                  {TIER_LABEL[t]}
                                </button>
                              ))}
                              <label className="ml-2 inline-flex items-center gap-1 text-[11px] font-semibold">
                                <input
                                  type="checkbox"
                                  checked={editLinkCleared}
                                  onChange={(e) =>
                                    setEditLinkCleared(e.target.checked)
                                  }
                                />
                                Cleared by footage
                              </label>
                            </div>
                            {editLinkTier === "confirmed" && (
                              <div
                                className="mt-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px]"
                                style={{
                                  background: "#FEF3C7",
                                  color: "#92400E",
                                  border: "1px solid #FDE68A",
                                }}
                              >
                                <AlertTriangle className="h-3 w-3" />
                                Confirmed creates a strong record. State what
                                you saw — this will be in the audit trail.
                              </div>
                            )}
                            <div className="mt-1 flex justify-end">
                              <DictateButton
                                onAppend={(chunk) =>
                                  // Prepend the dictated text in front
                                  // of the auto-attached "— Viewed by
                                  // {name}" suffix so the admin's own
                                  // observation comes first and the
                                  // attribution stays at the tail.
                                  setEditLinkReason((prev) =>
                                    appendDictated(chunk, prev),
                                  )
                                }
                                borderColor={lineColor}
                                inkSoft={inkSoft}
                                panelBg={panelBg}
                              />
                            </div>
                            <textarea
                              value={editLinkReason}
                              onChange={(e) => setEditLinkReason(e.target.value)}
                              placeholder={`Reason${
                                editLinkTier === "confirmed" ? " (required)" : " (optional)"
                              }`}
                              rows={2}
                              className="mt-1 w-full rounded-md border px-2 py-1 text-xs"
                              style={{ borderColor: lineColor, background: pageBg }}
                            />
                            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                              <button
                                type="button"
                                onClick={() => void removeLink(p.id)}
                                disabled={saving}
                                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold"
                                style={{
                                  borderColor: "#FCA5A5",
                                  background: "#FEF2F2",
                                  color: "#991B1B",
                                }}
                              >
                                <Trash2 className="h-3 w-3" /> Remove tag
                              </button>
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  onClick={cancelEditLink}
                                  disabled={saving}
                                  className="rounded-md border px-2 py-1 text-[11px] font-semibold"
                                  style={{
                                    borderColor: lineColor,
                                    background: pageBg,
                                    color: brandColor,
                                  }}
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void saveEditLink(p.id)}
                                  disabled={saving}
                                  className="rounded-md px-2 py-1 text-[11px] font-bold disabled:opacity-50"
                                  style={{
                                    background: brandColor,
                                    color: "#FFFFFF",
                                  }}
                                >
                                  Save
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}

                      {/* Inline new-tag form */}
                      {tagFor === r.id && (
                        <div
                          className="mt-2 rounded-md border p-2"
                          style={{ borderColor: brandColor, background: panelBg }}
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <select
                              value={tagStudentId}
                              onChange={(e) => setTagStudentId(e.target.value)}
                              className="rounded-md border px-2 py-1 text-xs"
                              style={{
                                borderColor: lineColor,
                                background: pageBg,
                              }}
                            >
                              <option value="">Choose player…</option>
                              {casePlayers
                                .filter(
                                  (p) =>
                                    !r.players.some(
                                      (pl) => pl.studentId === p.studentId,
                                    ),
                                )
                                .map((p) => (
                                  <option key={p.studentId} value={p.studentId}>
                                    {p.firstName} {p.lastName}
                                  </option>
                                ))}
                            </select>
                            <div className="flex flex-wrap gap-1">
                              {TIER_ORDER.map((t) => (
                                <button
                                  key={t}
                                  type="button"
                                  onClick={() => onTierChange(t)}
                                  className="rounded-full border px-2 py-0.5 text-[11px] font-semibold"
                                  style={
                                    tagTier === t
                                      ? tierBadgeStyle(t, brandColor)
                                      : {
                                          borderColor: lineColor,
                                          color: inkSoft,
                                          background: pageBg,
                                        }
                                  }
                                  title={TIER_HINT[t]}
                                >
                                  {TIER_LABEL[t]}
                                </button>
                              ))}
                            </div>
                            <label className="inline-flex items-center gap-1 text-[11px] font-semibold">
                              <input
                                type="checkbox"
                                checked={tagCleared}
                                onChange={(e) => setTagCleared(e.target.checked)}
                              />
                              Cleared by footage
                            </label>
                          </div>
                          {tagTier === "confirmed" && (
                            <div
                              className="mt-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px]"
                              style={{
                                background: "#FEF3C7",
                                color: "#92400E",
                                border: "1px solid #FDE68A",
                              }}
                            >
                              <AlertTriangle className="h-3 w-3" />
                              Confirmed creates a strong record. State what
                              you saw — this will be in the audit trail.
                            </div>
                          )}
                          <div className="mt-1 flex justify-end">
                            <DictateButton
                              onAppend={(chunk) =>
                                // Prepend dictated text in front of the
                                // auto-attached "— Viewed by {name}"
                                // suffix so the admin's observation
                                // comes first and the attribution
                                // stays at the tail.
                                setTagReason((prev) =>
                                  appendDictated(chunk, prev),
                                )
                              }
                              borderColor={lineColor}
                              inkSoft={inkSoft}
                              panelBg={panelBg}
                            />
                          </div>
                          <textarea
                            value={tagReason}
                            onChange={(e) => setTagReason(e.target.value)}
                            placeholder={`Reason${
                              tagTier === "confirmed" ? " (required)" : " (optional)"
                            }`}
                            rows={2}
                            className="mt-1 w-full rounded-md border px-2 py-1 text-xs"
                            style={{ borderColor: lineColor, background: pageBg }}
                          />
                          <div className="mt-2 flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={cancelTag}
                              disabled={saving}
                              className="rounded-md border px-2 py-1 text-[11px] font-semibold"
                              style={{
                                borderColor: lineColor,
                                background: pageBg,
                                color: brandColor,
                              }}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => void saveTag()}
                              disabled={saving || !tagStudentId}
                              className="rounded-md px-2 py-1 text-[11px] font-bold disabled:opacity-50"
                              style={{
                                background: brandColor,
                                color: "#FFFFFF",
                              }}
                            >
                              {saving ? "Saving…" : "Save tag"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                    <div
                      className="mt-2 text-[10px]"
                      style={{ color: inkSoft }}
                    >
                      Logged by {r.loggedByName ?? "—"} ·{" "}
                      {new Date(r.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <button
                      type="button"
                      onClick={() => startEdit(r)}
                      className="rounded-md px-2 py-1 text-[10px] font-semibold"
                      style={{
                        background: panelBg,
                        color: brandColor,
                        border: `1px solid ${lineColor}`,
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(r.id)}
                      className="inline-flex items-center justify-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold"
                      style={{
                        background: "#FEF2F2",
                        color: "#991B1B",
                        border: "1px solid #FCA5A5",
                      }}
                    >
                      <Trash2 className="h-3 w-3" /> Remove
                    </button>
                  </div>
                </div>
              </div>
            ),
          )
        )}
      </div>
    </div>
  );
}
