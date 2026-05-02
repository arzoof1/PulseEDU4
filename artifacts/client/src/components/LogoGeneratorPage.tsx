// PulseEDU brand logo generator. Admin/SuperUser tool that produces
// drop-in animated SVG, static SVG, and PNG variants for sister apps
// (PulseTV, PulseKinetics, PulseAthletics, …) using the same EKG
// + gradient-wordmark mark as PulseEDU itself.
//
// The generator runs entirely client-side: the SVG is built as a
// string, downloaded via Blob, and the PNG is rasterized through a
// canvas. No server round trip.
import { useMemo, useState } from "react";

interface PresetSwatch {
  label: string;
  prefix: string;
  accent: string;
  c1: string;
  c2: string;
  c3: string;
  ekg: string;
}

const PRESETS: PresetSwatch[] = [
  { label: "PulseEDU (current)", prefix: "Pulse", accent: "EDU",
    c1: "#0f766e", c2: "#0e7490", c3: "#7c3aed", ekg: "#dc2626" },
  { label: "PulseTV",            prefix: "Pulse", accent: "TV",
    c1: "#0ea5e9", c2: "#2563eb", c3: "#7c3aed", ekg: "#dc2626" },
  { label: "PulseKinetics",      prefix: "Pulse", accent: "Kinetics",
    c1: "#f97316", c2: "#ef4444", c3: "#be123c", ekg: "#fbbf24" },
  { label: "PulseAthletics",     prefix: "Pulse", accent: "Athletics",
    c1: "#15803d", c2: "#0d9488", c3: "#0e7490", ekg: "#f97316" },
];

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c] ?? c),
  );
}

interface BuildArgs {
  prefix: string;
  accent: string;
  c1: string;
  c2: string;
  c3: string;
  ekg: string;
  animated: boolean;
}

// Banner SVG — wide horizontal "wordmark + EKG" mark. Width auto-sizes
// to text length so longer accents (Kinetics, Athletics) don't crop.
function buildBannerSvg(a: BuildArgs): string {
  const wPrefix = a.prefix.length * 13.6;
  const wAccent = a.accent.length * 14.4;
  const x = Math.ceil(12 + wPrefix + wAccent + 4 + 6);
  const totalW = Math.ceil(x + 26 + 12 + 50);
  const ekgPath =
    `M0 20 H${x} L${x + 6} 16 L${x + 10} 24 L${x + 14} 5 ` +
    `L${x + 18} 35 L${x + 22} 16 L${x + 26} 20 H${totalW}`;
  const dashLen = 38;
  const gapLen = totalW + 40;
  const totalLen = dashLen + gapLen;
  const animatedCss = a.animated
    ? `.ekg-pulse{stroke-dasharray:${dashLen} ${gapLen};stroke-dashoffset:${totalLen};animation:pulse-sweep 2.2s linear infinite}@keyframes pulse-sweep{from{stroke-dashoffset:${totalLen}}to{stroke-dashoffset:0}}`
    : "";
  const staticPulsePath = a.animated
    ? ekgPath
    : `M${x - 10} 20 H${x} L${x + 6} 16 L${x + 10} 24 L${x + 14} 5 L${x + 18} 35 L${x + 22} 16 L${x + 26} 20 H${x + 36}`;
  const accentSpan = a.accent
    ? `<tspan class="accent" dx="1">${escapeXml(a.accent)}</tspan>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW} 40" width="${totalW}" height="40" role="img" aria-label="${escapeXml(a.prefix + a.accent)}">
  <title>${escapeXml(a.prefix + a.accent)}</title>
  <defs>
    <linearGradient id="wm" x1="0" y1="0" x2="1" y2="1" gradientTransform="rotate(45 0.5 0.5)">
      <stop offset="0%" stop-color="${a.c1}"/><stop offset="60%" stop-color="${a.c2}"/><stop offset="100%" stop-color="${a.c3}"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-50%" width="140%" height="200%">
      <feGaussianBlur stdDeviation="0.9" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <style>
      .wordmark,.accent{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;fill:url(#wm)}
      .wordmark{font-weight:800;font-size:24px;letter-spacing:-0.02em}
      .accent{font-weight:900;font-size:24px;letter-spacing:-0.03em;font-style:italic}
      ${animatedCss}
    </style>
  </defs>
  <path d="${ekgPath}" fill="none" stroke="${a.ekg}" stroke-opacity="0.3" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
  <path class="ekg-pulse" d="${staticPulsePath}" fill="none" stroke="${a.ekg}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)"/>
  <text x="12" y="28" class="wordmark">${escapeXml(a.prefix)}${accentSpan}</text>
</svg>`;
}

// 180×180 favicon — gradient rounded square, italic monogram, soft EKG
// sweep underneath. Monogram is the first letter of prefix + first
// letter of accent (e.g. PT, PE, PK, PA).
function buildFaviconSvg(a: BuildArgs): string {
  const monogram =
    ((a.prefix[0] || "") + (a.accent[0] || "")).toUpperCase() || "P";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180" width="180" height="180" role="img" aria-label="${escapeXml(a.prefix + a.accent)} icon">
  <title>${escapeXml(a.prefix + a.accent)}</title>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1" gradientTransform="rotate(45 0.5 0.5)">
      <stop offset="0%" stop-color="${a.c1}"/><stop offset="60%" stop-color="${a.c2}"/><stop offset="100%" stop-color="${a.c3}"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-50%" width="140%" height="200%">
      <feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="180" height="180" rx="36" fill="url(#bg)"/>
  <text x="90" y="108" text-anchor="middle"
        font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif"
        font-weight="900" font-style="italic" font-size="84"
        letter-spacing="-3" fill="white">${escapeXml(monogram)}</text>
  <path d="M20 140 H68 L74 134 L78 146 L82 122 L86 158 L90 134 L94 140 H160"
        fill="none" stroke="${a.ekg}" stroke-opacity="0.85" stroke-width="3.5"
        stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)"/>
</svg>`;
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}

function downloadText(filename: string, text: string): void {
  downloadBlob(filename, new Blob([text], { type: "image/svg+xml" }));
}

// Rasterize an SVG string to a PNG via a canvas. Returns a Promise
// that resolves once the download has been triggered. We use the
// static variant for PNG since CSS animations don't render through
// the canvas pipeline.
async function downloadPng(filename: string, svg: string, scale = 4): Promise<void> {
  const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  await new Promise<void>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth * scale;
      canvas.height = img.naturalHeight * scale;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error("Canvas not supported"));
        return;
      }
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => {
        if (b) downloadBlob(filename, b);
        resolve();
      }, "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("PNG export failed"));
    };
    img.src = url;
  });
}

function safeName(prefix: string, accent: string): string {
  const base = (prefix + accent)
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase()
    .replace(/^-|-$/g, "");
  return base || "logo";
}

export default function LogoGeneratorPage() {
  const [prefix, setPrefix] = useState("Pulse");
  const [accent, setAccent] = useState("TV");
  const [c1, setC1] = useState("#0ea5e9");
  const [c2, setC2] = useState("#2563eb");
  const [c3, setC3] = useState("#7c3aed");
  const [ekg, setEkg] = useState("#dc2626");

  const animatedSvg = useMemo(
    () => buildBannerSvg({ prefix, accent, c1, c2, c3, ekg, animated: true }),
    [prefix, accent, c1, c2, c3, ekg],
  );
  const staticSvg = useMemo(
    () => buildBannerSvg({ prefix, accent, c1, c2, c3, ekg, animated: false }),
    [prefix, accent, c1, c2, c3, ekg],
  );
  const faviconSvg = useMemo(
    () => buildFaviconSvg({ prefix, accent, c1, c2, c3, ekg, animated: false }),
    [prefix, accent, c1, c2, c3, ekg],
  );

  function applyPreset(p: PresetSwatch) {
    setPrefix(p.prefix);
    setAccent(p.accent);
    setC1(p.c1);
    setC2(p.c2);
    setC3(p.c3);
    setEkg(p.ekg);
  }

  const slug = safeName(prefix, accent);

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Brand Logo Generator</h2>
      <p style={{ color: "var(--text-subtle)", marginTop: 0, maxWidth: 720 }}>
        Spin up a sister-app brand mark that matches PulseEDU's look —
        gradient wordmark, EKG sweep, glowing pulse. Export as animated
        SVG (drop into any web app), static SVG (PDF/print), or 4×
        PNG (slides, social, app icons).
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className="btn"
            onClick={() => applyPreset(p)}
            style={{ padding: "6px 10px", fontSize: "0.85rem" }}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          marginBottom: 12,
        }}
      >
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: "0.85rem" }}>Prefix (regular weight)</span>
          <input
            type="text"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)" }}
          />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={{ fontSize: "0.85rem" }}>Accent (italic, heavier)</span>
          <input
            type="text"
            value={accent}
            onChange={(e) => setAccent(e.target.value)}
            style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)" }}
          />
        </label>
      </div>

      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          marginBottom: 16,
        }}
      >
        {[
          { label: "Gradient start", value: c1, set: setC1 },
          { label: "Gradient middle", value: c2, set: setC2 },
          { label: "Gradient end", value: c3, set: setC3 },
          { label: "EKG / pulse", value: ekg, set: setEkg },
        ].map((f) => (
          <label key={f.label} style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: "0.85rem" }}>{f.label}</span>
            <input
              type="color"
              value={f.value}
              onChange={(e) => f.set(e.target.value)}
              style={{ width: 64, height: 36, border: "none", padding: 0, background: "none" }}
            />
          </label>
        ))}
      </div>

      <div style={{ display: "grid", gap: 12, marginBottom: 16 }}>
        <div
          style={{
            background: "white",
            borderRadius: 8,
            padding: 24,
            display: "flex",
            justifyContent: "center",
            border: "1px solid var(--border)",
          }}
          dangerouslySetInnerHTML={{ __html: animatedSvg }}
        />
        <div
          style={{
            background: "var(--bg-subtle, #0f172a)",
            borderRadius: 8,
            padding: 24,
            display: "flex",
            gap: 24,
            justifyContent: "center",
            alignItems: "center",
            border: "1px solid var(--border)",
          }}
        >
          <div
            style={{ width: 120, height: 120 }}
            dangerouslySetInnerHTML={{ __html: faviconSvg }}
          />
          <div style={{ color: "var(--text-subtle)", fontSize: "0.85rem" }}>
            180 × 180 app icon preview (gradient rounded-square, italic
            monogram, soft EKG underline).
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn primary"
          onClick={() => downloadText(`${slug}-animated.svg`, animatedSvg)}
        >
          Download animated SVG
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => downloadText(`${slug}-static.svg`, staticSvg)}
        >
          Download static SVG
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            void downloadPng(`${slug}.png`, staticSvg, 4);
          }}
        >
          Download PNG (4×)
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => downloadText(`${slug}-favicon.svg`, faviconSvg)}
        >
          Download favicon SVG
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            void downloadPng(`${slug}-favicon.png`, faviconSvg, 3);
          }}
        >
          Download favicon PNG (512×512)
        </button>
      </div>

      <details style={{ marginTop: 16 }}>
        <summary style={{ cursor: "pointer", color: "var(--text-subtle)" }}>
          How to use these in another app
        </summary>
        <pre
          style={{
            background: "var(--bg-subtle, #0f172a)",
            padding: 12,
            borderRadius: 6,
            fontSize: "0.8rem",
            overflowX: "auto",
            marginTop: 8,
          }}
        >{`1. Drop the SVG into your new app's public/ or src/assets/ folder.

2. Use it like any image:
   <img src="/${slug}-animated.svg" alt="${prefix}${accent}" height="40" />

   The animation runs without external CSS or fonts.

3. For the favicon, replace your app's existing favicon.svg:
   <link rel="icon" type="image/svg+xml" href="/${slug}-favicon.svg" />

4. For the iOS / PWA app icon use the 512×512 PNG.`}</pre>
      </details>
    </div>
  );
}
