// Per-school branding admin tile.
//
// Lets an admin set:
//   - 1-4 gradient colors + angle (header tint applied site-wide).
//   - A logo. Uploaded files are pre-processed in the browser:
//       * optional chroma-key against near-white to make the background
//         transparent (skipped if "logo is already transparent" is on)
//       * trimmed of fully-transparent edges so the asset hugs its art
//       * uploaded as a PNG to object storage
//   - Primary + Accent colors, with one-click swatches sampled from the
//     dominant non-white/non-black colors in the cleaned logo.
//
// The right side renders a live preview of the brand banner, a mock
// printout header, the Kiosk masthead badge, and the parent HeartBEAT
// card so the admin can see exactly where the colors land before saving.
import { useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "../lib/authToken";
import {
  buildHeaderBackground,
  emitBrandingUpdated,
  resolveLogoUrl,
  DEFAULT_BRANDING_PRIMARY,
  DEFAULT_BRANDING_ACCENT,
} from "../lib/branding";

const DEFAULT_GRADIENT = ["#0f766e", "#0e7490", "#7c3aed"];
const DEFAULT_ANGLE = 135;

type LoadedBranding = {
  schoolId: number;
  gradientColors: string[];
  gradientAngle: number;
  primaryColor: string | null;
  accentColor: string | null;
  logoObjectPath: string | null;
  displayNameOverride: string | null;
};

function isHex(s: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(s);
}

// --- Image processing helpers ---------------------------------------------

// Chroma-key near-white pixels to transparent. `tolerance` is how far an
// RGB value can sit from pure white (per-channel) and still be erased.
function chromaKeyWhite(
  image: HTMLImageElement,
  tolerance: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.drawImage(image, 0, 0);
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] ?? 0;
    const g = d[i + 1] ?? 0;
    const b = d[i + 2] ?? 0;
    if (
      255 - r <= tolerance &&
      255 - g <= tolerance &&
      255 - b <= tolerance
    ) {
      d[i + 3] = 0;
    } else {
      // Soft edge: pixels that are "kinda white" get reduced alpha so the
      // edges don't look stamped. Above tolerance*1.6 stays opaque.
      const minDist = Math.min(255 - r, 255 - g, 255 - b);
      if (minDist <= tolerance * 1.6) {
        const fade = (minDist - tolerance) / (tolerance * 0.6);
        d[i + 3] = Math.round(255 * Math.max(0, Math.min(1, fade)));
      }
    }
  }
  ctx.putImageData(id, 0, 0);
  return canvas;
}

// Drop fully-transparent rows/columns from the edges so the logo crops
// tightly around its visible art. Returns the original canvas when nothing
// to trim (e.g. logo fills the frame edge-to-edge).
function trimTransparent(src: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = src.getContext("2d");
  if (!ctx) return src;
  const { width: w, height: h } = src;
  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data;
  let top = 0;
  let bottom = h - 1;
  let left = 0;
  let right = w - 1;
  const isOpaque = (x: number, y: number) =>
    (d[(y * w + x) * 4 + 3] ?? 0) > 8;
  outerTop: for (; top < h; top++) {
    for (let x = 0; x < w; x++) if (isOpaque(x, top)) break outerTop;
  }
  outerBottom: for (; bottom > top; bottom--) {
    for (let x = 0; x < w; x++) if (isOpaque(x, bottom)) break outerBottom;
  }
  outerLeft: for (; left < w; left++) {
    for (let y = top; y <= bottom; y++)
      if (isOpaque(left, y)) break outerLeft;
  }
  outerRight: for (; right > left; right--) {
    for (let y = top; y <= bottom; y++)
      if (isOpaque(right, y)) break outerRight;
  }
  const tw = right - left + 1;
  const th = bottom - top + 1;
  if (tw <= 0 || th <= 0 || (tw === w && th === h)) return src;
  const out = document.createElement("canvas");
  out.width = tw;
  out.height = th;
  out.getContext("2d")?.drawImage(src, left, top, tw, th, 0, 0, tw, th);
  return out;
}

// Sample dominant colors from a canvas. Bins to 5-bit-per-channel buckets
// to merge near-duplicates; excludes near-black, near-white, and very
// desaturated pixels so the swatches feel like brand colors, not paper or
// shadow. Returns up to `max` hex strings sorted by frequency.
function sampleDominantColors(
  src: HTMLCanvasElement,
  max: number,
): string[] {
  const sample = document.createElement("canvas");
  const targetW = Math.min(120, src.width);
  const scale = targetW / src.width;
  sample.width = targetW;
  sample.height = Math.max(1, Math.round(src.height * scale));
  const sctx = sample.getContext("2d");
  if (!sctx) return [];
  sctx.drawImage(src, 0, 0, sample.width, sample.height);
  const id = sctx.getImageData(0, 0, sample.width, sample.height);
  const d = id.data;
  const bins = new Map<number, { r: number; g: number; b: number; n: number }>();
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] ?? 0;
    const g = d[i + 1] ?? 0;
    const b = d[i + 2] ?? 0;
    const a = d[i + 3] ?? 0;
    if (a < 128) continue;
    const max3 = Math.max(r, g, b);
    const min3 = Math.min(r, g, b);
    if (max3 < 24) continue; // near-black
    if (min3 > 232) continue; // near-white
    if (max3 - min3 < 18 && max3 > 80 && max3 < 200) continue; // gray-ish
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const slot = bins.get(key);
    if (slot) {
      slot.r += r;
      slot.g += g;
      slot.b += b;
      slot.n++;
    } else {
      bins.set(key, { r, g, b, n: 1 });
    }
  }
  const sorted = [...bins.values()].sort((a, b) => b.n - a.n);
  const out: string[] = [];
  for (const slot of sorted) {
    const r = Math.round(slot.r / slot.n);
    const g = Math.round(slot.g / slot.n);
    const b = Math.round(slot.b / slot.n);
    const hex =
      "#" +
      [r, g, b]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("");
    // Reject if near-duplicate of an already-picked swatch.
    if (out.some((existing) => hexDistance(existing, hex) < 32)) continue;
    out.push(hex);
    if (out.length >= max) break;
  }
  return out;
}

function hexDistance(a: string, b: string): number {
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  return Math.sqrt(
    (pa.r - pb.r) ** 2 + (pa.g - pb.g) ** 2 + (pa.b - pb.b) ** 2,
  );
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1]!, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

// Convert a canvas to a Blob promise.
function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error("PNG export failed"));
    }, "image/png");
  });
}

// --- Component ------------------------------------------------------------

export default function SchoolBrandingPanel() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [gradientColors, setGradientColors] = useState<string[]>(DEFAULT_GRADIENT);
  const [gradientAngle, setGradientAngle] = useState(DEFAULT_ANGLE);
  const [primaryColor, setPrimaryColor] = useState<string>(DEFAULT_BRANDING_PRIMARY);
  const [accentColor, setAccentColor] = useState<string>(DEFAULT_BRANDING_ACCENT);
  const [logoObjectPath, setLogoObjectPath] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");

  // Local-only preview state for the cleaned logo (data URL) so admin can
  // see the chroma-keyed result before/after Save.
  const [localLogoUrl, setLocalLogoUrl] = useState<string | null>(null);
  const [logoPreviewBg, setLogoPreviewBg] = useState<"light" | "dark" | "brand">("light");
  const [keyOutWhite, setKeyOutWhite] = useState(true);
  const [whiteTolerance, setWhiteTolerance] = useState(18);
  const [suggestedSwatches, setSuggestedSwatches] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastImageRef = useRef<HTMLImageElement | null>(null);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch("/api/school-branding");
        if (!res.ok) throw new Error("Failed to load branding");
        const data = (await res.json()) as LoadedBranding;
        if (cancelled) return;
        if (data.gradientColors?.length) setGradientColors(data.gradientColors);
        if (typeof data.gradientAngle === "number") setGradientAngle(data.gradientAngle);
        if (data.primaryColor) setPrimaryColor(data.primaryColor);
        if (data.accentColor) setAccentColor(data.accentColor);
        if (data.logoObjectPath) setLogoObjectPath(data.logoObjectPath);
        if (data.displayNameOverride) setDisplayName(data.displayNameOverride);
      } catch (e) {
        if (!cancelled)
          setErr(e instanceof Error ? e.message : "Failed to load branding");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-process the logo whenever the chroma-key toggle or tolerance changes,
  // so the admin sees the impact in real time without re-uploading.
  useEffect(() => {
    const img = lastImageRef.current;
    if (!img) return;
    void processImage(img);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyOutWhite, whiteTolerance]);

  const headerBg = useMemo(
    () => buildHeaderBackground(gradientColors, gradientAngle),
    [gradientColors, gradientAngle],
  );

  // The "current" logo URL preferred for previews: the freshly-cleaned
  // local one if present, otherwise whatever's saved on the server.
  const previewLogoUrl = useMemo(() => {
    if (localLogoUrl) return localLogoUrl;
    return resolveLogoUrl(logoObjectPath);
  }, [localLogoUrl, logoObjectPath]);

  // Updates one of the 1..4 gradient stops by index.
  function setGradientAt(idx: number, hex: string) {
    setGradientColors((prev) => {
      const next = [...prev];
      next[idx] = hex;
      return next;
    });
  }

  function addGradientStop() {
    setGradientColors((prev) =>
      prev.length >= 4 ? prev : [...prev, prev[prev.length - 1] ?? "#888888"],
    );
  }

  function removeGradientStop(idx: number) {
    setGradientColors((prev) =>
      prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx),
    );
  }

  // Reads a File into an HTMLImageElement, cleans it, and updates state.
  async function handleFileSelected(file: File) {
    setErr(null);
    setInfo(null);
    if (!file.type.startsWith("image/")) {
      setErr("Please choose an image file (PNG, JPG, or WebP).");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setErr("Logo must be under 5 MB.");
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      lastImageRef.current = img;
      void processImage(img);
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setErr("Could not load that image.");
    };
    img.src = url;
  }

  // Run the chroma-key + trim pipeline on the held image and refresh
  // localLogoUrl + suggestedSwatches.
  async function processImage(img: HTMLImageElement) {
    let canvas: HTMLCanvasElement;
    if (keyOutWhite) {
      canvas = chromaKeyWhite(img, whiteTolerance);
      canvas = trimTransparent(canvas);
    } else {
      canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d")?.drawImage(img, 0, 0);
    }
    const dataUrl = canvas.toDataURL("image/png");
    setLocalLogoUrl(dataUrl);
    setSuggestedSwatches(sampleDominantColors(canvas, 8));
  }

  // Upload the cleaned logo to object storage, then store its path on
  // the school. We don't PUT the school row yet — the admin still has to
  // click Save — but we do push the logo to storage now so we have a path
  // by save time.
  async function uploadCleanedLogo(): Promise<string | null> {
    if (!localLogoUrl) return logoObjectPath;
    setUploading(true);
    try {
      // Re-render the data URL into a canvas to grab a Blob.
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error("Could not re-read cleaned logo"));
        im.src = localLogoUrl;
      });
      const cv = document.createElement("canvas");
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      cv.getContext("2d")?.drawImage(img, 0, 0);
      const blob = await canvasToPng(cv);
      const reqRes = await authFetch("/api/storage/uploads/request-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "school-logo.png",
          size: blob.size,
          contentType: "image/png",
        }),
      });
      if (!reqRes.ok) throw new Error("Could not start logo upload");
      const { uploadURL, objectPath } = (await reqRes.json()) as {
        uploadURL: string;
        objectPath: string;
      };
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body: blob,
      });
      if (!putRes.ok) throw new Error("Logo upload failed");
      return objectPath;
    } finally {
      setUploading(false);
    }
  }

  async function handleSave() {
    // Validate gradient
    if (gradientColors.length === 0 || gradientColors.length > 4) {
      setErr("Pick between 1 and 4 gradient colors.");
      return;
    }
    for (const c of gradientColors) {
      if (!isHex(c)) {
        setErr(`"${c}" is not a valid #RRGGBB hex color.`);
        return;
      }
    }
    if (!isHex(primaryColor)) {
      setErr("Primary color must be #RRGGBB.");
      return;
    }
    if (!isHex(accentColor)) {
      setErr("Accent color must be #RRGGBB.");
      return;
    }
    setSaving(true);
    setErr(null);
    setInfo(null);
    try {
      // Upload the cleaned logo first if there's a fresh one waiting.
      let nextLogoPath = logoObjectPath;
      if (localLogoUrl) {
        nextLogoPath = await uploadCleanedLogo();
      }
      const body = {
        gradientColors,
        gradientAngle,
        primaryColor,
        accentColor,
        logoObjectPath: nextLogoPath,
        displayNameOverride: displayName.trim() || null,
      };
      const res = await authFetch("/api/school-branding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let msg = "Save failed";
        try {
          const j = (await res.json()) as { error?: string };
          if (j?.error) msg = j.error;
        } catch {
          // ignore
        }
        throw new Error(msg);
      }
      const saved = (await res.json()) as LoadedBranding;
      setLogoObjectPath(saved.logoObjectPath);
      setLocalLogoUrl(null);
      setInfo("Branding saved.");
      // Tell the rest of the app to refetch.
      emitBrandingUpdated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function handleRestoreDefaults() {
    setGradientColors(DEFAULT_GRADIENT);
    setGradientAngle(DEFAULT_ANGLE);
    setPrimaryColor(DEFAULT_BRANDING_PRIMARY);
    setAccentColor(DEFAULT_BRANDING_ACCENT);
    setDisplayName("");
    setInfo("Defaults restored — click Save to apply.");
  }

  function handleClearLogo() {
    setLocalLogoUrl(null);
    setLogoObjectPath(null);
    setSuggestedSwatches([]);
    lastImageRef.current = null;
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  if (loading) {
    return (
      <div className="card" style={{ padding: "1rem" }}>
        Loading branding…
      </div>
    );
  }

  // --- Render -------------------------------------------------------------

  const previewLogoBgStyle: React.CSSProperties =
    logoPreviewBg === "light"
      ? { background: "#ffffff" }
      : logoPreviewBg === "dark"
        ? { background: "#0f172a" }
        : { background: headerBg };

  return (
    <div className="card" style={{ padding: "1rem" }}>
      <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap" }}>
        {/* LEFT: editor */}
        <div style={{ flex: "1 1 380px", minWidth: 320 }}>
          <h2 style={{ marginTop: 0 }}>School Branding</h2>
          <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
            Set the header gradient and logo. These show on print headers,
            the parent HeartBEAT snapshot, and the Kiosk masthead.
          </p>

          {/* Display name */}
          <label
            style={{
              display: "block",
              marginTop: "1rem",
              fontWeight: 600,
            }}
          >
            Display name override (optional)
          </label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. Parrott Middle School"
            style={inputStyle}
          />

          {/* Gradient editor */}
          <h3 style={sectionStyle}>Header gradient ({gradientColors.length}/4)</h3>
          {gradientColors.map((c, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                gap: 6,
                alignItems: "center",
                marginBottom: 6,
              }}
            >
              <input
                type="color"
                value={isHex(c) ? c : "#888888"}
                onChange={(e) => setGradientAt(i, e.target.value)}
                style={{ width: 36, height: 32, padding: 0, border: "none" }}
              />
              <input
                type="text"
                value={c}
                onChange={(e) => setGradientAt(i, e.target.value.trim())}
                style={{ ...inputStyle, width: 110, marginTop: 0 }}
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => removeGradientStop(i)}
                disabled={gradientColors.length <= 1}
                style={smallBtn(gradientColors.length <= 1)}
                title={
                  gradientColors.length <= 1
                    ? "Need at least one color"
                    : "Remove this color"
                }
              >
                −
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addGradientStop}
            disabled={gradientColors.length >= 4}
            style={smallBtn(gradientColors.length >= 4)}
          >
            + Add color
          </button>

          <label
            style={{
              display: "block",
              marginTop: "0.75rem",
              fontWeight: 600,
            }}
          >
            Angle: {gradientAngle}°
          </label>
          <input
            type="range"
            min={0}
            max={360}
            value={gradientAngle}
            onChange={(e) => setGradientAngle(Number(e.target.value))}
            style={{ width: "100%" }}
          />

          {/* Primary + Accent */}
          <h3 style={sectionStyle}>Primary &amp; Accent</h3>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <ColorField
              label="Primary"
              value={primaryColor}
              onChange={setPrimaryColor}
            />
            <ColorField
              label="Accent"
              value={accentColor}
              onChange={setAccentColor}
            />
          </div>

          {/* Logo */}
          <h3 style={sectionStyle}>Logo</h3>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFileSelected(f);
            }}
          />
          <div
            style={{
              display: "flex",
              gap: 12,
              alignItems: "center",
              marginTop: 8,
              flexWrap: "wrap",
            }}
          >
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
                checked={!keyOutWhite}
                onChange={(e) => setKeyOutWhite(!e.target.checked)}
              />
              Logo is already transparent (skip background removal)
            </label>
            {keyOutWhite && (
              <label style={{ fontSize: 13 }}>
                White tolerance: {whiteTolerance}
                <input
                  type="range"
                  min={4}
                  max={48}
                  value={whiteTolerance}
                  onChange={(e) => setWhiteTolerance(Number(e.target.value))}
                  style={{ marginLeft: 6, verticalAlign: "middle" }}
                />
              </label>
            )}
            {(localLogoUrl || logoObjectPath) && (
              <button
                type="button"
                onClick={handleClearLogo}
                style={smallBtn(false)}
              >
                Remove logo
              </button>
            )}
          </div>

          {previewLogoUrl && (
            <>
              <div style={{ marginTop: 10, display: "flex", gap: 6 }}>
                {(["light", "dark", "brand"] as const).map((bg) => (
                  <button
                    key={bg}
                    type="button"
                    onClick={() => setLogoPreviewBg(bg)}
                    style={{
                      ...smallBtn(false),
                      borderColor:
                        logoPreviewBg === bg
                          ? "var(--primary)"
                          : "var(--border)",
                      fontWeight: logoPreviewBg === bg ? 600 : 400,
                    }}
                  >
                    {bg === "brand" ? "On gradient" : `On ${bg}`}
                  </button>
                ))}
              </div>
              <div
                style={{
                  marginTop: 8,
                  ...previewLogoBgStyle,
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: 16,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  minHeight: 120,
                }}
              >
                <img
                  src={previewLogoUrl}
                  alt="Logo preview"
                  style={{
                    maxHeight: 96,
                    maxWidth: "100%",
                    objectFit: "contain",
                  }}
                />
              </div>
            </>
          )}

          {/* Sampled swatches */}
          {suggestedSwatches.length > 0 && (
            <>
              <h3 style={sectionStyle}>Colors found in your logo</h3>
              <p style={{ color: "var(--text-subtle)", marginTop: 0, fontSize: 13 }}>
                Click a swatch to use it. Hold the role you want to fill,
                then click.
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {suggestedSwatches.map((c) => (
                  <SwatchAssign
                    key={c}
                    color={c}
                    onPrimary={() => setPrimaryColor(c)}
                    onAccent={() => setAccentColor(c)}
                    onGradientStop={(idx) => setGradientAt(idx, c)}
                    gradientLen={gradientColors.length}
                  />
                ))}
              </div>
            </>
          )}

          {/* Save / Restore */}
          <div style={{ marginTop: "1.25rem", display: "flex", gap: 8 }}>
            <button
              type="button"
              className="primary"
              onClick={handleSave}
              disabled={saving || uploading}
              style={primaryBtn}
            >
              {saving ? "Saving…" : uploading ? "Uploading logo…" : "Save branding"}
            </button>
            <button
              type="button"
              onClick={handleRestoreDefaults}
              style={smallBtn(false)}
            >
              Restore defaults
            </button>
          </div>
          {err && (
            <div
              style={{
                color: "var(--danger)",
                marginTop: 8,
                fontSize: 13,
              }}
            >
              {err}
            </div>
          )}
          {info && (
            <div
              style={{
                color: "var(--success)",
                marginTop: 8,
                fontSize: 13,
              }}
            >
              {info}
            </div>
          )}
        </div>

        {/* RIGHT: live preview */}
        <div style={{ flex: "1 1 360px", minWidth: 320 }}>
          <h2 style={{ marginTop: 0 }}>Live preview</h2>

          {/* Brand banner */}
          <div
            style={{
              background: headerBg,
              color: "#fff",
              padding: "0.75rem 1rem",
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              gap: 12,
              boxShadow: "var(--shadow-sm)",
            }}
          >
            {previewLogoUrl && (
              <img
                src={previewLogoUrl}
                alt=""
                style={{ height: 36, width: "auto", objectFit: "contain" }}
              />
            )}
            <div style={{ fontWeight: 700, fontSize: 18 }}>
              {displayName.trim() || "Your School"}
            </div>
          </div>

          {/* Mock printout */}
          <div
            style={{
              marginTop: 12,
              border: "1px solid var(--border)",
              borderRadius: 8,
              overflow: "hidden",
              background: "#fff",
              color: "#0f172a",
            }}
          >
            <div
              style={{
                background: headerBg,
                color: "#fff",
                padding: "0.5rem 0.75rem",
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              {previewLogoUrl && (
                <img
                  src={previewLogoUrl}
                  alt=""
                  style={{ height: 24, width: "auto", objectFit: "contain" }}
                />
              )}
              {displayName.trim() || "Your School"} · Behavior Plan
            </div>
            <div style={{ padding: "0.6rem 0.75rem", fontSize: 12 }}>
              <div>
                <strong>Student:</strong> Sample Student
              </div>
              <div style={{ color: primaryColor }}>
                Tier 2 supports active.
              </div>
              <div style={{ color: accentColor }}>
                Next check-in: tomorrow.
              </div>
            </div>
          </div>

          {/* Parent snapshot */}
          <div
            style={{
              marginTop: 12,
              border: "1px solid var(--border)",
              borderRadius: 12,
              overflow: "hidden",
              background: "#fff",
              color: "#0f172a",
              boxShadow: "var(--shadow-sm)",
            }}
          >
            <div
              style={{
                background: headerBg,
                color: "#fff",
                padding: "0.6rem 0.85rem",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              {previewLogoUrl && (
                <img
                  src={previewLogoUrl}
                  alt=""
                  style={{ height: 28, width: "auto", objectFit: "contain" }}
                />
              )}
              <div>
                <div style={{ fontWeight: 700 }}>HeartBEAT Snapshot</div>
                <div style={{ fontSize: 11, opacity: 0.85 }}>
                  {displayName.trim() || "Your School"}
                </div>
              </div>
            </div>
            <div
              style={{
                padding: "0.75rem",
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
                fontSize: 12,
              }}
            >
              <div
                style={{
                  border: `1px solid ${primaryColor}33`,
                  borderRadius: 6,
                  padding: 6,
                }}
              >
                <div style={{ color: primaryColor, fontWeight: 600 }}>
                  Attendance
                </div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>96%</div>
              </div>
              <div
                style={{
                  border: `1px solid ${accentColor}33`,
                  borderRadius: 6,
                  padding: 6,
                }}
              >
                <div style={{ color: accentColor, fontWeight: 600 }}>Points</div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>1,240</div>
              </div>
            </div>
          </div>

          {/* Kiosk masthead */}
          <div
            style={{
              marginTop: 12,
              borderRadius: 12,
              padding: "1.25rem 1rem",
              background: headerBg,
              color: "#fff",
              textAlign: "center",
            }}
          >
            {previewLogoUrl && (
              <img
                src={previewLogoUrl}
                alt=""
                style={{ height: 48, marginBottom: 8 }}
              />
            )}
            <div style={{ fontSize: 22, fontWeight: 700 }}>
              {displayName.trim() || "Welcome"}
            </div>
            <div style={{ opacity: 0.85, fontSize: 13 }}>Kiosk masthead</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Subcomponents --------------------------------------------------------

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <div>
      <label style={{ display: "block", fontSize: 12, fontWeight: 600 }}>
        {label}
      </label>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          type="color"
          value={isHex(value) ? value : "#888888"}
          onChange={(e) => onChange(e.target.value)}
          style={{ width: 36, height: 32, padding: 0, border: "none" }}
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
          style={{ ...inputStyle, width: 110, marginTop: 0 }}
          spellCheck={false}
        />
      </div>
    </div>
  );
}

// One sampled swatch with a popover offering Primary/Accent/Stop-N actions.
function SwatchAssign({
  color,
  onPrimary,
  onAccent,
  onGradientStop,
  gradientLen,
}: {
  color: string;
  onPrimary: () => void;
  onAccent: () => void;
  onGradientStop: (idx: number) => void;
  gradientLen: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`${color} — assign`}
        style={{
          width: 36,
          height: 36,
          background: color,
          border: "1px solid var(--border)",
          borderRadius: 6,
          cursor: "pointer",
        }}
      />
      {open && (
        <div
          style={{
            position: "absolute",
            top: 40,
            left: 0,
            zIndex: 10,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            boxShadow: "var(--shadow)",
            padding: 6,
            minWidth: 140,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div style={{ fontSize: 11, color: "var(--text-subtle)" }}>
            Use {color} as:
          </div>
          <button
            type="button"
            onClick={() => {
              onPrimary();
              setOpen(false);
            }}
            style={menuBtn}
          >
            Primary
          </button>
          <button
            type="button"
            onClick={() => {
              onAccent();
              setOpen(false);
            }}
            style={menuBtn}
          >
            Accent
          </button>
          {Array.from({ length: gradientLen }).map((_, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => {
                onGradientStop(idx);
                setOpen(false);
              }}
              style={menuBtn}
            >
              Gradient stop {idx + 1}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Style tokens ---------------------------------------------------------

const inputStyle: React.CSSProperties = {
  marginTop: 4,
  padding: "0.4rem 0.5rem",
  border: "1px solid var(--border)",
  borderRadius: 6,
  fontFamily: "monospace",
  fontSize: 13,
  background: "var(--surface)",
  color: "var(--text)",
};

const sectionStyle: React.CSSProperties = {
  marginTop: "1rem",
  marginBottom: "0.5rem",
};

function smallBtn(disabled: boolean): React.CSSProperties {
  return {
    padding: "0.3rem 0.6rem",
    border: "1px solid var(--border)",
    borderRadius: 6,
    background: "var(--surface)",
    color: "var(--text)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    fontSize: 13,
  };
}

const primaryBtn: React.CSSProperties = {
  padding: "0.5rem 0.9rem",
  border: "none",
  borderRadius: 6,
  background: "var(--primary)",
  color: "#fff",
  cursor: "pointer",
  fontWeight: 600,
};

const menuBtn: React.CSSProperties = {
  textAlign: "left",
  padding: "0.3rem 0.5rem",
  border: "none",
  borderRadius: 4,
  background: "transparent",
  cursor: "pointer",
  font: "inherit",
  color: "var(--text)",
};
