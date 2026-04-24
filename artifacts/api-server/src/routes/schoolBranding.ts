// School Branding — per-school header gradient, logo, and color overrides
// applied to printouts, the HeartBEAT parent snapshot, and the Kiosk masthead.
//
// Routes:
//   GET  /api/school-branding              — read for the current school. Any
//                                            signed-in staffer can read.
//   PUT  /api/school-branding              — admin-only write.
//   POST /api/school-branding/logo/bind    — admin-only: bind an uploaded
//                                            object-storage logo to the
//                                            school's ACL after upload.
//
// Storage of gradient_colors is a JSON string ("[\"#aabbcc\",...]") to keep
// the schema portable — drizzle-kit's array type support varies across
// versions and we don't need SQL-level filtering on this column.
import { Router, type IRouter } from "express";
import { db, schoolBrandingTable, staffTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";
import { bindObjectToSchool } from "./storage.js";

const router: IRouter = Router();

// --- helpers -------------------------------------------------------------

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function isHex(s: unknown): s is string {
  return typeof s === "string" && HEX_RE.test(s.trim());
}

async function isAdmin(staffId: number | null | undefined): Promise<boolean> {
  if (!staffId) return false;
  const [staff] = await db
    .select({ isAdmin: staffTable.isAdmin, isSuperUser: staffTable.isSuperUser })
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  return !!staff && (staff.isAdmin || staff.isSuperUser);
}

export type BrandingResponse = {
  schoolId: number;
  gradientColors: string[];
  gradientAngle: number;
  primaryColor: string | null;
  accentColor: string | null;
  logoObjectPath: string | null;
  displayNameOverride: string | null;
  // Branded primary-action button. bgColors === [] means "not customized,
  // fall back to var(--primary)". 1 hex = solid; 2-4 hex = gradient.
  buttonRestBgColors: string[];
  buttonRestBgAngle: number;
  buttonRestText: string | null;
  buttonHoverBgColors: string[];
  buttonHoverBgAngle: number;
  buttonHoverText: string | null;
};

// Shared loader so other routers (parent portal, kiosk activation) can
// answer the same shape without duplicating the JSON parse + fallback
// behavior. Returns the canonical defaults when no row exists.
export async function loadBrandingForSchool(
  schoolId: number,
): Promise<BrandingResponse> {
  const [row] = await db
    .select({
      schoolId: schoolBrandingTable.schoolId,
      gradientColorsJson: schoolBrandingTable.gradientColorsJson,
      gradientAngle: schoolBrandingTable.gradientAngle,
      primaryColor: schoolBrandingTable.primaryColor,
      accentColor: schoolBrandingTable.accentColor,
      logoObjectPath: schoolBrandingTable.logoObjectPath,
      displayNameOverride: schoolBrandingTable.displayNameOverride,
      buttonRestBgColorsJson: schoolBrandingTable.buttonRestBgColorsJson,
      buttonRestBgAngle: schoolBrandingTable.buttonRestBgAngle,
      buttonRestText: schoolBrandingTable.buttonRestText,
      buttonHoverBgColorsJson: schoolBrandingTable.buttonHoverBgColorsJson,
      buttonHoverBgAngle: schoolBrandingTable.buttonHoverBgAngle,
      buttonHoverText: schoolBrandingTable.buttonHoverText,
    })
    .from(schoolBrandingTable)
    .where(eq(schoolBrandingTable.schoolId, schoolId));
  return rowToResponse(row ?? null, schoolId);
}

// Parse a JSON-string column holding ["#aabbcc", ...] into a clean array
// of valid 6-digit hex colors (max 4). Tolerates null/garbage by returning
// an empty array, which the client treats as "not customized".
function parseColorsJson(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[]).filter(isHex).slice(0, 4);
  } catch {
    return [];
  }
}

function rowToResponse(row: {
  schoolId: number;
  gradientColorsJson: string;
  gradientAngle: number;
  primaryColor: string | null;
  accentColor: string | null;
  logoObjectPath: string | null;
  displayNameOverride: string | null;
  buttonRestBgColorsJson: string | null;
  buttonRestBgAngle: number | null;
  buttonRestText: string | null;
  buttonHoverBgColorsJson: string | null;
  buttonHoverBgAngle: number | null;
  buttonHoverText: string | null;
} | null,
schoolId: number): BrandingResponse {
  if (!row) {
    return {
      schoolId,
      gradientColors: [],
      gradientAngle: 90,
      primaryColor: null,
      accentColor: null,
      logoObjectPath: null,
      displayNameOverride: null,
      buttonRestBgColors: [],
      buttonRestBgAngle: 90,
      buttonRestText: null,
      buttonHoverBgColors: [],
      buttonHoverBgAngle: 90,
      buttonHoverText: null,
    };
  }
  return {
    schoolId: row.schoolId,
    gradientColors: parseColorsJson(row.gradientColorsJson),
    gradientAngle: row.gradientAngle,
    primaryColor: row.primaryColor,
    accentColor: row.accentColor,
    logoObjectPath: row.logoObjectPath,
    displayNameOverride: row.displayNameOverride,
    buttonRestBgColors: parseColorsJson(row.buttonRestBgColorsJson),
    buttonRestBgAngle: row.buttonRestBgAngle ?? 90,
    buttonRestText: row.buttonRestText,
    buttonHoverBgColors: parseColorsJson(row.buttonHoverBgColorsJson),
    buttonHoverBgAngle: row.buttonHoverBgAngle ?? 90,
    buttonHoverText: row.buttonHoverText,
  };
}

// --- GET /api/school-branding -------------------------------------------
router.get("/school-branding", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  res.json(await loadBrandingForSchool(schoolId));
});

// --- PUT /api/school-branding -------------------------------------------
router.put("/school-branding", async (req, res) => {
  const schoolId = requireSchool(req, res);
  if (!schoolId) return;
  if (!(await isAdmin(req.staffId ?? null))) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;

  // gradient colors: 0-4 hex strings (0 = clear / restore default).
  // Strict validation: reject the whole payload if any entry is not a
  // valid #rrggbb, or if more than 4 entries are sent. We don't silently
  // truncate or filter — the admin should know exactly what was saved.
  let colors: string[] = [];
  if (Array.isArray(body.gradientColors)) {
    const raw = body.gradientColors as unknown[];
    if (raw.length > 4) {
      res
        .status(400)
        .json({ error: "Gradient supports at most 4 colors" });
      return;
    }
    const trimmed = raw.map((c) => (typeof c === "string" ? c.trim() : ""));
    if (!trimmed.every((c) => isHex(c))) {
      res.status(400).json({ error: "Each gradient color must be #rrggbb" });
      return;
    }
    colors = trimmed;
  }

  let angle = 90;
  if (typeof body.gradientAngle === "number" && Number.isFinite(body.gradientAngle)) {
    angle = Math.max(0, Math.min(360, Math.round(body.gradientAngle)));
  }

  // Primary / Accent: optional, but if provided must be valid hex.
  let primary: string | null = null;
  if (body.primaryColor !== undefined && body.primaryColor !== null) {
    if (!isHex(body.primaryColor)) {
      res.status(400).json({ error: "primaryColor must be #rrggbb" });
      return;
    }
    primary = (body.primaryColor as string).trim();
  }
  let accent: string | null = null;
  if (body.accentColor !== undefined && body.accentColor !== null) {
    if (!isHex(body.accentColor)) {
      res.status(400).json({ error: "accentColor must be #rrggbb" });
      return;
    }
    accent = (body.accentColor as string).trim();
  }

  let logoPath: string | null = null;
  if (typeof body.logoObjectPath === "string") {
    const trimmed = body.logoObjectPath.trim();
    if (trimmed === "") {
      logoPath = null;
    } else if (trimmed.startsWith("/objects/")) {
      const ok = await bindObjectToSchool(trimmed, schoolId);
      if (!ok) {
        res.status(403).json({ error: "Logo upload not authorized for this school" });
        return;
      }
      logoPath = trimmed;
    } else {
      res.status(400).json({ error: "Logo path must start with /objects/" });
      return;
    }
  }

  const displayNameOverride =
    typeof body.displayNameOverride === "string"
      ? body.displayNameOverride.trim().slice(0, 200) || null
      : null;

  // Branded buttons. Each side (rest, hover) accepts the same shape as the
  // header gradient: 0-4 hex colors + an angle. 0 colors means "clear, fall
  // back to the default styling." 1 color = solid, 2-4 = gradient.
  // Validation mirrors the gradient: any bad hex or > 4 entries is a 400.
  // text foreground (if provided) must be #rrggbb.
  const parseButtonSide = (
    label: string,
    bgColorsRaw: unknown,
    angleRaw: unknown,
    textRaw: unknown,
  ): {
    error?: string;
    bgColorsJson: string | null;
    angle: number;
    text: string | null;
  } => {
    let btnColors: string[] = [];
    if (Array.isArray(bgColorsRaw)) {
      const arr = bgColorsRaw as unknown[];
      if (arr.length > 4) {
        return {
          error: `${label} background supports at most 4 colors`,
          bgColorsJson: null,
          angle: 90,
          text: null,
        };
      }
      const trimmed = arr.map((c) => (typeof c === "string" ? c.trim() : ""));
      if (trimmed.length > 0 && !trimmed.every((c) => isHex(c))) {
        return {
          error: `${label} background colors must each be #rrggbb`,
          bgColorsJson: null,
          angle: 90,
          text: null,
        };
      }
      btnColors = trimmed;
    }
    let btnAngle = 90;
    if (typeof angleRaw === "number" && Number.isFinite(angleRaw)) {
      btnAngle = Math.max(0, Math.min(360, Math.round(angleRaw)));
    }
    let btnText: string | null = null;
    if (textRaw !== undefined && textRaw !== null && textRaw !== "") {
      if (!isHex(textRaw)) {
        return {
          error: `${label} text color must be #rrggbb`,
          bgColorsJson: null,
          angle: 90,
          text: null,
        };
      }
      btnText = (textRaw as string).trim();
    }
    // Empty arrays serialize to "null" (cleared) so we don't keep a stray
    // "[]" row that would still satisfy the "is set?" check downstream.
    const bgColorsJson = btnColors.length > 0 ? JSON.stringify(btnColors) : null;
    return { bgColorsJson, angle: btnAngle, text: btnText };
  };

  const rest = parseButtonSide(
    "Button rest",
    body.buttonRestBgColors,
    body.buttonRestBgAngle,
    body.buttonRestText,
  );
  if (rest.error) {
    res.status(400).json({ error: rest.error });
    return;
  }
  const hover = parseButtonSide(
    "Button hover",
    body.buttonHoverBgColors,
    body.buttonHoverBgAngle,
    body.buttonHoverText,
  );
  if (hover.error) {
    res.status(400).json({ error: hover.error });
    return;
  }

  const colorsJson = JSON.stringify(colors);

  // Upsert by schoolId (one row per school).
  const [existing] = await db
    .select({ id: schoolBrandingTable.id })
    .from(schoolBrandingTable)
    .where(eq(schoolBrandingTable.schoolId, schoolId));

  if (existing) {
    await db
      .update(schoolBrandingTable)
      .set({
        gradientColorsJson: colorsJson,
        gradientAngle: angle,
        primaryColor: primary,
        accentColor: accent,
        logoObjectPath: logoPath,
        displayNameOverride,
        buttonRestBgColorsJson: rest.bgColorsJson,
        buttonRestBgAngle: rest.angle,
        buttonRestText: rest.text,
        buttonHoverBgColorsJson: hover.bgColorsJson,
        buttonHoverBgAngle: hover.angle,
        buttonHoverText: hover.text,
        updatedAt: new Date(),
        updatedByStaffId: req.staffId ?? null,
      })
      .where(eq(schoolBrandingTable.id, existing.id));
  } else {
    await db.insert(schoolBrandingTable).values({
      schoolId,
      gradientColorsJson: colorsJson,
      gradientAngle: angle,
      primaryColor: primary,
      accentColor: accent,
      logoObjectPath: logoPath,
      displayNameOverride,
      buttonRestBgColorsJson: rest.bgColorsJson,
      buttonRestBgAngle: rest.angle,
      buttonRestText: rest.text,
      buttonHoverBgColorsJson: hover.bgColorsJson,
      buttonHoverBgAngle: hover.angle,
      buttonHoverText: hover.text,
      updatedByStaffId: req.staffId ?? null,
    });
  }

  // Return the canonical resolved row via the shared loader.
  res.json(await loadBrandingForSchool(schoolId));
});

export default router;
