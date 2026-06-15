import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { PDFiumLibrary } from "@hyzyla/pdfium";
import jsQR from "jsqr";
import {
  MultiFormatReader,
  BarcodeFormat,
  DecodeHintType,
  RGBLuminanceSource,
  BinaryBitmap,
  HybridBinarizer,
} from "@zxing/library";

// Server-side QR decode for scanned worksheet PDFs.
//
// The copier-batch intake path uploads ONE multi-page PDF (the whole stack
// scanned at the office MFP). There is no live camera here, so the server must
// rasterize each page and read its QR itself:
//   PDF bytes -> pdfium rasterize page -> RGBA bitmap -> decode.
//
// Decode reliability: the worksheet QR is rendered with a real quiet zone (see
// pulseBrainLabWorksheetPdf.ts) so the finder patterns are locatable. We
// rasterize at RENDER_SCALE (3x) so the printed QR survives copier
// compression/skew, then try two decoders in order:
//   1. jsQR (fast, good on clean renders)
//   2. ZXing MultiFormatReader with TRY_HARDER (slower, far more tolerant of
//      skew/low-contrast real-world MFP scans)
// Only if BOTH fail does the page return a null token and the caller parks it in
// the Unmatched tray for manual assignment.

const RENDER_SCALE = 3;

// pdfium is externalized from the esbuild bundle and loads a sibling .wasm via
// path traversal, which breaks once bundled. Resolve + read the wasm ourselves
// and hand pdfium the bytes so it never has to locate the file at runtime.
let wasmBinary: ArrayBuffer | null = null;
function loadWasmBinary(): ArrayBuffer {
  if (wasmBinary) return wasmBinary;
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve("@hyzyla/pdfium/pdfium.wasm");
  const buf = readFileSync(wasmPath);
  wasmBinary = buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
  return wasmBinary;
}

// One library instance is reused across requests (init is expensive). pdfium is
// single-threaded WASM; we serialize decode jobs behind a promise chain so two
// concurrent batch uploads can't corrupt the shared module heap.
let libPromise: Promise<PDFiumLibrary> | null = null;
function getLibrary(): Promise<PDFiumLibrary> {
  if (!libPromise) {
    libPromise = PDFiumLibrary.init({ wasmBinary: loadWasmBinary() });
  }
  return libPromise;
}

let decodeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(job: () => Promise<T>): Promise<T> {
  const run = decodeChain.then(job, job);
  // Keep the chain alive regardless of individual job outcome.
  decodeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export type DecodedPage = {
  pageIndex: number;
  // The decoded QR payload, or null when the page had no readable QR.
  token: string | null;
};

// ZXing fallback: build a luminance source from the RGBA bitmap and decode with
// TRY_HARDER. ZXing's finder is more tolerant of skew/low contrast than jsQR, so
// this catches real MFP scans jsQR misses. Returns null (never throws) on miss.
function decodeWithZxing(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): string | null {
  try {
    const luminances = new Uint8ClampedArray(width * height);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
      luminances[j] =
        (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114) | 0;
    }
    const source = new RGBLuminanceSource(luminances, width, height);
    const bitmap = new BinaryBitmap(new HybridBinarizer(source));
    const reader = new MultiFormatReader();
    const hints = new Map<DecodeHintType, unknown>();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
    hints.set(DecodeHintType.TRY_HARDER, true);
    reader.setHints(hints);
    return reader.decode(bitmap, hints).getText();
  } catch {
    // NotFoundException (and any other decode error) => unreadable page.
    return null;
  }
}

// Rasterize + QR-decode every page of a PDF. Returns one entry per page in
// page order. `token` is null for pages whose QR could not be read.
export async function decodeWorksheetPdf(
  pdfBytes: Buffer,
): Promise<DecodedPage[]> {
  return serialize(async () => {
    const lib = await getLibrary();
    const doc = await lib.loadDocument(new Uint8Array(pdfBytes));
    try {
      const pageCount = doc.getPageCount();
      const out: DecodedPage[] = [];
      for (let i = 0; i < pageCount; i++) {
        const page = doc.getPage(i);
        // colorSpace defaults to BGRA rendered with REVERSE_BYTE_ORDER, so the
        // raw `data` is already RGBA — exactly what jsQR expects.
        const { data, width, height } = await page.render({
          scale: RENDER_SCALE,
        });
        const rgba = new Uint8ClampedArray(
          data.buffer,
          data.byteOffset,
          data.byteLength,
        );
        const token =
          jsQR(rgba, width, height)?.data ??
          decodeWithZxing(rgba, width, height);
        out.push({ pageIndex: i, token: token ?? null });
      }
      return out;
    } finally {
      doc.destroy();
    }
  });
}
