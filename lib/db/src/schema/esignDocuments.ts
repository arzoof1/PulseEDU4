import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { schoolsTable } from "./schools";
import { staffTable } from "./staff";

// Built-in document e-signing.
//
// A staff member (admin, or anyone granted `capManageEsign`) uploads a
// PDF or image, gets an unguessable share link, and a recipient (parent,
// new-hire, etc.) opens the link on a phone, signs page 1, and submits.
// The signed file flows back into the creator's list.
//
// Privacy model (per product decision):
//   - Documents are PRIVATE TO THE CREATOR: every staff-facing read/write
//     is scoped to (schoolId, createdBy). Two front-office staff with the
//     capability never see each other's documents.
//   - The two recipient endpoints are PUBLIC, authorized solely by the
//     unguessable `shareToken` (24 random bytes, base64url). The recipient
//     is an unauthenticated outside party — the token IS the access control.
//
// No student/entity tie by design: a document can be a parent permission
// slip or a new-hire onboarding form, so it stands alone.
export const esignDocumentsTable = pgTable(
  "esign_documents",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id")
      .notNull()
      .references(() => schoolsTable.id),
    // The staff member who created (and solely owns) the document.
    createdBy: integer("created_by")
      .notNull()
      .references(() => staffTable.id),
    title: text("title").notNull(),
    // 'pdf' | 'image' — drives how the signing page renders the original.
    fileType: text("file_type").notNull(),
    // The stored ORIGINAL upload, e.g. "/objects/<uuid>". Bound to the
    // creating school via the object-storage ACL ledger.
    objectPath: text("object_path").notNull(),
    // Unguessable share token (24 random bytes, base64url). Unique so the
    // public sign endpoints can look a document up without auth.
    shareToken: text("share_token").notNull(),
    // 'pending' | 'signed'.
    status: text("status").notNull().default("pending"),
    // Optional recipient email captured at create/share time. Often blank
    // (no parent email on file until the document comes back).
    recipientEmail: text("recipient_email"),
    // Filled in when the recipient submits.
    signerName: text("signer_name"),
    // The stored SIGNED file (signature burned in). Bound to the same school.
    signedObjectPath: text("signed_object_path"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    signedAt: timestamp("signed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("esign_documents_share_token_uq").on(t.shareToken),
    // Primary staff-facing list query: a creator's own documents, newest first.
    index("esign_documents_school_creator_idx").on(
      t.schoolId,
      t.createdBy,
      t.createdAt,
    ),
  ],
);
