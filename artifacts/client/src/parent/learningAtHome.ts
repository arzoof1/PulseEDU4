// Parent-side data layer for "Learning at Home" — the family mirror of the
// staff "Partnering with Parents" surface. One card per class on the child's
// read-only schedule; each card holds the PUBLISHED academic work samples a
// teacher shared for that class.
//
// studentId here is the integer students.id the portal uses. The FLEID never
// reaches the client; the only visible id is localSisId.
import { parentFetch } from "./api";

export type AcademicSubject =
  | "ela"
  | "math"
  | "social_studies"
  | "science"
  | "leader_in_me"
  | "behavior";

export interface LearningAtHomeSample {
  id: number;
  subject: AcademicSubject;
  assignmentTitle: string;
  note: string | null;
  source: "phone" | "upload";
  publishedAt: string | null;
}

export interface LearningAtHomeCard {
  sectionId: number;
  period: string | null;
  courseName: string | null;
  teacherName: string | null;
  samples: LearningAtHomeSample[];
}

export interface LearningAtHomeResponse {
  localSisId: string | null;
  cards: LearningAtHomeCard[];
}

export async function fetchLearningAtHomeCards(
  studentId: number,
): Promise<LearningAtHomeResponse> {
  const res = await parentFetch(
    `/api/parent/learning-at-home/cards?studentId=${studentId}`,
  );
  if (!res.ok) {
    const msg =
      (await res.json().catch(() => null))?.error ??
      `Could not load Learning at Home (${res.status})`;
    throw new Error(msg);
  }
  return (await res.json()) as LearningAtHomeResponse;
}

// ── "New" badge shared logic ────────────────────────────────────────────
// A card is "new" until the family opens it. We persist a per-card signature
// (newest published timestamp + sample count) in localStorage on open; if the
// live signature differs, the card is new again. The SAME helpers back both
// surfaces — the per-card badge in LearningAtHomeSection AND the Academics
// bottom-tab counter in Dashboard — so the two can never disagree on which
// cards are new.
export function learningAtHomeSeenKey(
  studentId: number,
  sectionId: number,
): string {
  return `pulseed.lah.seen.${studentId}.${sectionId}`;
}

export function learningAtHomeCardSignature(card: LearningAtHomeCard): string {
  const latest = card.samples[0]?.publishedAt ?? "";
  return `${latest}|${card.samples.length}`;
}

export function isLearningAtHomeCardNew(
  studentId: number,
  card: LearningAtHomeCard,
): boolean {
  try {
    return (
      localStorage.getItem(learningAtHomeSeenKey(studentId, card.sectionId)) !==
      learningAtHomeCardSignature(card)
    );
  } catch {
    return true;
  }
}

export function markLearningAtHomeCardSeen(
  studentId: number,
  card: LearningAtHomeCard,
): void {
  try {
    localStorage.setItem(
      learningAtHomeSeenKey(studentId, card.sectionId),
      learningAtHomeCardSignature(card),
    );
  } catch {
    // best-effort; private mode may block storage
  }
}

// Count of classes that have shared work AND are still unseen — drives the
// Academics bottom-tab badge. Empty cards are never shown, so they never count.
export function countNewLearningAtHomeCards(
  studentId: number,
  cards: LearningAtHomeCard[],
): number {
  return cards.filter(
    (c) => c.samples.length > 0 && isLearningAtHomeCardNew(studentId, c),
  ).length;
}

// Fetch a published sample's bytes as an object URL (a bare <img src> can't
// carry the Bearer token in the preview iframe). Caller revokes the URL.
export async function fetchLearningAtHomeImage(
  studentId: number,
  sampleId: number,
): Promise<{ objectUrl: string; contentType: string }> {
  const res = await parentFetch(
    `/api/parent/learning-at-home/sample/${sampleId}/image?studentId=${studentId}`,
  );
  if (!res.ok) {
    const msg =
      (await res.json().catch(() => null))?.error ??
      `Could not load this work sample (${res.status})`;
    throw new Error(msg);
  }
  const blob = await res.blob();
  return {
    objectUrl: URL.createObjectURL(blob),
    contentType: res.headers.get("Content-Type") ?? blob.type ?? "",
  };
}
