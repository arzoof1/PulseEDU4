import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  schoolsTable,
  staffTable,
  districtsTable,
  schoolSettingsTable,
  tourPagesTable,
  tourRequestsTable,
  tourRequestEventsTable,
  tourSurveysTable,
  adminNotificationsTable,
  TOUR_STATUSES,
  TOUR_OUTCOMES,
  type TourChild,
  type TourPageSection,
  type TourFlyer,
  type TourCheckpoint,
  type TourTranslation,
  type TourStatus,
  type TourOutcome,
} from "@workspace/db";
import { and, eq, desc, asc, sql } from "drizzle-orm";
import { randomUUID, createHash } from "crypto";
import { requireSchool, getDistrictIdForSchool } from "../lib/scope.js";
import { canManageTours, canGuideTours } from "../lib/coreTeam.js";
import {
  ObjectStorageService,
  ObjectNotFoundError,
} from "../lib/objectStorage.js";
import { bindObjectToSchool } from "./storage.js";
import {
  sendNewLeadNotifyEmail,
  sendFamilyAckEmail,
  sendLeadAssignedEmail,
} from "../lib/tourEmails.js";
import { sendSmsBatch } from "../lib/sms.js";
import { addBusinessDays } from "../lib/businessDays.js";
import { overdueFor } from "../lib/tourReminders.js";
import {
  translateTourContent,
  isSupportedTargetLang,
  hashTourContent,
  type TranslatableTourContent,
  type SupportedTargetLang,
} from "../lib/tourTranslate.js";
import { buildTourBragSheetPdf } from "../lib/tourBragSheetPdf.js";
import { buildTourLeaveBehindPdf } from "../lib/tourLeaveBehindPdf.js";
import { buildTourRoadmapPdf } from "../lib/tourRoadmapPdf.js";
import { buildTourNoteCatcherPdf } from "../lib/tourNoteCatcherPdf.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

// Content-types we are willing to serve *inline* over the unauthenticated
// public path. Anything outside this allowlist (e.g. text/html, svg, js) is
// forced to download as an opaque octet-stream so it can never execute as
// first-party content — these routes are reachable without auth and flyers
// open via top-level navigation.
const PUBLIC_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);
const PUBLIC_FLYER_TYPES = new Set([...PUBLIC_IMAGE_TYPES, "application/pdf"]);

// Pipe a fetch-style Response (from object storage) to an Express Response.
// Content-type is NOT trusted from upstream: it is coerced against `allowed`,
// and anything else is served as a forced download. `X-Content-Type-Options:
// nosniff` is always set so browsers won't MIME-sniff the bytes back into an
// executable type.
async function pipeStorageResponse(
  src: globalThis.Response,
  dest: Response,
  allowed: Set<string>,
): Promise<void> {
  const rawType = (src.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const safe = allowed.has(rawType);

  const cacheControl = src.headers.get("cache-control");
  const contentLength = src.headers.get("content-length");
  if (cacheControl) dest.setHeader("Cache-Control", cacheControl);
  if (contentLength) dest.setHeader("Content-Length", contentLength);
  dest.setHeader("X-Content-Type-Options", "nosniff");
  if (safe) {
    dest.setHeader("Content-Type", rawType);
    dest.setHeader("Content-Disposition", "inline");
  } else {
    dest.setHeader("Content-Type", "application/octet-stream");
    dest.setHeader("Content-Disposition", "attachment");
  }

  if (!src.body) {
    dest.end();
    return;
  }
  const reader = src.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    dest.write(Buffer.from(value));
  }
  dest.end();
}

// Stream a tour asset (photo or flyer) to an unauthenticated public visitor.
// The caller has already verified the asset belongs to a *published* page, so
// we serve the bytes directly (bypassing the school-ACL gate on
// /storage/objects, which the public has no token for). Legacy external URLs
// are passed through via redirect. `allowed` constrains which content-types may
// render inline (see PUBLIC_*_TYPES).
// Short content-version token derived from the object-storage key. Public
// photo/flyer URLs are index-based (`/photo/0`, `/flyer/0`), so when a school
// deletes an asset and uploads a replacement the new file lands at the SAME
// index and the URL never changes — the browser then serves the previously
// cached image (Cache-Control max-age) and the old "seed" picture appears to
// persist. Appending `?v=<hash-of-key>` makes the URL change whenever the
// underlying object changes (each upload mints a fresh key), busting the cache.
function assetVersion(key: string): string {
  return createHash("sha1").update(key).digest("hex").slice(0, 10);
}

async function streamTourAsset(
  key: string,
  req: Request,
  res: Response,
  allowed: Set<string>,
): Promise<void> {
  if (/^https?:\/\//i.test(key)) {
    res.redirect(302, key);
    return;
  }
  if (!key.startsWith("/objects/")) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    const file = await objectStorageService.getObjectEntityFile(key);
    const r = await objectStorageService.downloadObject(file);
    await pipeStorageResponse(r, res, allowed);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    req.log.error({ err }, "[tours] asset stream failed");
    res.status(500).json({ error: "Failed to read asset" });
  }
}

// =============================================================================
// School Tours — public brag page + lead pipeline.
//
// Two surfaces:
//   PUBLIC (no auth): the brag page + tour-request form + post-tour survey.
//     School is identified by the numeric :schoolId in the path (brag page /
//     request) or by the globally-unique :token (survey).
//   ADMIN (requireStaff + canManageTours): brag-page editor, lead pipeline,
//     activity timeline, status/assignment/outcome, PDF leave-behinds.
// =============================================================================

// ---- shared helpers --------------------------------------------------------

// Public-facing origin for links/QR codes that families open OUTSIDE the
// workspace (post-tour survey QR, brag-page link, lead-notify email). We trust
// the first $REPLIT_DOMAINS host (the published production domain in prod, the
// dev/preview host in dev) so the URL is always externally reachable; then fall
// back to the inbound request host, and only finally to localhost. NOTE:
// $REPLIT_DEV_DOMAIN is the *development* host and is often unset in production,
// so it must never be the primary source — relying on it makes published QR
// codes point at the dev URL (or localhost) and land on a dead page.
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
    const proto = rawProto === "http" || rawProto === "https" ? rawProto : "https";
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

function surveyUrlFor(token: string, req?: Request): string {
  return `${publicAppOrigin(req)}/tour/survey/${encodeURIComponent(token)}`;
}

function pipelineUrlFor(req?: Request): string {
  return `${publicAppOrigin(req)}/?settingsTile=school-tours`;
}

type StaffRow = typeof staffTable.$inferSelect;

async function requireStaff(req: Request, res: Response, next: NextFunction) {
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

function requireTourManager(req: Request, res: Response, next: NextFunction) {
  const staff = (req as Request & { staff?: StaffRow }).staff;
  if (!staff || !canManageTours(staff)) {
    res.status(403).json({ error: "Not authorized for School Tours" });
    return;
  }
  next();
}

// Allows full tour managers AND lightweight Tour Guides. Routes that use this
// must additionally enforce own-lead scoping for guides via canAccessLead().
function requireTourGuide(req: Request, res: Response, next: NextFunction) {
  const staff = (req as Request & { staff?: StaffRow }).staff;
  if (!staff || !canGuideTours(staff)) {
    res.status(403).json({ error: "Not authorized for School Tours" });
    return;
  }
  next();
}

// Full managers can touch any lead; a Tour Guide may only act on a lead they
// own. Returns true when the staff member is allowed to view/print this lead.
function canAccessLead(
  staff: StaffRow,
  lead: { assignedStaffId: number | null },
): boolean {
  if (canManageTours(staff)) return true;
  return lead.assignedStaffId === staff.id;
}

function sanitizeStrings(input: unknown, max: number): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, max);
}

// Flyers: array of { key, label, kind }. Keys must be object-storage paths
// (uploaded via the presigned flow) — anything else is dropped.
function sanitizeFlyers(input: unknown): TourFlyer[] {
  if (!Array.isArray(input)) return [];
  const out: TourFlyer[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const key = typeof r.key === "string" ? r.key.trim() : "";
    if (!key.startsWith("/objects/")) continue;
    const label =
      typeof r.label === "string" ? r.label.trim().slice(0, 120) : "";
    const kind: TourFlyer["kind"] = r.kind === "pdf" ? "pdf" : "image";
    out.push({ key, label, kind });
    if (out.length >= 12) break;
  }
  return out;
}

// Tour checkpoints: array of { key?, label, location, talkingPoints, minutes }.
// A label is required (rows with no label are dropped). Keys are stable opaque
// ids — preserved if the client sends one back, otherwise assigned here — so a
// family's stored selections keep pointing at the same stop across label edits.
function sanitizeCheckpoints(input: unknown): TourCheckpoint[] {
  if (!Array.isArray(input)) return [];
  const out: TourCheckpoint[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const label =
      typeof r.label === "string" ? r.label.trim().slice(0, 120) : "";
    if (!label) continue;
    let key =
      typeof r.key === "string" && /^[a-z0-9]{6,}$/.test(r.key.trim())
        ? r.key.trim()
        : "";
    if (!key || seen.has(key)) {
      do {
        key = randomUUID().replace(/-/g, "").slice(0, 12);
      } while (seen.has(key));
    }
    seen.add(key);
    const location =
      typeof r.location === "string" ? r.location.trim().slice(0, 160) : "";
    const talkingPoints =
      typeof r.talkingPoints === "string"
        ? r.talkingPoints.trim().slice(0, 1000)
        : "";
    const minutesRaw =
      typeof r.minutes === "number"
        ? r.minutes
        : Number.parseInt(String(r.minutes ?? ""), 10);
    const minutes =
      Number.isFinite(minutesRaw) && minutesRaw > 0
        ? Math.min(Math.round(minutesRaw), 240)
        : 0;
    const alwaysInclude = r.alwaysInclude === true;
    out.push({ key, label, location, talkingPoints, minutes, alwaysInclude });
    if (out.length >= 30) break;
  }
  return out;
}

function sanitizeSections(input: unknown): TourPageSection[] {
  if (!Array.isArray(input)) return [];
  const out: TourPageSection[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const title = typeof r.title === "string" ? r.title.trim() : "";
    const body = typeof r.body === "string" ? r.body.trim() : "";
    if (!title && !body) continue;
    out.push({ title: title.slice(0, 120), body: body.slice(0, 2000) });
    if (out.length >= 20) break;
  }
  return out;
}

function sanitizeChildren(input: unknown): TourChild[] {
  if (!Array.isArray(input)) return [];
  const out: TourChild[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const grade = typeof r.grade === "string" ? r.grade.trim() : "";
    if (!name) continue;
    out.push({ name: name.slice(0, 120), grade: grade.slice(0, 20) });
    if (out.length >= 12) break;
  }
  return out;
}

// Read-or-default the per-school brag page. Returns defaults (unpersisted)
// when no row exists yet so the admin editor renders a blank slate.
async function loadTourPage(schoolId: number) {
  const [row] = await db
    .select()
    .from(tourPagesTable)
    .where(eq(tourPagesTable.schoolId, schoolId));
  return row ?? null;
}

async function schoolName(schoolId: number): Promise<string> {
  const [row] = await db
    .select({ name: schoolsTable.name })
    .from(schoolsTable)
    .where(eq(schoolsTable.id, schoolId));
  return row?.name ?? "Our School";
}

// Resolve the district-level branding for a school's brag page. Branding is
// district-owned (set once by a SuperUser) — every school in the district
// inherits the same logo, tagline, and placement toggles. Returns null when
// the school has no district.
type DistrictBranding = {
  districtId: number;
  tagline: string | null;
  logoObjectKey: string | null;
  brandHeroTop: boolean;
  brandDocuments: boolean;
  brandFooter: boolean;
  brandWatermark: boolean;
};
async function loadDistrictBranding(
  schoolId: number,
): Promise<DistrictBranding | null> {
  const districtId = await getDistrictIdForSchool(schoolId);
  if (districtId === null) return null;
  const [d] = await db
    .select({
      tagline: districtsTable.tagline,
      logoObjectKey: districtsTable.logoObjectKey,
      brandHeroTop: districtsTable.brandHeroTop,
      brandDocuments: districtsTable.brandDocuments,
      brandFooter: districtsTable.brandFooter,
      brandWatermark: districtsTable.brandWatermark,
    })
    .from(districtsTable)
    .where(eq(districtsTable.id, districtId));
  if (!d) return null;
  return { districtId, ...d };
}

// Resolve the district branding to embed in a printed document (brag sheet /
// post-tour). Returns null unless the district's "printed documents" toggle is
// on. Downloads the logo bytes into a Buffer for pdfkit; a missing/unreadable
// logo degrades gracefully to tagline-only.
async function loadDistrictDocumentBranding(
  schoolId: number,
): Promise<{ logo: Buffer | null; tagline: string | null } | null> {
  const branding = await loadDistrictBranding(schoolId);
  if (!branding || !branding.brandDocuments) return null;
  let logo: Buffer | null = null;
  const key = branding.logoObjectKey;
  if (key && key.startsWith("/objects/")) {
    try {
      const file = await objectStorageService.getObjectEntityFile(key);
      const [buf] = await file.download();
      logo = buf;
    } catch {
      logo = null;
    }
  }
  return { logo, tagline: branding.tagline };
}

// =============================================================================
// PUBLIC ROUTES (no auth)
// =============================================================================

// Survey routes first (literal "survey" segment) — registered ahead of the
// numeric :schoolId routes for clarity, though paths don't actually collide.

// GET /tours/public/survey/:token — resolve the lead behind a survey link.
router.get("/tours/public/survey/:token", async (req, res) => {
  const token = req.params.token;
  const [reqRow] = await db
    .select({
      id: tourRequestsTable.id,
      schoolId: tourRequestsTable.schoolId,
      familyName: tourRequestsTable.familyName,
      preferredLanguage: tourRequestsTable.preferredLanguage,
      submittedAt: tourRequestsTable.surveySubmittedAt,
    })
    .from(tourRequestsTable)
    .where(eq(tourRequestsTable.surveyToken, token));
  if (!reqRow) {
    res.status(404).json({ error: "Survey not found" });
    return;
  }
  res.json({
    schoolName: await schoolName(reqRow.schoolId),
    familyName: reqRow.familyName,
    preferredLanguage: reqRow.preferredLanguage,
    alreadySubmitted: Boolean(reqRow.submittedAt),
  });
});

// POST /tours/public/survey/:token — submit the post-tour survey.
router.post("/tours/public/survey/:token", async (req, res) => {
  const token = req.params.token;
  const [reqRow] = await db
    .select()
    .from(tourRequestsTable)
    .where(eq(tourRequestsTable.surveyToken, token));
  if (!reqRow) {
    res.status(404).json({ error: "Survey not found" });
    return;
  }
  if (reqRow.surveySubmittedAt) {
    res.status(409).json({ error: "Survey already submitted" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const ratingRaw = Number(body.rating);
  const rating =
    Number.isInteger(ratingRaw) && ratingRaw >= 1 && ratingRaw <= 5
      ? ratingRaw
      : null;
  const liked = typeof body.liked === "string" ? body.liked.slice(0, 4000) : "";
  const questions =
    typeof body.questions === "string" ? body.questions.slice(0, 4000) : "";
  const comments =
    typeof body.comments === "string" ? body.comments.slice(0, 4000) : "";

  await db.insert(tourSurveysTable).values({
    schoolId: reqRow.schoolId,
    tourRequestId: reqRow.id,
    rating,
    liked,
    questions,
    comments,
  });
  await db
    .update(tourRequestsTable)
    .set({ surveySubmittedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(tourRequestsTable.id, reqRow.id),
        eq(tourRequestsTable.schoolId, reqRow.schoolId),
      ),
    );
  await db.insert(tourRequestEventsTable).values({
    schoolId: reqRow.schoolId,
    tourRequestId: reqRow.id,
    staffId: null,
    eventType: "survey_submitted",
    body: rating ? `Post-tour survey submitted (${rating}/5).` : "Post-tour survey submitted.",
  });

  res.status(201).json({ ok: true });
});

// Build the translatable subset of a tour page row from its source columns.
function translatableFromPage(
  page: NonNullable<Awaited<ReturnType<typeof loadTourPage>>>,
): TranslatableTourContent {
  return {
    headline: page.headline,
    subheadline: page.subheadline,
    intro: page.intro,
    sections: page.sections ?? [],
    checkpoints: (page.checkpoints ?? []).map((c) => ({
      key: c.key,
      label: c.label,
    })),
    programs: page.programs ?? [],
    electives: page.electives ?? [],
    proudOf: page.proudOf ?? [],
    ctaText: page.ctaText,
  };
}

// In-process singleflight: the public page GET is unauthenticated, so a burst
// of concurrent cold-miss views (e.g. right after an admin edit) would each
// fire an Anthropic call. We dedupe by `schoolId:lang:hash` so only the first
// request does the work and the rest await its result — capping LLM cost/fan-
// out without needing a shared lock.
const inflightTranslations = new Map<
  string,
  Promise<TourTranslation | null>
>();

// Generate + persist a translation under the singleflight guard. Returns the
// cache payload (or null on failure). Persists best-effort; a write failure
// still returns the translation so the current request renders correctly.
async function generateAndCacheTranslation(
  schoolId: number,
  existingTranslations: Record<string, TourTranslation>,
  source: TranslatableTourContent,
  hash: string,
  lang: SupportedTargetLang,
): Promise<TourTranslation | null> {
  const key = `${schoolId}:${lang}:${hash}`;
  const existing = inflightTranslations.get(key);
  if (existing) return existing;
  const work = (async () => {
    const translated = await translateTourContent(source, lang);
    if (!translated) return null;
    try {
      await db
        .update(tourPagesTable)
        .set({ translations: { ...existingTranslations, [lang]: translated } })
        .where(eq(tourPagesTable.schoolId, schoolId));
    } catch (err) {
      logger.error({ err, schoolId, lang }, "tour translation cache write failed");
    }
    return translated;
  })();
  const tracked = work.finally(() => inflightTranslations.delete(key));
  inflightTranslations.set(key, tracked);
  return tracked;
}

// Resolve the brag-page content for the requested language. English (or any
// unsupported language) returns the raw source. For a supported target
// language we serve the cached translation when its source hash matches, else
// translate once and persist the result back onto the row. A translation
// failure transparently falls back to the English source so the public page
// never breaks.
async function resolveTranslatedContent(
  schoolId: number,
  page: NonNullable<Awaited<ReturnType<typeof loadTourPage>>>,
  lang: string,
): Promise<TranslatableTourContent | null> {
  if (!isSupportedTargetLang(lang)) return null;
  const source = translatableFromPage(page);
  const hash = hashTourContent(source);
  const existingTranslations = page.translations ?? {};
  const cached = existingTranslations[lang];
  const payload =
    cached && cached.sourceHash === hash
      ? cached
      : await generateAndCacheTranslation(
          schoolId,
          existingTranslations,
          source,
          hash,
          lang,
        );
  if (!payload) return null;
  return {
    headline: payload.headline,
    subheadline: payload.subheadline,
    intro: payload.intro,
    sections: payload.sections ?? [],
    checkpoints: payload.checkpoints ?? [],
    programs: payload.programs ?? [],
    electives: payload.electives ?? [],
    proudOf: payload.proudOf ?? [],
    ctaText: payload.ctaText,
  };
}

// GET /tours/public/:schoolId/page — the published brag page. Accepts an
// optional `?lang=` to serve machine-translated content (English is the
// source; only Spanish is supported today).
router.get("/tours/public/:schoolId/page", async (req, res) => {
  const schoolId = Number(req.params.schoolId);
  if (!Number.isInteger(schoolId) || schoolId <= 0) {
    res.status(400).json({ error: "Invalid school" });
    return;
  }
  const page = await loadTourPage(schoolId);
  if (!page || !page.published) {
    res.status(404).json({ error: "Tour page not available" });
    return;
  }
  const branding = await loadDistrictBranding(schoolId);
  const lang = typeof req.query.lang === "string" ? req.query.lang : "en";
  const tr = await resolveTranslatedContent(schoolId, page, lang);
  res.json({
    schoolName: await schoolName(schoolId),
    // When a translation is available `tr` carries the localized strings;
    // otherwise we serve the raw English source columns.
    headline: tr?.headline ?? page.headline,
    subheadline: tr?.subheadline ?? page.subheadline,
    intro: tr?.intro ?? page.intro,
    sections: tr?.sections ?? page.sections,
    // Public form only needs key + label + the always-include flag — location
    // / talking points / minutes are staff-facing and stay server-side. The
    // always-include flag lives only on the source row (translations cache
    // key + label), so we look it up by key from the source checkpoints.
    checkpoints: (tr?.checkpoints ?? page.checkpoints ?? []).map((c) => ({
      key: c.key,
      label: c.label,
      alwaysInclude:
        (page.checkpoints ?? []).find((s) => s.key === c.key)?.alwaysInclude ===
        true,
    })),
    programs: tr?.programs ?? page.programs,
    electives: tr?.electives ?? page.electives,
    proudOf: tr?.proudOf ?? page.proudOf,
    // Serve photos/flyers through the public streaming routes by index so
    // unauthenticated families never touch the school-ACL object path. Keys
    // are never exposed to the client.
    photos: page.photos.map(
      (key, i) =>
        `/api/tours/public/${schoolId}/photo/${i}?v=${assetVersion(key)}`,
    ),
    textPlacement: page.textPlacement === "bottom" ? "bottom" : "top",
    flyers: (page.flyers ?? []).map((f, i) => ({
      label: f.label,
      kind: f.kind,
      url: `/api/tours/public/${schoolId}/flyer/${i}?v=${assetVersion(f.key)}`,
    })),
    ctaText: tr?.ctaText ?? page.ctaText,
    accentColor: page.accentColor,
    headerTextColor: page.headerTextColor ?? "#ffffff",
    contactEmail: page.contactEmail,
    contactPhone: page.contactPhone,
    // District-level branding (set once by the district, inherited by every
    // school). The logo streams by a stable index-free public URL — the
    // object key is never exposed to the unauthenticated client.
    district: branding
      ? {
          tagline: branding.tagline,
          hasLogo: !!branding.logoObjectKey,
          logoUrl: branding.logoObjectKey
            ? `/api/tours/public/${schoolId}/district-logo?v=${assetVersion(branding.logoObjectKey)}`
            : null,
          placements: {
            heroTop: branding.brandHeroTop,
            footer: branding.brandFooter,
            watermark: branding.brandWatermark,
          },
        }
      : null,
  });
});

// GET /tours/public/:schoolId/district-logo — stream the school's district
// logo to an unauthenticated visitor (ACL-bypass, like brag photos). Only
// served when the page is published.
router.get("/tours/public/:schoolId/district-logo", async (req, res) => {
  const schoolId = Number(req.params.schoolId);
  if (!Number.isInteger(schoolId) || schoolId <= 0) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const page = await loadTourPage(schoolId);
  if (!page || !page.published) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const branding = await loadDistrictBranding(schoolId);
  if (!branding?.logoObjectKey) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await streamTourAsset(branding.logoObjectKey, req, res, PUBLIC_IMAGE_TYPES);
});

// GET /tours/admin/district-logo — stream the caller's district logo for the
// admin editor preview. Resolved by the caller's district (not object ACL),
// so any SuperUser in the district previews the same logo regardless of which
// school originally uploaded it.
router.get("/tours/admin/district-logo", requireStaff, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const branding = await loadDistrictBranding(schoolId);
  if (!branding?.logoObjectKey) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await streamTourAsset(branding.logoObjectKey, req, res, PUBLIC_IMAGE_TYPES);
});

// GET /tours/public/:schoolId/photo/:idx — stream a published page's Nth photo
// to an unauthenticated visitor.
router.get("/tours/public/:schoolId/photo/:idx", async (req, res) => {
  const schoolId = Number(req.params.schoolId);
  const idx = Number(req.params.idx);
  if (
    !Number.isInteger(schoolId) ||
    schoolId <= 0 ||
    !Number.isInteger(idx) ||
    idx < 0
  ) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const page = await loadTourPage(schoolId);
  if (!page || !page.published) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const key = page.photos[idx];
  if (!key) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await streamTourAsset(key, req, res, PUBLIC_IMAGE_TYPES);
});

// GET /tours/public/:schoolId/flyer/:idx — stream a published page's Nth flyer.
router.get("/tours/public/:schoolId/flyer/:idx", async (req, res) => {
  const schoolId = Number(req.params.schoolId);
  const idx = Number(req.params.idx);
  if (
    !Number.isInteger(schoolId) ||
    schoolId <= 0 ||
    !Number.isInteger(idx) ||
    idx < 0
  ) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const page = await loadTourPage(schoolId);
  if (!page || !page.published) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const flyer = (page.flyers ?? [])[idx];
  if (!flyer) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await streamTourAsset(flyer.key, req, res, PUBLIC_FLYER_TYPES);
});

// POST /tours/public/:schoolId/request — create a lead from the public form.
router.post("/tours/public/:schoolId/request", async (req, res) => {
  const schoolId = Number(req.params.schoolId);
  if (!Number.isInteger(schoolId) || schoolId <= 0) {
    res.status(400).json({ error: "Invalid school" });
    return;
  }
  // Only accept requests for a school whose brag page is actually published.
  const page = await loadTourPage(schoolId);
  if (!page || !page.published) {
    res.status(404).json({ error: "Tour page not available" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const familyName =
    typeof body.familyName === "string" ? body.familyName.trim() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const email =
    typeof body.email === "string" && body.email.trim()
      ? body.email.trim().slice(0, 200)
      : null;
  const children = sanitizeChildren(body.children);
  const interests =
    typeof body.interests === "string" ? body.interests.slice(0, 2000) : "";
  // Keep only selections that match a real checkpoint key on the page; de-dup
  // and preserve the page's checkpoint order so the roadmap reads top-to-bottom.
  const validKeys = new Set((page.checkpoints ?? []).map((c) => c.key));
  const requested = new Set(
    Array.isArray(body.interestSelections)
      ? body.interestSelections.filter(
          (k): k is string => typeof k === "string",
        )
      : [],
  );
  const interestSelections = (page.checkpoints ?? [])
    .map((c) => c.key)
    .filter((k) => validKeys.has(k) && requested.has(k));
  // Human-readable summary (selected stop labels + free text) for the staff
  // notification email.
  const selectedLabels = (page.checkpoints ?? [])
    .filter((c) => interestSelections.includes(c.key))
    .map((c) => c.label);
  const interestsForEmail =
    [selectedLabels.join(", "), interests.trim()]
      .filter((s) => s.length > 0)
      .join(" — ") || interests;
  const source =
    typeof body.source === "string" && body.source.trim()
      ? body.source.trim().slice(0, 80)
      : null;
  const preferredLanguage = body.preferredLanguage === "es" ? "es" : "en";

  if (!familyName || !phone || children.length === 0) {
    res.status(400).json({
      error: "Family name, phone, and at least one student are required.",
    });
    return;
  }

  const surveyToken = randomUUID().replace(/-/g, "");
  const [created] = await db
    .insert(tourRequestsTable)
    .values({
      schoolId,
      familyName: familyName.slice(0, 200),
      phone: phone.slice(0, 40),
      email,
      children,
      interests,
      interestSelections,
      source,
      preferredLanguage,
      surveyToken,
    })
    .returning({ id: tourRequestsTable.id });

  const childrenSummary = children
    .map((c) => `${c.name}${c.grade ? ` (Grade ${c.grade})` : ""}`)
    .join(", ");

  await db.insert(tourRequestEventsTable).values({
    schoolId,
    tourRequestId: created.id,
    staffId: null,
    eventType: "created",
    body: `Tour requested by ${familyName} for ${childrenSummary || "their family"}.`,
  });

  // Fire-and-forget notifications. Never block the family's submit on email
  // / SMS — they're best-effort and self-logging.
  void (async () => {
    try {
      const name = await schoolName(schoolId);
      // Notify group = active staff who can manage tours.
      const staff = await db
        .select()
        .from(staffTable)
        .where(and(eq(staffTable.schoolId, schoolId), eq(staffTable.active, true)));
      const recipients = staff.filter((s) => canManageTours(s));
      const emails = recipients
        .map((s) => s.email)
        .filter((e): e is string => Boolean(e));
      const phones = recipients
        .map((s) => s.cellPhone)
        .filter((p): p is string => Boolean(p));

      if (emails.length) {
        await sendNewLeadNotifyEmail({
          to: emails,
          schoolName: name,
          familyName,
          phone,
          childrenSummary: childrenSummary || "—",
          interests: interestsForEmail,
          source,
          pipelineUrl: pipelineUrlFor(req),
        });
      }
      // SMS is stubbed (AWS SNS) — logs only until SMS_ENABLED + creds set.
      if (phones.length) {
        await sendSmsBatch(
          phones,
          `New tour request at ${name}: ${familyName} (${phone}). Open PulseEDU to follow up.`,
        );
      }
      // Warm family auto-acknowledgment.
      if (email) {
        await sendFamilyAckEmail({
          to: email,
          schoolName: name,
          familyName,
          fromName: name,
          signature: `Warmly,\nThe ${name} Team`,
        });
      }
    } catch (err) {
      req.log.warn({ err }, "tour lead notification fan-out failed");
    }
  })();

  res.status(201).json({ ok: true });
});

// =============================================================================
// ADMIN ROUTES (requireStaff + canManageTours)
// =============================================================================

// ---- brag page editor ------------------------------------------------------

// GET /tours/page — current school's brag page (defaults if none yet).
router.get("/tours/page", requireStaff, requireTourManager, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const page = await loadTourPage(schoolId);
  const [settings] = await db
    .select({
      tourSmsScope: schoolSettingsTable.tourSmsScope,
      tourFirstContactHours: schoolSettingsTable.tourFirstContactHours,
      tourFollowUpBusinessDays: schoolSettingsTable.tourFollowUpBusinessDays,
      tourArchiveDays: schoolSettingsTable.tourArchiveDays,
      tourEscalationEnabled: schoolSettingsTable.tourEscalationEnabled,
      tourFamilyNurtureEnabled: schoolSettingsTable.tourFamilyNurtureEnabled,
      tourReminderLeadHours: schoolSettingsTable.tourReminderLeadHours,
    })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  res.json({
    schoolName: await schoolName(schoolId),
    schoolId,
    // School-level tour preference (lives on schoolSettings, surfaced here so
    // the Tour Admin page can manage it alongside the brag page).
    tourSmsScope: settings?.tourSmsScope ?? "all",
    // Phase 2 "never lose a lead" SLA settings (also on schoolSettings).
    tourFirstContactHours: settings?.tourFirstContactHours ?? 24,
    tourFollowUpBusinessDays: settings?.tourFollowUpBusinessDays ?? 3,
    tourArchiveDays: settings?.tourArchiveDays ?? 3,
    tourEscalationEnabled: settings?.tourEscalationEnabled ?? true,
    // Phase 3 "close the loop with families" family-nurture settings.
    tourFamilyNurtureEnabled: settings?.tourFamilyNurtureEnabled ?? false,
    tourReminderLeadHours: settings?.tourReminderLeadHours ?? 24,
    published: page?.published ?? false,
    headline: page?.headline ?? "Come See Our School",
    subheadline: page?.subheadline ?? "",
    intro: page?.intro ?? "",
    sections: page?.sections ?? [],
    checkpoints: page?.checkpoints ?? [],
    programs: page?.programs ?? [],
    electives: page?.electives ?? [],
    proudOf: page?.proudOf ?? [],
    photos: page?.photos ?? [],
    textPlacement: page?.textPlacement === "bottom" ? "bottom" : "top",
    flyers: page?.flyers ?? [],
    ctaText: page?.ctaText ?? "Request Your Tour",
    accentColor: page?.accentColor ?? "#0ea5a4",
    headerTextColor: page?.headerTextColor ?? "#ffffff",
    contactEmail: page?.contactEmail ?? null,
    contactPhone: page?.contactPhone ?? null,
  });
});

// PUT /tours/page — upsert the brag page.
router.put("/tours/page", requireStaff, requireTourManager, async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  const body = (req.body ?? {}) as Record<string, unknown>;

  const accent =
    typeof body.accentColor === "string" &&
    /^#[0-9a-fA-F]{6}$/.test(body.accentColor)
      ? body.accentColor
      : "#0ea5a4";

  const headerTextColor =
    typeof body.headerTextColor === "string" &&
    /^#[0-9a-fA-F]{6}$/.test(body.headerTextColor)
      ? body.headerTextColor
      : "#ffffff";

  const values = {
    schoolId,
    published: typeof body.published === "boolean" ? body.published : false,
    headline:
      typeof body.headline === "string" && body.headline.trim()
        ? body.headline.trim().slice(0, 200)
        : "Come See Our School",
    subheadline:
      typeof body.subheadline === "string"
        ? body.subheadline.slice(0, 300)
        : "",
    intro: typeof body.intro === "string" ? body.intro.slice(0, 4000) : "",
    sections: sanitizeSections(body.sections),
    checkpoints: sanitizeCheckpoints(body.checkpoints),
    programs: sanitizeStrings(body.programs, 40),
    electives: sanitizeStrings(body.electives, 40),
    proudOf: sanitizeStrings(body.proudOf, 40),
    photos: sanitizeStrings(body.photos, 24),
    textPlacement: (body.textPlacement === "bottom" ? "bottom" : "top") as
      | "top"
      | "bottom",
    flyers: sanitizeFlyers(body.flyers),
    ctaText:
      typeof body.ctaText === "string" && body.ctaText.trim()
        ? body.ctaText.trim().slice(0, 80)
        : "Request Your Tour",
    accentColor: accent,
    headerTextColor,
    contactEmail:
      typeof body.contactEmail === "string" && body.contactEmail.trim()
        ? body.contactEmail.trim().slice(0, 200)
        : null,
    contactPhone:
      typeof body.contactPhone === "string" && body.contactPhone.trim()
        ? body.contactPhone.trim().slice(0, 40)
        : null,
    updatedAt: new Date(),
  };

  // Claim ownership of every freshly-uploaded object (photos + flyers) for
  // this school before persisting. `bindObjectToSchool` is idempotent for
  // objects already owned by the same school, so re-saving an unchanged page
  // is a no-op. External http(s) photo URLs are skipped (not object paths).
  const objectKeys = [
    ...values.photos.filter((p) => p.startsWith("/objects/")),
    ...values.flyers.map((f) => f.key),
  ];
  for (const key of objectKeys) {
    const bound = await bindObjectToSchool(key, schoolId);
    if (!bound) {
      res.status(400).json({
        error:
          "An uploaded file could not be verified. Please re-upload it and try again.",
      });
      return;
    }
  }

  await db
    .insert(tourPagesTable)
    .values(values)
    .onConflictDoUpdate({
      target: tourPagesTable.schoolId,
      set: {
        published: values.published,
        headline: values.headline,
        subheadline: values.subheadline,
        intro: values.intro,
        sections: values.sections,
        checkpoints: values.checkpoints,
        programs: values.programs,
        electives: values.electives,
        proudOf: values.proudOf,
        photos: values.photos,
        textPlacement: values.textPlacement,
        flyers: values.flyers,
        ctaText: values.ctaText,
        accentColor: values.accentColor,
        headerTextColor: values.headerTextColor,
        contactEmail: values.contactEmail,
        contactPhone: values.contactPhone,
        updatedAt: values.updatedAt,
      },
    });

  // Persist the school-level tour SMS scope (separate table). Only 'urgent'
  // narrows alerts; anything else keeps the default 'all'.
  if ("tourSmsScope" in body) {
    const scope = body.tourSmsScope === "urgent" ? "urgent" : "all";
    await db
      .insert(schoolSettingsTable)
      .values({ schoolId, tourSmsScope: scope })
      .onConflictDoUpdate({
        target: schoolSettingsTable.schoolId,
        set: { tourSmsScope: scope },
      });
  }

  // Persist the Phase 2 SLA settings (schoolSettings). Each is clamped to a
  // sane range; only fields present in the body are touched.
  const slaSet: Partial<typeof schoolSettingsTable.$inferInsert> = {};
  const clampInt = (v: unknown, min: number, max: number, dflt: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
  };
  if ("tourFirstContactHours" in body) {
    slaSet.tourFirstContactHours = clampInt(body.tourFirstContactHours, 1, 720, 24);
  }
  if ("tourFollowUpBusinessDays" in body) {
    slaSet.tourFollowUpBusinessDays = clampInt(
      body.tourFollowUpBusinessDays,
      1,
      60,
      3,
    );
  }
  if ("tourArchiveDays" in body) {
    slaSet.tourArchiveDays = clampInt(body.tourArchiveDays, 1, 365, 3);
  }
  if ("tourEscalationEnabled" in body) {
    slaSet.tourEscalationEnabled = body.tourEscalationEnabled === true;
  }
  if ("tourFamilyNurtureEnabled" in body) {
    slaSet.tourFamilyNurtureEnabled = body.tourFamilyNurtureEnabled === true;
  }
  if ("tourReminderLeadHours" in body) {
    slaSet.tourReminderLeadHours = clampInt(body.tourReminderLeadHours, 1, 168, 24);
  }
  if (Object.keys(slaSet).length > 0) {
    await db
      .insert(schoolSettingsTable)
      .values({ schoolId, ...slaSet })
      .onConflictDoUpdate({
        target: schoolSettingsTable.schoolId,
        set: slaSet,
      });
  }

  res.json({ ok: true, publicUrl: `${publicAppOrigin(req)}/tour/${schoolId}` });
});

// ---- lead pipeline ---------------------------------------------------------

// GET /tours/requests/new-count — banner badge. MUST precede /requests/:id.
router.get(
  "/tours/requests/new-count",
  requireStaff,
  requireTourManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tourRequestsTable)
      .where(
        and(
          eq(tourRequestsTable.schoolId, schoolId),
          eq(tourRequestsTable.status, "new"),
        ),
      );
    res.json({ count: row?.count ?? 0 });
  },
);

// GET /tours/requests?status= — pipeline list with response-clock + overdue.
router.get(
  "/tours/requests",
  requireStaff,
  requireTourManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const statusFilter =
      typeof req.query.status === "string" &&
      (TOUR_STATUSES as readonly string[]).includes(req.query.status)
        ? (req.query.status as TourStatus)
        : null;

    const where = statusFilter
      ? and(
          eq(tourRequestsTable.schoolId, schoolId),
          eq(tourRequestsTable.status, statusFilter),
        )
      : eq(tourRequestsTable.schoolId, schoolId);

    const rows = await db
      .select()
      .from(tourRequestsTable)
      .where(where)
      .orderBy(desc(tourRequestsTable.createdAt));

    // Resolve assigned-owner display names in one pass.
    const staffIds = Array.from(
      new Set(rows.map((r) => r.assignedStaffId).filter((n): n is number => n != null)),
    );
    const ownerNames = new Map<number, string>();
    if (staffIds.length) {
      const owners = await db
        .select({ id: staffTable.id, name: staffTable.displayName })
        .from(staffTable)
        .where(eq(staffTable.schoolId, schoolId));
      for (const o of owners) ownerNames.set(o.id, o.name);
    }

    // Default view hides archived (long-closed) leads; ?view=archived shows
    // only them. Archive cutoff + first-contact window come from school settings.
    const view = req.query.view === "archived" ? "archived" : "active";
    const [settings] = await db
      .select({
        firstContactHours: schoolSettingsTable.tourFirstContactHours,
        archiveDays: schoolSettingsTable.tourArchiveDays,
      })
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId));
    const archiveMs = (settings?.archiveDays ?? 3) * 24 * 60 * 60 * 1000;

    const now = Date.now();
    const nowDate = new Date(now);
    const mapped = rows.map((r) => {
      // Response clock: ms from creation to first contact (or to now if still
      // un-contacted).
      const responseMs = r.firstContactedAt
        ? r.firstContactedAt.getTime() - r.createdAt.getTime()
        : now - r.createdAt.getTime();
      // Stage-aware overdue (Phase 2) via the shared overdueFor() helper — the
      // single source of truth used by the list, the detail drawer, and the
      // hourly escalation sweep, so they can never disagree on who is overdue.
      const od = overdueFor(r, settings?.firstContactHours ?? 24, nowDate);
      const overdue = od != null;
      const overdueReason = od?.reason ?? null;
      const archived =
        r.status === "closed" &&
        r.closedAt != null &&
        now - r.closedAt.getTime() > archiveMs;
      return {
        id: r.id,
        familyName: r.familyName,
        phone: r.phone,
        email: r.email,
        children: r.children,
        interests: r.interests,
        source: r.source,
        preferredLanguage: r.preferredLanguage,
        status: r.status,
        outcome: r.outcome,
        outcomeReason: r.outcomeReason,
        assignedStaffId: r.assignedStaffId,
        assignedTo: r.assignedStaffId
          ? ownerNames.get(r.assignedStaffId) ?? null
          : null,
        tourScheduledAt: r.tourScheduledAt,
        firstContactedAt: r.firstContactedAt,
        followUpDueAt: r.followUpDueAt,
        closedAt: r.closedAt,
        surveySubmittedAt: r.surveySubmittedAt,
        createdAt: r.createdAt,
        responseMs,
        overdue,
        overdueReason,
        archived,
      };
    });
    res.json(
      mapped.filter((m) => (view === "archived" ? m.archived : !m.archived)),
    );
  },
);

// GET /tours/assignable-staff — owner dropdown (notify group members).
router.get(
  "/tours/assignable-staff",
  requireStaff,
  requireTourManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = await db
      .select()
      .from(staffTable)
      .where(and(eq(staffTable.schoolId, schoolId), eq(staffTable.active, true)));
    res.json(
      staff
        // Full tour managers AND lightweight Tour Guides can own a lead.
        .filter((s) => canGuideTours(s))
        .map((s) => ({ id: s.id, name: s.displayName }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  },
);

// GET /tours/requests/:id — detail + timeline + survey.
router.get(
  "/tours/requests/:id",
  requireStaff,
  requireTourGuide,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as Request & { staff: StaffRow }).staff;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [lead] = await db
      .select()
      .from(tourRequestsTable)
      .where(
        and(
          eq(tourRequestsTable.id, id),
          eq(tourRequestsTable.schoolId, schoolId),
        ),
      );
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    if (!canAccessLead(staff, lead)) {
      res.status(403).json({ error: "Not your assigned lead" });
      return;
    }

    const events = await db
      .select()
      .from(tourRequestEventsTable)
      .where(
        and(
          eq(tourRequestEventsTable.tourRequestId, id),
          eq(tourRequestEventsTable.schoolId, schoolId),
        ),
      )
      .orderBy(asc(tourRequestEventsTable.createdAt));

    const [survey] = await db
      .select()
      .from(tourSurveysTable)
      .where(
        and(
          eq(tourSurveysTable.tourRequestId, id),
          eq(tourSurveysTable.schoolId, schoolId),
        ),
      );

    // Resolve staff display names referenced in events / assignment.
    const staffIds = Array.from(
      new Set(
        [
          lead.assignedStaffId,
          ...events.map((e) => e.staffId),
        ].filter((n): n is number => n != null),
      ),
    );
    const names = new Map<number, string>();
    if (staffIds.length) {
      const rows = await db
        .select({ id: staffTable.id, name: staffTable.displayName })
        .from(staffTable)
        .where(eq(staffTable.schoolId, schoolId));
      for (const r of rows) names.set(r.id, r.name);
    }

    // Response clock: ms from creation to first contact (or to now if
    // still un-contacted). Mirrors the list endpoint so the drawer shows
    // the same value instead of NaN.
    const responseMs = lead.firstContactedAt
      ? lead.firstContactedAt.getTime() - lead.createdAt.getTime()
      : Date.now() - lead.createdAt.getTime();
    // Stage-aware overdue via the shared overdueFor() helper, so the drawer
    // agrees with the pipeline list and the escalation sweep.
    const [detailSettings] = await db
      .select({ firstContactHours: schoolSettingsTable.tourFirstContactHours })
      .from(schoolSettingsTable)
      .where(eq(schoolSettingsTable.schoolId, schoolId));
    const od = overdueFor(
      lead,
      detailSettings?.firstContactHours ?? 24,
      new Date(),
    );
    const overdue = od != null;
    const overdueReason = od?.reason ?? null;

    // Resolve the family's checkpoint selections to their current labels, in
    // the page's checkpoint order. Stops deleted since they were selected fall
    // away naturally (their key no longer matches a configured checkpoint).
    const detailPage = await loadTourPage(schoolId);
    const selectedSet = new Set(lead.interestSelections ?? []);
    const selectedCheckpoints = (detailPage?.checkpoints ?? [])
      .filter((c) => selectedSet.has(c.key))
      .map((c) => c.label);

    res.json({
      lead: {
        ...lead,
        assignedTo: lead.assignedStaffId
          ? names.get(lead.assignedStaffId) ?? null
          : null,
        responseMs,
        overdue,
        overdueReason,
        selectedCheckpoints,
        surveyUrl: surveyUrlFor(lead.surveyToken, req),
      },
      events: events.map((e) => ({
        ...e,
        staffName: e.staffId ? names.get(e.staffId) ?? null : null,
      })),
      survey: survey ?? null,
    });
  },
);

// Resolve a fresh "Still deciding" follow-up due date from the school's
// configured business-day window (defaults to 3 if the row is missing).
async function followUpDueDate(schoolId: number): Promise<Date> {
  const [s] = await db
    .select({ days: schoolSettingsTable.tourFollowUpBusinessDays })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId));
  return addBusinessDays(new Date(), s?.days ?? 3);
}

// PATCH /tours/requests/:id — status / assignment / outcome / schedule.
router.patch(
  "/tours/requests/:id",
  requireStaff,
  requireTourManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as Request & { staff: StaffRow }).staff;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [lead] = await db
      .select()
      .from(tourRequestsTable)
      .where(
        and(
          eq(tourRequestsTable.id, id),
          eq(tourRequestsTable.schoolId, schoolId),
        ),
      );
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates: Partial<typeof tourRequestsTable.$inferInsert> = {};
    const events: { eventType: string; body: string }[] = [];
    // Set when this PATCH (re)assigns the lead to a real staff member, so we
    // can fire the assignee notification AFTER the transaction commits.
    let assignmentNotify: {
      assigneeStaffId: number;
      assigneeName: string;
      assigneeEmail: string | null;
      assigneeCell: string | null;
    } | null = null;

    // Status change.
    if (
      typeof body.status === "string" &&
      (TOUR_STATUSES as readonly string[]).includes(body.status) &&
      body.status !== lead.status
    ) {
      const next = body.status as TourStatus;
      updates.status = next;
      events.push({
        eventType: "status_change",
        body: `Status: ${lead.status} → ${next}.`,
      });
      // Moving off "new" the first time stamps the response clock.
      if (next !== "new" && !lead.firstContactedAt) {
        updates.firstContactedAt = new Date();
      }
      // Phase 2 lifecycle stamps tied to the new stage.
      if (next === "deciding") {
        // Entering "Still deciding" starts the business-day follow-up clock.
        updates.followUpDueAt = await followUpDueDate(schoolId);
        // Phase 3: re-arm the family deciding-nudge for this fresh cycle.
        updates.familyDecidingNudgeSentAt = null;
      } else if (lead.status === "deciding") {
        // Leaving "Still deciding" clears the follow-up clock.
        updates.followUpDueAt = null;
      }
      if (next === "closed") {
        updates.closedAt = new Date();
        updates.followUpDueAt = null;
      } else if (lead.status === "closed") {
        // Re-opening a closed lead clears the archive clock.
        updates.closedAt = null;
      }
      // Any staff-driven stage change re-arms the escalation job so the next
      // applicable overdue condition fires a fresh nudge.
      updates.lastEscalatedAt = null;
      updates.lastEscalatedReason = null;
    }

    // Assignment.
    if ("assignedStaffId" in body) {
      const raw = body.assignedStaffId;
      const nextId =
        raw === null || raw === undefined ? null : Number(raw);
      if (nextId !== null && !Number.isInteger(nextId)) {
        res.status(400).json({ error: "Invalid assignee" });
        return;
      }
      if (nextId !== lead.assignedStaffId) {
        updates.assignedStaffId = nextId;
        let assigneeName = "Unassigned";
        if (nextId !== null) {
          const [a] = await db
            .select({
              name: staffTable.displayName,
              email: staffTable.email,
              cell: staffTable.cellPhone,
            })
            .from(staffTable)
            .where(
              and(eq(staffTable.id, nextId), eq(staffTable.schoolId, schoolId)),
            );
          if (!a) {
            res.status(400).json({ error: "Assignee not in this school" });
            return;
          }
          assigneeName = a.name;
          assignmentNotify = {
            assigneeStaffId: nextId,
            assigneeName: a.name,
            assigneeEmail: a.email ?? null,
            assigneeCell: a.cell ?? null,
          };
        }
        events.push({
          eventType: "assignment",
          body: `Owner: ${assigneeName}.`,
        });
      }
    }

    // Scheduled time.
    if ("tourScheduledAt" in body) {
      const raw = body.tourScheduledAt;
      if (raw === null) {
        updates.tourScheduledAt = null;
      } else if (typeof raw === "string") {
        const d = new Date(raw);
        if (Number.isNaN(d.getTime())) {
          res.status(400).json({ error: "Invalid tour date" });
          return;
        }
        updates.tourScheduledAt = d;
        // Only log a timeline event when the scheduled time actually
        // changes, so re-saving the same value (or the client committing
        // an unchanged field) does not spam duplicate "scheduled" entries.
        const prev = lead.tourScheduledAt?.getTime() ?? null;
        if (prev !== d.getTime()) {
          events.push({
            eventType: "scheduled",
            body: `Tour scheduled for ${d.toLocaleString("en-US")}.`,
          });
        }
        // Scheduling also counts as first contact if not yet set.
        if (!lead.firstContactedAt) updates.firstContactedAt = new Date();
      }
    }

    // Outcome. enrolled|chose_other are TERMINAL (close + start the archive
    // clock). "deciding" is no longer a terminal outcome — it maps to the live
    // "Still deciding" stage with a follow-up clock (back-compat for any client
    // that still posts outcome:'deciding'; the Phase 2 UI drives it via status).
    if ("outcome" in body) {
      const raw = body.outcome;
      const reason =
        typeof body.outcomeReason === "string"
          ? body.outcomeReason.slice(0, 1000)
          : null;
      if (raw === null) {
        updates.outcome = null;
        updates.outcomeReason = null;
      } else if (raw === "deciding") {
        // Live holding stage, not a close.
        updates.outcome = null;
        updates.outcomeReason = reason;
        updates.followUpDueAt = await followUpDueDate(schoolId);
        updates.closedAt = null;
        updates.lastEscalatedAt = null;
        updates.lastEscalatedReason = null;
        // Phase 3: re-arm the family deciding-nudge for this fresh cycle.
        updates.familyDecidingNudgeSentAt = null;
        if (lead.status !== "deciding") {
          updates.status = "deciding";
          events.push({
            eventType: "status_change",
            body: `Status: ${lead.status} → deciding.`,
          });
        }
      } else if (
        typeof raw === "string" &&
        (TOUR_OUTCOMES as readonly string[]).includes(raw)
      ) {
        updates.outcome = raw as TourOutcome;
        updates.outcomeReason = reason;
        // Recording a terminal outcome closes the lead + starts the archive clock.
        updates.status = "closed";
        updates.closedAt = new Date();
        updates.followUpDueAt = null;
        events.push({
          eventType: "outcome",
          body: `Outcome: ${raw}${
            updates.outcomeReason ? ` — ${updates.outcomeReason}` : ""
          }.`,
        });
      } else {
        res.status(400).json({ error: "Invalid outcome" });
        return;
      }
    }

    if (Object.keys(updates).length === 0) {
      res.json({ ok: true, unchanged: true });
      return;
    }

    updates.updatedAt = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(tourRequestsTable)
        .set(updates)
        .where(
          and(
            eq(tourRequestsTable.id, id),
            eq(tourRequestsTable.schoolId, schoolId),
          ),
        );

      for (const ev of events) {
        await tx.insert(tourRequestEventsTable).values({
          schoolId,
          tourRequestId: id,
          staffId: staff.id,
          eventType: ev.eventType as never,
          body: ev.body,
        });
      }
    });

    // Assignment notification (fire-and-forget). When a lead gains a new
    // owner, alert the assignee directly (email always; SMS gated by the
    // school's tour SMS scope) and CC the principals/admins for oversight.
    // Best-effort: failures are logged, never block the PATCH response.
    if (assignmentNotify) {
      const notify = assignmentNotify;
      void (async () => {
        try {
          const name = await schoolName(schoolId);
          // Principals/admins to CC (excluding the assignee themselves).
          const admins = await db
            .select({
              email: staffTable.email,
              isAdmin: staffTable.isAdmin,
              id: staffTable.id,
            })
            .from(staffTable)
            .where(
              and(
                eq(staffTable.schoolId, schoolId),
                eq(staffTable.active, true),
                eq(staffTable.isAdmin, true),
              ),
            );
          const ccEmails = admins
            .filter((a) => a.id !== notify.assigneeStaffId)
            .map((a) => a.email)
            .filter((e): e is string => Boolean(e));

          const childrenSummary =
            lead.children
              .map((c) => `${c.name}${c.grade ? ` (Grade ${c.grade})` : ""}`)
              .join(", ") || "—";

          if (notify.assigneeEmail) {
            await sendLeadAssignedEmail({
              to: notify.assigneeEmail,
              cc: ccEmails,
              schoolName: name,
              familyName: lead.familyName,
              phone: lead.phone,
              childrenSummary,
              assigneeName: notify.assigneeName,
              assignedByName: staff.displayName,
              pipelineUrl: pipelineUrlFor(req),
            });
          }

          // SMS only when the school's scope allows standard alerts.
          const [settings] = await db
            .select({ scope: schoolSettingsTable.tourSmsScope })
            .from(schoolSettingsTable)
            .where(eq(schoolSettingsTable.schoolId, schoolId));
          const smsAllowed = (settings?.scope ?? "all") === "all";
          if (smsAllowed && notify.assigneeCell) {
            await sendSmsBatch(
              [notify.assigneeCell],
              `You've been assigned a tour at ${name}: ${lead.familyName} (${lead.phone}). Open PulseEDU to follow up.`,
            );
          }

          // In-app record for admin oversight.
          await db.insert(adminNotificationsTable).values({
            schoolId,
            type: "tour_lead_assigned",
            payload: {
              leadId: id,
              familyName: lead.familyName,
              assigneeStaffId: notify.assigneeStaffId,
              assigneeName: notify.assigneeName,
              assignedByStaffId: staff.id,
            },
          });
        } catch (err) {
          req.log.warn({ err }, "tour assignment notification failed");
        }
      })();
    }

    res.json({ ok: true });
  },
);

// POST /tours/requests/:id/events — append a note or logged contact.
router.post(
  "/tours/requests/:id/events",
  requireStaff,
  requireTourManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as Request & { staff: StaffRow }).staff;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const [lead] = await db
      .select()
      .from(tourRequestsTable)
      .where(
        and(
          eq(tourRequestsTable.id, id),
          eq(tourRequestsTable.schoolId, schoolId),
        ),
      );
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const kind = body.eventType === "contact" ? "contact" : "note";
    const text = typeof body.body === "string" ? body.body.trim() : "";
    const channel =
      typeof body.channel === "string" &&
      ["call", "text", "email", "in_person"].includes(body.channel)
        ? body.channel
        : null;
    if (!text) {
      res.status(400).json({ error: "Note text is required" });
      return;
    }

    await db.insert(tourRequestEventsTable).values({
      schoolId,
      tourRequestId: id,
      staffId: staff.id,
      eventType: kind,
      channel,
      body: text.slice(0, 4000),
    });

    // Logging a contact stamps the response clock the first time, and — when
    // the lead is "Still deciding" — pushes the follow-up clock forward and
    // re-arms the escalation job (the owner just did the follow-up).
    const contactUpdates: Partial<typeof tourRequestsTable.$inferInsert> = {};
    if (kind === "contact" && !lead.firstContactedAt) {
      contactUpdates.firstContactedAt = new Date();
    }
    if (kind === "contact" && lead.status === "deciding") {
      contactUpdates.followUpDueAt = await followUpDueDate(schoolId);
      contactUpdates.lastEscalatedAt = null;
      contactUpdates.lastEscalatedReason = null;
      // Phase 3: logging a contact pushes the follow-up clock forward, so
      // re-arm the family deciding-nudge for the next cycle.
      contactUpdates.familyDecidingNudgeSentAt = null;
    }
    if (Object.keys(contactUpdates).length > 0) {
      contactUpdates.updatedAt = new Date();
      await db
        .update(tourRequestsTable)
        .set(contactUpdates)
        .where(
          and(
            eq(tourRequestsTable.id, id),
            eq(tourRequestsTable.schoolId, schoolId),
          ),
        );
    }

    res.status(201).json({ ok: true });
  },
);

// ---- PDFs ------------------------------------------------------------------

async function loadLeadForPdf(schoolId: number, id: number) {
  const [lead] = await db
    .select()
    .from(tourRequestsTable)
    .where(
      and(
        eq(tourRequestsTable.id, id),
        eq(tourRequestsTable.schoolId, schoolId),
      ),
    );
  return lead ?? null;
}

// GET /tours/requests/:id/brag-sheet.pdf
router.get(
  "/tours/requests/:id/brag-sheet.pdf",
  requireStaff,
  requireTourManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const lead = await loadLeadForPdf(schoolId, id);
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    let assignedTo: string | null = null;
    if (lead.assignedStaffId) {
      const [a] = await db
        .select({ name: staffTable.displayName })
        .from(staffTable)
        .where(
          and(
            eq(staffTable.id, lead.assignedStaffId),
            eq(staffTable.schoolId, schoolId),
          ),
        );
      assignedTo = a?.name ?? null;
    }
    const page = await loadTourPage(schoolId);
    const selectedSet = new Set(lead.interestSelections ?? []);
    const selectedStops = (page?.checkpoints ?? [])
      .filter((c) => selectedSet.has(c.key))
      .map((c) => c.label);
    const docBranding = await loadDistrictDocumentBranding(schoolId);
    const pdf = await buildTourBragSheetPdf({
      schoolName: await schoolName(schoolId),
      familyName: lead.familyName,
      phone: lead.phone,
      email: lead.email,
      preferredLanguage: lead.preferredLanguage,
      children: lead.children,
      selectedStops,
      interests: lead.interests,
      source: lead.source,
      status: lead.status,
      assignedTo,
      requestedAt: lead.createdAt,
      tourScheduledAt: lead.tourScheduledAt,
      districtLogo: docBranding?.logo ?? null,
      districtTagline: docBranding?.tagline ?? null,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="tour-brag-sheet-${id}.pdf"`,
    );
    res.send(pdf);
  },
);

// GET /tours/requests/:id/leave-behind.pdf
router.get(
  "/tours/requests/:id/leave-behind.pdf",
  requireStaff,
  requireTourManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const lead = await loadLeadForPdf(schoolId, id);
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    const page = await loadTourPage(schoolId);
    const docBranding = await loadDistrictDocumentBranding(schoolId);
    const pdf = await buildTourLeaveBehindPdf({
      schoolName: await schoolName(schoolId),
      familyName: lead.familyName,
      surveyUrl: surveyUrlFor(lead.surveyToken, req),
      contactEmail: page?.contactEmail ?? null,
      contactPhone: page?.contactPhone ?? null,
      accentColor: page?.accentColor ?? "#0ea5a4",
      districtLogo: docBranding?.logo ?? null,
      districtTagline: docBranding?.tagline ?? null,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="tour-post-tour-document-${id}.pdf"`,
    );
    res.send(pdf);
  },
);

// GET /tours/requests/:id/roadmap.pdf — staff-facing tour plan: prep info +
// a check-off list of the family's selected stops with note lines.
router.get(
  "/tours/requests/:id/roadmap.pdf",
  requireStaff,
  requireTourGuide,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as Request & { staff: StaffRow }).staff;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const lead = await loadLeadForPdf(schoolId, id);
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    if (!canAccessLead(staff, lead)) {
      res.status(403).json({ error: "Not your assigned lead" });
      return;
    }
    let assignedTo: string | null = null;
    if (lead.assignedStaffId) {
      const [a] = await db
        .select({ name: staffTable.displayName })
        .from(staffTable)
        .where(
          and(
            eq(staffTable.id, lead.assignedStaffId),
            eq(staffTable.schoolId, schoolId),
          ),
        );
      assignedTo = a?.name ?? null;
    }
    const page = await loadTourPage(schoolId);
    // Build the roadmap from the union of (a) the stops the family ticked and
    // (b) the school's "always include" highlights — in page order. Each stop
    // carries flags so the PDF can badge it: family pick (★), school highlight,
    // or both. This is the "Option A" walkable route the guide follows.
    const selectedSet = new Set(lead.interestSelections ?? []);
    const stops = (page?.checkpoints ?? [])
      .filter((c) => selectedSet.has(c.key) || c.alwaysInclude === true)
      .map((c) => ({
        label: c.label,
        location: c.location,
        talkingPoints: c.talkingPoints,
        minutes: c.minutes,
        familyRequested: selectedSet.has(c.key),
        schoolHighlight: c.alwaysInclude === true,
      }));
    const docBranding = await loadDistrictDocumentBranding(schoolId);
    const pdf = await buildTourRoadmapPdf({
      schoolName: await schoolName(schoolId),
      familyName: lead.familyName,
      phone: lead.phone,
      email: lead.email,
      preferredLanguage: lead.preferredLanguage,
      children: lead.children,
      status: lead.status,
      assignedTo,
      requestedAt: lead.createdAt,
      tourScheduledAt: lead.tourScheduledAt,
      contactEmail: page?.contactEmail ?? null,
      contactPhone: page?.contactPhone ?? null,
      notes: lead.interests,
      stops,
      accentColor: page?.accentColor ?? "#0ea5a4",
      districtLogo: docBranding?.logo ?? null,
      districtTagline: docBranding?.tagline ?? null,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="tour-roadmap-${id}.pdf"`,
    );
    res.send(pdf);
  },
);

// GET /tours/requests/:id/note-catcher.pdf — family-facing take-along sheet:
// general tour info + note space for each stop the family selected.
router.get(
  "/tours/requests/:id/note-catcher.pdf",
  requireStaff,
  requireTourGuide,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const staff = (req as Request & { staff: StaffRow }).staff;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const lead = await loadLeadForPdf(schoolId, id);
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    if (!canAccessLead(staff, lead)) {
      res.status(403).json({ error: "Not your assigned lead" });
      return;
    }
    const page = await loadTourPage(schoolId);
    // Include the family's picks AND the school's always-include highlights so
    // the family's take-along sheet matches the actual tour route.
    const selectedSet = new Set(lead.interestSelections ?? []);
    const stops = (page?.checkpoints ?? [])
      .filter((c) => selectedSet.has(c.key) || c.alwaysInclude === true)
      .map((c) => ({ label: c.label }));
    const docBranding = await loadDistrictDocumentBranding(schoolId);
    const pdf = await buildTourNoteCatcherPdf({
      schoolName: await schoolName(schoolId),
      familyName: lead.familyName,
      tourScheduledAt: lead.tourScheduledAt,
      contactEmail: page?.contactEmail ?? null,
      contactPhone: page?.contactPhone ?? null,
      stops,
      accentColor: page?.accentColor ?? "#0ea5a4",
      districtLogo: docBranding?.logo ?? null,
      districtTagline: docBranding?.tagline ?? null,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="tour-note-catcher-${id}.pdf"`,
    );
    res.send(pdf);
  },
);

// GET /tours/outcomes/summary — outcome → enrollment reporting rollup.
router.get(
  "/tours/outcomes/summary",
  requireStaff,
  requireTourManager,
  async (req, res) => {
    const schoolId = requireSchool(req, res);
    if (!schoolId) return;
    const rows = await db
      .select()
      .from(tourRequestsTable)
      .where(eq(tourRequestsTable.schoolId, schoolId));
    const byStatus: Record<string, number> = {};
    for (const s of TOUR_STATUSES) byStatus[s] = 0;
    const byOutcome: Record<string, number> = {};
    for (const o of TOUR_OUTCOMES) byOutcome[o] = 0;
    const bySource: Record<string, number> = {};
    let toured = 0;
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      if (r.outcome) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
      const src = r.source || "Unspecified";
      bySource[src] = (bySource[src] ?? 0) + 1;
      if (r.status === "toured" || r.status === "closed") toured += 1;
    }
    const enrolled = byOutcome["enrolled"] ?? 0;
    const conversionRate = toured > 0 ? Math.round((enrolled / toured) * 100) : 0;
    res.json({
      total: rows.length,
      byStatus,
      byOutcome,
      bySource,
      enrolled,
      toured,
      conversionRate,
    });
  },
);

export default router;
