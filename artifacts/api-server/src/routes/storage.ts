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
import { db, staffTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  ObjectStorageService,
  ObjectNotFoundError,
} from "../lib/objectStorage.js";
import { getObjectAclPolicy } from "../lib/objectAcl.js";
import { canActAsDistrict, getDistrictIdForSchool } from "../lib/scope.js";

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

// Issue a presigned upload URL on behalf of a specific school, recording it
// in the pending-uploads ledger so a later `bindObjectToSchool(path, schoolId)`
// succeeds. Used by feature routes that must mint an upload URL for an
// UNAUTHENTICATED caller (e.g. the public e-sign signing page, where the
// recipient is an outside party identified only by a share token — they have
// no `req.schoolId` of their own, so the document's school is supplied).
export async function issueSchoolUploadUrl(
  schoolId: number,
): Promise<{ uploadURL: string; objectPath: string }> {
  const uploadURL = await objectStorageService.getObjectEntityUploadURL();
  const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
  rememberPendingUpload(objectPath, schoolId);
  return { uploadURL, objectPath };
}

// Stream a stored object to an Express response WITHOUT any per-request auth
// check. The CALLER is responsible for authorizing access first (the e-sign
// signing page authorizes via an unguessable share token before calling this).
// Returns false if the object does not exist so the caller can 404.
export async function streamObjectToResponse(
  objectPath: string,
  res: Response,
): Promise<boolean> {
  let file;
  try {
    file = await objectStorageService.getObjectEntityFile(objectPath);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return false;
    throw err;
  }
  const r = await objectStorageService.downloadObject(file);
  await pipeResponse(r, res);
  return true;
}

// Synthetic ACL "owner" used to scope private uploads to a single school.
// We intentionally use the string form `school:<id>` instead of a per-staff
// owner so that any staffer in the same school can fetch the thumbnail
// (e.g. an admin viewing a teacher's store).
export function schoolOwnerKey(schoolId: number) {
  return `school:${schoolId}`;
}

// Inverse of schoolOwnerKey — parse the owner school id out of an ACL owner
// string. Returns null if the owner is not a `school:<id>` key.
function schoolIdFromOwnerKey(owner: string): number | null {
  const m = /^school:(\d+)$/.exec(owner);
  return m ? Number(m[1]) : null;
}

// District-wide read fallback. When the fast same-school ACL check fails, a
// SuperUser / District Admin may STILL read an object owned by ANOTHER school
// in THEIR OWN district. This mirrors the district-wide tenancy tier used by
// adminStaff (a district admin's roster spans every school in the district),
// so e.g. a teacher photo owned by school B is viewable by a district admin
// whose active school is A. Everyone else stays confined to their own school.
// Only invoked on the slow path (after the same-school check fails), so the
// common avatar render keeps its single-policy-lookup cost.
async function viewerMayReadAcrossSchool(
  staffId: number,
  ownerSchoolId: number,
): Promise<boolean> {
  const [viewer] = await db
    .select({
      schoolId: staffTable.schoolId,
      isSuperUser: staffTable.isSuperUser,
      isDistrictAdmin: staffTable.isDistrictAdmin,
    })
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!viewer || !canActAsDistrict(viewer)) return false;
  const viewerDistrict = await getDistrictIdForSchool(viewer.schoolId);
  if (viewerDistrict === null) return false;
  const ownerDistrict = await getDistrictIdForSchool(ownerSchoolId);
  return ownerDistrict !== null && ownerDistrict === viewerDistrict;
}

// Bind a freshly-uploaded object to a school. Called by feature routes
// (e.g. classroomStore.ts) immediately after persisting the imageUrl, so the
// `/storage/objects/*` read path can verify the requester has access.
//
// Returns true on success, false if the caller is not allowed to claim this
// object — either because it was already bound to a different school, or
// because no upload URL was issued to this school for this path. Callers
// should treat false as "reject the save with 403".
// `ownerSchoolId` is the school the object will be OWNED by (its ACL owner —
// the school whose staff may later read it). `uploaderSchoolIds`, when given,
// is the set of schools whose pending upload is allowed to claim this object;
// it defaults to `[ownerSchoolId]` so existing two-arg callers are unchanged.
// The two diverge only when an authorized actor uploads on behalf of a
// DIFFERENT school they manage (e.g. a SuperUser/district admin sets a photo
// for a teacher in another school in their district): the upload URL was
// minted under the actor's own `req.schoolId`, but ownership must land on the
// target's school.
export async function bindObjectToSchool(
  objectPath: string,
  ownerSchoolId: number,
  uploaderSchoolIds?: number[],
): Promise<boolean> {
  if (!objectPath || !objectPath.startsWith("/objects/")) return false;
  let file;
  try {
    file = await objectStorageService.getObjectEntityFile(objectPath);
  } catch {
    return false;
  }
  const existing = await getObjectAclPolicy(file);
  if (existing) {
    // Already bound — only succeed if it's the same school. Refuse to
    // re-assign ownership to a different school, which would otherwise let
    // any caller hijack a known object path.
    return existing.owner === schoolOwnerKey(ownerSchoolId);
  }
  const allowedUploaders = uploaderSchoolIds ?? [ownerSchoolId];
  const pending = getPendingUpload(objectPath);
  if (!pending || !allowedUploaders.includes(pending.schoolId)) return false;
  await objectStorageService.trySetObjectEntityAclPolicy(objectPath, {
    owner: schoolOwnerKey(ownerSchoolId),
    visibility: "private",
  });
  pendingUploads.delete(objectPath);
  return true;
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
      if (!allowed) {
        // Slow path: a SuperUser / District Admin may read an object owned by
        // another school in their own district (district-wide tenancy tier).
        const ownerSchoolId = schoolIdFromOwnerKey(policy.owner);
        if (ownerSchoolId !== null) {
          allowed = await viewerMayReadAcrossSchool(staffId, ownerSchoolId);
        }
      }
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
