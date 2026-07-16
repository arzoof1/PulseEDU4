// Shared parent-identity resolution middleware.
//
// Every parent-facing data router (snapshot, snapshot.pdf, store, tickets,
// brain-lab, academic-evidence, heartbeat-prefs) previously carried its own
// inline copy of "read req.session.parentId OR a Bearer parent token, set
// req.parentId". That decentralized pattern had a hole: it never re-checked
// parents.active, so an admin revoking a guardian (parents.active=false via
// POST /api/admin/parents/:id/revoke) did NOT stop the guardian's live read
// traffic — only GET /parent-auth/me destroyed the session, and attacker read
// traffic never calls /me. (Security finding F02.)
//
// This is the single choke point. It resolves the parent id the same way as
// before, then LOADS the parent row and rejects (401 + destroys any session)
// when the account is missing or active===false. Mount it as router-level
// middleware on every parent data router so revocation is enforced on EVERY
// downstream read/write, cookie- or bearer-authenticated alike.
import type { Request, Response, NextFunction } from "express";
import { db, parentsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { verifyParentAuthToken } from "./authToken.js";

// Resolve the parent id from the session cookie OR a Bearer parent token
// (the preview iframe falls back to the token because the session cookie is
// blocked inside it). Returns null when neither yields an id.
export function resolveParentId(req: Request): number | null {
  let pid: number | null = req.session?.parentId ?? null;
  if (!pid) {
    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
      pid = verifyParentAuthToken(auth.slice(7).trim());
    }
  }
  return pid;
}

// Router-level middleware. Populates req.parentId ONLY for an existing, active
// parent. On a revoked/missing account it clears req.parentId, proactively
// destroys the session (so a still-valid cookie stops working immediately),
// and returns 401 — matching the existing "Sign-in required" error shape used
// by the parent routes. Downstream handlers keep their own `if (!pid) 401`
// guard, so an unauthenticated caller (no id at all) still flows through to
// that guard rather than being force-destroyed here.
export async function requireActiveParent(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const pid = resolveParentId(req);
  if (!pid) {
    // No parent identity presented at all — leave req.parentId null and let
    // the route's own guard produce the 401. (Avoids destroying an unrelated
    // staff session that happens to share the browser.)
    req.parentId = null;
    next();
    return;
  }
  const [parent] = await db
    .select({ id: parentsTable.id })
    .from(parentsTable)
    .where(and(eq(parentsTable.id, pid), eq(parentsTable.active, true)));
  if (!parent) {
    // Account is gone or revoked (active=false). Kill the live session so the
    // cookie can't be replayed, drop the resolved id, and fail closed.
    req.parentId = null;
    if (req.session) {
      req.session.destroy(() => {
        res.status(401).json({ error: "Sign-in required" });
      });
    } else {
      res.status(401).json({ error: "Sign-in required" });
    }
    return;
  }
  req.parentId = parent.id;
  next();
}
