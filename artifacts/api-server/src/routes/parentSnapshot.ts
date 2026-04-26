import { Router, type IRouter } from "express";
import { verifyParentAuthToken } from "../lib/authToken.js";
import { buildParentSnapshot } from "../lib/parentSnapshot.js";

const router: IRouter = Router();

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
