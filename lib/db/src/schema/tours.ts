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
    interests: text("interests").notNull().default(""),
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
