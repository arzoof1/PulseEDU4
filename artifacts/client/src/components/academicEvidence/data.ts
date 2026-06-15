// Client data layer for "Partnering with Parents" — the academic sibling of the
// PulseBrainLab evidence workflow. A teacher captures a student's formative work
// sample for one of their OWN class sections and shares it with the family.
//
// FLEID boundary: studentId here is the canonical students.student_id (the FK /
// join key) — never rendered. The only human-visible id is localSisId.
import { authFetch } from "../../lib/authToken";

const BASE = "/api/academic-evidence";

export type AcademicSubject = "ela" | "math";
export type AcademicSource = "phone" | "upload";

export interface SectionStudent {
  studentId: string;
  localSisId: string | null;
  name: string;
}

export interface TeacherSection {
  id: number;
  period: string | null;
  courseName: string | null;
  students: SectionStudent[];
}

export interface MySectionsResponse {
  teacherId: number;
  sections: TeacherSection[];
}

export interface WorkSample {
  id: number;
  studentId: string;
  localSisId: string | null;
  studentName: string;
  subject: AcademicSubject;
  assignmentTitle: string;
  note: string | null;
  source: AcademicSource;
  shared: boolean;
  publishedAt: string | null;
  createdAt: string;
}

// A typeahead hit from /api/student-finder/search. Renders local_sis_id only.
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

// The actor's (or, for Core Team, a chosen teacher's) class sections with their
// read-only rosters. Pass teacherId only as Core Team assisting another teacher.
export async function fetchMySections(
  teacherId?: number,
): Promise<MySectionsResponse> {
  const q = teacherId ? `?teacherId=${teacherId}` : "";
  return asJson(await authFetch(`${BASE}/my-sections${q}`));
}

export async function fetchSectionSamples(
  sectionId: number,
): Promise<WorkSample[]> {
  const body = await asJson<{ samples: WorkSample[] }>(
    await authFetch(`${BASE}/sections/${sectionId}/samples`),
  );
  return body.samples;
}

export async function createSample(input: {
  sectionId: number;
  studentId: string;
  subject: AcademicSubject;
  assignmentTitle: string;
  note?: string;
  objectPath: string;
  source: AcademicSource;
}): Promise<{ id: number }> {
  return asJson(
    await authFetch(`${BASE}/samples`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function updateSample(
  sampleId: number,
  input: { assignmentTitle?: string; note?: string | null },
): Promise<void> {
  await asJson(
    await authFetch(`${BASE}/samples/${sampleId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function publishSample(sampleId: number): Promise<void> {
  await asJson(
    await authFetch(`${BASE}/samples/${sampleId}/publish`, { method: "POST" }),
  );
}

export async function unpublishSample(sampleId: number): Promise<void> {
  await asJson(
    await authFetch(`${BASE}/samples/${sampleId}/unpublish`, {
      method: "POST",
    }),
  );
}

export async function deleteSample(sampleId: number): Promise<void> {
  await asJson(
    await authFetch(`${BASE}/samples/${sampleId}`, { method: "DELETE" }),
  );
}

// Two-step presigned upload: ask for a PUT URL, push the bytes straight to
// storage (NEVER attach our auth header to the storage origin), return the
// objectPath the create endpoint expects.
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

// Fetch the authed image/PDF bytes for a sample and return an object URL for an
// inline <img> (a bare <img src> can't carry the Bearer token in the preview
// iframe). Caller MUST revokeObjectURL when done.
export async function fetchSampleImage(
  sampleId: number,
): Promise<{ objectUrl: string; contentType: string }> {
  const res = await authFetch(`${BASE}/samples/${sampleId}/image`);
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

export interface TeacherOption {
  id: number;
  displayName: string;
  department?: string | null;
}

// Reuses the Teacher Roster teacher list: returns just the actor for non-Core
// staff, or every teaching staff member for Core Team (so they can assist).
export async function fetchTeachers(): Promise<TeacherOption[]> {
  const body = await asJson<{ teachers: TeacherOption[] }>(
    await authFetch(`/api/teacher-roster/teachers`),
  );
  return body.teachers;
}

export async function searchStudents(q: string): Promise<StudentHit[]> {
  const res = await authFetch(
    `/api/student-finder/search?q=${encodeURIComponent(q)}`,
  );
  if (!res.ok) return [];
  const body = (await res.json()) as { students?: StudentHit[] };
  return body.students ?? [];
}
