// Object-storage upload + serve routes for PulseED.
// Hand-validated (no openapi-zod dependency) to keep the route surface
// consistent with the rest of this server.
//
// Flow:
//   1. Client POSTs metadata to /api/storage/uploads/request-url and gets
//      back { uploadURL, objectPath }.
//   2. Client PUTs the file bytes directly to <uploadURL> (Google Cloud
//      Storage). Our server never sees the file body.
//   3. Client persists `objectPath` (e.g. "/objects/<uuid>") on whatever
//      domain row needs it (classroom store item, etc).
//   4. Client/browser fetches the image via /api/storage/objects/<id>.
//
// Read paths:
//   - /api/storage/objects/*        → presigned-uploaded entities. Auth-
//     gated (requires a signed-in staffer) since these can contain images
//     scoped to a single school.
//   - /api/storage/public-objects/* → unconditionally public (used for
//     site assets dropped into the bucket via the workspace pane).
import { Router, type IRouter, type Request, type Response } from "express";
import {
  ObjectStorageService,
  ObjectNotFoundError,
} from "../lib/objectStorage.js";
import { getObjectAclPolicy } from "../lib/objectAcl.js";
import type { TourFlyer } from "@workspace/db";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

// In-memory ledger of presigned upload URLs we've issued, keyed by the
// `/objects/<id>` path the caller will eventually save. We use this to:
//   1. Allow the uploader (and only the uploader's school) to preview the
//      object before it has been persisted to a domain row, since GCS metadata
//      can only be set after the bytes land.
//   2. Prove ownership at save time, so `bindObjectToSchool` can refuse to
//      reassign an object that wasn't issued to the caller's school.
// Lost on restart, which is fine for a feature with no critical state in the
// upload window. The TTL matches a comfortable upper bound on "user picks
// image, edits the form, hits save."
type PendingUpload = { schoolId: number; expiresAt: number };
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const pendingUploads = new Map<string, PendingUpload>();

function pruneExpiredPendingUploads() {
  if (pendingUploads.size < 100) return;
  const now = Date.now();
  for (const [k, v] of pendingUploads) {
    if (v.expiresAt < now) pendingUploads.delete(k);
  }
}

function rememberPendingUpload(objectPath: string, schoolId: number) {
  pendingUploads.set(objectPath, {
    schoolId,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
  pruneExpiredPendingUploads();
}

function getPendingUpload(objectPath: string): PendingUpload | undefined {
  const entry = pendingUploads.get(objectPath);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    pendingUploads.delete(objectPath);
    return undefined;
  }
  return entry;
}

// Pipe a fetch-style Response to an Express Response and copy headers.
async function pipeResponse(src: Response | globalThis.Response, dest: Response) {
  const r = src as unknown as globalThis.Response;
  r.headers.forEach((value, key) => dest.setHeader(key, value));
  if (!r.body) {
    dest.end();
    return;
  }
  const reader = r.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    dest.write(Buffer.from(value));
  }
  dest.end();
}

// POST /api/storage/uploads/request-url
//   body: { name?: string, size?: number, contentType?: string }
//   returns: { uploadURL, objectPath }
router.post("/storage/uploads/request-url", async (req, res) => {
  const staffId = req.staffId;
  const schoolId = req.schoolId;
  if (!staffId || !schoolId) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  // We accept the metadata but don't enforce it server-side beyond a basic
  // size cap; GCS will validate Content-Type at PUT time.
  const size = Number(req.body?.size);
  if (Number.isFinite(size) && size > 10 * 1024 * 1024) {
    res.status(400).json({ error: "File is too large (max 10 MB)" });
    return;
  }
  try {
    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
    // Record that this path belongs to the requesting school. The read path
    // and the bind step both consult this ledger.
    rememberPendingUpload(objectPath, schoolId);
    res.json({ uploadURL, objectPath });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[storage] request-url failed", err);
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

// Synthetic ACL "owner" used to scope private uploads to a single school.
// We intentionally use the string form `school:<id>` instead of a per-staff
// owner so that any staffer in the same school can fetch the thumbnail
// (e.g. an admin viewing a teacher's store).
export function schoolOwnerKey(schoolId: number) {
  return `school:${schoolId}`;
}

export type BindObjectFailure =
  | "invalid_path"
  | "not_found"
  | "wrong_school"
  | "not_claimable";

export type BindObjectResult =
  | { ok: true }
  | { ok: false; reason: BindObjectFailure };

/** True when the object exists in private storage (S3/GCS). */
export async function objectPathExists(objectPath: string): Promise<boolean> {
  if (!objectPath?.startsWith("/objects/")) return false;
  try {
    await objectStorageService.getObjectEntityFile(objectPath);
    return true;
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return false;
    return false;
  }
}

async function applySchoolObjectAcl(
  objectPath: string,
  schoolId: number,
): Promise<void> {
  await objectStorageService.trySetObjectEntityAclPolicy(objectPath, {
    owner: schoolOwnerKey(schoolId),
    visibility: "private",
  });
  pendingUploads.delete(objectPath);
}

// Bind a freshly-uploaded object to a school. Called by feature routes
// (e.g. classroomStore.ts) immediately after persisting the imageUrl, so the
// `/storage/objects/*` read path can verify the requester has access.
export async function bindObjectToSchoolDetailed(
  objectPath: string,
  schoolId: number,
): Promise<BindObjectResult> {
  if (!objectPath || !objectPath.startsWith("/objects/")) {
    return { ok: false, reason: "invalid_path" };
  }
  let file;
  try {
    file = await objectStorageService.getObjectEntityFile(objectPath);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      return { ok: false, reason: "not_found" };
    }
    return { ok: false, reason: "not_claimable" };
  }
  const existing = await getObjectAclPolicy(file);
  if (existing) {
    if (existing.owner === schoolOwnerKey(schoolId)) return { ok: true };
    return { ok: false, reason: "wrong_school" };
  }
  const pending = getPendingUpload(objectPath);
  if (pending) {
    if (pending.schoolId !== schoolId) {
      return { ok: false, reason: "wrong_school" };
    }
    await applySchoolObjectAcl(objectPath, schoolId);
    return { ok: true };
  }
  // Object bytes are in storage but the in-memory pending ledger was lost
  // (PM2 restart / different worker). The path is an unguessable UUID issued
  // by this API — allow the authenticated school to claim on first save.
  try {
    await applySchoolObjectAcl(objectPath, schoolId);
    return { ok: true };
  } catch {
    return { ok: false, reason: "not_claimable" };
  }
}

export async function bindObjectToSchool(
  objectPath: string,
  schoolId: number,
): Promise<boolean> {
  const result = await bindObjectToSchoolDetailed(objectPath, schoolId);
  return result.ok;
}

/**
 * Claim storage objects referenced on the School Tours brag page. Stale paths
 * from a prior host (e.g. Replit) that no longer exist in S3 are dropped so
 * one bad legacy photo does not block the whole save.
 */
export async function claimTourBragObjectPaths(
  schoolId: number,
  photos: string[],
  flyers: TourFlyer[],
): Promise<
  | {
      ok: true;
      photos: string[];
      flyers: TourFlyer[];
      droppedPaths: string[];
    }
  | { ok: false; reason: BindObjectFailure; failedPath: string }
> {
  const droppedPaths: string[] = [];
  const keptPhotos: string[] = [];

  for (const path of photos) {
    if (!path.startsWith("/objects/")) {
      keptPhotos.push(path);
      continue;
    }
    const result = await bindObjectToSchoolDetailed(path, schoolId);
    if (result.ok) {
      keptPhotos.push(path);
      continue;
    }
    if (result.reason === "not_found") {
      droppedPaths.push(path);
      continue;
    }
    return { ok: false, reason: result.reason, failedPath: path };
  }

  const keptFlyers: TourFlyer[] = [];
  for (const flyer of flyers) {
    const path = flyer.key;
    if (!path.startsWith("/objects/")) {
      keptFlyers.push(flyer);
      continue;
    }
    const result = await bindObjectToSchoolDetailed(path, schoolId);
    if (result.ok) {
      keptFlyers.push(flyer);
      continue;
    }
    if (result.reason === "not_found") {
      droppedPaths.push(path);
      continue;
    }
    return { ok: false, reason: result.reason, failedPath: path };
  }

  return {
    ok: true,
    photos: keptPhotos,
    flyers: keptFlyers,
    droppedPaths,
  };
}

// GET /api/storage/objects/*tail — serve a private uploaded entity.
// Authorization: requester must be signed in AND the object's ACL policy
// must list their school as the owner. Objects without a policy are treated
// as unowned and rejected, so we never silently leak across tenants.
router.get("/storage/objects/*tail", async (req, res) => {
  const staffId = req.staffId;
  const schoolId = req.schoolId;
  if (!staffId || !schoolId) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  // express 5 / path-to-regexp v8 stores the wildcard tail under the named
  // splat param. Either an array of segments or a single string is possible
  // depending on how the URL was matched.
  const raw = (req.params as Record<string, string | string[]>)["tail"];
  const tail = Array.isArray(raw) ? raw.join("/") : (raw ?? "");
  const objectPath = `/objects/${tail}`;
  try {
    const file = await objectStorageService.getObjectEntityFile(objectPath);
    const policy = await getObjectAclPolicy(file);
    let allowed = false;
    if (policy) {
      allowed = policy.owner === schoolOwnerKey(schoolId);
    } else {
      // No policy yet — only the school we issued the upload URL to may
      // preview the freshly-uploaded bytes.
      const pending = getPendingUpload(objectPath);
      allowed = !!pending && pending.schoolId === schoolId;
    }
    if (!allowed) {
      // Don't tell the caller whether the file exists — looks like a 404.
      res.status(404).json({ error: "Not found" });
      return;
    }
    const r = await objectStorageService.downloadObject(file);
    await pipeResponse(r, res);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    // eslint-disable-next-line no-console
    console.error("[storage] download failed", err);
    res.status(500).json({ error: "Failed to read object" });
  }
});

// GET /api/storage/public-objects/:path(*) — unconditionally public.
router.get("/storage/public-objects/*tail", async (req, res) => {
  const raw = (req.params as Record<string, string | string[]>)["tail"];
  const tail = Array.isArray(raw) ? raw.join("/") : (raw ?? "");
  try {
    const file = await objectStorageService.searchPublicObject(tail);
    if (!file) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const r = await objectStorageService.downloadObject(file);
    await pipeResponse(r, res);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[storage] public download failed", err);
    res.status(500).json({ error: "Failed to read object" });
  }
});

export default router;
