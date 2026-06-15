import type {
  PulseBrainLabLessonSummary,
  PulseBrainLabParentCard,
  PulseBrainLabGradeBand,
  PulseBrainLabGroup,
  PulseBrainLabGroupDetail,
  PulseBrainLabSession,
  PulseBrainLabSessionDetail,
  CreatePulseBrainLabGroupInput,
  CreatePulseBrainLabSessionInput,
  SetPulseBrainLabAttendanceItem,
  SetPulseBrainLabSessionGradingInput,
  SetPulseBrainLabWorkSampleGradeInput,
  PulseBrainLabWorkSample,
  PulseBrainLabUnmatchedScan,
  PulseBrainLabBatchScanResult,
  PulseBrainLabScanSource,
  PulseBrainLabHomeCard,
} from "@workspace/api-client-react";
import { authFetch } from "../../lib/authToken";

const BASE = "/api/pulse-brain-lab";

// A typeahead hit from /api/student-finder/search. Renders local_sis_id
// only — studentId (FLEID) is the join key, never shown.
export interface StudentHit {
  studentId: string;
  localSisId: string | null;
  firstName: string;
  lastName: string;
  grade: string | null;
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export async function fetchLessons(
  gradeBand?: PulseBrainLabGradeBand,
): Promise<PulseBrainLabLessonSummary[]> {
  const q = gradeBand ? `?gradeBand=${encodeURIComponent(gradeBand)}` : "";
  return asJson(await authFetch(`${BASE}/lessons${q}`));
}

export async function fetchParentCard(
  lessonKey: string,
  lang: "en" | "es",
): Promise<PulseBrainLabParentCard> {
  return asJson(
    await authFetch(`${BASE}/lessons/${lessonKey}/parent-card/${lang}`),
  );
}

export function facilitationPdfUrl(lessonKey: string): string {
  return `${BASE}/lessons/${lessonKey}/facilitation.pdf`;
}

// Stream an authed PDF to the browser as a DOWNLOAD. window.open() would
// drop the Bearer token inside the Replit preview iframe (cookie blocked)
// and a blob opened in a new tab renders blank, so we download instead.
export async function downloadPdf(
  url: string,
  filename: string,
): Promise<void> {
  const res = await authFetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `PDF failed (${res.status})`);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}

// Fetch an authed binary asset and return both an object URL (for inline
// <img>/<iframe> preview) and its content type. Caller MUST revokeObjectURL
// when done. Bearer token rides through authFetch (cookies are blocked in the
// preview iframe), which a bare <img src> could not carry.
export async function fetchObjectUrl(
  url: string,
): Promise<{ objectUrl: string; contentType: string }> {
  const res = await authFetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Preview failed (${res.status})`);
  }
  const blob = await res.blob();
  return {
    objectUrl: URL.createObjectURL(blob),
    contentType: res.headers.get("Content-Type") ?? blob.type ?? "",
  };
}

// ---- Groups ----

export async function fetchGroups(): Promise<PulseBrainLabGroup[]> {
  return asJson(await authFetch(`${BASE}/groups`));
}

export async function createGroup(
  input: CreatePulseBrainLabGroupInput,
): Promise<PulseBrainLabGroupDetail> {
  return asJson(
    await authFetch(`${BASE}/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function fetchGroup(
  groupId: number,
): Promise<PulseBrainLabGroupDetail> {
  return asJson(await authFetch(`${BASE}/groups/${groupId}`));
}

export async function deleteGroup(groupId: number): Promise<void> {
  const res = await authFetch(`${BASE}/groups/${groupId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Delete failed (${res.status})`);
  }
}

export async function addMembers(
  groupId: number,
  studentIds: string[],
): Promise<PulseBrainLabGroupDetail> {
  return asJson(
    await authFetch(`${BASE}/groups/${groupId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentIds }),
    }),
  );
}

export async function removeMember(
  groupId: number,
  studentId: string,
): Promise<PulseBrainLabGroupDetail> {
  return asJson(
    await authFetch(
      `${BASE}/groups/${groupId}/members/${encodeURIComponent(studentId)}`,
      { method: "DELETE" },
    ),
  );
}

// ---- Sessions + attendance ----

export async function fetchSessions(
  groupId: number,
): Promise<PulseBrainLabSession[]> {
  return asJson(await authFetch(`${BASE}/groups/${groupId}/sessions`));
}

export async function createSession(
  groupId: number,
  input: CreatePulseBrainLabSessionInput,
): Promise<PulseBrainLabSession> {
  return asJson(
    await authFetch(`${BASE}/groups/${groupId}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function fetchSession(
  sessionId: number,
): Promise<PulseBrainLabSessionDetail> {
  return asJson(await authFetch(`${BASE}/sessions/${sessionId}`));
}

export async function deleteSession(sessionId: number): Promise<void> {
  const res = await authFetch(`${BASE}/sessions/${sessionId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Delete failed (${res.status})`);
  }
}

export async function publishSession(
  sessionId: number,
): Promise<PulseBrainLabSessionDetail> {
  return asJson(
    await authFetch(`${BASE}/sessions/${sessionId}/publish`, {
      method: "POST",
    }),
  );
}

export async function unpublishSession(
  sessionId: number,
): Promise<PulseBrainLabSessionDetail> {
  return asJson(
    await authFetch(`${BASE}/sessions/${sessionId}/unpublish`, {
      method: "POST",
    }),
  );
}

export async function setAttendance(
  sessionId: number,
  entries: SetPulseBrainLabAttendanceItem[],
): Promise<PulseBrainLabSessionDetail> {
  return asJson(
    await authFetch(`${BASE}/sessions/${sessionId}/attendance`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries }),
    }),
  );
}

export function worksheetsPdfUrl(
  sessionId: number,
  lang: "en" | "es",
): string {
  return `${BASE}/sessions/${sessionId}/worksheets.pdf?lang=${lang}`;
}

export function worksheetReprintUrl(
  sessionId: number,
  studentId: string,
  lang: "en" | "es",
): string {
  return `${BASE}/sessions/${sessionId}/students/${encodeURIComponent(
    studentId,
  )}/worksheet.pdf?lang=${lang}`;
}

// ---- Student search ----

export async function searchStudents(q: string): Promise<StudentHit[]> {
  const res = await authFetch(
    `/api/student-finder/search?q=${encodeURIComponent(q)}`,
  );
  if (!res.ok) return [];
  const body = (await res.json()) as { students?: StudentHit[] };
  return body.students ?? [];
}

// ---- Object upload (two-step presigned PUT) ----

// Ask for a presigned PUT URL, push the bytes straight to storage (NOT via
// authFetch — never attach our auth header to the storage origin), and return
// the objectPath the scan endpoints expect.
export async function uploadObject(file: File): Promise<string> {
  const reqRes = await authFetch("/api/storage/uploads/request-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: file.name,
      size: file.size,
      contentType: file.type,
    }),
  });
  if (!reqRes.ok) throw new Error("Could not start upload");
  const { uploadURL, objectPath } = (await reqRes.json()) as {
    uploadURL: string;
    objectPath: string;
  };
  const putRes = await fetch(uploadURL, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!putRes.ok) throw new Error("Upload failed");
  return objectPath;
}

// ---- Scan / evidence ----

export async function routeScan(input: {
  token: string;
  objectPath: string;
  source: PulseBrainLabScanSource;
  pageIndex?: number;
}): Promise<PulseBrainLabWorkSample> {
  return asJson(
    await authFetch(`${BASE}/scan/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function batchScan(input: {
  objectPath: string;
  batchLabel?: string;
}): Promise<PulseBrainLabBatchScanResult> {
  return asJson(
    await authFetch(`${BASE}/scan/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function fetchUnmatched(): Promise<PulseBrainLabUnmatchedScan[]> {
  return asJson(await authFetch(`${BASE}/scan/unmatched`));
}

export async function assignUnmatched(
  scanId: number,
  sessionId: number,
  studentId: string,
): Promise<PulseBrainLabWorkSample> {
  return asJson(
    await authFetch(`${BASE}/scan/unmatched/${scanId}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, studentId }),
    }),
  );
}

export async function discardUnmatched(scanId: number): Promise<void> {
  const res = await authFetch(`${BASE}/scan/unmatched/${scanId}/discard`, {
    method: "POST",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Discard failed (${res.status})`);
  }
}

export async function fetchWorkSamples(
  sessionId: number,
): Promise<PulseBrainLabWorkSample[]> {
  return asJson(await authFetch(`${BASE}/sessions/${sessionId}/work-samples`));
}

export async function deleteWorkSample(sampleId: number): Promise<void> {
  const res = await authFetch(`${BASE}/work-samples/${sampleId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Delete failed (${res.status})`);
  }
}

// ---- Reinforce at Home (staff preview of the family-facing cards) ----

// :studentId is the canonical student_id (FLEID FK) — the join key, never shown.
export async function fetchStudentHomeCards(
  studentId: string,
): Promise<PulseBrainLabHomeCard[]> {
  return asJson(
    await authFetch(
      `${BASE}/students/${encodeURIComponent(studentId)}/home-cards`,
    ),
  );
}

export function homePacketPdfUrl(
  studentId: string,
  lessonKey: string,
  lang: "en" | "es",
): string {
  return `${BASE}/students/${encodeURIComponent(
    studentId,
  )}/packet.pdf?lessonKey=${encodeURIComponent(lessonKey)}&lang=${lang}`;
}

// Official printable per-student intervention report (every shared lesson,
// DRAFT + published). :studentId is the FLEID FK — the join key, never shown;
// the report renders local_sis_id only. Stream via downloadPdf (blob download,
// never window.open in the preview iframe).
export function studentReportPdfUrl(
  studentId: string,
  lang: "en" | "es",
): string {
  return `${BASE}/students/${encodeURIComponent(studentId)}/report.pdf?lang=${lang}`;
}

// Staff-only preview of the exact image/PDF bytes a family would receive for a
// work sample — used to eyeball scan/photo quality before sharing.
export function workSampleImageUrl(sampleId: number): string {
  return `${BASE}/work-samples/${sampleId}/image`;
}

// ---- Home Follow-Up (staff viewer of family transcripts) ----

// One parent-recorded transcript. studentId is the FLEID FK (key only, never
// shown); the UI renders studentName + localSisId.
export interface HomeResponseRecord {
  studentId: string;
  studentName: string;
  localSisId: string | null;
  promptIndex: number;
  transcript: string;
  language: string;
  updatedAt: string;
}

export interface SessionHomeResponses {
  respondedStudents: number;
  totalGroupMembers: number;
  totalResponses: number;
  records: HomeResponseRecord[];
}

export async function fetchSessionHomeResponses(
  sessionId: number,
): Promise<SessionHomeResponses> {
  return asJson(
    await authFetch(`${BASE}/sessions/${sessionId}/home-responses`),
  );
}

// Toggle whether a filed work sample is visible to the family on the
// "Reinforce at Home" card. The share flag is the single gate that exposes a
// delivered lesson to the home.
export async function setWorkSampleShare(
  sampleId: number,
  shared: boolean,
): Promise<PulseBrainLabWorkSample> {
  return asJson(
    await authFetch(`${BASE}/work-samples/${sampleId}/share`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shared }),
    }),
  );
}

// ---- Grading ----

// Configure grading for one assignment (session): mode, max score, and an
// optional official Florida benchmark tag (resolved + snapshotted server-side).
export async function setSessionGrading(
  sessionId: number,
  input: SetPulseBrainLabSessionGradingInput,
): Promise<PulseBrainLabSessionDetail> {
  return asJson(
    await authFetch(`${BASE}/sessions/${sessionId}/grading`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

// Grade one work sample (score OR participation mark, per the session's mode).
// Pass both null to clear the grade.
export async function setWorkSampleGrade(
  sampleId: number,
  input: SetPulseBrainLabWorkSampleGradeInput,
): Promise<PulseBrainLabWorkSample> {
  return asJson(
    await authFetch(`${BASE}/work-samples/${sampleId}/grade`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

// A single benchmark from the global Standards Book (read-only reference).
export interface BenchmarkHit {
  code: string;
  grade: string;
  strand: string | null;
  statement: string;
}

// Fetch the benchmark index for one subject from the global Standards Book.
// The full book body is large but static reference data; we keep only the
// benchmark index here for the picker.
export async function fetchBenchmarks(
  subject: "ela" | "math",
): Promise<BenchmarkHit[]> {
  const res = await authFetch(`/api/standards-book?subject=${subject}`);
  if (!res.ok) return [];
  const body = (await res.json()) as {
    benchmarks?: Array<{
      code: string;
      grade: string;
      strand: string | null;
      statement: string;
    }>;
  };
  return body.benchmarks ?? [];
}
