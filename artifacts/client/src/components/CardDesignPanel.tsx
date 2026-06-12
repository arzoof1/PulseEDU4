import { useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "../lib/authToken";
import {
  buildHeaderBackground,
  resolveLogoUrl,
  emitBrandingUpdated,
  type BrandingPayload,
} from "../lib/branding";

// Student ID card designer. Lets an admin choose 1-2 school colors OR
// upload a top-background image (behind the header + photo only), set the
// header text to auto-contrast or a manual color, and toggle an optional
// house footer band. A live HTML mock mirrors the printed PDF layout, and
// "Print sample badge" renders the real PDF (?sample endpoint) so the admin
// can verify before printing a batch. NO drag-and-drop.

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
function isHex(s: string): boolean {
  return HEX_RE.test(s.trim());
}

// Relative-luminance contrast pick — mirrors the server renderer so the
// HTML preview matches the printed card.
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return { r: 15, g: 23, b: 42 };
  const n = parseInt(m[1]!, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}
function isLight(hex: string): boolean {
  const { r, g, b } = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
}
function readableTextOn(hex: string): string {
  return isLight(hex) ? "#111827" : "#ffffff";
}

type BgMode = "colors" | "image";
type TextMode = "auto" | "manual";
type HouseBgMode = "house" | "white" | "custom";

export function CardDesignPanel() {
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Card orientation (per-school). Landscape is the legacy CR80 layout;
  // portrait is the lanyard-style layout with icon rows + house emblem.
  const [orientation, setOrientation] = useState<"landscape" | "portrait">(
    "landscape",
  );

  // Top background
  const [bgMode, setBgMode] = useState<BgMode>("colors");
  const [bgColors, setBgColors] = useState<string[]>([]);
  const [bgAngle, setBgAngle] = useState(135);
  const [bgObjectPath, setBgObjectPath] = useState<string | null>(null);
  // Local preview URL for a freshly-picked (not-yet-uploaded) image.
  const [localBgUrl, setLocalBgUrl] = useState<string | null>(null);
  const [localBgBlob, setLocalBgBlob] = useState<Blob | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Header text
  const [headerTextMode, setHeaderTextMode] = useState<TextMode>("auto");
  const [headerTextColor, setHeaderTextColor] = useState("#ffffff");

  // House footer
  const [showHouse, setShowHouse] = useState(true);
  const [houseBgMode, setHouseBgMode] = useState<HouseBgMode>("house");
  const [houseBgColor, setHouseBgColor] = useState("#111827");
  const [houseTextMode, setHouseTextMode] = useState<TextMode>("auto");
  const [houseTextColor, setHouseTextColor] = useState("#ffffff");

  // A representative house color for the live preview (first house, else a
  // sensible default). Loaded best-effort; the printed card uses the real
  // per-student house.
  const [previewHouseColor, setPreviewHouseColor] = useState("#b91c1c");
  const [previewHouseName, setPreviewHouseName] = useState("Phoenix");
  const [schoolName, setSchoolName] = useState("Your School");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch("/api/school-branding");
        if (res.ok) {
          const b = (await res.json()) as BrandingPayload & {
            displayNameOverride?: string | null;
          };
          if (!cancelled) {
            setOrientation(b.cardOrientation ?? "landscape");
            setBgMode(b.cardBgMode ?? "colors");
            setBgColors(Array.isArray(b.cardBgColors) ? b.cardBgColors : []);
            setBgAngle(b.cardBgAngle ?? 135);
            setBgObjectPath(b.cardBgObjectPath ?? null);
            setHeaderTextMode(b.cardHeaderTextMode ?? "auto");
            setHeaderTextColor(b.cardHeaderTextColor ?? "#ffffff");
            setShowHouse(b.cardShowHouse ?? true);
            setHouseBgMode(b.cardHouseBgMode ?? "house");
            setHouseBgColor(b.cardHouseBgColor ?? "#111827");
            setHouseTextMode(b.cardHouseTextMode ?? "auto");
            setHouseTextColor(b.cardHouseTextColor ?? "#ffffff");
            if (b.displayNameOverride) setSchoolName(b.displayNameOverride);
          }
        }
      } catch {
        // keep defaults
      }
      // Best-effort: a representative house for the preview. The printed
      // card uses each student's real house; this is only an approximation.
      try {
        const hRes = await authFetch("/api/houses");
        if (hRes.ok) {
          const data = (await hRes.json()) as
            | Array<{ name: string; color: string }>
            | { houses?: Array<{ name: string; color: string }> };
          const houses = Array.isArray(data) ? data : data?.houses ?? [];
          if (!cancelled && houses.length > 0) {
            setPreviewHouseColor(houses[0]!.color || "#b91c1c");
            setPreviewHouseName(houses[0]!.name || "Phoenix");
          }
        }
      } catch {
        /* ignore */
      }
      if (!cancelled) setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Revoke any object URL we created for the local image preview.
  useEffect(() => {
    return () => {
      if (localBgUrl) URL.revokeObjectURL(localBgUrl);
    };
  }, [localBgUrl]);

  function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) {
      setErr("Background must be a PNG, JPEG, or WebP image.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setErr("Background image must be under 5 MB.");
      return;
    }
    setErr(null);
    if (localBgUrl) URL.revokeObjectURL(localBgUrl);
    setLocalBgBlob(file);
    setLocalBgUrl(URL.createObjectURL(file));
    setBgMode("image");
  }

  function clearImage() {
    if (localBgUrl) URL.revokeObjectURL(localBgUrl);
    setLocalBgUrl(null);
    setLocalBgBlob(null);
    setBgObjectPath(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  // Upload the picked image to object storage, returning its objectPath.
  async function uploadBgImage(): Promise<string | null> {
    if (!localBgBlob) return bgObjectPath;
    setUploading(true);
    try {
      const reqRes = await authFetch("/api/storage/uploads/request-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "card-background",
          size: localBgBlob.size,
          contentType: localBgBlob.type,
        }),
      });
      if (!reqRes.ok) throw new Error("Could not start image upload");
      const { uploadURL, objectPath } = (await reqRes.json()) as {
        uploadURL: string;
        objectPath: string;
      };
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": localBgBlob.type },
        body: localBgBlob,
      });
      if (!putRes.ok) throw new Error("Image upload failed");
      return objectPath;
    } finally {
      setUploading(false);
    }
  }

  function addColor() {
    setBgColors((prev) => (prev.length >= 2 ? prev : [...prev, "#0e7490"]));
  }
  function setColorAt(i: number, v: string) {
    setBgColors((prev) => prev.map((c, idx) => (idx === i ? v : c)));
  }
  function removeColorAt(i: number) {
    setBgColors((prev) => prev.filter((_, idx) => idx !== i));
  }

  function validate(): string | null {
    if (bgMode === "colors") {
      if (bgColors.length > 2) return "Pick at most 2 background colors.";
      for (const c of bgColors) {
        if (!isHex(c)) return `"${c}" is not a valid #RRGGBB color.`;
      }
    }
    if (headerTextMode === "manual" && !isHex(headerTextColor)) {
      return "Header text color must be #RRGGBB.";
    }
    if (houseBgMode === "custom" && !isHex(houseBgColor)) {
      return "Footer background color must be #RRGGBB.";
    }
    if (houseTextMode === "manual" && !isHex(houseTextColor)) {
      return "Footer text color must be #RRGGBB.";
    }
    return null;
  }

  // Persist the design. Uploads the image first (image mode) so we have a
  // bound objectPath by save time. Re-sends the existing branding values
  // unchanged is unnecessary — the PUT validates each block independently
  // and the server merges card fields onto the row.
  async function handleSave(): Promise<boolean> {
    const v = validate();
    if (v) {
      setErr(v);
      return false;
    }
    setSaving(true);
    setErr(null);
    setInfo(null);
    try {
      let nextBgPath = bgObjectPath;
      if (bgMode === "image" && localBgBlob) {
        nextBgPath = await uploadBgImage();
      }
      // We must re-send the full branding payload because PUT is a whole-row
      // upsert. Load the current row, then overlay the card fields.
      const cur = await authFetch("/api/school-branding");
      const base = cur.ok ? ((await cur.json()) as BrandingPayload) : null;
      const body = {
        // Preserve existing branding (PUT is a full upsert).
        gradientColors: base?.gradientColors ?? [],
        gradientAngle: base?.gradientAngle ?? 135,
        primaryColor: base?.primaryColor ?? null,
        accentColor: base?.accentColor ?? null,
        logoObjectPath: base?.logoObjectPath ?? null,
        displayNameOverride: base?.displayNameOverride ?? null,
        buttonRestBgColors: base?.buttonRestBgColors ?? [],
        buttonRestBgAngle: base?.buttonRestBgAngle ?? 135,
        buttonRestText: base?.buttonRestText ?? null,
        buttonHoverBgColors: base?.buttonHoverBgColors ?? [],
        buttonHoverBgAngle: base?.buttonHoverBgAngle ?? 135,
        buttonHoverText: base?.buttonHoverText ?? null,
        // Card design.
        cardOrientation: orientation,
        cardBgMode: bgMode,
        cardBgColors: bgMode === "colors" ? bgColors : [],
        cardBgAngle: bgAngle,
        cardBgObjectPath: bgMode === "image" ? nextBgPath : null,
        cardHeaderTextMode: headerTextMode,
        cardHeaderTextColor:
          headerTextMode === "manual" ? headerTextColor : null,
        cardShowHouse: showHouse,
        cardHouseBgMode: houseBgMode,
        cardHouseBgColor: houseBgMode === "custom" ? houseBgColor : null,
        cardHouseTextMode: houseTextMode,
        cardHouseTextColor: houseTextMode === "manual" ? houseTextColor : null,
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
          /* ignore */
        }
        throw new Error(msg);
      }
      const saved = (await res.json()) as BrandingPayload;
      setBgObjectPath(saved.cardBgObjectPath ?? null);
      setLocalBgBlob(null);
      if (localBgUrl) URL.revokeObjectURL(localBgUrl);
      setLocalBgUrl(null);
      emitBrandingUpdated();
      setInfo("Card design saved.");
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setSaving(false);
    }
  }

  // Save first (so the sample reflects the latest controls), then download
  // the real PDF from the sample endpoint.
  async function handlePrintSample() {
    setPrinting(true);
    setErr(null);
    setInfo(null);
    try {
      const ok = await handleSave();
      if (!ok) return;
      const res = await authFetch("/api/students/id-badges-sample.pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? `Sample PDF failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "student-id-sample.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setInfo("Sample badge downloaded.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPrinting(false);
    }
  }

  // ---- Live HTML preview values (mirror the PDF renderer) --------------
  const topColors = useMemo(
    () => (bgColors.length > 0 ? bgColors : [previewHouseColor]),
    [bgColors, previewHouseColor],
  );
  const bgImageUrl =
    bgMode === "image"
      ? localBgUrl ?? resolveLogoUrl(bgObjectPath)
      : null;
  const topBackground =
    bgMode === "image" && bgImageUrl
      ? `center / cover no-repeat url("${bgImageUrl}")`
      : buildHeaderBackground(topColors, bgAngle);
  const autoHeaderColor =
    bgMode === "image" && bgImageUrl
      ? "#ffffff"
      : readableTextOn(topColors[0] ?? previewHouseColor);
  const headerColor =
    headerTextMode === "manual" && isHex(headerTextColor)
      ? headerTextColor
      : autoHeaderColor;

  const footerBg =
    houseBgMode === "white"
      ? "#ffffff"
      : houseBgMode === "custom" && isHex(houseBgColor)
        ? houseBgColor
        : previewHouseColor;
  const footerText =
    houseTextMode === "manual" && isHex(houseTextColor)
      ? houseTextColor
      : readableTextOn(footerBg);

  if (!loaded) {
    return <div style={{ opacity: 0.7, padding: "0.5rem" }}>Loading…</div>;
  }

  const inputStyle: React.CSSProperties = {
    width: 96,
    padding: "0.2rem 0.3rem",
    border: "1px solid var(--border, rgba(0,0,0,0.2))",
    borderRadius: 6,
  };
  const labelStyle: React.CSSProperties = {
    fontSize: "0.85rem",
    fontWeight: 600,
    display: "block",
    marginBottom: "0.25rem",
  };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "1.5rem", marginTop: "0.75rem" }}>
      {/* ---- Controls ---- */}
      <div style={{ flex: "1 1 320px", minWidth: 300 }}>
        {/* Orientation */}
        <fieldset style={{ border: "1px solid var(--border, rgba(0,0,0,0.15))", borderRadius: 8, marginBottom: "1rem" }}>
          <legend style={{ fontWeight: 700, padding: "0 0.4rem" }}>Orientation</legend>
          <div style={{ display: "flex", gap: "1rem" }}>
            <label style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
              <input
                type="radio"
                name="cardOrientation"
                checked={orientation === "landscape"}
                onChange={() => setOrientation("landscape")}
              />
              Landscape
            </label>
            <label style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
              <input
                type="radio"
                name="cardOrientation"
                checked={orientation === "portrait"}
                onChange={() => setOrientation("portrait")}
              />
              Portrait (lanyard)
            </label>
          </div>
          <div style={{ fontSize: "0.8rem", opacity: 0.7, marginTop: "0.45rem" }}>
            Portrait prints a vertical lanyard badge with icon rows and a house
            emblem. All colors, background, header-text and house options below
            apply to both orientations.
          </div>
        </fieldset>

        {/* Top background */}
        <fieldset style={{ border: "1px solid var(--border, rgba(0,0,0,0.15))", borderRadius: 8, marginBottom: "1rem" }}>
          <legend style={{ fontWeight: 700, padding: "0 0.4rem" }}>Top background</legend>
          <div style={{ display: "flex", gap: "1rem", marginBottom: "0.5rem" }}>
            <label style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
              <input
                type="radio"
                name="cardBgMode"
                checked={bgMode === "colors"}
                onChange={() => setBgMode("colors")}
              />
              School colors
            </label>
            <label style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
              <input
                type="radio"
                name="cardBgMode"
                checked={bgMode === "image"}
                onChange={() => setBgMode("image")}
              />
              Upload image
            </label>
          </div>

          {bgMode === "colors" ? (
            <div>
              <span style={labelStyle}>Colors (1–2)</span>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                {bgColors.length === 0 && (
                  <div style={{ fontSize: "0.82rem", opacity: 0.7 }}>
                    No colors set — badge uses each student's house color.
                  </div>
                )}
                {bgColors.map((c, i) => (
                  <div key={i} style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                    <input
                      type="color"
                      value={isHex(c) ? c : "#0e7490"}
                      onChange={(e) => setColorAt(i, e.target.value)}
                      style={{ width: 36, height: 28, padding: 0, border: "none", background: "none" }}
                    />
                    <input
                      type="text"
                      value={c}
                      onChange={(e) => setColorAt(i, e.target.value)}
                      style={inputStyle}
                    />
                    <button type="button" onClick={() => removeColorAt(i)} style={linkBtn}>
                      Remove
                    </button>
                  </div>
                ))}
                {bgColors.length < 2 && (
                  <button type="button" onClick={addColor} style={linkBtn}>
                    + Add color
                  </button>
                )}
              </div>
              {bgColors.length === 2 && (
                <div style={{ marginTop: "0.6rem" }}>
                  <label style={labelStyle} htmlFor="cardBgAngle">
                    Gradient angle: {bgAngle}°
                  </label>
                  <input
                    id="cardBgAngle"
                    type="range"
                    min={0}
                    max={360}
                    value={bgAngle}
                    onChange={(e) => setBgAngle(Number(e.target.value))}
                    style={{ width: "100%" }}
                  />
                </div>
              )}
            </div>
          ) : (
            <div>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={onPickImage}
              />
              {(localBgUrl || bgObjectPath) && (
                <button type="button" onClick={clearImage} style={{ ...linkBtn, marginLeft: "0.5rem" }}>
                  Remove image
                </button>
              )}
              <div style={{ fontSize: "0.8rem", opacity: 0.7, marginTop: "0.35rem" }}>
                Covers the top portion only (behind the header + photo). The
                QR, barcode, and crisis line stay on clean white. PNG/JPEG/WebP,
                under 5 MB.
              </div>
            </div>
          )}
        </fieldset>

        {/* Header text */}
        <fieldset style={{ border: "1px solid var(--border, rgba(0,0,0,0.15))", borderRadius: 8, marginBottom: "1rem" }}>
          <legend style={{ fontWeight: 700, padding: "0 0.4rem" }}>Header &amp; name text</legend>
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
              <input
                type="radio"
                name="cardHeaderTextMode"
                checked={headerTextMode === "auto"}
                onChange={() => setHeaderTextMode("auto")}
              />
              Auto-contrast
            </label>
            <label style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
              <input
                type="radio"
                name="cardHeaderTextMode"
                checked={headerTextMode === "manual"}
                onChange={() => setHeaderTextMode("manual")}
              />
              Manual
            </label>
            {headerTextMode === "manual" && (
              <span style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                <input
                  type="color"
                  value={isHex(headerTextColor) ? headerTextColor : "#ffffff"}
                  onChange={(e) => setHeaderTextColor(e.target.value)}
                  style={{ width: 36, height: 28, padding: 0, border: "none", background: "none" }}
                />
                <input
                  type="text"
                  value={headerTextColor}
                  onChange={(e) => setHeaderTextColor(e.target.value)}
                  style={inputStyle}
                />
              </span>
            )}
          </div>
        </fieldset>

        {/* House footer */}
        <fieldset style={{ border: "1px solid var(--border, rgba(0,0,0,0.15))", borderRadius: 8 }}>
          <legend style={{ fontWeight: 700, padding: "0 0.4rem" }}>House footer band</legend>
          <label style={{ display: "flex", gap: "0.35rem", alignItems: "center", marginBottom: "0.5rem" }}>
            <input
              type="checkbox"
              checked={showHouse}
              onChange={(e) => setShowHouse(e.target.checked)}
            />
            Show house footer band
          </label>
          {showHouse && (
            <>
              <span style={labelStyle}>Footer background</span>
              <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
                {(["house", "white", "custom"] as const).map((m) => (
                  <label key={m} style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
                    <input
                      type="radio"
                      name="cardHouseBgMode"
                      checked={houseBgMode === m}
                      onChange={() => setHouseBgMode(m)}
                    />
                    {m === "house" ? "House color" : m === "white" ? "White" : "Custom"}
                  </label>
                ))}
                {houseBgMode === "custom" && (
                  <span style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                    <input
                      type="color"
                      value={isHex(houseBgColor) ? houseBgColor : "#111827"}
                      onChange={(e) => setHouseBgColor(e.target.value)}
                      style={{ width: 36, height: 28, padding: 0, border: "none", background: "none" }}
                    />
                    <input
                      type="text"
                      value={houseBgColor}
                      onChange={(e) => setHouseBgColor(e.target.value)}
                      style={inputStyle}
                    />
                  </span>
                )}
              </div>
              <span style={labelStyle}>Footer text</span>
              <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "center" }}>
                <label style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
                  <input
                    type="radio"
                    name="cardHouseTextMode"
                    checked={houseTextMode === "auto"}
                    onChange={() => setHouseTextMode("auto")}
                  />
                  Auto-contrast
                </label>
                <label style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
                  <input
                    type="radio"
                    name="cardHouseTextMode"
                    checked={houseTextMode === "manual"}
                    onChange={() => setHouseTextMode("manual")}
                  />
                  Manual
                </label>
                {houseTextMode === "manual" && (
                  <span style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                    <input
                      type="color"
                      value={isHex(houseTextColor) ? houseTextColor : "#ffffff"}
                      onChange={(e) => setHouseTextColor(e.target.value)}
                      style={{ width: 36, height: 28, padding: 0, border: "none", background: "none" }}
                    />
                    <input
                      type="text"
                      value={houseTextColor}
                      onChange={(e) => setHouseTextColor(e.target.value)}
                      style={inputStyle}
                    />
                  </span>
                )}
              </div>
            </>
          )}
        </fieldset>

        <div style={{ display: "flex", gap: "0.6rem", marginTop: "1rem", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || uploading || printing}
            style={primaryBtn}
          >
            {saving || uploading ? "Saving…" : "Save design"}
          </button>
          <button
            type="button"
            onClick={handlePrintSample}
            disabled={saving || uploading || printing}
            style={secondaryBtn}
          >
            {printing ? "Preparing…" : "Print sample badge"}
          </button>
        </div>
        {err && <div style={{ color: "#b91c1c", marginTop: "0.6rem" }}>{err}</div>}
        {info && <div style={{ color: "#15803d", marginTop: "0.6rem" }}>{info}</div>}
      </div>

      {/* ---- Live preview ---- */}
      <div style={{ flex: "0 0 auto" }}>
        <span style={labelStyle}>Live preview</span>
        {orientation === "portrait" ? (
          <CardPreviewPortrait
            schoolName={schoolName}
            topBackground={topBackground}
            headerColor={headerColor}
            showHouse={showHouse}
            footerBg={footerBg}
            footerText={footerText}
            houseName={previewHouseName}
            houseColor={previewHouseColor}
          />
        ) : (
          <CardPreview
            schoolName={schoolName}
            topBackground={topBackground}
            headerColor={headerColor}
            showHouse={showHouse}
            footerBg={footerBg}
            footerText={footerText}
            houseName={previewHouseName}
          />
        )}
        <div style={{ fontSize: "0.78rem", opacity: 0.65, maxWidth: 360, marginTop: "0.4rem" }}>
          Approximation of the printed card. Use “Print sample badge” for an
          exact PDF.
        </div>
      </div>
    </div>
  );
}

// HTML mock of the printed CR80 card (scaled up 1.5× from 243×153 for
// on-screen legibility). Mirrors the PDF layout: colored/image top region,
// white QR plate, white barcode strip, optional house footer.
function CardPreview(props: {
  schoolName: string;
  topBackground: string;
  headerColor: string;
  showHouse: boolean;
  footerBg: string;
  footerText: string;
  houseName: string;
}) {
  const W = 364; // 243 * 1.5
  const TOP_H = 144; // 96 * 1.5
  return (
    <div
      style={{
        width: W,
        border: "1px solid #cbd5e1",
        borderRadius: 9,
        overflow: "hidden",
        background: "#fff",
        fontFamily: "system-ui, sans-serif",
        boxShadow: "0 1px 4px rgba(0,0,0,0.12)",
      }}
    >
      {/* Top region */}
      <div style={{ position: "relative", height: TOP_H, background: props.topBackground }}>
        <div
          style={{
            position: "absolute",
            top: 10,
            left: 14,
            right: 132,
            color: props.headerColor,
            fontWeight: 700,
            fontSize: 16,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {props.schoolName}
        </div>
        {/* Photo placeholder */}
        <div
          style={{
            position: "absolute",
            top: 48,
            left: 14,
            width: 84,
            height: 84,
            borderRadius: 6,
            background: "#e2e8f0",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#475569",
            fontWeight: 700,
            fontSize: 26,
          }}
        >
          JS
        </div>
        {/* Name + grade */}
        <div style={{ position: "absolute", top: 52, left: 110, right: 132, color: props.headerColor }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Jordan Sample</div>
          <div style={{ fontSize: 12, marginTop: 6 }}>Grade 7</div>
        </div>
        {/* QR white plate */}
        <div
          style={{
            position: "absolute",
            top: 18,
            right: 12,
            width: 112,
            height: 112,
            borderRadius: 7,
            background: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#94a3b8",
            fontSize: 10,
            border: "1px solid #e2e8f0",
          }}
        >
          QR
        </div>
      </div>
      {/* White region — house band, then barcode (below the band, for
          cafeteria swipe readers), then the crisis strip at the very bottom. */}
      <div style={{ padding: "8px 12px 10px" }}>
        {props.showHouse && (
          <div
            style={{
              height: 24,
              borderRadius: 5,
              background: props.footerBg,
              border: props.footerBg.toLowerCase() === "#ffffff" ? "1px solid #cbd5e1" : "none",
              color: props.footerText,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontSize: 12,
              letterSpacing: 0.5,
            }}
          >
            HOUSE {props.houseName.toUpperCase()}
          </div>
        )}
        <div
          style={{
            marginTop: props.showHouse ? 8 : 0,
            height: 18,
            background:
              "repeating-linear-gradient(90deg,#111 0 2px,#fff 2px 4px,#111 4px 7px,#fff 7px 9px)",
          }}
        />
        <div style={{ marginTop: 8, textAlign: "center", color: "#b91c1c", fontSize: 9 }}>
          Crisis? Call or text 988 · Crisis Text Line: text HOME to 741741
        </div>
      </div>
    </div>
  );
}

// HTML mock of the PORTRAIT lanyard badge (scaled from 153×243). Mirrors the
// PDF portrait renderer: lanyard slot, diagonal school-color corner ribbons,
// centered school name, photo + QR, icon rows (Car Rider / name+grade /
// teacher), house emblem band, barcode below it, navy crisis strip.
function CardPreviewPortrait(props: {
  schoolName: string;
  topBackground: string;
  headerColor: string;
  showHouse: boolean;
  footerBg: string;
  footerText: string;
  houseName: string;
  houseColor: string;
}) {
  const W = 255; // 153 * 1.667
  const ribbon = props.houseColor || "#b91c1c";
  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 0",
    borderTop: "1px solid #e2e8f0",
  };
  const iconBubble: React.CSSProperties = {
    flex: "0 0 auto",
    width: 26,
    height: 26,
    borderRadius: "50%",
    background: "#1e3a5f",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 13,
  };
  return (
    <div
      style={{
        width: W,
        border: "1px solid #cbd5e1",
        borderRadius: 12,
        overflow: "hidden",
        background: "#fff",
        fontFamily: "system-ui, sans-serif",
        boxShadow: "0 1px 4px rgba(0,0,0,0.12)",
      }}
    >
      {/* Header with lanyard slot + corner ribbons */}
      <div style={{ position: "relative", height: 92, background: props.topBackground, overflow: "hidden" }}>
        {/* corner ribbons */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: 0,
            height: 0,
            borderTop: `46px solid ${ribbon}`,
            borderRight: "46px solid transparent",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            width: 0,
            height: 0,
            borderTop: `46px solid ${ribbon}`,
            borderLeft: "46px solid transparent",
          }}
        />
        {/* lanyard slot */}
        <div
          style={{
            position: "absolute",
            top: 8,
            left: "50%",
            transform: "translateX(-50%)",
            width: 56,
            height: 12,
            borderRadius: 6,
            border: "2px solid rgba(255,255,255,0.85)",
            background: "rgba(255,255,255,0.12)",
          }}
        />
        {/* school name */}
        <div
          style={{
            position: "absolute",
            left: 8,
            right: 8,
            top: 40,
            textAlign: "center",
            color: props.headerColor,
            fontWeight: 800,
            fontSize: 17,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {props.schoolName}
        </div>
      </div>
      {/* photo + QR */}
      <div style={{ display: "flex", gap: 10, padding: "10px 12px 6px" }}>
        <div
          style={{
            flex: "0 0 auto",
            width: 96,
            height: 96,
            borderRadius: 8,
            background: "#e2e8f0",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#475569",
            fontWeight: 700,
            fontSize: 30,
          }}
        >
          JS
        </div>
        <div
          style={{
            flex: 1,
            height: 96,
            borderRadius: 8,
            background: "#fff",
            border: "1px solid #e2e8f0",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#94a3b8",
            fontSize: 11,
          }}
        >
          QR
        </div>
      </div>
      {/* icon rows */}
      <div style={{ padding: "0 12px" }}>
        <div style={rowStyle}>
          <span style={iconBubble}>🚗</span>
          <span style={{ fontWeight: 700, fontSize: 14, color: "#1e293b" }}>CAR RIDER</span>
        </div>
        <div style={rowStyle}>
          <span style={iconBubble}>👤</span>
          <span style={{ fontWeight: 700, fontSize: 14, color: "#1e293b", flex: 1 }}>Jordan Sample</span>
          <span
            style={{
              flex: "0 0 auto",
              width: 26,
              height: 26,
              borderRadius: "50%",
              border: "2px solid #1e3a5f",
              color: "#1e3a5f",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontSize: 13,
            }}
          >
            7
          </span>
        </div>
        <div style={rowStyle}>
          <span style={iconBubble}>👥</span>
          <span style={{ fontWeight: 600, fontSize: 13, color: "#1e293b" }}>Teacher: Ms. Johnson</span>
        </div>
      </div>
      {/* house band + barcode + crisis */}
      <div style={{ padding: "8px 12px 10px" }}>
        {props.showHouse && (
          <div
            style={{
              height: 28,
              borderRadius: 6,
              background: props.footerBg,
              border: props.footerBg.toLowerCase() === "#ffffff" ? "1px solid #cbd5e1" : "none",
              color: props.footerText,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 800,
              fontSize: 13,
              letterSpacing: 0.5,
            }}
          >
            HOUSE {props.houseName.toUpperCase()}
          </div>
        )}
        <div
          style={{
            marginTop: props.showHouse ? 8 : 0,
            height: 20,
            background:
              "repeating-linear-gradient(90deg,#111 0 2px,#fff 2px 4px,#111 4px 7px,#fff 7px 9px)",
          }}
        />
      </div>
      {/* navy crisis strip */}
      <div
        style={{
          background: "#1e3a5f",
          color: "#fff",
          fontSize: 9,
          textAlign: "center",
          padding: "6px 8px",
        }}
      >
        Crisis? Call or text 988 · Text HOME to 741741
      </div>
    </div>
  );
}

const linkBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--brand-primary, #0e7490)",
  cursor: "pointer",
  padding: 0,
  fontSize: "0.85rem",
  textAlign: "left",
};
const primaryBtn: React.CSSProperties = {
  background: "var(--brand-primary, #0e7490)",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  padding: "0.5rem 1rem",
  fontWeight: 600,
  cursor: "pointer",
};
const secondaryBtn: React.CSSProperties = {
  background: "#fff",
  color: "var(--brand-primary, #0e7490)",
  border: "1px solid var(--brand-primary, #0e7490)",
  borderRadius: 8,
  padding: "0.5rem 1rem",
  fontWeight: 600,
  cursor: "pointer",
};

export default CardDesignPanel;
