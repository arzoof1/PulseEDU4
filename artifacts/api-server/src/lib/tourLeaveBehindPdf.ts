import PDFDocument from "pdfkit";
import QRCode from "qrcode";

// Post-tour "leave-behind" — a single warm page the family takes home with a
// big QR code that opens the post-tour survey tied to their lead. Generated
// on demand; returns a PDF buffer.

export interface LeaveBehindInput {
  schoolName: string;
  familyName: string;
  // Absolute URL to the survey, e.g. https://host/tour/survey/<token>
  surveyUrl: string;
  contactEmail: string | null;
  contactPhone: string | null;
  accentColor: string;
}

const INK = "#1f2937";
const MUTED = "#6b7280";

function safeAccent(hex: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : "#0ea5a4";
}

export function buildTourLeaveBehindPdf(
  input: LeaveBehindInput,
): Promise<Buffer> {
  const accent = safeAccent(input.accentColor);
  const doc = new PDFDocument({ size: "LETTER", margin: 54 });
  const chunks: Buffer[] = [];
  doc.on("data", (c) => chunks.push(c as Buffer));
  const done = new Promise<Buffer>((resolve) =>
    doc.on("end", () => resolve(Buffer.concat(chunks))),
  );

  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const centerX = doc.page.width / 2;

  // Top accent band
  doc.rect(0, 0, doc.page.width, 130).fill(accent);
  doc
    .fillColor("#ffffff")
    .font("Helvetica")
    .fontSize(13)
    .text("THANK YOU FOR VISITING", left, 44, {
      width,
      align: "center",
      characterSpacing: 2,
    });
  doc
    .fillColor("#ffffff")
    .font("Helvetica-Bold")
    .fontSize(28)
    .text(input.schoolName, left, 70, { width, align: "center" });

  doc.y = 170;
  doc
    .fillColor(INK)
    .font("Helvetica")
    .fontSize(15)
    .text(
      `${input.familyName ? input.familyName + ", we" : "We"} loved having you on campus. We'd be grateful for two minutes of your thoughts — what stood out, and anything you're still wondering about.`,
      left,
      doc.y,
      { width, align: "center" },
    );

  // QR code, centered
  return QRCode.toDataURL(input.surveyUrl, { margin: 1, width: 360 })
    .then((dataUrl) => {
      const qrBuf = Buffer.from(dataUrl.split(",")[1], "base64");
      const qrSize = 200;
      const qrY = doc.y + 24;
      doc.image(qrBuf, centerX - qrSize / 2, qrY, {
        width: qrSize,
        height: qrSize,
      });

      doc.y = qrY + qrSize + 16;
      doc
        .fillColor(accent)
        .font("Helvetica-Bold")
        .fontSize(16)
        .text("Scan to share your thoughts", left, doc.y, {
          width,
          align: "center",
        });
      doc.moveDown(0.4);
      doc
        .fillColor(MUTED)
        .font("Helvetica")
        .fontSize(10)
        .text(input.surveyUrl, left, doc.y, { width, align: "center" });

      // Contact footer
      const contactBits = [
        input.contactPhone ? `Call: ${input.contactPhone}` : null,
        input.contactEmail ? `Email: ${input.contactEmail}` : null,
      ].filter(Boolean) as string[];
      if (contactBits.length) {
        doc.moveDown(1.5);
        doc
          .fillColor(INK)
          .font("Helvetica")
          .fontSize(12)
          .text(contactBits.join("     •     "), left, doc.y, {
            width,
            align: "center",
          });
      }

      doc.end();
      return done;
    });
}
