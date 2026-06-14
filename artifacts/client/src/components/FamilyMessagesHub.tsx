// Staff-side "Family Messages" hub — Core Team composes a broadcast to parent
// families (subject + body + optional PNG/PDF attachment), targets an audience
// (whole school, by grade, by house, or specific students via CSV of local SIS
// IDs), and watches REAL per-message counters: Sent → Reached → Got it. A
// derived "Power Reader" badge flags families who consistently acknowledge.
//
// Talks to /api/family-messages via authFetch (repo convention — no codegen).
import { useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "../lib/authToken";
import type { VideoItem } from "./PulseDnaStudio";

interface SentMessage {
  id: number;
  subject: string;
  body: string;
  audienceType: string;
  audienceGrades: string[];
  audienceHouseIds: number[];
  hasAttachment: boolean;
  attachmentName: string | null;
  attachmentType: string | null;
  emailNudge: boolean;
  videoId: number | null;
  video: HubVideoMeta | null;
  totalRecipients: number;
  reachedRecipients: number;
  acknowledgedRecipients: number;
  senderName: string;
  createdAt: string;
}

interface HubVideoMeta {
  id: number;
  status: string;
  durationSec: number | null;
  hasMp4: boolean;
  hasAudio: boolean;
  purged: boolean;
}

// A ready PulseDNA video available to attach to a message.
interface ReadyVideo {
  id: number;
  title: string | null;
  durationSec: number | null;
  createdAt: string;
}

interface DetailRecipient {
  id: number;
  name: string;
  hasAccount: boolean;
  email: string | null;
  deliveredPortal: boolean;
  deliveredEmail: boolean;
  acknowledgedAt: string | null;
  isPowerReader: boolean;
  studentCount: number;
}

interface MessageDetail {
  id: number;
  subject: string;
  body: string;
  audienceType: string;
  hasAttachment: boolean;
  attachmentName: string | null;
  attachmentType: string | null;
  emailNudge: boolean;
  videoId: number | null;
  video: HubVideoMeta | null;
  totalRecipients: number;
  reachedRecipients: number;
  acknowledgedRecipients: number;
  createdAt: string;
  recipients: DetailRecipient[];
}

interface House {
  id: number;
  name: string;
}

type AudienceType = "school" | "grade" | "house" | "students";

// mm:ss for the video picker labels.
function formatVideoDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const ALLOWED_ATTACHMENT_TYPES = new Set(["image/png", "application/pdf"]);

function pct(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Pull the local-SIS-ID column out of a pasted CSV / line list. Accepts a
// header row (prefers a column named local_sis_id / "local sis id" / id) and
// falls back to the first column. Strips a UTF-8 BOM. Mirrors the importer's
// tolerant matching so a teacher can paste a Skyward export directly.
function parseLocalSisIds(text: string): string[] {
  const clean = text.replace(/^\uFEFF/, "");
  const lines = clean
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const splitRow = (row: string): string[] =>
    row.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));

  const header = splitRow(lines[0]).map((h) => h.toLowerCase());
  const idCol = header.findIndex((h) =>
    ["local_sis_id", "local sis id", "localsisid", "sis_id", "sis id", "id"].includes(
      h,
    ),
  );
  const hasHeader = idCol !== -1;
  const col = hasHeader ? idCol : 0;
  const dataLines = hasHeader ? lines.slice(1) : lines;

  const out = new Set<string>();
  for (const line of dataLines) {
    const cells = splitRow(line);
    const v = (cells[col] ?? "").trim();
    if (v) out.add(v);
  }
  return Array.from(out);
}

export default function FamilyMessagesHub({ grades }: { grades: number[] }) {
  // Compose state
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [audienceType, setAudienceType] = useState<AudienceType>("school");
  const [selectedGrades, setSelectedGrades] = useState<Set<number>>(new Set());
  const [selectedHouses, setSelectedHouses] = useState<Set<number>>(new Set());
  const [csvText, setCsvText] = useState("");
  const [emailNudge, setEmailNudge] = useState(true);
  const [attachment, setAttachment] = useState<File | null>(null);
  const [attachmentError, setAttachmentError] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [readyVideos, setReadyVideos] = useState<ReadyVideo[]>([]);
  const [selectedVideoId, setSelectedVideoId] = useState<number | null>(null);

  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [sendResult, setSendResult] = useState<{
    totalRecipients: number;
    reachedRecipients: number;
    emailsSent: number;
    unmatchedSisIds: string[];
  } | null>(null);

  // Data
  const [houses, setHouses] = useState<House[]>([]);
  const [messages, setMessages] = useState<SentMessage[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState("");

  // Detail drawer
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const csvIds = useMemo(() => parseLocalSisIds(csvText), [csvText]);

  async function loadMessages() {
    try {
      const res = await authFetch("/api/family-messages");
      if (!res.ok) {
        setListError(`Could not load messages (${res.status})`);
        return;
      }
      const body = (await res.json()) as SentMessage[];
      setMessages(Array.isArray(body) ? body : []);
      setListError("");
    } catch {
      setListError("Could not load messages");
    } finally {
      setLoadingList(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Houses for the audience picker.
      try {
        const res = await authFetch("/api/houses");
        if (!cancelled && res.ok) {
          const body = (await res.json()) as { houses?: House[] };
          setHouses(Array.isArray(body.houses) ? body.houses : []);
        }
      } catch {
        /* houses are optional — picker just shows none */
      }
      // Ready PulseDNA videos available to attach.
      try {
        const res = await authFetch("/api/pulse-dna/videos");
        if (!cancelled && res.ok) {
          const body = (await res.json()) as { videos?: VideoItem[] };
          const ready = (Array.isArray(body.videos) ? body.videos : [])
            .filter((v) => v.status === "ready" && v.hasMp4)
            .map((v) => ({
              id: v.id,
              title: v.title,
              durationSec: v.durationSec,
              createdAt: v.createdAt,
            }));
          setReadyVideos(ready);
        }
      } catch {
        /* videos are optional — picker just shows none */
      }
      if (!cancelled) await loadMessages();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function onPickFile(file: File | null) {
    setAttachmentError("");
    if (!file) {
      setAttachment(null);
      return;
    }
    if (!ALLOWED_ATTACHMENT_TYPES.has(file.type)) {
      setAttachment(null);
      setAttachmentError("Attachment must be a PNG image or a PDF.");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setAttachment(file);
  }

  async function uploadAttachment(
    file: File,
  ): Promise<{ objectPath: string } | null> {
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
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!putRes.ok) return null;
      return { objectPath };
    } catch {
      return null;
    }
  }

  function resetCompose() {
    setSubject("");
    setBody("");
    setAudienceType("school");
    setSelectedGrades(new Set());
    setSelectedHouses(new Set());
    setCsvText("");
    setEmailNudge(true);
    setAttachment(null);
    setAttachmentError("");
    setSelectedVideoId(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleSend() {
    if (sending) return;
    setSendError("");
    setSendResult(null);

    if (!subject.trim()) {
      setSendError("Subject is required.");
      return;
    }
    if (!body.trim()) {
      setSendError("Message body is required.");
      return;
    }
    if (audienceType === "grade" && selectedGrades.size === 0) {
      setSendError("Pick at least one grade.");
      return;
    }
    if (audienceType === "house" && selectedHouses.size === 0) {
      setSendError("Pick at least one house.");
      return;
    }
    if (audienceType === "students" && csvIds.length === 0) {
      setSendError("Paste or upload a CSV with at least one local SIS ID.");
      return;
    }

    setSending(true);
    try {
      let attachmentObjectKey: string | null = null;
      if (attachment) {
        const up = await uploadAttachment(attachment);
        if (!up) {
          setSendError("Attachment upload failed. Try again.");
          setSending(false);
          return;
        }
        attachmentObjectKey = up.objectPath;
      }

      const payload = {
        subject: subject.trim(),
        body: body.trim(),
        audienceType,
        audienceGrades:
          audienceType === "grade"
            ? Array.from(selectedGrades).map((g) => String(g))
            : [],
        audienceHouseIds:
          audienceType === "house" ? Array.from(selectedHouses) : [],
        audienceLocalSisIds: audienceType === "students" ? csvIds : [],
        emailNudge,
        attachmentObjectKey,
        attachmentName: attachment?.name ?? null,
        attachmentType: attachment?.type ?? null,
        videoId: selectedVideoId,
      };

      const res = await authFetch("/api/family-messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => null)) as
        | {
            totalRecipients: number;
            reachedRecipients: number;
            emailsSent: number;
            unmatchedSisIds: string[];
          }
        | { error?: string }
        | null;
      if (!res.ok) {
        setSendError(
          (data && "error" in data && data.error) ||
            `Could not send (${res.status})`,
        );
        return;
      }
      setSendResult(
        data as {
          totalRecipients: number;
          reachedRecipients: number;
          emailsSent: number;
          unmatchedSisIds: string[];
        },
      );
      resetCompose();
      await loadMessages();
    } catch {
      setSendError("Could not send the message.");
    } finally {
      setSending(false);
    }
  }

  async function openDetail(id: number) {
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await authFetch(`/api/family-messages/${id}`);
      if (res.ok) setDetail((await res.json()) as MessageDetail);
    } catch {
      /* swallow */
    } finally {
      setDetailLoading(false);
    }
  }

  async function downloadStaffAttachment(m: MessageDetail) {
    try {
      const res = await authFetch(`/api/family-messages/${m.id}/attachment`);
      if (!res.ok) return;
      const blob = await res.blob();
      const ext = m.attachmentType === "application/pdf" ? "pdf" : "png";
      const filename = m.attachmentName || `attachment.${ext}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      /* swallow */
    }
  }

  const sortedGrades = useMemo(
    () => Array.from(new Set(grades)).sort((a, b) => a - b),
    [grades],
  );

  return (
    <>
      <div
        style={{
          borderTopLeftRadius: "var(--radius-lg, 8px)",
          borderTopRightRadius: "var(--radius-lg, 8px)",
          overflow: "hidden",
          marginBottom: "-1px",
        }}
      >
        <div className="section-header-bar-teal" style={{ width: "100%", margin: 0 }} />
        <div className="section-header-band-hub" style={{ width: "100%", margin: 0 }} />
      </div>

      <section className="card" style={{ overflow: "visible" }}>
        <h2
          style={{
            margin: "0 0 0.25rem",
            fontSize: "1.5rem",
            fontWeight: 700,
            color: "#0f766e",
          }}
        >
          Family Messages
        </h2>
        <p style={{ marginTop: 0, color: "var(--muted, #64748b)", fontSize: "0.9rem" }}>
          Send an announcement to parent families. It lands in their Parent
          Portal inbox with a "Got it" button, and (optionally) emails a nudge
          linking back to the portal. Counters are real — every family you reach
          is tracked.
        </p>

        {/* ---- Compose ---- */}
        <div style={{ display: "grid", gap: "0.75rem", maxWidth: 720 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>Subject</span>
            <input
              type="text"
              value={subject}
              maxLength={200}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g. Picture Day is Thursday"
              style={{ padding: "0.5rem 0.65rem", borderRadius: 8, border: "1px solid var(--border, #cbd5e1)" }}
            />
          </label>

          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>Message</span>
            <textarea
              value={body}
              rows={5}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your message to families…"
              style={{ padding: "0.5rem 0.65rem", borderRadius: 8, border: "1px solid var(--border, #cbd5e1)", resize: "vertical", fontFamily: "inherit" }}
            />
          </label>

          {/* Audience */}
          <div style={{ display: "grid", gap: 6 }}>
            <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>Audience</span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {(
                [
                  ["school", "Whole school"],
                  ["grade", "By grade"],
                  ["house", "By house"],
                  ["students", "Specific families (CSV)"],
                ] as [AudienceType, string][]
              ).map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  className={"btn" + (audienceType === val ? " primary" : "")}
                  onClick={() => setAudienceType(val)}
                >
                  {label}
                </button>
              ))}
            </div>

            {audienceType === "grade" && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                {sortedGrades.length === 0 && (
                  <span style={{ color: "var(--muted, #64748b)", fontSize: "0.85rem" }}>
                    No grades found.
                  </span>
                )}
                {sortedGrades.map((g) => {
                  const on = selectedGrades.has(g);
                  return (
                    <button
                      key={g}
                      type="button"
                      className={"btn" + (on ? " primary" : "")}
                      onClick={() => {
                        const next = new Set(selectedGrades);
                        if (on) next.delete(g);
                        else next.add(g);
                        setSelectedGrades(next);
                      }}
                    >
                      {g === 0 ? "K" : `Grade ${g}`}
                    </button>
                  );
                })}
              </div>
            )}

            {audienceType === "house" && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                {houses.length === 0 && (
                  <span style={{ color: "var(--muted, #64748b)", fontSize: "0.85rem" }}>
                    No houses configured.
                  </span>
                )}
                {houses.map((h) => {
                  const on = selectedHouses.has(h.id);
                  return (
                    <button
                      key={h.id}
                      type="button"
                      className={"btn" + (on ? " primary" : "")}
                      onClick={() => {
                        const next = new Set(selectedHouses);
                        if (on) next.delete(h.id);
                        else next.add(h.id);
                        setSelectedHouses(next);
                      }}
                    >
                      {h.name}
                    </button>
                  );
                })}
              </div>
            )}

            {audienceType === "students" && (
              <div style={{ display: "grid", gap: 6, marginTop: 4 }}>
                <span style={{ color: "var(--muted, #64748b)", fontSize: "0.8rem" }}>
                  Paste a list of local SIS IDs (one per line, or a CSV with a
                  <code> local_sis_id </code> column), or upload a CSV file.
                </span>
                <textarea
                  value={csvText}
                  rows={4}
                  onChange={(e) => setCsvText(e.target.value)}
                  placeholder={"local_sis_id\n100234\n100987"}
                  style={{ padding: "0.5rem 0.65rem", borderRadius: 8, border: "1px solid var(--border, #cbd5e1)", fontFamily: "monospace", fontSize: "0.85rem" }}
                />
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (f) setCsvText(await f.text());
                      e.target.value = "";
                    }}
                  />
                  <span style={{ fontSize: "0.8rem", color: "var(--muted, #64748b)" }}>
                    {csvIds.length} ID{csvIds.length === 1 ? "" : "s"} detected
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Attachment */}
          <div style={{ display: "grid", gap: 6 }}>
            <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>
              Attachment (PNG or PDF, optional)
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,application/pdf"
              onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
            />
            {attachment && (
              <span style={{ fontSize: "0.8rem", color: "var(--muted, #64748b)" }}>
                {attachment.name}
              </span>
            )}
            {attachmentError && (
              <span style={{ fontSize: "0.8rem", color: "#dc2626" }}>
                {attachmentError}
              </span>
            )}
          </div>

          {/* PulseDNA video picker */}
          {readyVideos.length > 0 && (
            <div style={{ display: "grid", gap: 6 }}>
              <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>
                Attach a PulseDNA video (optional)
              </span>
              <select
                value={selectedVideoId == null ? "" : String(selectedVideoId)}
                onChange={(e) =>
                  setSelectedVideoId(
                    e.target.value === "" ? null : Number(e.target.value),
                  )
                }
                style={{
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid var(--border, #cbd5e1)",
                  fontSize: "0.9rem",
                }}
              >
                <option value="">No video</option>
                {readyVideos.map((v) => (
                  <option key={v.id} value={String(v.id)}>
                    {(v.title || "Untitled video") +
                      (v.durationSec != null
                        ? ` (${formatVideoDuration(v.durationSec)})`
                        : "")}
                  </option>
                ))}
              </select>
              <span
                style={{ fontSize: "0.8rem", color: "var(--muted, #64748b)" }}
              >
                Record videos in the PulseDNA Studio. Ready videos appear here.
              </span>
            </div>
          )}

          {/* Email nudge */}
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={emailNudge}
              onChange={(e) => setEmailNudge(e.target.checked)}
            />
            <span style={{ fontSize: "0.9rem" }}>
              Also email a nudge to families with an address on file
            </span>
          </label>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              type="button"
              className="btn primary"
              disabled={sending}
              onClick={handleSend}
            >
              {sending ? "Sending…" : "Send message"}
            </button>
            {sendError && (
              <span style={{ color: "#dc2626", fontSize: "0.85rem" }}>
                {sendError}
              </span>
            )}
          </div>

          {sendResult && (
            <div
              style={{
                borderRadius: 10,
                border: "1px solid #99f6e4",
                background: "#f0fdfa",
                padding: "0.75rem 0.9rem",
                fontSize: "0.85rem",
              }}
            >
              <strong>Sent.</strong> Reached {sendResult.reachedRecipients} of{" "}
              {sendResult.totalRecipients} famil
              {sendResult.totalRecipients === 1 ? "y" : "ies"}
              {sendResult.emailsSent > 0
                ? ` · ${sendResult.emailsSent} email${
                    sendResult.emailsSent === 1 ? "" : "s"
                  } sent`
                : ""}
              .
              {sendResult.unmatchedSisIds.length > 0 && (
                <div style={{ marginTop: 6, color: "#b45309" }}>
                  {sendResult.unmatchedSisIds.length} ID
                  {sendResult.unmatchedSisIds.length === 1 ? "" : "s"} didn't
                  match any student:{" "}
                  {sendResult.unmatchedSisIds.slice(0, 10).join(", ")}
                  {sendResult.unmatchedSisIds.length > 10 ? "…" : ""}
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* ---- Sent messages + counters ---- */}
      <section className="card" style={{ overflow: "visible" }}>
        <h3 style={{ marginTop: 0 }}>Sent messages</h3>
        {loadingList && <p style={{ color: "var(--muted, #64748b)" }}>Loading…</p>}
        {listError && <p style={{ color: "#dc2626" }}>{listError}</p>}
        {!loadingList && !listError && messages.length === 0 && (
          <p style={{ color: "var(--muted, #64748b)" }}>
            No messages sent yet.
          </p>
        )}
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {messages.map((m) => (
            <div
              key={m.id}
              style={{
                border: "1px solid var(--border, #e2e8f0)",
                borderRadius: 12,
                padding: "0.9rem 1rem",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{m.subject}</div>
                  <div style={{ fontSize: "0.8rem", color: "var(--muted, #64748b)" }}>
                    {m.senderName} · {formatWhen(m.createdAt)}
                    {m.hasAttachment ? " · 📎 attachment" : ""}
                    {m.videoId ? " · 🎥 video" : ""}
                    {m.emailNudge ? " · email nudge" : ""}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn"
                  onClick={() => openDetail(m.id)}
                >
                  View recipients
                </button>
              </div>

              <div style={{ display: "flex", gap: 18, marginTop: 10, flexWrap: "wrap" }}>
                <Counter label="Sent" value={m.totalRecipients} />
                <Counter
                  label="Reached"
                  value={m.reachedRecipients}
                  sub={pct(m.reachedRecipients, m.totalRecipients)}
                />
                <Counter
                  label="Got it"
                  value={m.acknowledgedRecipients}
                  sub={pct(m.acknowledgedRecipients, m.reachedRecipients)}
                  accent
                />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ---- Detail drawer ---- */}
      {(detail || detailLoading) && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => {
            setDetail(null);
            setDetailLoading(false);
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,23,42,0.45)",
            display: "flex",
            justifyContent: "flex-end",
            zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(560px, 100%)",
              height: "100%",
              background: "var(--card-bg, #fff)",
              boxShadow: "-8px 0 24px rgba(0,0,0,0.15)",
              overflowY: "auto",
              padding: "1.25rem",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0 }}>Recipients</h3>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setDetail(null);
                  setDetailLoading(false);
                }}
              >
                Close
              </button>
            </div>

            {detailLoading && (
              <p style={{ color: "var(--muted, #64748b)" }}>Loading…</p>
            )}

            {detail && (
              <>
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontWeight: 700 }}>{detail.subject}</div>
                  <p style={{ whiteSpace: "pre-wrap", fontSize: "0.9rem" }}>
                    {detail.body}
                  </p>
                  {detail.hasAttachment && (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => downloadStaffAttachment(detail)}
                    >
                      📎 Download {detail.attachmentName || "attachment"}
                    </button>
                  )}
                </div>

                <div style={{ display: "flex", gap: 18, margin: "14px 0" }}>
                  <Counter label="Sent" value={detail.totalRecipients} />
                  <Counter
                    label="Reached"
                    value={detail.reachedRecipients}
                    sub={pct(detail.reachedRecipients, detail.totalRecipients)}
                  />
                  <Counter
                    label="Got it"
                    value={detail.acknowledgedRecipients}
                    sub={pct(
                      detail.acknowledgedRecipients,
                      detail.reachedRecipients,
                    )}
                    accent
                  />
                </div>

                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                  <thead>
                    <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border, #e2e8f0)" }}>
                      <th style={{ padding: "6px 4px" }}>Family</th>
                      <th style={{ padding: "6px 4px" }}>Channel</th>
                      <th style={{ padding: "6px 4px" }}>Got it</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.recipients.map((r) => (
                      <tr key={r.id} style={{ borderBottom: "1px solid var(--border, #f1f5f9)" }}>
                        <td style={{ padding: "6px 4px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span>{r.name}</span>
                            {r.isPowerReader && (
                              <span
                                title="Power Reader — consistently acknowledges"
                                style={{
                                  fontSize: "0.7rem",
                                  background: "#fef3c7",
                                  color: "#b45309",
                                  borderRadius: 999,
                                  padding: "1px 6px",
                                  fontWeight: 700,
                                }}
                              >
                                ★ Power Reader
                              </span>
                            )}
                          </div>
                          {!r.hasAccount && r.email && (
                            <div style={{ fontSize: "0.72rem", color: "var(--muted, #94a3b8)" }}>
                              {r.email} (no portal account)
                            </div>
                          )}
                        </td>
                        <td style={{ padding: "6px 4px" }}>
                          {[
                            r.deliveredPortal ? "Portal" : null,
                            r.deliveredEmail ? "Email" : null,
                          ]
                            .filter(Boolean)
                            .join(" + ") || "—"}
                        </td>
                        <td style={{ padding: "6px 4px" }}>
                          {r.acknowledgedAt ? (
                            <span style={{ color: "#059669", fontWeight: 600 }}>
                              ✓ {formatWhen(r.acknowledgedAt)}
                            </span>
                          ) : (
                            <span style={{ color: "var(--muted, #94a3b8)" }}>—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function Counter({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: number;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div>
      <div style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--muted, #64748b)" }}>
        {label}
      </div>
      <div
        style={{
          fontSize: "1.5rem",
          fontWeight: 800,
          color: accent ? "#0f766e" : "var(--text, #0f172a)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
        {sub && (
          <span style={{ fontSize: "0.8rem", fontWeight: 600, marginLeft: 6, color: "var(--muted, #64748b)" }}>
            {sub}
          </span>
        )}
      </div>
    </div>
  );
}
