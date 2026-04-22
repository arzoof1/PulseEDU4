// Tiny helper to require a resolved school for a request. Most routes call
// this at the top of each handler so the type narrows from `number | null`
// to `number` and a 401 is written if the request is unauthenticated.
import type { Request, Response } from "express";

export function requireSchool(req: Request, res: Response): number | null {
  const sid = req.schoolId;
  if (!sid) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  return sid;
}
