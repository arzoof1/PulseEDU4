// Displays / digital-signage admin UI.
//
// Two view modes inside one component (driven by `editing`):
//   1. List view: cards for every playlist visible to the caller,
//      plus a "+ New playlist" affordance.
//   2. Editor view: pick a playlist → name / default duration /
//      PBIS-toggle, an item table with per-item duration override,
//      enable/disable, drag-reorder via up/down arrows, file upload,
//      and a small live preview iframe of /display/<id>.
//
// Capability gating happens at the App.tsx nav level — by the time
// this component renders, the caller is already authorized to manage
// at least one playlist. The server enforces the same gate for every
// write so a teacher who manually visits this page can't escalate.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { authFetch } from "../lib/authToken";

interface PlaylistRow {
  id: number;
  schoolId: number;
  ownerStaffId: number | null;
  ownerDisplayName: string | null;
  name: string;
  defaultDurationSeconds: number;
  showPbisHousePage: boolean;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
}

interface PlaylistItem {
  id: number;
  playlistId: number;
  orderIndex: number;
  kind: "image" | "video" | "audio" | "pdf" | "url";
  // For uploaded media these come back from object storage. For
  // kind=url items they are NULL on the server and we substitute a
  // sensible label client-side.
  objectPath: string | null;
  originalFilename: string | null;
  mimeType: string | null;
  sizeBytes: number;
  durationSeconds: number | null;
  enabled: boolean;
  createdAt: string;
  // Only populated for kind=url.
  url: string | null;
}

interface PlaylistDetail {
  playlist: {
    id: number;
    schoolId: number;
    ownerStaffId: number | null;
    name: string;
    defaultDurationSeconds: number;
    showPbisHousePage: boolean;
    showActiveHallPasses: boolean;
    showHeartbeat: boolean;
    scheduleEnabled: boolean;
    scheduleStartTime: string | null;
    scheduleEndTime: string | null;
    scheduleDaysOfWeek: string | null;
    createdAt: string;
    updatedAt: string;
  };
  items: PlaylistItem[];
}

const WEEKDAY_LABELS: ReadonlyArray<{ idx: number; label: string }> = [
  { idx: 0, label: "Sun" },
  { idx: 1, label: "Mon" },
  { idx: 2, label: "Tue" },
  { idx: 3, label: "Wed" },
  { idx: 4, label: "Thu" },
  { idx: 5, label: "Fri" },
  { idx: 6, label: "Sat" },
];

function parseDaysCsv(s: string | null | undefined): Set<number> {
  if (!s) return new Set();
  const out = new Set<number>();
  for (const part of s.split(",")) {
    const n = Number.parseInt(part.trim(), 10);
    if (Number.isInteger(n) && n >= 0 && n <= 6) out.add(n);
  }
  return out;
}

const card: CSSProperties = {
  background: "white",
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  padding: 16,
  boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
};

const btn: CSSProperties = {
  border: "1px solid #d1d5db",
  background: "white",
  borderRadius: 8,
  padding: "6px 12px",
  cursor: "pointer",
  fontSize: 14,
};

const btnPrimary: CSSProperties = {
  ...btn,
  background: "#2563eb",
  color: "white",
  borderColor: "#2563eb",
};

const btnDanger: CSSProperties = {
  ...btn,
  background: "white",
  color: "#b91c1c",
  borderColor: "#fca5a5",
};

const inputStyle: CSSProperties = {
  border: "1px solid #d1d5db",
  borderRadius: 8,
  padding: "6px 10px",
  fontSize: 14,
  background: "white",
};

function kindIcon(kind: PlaylistItem["kind"]): string {
  switch (kind) {
    case "image":
      return "🖼️";
    case "video":
      return "🎬";
    case "audio":
      return "🔊";
    case "pdf":
      return "📄";
    case "url":
      return "🔗";
  }
}

function publicUrlFor(playlistId: number): string {
  return `${window.location.origin}/display/${playlistId}`;
}

export default function Displays() {
  const [playlists, setPlaylists] = useState<PlaylistRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refreshList() {
    setLoading(true);
    try {
      const r = await authFetch("/api/displays/playlists");
      if (!r.ok) throw new Error("Failed to load");
      const j = (await r.json()) as { playlists: PlaylistRow[] };
      setPlaylists(j.playlists ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshList();
  }, []);

  async function createPlaylist() {
    const name = window.prompt("New playlist name (e.g. 'Lobby TV'):");
    if (!name || !name.trim()) return;
    try {
      const r = await authFetch("/api/displays/playlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          defaultDurationSeconds: 10,
          showPbisHousePage: false,
        }),
      });
      const j = (await r.json()) as
        | { playlist: PlaylistRow }
        | { error: string };
      if (!r.ok || "error" in j) {
        throw new Error(("error" in j && j.error) || "Failed");
      }
      await refreshList();
      setEditingId(j.playlist.id);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed to create");
    }
  }

  async function deletePlaylist(p: PlaylistRow) {
    if (
      !window.confirm(
        `Delete "${p.name}"? This removes the playlist and any uploaded items.`,
      )
    ) {
      return;
    }
    try {
      const r = await authFetch(`/api/displays/playlists/${p.id}`, {
        method: "DELETE",
      });
      if (!r.ok) throw new Error("Failed");
      await refreshList();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed to delete");
    }
  }

  if (editingId !== null) {
    return (
      <PlaylistEditor
        playlistId={editingId}
        onBack={async () => {
          setEditingId(null);
          await refreshList();
        }}
      />
    );
  }

  return (
    <div style={{ padding: 16, maxWidth: 1100, margin: "0 auto" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Displays</h1>
          <div style={{ color: "#6b7280", marginTop: 4, fontSize: 14 }}>
            Build a slideshow for any TV in the building. Open the public link
            on a smart TV's browser — no login required on the TV.
          </div>
        </div>
        <button style={btnPrimary} onClick={() => void createPlaylist()}>
          + New playlist
        </button>
      </div>

      {error && (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#b91c1c",
            borderRadius: 8,
            padding: 10,
            marginBottom: 12,
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ color: "#6b7280" }}>Loading…</div>
      ) : playlists.length === 0 ? (
        <div style={{ ...card, textAlign: "center", color: "#6b7280" }}>
          No playlists yet. Click "+ New playlist" to create your first one.
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: 12,
          }}
        >
          {playlists.map((p) => (
            <div key={p.id} style={card}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontSize: 16,
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                    title={p.name}
                  >
                    {p.name}
                  </div>
                  <div
                    style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}
                  >
                    {p.itemCount} item{p.itemCount === 1 ? "" : "s"} ·{" "}
                    {p.defaultDurationSeconds}s default
                    {p.showPbisHousePage ? " · 🏠 House page" : ""}
                    {p.showActiveHallPasses ? " · 🎫 Hall passes" : ""}
                    {p.showHeartbeat ? " · 💓 Heartbeat" : ""}
                  </div>
                  <div
                    style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}
                  >
                    Owner:{" "}
                    {p.ownerDisplayName ?? (
                      <span style={{ fontStyle: "italic" }}>
                        Whole school
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button style={btn} onClick={() => setEditingId(p.id)}>
                  Edit
                </button>
                <a
                  href={publicUrlFor(p.id)}
                  target="_blank"
                  rel="noreferrer"
                  style={{ ...btn, textDecoration: "none", color: "#111827" }}
                >
                  Open
                </a>
                <button
                  style={btnDanger}
                  onClick={() => void deletePlaylist(p)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ===================================================================
// Editor
// ===================================================================

function PlaylistEditor({
  playlistId,
  onBack,
}: {
  playlistId: number;
  onBack: () => void | Promise<void>;
}) {
  const [detail, setDetail] = useState<PlaylistDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // Bumped on every edit so the preview iframe re-fetches the
  // playlist (it has its own poll, but bumping forces an immediate
  // refresh so admins see edits land instantly).
  const [previewNonce, setPreviewNonce] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const r = await authFetch(`/api/displays/playlists/${playlistId}`);
      if (!r.ok) throw new Error("Failed to load");
      const j = (await r.json()) as PlaylistDetail;
      setDetail(j);
      setError(null);
      setPreviewNonce((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlistId]);

  async function patchPlaylist(update: {
    name?: string;
    defaultDurationSeconds?: number;
    showPbisHousePage?: boolean;
    showActiveHallPasses?: boolean;
    showHeartbeat?: boolean;
    scheduleEnabled?: boolean;
    scheduleStartTime?: string | null;
    scheduleEndTime?: string | null;
    scheduleDaysOfWeek?: string | null;
    itemOrder?: number[];
  }) {
    try {
      const r = await authFetch(`/api/displays/playlists/${playlistId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
      const j = (await r.json()) as
        | { playlist: PlaylistDetail["playlist"] }
        | { error: string };
      if (!r.ok || "error" in j) {
        throw new Error(("error" in j && j.error) || "Failed");
      }
      await refresh();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed to update");
    }
  }

  async function patchItem(
    itemId: number,
    update: { durationSeconds?: number | null; enabled?: boolean },
  ) {
    try {
      const r = await authFetch(
        `/api/displays/playlists/${playlistId}/items/${itemId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        },
      );
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(j?.error ?? "Failed");
      }
      await refresh();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed");
    }
  }

  async function deleteItem(item: PlaylistItem) {
    if (!window.confirm(`Remove "${item.originalFilename}" from the playlist?`)) {
      return;
    }
    try {
      const r = await authFetch(
        `/api/displays/playlists/${playlistId}/items/${item.id}`,
        { method: "DELETE" },
      );
      if (!r.ok) throw new Error("Failed");
      await refresh();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed");
    }
  }

  async function moveItem(idx: number, dir: -1 | 1) {
    if (!detail) return;
    const items = [...detail.items];
    const target = idx + dir;
    if (target < 0 || target >= items.length) return;
    const tmp = items[idx];
    items[idx] = items[target];
    items[target] = tmp;
    await patchPlaylist({ itemOrder: items.map((i) => i.id) });
  }

  async function handleAddUrl() {
    // Lightweight prompt-based flow — keeps the editor pageful but
    // lets staff drop in a Slides / weather / district news embed in
    // seconds. We pre-validate the protocol client-side too.
    const raw = window.prompt(
      "Paste an https:// URL to embed as a slide:",
      "https://",
    );
    if (!raw) return;
    const url = raw.trim();
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new Error("Only http:// or https:// URLs are allowed");
      }
    } catch {
      window.alert("That doesn't look like a valid URL.");
      return;
    }
    const label = window.prompt(
      "Optional label (shown in the editor list):",
      url,
    );
    try {
      const r = await authFetch(
        `/api/displays/playlists/${playlistId}/items`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "url",
            url,
            originalFilename: label ?? url,
          }),
        },
      );
      const j = (await r.json()) as
        | { item: PlaylistItem }
        | { error: string };
      if (!r.ok || "error" in j) {
        throw new Error(("error" in j && j.error) || "Failed to add URL");
      }
      await refresh();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed to add URL");
    }
  }

  async function handleUpload(file: File) {
    setUploading(true);
    try {
      // Step 1: ask the server for a presigned PUT URL.
      const r1 = await authFetch("/api/storage/uploads/request-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const j1 = (await r1.json()) as
        | { uploadURL: string; objectPath?: string }
        | { error: string };
      if (!r1.ok || "error" in j1) {
        throw new Error(("error" in j1 && j1.error) || "Upload setup failed");
      }
      // Server returns the signed URL; the path the API expects back
      // when we register the item is /objects/<gcs object id>. We
      // derive it from the signed URL's pathname tail.
      const u = new URL(j1.uploadURL);
      // GCS path looks like /<bucket>/.private/uploads/<id>; we want
      // /objects/uploads/<id> which is what the auth-gated GET maps
      // to. The storage skill / route stores under the same prefix.
      const tail = u.pathname.split("/.private/")[1] ?? "";
      if (!tail) throw new Error("Could not parse upload path");
      const objectPath = `/objects/${tail}`;

      // Step 2: PUT the file body.
      const r2 = await fetch(j1.uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!r2.ok) throw new Error(`Upload failed (${r2.status})`);

      // Step 3: register the item.
      const r3 = await authFetch(
        `/api/displays/playlists/${playlistId}/items`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            objectPath,
            originalFilename: file.name,
            mimeType: file.type || "application/octet-stream",
            sizeBytes: file.size,
          }),
        },
      );
      const j3 = (await r3.json()) as
        | { item: PlaylistItem }
        | { error: string };
      if (!r3.ok || "error" in j3) {
        throw new Error(("error" in j3 && j3.error) || "Failed to add item");
      }
      await refresh();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const publicUrl = useMemo(() => publicUrlFor(playlistId), [playlistId]);

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <button style={btn} onClick={() => void onBack()}>
          ← Back
        </button>
        <div style={{ marginTop: 16, color: "#6b7280" }}>Loading…</div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div style={{ padding: 16 }}>
        <button style={btn} onClick={() => void onBack()}>
          ← Back
        </button>
        <div style={{ marginTop: 16, color: "#b91c1c" }}>
          {error ?? "Playlist not found"}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 16, maxWidth: 1200, margin: "0 auto" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button style={btn} onClick={() => void onBack()}>
            ← Back
          </button>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>
            {detail.playlist.name}
          </h1>
        </div>
        <a
          href={publicUrl}
          target="_blank"
          rel="noreferrer"
          style={{ ...btnPrimary, textDecoration: "none" }}
        >
          Open public URL ↗
        </a>
      </div>

      {/* Settings card + preview side-by-side */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 360px",
          gap: 16,
          marginBottom: 16,
        }}
      >
        <div style={card}>
          <div style={{ display: "grid", gap: 12 }}>
            <label style={{ display: "block" }}>
              <div
                style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}
              >
                Name
              </div>
              <input
                style={{ ...inputStyle, width: "100%" }}
                defaultValue={detail.playlist.name}
                onBlur={(e) => {
                  const v = e.currentTarget.value.trim();
                  if (v && v !== detail.playlist.name) {
                    void patchPlaylist({ name: v });
                  }
                }}
              />
            </label>
            <label style={{ display: "block", maxWidth: 200 }}>
              <div
                style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}
              >
                Default duration (seconds)
              </div>
              <input
                type="number"
                min={2}
                max={600}
                style={{ ...inputStyle, width: "100%" }}
                defaultValue={detail.playlist.defaultDurationSeconds}
                onBlur={(e) => {
                  const n = Number.parseInt(e.currentTarget.value, 10);
                  if (
                    Number.isFinite(n) &&
                    n !== detail.playlist.defaultDurationSeconds
                  ) {
                    void patchPlaylist({ defaultDurationSeconds: n });
                  }
                }}
              />
              <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>
                Used for images and PDF pages when an item doesn't override
                it. Videos and audio always play to their natural end.
              </div>
            </label>
            <label
              style={{ display: "flex", alignItems: "center", gap: 8 }}
            >
              <input
                type="checkbox"
                checked={detail.playlist.showPbisHousePage}
                onChange={(e) =>
                  void patchPlaylist({
                    showPbisHousePage: e.currentTarget.checked,
                  })
                }
              />
              <span style={{ fontSize: 14 }}>
                Show PBIS Houses slide each loop
              </span>
            </label>
            <label
              style={{ display: "flex", alignItems: "center", gap: 8 }}
            >
              <input
                type="checkbox"
                checked={detail.playlist.showActiveHallPasses}
                onChange={(e) =>
                  void patchPlaylist({
                    showActiveHallPasses: e.currentTarget.checked,
                  })
                }
              />
              <span style={{ fontSize: 14 }}>
                Show Active Hall Passes slide each loop
              </span>
            </label>
            <label
              style={{ display: "flex", alignItems: "center", gap: 8 }}
            >
              <input
                type="checkbox"
                checked={detail.playlist.showHeartbeat}
                onChange={(e) =>
                  void patchPlaylist({
                    showHeartbeat: e.currentTarget.checked,
                  })
                }
              />
              <span style={{ fontSize: 14 }}>
                Show Today's Heartbeat slide each loop
              </span>
            </label>
            <ScheduleEditor
              playlist={detail.playlist}
              onPatch={patchPlaylist}
            />
          </div>
        </div>

        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
            Live preview
          </div>
          <div
            style={{
              background: "black",
              borderRadius: 8,
              overflow: "hidden",
              aspectRatio: "16 / 9",
            }}
          >
            <iframe
              key={previewNonce}
              src={`/display/${playlistId}?preview=1`}
              title="Display preview"
              style={{
                width: "100%",
                height: "100%",
                border: 0,
                display: "block",
              }}
            />
          </div>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>
            Shareable link:{" "}
            <code style={{ fontSize: 11 }}>{publicUrl}</code>
          </div>
        </div>
      </div>

      {/* Schedule overrides */}
      <div style={{ marginBottom: 16 }}>
        <OverridesEditor displayId={playlistId} schoolId={detail.playlist.schoolId} />
      </div>

      {/* Items table */}
      <div style={card}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 600 }}>
            Items ({detail.items.length})
          </div>
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/mp4,audio/wav,audio/mpeg,application/pdf"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.currentTarget.files?.[0];
                if (f) void handleUpload(f);
              }}
            />
            <button
              style={btn}
              onClick={() => void handleAddUrl()}
              title="Embed any web page as a slide"
            >
              + Add URL
            </button>
            <button
              style={{ ...btnPrimary, marginLeft: 8 }}
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? "Uploading…" : "+ Upload file"}
            </button>
          </div>
        </div>

        {detail.items.length === 0 ? (
          <div style={{ color: "#6b7280", textAlign: "center", padding: 24 }}>
            No items yet. Upload a PNG, MP4, WAV, or PDF to get started.
          </div>
        ) : (
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 14,
            }}
          >
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280" }}>
                <th style={{ padding: "8px 6px", width: 40 }}>#</th>
                <th style={{ padding: "8px 6px", width: 40 }}></th>
                <th style={{ padding: "8px 6px" }}>File</th>
                <th style={{ padding: "8px 6px", width: 140 }}>
                  Duration (s)
                </th>
                <th style={{ padding: "8px 6px", width: 90 }}>Enabled</th>
                <th style={{ padding: "8px 6px", width: 110 }}>Reorder</th>
                <th style={{ padding: "8px 6px", width: 70 }}></th>
              </tr>
            </thead>
            <tbody>
              {detail.items.map((it, idx) => (
                <tr
                  key={it.id}
                  style={{
                    borderTop: "1px solid #e5e7eb",
                    opacity: it.enabled ? 1 : 0.55,
                  }}
                >
                  <td style={{ padding: "8px 6px", color: "#6b7280" }}>
                    {idx + 1}
                  </td>
                  <td
                    style={{ padding: "8px 6px", fontSize: 20, lineHeight: 1 }}
                  >
                    {kindIcon(it.kind)}
                  </td>
                  <td
                    style={{
                      padding: "8px 6px",
                      maxWidth: 320,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={it.url ?? it.originalFilename ?? ""}
                  >
                    {it.kind === "url"
                      ? (it.originalFilename ?? it.url ?? "URL")
                      : it.originalFilename}
                    <div style={{ fontSize: 11, color: "#9ca3af" }}>
                      {it.kind === "url" ? it.url : it.mimeType}
                    </div>
                  </td>
                  <td style={{ padding: "8px 6px" }}>
                    {it.kind === "video" || it.kind === "audio" ? (
                      <span style={{ color: "#9ca3af", fontSize: 12 }}>
                        plays to end
                      </span>
                    ) : (
                      <input
                        type="number"
                        min={2}
                        max={600}
                        placeholder={`(default ${detail.playlist.defaultDurationSeconds})`}
                        defaultValue={it.durationSeconds ?? ""}
                        style={{ ...inputStyle, width: 110 }}
                        onBlur={(e) => {
                          const raw = e.currentTarget.value.trim();
                          if (raw === "") {
                            if (it.durationSeconds !== null) {
                              void patchItem(it.id, { durationSeconds: null });
                            }
                            return;
                          }
                          const n = Number.parseInt(raw, 10);
                          if (
                            Number.isFinite(n) &&
                            n !== it.durationSeconds
                          ) {
                            void patchItem(it.id, { durationSeconds: n });
                          }
                        }}
                      />
                    )}
                  </td>
                  <td style={{ padding: "8px 6px" }}>
                    <input
                      type="checkbox"
                      checked={it.enabled}
                      onChange={(e) =>
                        void patchItem(it.id, {
                          enabled: e.currentTarget.checked,
                        })
                      }
                    />
                  </td>
                  <td style={{ padding: "8px 6px" }}>
                    <button
                      style={{ ...btn, padding: "2px 8px", marginRight: 4 }}
                      disabled={idx === 0}
                      onClick={() => void moveItem(idx, -1)}
                      aria-label="Move up"
                    >
                      ↑
                    </button>
                    <button
                      style={{ ...btn, padding: "2px 8px" }}
                      disabled={idx === detail.items.length - 1}
                      onClick={() => void moveItem(idx, 1)}
                      aria-label="Move down"
                    >
                      ↓
                    </button>
                  </td>
                  <td style={{ padding: "8px 6px", textAlign: "right" }}>
                    <button
                      style={btnDanger}
                      onClick={() => void deleteItem(it)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ===================================================================
// OverridesEditor — list / add / edit / delete schedule overrides for a
// single display. An override row says "on day X between HH:MM and
// HH:MM, play THIS OTHER playlist instead of my own items".
//
// Two add modes:
//   - Single: pick day + start + end + playlist
//   - Bulk:   pick playlist + start + end + multiple days at once
//             (uses POST /overrides/bulk so all-or-nothing)
// ===================================================================

interface OverrideRow {
  id: number;
  displayId: number;
  playlistId: number;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  // Set when this row was created as part of a multi-day bulk add
  // (e.g. "passing period 8:55, M–F"). All five rows share the same
  // groupId and groupName, which lets the UI offer
  // "edit/delete this day only vs the entire passing period".
  groupId: string | null;
  groupName: string | null;
}

function OverridesEditor({
  displayId,
  schoolId,
}: {
  displayId: number;
  schoolId: number;
}) {
  const [rows, setRows] = useState<OverrideRow[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState<"single" | "bulk" | null>(null);
  // When set, the dialog opens in EDIT mode for this row.
  const [editing, setEditing] = useState<OverrideRow | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const [r1, r2] = await Promise.all([
        authFetch(`/api/displays/playlists/${displayId}/overrides`),
        authFetch(`/api/displays/playlists`),
      ]);
      const j1 = (await r1.json()) as { overrides: OverrideRow[] };
      const j2 = (await r2.json()) as { playlists: PlaylistRow[] };
      setRows(j1.overrides ?? []);
      // Only same-school playlists are valid override targets.
      setPlaylists(
        (j2.playlists ?? []).filter((p) => p.schoolId === schoolId),
      );
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed to load overrides");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayId]);

  // Returns rows that look like they belong to the same passing
  // period as `row`. Either an explicit group_id match (rows added
  // via bulk-add since the group_id column landed) OR an implicit
  // match (older bulk-added rows whose playlistId + startTime +
  // endTime line up across multiple days). Always includes `row`.
  function siblingRows(row: OverrideRow): OverrideRow[] {
    if (row.groupId) {
      return rows.filter((r) => r.groupId === row.groupId);
    }
    return rows.filter(
      (r) =>
        r.playlistId === row.playlistId &&
        r.startTime === row.startTime &&
        r.endTime === row.endTime,
    );
  }

  async function deleteRow(row: OverrideRow) {
    const siblings = siblingRows(row);
    const oneDayLabel = `${WEEKDAY_LABELS[row.dayOfWeek].label} ${row.startTime}–${row.endTime}`;
    if (siblings.length > 1) {
      // Multi-day passing period — explicit OR implicit. Ask scope first.
      const periodLabel =
        row.groupName ?? `${row.startTime}–${row.endTime}`;
      const wholeGroup = window.confirm(
        `Delete the ENTIRE "${periodLabel}" passing period (${siblings.length} days)?\n\n` +
          `OK = delete all ${siblings.length} days.\n` +
          `Cancel = delete only ${oneDayLabel}.`,
      );
      try {
        if (wholeGroup) {
          if (row.groupId) {
            const r = await authFetch(
              `/api/displays/playlists/${displayId}/overrides/group/${row.groupId}`,
              { method: "DELETE" },
            );
            if (!r.ok) throw new Error("Failed");
          } else {
            // Implicit group — delete each row individually so we never
            // accidentally take down an unrelated row that happens to
            // share a group_id elsewhere.
            await Promise.all(
              siblings.map((s) =>
                authFetch(
                  `/api/displays/playlists/${displayId}/overrides/${s.id}`,
                  { method: "DELETE" },
                ).then((r) => {
                  if (!r.ok) throw new Error("Failed");
                }),
              ),
            );
          }
        } else {
          if (!window.confirm(`Delete override on ${oneDayLabel}?`)) return;
          const r = await authFetch(
            `/api/displays/playlists/${displayId}/overrides/${row.id}`,
            { method: "DELETE" },
          );
          if (!r.ok) throw new Error("Failed");
        }
        await refresh();
      } catch (e) {
        window.alert(e instanceof Error ? e.message : "Failed");
      }
      return;
    }
    if (!window.confirm(`Delete override on ${oneDayLabel}?`)) return;
    try {
      const r = await authFetch(
        `/api/displays/playlists/${displayId}/overrides/${row.id}`,
        { method: "DELETE" },
      );
      if (!r.ok) throw new Error("Failed");
      await refresh();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed");
    }
  }

  // Group rows by day so the weekly view is scannable.
  const byDay = useMemo(() => {
    const m = new Map<number, OverrideRow[]>();
    for (const r of rows) {
      const list = m.get(r.dayOfWeek) ?? [];
      list.push(r);
      m.set(r.dayOfWeek, list);
    }
    return m;
  }, [rows]);

  function nameFor(playlistId: number): string {
    return playlists.find((p) => p.id === playlistId)?.name ?? `#${playlistId}`;
  }

  return (
    <div style={card}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Schedule overrides</div>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
            Replace this display's normal loop with another playlist during
            specific weekly windows. Tie-break: earliest start wins. The
            cycler restarts at slide 1 whenever the active window changes.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={btn} onClick={() => setShowAdd("bulk")}>+ Passing period</button>
          <button style={btnPrimary} onClick={() => setShowAdd("single")}>+ Single override</button>
        </div>
      </div>

      {loading ? (
        <div style={{ color: "#6b7280" }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: "#6b7280", textAlign: "center", padding: 16, fontSize: 13 }}>
          No overrides yet. The display plays its own items 24/7 (subject to
          its schedule above).
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 8 }}>
          {WEEKDAY_LABELS.map((d) => {
            const dayRows = (byDay.get(d.idx) ?? []).slice().sort((a, b) =>
              a.startTime.localeCompare(b.startTime),
            );
            return (
              <div
                key={d.idx}
                style={{
                  border: "1px solid #e5e7eb",
                  borderRadius: 8,
                  padding: 8,
                  minHeight: 80,
                  background: "#fafafa",
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 6 }}>
                  {d.label}
                </div>
                {dayRows.length === 0 ? (
                  <div style={{ fontSize: 11, color: "#9ca3af", fontStyle: "italic" }}>—</div>
                ) : (
                  <div style={{ display: "grid", gap: 6 }}>
                    {dayRows.map((row) => (
                      <div
                        key={row.id}
                        style={{
                          background: "white",
                          border: "1px solid #d1d5db",
                          borderRadius: 6,
                          padding: 6,
                          fontSize: 11,
                        }}
                      >
                        <div style={{ fontWeight: 600 }}>
                          {row.startTime}–{row.endTime}
                        </div>
                        {row.groupName && (
                          <div
                            style={{
                              fontSize: 10,
                              color: "#0369a1",
                              background: "#e0f2fe",
                              border: "1px solid #bae6fd",
                              borderRadius: 4,
                              padding: "1px 4px",
                              marginTop: 3,
                              display: "inline-block",
                              maxWidth: "100%",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={`Part of "${row.groupName}" — applied to multiple days`}
                          >
                            ⛓ {row.groupName}
                          </div>
                        )}
                        <div
                          style={{
                            color: "#374151",
                            marginTop: 2,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={nameFor(row.playlistId)}
                        >
                          → {nameFor(row.playlistId)}
                        </div>
                        <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                          <button
                            style={{
                              ...btn,
                              padding: "2px 6px",
                              fontSize: 10,
                              flex: 1,
                            }}
                            onClick={() => setEditing(row)}
                          >
                            Edit
                          </button>
                          <button
                            style={{
                              ...btn,
                              padding: "2px 6px",
                              fontSize: 10,
                              color: "#b91c1c",
                              borderColor: "#fca5a5",
                            }}
                            onClick={() => void deleteRow(row)}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showAdd && (
        <AddOverrideDialog
          mode={showAdd}
          schoolId={schoolId}
          displayId={displayId}
          playlists={playlists}
          onPlaylistsChanged={refresh}
          onClose={() => setShowAdd(null)}
          onSaved={async () => {
            setShowAdd(null);
            await refresh();
          }}
        />
      )}
      {editing && (
        <AddOverrideDialog
          mode="edit"
          schoolId={schoolId}
          displayId={displayId}
          playlists={playlists}
          editing={editing}
          // Pass every sibling row (explicit OR implicit group) so the
          // dialog can offer the same "this day vs all matching days"
          // toggle for legacy bulk-added rows that have no group_id.
          editingSiblingIds={siblingRows(editing).map((r) => r.id)}
          onPlaylistsChanged={refresh}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function AddOverrideDialog({
  mode,
  schoolId,
  displayId,
  playlists,
  editing,
  editingSiblingIds,
  onPlaylistsChanged,
  onClose,
  onSaved,
}: {
  mode: "single" | "bulk" | "edit";
  schoolId: number;
  displayId: number;
  playlists: PlaylistRow[];
  // Pre-populated row when mode === "edit". Ignored otherwise.
  editing?: OverrideRow;
  // Every row id (including `editing.id`) that the parent considers
  // part of the same passing period — explicit `groupId` match OR
  // implicit (same playlist + start + end on different days).
  // Used to enable the scope toggle for legacy bulk-added rows.
  editingSiblingIds?: number[];
  // Called after a quick-create so the parent re-fetches the dropdown.
  onPlaylistsChanged?: () => void | Promise<void>;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [playlistId, setPlaylistId] = useState<number | "">(
    editing?.playlistId ?? playlists[0]?.id ?? "",
  );
  const [days, setDays] = useState<Set<number>>(
    editing
      ? new Set([editing.dayOfWeek])
      : new Set([1, 2, 3, 4, 5]),
  );
  const [startTime, setStartTime] = useState(editing?.startTime ?? "08:30");
  const [endTime, setEndTime] = useState(editing?.endTime ?? "09:00");
  // Optional friendly name for a passing-period group. Only shown in
  // bulk mode and in edit mode for an already-grouped row.
  const [groupName, setGroupName] = useState<string>(editing?.groupName ?? "");
  // For edit mode on a grouped row: choose whether the change applies
  // to just this one day or to every day sharing the groupId.
  const siblingCount = editingSiblingIds?.length ?? 0;
  const isGroupedEdit = mode === "edit" && siblingCount > 1;
  const [editScope, setEditScope] = useState<"single" | "group">(
    isGroupedEdit ? "group" : "single",
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function toggleDay(idx: number) {
    const n = new Set(days);
    if (n.has(idx)) n.delete(idx);
    else n.add(idx);
    setDays(n);
  }

  // Quick-create: spin up a new playlist for this period (e.g.
  // "Passing Period 8:30") and select it. Saves the staff a trip to
  // the playlist list.
  async function quickCreatePlaylist() {
    const suggested = `Override ${startTime}–${endTime}`;
    const name = window.prompt(
      "Name for the new playlist (you can add images / URLs to it after):",
      suggested,
    );
    if (!name || !name.trim()) return;
    try {
      const r = await authFetch(`/api/displays/playlists`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schoolId, name: name.trim() }),
      });
      const j = (await r.json()) as
        | { playlist: PlaylistRow }
        | { error: string };
      if (!r.ok || "error" in j) {
        throw new Error(("error" in j && j.error) || "Failed to create");
      }
      setPlaylistId(j.playlist.id);
      await onPlaylistsChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create playlist");
    }
  }

  async function save() {
    setErr(null);
    if (playlistId === "") {
      setErr("Pick a playlist");
      return;
    }
    if (mode === "single" && days.size !== 1) {
      setErr("Pick exactly one day (or use Bulk add)");
      return;
    }
    if (mode === "bulk" && days.size === 0) {
      setErr("Pick at least one day");
      return;
    }
    // In edit mode, day picker is per-day-only edits. Group-scope
    // edits keep the original day set untouched on the server.
    if (mode === "edit" && editScope === "single" && days.size !== 1) {
      setErr("Pick exactly one day");
      return;
    }
    if (endTime <= startTime) {
      setErr("End time must be after start time");
      return;
    }
    setSaving(true);
    try {
      if (mode === "edit" && editing && editScope === "group" && editing.groupId) {
        // Group PATCH — applies playlistId/start/end/groupName to every
        // row sharing this groupId. dayOfWeek is intentionally NOT
        // sent (each row keeps its own day).
        const r = await authFetch(
          `/api/displays/playlists/${displayId}/overrides/group/${editing.groupId}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              playlistId,
              startTime,
              endTime,
              groupName: groupName.trim() || null,
            }),
          },
        );
        if (!r.ok) {
          const j = (await r.json().catch(() => null)) as { error?: string } | null;
          throw new Error(j?.error ?? "Failed");
        }
      } else if (
        mode === "edit" &&
        editing &&
        editScope === "group" &&
        editingSiblingIds &&
        editingSiblingIds.length > 1
      ) {
        // Legacy / implicit group — fan out per-row PATCHes so each row
        // keeps its own day. We deliberately do NOT send dayOfWeek.
        await Promise.all(
          editingSiblingIds.map((id) =>
            authFetch(
              `/api/displays/playlists/${displayId}/overrides/${id}`,
              {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ playlistId, startTime, endTime }),
              },
            ).then(async (r) => {
              if (!r.ok) {
                const j = (await r.json().catch(() => null)) as { error?: string } | null;
                throw new Error(j?.error ?? "Failed");
              }
            }),
          ),
        );
      } else if (mode === "edit" && editing) {
        const day = Array.from(days)[0];
        const r = await authFetch(
          `/api/displays/playlists/${displayId}/overrides/${editing.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ playlistId, dayOfWeek: day, startTime, endTime }),
          },
        );
        if (!r.ok) {
          const j = (await r.json().catch(() => null)) as { error?: string } | null;
          throw new Error(j?.error ?? "Failed");
        }
      } else if (mode === "single") {
        const day = Array.from(days)[0];
        const r = await authFetch(
          `/api/displays/playlists/${displayId}/overrides`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ playlistId, dayOfWeek: day, startTime, endTime }),
          },
        );
        if (!r.ok) {
          const j = (await r.json().catch(() => null)) as { error?: string } | null;
          throw new Error(j?.error ?? "Failed");
        }
      } else {
        const overrides = Array.from(days).map((d) => ({
          playlistId,
          dayOfWeek: d,
          startTime,
          endTime,
        }));
        const r = await authFetch(
          `/api/displays/playlists/${displayId}/overrides/bulk`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              overrides,
              groupName: groupName.trim() || null,
            }),
          },
        );
        if (!r.ok) {
          const j = (await r.json().catch(() => null)) as { error?: string } | null;
          throw new Error(j?.error ?? "Failed");
        }
      }
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "white",
          borderRadius: 12,
          padding: 20,
          width: "min(92vw, 480px)",
          boxShadow: "0 12px 36px rgba(0,0,0,0.3)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>
          {mode === "edit"
            ? "Edit override"
            : mode === "single"
              ? "Add override"
              : "Bulk add overrides"}
        </div>
        <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 16 }}>
          {mode === "edit"
            ? isGroupedEdit && editScope === "group"
              ? "Change time / playlist for every day in this passing period."
              : "Change the day, time, or playlist for this window."
            : mode === "single"
              ? "One window on one day."
              : "Same window applied to every selected day. They'll be linked as one passing period so you can edit them together later."}
        </div>
        {isGroupedEdit && (
          <div
            style={{
              display: "flex",
              gap: 6,
              padding: 4,
              background: "#f3f4f6",
              borderRadius: 8,
              marginBottom: 12,
            }}
          >
            {(
              [
                { v: "group", label: "Entire passing period" },
                { v: "single", label: "Just this day" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.v}
                type="button"
                onClick={() => setEditScope(opt.v)}
                style={{
                  flex: 1,
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: "none",
                  background: editScope === opt.v ? "white" : "transparent",
                  color: editScope === opt.v ? "#1d4ed8" : "#374151",
                  boxShadow:
                    editScope === opt.v
                      ? "0 1px 2px rgba(0,0,0,0.08)"
                      : "none",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
        <div style={{ display: "grid", gap: 12 }}>
          <div>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                marginBottom: 4,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>Play this playlist</span>
              <button
                type="button"
                style={{ ...btn, padding: "2px 8px", fontSize: 11 }}
                onClick={() => void quickCreatePlaylist()}
                disabled={saving}
                title="Create a brand new playlist for this period — you'll add images and URLs to it from the main displays list."
              >
                + New playlist
              </button>
            </div>
            <select
              style={{ ...inputStyle, width: "100%" }}
              value={playlistId}
              onChange={(e) =>
                setPlaylistId(e.currentTarget.value === "" ? "" : Number(e.currentTarget.value))
              }
            >
              <option value="">Pick a playlist…</option>
              {playlists.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>
              Tip: open the new playlist from the displays list to add
              images or URLs (e.g. a school news site, weather page).
            </div>
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <label style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Start</div>
              <input
                type="time"
                style={{ ...inputStyle, width: "100%" }}
                value={startTime}
                onChange={(e) => setStartTime(e.currentTarget.value)}
              />
            </label>
            <label style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>End</div>
              <input
                type="time"
                style={{ ...inputStyle, width: "100%" }}
                value={endTime}
                onChange={(e) => setEndTime(e.currentTarget.value)}
              />
            </label>
          </div>
          {/* Group name input only applies when the row already carries
              a server-side groupId (or for fresh bulk inserts). Legacy
              implicit groups can't store a name without a groupId. */}
          {(mode === "bulk" ||
            (mode === "edit" && editScope === "group" && editing?.groupId)) && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                Passing period name (optional)
              </div>
              <input
                type="text"
                placeholder='e.g. "1st period passing"'
                style={{ ...inputStyle, width: "100%" }}
                value={groupName}
                onChange={(e) => setGroupName(e.currentTarget.value)}
                maxLength={100}
              />
              <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>
                Shows on each day's tile so you can spot grouped rows at
                a glance.
              </div>
            </div>
          )}
          {/* Day picker. Hidden when editing the whole passing-period
              group, since each row keeps its own day on the server. */}
          {!(mode === "edit" && editScope === "group") && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
              {mode === "single" || mode === "edit" ? "Day" : "Days"}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {WEEKDAY_LABELS.map((d) => {
                const on = days.has(d.idx);
                return (
                  <button
                    type="button"
                    key={d.idx}
                    onClick={() => {
                      if (mode === "single" || mode === "edit") {
                        setDays(new Set([d.idx]));
                      } else {
                        toggleDay(d.idx);
                      }
                    }}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 999,
                      border: on ? "1px solid #2563eb" : "1px solid #d1d5db",
                      background: on ? "#dbeafe" : "white",
                      color: on ? "#1d4ed8" : "#374151",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
          </div>
          )}
          {err && (
            <div
              style={{
                background: "#fef2f2",
                border: "1px solid #fecaca",
                color: "#b91c1c",
                borderRadius: 8,
                padding: 8,
                fontSize: 13,
              }}
            >
              {err}
            </div>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button style={btn} onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button style={btnPrimary} onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Schedule editor — collapsible fieldset that lets a user opt the
// playlist into a recurring play window (days-of-week + start/end).
// All fields auto-save on blur or change so the editor stays consistent
// with the rest of the page (no global "Save" button).
function ScheduleEditor(props: {
  playlist: PlaylistDetail["playlist"];
  onPatch: (u: {
    scheduleEnabled?: boolean;
    scheduleStartTime?: string | null;
    scheduleEndTime?: string | null;
    scheduleDaysOfWeek?: string | null;
  }) => Promise<void>;
}) {
  const { playlist, onPatch } = props;
  const days = parseDaysCsv(playlist.scheduleDaysOfWeek);

  function toggleDay(idx: number) {
    const next = new Set(days);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    const csv = Array.from(next).sort((a, b) => a - b).join(",");
    void onPatch({ scheduleDaysOfWeek: csv || null });
  }

  return (
    <fieldset
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        padding: 12,
        marginTop: 4,
      }}
    >
      <legend style={{ fontSize: 13, fontWeight: 600, padding: "0 6px" }}>
        Schedule
      </legend>
      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={playlist.scheduleEnabled}
          onChange={(e) =>
            void onPatch({ scheduleEnabled: e.currentTarget.checked })
          }
        />
        <span style={{ fontSize: 14 }}>
          Only play during a recurring window
        </span>
      </label>
      {playlist.scheduleEnabled && (
        <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
            <label style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                Start
              </div>
              <input
                type="time"
                style={{ ...inputStyle, width: "100%" }}
                defaultValue={playlist.scheduleStartTime ?? ""}
                onBlur={(e) => {
                  const v = e.currentTarget.value;
                  if (v !== (playlist.scheduleStartTime ?? "")) {
                    void onPatch({ scheduleStartTime: v || null });
                  }
                }}
              />
            </label>
            <label style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                End
              </div>
              <input
                type="time"
                style={{ ...inputStyle, width: "100%" }}
                defaultValue={playlist.scheduleEndTime ?? ""}
                onBlur={(e) => {
                  const v = e.currentTarget.value;
                  if (v !== (playlist.scheduleEndTime ?? "")) {
                    void onPatch({ scheduleEndTime: v || null });
                  }
                }}
              />
            </label>
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
              Days
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {WEEKDAY_LABELS.map((d) => {
                const on = days.has(d.idx);
                return (
                  <button
                    type="button"
                    key={d.idx}
                    onClick={() => toggleDay(d.idx)}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 999,
                      border: on
                        ? "1px solid #2563eb"
                        : "1px solid #d1d5db",
                      background: on ? "#dbeafe" : "white",
                      color: on ? "#1d4ed8" : "#374151",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: "#6b7280", marginTop: 6 }}>
              No days selected = every day. Outside the window the screen
              shows an "Off-air" placeholder.
            </div>
          </div>
        </div>
      )}
    </fieldset>
  );
}
