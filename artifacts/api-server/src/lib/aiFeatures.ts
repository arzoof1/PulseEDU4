// Global AI kill switch — deployment-level env gate plus per-school
// `aiAssist` feature licensing. All AI surfaces (Help Assistant, PulseDNA,
// watchlist consistency, mention suggest, tour translation) must consult
// these checks server-side. UI hiding alone is not sufficient.
//
// Defaults: AI stays ON (`AI_FEATURES_ENABLED` unset/true; school columns
// default TRUE) so production behavior is unchanged until explicitly disabled.

import type { RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { db, schoolSettingsTable } from "@workspace/db";
import { isFeatureEnabled } from "./featureLicensing.js";
import { isAiGloballyEnabled } from "./aiGlobalSwitch.js";

export const AI_DISABLED_ERROR = "ai_features_disabled";

/** School-scoped check for background jobs without an HTTP request. */
export async function isAiAssistEnabledForSchool(
  schoolId: number,
): Promise<boolean> {
  if (!isAiGloballyEnabled()) return false;
  const [settings] = await db
    .select({
      superOn: schoolSettingsTable.superFeatureAiAssist,
      adminOn: schoolSettingsTable.featureAiAssist,
    })
    .from(schoolSettingsTable)
    .where(eq(schoolSettingsTable.schoolId, schoolId))
    .limit(1);
  // Match seed defaults: absent row or new columns default to enabled.
  if (!settings) return true;
  return settings.superOn && settings.adminOn;
}

// Express middleware. Returns 404 when AI is off — same contract as
// `requireFeature` so unlicensed AI routes look absent, not forbidden.
// NOTE: this is a direct RequestHandler (not a factory), so it is mounted
// as `requireAiFeatures`, not `requireAiFeatures()`.
export const requireAiFeatures: RequestHandler = async (req, res, next) => {
  try {
    if (!isAiGloballyEnabled()) {
      res.status(404).json({ error: AI_DISABLED_ERROR });
      return;
    }
    const schoolId = req.schoolId;
    if (!schoolId) {
      res.status(401).json({ error: "no_school_context" });
      return;
    }
    const ok = await isFeatureEnabled(req, schoolId, "aiAssist");
    if (!ok) {
      res.status(404).json({ error: AI_DISABLED_ERROR });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
};
