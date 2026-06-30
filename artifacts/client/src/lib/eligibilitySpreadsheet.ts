// Flexible column detection for Eligibility Hub spreadsheet uploads (.xlsx/.csv).
// District exports vary (Skyward "Local ID", "Other ID", "SIS ID", etc.) — we
// resolve the student-id / absence / tardy columns once per file from headers,
// then read every row by the detected keys (stable column order, no per-row guess).

export function normalizeImportHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9#_]/g, "");
}

const ID_HEADER_DENY = new Set([
  "studentfullname",
  "studentname",
  "name",
  "firstname",
  "lastname",
  "fullname",
  "grade",
  "gr",
  "homeroom",
  "teacher",
  "school",
  "year",
  "semester",
  "nbr",
  "absencetotal",
  "absence_total",
  "absences",
  "absent",
  "daysabsent",
  "days_absent",
  "daystardy",
  "days_tardy",
  "tardies",
  "tardy",
  "jersey",
  "jerseynumber",
  "jersey_number",
  "number",
]);

/** Highest-priority exact header matches for the district student number. */
const LOCAL_SIS_ID_EXACT = [
  "localsisid",
  "local_sis_id",
  "localid",
  "local_id",
  "sisid",
  "sis_id",
  "otherid",
  "other_id",
  "studentid",
  "student_id",
  "skywardid",
  "skyward_id",
  "districtid",
  "district_id",
  "id",
];

const ABSENCE_EXACT = [
  "absencetotal",
  "absence_total",
  "totalabsences",
  "absencecount",
  "absences",
  "absent",
  "daysabsent",
  "days_absent",
  "dayabsent",
];

const TARDY_EXACT = [
  "daystardy",
  "days_tardy",
  "tardydays",
  "tardies",
  "tardy",
  "tardycount",
  "daytardy",
];

const JERSEY_EXACT = ["jersey", "jerseynumber", "jersey_number", "jersey#", "#"];

function scoreLocalSisIdHeader(norm: string): number {
  if (!norm || ID_HEADER_DENY.has(norm)) return 0;
  const exactIdx = LOCAL_SIS_ID_EXACT.indexOf(norm);
  if (exactIdx >= 0) return 100 - exactIdx;
  if (norm.includes("localsis") || (norm.includes("local") && norm.endsWith("id"))) {
    return 85;
  }
  if (norm.includes("sis") && norm.endsWith("id")) return 84;
  if (norm.includes("other") && norm.endsWith("id")) return 83;
  if (norm.includes("student") && norm.endsWith("id")) return 82;
  if (norm.includes("skyward") && norm.endsWith("id")) return 81;
  if (norm.endsWith("id") && norm.length <= 16) return 55;
  return 0;
}

function scoreAbsenceHeader(norm: string): number {
  if (!norm || norm.includes("tardy")) return 0;
  const exactIdx = ABSENCE_EXACT.indexOf(norm);
  if (exactIdx >= 0) return 100 - exactIdx;
  if (norm.includes("absence")) return 70;
  if (norm.includes("absent")) return 65;
  return 0;
}

function scoreTardyHeader(norm: string): number {
  if (!norm) return 0;
  const exactIdx = TARDY_EXACT.indexOf(norm);
  if (exactIdx >= 0) return 100 - exactIdx;
  if (norm.includes("tardy") || norm.includes("tardies")) return 70;
  return 0;
}

function scoreJerseyHeader(norm: string): number {
  if (!norm) return 0;
  const exactIdx = JERSEY_EXACT.indexOf(norm);
  if (exactIdx >= 0) return 100 - exactIdx;
  if (norm.includes("jersey")) return 80;
  return 0;
}

function pickBestColumn(
  headers: string[],
  scoreFn: (norm: string) => number,
  minScore = 50,
): string | null {
  let bestHeader: string | null = null;
  let bestScore = minScore - 1;
  let bestIndex = Number.POSITIVE_INFINITY;

  for (let index = 0; index < headers.length; index++) {
    const header = headers[index]!;
    const score = scoreFn(normalizeImportHeader(header));
    if (score < minScore) continue;
    if (
      score > bestScore ||
      (score === bestScore && index < bestIndex)
    ) {
      bestHeader = header;
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestHeader;
}

export type DetectedEligibilityColumns = {
  localSisId: string | null;
  absenceTotal: string | null;
  daysTardy: string | null;
  jersey: string | null;
};

export function detectEligibilityColumns(
  sampleRow: Record<string, unknown>,
): DetectedEligibilityColumns {
  const headers = Object.keys(sampleRow);
  return {
    localSisId: pickBestColumn(headers, scoreLocalSisIdHeader),
    absenceTotal: pickBestColumn(headers, scoreAbsenceHeader),
    daysTardy: pickBestColumn(headers, scoreTardyHeader),
    jersey: pickBestColumn(headers, scoreJerseyHeader, 70),
  };
}

function cellString(row: Record<string, unknown>, header: string | null): string {
  if (!header) return "";
  const v = row[header];
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function parseNonNegativeInt(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

export type AttendanceImportRow = {
  localSisId: string;
  absenceTotal: number;
  daysTardy: number;
};

export type RosterImportRow = {
  localSisId: string;
  jerseyNumber?: string;
};

export function parseAttendanceRows(
  rows: Record<string, unknown>[],
): AttendanceImportRow[] {
  if (rows.length === 0) return [];
  const cols = detectEligibilityColumns(rows[0]!);
  if (!cols.localSisId) return [];

  const out: AttendanceImportRow[] = [];
  for (const row of rows) {
    const localSisId = cellString(row, cols.localSisId);
    if (!localSisId) continue;
    out.push({
      localSisId,
      absenceTotal: parseNonNegativeInt(cellString(row, cols.absenceTotal)),
      daysTardy: parseNonNegativeInt(cellString(row, cols.daysTardy)),
    });
  }
  return out;
}

export function parseRosterRows(
  rows: Record<string, unknown>[],
): RosterImportRow[] {
  if (rows.length === 0) return [];
  const cols = detectEligibilityColumns(rows[0]!);
  if (!cols.localSisId) return [];

  const out: RosterImportRow[] = [];
  for (const row of rows) {
    const localSisId = cellString(row, cols.localSisId);
    if (!localSisId) continue;
    const jersey = cellString(row, cols.jersey);
    out.push({
      localSisId,
      jerseyNumber: jersey || undefined,
    });
  }
  return out;
}
