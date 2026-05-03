// Pullout Note Templates admin — school-scoped catalog of canned
// parent messages the verifier picks from in the Verify modal.
// Mounted at the bottom of the Behavior Dashboard. Same edit gate as
// pullout reasons (Behavior Specialist / Admin / MTSS Coord / Dean /
// SuperUser). Read access for any signed-in staff so the section
// itself stays visible — the buttons just no-op with a 403 if a
// teacher tries to write.
//
// Templates support these placeholders, substituted client-side
// in the Verify modal before /verify is called:
//   {firstName} {lastName} {teacherName} {reason} {period} {schoolName}

import { useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";

interface TemplateRow {
  id: number;
  schoolId: number;
  title: string;
  body: string;
  sortOrder: number;
  active: string;
  createdAt: string;
  updatedAt: string | null;
}

const PLACEHOLDER_HINT =
  "Placeholders: {firstName} {lastName} {teacherName} {reason} {period} {schoolName}";

export default function PulloutNoteTemplatesAdmin() {
  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState<TemplateRow | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [bodyDraft, setBodyDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function reload() {
    setLoading(true);
    setErr("");
    try {
      const r = await authFetch("/api/pullout-note-templates");
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      const data = (await r.json()) as TemplateRow[];
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load templates");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  function startNew() {
    setEditing({
      id: 0,
      schoolId: 0,
      title: "",
      body: "",
      sortOrder: rows.length,
      active: "true",
      createdAt: "",
      updatedAt: null,
    });
    setTitleDraft("");
    setBodyDraft("");
  }

  function startEdit(row: TemplateRow) {
    setEditing(row);
    setTitleDraft(row.title);
    setBodyDraft(row.body);
  }

  async function save() {
    if (!editing) return;
    const title = titleDraft.trim();
    const body = bodyDraft.trim();
    if (!title || !body) {
      setErr("Title and body are both required.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const isNew = editing.id === 0;
      const r = await authFetch(
        isNew
          ? "/api/pullout-note-templates"
          : `/api/pullout-note-templates/${editing.id}`,
        {
          method: isNew ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, body }),
        },
      );
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${r.status}`);
      }
      setEditing(null);
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: TemplateRow) {
    if (
      !confirm(
        `Delete template "${row.title}"? This cannot be undone.`,
      )
    )
      return;
    setBusy(true);
    setErr("");
    try {
      const r = await authFetch(`/api/pullout-note-templates/${row.id}`, {
        method: "DELETE",
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${r.status}`);
      }
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: "1rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 4,
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: "1.15rem" }}>
            Pullout note templates
          </h2>
          <p
            style={{
              color: "var(--text-subtle, #64748b)",
              margin: "0.25rem 0 0",
              fontSize: 13,
            }}
          >
            Canned parent messages the verifier can drop into the Verify
            modal. {PLACEHOLDER_HINT}
          </p>
        </div>
        {!editing && (
          <button
            type="button"
            onClick={startNew}
            style={{
              background: "#2563eb",
              color: "white",
              border: "none",
              borderRadius: 6,
              padding: "0.45rem 0.9rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            + New template
          </button>
        )}
      </div>

      {err && (
        <div
          style={{
            background: "#fef2f2",
            color: "#991b1b",
            border: "1px solid #fecaca",
            borderRadius: 6,
            padding: "0.5rem 0.75rem",
            margin: "0.5rem 0",
            fontSize: 13,
          }}
        >
          {err}
        </div>
      )}

      {editing && (
        <div
          style={{
            border: "1px solid #cbd5e1",
            borderRadius: 8,
            padding: 12,
            marginTop: 10,
            background: "#f8fafc",
          }}
        >
          <div style={{ display: "grid", gap: 8 }}>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 12, color: "#475569" }}>Title</span>
              <input
                type="text"
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                maxLength={200}
                placeholder="e.g. Standard pull-out (period)"
                style={{
                  padding: "0.4rem 0.6rem",
                  border: "1px solid #cbd5e1",
                  borderRadius: 6,
                }}
              />
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 12, color: "#475569" }}>
                Body (use placeholders)
              </span>
              <textarea
                rows={5}
                value={bodyDraft}
                onChange={(e) => setBodyDraft(e.target.value)}
                maxLength={4000}
                placeholder="Your student, {firstName} {lastName}, has received a classroom pullout from {teacherName} for {reason}. They will return to their regular schedule at the end of this period."
                style={{
                  padding: "0.4rem 0.6rem",
                  border: "1px solid #cbd5e1",
                  borderRadius: 6,
                  font: "inherit",
                }}
              />
            </label>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              marginTop: 10,
            }}
          >
            <button
              type="button"
              onClick={() => setEditing(null)}
              style={{
                background: "white",
                color: "#374151",
                border: "1px solid #d1d5db",
                borderRadius: 6,
                padding: "0.4rem 0.9rem",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || !titleDraft.trim() || !bodyDraft.trim()}
              style={{
                background: "#16a34a",
                color: "white",
                border: "none",
                borderRadius: 6,
                padding: "0.4rem 0.9rem",
                fontWeight: 600,
                cursor: busy ? "not-allowed" : "pointer",
                opacity: busy ? 0.6 : 1,
              }}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        {loading ? (
          <div style={{ color: "#64748b" }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div
            style={{
              padding: "0.75rem",
              border: "1px dashed #cbd5e1",
              borderRadius: 8,
              color: "#64748b",
              fontSize: 13,
            }}
          >
            No templates yet. Click "+ New template" to add the first one.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {rows.map((row) => (
              <div
                key={row.id}
                style={{
                  border: "1px solid #e2e8f0",
                  borderRadius: 8,
                  padding: "0.5rem 0.75rem",
                  background: "white",
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
                  <strong style={{ fontSize: 14 }}>{row.title}</strong>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      type="button"
                      onClick={() => startEdit(row)}
                      style={{
                        background: "white",
                        color: "#1f2937",
                        border: "1px solid #d1d5db",
                        borderRadius: 4,
                        padding: "2px 8px",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(row)}
                      style={{
                        background: "white",
                        color: "#b91c1c",
                        border: "1px solid #fecaca",
                        borderRadius: 4,
                        padding: "2px 8px",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: "#475569",
                    marginTop: 4,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {row.body}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
