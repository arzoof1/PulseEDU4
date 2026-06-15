import { useCallback, useEffect, useRef, useState } from "react";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { PDFDocument } from "pdf-lib";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// =============================================================================
// Public document signing page (/sign/<token>). Unauthenticated — the share
// token in the URL is the sole authorization. A recipient opens this on their
// phone, sees the document (page 1 of a PDF, or the image), draws a signature,
// types their name, and submits. We composite the signature onto the original
// client-side (pdf-lib for PDFs, canvas for images), upload it, and flip the
// document to "signed".
//
// Interaction model for phones:
//   - "Move" mode: pinch-zoom / pan the document (react-zoom-pan-pinch).
//   - "Sign" mode: panning is locked; pointer events draw on a transparent
//     canvas overlaid exactly on the document. Coordinates are normalized via
//     getBoundingClientRect so drawing stays accurate at any zoom level.
// =============================================================================

type DocMeta = {
  title: string;
  fileType: "pdf" | "image";
  status: "pending" | "signed";
  fileUrl: string;
};

type Phase =
  | "loading"
  | "ready"
  | "signed-already"
  | "invalid"
  | "render-error"
  | "done";

function tokenFromPath(): string {
  // /sign/<token>
  const parts = window.location.pathname.split("/").filter(Boolean);
  const idx = parts.indexOf("sign");
  return idx >= 0 && parts[idx + 1] ? decodeURIComponent(parts[idx + 1]) : "";
}

export default function SignApp() {
  const token = tokenFromPath();
  const [phase, setPhase] = useState<Phase>("loading");
  const [meta, setMeta] = useState<DocMeta | null>(null);
  const [mode, setMode] = useState<"move" | "sign">("sign");
  const [signerName, setSignerName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasDrawn, setHasDrawn] = useState(false);

  // The rendered document raster (page 1 / image) lives here.
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // The transparent signature overlay (matches base canvas pixel dims).
  const sigCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Pixel dimensions of the document raster.
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  // Kept for PDF compositing: the original PDF bytes.
  const pdfBytesRef = useRef<ArrayBuffer | null>(null);
  // Guards the render effect so the document is rasterized exactly once.
  const renderedRef = useRef(false);

  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);

  // ---- load + render -------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setPhase("invalid");
      return;
    }
    (async () => {
      try {
        const res = await fetch(
          `/api/esign/sign/${encodeURIComponent(token)}`,
        );
        if (res.status === 404) {
          if (!cancelled) setPhase("invalid");
          return;
        }
        if (!res.ok) throw new Error("load failed");
        const m = (await res.json()) as DocMeta;
        if (cancelled) return;
        setMeta(m);
        // Flip to the document UI first so the base/signature <canvas>
        // elements actually mount. renderDocument writes to those refs and
        // they don't exist on the loading screen — rasterizing happens in
        // the render effect below, once the refs are in the DOM.
        setPhase(m.status === "pending" ? "ready" : "signed-already");
      } catch {
        if (!cancelled) setPhase("invalid");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Rasterize the document only after the canvases are mounted (phase
  // "ready"). Running this inside the fetch effect crashed with a null canvas
  // ref and surfaced as a misleading "Link not valid" message.
  useEffect(() => {
    if (phase !== "ready" || !meta || renderedRef.current) return;
    renderedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        await renderDocument(meta);
      } catch (err) {
        console.error("[sign] render failed", err);
        if (!cancelled) {
          renderedRef.current = false;
          setPhase("render-error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, meta]);

  async function renderDocument(m: DocMeta) {
    const fileRes = await fetch(m.fileUrl);
    if (!fileRes.ok) throw new Error("file load failed");

    if (m.fileType === "pdf") {
      const bytes = await fileRes.arrayBuffer();
      pdfBytesRef.current = bytes.slice(0);
      const pdf = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
      const page = await pdf.getPage(1);
      // Render at a width that gives crisp text on phones without being huge.
      const baseViewport = page.getViewport({ scale: 1 });
      const targetW = Math.min(1400, Math.max(900, baseViewport.width * 2));
      const scale = targetW / baseViewport.width;
      const viewport = page.getViewport({ scale });
      const canvas = baseCanvasRef.current!;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d")!;
      await page.render({ canvasContext: ctx, viewport }).promise;
      prepareSignatureCanvas(canvas.width, canvas.height);
    } else {
      const blob = await fileRes.blob();
      const url = URL.createObjectURL(blob);
      try {
        const img = await loadImage(url);
        const canvas = baseCanvasRef.current!;
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        prepareSignatureCanvas(canvas.width, canvas.height);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  }

  function prepareSignatureCanvas(w: number, h: number) {
    setDims({ w, h });
    // Defer until the overlay canvas is in the DOM with the right size.
    requestAnimationFrame(() => {
      const sig = sigCanvasRef.current;
      if (!sig) return;
      sig.width = w;
      sig.height = h;
      const ctx = sig.getContext("2d")!;
      ctx.lineWidth = Math.max(2, Math.round(w / 320));
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#0b1b3a";
    });
  }

  // ---- drawing -------------------------------------------------------------
  function pointFromEvent(e: React.PointerEvent<HTMLCanvasElement>) {
    const sig = sigCanvasRef.current!;
    const rect = sig.getBoundingClientRect();
    // Normalize against the on-screen (possibly zoomed) rect, then scale to the
    // canvas's internal pixel resolution. Works at any zoom/pan.
    const x = ((e.clientX - rect.left) / rect.width) * sig.width;
    const y = ((e.clientY - rect.top) / rect.height) * sig.height;
    return { x, y };
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (mode !== "sign") return;
    e.preventDefault();
    sigCanvasRef.current?.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = pointFromEvent(e);
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (mode !== "sign" || !drawing.current) return;
    e.preventDefault();
    const ctx = sigCanvasRef.current!.getContext("2d")!;
    const p = pointFromEvent(e);
    const l = last.current ?? p;
    ctx.beginPath();
    ctx.moveTo(l.x, l.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    if (!hasDrawn) setHasDrawn(true);
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    if (mode !== "sign") return;
    drawing.current = false;
    last.current = null;
    try {
      sigCanvasRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  function clearSignature() {
    const sig = sigCanvasRef.current;
    if (!sig) return;
    sig.getContext("2d")!.clearRect(0, 0, sig.width, sig.height);
    setHasDrawn(false);
  }

  // ---- submit --------------------------------------------------------------
  async function handleSubmit() {
    setError(null);
    if (!signerName.trim()) {
      setError("Please type your full name.");
      return;
    }
    if (!hasDrawn) {
      setError("Please draw your signature.");
      return;
    }
    if (!meta) return;
    setSubmitting(true);
    try {
      const blob = await composite(meta);

      // 1. Ask for a token-gated upload URL.
      const urlRes = await fetch(
        `/api/esign/sign/${encodeURIComponent(token)}/upload-url`,
        { method: "POST" },
      );
      if (urlRes.status === 409) {
        setPhase("signed-already");
        return;
      }
      if (!urlRes.ok) throw new Error("Could not prepare the upload.");
      const { uploadURL, objectPath } = (await urlRes.json()) as {
        uploadURL: string;
        objectPath: string;
      };

      // 2. PUT the signed file.
      const contentType =
        meta.fileType === "pdf" ? "application/pdf" : "image/png";
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: blob,
      });
      if (!putRes.ok) throw new Error("Upload failed. Please try again.");

      // 3. Record the signature.
      const signRes = await fetch(
        `/api/esign/sign/${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            signerName: signerName.trim(),
            signedObjectPath: objectPath,
          }),
        },
      );
      if (signRes.status === 409) {
        setPhase("signed-already");
        return;
      }
      if (!signRes.ok) {
        const j = (await signRes.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(j?.error ?? "Could not submit your signature.");
      }
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  // Burn the signature into the document and return a blob.
  async function composite(m: DocMeta): Promise<Blob> {
    const sig = sigCanvasRef.current!;
    if (m.fileType === "pdf") {
      const pdfDoc = await PDFDocument.load(pdfBytesRef.current!);
      const page = pdfDoc.getPage(0);
      const pngBytes = await canvasToPngBytes(sig);
      const png = await pdfDoc.embedPng(pngBytes);
      const { width, height } = page.getSize();
      // The signature canvas overlays the full page 1:1, so stamp it across
      // the whole page — only the strokes are opaque.
      page.drawImage(png, { x: 0, y: 0, width, height });
      const out = await pdfDoc.save();
      return new Blob([out as BlobPart], { type: "application/pdf" });
    }
    // Image: draw base + signature into one canvas, export PNG.
    const base = baseCanvasRef.current!;
    const merged = document.createElement("canvas");
    merged.width = base.width;
    merged.height = base.height;
    const ctx = merged.getContext("2d")!;
    ctx.drawImage(base, 0, 0);
    ctx.drawImage(sig, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      merged.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("export failed"))),
        "image/png",
      ),
    );
  }

  // ---- render --------------------------------------------------------------
  if (phase === "loading") {
    return <Centered>Loading document…</Centered>;
  }
  if (phase === "invalid") {
    return (
      <Centered>
        <h2>Link not valid</h2>
        <p>
          This signing link isn&rsquo;t valid. The link may have been cut off
          when it was copied or sent &mdash; please ask the sender to share it
          again.
        </p>
      </Centered>
    );
  }
  if (phase === "render-error") {
    return (
      <Centered>
        <h2>Couldn&rsquo;t open this document</h2>
        <p>
          The link is valid, but this document couldn&rsquo;t be displayed.
          Please ask the sender to re-upload it and share a new link.
        </p>
      </Centered>
    );
  }
  if (phase === "signed-already") {
    return (
      <Centered>
        <h2>Already signed</h2>
        <p>This document has already been signed. Thank you.</p>
      </Centered>
    );
  }
  if (phase === "done") {
    return (
      <Centered>
        <h2>✓ Signed</h2>
        <p>
          Thank you. Your signature for <strong>{meta?.title}</strong> has been
          submitted.
        </p>
      </Centered>
    );
  }

  return (
    <div
      style={{
        height: "100dvh",
        display: "flex",
        flexDirection: "column",
        background: "#f4f5f8",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <header
        style={{
          padding: "12px 16px",
          background: "#0b1b3a",
          color: "#fff",
          flexShrink: 0,
        }}
      >
        <div style={{ fontWeight: 700 }}>{meta?.title}</div>
        <div style={{ fontSize: 13, opacity: 0.85 }}>
          {mode === "sign"
            ? "Draw your signature on the document below."
            : "Pinch to zoom · drag to move. Switch to Sign when ready."}
        </div>
      </header>

      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "10px 16px",
          alignItems: "center",
          flexWrap: "wrap",
          background: "#fff",
          borderBottom: "1px solid #e2e3ea",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", borderRadius: 8, overflow: "hidden" }}>
          <button
            onClick={() => setMode("move")}
            style={toggleBtn(mode === "move")}
          >
            Move
          </button>
          <button
            onClick={() => setMode("sign")}
            style={toggleBtn(mode === "sign")}
          >
            Sign
          </button>
        </div>
        <button onClick={clearSignature} style={plainBtn}>
          Clear
        </button>
        <span style={{ fontSize: 12, color: "#667" }}>
          {mode === "sign" ? "Drawing enabled" : "Move/zoom enabled"}
        </span>
      </div>

      <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
        <TransformWrapper
          disabled={mode === "sign"}
          minScale={1}
          maxScale={6}
          doubleClick={{ disabled: true }}
          panning={{ velocityDisabled: true }}
        >
          <TransformComponent
            wrapperStyle={{ width: "100%", height: "100%" }}
            contentStyle={{
              width: "100%",
              display: "flex",
              justifyContent: "center",
              padding: 12,
            }}
          >
            <div
              style={{
                position: "relative",
                width: "100%",
                maxWidth: 800,
                aspectRatio: dims ? `${dims.w} / ${dims.h}` : undefined,
                boxShadow: "0 2px 12px rgba(0,0,0,0.15)",
                background: "#fff",
              }}
            >
              <canvas
                ref={baseCanvasRef}
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                }}
              />
              <canvas
                ref={sigCanvasRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  touchAction: mode === "sign" ? "none" : "auto",
                  cursor: mode === "sign" ? "crosshair" : "grab",
                }}
              />
            </div>
          </TransformComponent>
        </TransformWrapper>
      </div>

      <footer
        style={{
          padding: "12px 16px",
          background: "#fff",
          borderTop: "1px solid #e2e3ea",
          display: "grid",
          gap: 10,
          flexShrink: 0,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: "#1f2a44" }}>
          Last step — type your full name, then submit to send it back.
        </div>
        <input
          type="text"
          value={signerName}
          onChange={(e) => setSignerName(e.target.value)}
          placeholder="Type your full name"
          maxLength={120}
          style={{
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid #cfd2dc",
            fontSize: 16,
          }}
        />
        {error && <div style={{ color: "#b42318", fontSize: 14 }}>{error}</div>}
        <button
          onClick={handleSubmit}
          disabled={submitting}
          style={{
            padding: "14px 16px",
            borderRadius: 10,
            border: "none",
            background: "#4f46e5",
            color: "#fff",
            fontWeight: 700,
            fontSize: 16,
            cursor: "pointer",
          }}
        >
          {submitting ? "Submitting…" : "Submit signature"}
        </button>
      </footer>
    </div>
  );
}

function toggleBtn(active: boolean): React.CSSProperties {
  return {
    padding: "8px 18px",
    border: "1px solid #4f46e5",
    background: active ? "#4f46e5" : "#fff",
    color: active ? "#fff" : "#4f46e5",
    fontWeight: 600,
    cursor: "pointer",
  };
}

const plainBtn: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 8,
  border: "1px solid #cfd2dc",
  background: "#fff",
  cursor: "pointer",
};

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: 24,
        fontFamily: "system-ui, sans-serif",
        color: "#1f2a44",
        gap: 6,
      }}
    >
      {children}
    </div>
  );
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/png",
    ),
  );
  return new Uint8Array(await blob.arrayBuffer());
}
