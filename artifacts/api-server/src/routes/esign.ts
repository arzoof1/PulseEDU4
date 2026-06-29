import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  staffTable,
  esignDocumentsTable,
  interactionAuditLogTable,
} from "@workspace/db";
import { and, eq, sql, desc } from "drizzle-orm";
import { canManageEsign } from "../lib/coreTeam.js";
import { genUrlSafeToken } from "../lib/urlSafeToken.js";
import {
  bindObjectToSchool,
  issueSchoolUploadUrl,
  streamObjectToResponse,
} from "./storage.js";
import { getUncachableResendClient } from "../lib/resendClient.js";
import { isParentNotifyEnabled } from "../lib/parentNotify.js";

const router: IRouter = Router();

// =============================================================================
// Document e-Signing — server routes.
//
// A staff member with `canManageEsign` uploads a PDF or image (via the shared
// object-storage presigned-upload flow), then shares an unguessable link. An
// outside recipient (parent, new-hire) opens the link on a phone, draws a
// signature on page 1, and submits — the signed file is composited client-side
// and uploaded back, flipping the document to `signed`.
//
// Auth model:
//   - Staff surface (list / stats / create / get / delete) is gated by
//     canManageEsign AND scoped to the CREATOR: every query filters
//     (schoolId, createdBy = req.staffId). Two office staff never see each
//     other's documents. Admin "see all" is intentionally out of scope.
//   - The recipient surface (`/esign/sign/:token` family) is PUBLIC, authorized
//     solely by the unguessable share token. The recipient has no session.
//
// Documents have no student/entity tie by design (permission slips, hiring
// paperwork, etc. all stand alone). Every create / sign / delete is audited.
// =============================================================================

type StaffRow = typeof staffTable.$inferSelect;

const FILE_TYPES = new Set(["pdf", "image"]);
const MAX_TITLE_LEN = 200;
const MAX_NAME_LEN = 120;
const MAX_EMAIL_LEN = 254;

// Unguessable share token: 32 chars of base62 (~190 bits) — not derived from
// any id, so a leaked token reveals nothing and cannot be guessed or forged.
// base62 (not base64url) so it survives email/chat linkifiers intact; see
// lib/urlSafeToken for the full rationale.
function genShareToken(): string {
  return genUrlSafeToken(32); // ~190 bits, linkifier-safe (see lib/urlSafeToken)
}

// Public-facing origin for the signing link (recipients open it OUTSIDE the
// workspace). Resolution order mirrors tours.ts / ticketing.ts:
// PUBLIC_APP_URL -> first REPLIT_DOMAINS host -> forwarded request host ->
// localhost. Never trust REPLIT_DEV_DOMAIN first (unset in prod).
function publicAppOrigin(req?: Request): string {
  const explicit = process.env.PUBLIC_APP_URL;
  if (explicit && explicit.length > 0) return explicit.replace(/\/+$/, "");
  const replitDomains = (process.env.REPLIT_DOMAINS ?? "").trim();
  if (replitDomains) {
    const first = replitDomains.split(",")[0]?.trim();
    if (first) return `https://${first}`;
  }
  if (req) {
    const rawProto = (req.headers["x-forwarded-proto"] as string | undefined)
      ?.split(",")[0]
      ?.trim()
      .toLowerCase();
    const proto =
      rawProto === "http" || rawProto === "https" ? rawProto : "https";
    const rawHost = (req.headers["x-forwarded-host"] ?? req.headers.host) as
      | string
      | undefined;
    const host = rawHost?.split(",")[0]?.trim();
    if (host) return `${proto}://${host}`;
  }
  const replit = process.env.REPLIT_DEV_DOMAIN;
  if (replit && replit.length > 0) return `https://${replit}`;
  return "http://localhost:5000";
}

function signUrlForToken(req: Request, token: string): string {
  return `${publicAppOrigin(req)}/sign/${encodeURIComponent(token)}`;
}

// Reject anything that isn't a `/objects/<...>` path with no traversal. The
// object actually has to have been issued to this school too — that is enforced
// downstream by bindObjectToSchool — but we cheaply reject obvious garbage here.
function isSafeObjectPath(p: unknown): p is string {
  return (
    typeof p === "string" &&
    p.startsWith("/objects/") &&
    !p.includes("..") &&
    p.length < 512
  );
}

function isValidEmail(s: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) && s.length <= MAX_EMAIL_LEN;
}

async function audit(opts: {
  schoolId: number;
  entityId: number;
  action: string;
  staff: { id: number; displayName: string };
  payload?: Record<string, unknown> | null;
}): Promise<void> {
  await db.insert(interactionAuditLogTable).values({
    schoolId: opts.schoolId,
    entityType: "esign_document",
    entityId: opts.entityId,
    action: opts.action,
    actorStaffId: opts.staff.id,
    actorName: opts.staff.displayName,
    payload: opts.payload ?? null,
  });
}

// ---- staff middleware ------------------------------------------------------

async function requireStaff(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Staff not found or inactive" });
    return;
  }
  (req as Request & { staff: StaffRow }).staff = staff;
  next();
}

function staffOf(req: Request): StaffRow {
  return (req as Request & { staff: StaffRow }).staff;
}

function requireEsignManager(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const staff = staffOf(req);
  if (!canManageEsign(staff)) {
    res.status(403).json({ error: "Not authorized to manage e-signatures" });
    return;
  }
  next();
}

// Shape returned to the staff UI. Never leak the raw object paths; the client
// fetches bytes via /api/storage/objects/* (auth-gated) using these.
function publicDoc(row: typeof esignDocumentsTable.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    fileType: row.fileType,
    status: row.status,
    recipientEmail: row.recipientEmail,
    signerName: row.signerName,
    shareToken: row.shareToken,
    objectPath: row.objectPath,
    signedObjectPath: row.signedObjectPath,
    createdAt: row.createdAt,
    signedAt: row.signedAt,
  };
}

// ---- staff endpoints -------------------------------------------------------

// GET /api/esign/documents — the caller's own documents, newest first.
router.get(
  "/esign/documents",
  requireStaff,
  requireEsignManager,
  async (req, res) => {
    const staff = staffOf(req);
    const rows = await db
      .select()
      .from(esignDocumentsTable)
      .where(
        and(
          eq(esignDocumentsTable.schoolId, staff.schoolId),
          eq(esignDocumentsTable.createdBy, staff.id),
        ),
      )
      .orderBy(desc(esignDocumentsTable.createdAt));
    res.json({ documents: rows.map(publicDoc) });
  },
);

// GET /api/esign/documents/stats — small counts for the manager header.
router.get(
  "/esign/documents/stats",
  requireStaff,
  requireEsignManager,
  async (req, res) => {
    const staff = staffOf(req);
    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        pending: sql<number>`count(*) filter (where ${esignDocumentsTable.status} = 'pending')::int`,
        signed: sql<number>`count(*) filter (where ${esignDocumentsTable.status} = 'signed')::int`,
      })
      .from(esignDocumentsTable)
      .where(
        and(
          eq(esignDocumentsTable.schoolId, staff.schoolId),
          eq(esignDocumentsTable.createdBy, staff.id),
        ),
      );
    res.json({
      total: row?.total ?? 0,
      pending: row?.pending ?? 0,
      signed: row?.signed ?? 0,
    });
  },
);

// POST /api/esign/documents
//   body: { title, fileType, objectPath, recipientEmail? }
// The client has already uploaded the original via /api/storage presigned flow;
// objectPath is the resulting "/objects/<id>" path. We bind it to the school
// (proving the upload was issued to this school) then persist the row. If
// recipientEmail is supplied, we email the signing link.
router.post(
  "/esign/documents",
  requireStaff,
  requireEsignManager,
  async (req, res) => {
    const staff = staffOf(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > MAX_TITLE_LEN) {
      res.status(400).json({ error: "A document title is required" });
      return;
    }
    const fileType = typeof body.fileType === "string" ? body.fileType : "";
    if (!FILE_TYPES.has(fileType)) {
      res.status(400).json({ error: "fileType must be 'pdf' or 'image'" });
      return;
    }
    if (!isSafeObjectPath(body.objectPath)) {
      res.status(400).json({ error: "A valid uploaded file is required" });
      return;
    }
    const objectPath = body.objectPath;

    let recipientEmail: string | null = null;
    if (body.recipientEmail != null && body.recipientEmail !== "") {
      const raw = String(body.recipientEmail).trim().toLowerCase();
      if (!isValidEmail(raw)) {
        res.status(400).json({ error: "Recipient email is not valid" });
        return;
      }
      recipientEmail = raw;
    }

    // Prove the upload belongs to this school before we store a row pointing
    // at it (mirrors the classroom-store / branding save paths).
    const bound = await bindObjectToSchool(objectPath, staff.schoolId);
    if (!bound) {
      res
        .status(403)
        .json({ error: "Uploaded file could not be verified. Re-upload." });
      return;
    }

    const shareToken = genShareToken();
    const [row] = await db
      .insert(esignDocumentsTable)
      .values({
        schoolId: staff.schoolId,
        createdBy: staff.id,
        title,
        fileType,
        objectPath,
        shareToken,
        status: "pending",
        recipientEmail,
      })
      .returning();

    await audit({
      schoolId: staff.schoolId,
      entityId: row.id,
      action: "created",
      staff,
      payload: { title, fileType, emailed: Boolean(recipientEmail) },
    });

    // Best-effort email. Failure to email never fails the create — the staffer
    // can always copy the link manually.
    let emailSent = false;
    let emailError: string | null = null;
    const esignNotifyOn = await isParentNotifyEnabled(
      staff.schoolId,
      "notifyParentEsign",
    );
    if (recipientEmail && esignNotifyOn) {
      try {
        const { client, fromEmail } = await getUncachableResendClient();
        const link = signUrlForToken(req, shareToken);
        await client.emails.send({
          from: fromEmail,
          to: recipientEmail,
          subject: `Please sign: ${title}`,
          html: `<p>You have a document to review and sign: <strong>${escapeHtml(
            title,
          )}</strong>.</p><p><a href="${link}">Open and sign the document</a></p><p>If the link doesn't work, paste this into your browser:<br>${link}</p>`,
        });
        emailSent = true;
      } catch (err) {
        req.log?.error({ err }, "[esign] failed to send signing email");
        emailError = "Document saved, but the email could not be sent.";
      }
    }

    res.status(201).json({
      document: publicDoc(row),
      emailSent,
      emailError,
    });
  },
);

// GET /api/esign/documents/:id — single document (creator-scoped).
router.get(
  "/esign/documents/:id",
  requireStaff,
  requireEsignManager,
  async (req, res) => {
    const staff = staffOf(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [row] = await db
      .select()
      .from(esignDocumentsTable)
      .where(
        and(
          eq(esignDocumentsTable.id, id),
          eq(esignDocumentsTable.schoolId, staff.schoolId),
          eq(esignDocumentsTable.createdBy, staff.id),
        ),
      );
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ document: publicDoc(row) });
  },
);

// DELETE /api/esign/documents/:id — creator-scoped. We leave the stored
// objects in place (cheap, and avoids a partial-delete failure mode); the row
// is the source of truth for what's visible.
router.delete(
  "/esign/documents/:id",
  requireStaff,
  requireEsignManager,
  async (req, res) => {
    const staff = staffOf(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [row] = await db
      .delete(esignDocumentsTable)
      .where(
        and(
          eq(esignDocumentsTable.id, id),
          eq(esignDocumentsTable.schoolId, staff.schoolId),
          eq(esignDocumentsTable.createdBy, staff.id),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await audit({
      schoolId: staff.schoolId,
      entityId: row.id,
      action: "deleted",
      staff,
      payload: { title: row.title, status: row.status },
    });
    res.json({ ok: true });
  },
);

// ---- public (recipient) endpoints ------------------------------------------
//
// Authorized solely by the share token. No session. We never expose the
// document's school, creator, or any internal ids beyond what the signer needs.

// GET /api/esign/sign/:token — metadata for the signing page.
router.get("/esign/sign/:token", async (req, res) => {
  const token = String(req.params.token ?? "");
  const [row] = await db
    .select()
    .from(esignDocumentsTable)
    .where(eq(esignDocumentsTable.shareToken, token));
  if (!row) {
    res.status(404).json({ error: "This signing link is not valid." });
    return;
  }
  res.json({
    title: row.title,
    fileType: row.fileType,
    status: row.status,
    // The recipient streams the original through the token-gated file route.
    fileUrl: `/api/esign/sign/${encodeURIComponent(token)}/file`,
  });
});

// GET /api/esign/sign/:token/file — stream the ORIGINAL document bytes. Token
// is the authorization; we look the doc up and stream its object path.
router.get("/esign/sign/:token/file", async (req, res) => {
  const token = String(req.params.token ?? "");
  const [row] = await db
    .select()
    .from(esignDocumentsTable)
    .where(eq(esignDocumentsTable.shareToken, token));
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    const ok = await streamObjectToResponse(row.objectPath, res);
    if (!ok) res.status(404).json({ error: "Not found" });
  } catch (err) {
    req.log?.error({ err }, "[esign] failed to stream original");
    if (!res.headersSent) res.status(500).json({ error: "Failed to read file" });
  }
});

// POST /api/esign/sign/:token/upload-url — issue a presigned upload URL for the
// signed composite. Bound to the document's school so the later sign step can
// verify it. Token-gated; refuses if already signed.
router.post("/esign/sign/:token/upload-url", async (req, res) => {
  const token = String(req.params.token ?? "");
  const [row] = await db
    .select()
    .from(esignDocumentsTable)
    .where(eq(esignDocumentsTable.shareToken, token));
  if (!row) {
    res.status(404).json({ error: "This signing link is not valid." });
    return;
  }
  if (row.status !== "pending") {
    res.status(409).json({ error: "This document has already been signed." });
    return;
  }
  try {
    const { uploadURL, objectPath } = await issueSchoolUploadUrl(row.schoolId);
    res.json({ uploadURL, objectPath });
  } catch (err) {
    req.log?.error({ err }, "[esign] failed to issue signer upload url");
    res.status(500).json({ error: "Failed to prepare upload" });
  }
});

// POST /api/esign/sign/:token
//   body: { signerName, signedObjectPath }
// Race-safe: the conditional UPDATE only flips a row that is still pending, so
// two concurrent submits resolve to exactly one winner (the other gets 409).
router.post("/esign/sign/:token", async (req, res) => {
  const token = String(req.params.token ?? "");
  const body = (req.body ?? {}) as Record<string, unknown>;

  const signerName =
    typeof body.signerName === "string" ? body.signerName.trim() : "";
  if (!signerName || signerName.length > MAX_NAME_LEN) {
    res.status(400).json({ error: "Please type your full name." });
    return;
  }
  if (!isSafeObjectPath(body.signedObjectPath)) {
    res.status(400).json({ error: "A signed document is required." });
    return;
  }
  const signedObjectPath = body.signedObjectPath;

  const [row] = await db
    .select()
    .from(esignDocumentsTable)
    .where(eq(esignDocumentsTable.shareToken, token));
  if (!row) {
    res.status(404).json({ error: "This signing link is not valid." });
    return;
  }
  if (row.status !== "pending") {
    res.status(409).json({ error: "This document has already been signed." });
    return;
  }

  // Bind the signed upload to the document's school before we point a row at
  // it — same ownership proof used on the staff create path.
  const bound = await bindObjectToSchool(signedObjectPath, row.schoolId);
  if (!bound) {
    res
      .status(403)
      .json({ error: "The signed file could not be verified. Try again." });
    return;
  }

  // Conditional update — only the still-pending row flips. 0 rows => someone
  // else won the race (or it was deleted), so report the conflict.
  const updated = await db
    .update(esignDocumentsTable)
    .set({
      status: "signed",
      signerName,
      signedObjectPath,
      signedAt: new Date(),
    })
    .where(
      and(
        eq(esignDocumentsTable.id, row.id),
        eq(esignDocumentsTable.status, "pending"),
      ),
    )
    .returning();
  if (updated.length === 0) {
    res.status(409).json({ error: "This document has already been signed." });
    return;
  }

  await audit({
    schoolId: row.schoolId,
    entityId: row.id,
    action: "signed",
    // The signer is not a staff member; record their typed name as the actor.
    staff: { id: row.createdBy, displayName: signerName },
    payload: { signerName, via: "public_link" },
  });

  res.json({ ok: true });
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default router;
