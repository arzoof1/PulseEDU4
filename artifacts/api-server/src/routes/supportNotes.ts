import { Router, type IRouter } from "express";
import {
  supportNotes,
  getNextSupportNoteId,
  type SupportNote,
} from "../data/supportNotes";

const router: IRouter = Router();

router.get("/support-notes", (req, res) => {
  const { studentId } = req.query;
  if (typeof studentId === "string" && studentId) {
    res.json(supportNotes.filter((n) => n.studentId === studentId));
    return;
  }
  res.json(supportNotes);
});

router.post("/support-notes", (req, res) => {
  const { studentId, noteType, noteText, staffName } = req.body ?? {};

  if (typeof studentId !== "string" || !studentId) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  if (typeof noteType !== "string" || !noteType) {
    res.status(400).json({ error: "noteType is required" });
    return;
  }
  if (typeof noteText !== "string" || !noteText) {
    res.status(400).json({ error: "noteText is required" });
    return;
  }

  const note: SupportNote = {
    id: getNextSupportNoteId(),
    studentId,
    noteType,
    noteText,
    staffName: typeof staffName === "string" ? staffName : "",
    createdAt: new Date().toISOString(),
  };

  supportNotes.push(note);
  res.status(201).json(note);
});

export default router;
