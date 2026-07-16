import { Router, type IRouter } from "express";
import { buildParentSnapshot } from "../lib/parentSnapshot.js";
import { requireActiveParent } from "../lib/parentAuthMiddleware.js";

const router: IRouter = Router();

// Resolve req.parentId AND enforce parents.active=true on every request (F02).
router.use(requireActiveParent);

router.get("/parent/snapshot", async (req, res) => {
  const pid = req.parentId;
  if (!pid) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const requestedStudentId = Number(req.query.studentId);
  if (!Number.isFinite(requestedStudentId)) {
    res.status(400).json({ error: "studentId is required" });
    return;
  }
  const result = await buildParentSnapshot(pid, requestedStudentId);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

export default router;
