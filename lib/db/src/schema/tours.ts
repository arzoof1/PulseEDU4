import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// --------------------------------------------------------------------------
// School Tours — public-facing enrollment "brag page" + lead pipeline.
//
// Multi-tenant: every table carries school_id and every query MUST filter on
// it. The public brag page and tour-request form are UNAUTHENTICATED (the
// whole point is a frictionless link a family can open from Facebook/a
// flyer QR), so the school is identified by the numeric school_id in the
// public URL — the same approach signage TVs use (`?schoolId=`).
// --------------------------------------------------------------------------

// One editable "brag page" per school. Stored as a single row (read-or-create
// on first admin edit, mirroring school_settings). Free-form list sections
// are JSONB string arrays so admins can add/remove bullets without a schema
// change; richer "sections" are {title, body} blocks.
export type TourPageSection = { title: string; body: string };

// An uploaded flyer (object-storage key + display label). `kind` lets the
// public page decide how to render it: image flyers show a tappable
// thumbnail; pdf flyers show a download/view card.
export type TourFlyer = { key: string; label: string; kind: "image" | "pdf" };

// An admin-configured "tour checkpoint" (a stop on a campus tour). Families
// pick the ones they care about as checkboxes on the public request form
// (`tour_requests.interest_selections` stores the selected `key`s), and the
// staff-facing Tour Roadmap PDF turns the selected stops into a check-off
// route with location, talking points, and an estimated duration. `key` is a
// stable opaque id assigned server-side so selections survive label edits.
export type TourCheckpoint = {
  key: string;
  label: string;
  location: string;
  talkingPoints: string;
  minutes: number;
  // When true this stop is on EVERY tour (a "school highlight") regardless of
  // what the family ticked on the public form. It is not offered as a family
  // checkbox; instead the public form lists it as "always included" and the
  // staff Tour Roadmap merges it in with a "School highlight" badge. Optional /
  // defaults to false so legacy rows (no field) behave as before.
  alwaysInclude?: boolean;
};

// A machine-translated cache of the admin-authored brag-page content for one
// target language. The English columns above are always the source of truth
// and are served raw; when a family views the page in another language
// (currently only Spanish) the server generates this payload once and caches
// it on the row, keyed by language. `sourceHash` is a hash of the source
// strings the translation was produced from — when an admin edits content the
// hash changes and the cache is regenerated on the next non-English view.
// Checkpoint `key`s are preserved (selections are stored by key); only the
// `label` is translated.
export type TourTranslation = {
  sourceHash: string;
  headline: string;
  subheadline: string;
  intro: string;
  sections: TourPageSection[];
  checkpoints: { key: string; label: string }[];
  programs: string[];
  electives: string[];
  proudOf: string[];
  ctaText: string;
};

export const tourPagesTable = pgTable(
  "tour_pages",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    // When false the public page returns 404 — admins draft privately then
    // flip this on to go live.
    published: boolean("published").notNull().default(false),
    headline: text("headline").notNull().default("Come See Our School"),
    subheadline: text("subheadline").notNull().default(""),
    intro: text("intro").notNull().default(""),
    // [{title, body}] narrative blocks.
    sections: jsonb("sections")
      .$type<TourPageSection[]>()
      .notNull()
      .default([]),
    // Admin-configured tour checkpoints (stops families can request on the
    // public form; staff print them as a roadmap). Order = display order.
    checkpoints: jsonb("checkpoints")
      .$type<TourCheckpoint[]>()
      .notNull()
      .default([]),
    // Machine-translated cache of the admin-authored content, keyed by target
    // language (e.g. {"es": {...}}). Generated on demand when a family views
    // the page in a non-English language and regenerated when the source
    // content changes (see TourTranslation.sourceHash). English is always
    // served raw from the columns above; this is purely a cache.
    translations: jsonb("translations")
      .$type<Record<string, TourTranslation>>()
      .notNull()
      .default({}),
    // Simple bullet lists.
    programs: jsonb("programs").$type<string[]>().notNull().default([]),
    electives: jsonb("electives").$type<string[]>().notNull().default([]),
    proudOf: jsonb("proud_of").$type<string[]>().notNull().default([]),
    // Object-storage keys for uploaded photos (school-scoped ACL). Order =
    // display order in the public carousel; index 0 is the cover. Legacy rows
    // may still hold external http(s) URLs, which the public page passes
    // through unchanged.
    photos: jsonb("photos").$type<string[]>().notNull().default([]),
    // Where the headline/intro verbiage sits relative to the photo carousel
    // on the public page: above ('top', default) or below ('bottom').
    textPlacement: text("text_placement")
      .$type<"top" | "bottom">()
      .notNull()
      .default("top"),
    // Uploaded flyers (object-storage keys + labels), shown in their own
    // section lower on the public page.
    flyers: jsonb("flyers").$type<TourFlyer[]>().notNull().default([]),
    ctaText: text("cta_text").notNull().default("Request Your Tour"),
    accentColor: text("accent_color").notNull().default("#0ea5a4"),
    // Font color for the public hero/header text (headline, subheadline,
    // school name). Defaults to white, which reads well on the accent-colored
    // hero gradient; admins can override when their accent needs darker text.
    headerTextColor: text("header_text_color").notNull().default("#ffffff"),
    contactEmail: text("contact_email"),
    contactPhone: text("contact_phone"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("tour_pages_school_id_unique").on(t.schoolId)],
);

// A lead. Created by the public form; worked through the pipeline by staff.
export type TourChild = { name: string; grade: string };

export const TOUR_STATUSES = [
  "new",
  "contacted",
  "scheduled",
  "toured",
  // "Still deciding" — a LIVE holding stage (Phase 2) between a completed tour
  // and a final close. A lead here has a `follow_up_due_at` clock; the
  // background escalation job nudges the owner when it lapses. Distinct from
  // the terminal `deciding` OUTCOME on legacy rows (kept for back-compat).
  "deciding",
  "closed",
] as const;
export type TourStatus = (typeof TOUR_STATUSES)[number];

export const TOUR_OUTCOMES = ["enrolled", "deciding", "chose_other"] as const;
export type TourOutcome = (typeof TOUR_OUTCOMES)[number];

export const tourRequestsTable = pgTable(
  "tour_requests",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    familyName: text("family_name").notNull(),
    phone: text("phone").notNull(),
    email: text("email"),
    // Sibling-aware: [{name, grade}], at least one.
    children: jsonb("children").$type<TourChild[]>().notNull().default([]),
    // Free-text "anything else?" note from the family (optional).
    interests: text("interests").notNull().default(""),
    // Keys of the admin-configured tour checkpoints the family ticked on the
    // public form. Validated against the page's checkpoint keys at submit time.
    interestSelections: jsonb("interest_selections")
      .$type<string[]>()
      .notNull()
      .default([]),
    // Marketing source tag from the public link (e.g. "facebook", "flyer").
    source: text("source"),
    // 'en' | 'es' — which language the family submitted in.
    preferredLanguage: text("preferred_language").notNull().default("en"),
    status: text("status").$type<TourStatus>().notNull().default("new"),
    outcome: text("outcome").$type<TourOutcome | null>(),
    outcomeReason: text("outcome_reason"),
    assignedStaffId: integer("assigned_staff_id"),
    tourScheduledAt: timestamp("tour_scheduled_at", { withTimezone: true }),
    // Set the first time a staff member logs a "contact" event — powers the
    // response-time clock + the >24h escalation flag.
    firstContactedAt: timestamp("first_contacted_at", { withTimezone: true }),
    // Phase 2 lead-rescue lifecycle.
    //   followUpDueAt — set when a lead is moved to "Still deciding"; the next
    //     follow-up is due at this time. Drives the board countdown + the
    //     deciding-overdue branch of the escalation job. Logging a contact on a
    //     deciding lead pushes it forward and clears the escalation stamp.
    //   closedAt — stamped when the lead moves to 'closed'; drives auto-archive.
    //   lastEscalatedAt / lastEscalatedReason — idempotency for the background
    //     escalation job: it re-nudges at most once per re-nudge window and
    //     immediately when the reason changes (e.g. new→scheduled→deciding).
    followUpDueAt: timestamp("follow_up_due_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    lastEscalatedAt: timestamp("last_escalated_at", { withTimezone: true }),
    lastEscalatedReason: text("last_escalated_reason"),
    // Phase 3 "close the loop with families" — idempotency stamps for the
    // automated FAMILY-facing nurture cadence (separate from the staff
    // escalation stamps above). Each is set only after a successful send so a
    // transient email failure is retried on the next sweep.
    //   familyReminderSentAt    — pre-tour reminder (day before tourScheduledAt)
    //   familyThankYouSentAt    — post-tour thank-you + survey link (on "toured")
    //   familyDecidingNudgeSentAt — gentle "still deciding" nudge; cleared
    //     whenever the deciding follow-up clock is (re)armed so a fresh
    //     deciding cycle can nudge again.
    //   familyWelcomeSentAt     — enrollment welcome (on close w/ outcome enrolled)
    familyReminderSentAt: timestamp("family_reminder_sent_at", {
      withTimezone: true,
    }),
    familyThankYouSentAt: timestamp("family_thank_you_sent_at", {
      withTimezone: true,
    }),
    familyDecidingNudgeSentAt: timestamp("family_deciding_nudge_sent_at", {
      withTimezone: true,
    }),
    familyWelcomeSentAt: timestamp("family_welcome_sent_at", {
      withTimezone: true,
    }),
    // Opaque token for the post-tour survey link (printed as a QR on the
    // leave-behind). Unique across all schools so the public survey route
    // can resolve the school from the token alone.
    surveyToken: text("survey_token").notNull(),
    surveySubmittedAt: timestamp("survey_submitted_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("tour_requests_survey_token_unique").on(t.surveyToken),
    index("tour_requests_school_status_idx").on(t.schoolId, t.status),
  ],
);

// Append-only activity timeline for a lead. Never updated or deleted.
export const TOUR_EVENT_TYPES = [
  "created",
  "note",
  "contact",
  "status_change",
  "assignment",
  "scheduled",
  "outcome",
  "survey_submitted",
  // System event written by the background escalation job when it emails the
  // owner about an overdue lead (first-contact / tour-not-logged / follow-up).
  "escalation",
] as const;
export type TourEventType = (typeof TOUR_EVENT_TYPES)[number];

export const tourRequestEventsTable = pgTable(
  "tour_request_events",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    tourRequestId: integer("tour_request_id").notNull(),
    // Null for system/public-generated events (created, survey_submitted).
    staffId: integer("staff_id"),
    eventType: text("event_type").$type<TourEventType>().notNull(),
    // For contact events: 'call' | 'text' | 'email' | 'in_person'.
    channel: text("channel"),
    body: text("body").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("tour_request_events_request_idx").on(t.tourRequestId),
  ],
);

// Post-tour survey, tied back to the originating lead (one per request).
export const tourSurveysTable = pgTable(
  "tour_surveys",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull(),
    tourRequestId: integer("tour_request_id").notNull(),
    rating: integer("rating"),
    liked: text("liked").notNull().default(""),
    questions: text("questions").notNull().default(""),
    comments: text("comments").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("tour_surveys_request_unique").on(t.tourRequestId),
  ],
);
