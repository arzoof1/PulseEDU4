import { Router, type IRouter } from "express";
import { db, schoolsTable, studentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { verifyParentAuthToken } from "../lib/authToken.js";
import { buildParentSnapshot } from "../lib/parentSnapshot.js";
import { renderSnapshotPdf } from "../lib/parentSnapshotPdf.js";

const router: IRouter = Router();

// Same parent-id resolution pattern as the JSON snapshot.
router.use(async (req, _res, next) => {
  let pid: number | null = req.session.parentId ?? null;
  if (!pid) {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      pid = verifyParentAuthToken(auth.slice(7).trim());
    }
  }
  req.parentId = pid;
  next();
});

function parsePositiveInt(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw) : (raw as number);
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

router.get("/parent/snapshot.pdf", async (req, res) => {
  const pid = req.parentId;
  if (!pid) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const studentId = parsePositiveInt(req.query.studentId);
  if (studentId === null) {
    res.status(400).json({ error: "studentId must be a positive integer" });
    return;
  }
  const result = await buildParentSnapshot(pid, studentId);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  // School name for the header strip — best-effort, ok if missing.
  let schoolName: string | undefined;
  try {
    const [row] = await db
      .select({ name: schoolsTable.name })
      .from(schoolsTable)
      .innerJoin(studentsTable, eq(studentsTable.schoolId, schoolsTable.id))
      .where(eq(studentsTable.id, result.data.student.id));
    schoolName = row?.name ?? undefined;
  } catch {
    schoolName = undefined;
  }

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await renderSnapshotPdf(result.data, { schoolName });
  } catch (err) {
    console.error("renderSnapshotPdf failed", err);
    res.status(500).json({ error: "Could not generate PDF" });
    return;
  }

  const safeName =
    `${result.data.student.firstName}-${result.data.student.lastName}`
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .slice(0, 80) || "snapshot";
  const filename = `HeartBEAT-${safeName}.pdf`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", pdfBuffer.length.toString());
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"`,
  );
  // Don't let the browser cache a per-parent confidential document.
  res.setHeader("Cache-Control", "private, no-store");
  res.status(200).end(pdfBuffer);
});

export default router;
