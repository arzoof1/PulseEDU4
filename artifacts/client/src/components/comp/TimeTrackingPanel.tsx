import { useEffect, useState } from "react";
import { authFetch } from "../../lib/authToken";

type Settings = {
  workweekStart?: "sunday" | "monday" | null;
  compTimeRequireAuthForm?: boolean | null;
  compTimeAuthFormObjectKey?: string | null;
};

export default function TimeTrackingPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = async () => {
    const r = await authFetch("/api/school-settings");
    if (r.ok) setSettings((await r.json()) as Settings);
  };
  useEffect(() => {
    void load();
  }, []);

  const patch = async (body: Partial<Settings>) => {
    setSaving(true);
    setMsg(null);
    try {
      const r = await authFetch("/api/school-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await r.text());
      setSettings((await r.json()) as Settings);
      setMsg("Saved.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleUpload = async (file: File) => {
    setUploading(true);
    setMsg(null);
    try {
      const presign = await authFetch("/api/storage/uploads/request-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: file.name,
          contentType: file.type || "application/pdf",
        }),
      });
      if (!presign.ok) throw new Error(await presign.text());
      const { uploadURL, objectPath } = (await presign.json()) as {
        uploadURL: string;
        objectPath: string;
      };
      const put = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/pdf" },
        body: file,
      });
      if (!put.ok) throw new Error("Upload failed");
      await patch({ compTimeAuthFormObjectKey: objectPath });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  if (!settings) return <div className="card">Loading…</div>;

  const ww = settings.workweekStart ?? "sunday";
  const requireForm = settings.compTimeRequireAuthForm ?? true;

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Time Tracking</h2>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        Settings here govern <strong>both</strong> Alternate Schedule Time
        (AST) and Comp Time accrual for non-exempt staff.
      </p>

      <section style={{ marginTop: 16 }}>
        <h3 style={{ marginBottom: 4 }}>Workweek anchor</h3>
        <p style={{ color: "var(--text-subtle)", marginTop: 0, fontSize: 13 }}>
          Defines the 7-day window FLSA uses to count overtime hours. Pick the
          first day of your district's payroll workweek.
        </p>
        <label style={{ display: "block", marginTop: 6 }}>
          <input
            type="radio"
            name="ww"
            value="sunday"
            checked={ww === "sunday"}
            disabled={saving}
            onChange={() => void patch({ workweekStart: "sunday" })}
          />{" "}
          Sunday – Saturday
        </label>
        <label style={{ display: "block", marginTop: 4 }}>
          <input
            type="radio"
            name="ww"
            value="monday"
            checked={ww === "monday"}
            disabled={saving}
            onChange={() => void patch({ workweekStart: "monday" })}
          />{" "}
          Monday – Sunday
        </label>
      </section>

      <section style={{ marginTop: 24 }}>
        <h3 style={{ marginBottom: 4 }}>
          Comp Time authorization form
        </h3>
        <p style={{ color: "var(--text-subtle)", marginTop: 0, fontSize: 13 }}>
          Upload the blank "Authorization to Accrue Comp Time" PDF. Non-exempt
          staff download it from their Comp Time page, get supervisor
          signature, and re-upload it with every earn submission.
        </p>
        <label style={{ display: "block", marginTop: 6 }}>
          <input
            type="checkbox"
            checked={requireForm}
            disabled={saving}
            onChange={(e) =>
              void patch({ compTimeRequireAuthForm: e.target.checked })
            }
          />{" "}
          Require the signed authorization form on every Comp Time earn
          submission
        </label>
        <div style={{ marginTop: 12 }}>
          {settings.compTimeAuthFormObjectKey ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <a
                href={`/api${settings.compTimeAuthFormObjectKey}`}
                target="_blank"
                rel="noreferrer"
              >
                View current template
              </a>
              <button
                type="button"
                disabled={saving}
                onClick={() =>
                  void patch({ compTimeAuthFormObjectKey: null })
                }
              >
                Remove
              </button>
            </div>
          ) : (
            <em style={{ color: "var(--text-subtle)" }}>
              No template uploaded yet.
            </em>
          )}
        </div>
        <div style={{ marginTop: 8 }}>
          <input
            type="file"
            accept="application/pdf,image/*"
            disabled={uploading || saving}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleUpload(f);
              e.target.value = "";
            }}
          />
          {uploading && (
            <span style={{ marginLeft: 8 }}>Uploading…</span>
          )}
        </div>
      </section>

      <section style={{ marginTop: 24 }}>
        <h3 style={{ marginBottom: 4 }}>Supervisor approvers</h3>
        <p style={{ color: "var(--text-subtle)", marginTop: 0, fontSize: 13 }}>
          Principals and Assistant Principals are automatic Comp Time
          approvers. To add additional approvers (e.g., Director of
          Operations), open Staff &amp; Roles and toggle the staff member's
          "Approve Comp Time" capability.
        </p>
      </section>

      {msg && (
        <p
          style={{
            marginTop: 12,
            color: msg === "Saved." ? "#15803d" : "#b91c1c",
          }}
        >
          {msg}
        </p>
      )}
    </div>
  );
}
