import { parentFetch } from "./api";

// Family-safe shape of a "Reinforce at Home" card, mirroring the parent route's
// sanitizeCard output (no FLEID, no raw object key — work samples collapsed to a
// count). Strictly learning / brain-science framing; never "SEL".
export interface LocalizedText {
  en: string;
  es: string;
}

export interface ParentHomeResponse {
  id: number;
  lessonKey: string;
  sessionId: number | null;
  promptIndex: number;
  transcript: string;
  language: "en" | "es";
  createdAt: string;
  updatedAt: string;
}

export interface ParentReinforcement {
  summary: LocalizedText;
  brainIdea: string;
  askYourChild: LocalizedText[];
  whyThisWorks: LocalizedText;
  tryTogether: LocalizedText;
}

export type WorksheetResponseType = "write" | "draw" | "checklist";

export interface ParentWorksheetPrompt {
  id: string;
  text: LocalizedText;
  responseType: WorksheetResponseType;
}

// The bilingual worksheet (the activity the child did) so the family can read
// the lesson alongside the photo of the completed sheet.
export interface ParentStudentWorksheet {
  intro: LocalizedText;
  prompts: ParentWorksheetPrompt[];
}

// Family-safe reference to a completed work-sample image. Only the serial id and
// page index cross the wire; the image bytes come from the authed image route
// (which re-checks parent ownership). No FLEID, no object key.
export interface ParentWorkSampleRef {
  id: number;
  pageIndex: number;
}

// Grade/benchmark shown to the family — one entry per SHARED, graded sample
// (the server gates this in sanitizeCard). Grading is per assignment (session),
// so a multi-session lesson card can carry several entries.
export interface ParentHomeGrade {
  sessionDate: string | null;
  gradeMode: "score" | "participation";
  maxScore: number | null;
  score: number | null;
  participationMark: "check" | "x" | null;
  benchmarkCode: string | null;
  benchmarkLabel: string | null;
}

export interface ParentHomeCard {
  lessonKey: string;
  lessonTitle: string;
  skillArea: string;
  brainIdea: string;
  sessionId: number | null;
  sessionDate: string | null;
  parentReinforcement: ParentReinforcement;
  studentWorksheet: ParentStudentWorksheet;
  workSampleCount: number;
  workSamples: ParentWorkSampleRef[];
  grades: ParentHomeGrade[];
  homeResponses: ParentHomeResponse[];
}

export async function fetchParentHomeCards(
  studentId: number,
): Promise<ParentHomeCard[]> {
  const res = await parentFetch(
    `/api/parent/brain-lab/cards?studentId=${studentId}`,
  );
  if (!res.ok) {
    const msg =
      (await res.json().catch(() => null))?.error ??
      `Could not load Reinforce at Home (${res.status})`;
    throw new Error(msg);
  }
  return (await res.json()) as ParentHomeCard[];
}

// Fetch a completed work-sample image as an object URL. The session cookie is
// blocked in the Replit preview iframe, so a plain <img src> can't authenticate;
// we pull the bytes via parentFetch (Bearer token) and synthesize a blob URL.
// Caller is responsible for URL.revokeObjectURL when the image unmounts.
export async function fetchParentWorkSampleImage(
  studentId: number,
  sampleId: number,
): Promise<string> {
  const res = await parentFetch(
    `/api/parent/brain-lab/work-sample/${sampleId}/image?studentId=${studentId}`,
  );
  if (!res.ok) {
    const msg =
      (await res.json().catch(() => null))?.error ??
      `Could not load the worksheet image (${res.status})`;
    throw new Error(msg);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export async function submitParentHomeResponse(input: {
  studentId: number;
  lessonKey: string;
  sessionId: number | null;
  promptIndex: number;
  transcript: string;
  language: "en" | "es";
}): Promise<ParentHomeResponse> {
  const res = await parentFetch(`/api/parent/brain-lab/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const msg =
      (await res.json().catch(() => null))?.error ??
      `Could not save your answer (${res.status})`;
    throw new Error(msg);
  }
  return (await res.json()) as ParentHomeResponse;
}

// Authed PDF download: fetch as a blob through parentFetch (the session cookie
// is blocked inside the Replit preview iframe, so we rely on the Bearer token)
// and synthesize an <a download>. Never window.open in the iframe.
export async function downloadParentPacket(
  studentId: number,
  lessonKey: string,
  lang: "en" | "es",
): Promise<void> {
  const res = await parentFetch(
    `/api/parent/brain-lab/packet.pdf?studentId=${studentId}&lessonKey=${encodeURIComponent(
      lessonKey,
    )}&lang=${lang}`,
  );
  if (!res.ok) {
    const msg =
      (await res.json().catch(() => null))?.error ??
      `Could not download the packet (${res.status})`;
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `reinforce-at-home-${lessonKey}-${lang}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
