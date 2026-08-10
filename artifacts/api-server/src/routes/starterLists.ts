// One-click "starter pack" for a school's configurable pick lists.
//
// POST /pick-lists/load-starter (admin / SuperUser only) inserts a curated
// default set into every pick-list table for the CURRENT school, skipping
// any entry the school already has (case-insensitive name match), so it is
// safe to run on a brand-new school OR a school that already customized
// some lists. Nothing is ever updated or deleted — insert-only.
//
// The catalog below is the D. S. Parrott Middle School production set plus
// admin-approved additions for the sparse lists (negative behaviors,
// communication types, Tier 3 strategies).

import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  pbisReasonsTable,
  interventionTypesTable,
  pulloutReasonsTable,
  caseOutcomeTypesTable,
  separationReasonTagsTable,
  communicationTypesTable,
  tier3StrategyCategoriesTable,
  tier3StrategiesTable,
  staffTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireSchool } from "../lib/scope.js";

const router: IRouter = Router();

// ---- Starter catalog -------------------------------------------------

const PBIS_POSITIVE: Array<{
  name: string;
  category: string;
  defaultPoints: number;
  sortOrder: number;
}> = [
  { name: "Helpful", category: "Character", defaultPoints: 1, sortOrder: 0 },
  { name: "Kind to others", category: "Character", defaultPoints: 1, sortOrder: 1 },
  { name: "Leadership", category: "Character", defaultPoints: 2, sortOrder: 2 },
  { name: "Respectful", category: "Character", defaultPoints: 1, sortOrder: 3 },
  { name: "Responsible", category: "Character", defaultPoints: 1, sortOrder: 4 },
  { name: "On-task", category: "Effort", defaultPoints: 1, sortOrder: 0 },
  { name: "Show Sportsmanship", category: "Athletics", defaultPoints: 2, sortOrder: 0 },
  { name: "Class Participation (Spotlight)", category: "Effort", defaultPoints: 5, sortOrder: 100 },
];

const PBIS_NEGATIVE: Array<{
  name: string;
  category: string;
  sortOrder: number;
}> = [
  // Current production set
  { name: "Talk too much in class", category: "Classroom", sortOrder: 0 },
  { name: "Sleeping in Class", category: "Classroom", sortOrder: 1 },
  { name: "Off-task Behavior", category: "Classroom", sortOrder: 2 },
  { name: "Making Unnecessary Noises", category: "Classroom", sortOrder: 3 },
  { name: "Out of Seat Without Permission", category: "Classroom", sortOrder: 4 },
  { name: "Dress Code", category: "School-Wide", sortOrder: 0 },
  { name: "Cell Phone", category: "School-Wide", sortOrder: 1 },
  // Admin-approved additions
  { name: "Disrespectful to staff", category: "Classroom", sortOrder: 5 },
  { name: "Refusing to follow directions", category: "Classroom", sortOrder: 6 },
  { name: "Inappropriate language", category: "Classroom", sortOrder: 7 },
  { name: "Not prepared for class", category: "Classroom", sortOrder: 8 },
  { name: "Not completing work", category: "Classroom", sortOrder: 9 },
  { name: "Horseplay / rough play", category: "Classroom", sortOrder: 10 },
  { name: "Throwing objects", category: "Classroom", sortOrder: 11 },
  { name: "Misuse of technology", category: "Classroom", sortOrder: 12 },
];

const INTERVENTION_TYPES: string[] = [
  "Behavior Specific Praise",
  "Brain Break",
  "Brief Restorative Conversation",
  'Choice Statements ("You may work here or back at the table")',
  "Eye Contact or Gesture",
  "Loss of Classroom Privilege",
  "Movement Break",
  "Nonverbal Proximity",
  "Parent Communication",
  "Peer Partner Support",
  "Private Redirection",
  "Restating Expectations",
  "Seating Change",
  "Visual Reminder",
];

const PULLOUT_REASONS: Array<{ name: string; category: string }> = [
  { name: "Aggression / fighting", category: "Behavior" },
  { name: "Defiance", category: "Behavior" },
  { name: "Disruption", category: "Behavior" },
  { name: "Excessive talking", category: "Behavior" },
  { name: "Inappropriate language", category: "Behavior" },
  { name: "Not following directions", category: "Behavior" },
  { name: "Phone misuse", category: "Behavior" },
  { name: "Refusing to work", category: "Behavior" },
  { name: "Verbal disrespect", category: "Behavior" },
  { name: "Counseling", category: "Mental Health" },
  { name: "Other", category: "General" },
];

// Matches the DEFAULT_CASE_OUTCOMES catalog codes in watchlist.ts (which
// already seeds on first read). Included here so the starter button also
// covers schools where that lazy seed hasn't fired; skip-by-code keeps it
// idempotent with that seeder.
const CASE_OUTCOMES: Array<{
  code: string;
  label: string;
  description: string;
  sortOrder: number;
}> = [
  { code: "no_action", label: "No action needed", description: "Investigated; no behavioral consequence warranted.", sortOrder: 10 },
  { code: "conflict_resolution", label: "Conflict resolution", description: "Mediated conversation between the involved students; agreement reached.", sortOrder: 20 },
  { code: "mediation", label: "Restorative mediation", description: "Structured restorative session with a facilitator; documented agreement on file.", sortOrder: 30 },
  { code: "parent_contact", label: "Parent contact", description: "Parent/guardian notified; handled in coordination with the family.", sortOrder: 40 },
  { code: "office_referral", label: "Office referral", description: "Referred to administration for disciplinary follow-up.", sortOrder: 50 },
  { code: "iss_assigned", label: "ISS assigned", description: "In-school suspension assigned.", sortOrder: 60 },
  { code: "oss_assigned", label: "OSS assigned", description: "Out-of-school suspension assigned.", sortOrder: 70 },
  { code: "safety_plan_update", label: "Safety plan updated", description: "Student safety plan revised based on the findings.", sortOrder: 80 },
  { code: "other", label: "Other (note required)", description: "Requires a written note describing what happened.", sortOrder: 99 },
];

const SEPARATION_TAGS: string[] = [
  "Verbal conflict",
  "Physical altercation history",
  "Bullying / target dynamic",
  "Negative peer influence",
  "Disruptive when together",
  "Off-task when paired",
  "Romantic relationship",
  "Family conflict (siblings / cousins)",
  "Cliques / exclusion behavior",
  "Cheating / academic integrity concern",
  "Safety concern",
  "Prior administrative referral together",
];

const COMMUNICATION_TYPES: string[] = [
  "Phone",
  "Email",
  "Parent Square",
  // Admin-approved additions
  "Text Message",
  "In-Person Conference",
  "Note Sent Home",
];

const TIER3_CATEGORIES: Array<{ name: string; sortOrder: number; strategies: string[] }> = [
  {
    name: "Preventative Procedures",
    sortOrder: 0,
    strategies: [
      "Scheduled check-in with trusted adult",
      "Pre-correction before transitions",
      "Modified seating / environment",
      "Visual schedule or checklist",
    ],
  },
  {
    name: "Replacement Behavior Procedures",
    sortOrder: 1,
    strategies: [
      "Teach and practice a replacement skill",
      "Break card / ask-for-help signal",
      "Structured choice-making",
    ],
  },
  {
    name: "Procedures to Reinforce Replacement Behavior",
    sortOrder: 2,
    strategies: [
      "Behavior-specific praise on a set schedule",
      "Point/goal tracking toward a reward",
      "Positive call or note home",
    ],
  },
];

// ---- Route -----------------------------------------------------------

const norm = (s: string) => s.trim().toLowerCase();

router.post("/pick-lists/load-starter", async (req: Request, res: Response) => {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  const [staff] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, staffId));
  if (!staff || !staff.active) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  if (!staff.isAdmin && !staff.isDistrictAdmin && !staff.isSuperUser) {
    res.status(403).json({ error: "Admin only" });
    return;
  }
  const schoolId = requireSchool(req, res);
  if (schoolId == null) return;

  const added: Record<string, number> = {};
  const skipped: Record<string, number> = {};

  await db.transaction(async (tx) => {
    // PBIS reasons (school-scope rows only; both polarities)
    {
      const existing = await tx
        .select({ name: pbisReasonsTable.name, polarity: pbisReasonsTable.polarity })
        .from(pbisReasonsTable)
        .where(eq(pbisReasonsTable.schoolId, schoolId));
      const have = new Set(existing.map((r) => `${r.polarity}:${norm(r.name)}`));
      const rows = [
        ...PBIS_POSITIVE.map((r) => ({ ...r, polarity: "positive" as const })),
        ...PBIS_NEGATIVE.map((r) => ({ ...r, defaultPoints: 1, polarity: "negative" as const })),
      ].filter((r) => !have.has(`${r.polarity}:${norm(r.name)}`));
      if (rows.length) {
        await tx.insert(pbisReasonsTable).values(
          rows.map((r) => ({
            schoolId,
            name: r.name,
            category: r.category,
            defaultPoints: r.defaultPoints,
            polarity: r.polarity,
            sortOrder: r.sortOrder,
            active: true,
            ownerScope: "school",
            ownerStaffId: null,
          })),
        );
      }
      added.pbisReasons = rows.length;
      skipped.pbisReasons = PBIS_POSITIVE.length + PBIS_NEGATIVE.length - rows.length;
    }

    // Intervention strategies
    {
      const existing = await tx
        .select({ name: interventionTypesTable.name })
        .from(interventionTypesTable)
        .where(eq(interventionTypesTable.schoolId, schoolId));
      const have = new Set(existing.map((r) => norm(r.name)));
      const rows = INTERVENTION_TYPES.filter((n) => !have.has(norm(n)));
      if (rows.length) {
        await tx
          .insert(interventionTypesTable)
          .values(rows.map((name) => ({ schoolId, name, category: "Classroom", active: true })));
      }
      added.interventionTypes = rows.length;
      skipped.interventionTypes = INTERVENTION_TYPES.length - rows.length;
    }

    // Pullout reasons
    {
      const existing = await tx
        .select({ name: pulloutReasonsTable.name })
        .from(pulloutReasonsTable)
        .where(eq(pulloutReasonsTable.schoolId, schoolId));
      const have = new Set(existing.map((r) => norm(r.name)));
      const rows = PULLOUT_REASONS.filter((r) => !have.has(norm(r.name)));
      if (rows.length) {
        await tx
          .insert(pulloutReasonsTable)
          .values(rows.map((r) => ({ schoolId, name: r.name, category: r.category, active: true })));
      }
      added.pulloutReasons = rows.length;
      skipped.pulloutReasons = PULLOUT_REASONS.length - rows.length;
    }

    // Case closure outcomes (skip by stable code)
    {
      const existing = await tx
        .select({ code: caseOutcomeTypesTable.code })
        .from(caseOutcomeTypesTable)
        .where(eq(caseOutcomeTypesTable.schoolId, schoolId));
      const have = new Set(existing.map((r) => norm(r.code)));
      const rows = CASE_OUTCOMES.filter((r) => !have.has(norm(r.code)));
      if (rows.length) {
        await tx.insert(caseOutcomeTypesTable).values(
          rows.map((r) => ({
            schoolId,
            code: r.code,
            label: r.label,
            description: r.description,
            sortOrder: r.sortOrder,
            active: true,
            createdByName: staff.displayName ?? "",
          })),
        );
      }
      added.caseOutcomes = rows.length;
      skipped.caseOutcomes = CASE_OUTCOMES.length - rows.length;
    }

    // Separation reason tags
    {
      const existing = await tx
        .select({ label: separationReasonTagsTable.label })
        .from(separationReasonTagsTable)
        .where(eq(separationReasonTagsTable.schoolId, schoolId));
      const have = new Set(existing.map((r) => norm(r.label)));
      const rows = SEPARATION_TAGS.map((label, i) => ({ label, sortOrder: i })).filter(
        (r) => !have.has(norm(r.label)),
      );
      if (rows.length) {
        await tx
          .insert(separationReasonTagsTable)
          .values(rows.map((r) => ({ schoolId, label: r.label, sortOrder: r.sortOrder, active: true })));
      }
      added.separationTags = rows.length;
      skipped.separationTags = SEPARATION_TAGS.length - rows.length;
    }

    // Communication types
    {
      const existing = await tx
        .select({ name: communicationTypesTable.name })
        .from(communicationTypesTable)
        .where(eq(communicationTypesTable.schoolId, schoolId));
      const have = new Set(existing.map((r) => norm(r.name)));
      const rows = COMMUNICATION_TYPES.map((name, i) => ({ name, sortOrder: i })).filter(
        (r) => !have.has(norm(r.name)),
      );
      if (rows.length) {
        await tx
          .insert(communicationTypesTable)
          .values(rows.map((r) => ({ schoolId, name: r.name, sortOrder: r.sortOrder, active: true })));
      }
      added.communicationTypes = rows.length;
      skipped.communicationTypes = COMMUNICATION_TYPES.length - rows.length;
    }

    // Tier 3 strategy categories + strategies
    {
      const existingCats = await tx
        .select({ id: tier3StrategyCategoriesTable.id, name: tier3StrategyCategoriesTable.name })
        .from(tier3StrategyCategoriesTable)
        .where(eq(tier3StrategyCategoriesTable.schoolId, schoolId));
      const catByName = new Map(existingCats.map((c) => [norm(c.name), c.id]));

      let catsAdded = 0;
      for (const cat of TIER3_CATEGORIES) {
        if (!catByName.has(norm(cat.name))) {
          const [inserted] = await tx
            .insert(tier3StrategyCategoriesTable)
            .values({ schoolId, name: cat.name, sortOrder: cat.sortOrder, active: true })
            .returning({ id: tier3StrategyCategoriesTable.id });
          catByName.set(norm(cat.name), inserted.id);
          catsAdded++;
        }
      }
      added.tier3Categories = catsAdded;
      skipped.tier3Categories = TIER3_CATEGORIES.length - catsAdded;

      const existingStrats = await tx
        .select({ categoryId: tier3StrategiesTable.categoryId, name: tier3StrategiesTable.name })
        .from(tier3StrategiesTable)
        .where(eq(tier3StrategiesTable.schoolId, schoolId));
      const haveStrat = new Set(existingStrats.map((s) => `${s.categoryId}:${norm(s.name)}`));

      let stratsAdded = 0;
      let stratsSkipped = 0;
      for (const cat of TIER3_CATEGORIES) {
        const categoryId = catByName.get(norm(cat.name));
        if (categoryId == null) continue;
        const rows = cat.strategies
          .map((name, i) => ({ name, sortOrder: i }))
          .filter((r) => !haveStrat.has(`${categoryId}:${norm(r.name)}`));
        stratsSkipped += cat.strategies.length - rows.length;
        if (rows.length) {
          await tx.insert(tier3StrategiesTable).values(
            rows.map((r) => ({
              schoolId,
              categoryId,
              name: r.name,
              sortOrder: r.sortOrder,
              active: true,
            })),
          );
          stratsAdded += rows.length;
        }
      }
      added.tier3Strategies = stratsAdded;
      skipped.tier3Strategies = stratsSkipped;
    }
  });

  res.json({ ok: true, added, skipped });
});

export default router;
