import { BarcodeFormat, MultiFormatWriter } from "@zxing/library";

// Render a Code 128 barcode of `text` to a PNG data URL. Used on the kiosk
// activation card (staff app) and the phone "carry over" mirror page so a
// classroom device with a 1D laser/USB scanner can read the code off a
// teacher's phone. QR + the big PIN cover camera kiosks and manual entry;
// this covers laser/USB scanners. Returns "" if encoding fails (UI then
// just omits it).
export function code128DataUrl(text: string): string {
  try {
    const targetW = 360;
    const targetH = 90;
    const matrix = new MultiFormatWriter().encode(
      text,
      BarcodeFormat.CODE_128,
      targetW,
      targetH,
      new Map(),
    );
    const w = matrix.getWidth();
    const h = matrix.getHeight();
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#000000";
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (matrix.get(x, y)) ctx.fillRect(x, y, 1, 1);
      }
    }
    return canvas.toDataURL("image/png");
  } catch {
    return "";
  }
}
