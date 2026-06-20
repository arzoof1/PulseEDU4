import { PDFDocument } from "pdf-lib";

// Merge several already-rendered PDF buffers into a single document, preserving
// order. Empty/zero-length buffers are skipped so one missing section never
// aborts the whole packet. Returns a fresh Buffer suitable for res.send().
export async function mergePdfs(buffers: Buffer[]): Promise<Buffer> {
  const out = await PDFDocument.create();
  for (const buf of buffers) {
    if (!buf || buf.length === 0) continue;
    const src = await PDFDocument.load(buf);
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
  }
  const bytes = await out.save();
  return Buffer.from(bytes);
}
