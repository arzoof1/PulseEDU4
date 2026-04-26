// Per-user UI preferences. Small JSON bag stored on staff.ui_prefs that
// persists "how I like the UI" choices that should sync across devices —
// e.g. dashboard tile orderings, collapsed sections.
//
// Each feature owns its own top-level key in ui_prefs and its own
// validator below. Today: equity dashboard subgroup tile order. Add a
// new EQUITY_SUBGROUP_KEYS-style allowlist + validator + endpoint pair
// for each new pref to keep validation explicit (not "trust whatever the
// client sent").

import { Router, type IRouter } from "express";
import { db, staffTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

// --------- Equity subgroup tile order ------------------------------------

// Mirror of SubgroupKey in client/src/components/EquityDashboard.tsx.
// If you add a new subgroup there, add it here too — unknown values are
// rejected so the server doesn't quietly persist garbage.
const EQUITY_SUBGROUP_KEYS = [
  "ELL",
  "IEP",
  "504",
  "Female",
  "Male",
  "White",
  "Hispanic",
  "Black",
  "Asian",
  "Multi-Race",
  "Native",
  "Pacific",
  "Hispanic Ethnicity",
] as const;
type EquitySubgroupKey = (typeof EQUITY_SUBGROUP_KEYS)[number];
const EQUITY_SUBGROUP_SET: ReadonlySet<string> = new Set(EQUITY_SUBGROUP_KEYS);

// Top-level key inside staff.ui_prefs for this preference.
const EQUITY_ORDER_KEY = "equitySubgroupOrder";

// Validate an array-of-subgroup-keys body. Returns the cleaned array or
// an error message. Rules:
//  - must be a non-empty array of strings
//  - every entry must be a known SubgroupKey
//  - no duplicates
//  - subset is OK (we let new subgroups added later just fall to the end
//    on read), so we do NOT require length === EQUITY_SUBGROUP_KEYS.length
function validateOrder(
  raw: unknown,
): { ok: true; order: EquitySubgroupKey[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "order must be an array" };
  }
  if (raw.length === 0) {
    return { ok: false, error: "order must not be empty" };
  }
  if (raw.length > EQUITY_SUBGROUP_KEYS.length) {
    return { ok: false, error: "order has too many entries" };
  }
  const seen = new Set<string>();
  const out: EquitySubgroupKey[] = [];
  for (const v of raw) {
    if (typeof v !== "string") {
      return { ok: false, error: "order entries must be strings" };
    }
    if (!EQUITY_SUBGROUP_SET.has(v)) {
      return { ok: false, error: `unknown subgroup: ${v}` };
    }
    if (seen.has(v)) {
      return { ok: false, error: `duplicate subgroup: ${v}` };
    }
    seen.add(v);
    out.push(v as EquitySubgroupKey);
  }
  return { ok: true, order: out };
}

// Returns null if the staff row is missing OR deactivated. A live session
// could outlast a deactivation, so every prefs read/write re-checks active
// (matches the active-gate pattern used elsewhere in this codebase, e.g.
// heartbeatSettings.isAdminOrSuperUser).
async function loadPrefsIfActive(
  staffId: number,
): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ uiPrefs: staffTable.uiPrefs, active: staffTable.active })
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!row || !row.active) return null;
  // uiPrefs is non-null in the schema, but defensively coerce in case
  // a legacy row was inserted before the default landed.
  const p = row.uiPrefs;
  if (p && typeof p === "object" && !Array.isArray(p)) {
    return p as Record<string, unknown>;
  }
  return {};
}

router.get(
  "/me/ui-prefs/equity-subgroup-order",
  async (req, res): Promise<void> => {
    const staffId = req.staffId;
    if (!staffId) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const prefs = await loadPrefsIfActive(staffId);
    if (prefs === null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const raw = prefs[EQUITY_ORDER_KEY];
    // Re-validate on read so a corrupted row doesn't poison the client.
    if (raw === undefined || raw === null) {
      res.json({ order: null });
      return;
    }
    const v = validateOrder(raw);
    if (!v.ok) {
      // Stored value is bad — surface as null rather than 500ing, the
      // client will simply use the default order.
      res.json({ order: null });
      return;
    }
    res.json({ order: v.order });
  },
);

router.put(
  "/me/ui-prefs/equity-subgroup-order",
  async (req, res): Promise<void> => {
    const staffId = req.staffId;
    if (!staffId) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const v = validateOrder(body.order);
    if (!v.ok) {
      res.status(400).json({ error: v.error });
      return;
    }
    // Read-modify-write to preserve other top-level keys in ui_prefs.
    // Concurrent writes from the same user across two tabs are a known
    // last-writer-wins case — acceptable for a per-user prefs bag with
    // a single key today. If more pref keys land here later, switch to a
    // jsonb_set-style partial update to avoid cross-key clobber.
    const prefs = await loadPrefsIfActive(staffId);
    if (prefs === null) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const next = { ...prefs, [EQUITY_ORDER_KEY]: v.order };
    await db
      .update(staffTable)
      .set({ uiPrefs: next })
      .where(eq(staffTable.id, staffId));
    res.json({ order: v.order });
  },
);

export default router;
