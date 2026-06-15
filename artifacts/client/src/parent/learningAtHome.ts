// Parent-side data layer for "Learning at Home" — the family mirror of the
// staff "Partnering with Parents" surface. One card per class on the child's
// read-only schedule; each card holds the PUBLISHED academic work samples a
// teacher shared for that class.
//
// studentId here is the integer students.id the portal uses. The FLEID never
// reaches the client; the only visible id is localSisId.
import { parentFetch } from "./api";

export type AcademicSubject = "ela" | "math";

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
