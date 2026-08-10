import { authFetch } from "./authToken";

type StudentsPage<T> = {
  items: T[];
  nextCursor: string | null;
};

type StudentsQuery = {
  q?: string;
  limit?: number;
  cursor?: string | null;
};

function studentsUrl(query: StudentsQuery): string {
  const params = new URLSearchParams();
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.limit) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  const suffix = params.toString();
  return suffix ? `/api/students?${suffix}` : "/api/students";
}

/** Normalize GET /api/students JSON (legacy array or paginated page). */
export function studentsItemsFromJson<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (
    data &&
    typeof data === "object" &&
    Array.isArray((data as StudentsPage<T>).items)
  ) {
    return (data as StudentsPage<T>).items;
  }
  return [];
}

async function readStudentsPage<T>(res: Response): Promise<StudentsPage<T>> {
  const data = await res.json();
  if (Array.isArray(data)) {
    return { items: data as T[], nextCursor: null };
  }
  return {
    items: studentsItemsFromJson<T>(data),
    nextCursor:
      typeof (data as StudentsPage<T>)?.nextCursor === "string"
        ? (data as StudentsPage<T>).nextCursor
        : null,
  };
}

export async function fetchStudentsPage<T>(
  query: StudentsQuery = {},
): Promise<StudentsPage<T>> {
  const res = await authFetch(studentsUrl(query));
  if (!res.ok) throw new Error("Failed to load students");
  return readStudentsPage<T>(res);
}

export async function fetchAllStudents<T>(): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | null = null;
  const seenCursors = new Set<string>();

  do {
    const page: StudentsPage<T> = await fetchStudentsPage<T>({
      limit: 200,
      cursor,
    });
    rows.push(...page.items);
    cursor = page.nextCursor;

    if (cursor) {
      if (seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
    }
  } while (cursor);

  return rows;
}

export async function searchStudents<T>(
  q: string,
  limit = 20,
): Promise<T[]> {
  const page = await fetchStudentsPage<T>({ q, limit });
  return page.items;
}
