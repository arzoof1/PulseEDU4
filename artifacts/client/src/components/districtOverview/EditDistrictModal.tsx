// Edit-a-District modal. SuperUser-only. Calls
// PATCH /api/tenancy/districts/:id with only the fields the user
// changed. Deactivate / reactivate is a separate inline button on the
// parent card, not a checkbox here.
//
// District-level School Tours branding (logo + tagline + placement
// toggles) is set here too: the district sets it once and every school in
// the district inherits it — schools cannot change it.

import { useEffect, useRef, useState } from "react";
import { authFetch } from "../../lib/authToken";

type Props = {
  district: {
    id: number;
    name: string;
    slug: string;
    stateDistrictCode: string | null;
    timezone: string;
    tagline: string | null;
    brandHasLogo: boolean;
    brandHeroTop: boolean;
    brandDocuments: boolean;
    brandFooter: boolean;
    brandWatermark: boolean;
  };
  onClose: () => void;
  onSaved: () => void;
};

// Small curated list — matches the dropdown in OnboardDistrictModal.
const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/Phoenix",
  "Pacific/Honolulu",
];

const MAX_LOGO_BYTES = 5 * 1024 * 1024;

// Upload a single file via the presigned-URL flow and return its
// /objects/... path, or null on failure.
async function uploadLogoFile(file: File): Promise<string | null> {
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
    return objectPath;
  } catch {
    return null;
  }
}

export default function EditDistrictModal({
  district,
  onClose,
  onSaved,
}: Props) {
  const [name, setName] = useState(district.name);
  const [slug, setSlug] = useState(district.slug);
  const [stateDistrictCode, setStateDistrictCode] = useState(
    district.stateDistrictCode ?? "",
  );
  const [timezone, setTimezone] = useState(district.timezone);
  const [tagline, setTagline] = useState(district.tagline ?? "");
  const [heroTop, setHeroTop] = useState(district.brandHeroTop);
  const [documents, setDocuments] = useState(district.brandDocuments);
  const [footer, setFooter] = useState(district.brandFooter);
  const [watermark, setWatermark] = useState(district.brandWatermark);

  // Logo state: a freshly-chosen File wins; otherwise we preview the saved
  // logo (if any) unless the admin removed it.
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [removeExisting, setRemoveExisting] = useState(false);
  const [savedLogoUrl, setSavedLogoUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the saved logo (private object) as a blob for preview.
  useEffect(() => {
    if (!district.brandHasLogo) return;
    let revoked = false;
    let objUrl = "";
    (async () => {
      try {
        const res = await authFetch("/api/tours/admin/district-logo");
        if (!res.ok) return;
        const blob = await res.blob();
        if (revoked) return;
        objUrl = URL.createObjectURL(blob);
        setSavedLogoUrl(objUrl);
      } catch {
        /* preview is best-effort */
      }
    })();
    return () => {
      revoked = true;
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
  }, [district.brandHasLogo]);

  // Preview URL for a freshly-chosen file.
  const [filePreview, setFilePreview] = useState<string | null>(null);
  useEffect(() => {
    if (!logoFile) {
      setFilePreview(null);
      return;
    }
    const u = URL.createObjectURL(logoFile);
    setFilePreview(u);
    return () => URL.revokeObjectURL(u);
  }, [logoFile]);

  const previewSrc = logoFile
    ? filePreview
    : removeExisting
      ? null
      : savedLogoUrl;
  const showLogo = !!previewSrc;

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    // SVG is intentionally excluded — the public logo stream allowlist
    // (PUBLIC_IMAGE_TYPES) rejects image/svg+xml for XSS safety, so an SVG
    // would upload but never render on the brag page.
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) {
      setError("Logo must be a PNG, JPG, or WebP image.");
      return;
    }
    if (f.size > MAX_LOGO_BYTES) {
      setError("Logo must be 5MB or smaller.");
      return;
    }
    setError(null);
    setRemoveExisting(false);
    setLogoFile(f);
  }

  function removeLogo() {
    setLogoFile(null);
    setRemoveExisting(true);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const patch: Record<string, unknown> = {};
      if (name.trim() !== district.name) patch.name = name.trim();
      if (slug.trim() !== district.slug) patch.slug = slug.trim();
      if (stateDistrictCode !== (district.stateDistrictCode ?? "")) {
        patch.stateDistrictCode = stateDistrictCode.trim() || null;
      }
      if (timezone !== district.timezone) patch.timezone = timezone;
      if (tagline.trim() !== (district.tagline ?? "")) {
        patch.tagline = tagline.trim() || null;
      }
      if (heroTop !== district.brandHeroTop) patch.brandHeroTop = heroTop;
      if (documents !== district.brandDocuments) patch.brandDocuments = documents;
      if (footer !== district.brandFooter) patch.brandFooter = footer;
      if (watermark !== district.brandWatermark) patch.brandWatermark = watermark;

      // Logo: upload a new file, or clear the existing one.
      if (logoFile) {
        const path = await uploadLogoFile(logoFile);
        if (!path) {
          throw new Error("Logo upload failed. Please try again.");
        }
        patch.logoObjectPath = path;
      } else if (removeExisting && district.brandHasLogo) {
        patch.logoObjectPath = "";
      }

      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }
      const res = await authFetch(`/api/tenancy/districts/${district.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.5)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "3rem 1rem",
        zIndex: 1000,
        overflowY: "auto",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface, #fff)",
          borderRadius: 10,
          width: "100%",
          maxWidth: 480,
          padding: "1.25rem 1.5rem",
          boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "0.75rem",
          }}
        >
          <h2 style={{ margin: 0 }}>Edit district</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              fontSize: "1.5rem",
              cursor: "pointer",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
        <form onSubmit={submit}>
          <Field label="District name" required>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={inputStyle}
            />
          </Field>
          <Field label="Slug" required hint="lowercase letters, digits, hyphens">
            <input
              type="text"
              required
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              style={inputStyle}
            />
          </Field>
          <Field label="State district code" hint="(optional)">
            <input
              type="text"
              value={stateDistrictCode}
              onChange={(e) => setStateDistrictCode(e.target.value)}
              style={inputStyle}
            />
          </Field>
          <Field label="Timezone">
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              style={inputStyle}
            >
              {!TIMEZONES.includes(timezone) && (
                <option value={timezone}>{timezone}</option>
              )}
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </Field>

          {/* --- School Tours branding ----------------------------------- */}
          <div
            style={{
              marginTop: "0.5rem",
              marginBottom: "0.75rem",
              paddingTop: "0.75rem",
              borderTop: "1px solid var(--border, #e2e8f0)",
            }}
          >
            <div
              style={{ fontWeight: 700, fontSize: "0.9rem", marginBottom: 2 }}
            >
              School Tours branding
            </div>
            <div
              style={{
                fontSize: "0.78rem",
                color: "var(--text-subtle)",
                marginBottom: "0.75rem",
              }}
            >
              Set once for the whole district. Every school's tour page and
              printed documents inherit this — schools can't change it.
            </div>

            <Field label="District logo" hint="PNG/JPG/WebP, ≤5MB">
              <div
                style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}
              >
                <div
                  style={{
                    width: 72,
                    height: 72,
                    borderRadius: 8,
                    border: "1px dashed var(--border, #cbd5e1)",
                    background: "#f8fafc",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    overflow: "hidden",
                    flexShrink: 0,
                  }}
                >
                  {showLogo && previewSrc ? (
                    <img
                      src={previewSrc}
                      alt="District logo preview"
                      style={{
                        maxWidth: "100%",
                        maxHeight: "100%",
                        objectFit: "contain",
                      }}
                    />
                  ) : (
                    <span
                      style={{ fontSize: "0.7rem", color: "var(--text-subtle)" }}
                    >
                      No logo
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={onPickFile}
                    style={{ fontSize: "0.8rem" }}
                  />
                  {showLogo && (
                    <button
                      type="button"
                      onClick={removeLogo}
                      style={{
                        alignSelf: "flex-start",
                        padding: "0.25rem 0.6rem",
                        border: "1px solid var(--border, #e2e8f0)",
                        borderRadius: 6,
                        background: "var(--surface, #fff)",
                        fontSize: "0.78rem",
                        cursor: "pointer",
                      }}
                    >
                      Remove logo
                    </button>
                  )}
                </div>
              </div>
            </Field>

            <Field label="Tagline" hint="(optional, ≤200 chars)">
              <input
                type="text"
                value={tagline}
                maxLength={200}
                placeholder="e.g. Hernando County Schools — Every child, every day"
                onChange={(e) => setTagline(e.target.value)}
                style={inputStyle}
              />
            </Field>

            <div style={{ marginTop: "0.25rem" }}>
              <div
                style={{
                  fontSize: "0.8rem",
                  fontWeight: 600,
                  marginBottom: 6,
                }}
              >
                Where it shows
              </div>
              <Toggle
                label="Hero strip (top of brag page)"
                checked={heroTop}
                onChange={setHeroTop}
              />
              <Toggle
                label="Printed documents (brag sheet + post-tour)"
                checked={documents}
                onChange={setDocuments}
              />
              <Toggle
                label="Footer band"
                checked={footer}
                onChange={setFooter}
              />
              <Toggle
                label="Hero corner watermark"
                checked={watermark}
                onChange={setWatermark}
              />
            </div>
          </div>

          {error && (
            <div
              style={{
                marginTop: "0.5rem",
                padding: "0.5rem 0.75rem",
                background: "#fee2e2",
                border: "1px solid #fca5a5",
                borderRadius: 6,
                color: "#991b1b",
                fontSize: "0.85rem",
              }}
            >
              {error}
            </div>
          )}

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: "0.5rem",
              marginTop: "1rem",
            }}
          >
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              style={{
                padding: "0.55rem 1rem",
                border: "1px solid var(--border, #e2e8f0)",
                borderRadius: 6,
                background: "var(--surface, #fff)",
                cursor: submitting ? "not-allowed" : "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              style={{
                padding: "0.55rem 1rem",
                border: "none",
                borderRadius: 6,
                background: "var(--primary, #2563eb)",
                color: "#fff",
                fontWeight: 600,
                cursor: submitting ? "not-allowed" : "pointer",
                opacity: submitting ? 0.6 : 1,
              }}
            >
              {submitting ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        marginBottom: "0.4rem",
        fontSize: "0.85rem",
        cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block", marginBottom: "0.75rem" }}>
      <span
        style={{
          display: "block",
          fontSize: "0.8rem",
          fontWeight: 600,
          marginBottom: 4,
        }}
      >
        {label}
        {required && <span style={{ color: "#b91c1c" }}> *</span>}
        {hint && (
          <span
            style={{
              fontWeight: 400,
              color: "var(--text-subtle)",
              marginLeft: 6,
            }}
          >
            {hint}
          </span>
        )}
      </span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.6rem",
  border: "1px solid var(--border, #e2e8f0)",
  borderRadius: 6,
  font: "inherit",
  boxSizing: "border-box",
};
