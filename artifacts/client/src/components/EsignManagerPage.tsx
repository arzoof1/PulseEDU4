import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "../lib/authToken";

// =============================================================================
// Document e-Sign manager (Settings tile).
//
// Office staff (admins + the assignable "e-Sign Documents" capability) upload a
// PDF or image, get a shareable signing link (copy or email to a typed
// address), and collect the signed copy back into their own list. Documents are
// PRIVATE TO THE CREATOR — this page only ever shows the caller's own.
// =============================================================================

type EsignDoc = {
  id: number;
  title: string;
  fileType: "pdf" | "image";
  status: "pending" | "signed";
  recipientEmail: string | null;
  signerName: string | null;
  shareToken: string;
  objectPath: string;
  signedObjectPath: string | null;
  createdAt: string;
  signedAt: string | null;
};

type Stats = { total: number; pending: number; signed: number };

const MAX_BYTES = 10 * 1024 * 1024;

function signLinkFor(token: string): string {
  return `${window.location.origin}/sign/${encodeURIComponent(token)}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function EsignManagerPage() {
  const [docs, setDocs] = useState<EsignDoc[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, pending: 0, signed: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form
  const [title, setTitle] = useState("");
  const [email, setEmail] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [copiedId, setCopiedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [listRes, statsRes] = await Promise.all([
        authFetch("/api/esign/documents"),
        authFetch("/api/esign/documents/stats"),
      ]);
      if (!listRes.ok) throw new Error("Could not load documents");
      const listJson = (await listRes.json()) as { documents: EsignDoc[] };
      setDocs(listJson.documents);
      if (statsRes.ok) setStats((await statsRes.json()) as Stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll so a document flips to "signed" without a manual refresh once the
  // recipient submits on their phone.
  useEffect(() => {
    const t = setInterval(() => {
      void load();
    }, 15000);
    return () => clearInterval(t);
  }, [load]);

  function pickFile(f: File | null) {
    setNotice(null);
    if (!f) {
      setFile(null);
      return;
    }
    const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
    const isImage = f.type.startsWith("image/");
    if (!isPdf && !isImage) {
      setNotice("Please choose a PDF or an image file.");
      return;
    }
    if (f.size > MAX_BYTES) {
      setNotice("That file is too large (max 10 MB).");
      return;
    }
    setFile(f);
    if (!title.trim()) {
      setTitle(f.name.replace(/\.[^.]+$/, ""));
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    if (!title.trim()) {
      setNotice("Give the document a title.");
      return;
    }
    if (!file) {
      setNotice("Choose a PDF or image to send.");
      return;
    }
    setBusy(true);
    try {
      const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      const fileType = isPdf ? "pdf" : "image";
      const contentType = file.type || (isPdf ? "application/pdf" : "image/png");

      // 1. Ask the server for a presigned upload URL.
      const reqRes = await authFetch("/api/storage/uploads/request-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          contentType,
        }),
      });
      if (!reqRes.ok) throw new Error("Could not start the upload.");
      const { uploadURL, objectPath } = (await reqRes.json()) as {
        uploadURL: string;
        objectPath: string;
      };

      // 2. PUT the bytes straight to storage.
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: file,
      });
      if (!putRes.ok) throw new Error("The file upload failed.");

      // 3. Persist the document row (and optionally email the link).
      const createRes = await authFetch("/api/esign/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          fileType,
          objectPath,
          recipientEmail: email.trim() || undefined,
        }),
      });
      if (!createRes.ok) {
        const j = (await createRes.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(j?.error ?? "Could not save the document.");
      }
      const created = (await createRes.json()) as {
        document: EsignDoc;
        emailSent: boolean;
        emailError: string | null;
      };

      setTitle("");
      setEmail("");
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (created.emailError) {
        setNotice(created.emailError);
      } else if (created.emailSent) {
        setNotice("Document saved and the signing link was emailed.");
      } else {
        setNotice("Document saved. Copy the link to share it.");
      }
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(doc: EsignDoc) {
    const link = signLinkFor(doc.shareToken);
    try {
      await navigator.clipboard.writeText(link);
      setCopiedId(doc.id);
      setTimeout(() => setCopiedId((c) => (c === doc.id ? null : c)), 2000);
    } catch {
      window.prompt("Copy this signing link:", link);
    }
  }

  // Authed download of the signed PDF/image. We fetch the bytes and trigger a
  // download (NOT open-in-tab) because the preview iframe blocks the session
  // cookie and a blob tab renders blank.
  async function downloadSigned(doc: EsignDoc) {
    if (!doc.signedObjectPath) return;
    try {
      const path = doc.signedObjectPath.replace(/^\/objects\//, "");
      const res = await authFetch(`/api/storage/objects/${path}`);
      if (!res.ok) throw new Error("Could not download the signed file.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const ext = doc.fileType === "pdf" ? "pdf" : "png";
      a.download = `${doc.title.replace(/[^\w.-]+/g, "_")}-signed.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Download failed.");
    }
  }

  async function remove(doc: EsignDoc) {
    if (
      !window.confirm(
        `Delete "${doc.title}"? This removes it from your list permanently.`,
      )
    )
      return;
    try {
      const res = await authFetch(`/api/esign/documents/${doc.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Could not delete.");
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Delete failed.");
    }
  }

  return (
    <div className="esign-manager" style={{ maxWidth: 920, margin: "0 auto" }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ margin: "0 0 4px" }}>Document e-Sign</h1>
        <p style={{ margin: 0, color: "var(--muted, #667)" }}>
          Upload a PDF or image, share a signing link, and collect the signed
          copy. Documents are private to you.
        </p>
      </header>

      <div
        style={{
          display: "flex",
          gap: 12,
          marginBottom: 20,
          flexWrap: "wrap",
        }}
      >
        <StatChip label="Total" value={stats.total} />
        <StatChip label="Awaiting signature" value={stats.pending} />
        <StatChip label="Signed" value={stats.signed} />
      </div>

      <form
        onSubmit={handleCreate}
        style={{
          border: "1px solid var(--border, #e2e3ea)",
          borderRadius: 12,
          padding: 16,
          marginBottom: 24,
          display: "grid",
          gap: 12,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>New document</h2>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Field trip permission slip"
            maxLength={200}
            style={inputStyle}
          />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            File (PDF or image, max 10 MB)
          </span>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,image/*"
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            style={inputStyle}
          />
          {file && (
            <span style={{ fontSize: 12, color: "var(--muted, #667)" }}>
              {file.name} ({Math.round(file.size / 1024)} KB)
            </span>
          )}
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            Email link to (optional)
          </span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="parent@example.com"
            maxLength={254}
            style={inputStyle}
          />
        </label>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button type="submit" disabled={busy} style={primaryBtn}>
            {busy ? "Uploading…" : "Create & get link"}
          </button>
          {notice && (
            <span style={{ fontSize: 13, color: "var(--muted, #445)" }}>
              {notice}
            </span>
          )}
        </div>
      </form>

      {loading ? (
        <p>Loading…</p>
      ) : error ? (
        <p style={{ color: "#b42318" }}>{error}</p>
      ) : docs.length === 0 ? (
        <p style={{ color: "var(--muted, #667)" }}>
          No documents yet. Create one above to get a signing link.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {docs.map((doc) => (
            <div
              key={doc.id}
              style={{
                border: "1px solid var(--border, #e2e3ea)",
                borderRadius: 12,
                padding: 14,
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <div style={{ minWidth: 220, flex: 1 }}>
                <div style={{ fontWeight: 600 }}>
                  {doc.title}{" "}
                  <span
                    style={{
                      fontSize: 11,
                      padding: "2px 8px",
                      borderRadius: 999,
                      marginLeft: 6,
                      background:
                        doc.status === "signed" ? "#dcfce7" : "#fef3c7",
                      color: doc.status === "signed" ? "#166534" : "#92400e",
                    }}
                  >
                    {doc.status === "signed" ? "Signed" : "Awaiting signature"}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--muted, #667)",
                    marginTop: 4,
                  }}
                >
                  {doc.fileType.toUpperCase()} · created {fmtDate(doc.createdAt)}
                  {doc.recipientEmail ? ` · ${doc.recipientEmail}` : ""}
                  {doc.status === "signed" && doc.signerName
                    ? ` · signed by ${doc.signerName} ${fmtDate(doc.signedAt)}`
                    : ""}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {doc.status === "pending" && (
                  <button onClick={() => copyLink(doc)} style={secondaryBtn}>
                    {copiedId === doc.id ? "Copied!" : "Copy link"}
                  </button>
                )}
                {doc.status === "signed" && (
                  <button onClick={() => downloadSigned(doc)} style={secondaryBtn}>
                    Download signed
                  </button>
                )}
                <button onClick={() => remove(doc)} style={dangerBtn}>
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

function StatChip({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        border: "1px solid var(--border, #e2e3ea)",
        borderRadius: 10,
        padding: "10px 16px",
        minWidth: 120,
      }}
    >
      <div style={{ fontSize: 24, fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: 12, color: "var(--muted, #667)" }}>{label}</div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--border, #cfd2dc)",
  fontSize: 14,
};

const primaryBtn: React.CSSProperties = {
  padding: "8px 16px",
  borderRadius: 8,
  border: "none",
  background: "var(--accent, #4f46e5)",
  color: "#fff",
  fontWeight: 600,
  cursor: "pointer",
};

const secondaryBtn: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 8,
  border: "1px solid var(--border, #cfd2dc)",
  background: "#fff",
  cursor: "pointer",
  fontSize: 13,
};

const dangerBtn: React.CSSProperties = {
  ...secondaryBtn,
  color: "#b42318",
  borderColor: "#f1c7c2",
};
