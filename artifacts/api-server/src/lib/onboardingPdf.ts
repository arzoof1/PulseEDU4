// Printable onboarding checklist. One page per phase, each step rendered as
// a checkbox row with the "how this works" copy underneath. Uses pdfkit
// (already a runtime dep via parentSnapshotPdf) so we don't pull in a new
// renderer.

import PDFDocument from "pdfkit";
import {
  ONBOARDING_PHASES,
  ONBOARDING_STEPS,
  type AutoStatus,
} from "./onboardingSteps.js";

interface RenderedStep {
  key: string;
  manualChecked: boolean;
  autoStatus: AutoStatus;
}

interface RenderOpts {
  schoolName?: string;
  generatedAt: Date;
  steps: RenderedStep[];
  totalCount: number;
  completeCount: number;
}

const COLORS = {
  text: "#0f172a",
  muted: "#64748b",
  border: "#e2e8f0",
  accent: "#0e7490",
  brand: "#7c3aed",
  ok: "#16a34a",
  warn: "#b45309",
};

function checkboxGlyph(complete: boolean): string {
  return complete ? "[x]" : "[ ]";
}

export function renderOnboardingPdf(opts: RenderOpts): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: { top: 56, bottom: 56, left: 56, right: 56 },
      info: {
        Title: `PulseEDU Onboarding Checklist — ${opts.schoolName ?? "School"}`,
        Author: "PulseEDU",
        Subject: "School onboarding checklist",
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (b: Buffer) => chunks.push(b));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      drawDocument(doc, opts);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawDocument(doc: PDFKit.PDFDocument, opts: RenderOpts) {
  const stateByKey = new Map<string, RenderedStep>();
  for (const s of opts.steps) stateByKey.set(s.key, s);

  // ---- Header ----
  doc
    .fillColor(COLORS.brand)
    .fontSize(22)
    .font("Helvetica-Bold")
    .text("PulseEDU Onboarding Checklist");
  doc
    .moveDown(0.2)
    .fillColor(COLORS.muted)
    .fontSize(11)
    .font("Helvetica")
    .text(
      `${opts.schoolName ?? "Your school"} · Generated ${opts.generatedAt.toLocaleDateString(
        "en-US",
        { year: "numeric", month: "short", day: "numeric" },
      )} · ${opts.completeCount} of ${opts.totalCount} steps complete`,
    );

  doc
    .moveDown(0.6)
    .fillColor(COLORS.text)
    .fontSize(10)
    .text(
      "Use this sheet to track your school's setup. A step counts as complete when its data has been entered in the app or when an admin manually ticks the box. Re-print this page any time from Settings → Onboarding → Download PDF.",
      { width: 500 },
    );

  doc.moveDown(0.8);

  // ---- Phases ----
  for (const phase of ONBOARDING_PHASES) {
    drawPhaseHeader(doc, phase);
    const stepsInPhase = ONBOARDING_STEPS.filter((s) => s.phase === phase);
    for (const step of stepsInPhase) {
      const state = stateByKey.get(step.key);
      const complete =
        state?.manualChecked === true || state?.autoStatus === "complete";
      drawStep(doc, step.label, step.hint, complete, state?.autoStatus ?? "empty");
    }
    doc.moveDown(0.4);
  }

  // ---- Footer ----
  doc
    .moveDown(0.8)
    .fillColor(COLORS.muted)
    .fontSize(9)
    .text("PulseEDU · Onboarding Checklist · pulse.edu", { align: "center" });
}

function drawPhaseHeader(doc: PDFKit.PDFDocument, phase: string) {
  if (doc.y > 680) doc.addPage();
  doc
    .moveDown(0.4)
    .fillColor(COLORS.accent)
    .fontSize(13)
    .font("Helvetica-Bold")
    .text(phase);
  doc
    .moveTo(56, doc.y + 2)
    .lineTo(556, doc.y + 2)
    .strokeColor(COLORS.border)
    .lineWidth(0.5)
    .stroke();
  doc.moveDown(0.4);
}

function drawStep(
  doc: PDFKit.PDFDocument,
  label: string,
  hint: string,
  complete: boolean,
  autoStatus: AutoStatus,
) {
  // Page-break guard: rough estimate of row height (~70pt with hint).
  if (doc.y > 700) doc.addPage();

  const rowTop = doc.y;
  doc
    .fillColor(complete ? COLORS.ok : COLORS.text)
    .fontSize(11)
    .font("Helvetica-Bold")
    .text(`${checkboxGlyph(complete)}  ${label}`, 56, rowTop, { width: 460 });

  // Status pill (right side).
  const pillX = 460;
  const pillY = rowTop;
  const pillText =
    autoStatus === "complete"
      ? "auto: ready"
      : autoStatus === "partial"
        ? "auto: partial"
        : "auto: needs setup";
  doc
    .fillColor(
      autoStatus === "complete"
        ? COLORS.ok
        : autoStatus === "partial"
          ? COLORS.warn
          : COLORS.muted,
    )
    .fontSize(8)
    .font("Helvetica")
    .text(pillText, pillX, pillY + 2, { width: 96, align: "right" });

  doc
    .fillColor(COLORS.muted)
    .fontSize(9.5)
    .font("Helvetica")
    .text(hint, 76, doc.y + 2, { width: 480 });

  doc.moveDown(0.45);
}
