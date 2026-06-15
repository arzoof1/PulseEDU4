// Standards Book — GLOBAL (not school-scoped) read-only reference of the
// official FLDOE B.E.S.T. standards documents, served as a searchable,
// browsable in-app book. The wording of the standards is identical for every
// tenant (published state reference data), so the dataset is committed and
// served once for all schools.
//
// ELA and Math are both loaded (parsed from the FLDOE standards PDFs) using the
// same pipeline; each subject is a committed dataset served once for all schools.
import { Router, type IRouter } from "express";
import elaStandardsBook from "../data/elaStandardsBook.json" with { type: "json" };
import mathStandardsBook from "../data/mathStandardsBook.json" with { type: "json" };

const router: IRouter = Router();

type StandardsBook = {
  subject: string;
  title: string;
  fileName: string;
  pageCount: number;
  pages: Array<{ page: number; text: string }>;
  benchmarks: Array<{
    code: string;
    grade: string;
    strand: string | null;
    statement: string;
    page: number | null;
  }>;
};

const BOOKS: Record<string, StandardsBook> = {
  ela: elaStandardsBook as StandardsBook,
  math: mathStandardsBook as StandardsBook,
};

// GET /api/standards-book?subject=ela — full book payload (pages + benchmark
// index) for the client to search/browse in-memory. Cached aggressively on the
// client; the body is large but static reference data.
router.get("/standards-book", (req, res) => {
  const subject = String(req.query.subject ?? "ela").toLowerCase();
  const book = BOOKS[subject];
  if (!book) {
    res.status(404).json({ error: `No standards book for subject "${subject}"` });
    return;
  }
  res.json(book);
});

// GET /api/standards-book/subjects — which subjects have a loaded book.
router.get("/standards-book/subjects", (_req, res) => {
  res.json({
    subjects: Object.values(BOOKS).map((b) => ({
      subject: b.subject,
      title: b.title,
      pageCount: b.pageCount,
      benchmarkCount: b.benchmarks.length,
    })),
  });
});

export default router;
