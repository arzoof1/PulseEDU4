// Map a teacher's course names to a coarse department label for the
// teacher pickers. Keyword-based — anything unmatched lands in "Other"
// and an admin can clean up a course name (or we add keywords) to
// reclassify. Order matters: more specific tokens (Algebra, Geometry)
// check before the generic Math match.
//
// Single source of truth so every teacher chooser in the app groups
// identically (Teacher Roster picker, Data Chats launcher, etc.). The
// client mirrors the label set in components/teacherDepartments.ts.
// Canonical labels the client pickers know how to order/tint. Any other
// value (e.g. a free-text SIS staff.department like "Student Support")
// must be clamped or the client group-filter silently drops the teacher.
export const CANONICAL_DEPARTMENTS = new Set([
  "ELA",
  "Math",
  "Science",
  "Social Studies",
  "World Languages",
  "PE / Health",
  "Electives",
  "CTE / STEM",
  "Support",
  "Other",
]);

export function clampDepartment(raw: string | null): string | null {
  if (raw === null) return null;
  return CANONICAL_DEPARTMENTS.has(raw) ? raw : "Other";
}

export function inferDepartment(courseNames: string[]): string {
  if (courseNames.length === 0) return "Other";
  const tally = new Map<string, number>();
  for (const raw of courseNames) {
    const name = raw.toLowerCase();
    let dept = "Other";
    if (/(algebra|geometry|\bmath|pre-?calc|calculus|statistics)/.test(name)) {
      dept = "Math";
    } else if (/(\bela\b|english|language arts|reading|literature|writing)/.test(name)) {
      dept = "ELA";
    } else if (/(science|biology|chemistry|physics|earth|environmental)/.test(name)) {
      dept = "Science";
    } else if (/(social studies|history|civics|geography|economics|government|us history|world history)/.test(name)) {
      dept = "Social Studies";
    } else if (/(spanish|french|german|chinese|latin|world language)/.test(name)) {
      dept = "World Languages";
    } else if (/(\bpe\b|physical education|health|wellness)/.test(name)) {
      dept = "PE / Health";
    } else if (/(art|music|band|chorus|drama|theater|theatre|dance|media|tv|journalism|yearbook)/.test(name)) {
      dept = "Electives";
    } else if (/(ese|esol|ell|intensive|resource|support|skills)/.test(name)) {
      dept = "Support";
    } else if (/(technology|computer|coding|stem|engineering|robotics)/.test(name)) {
      dept = "CTE / STEM";
    }
    tally.set(dept, (tally.get(dept) ?? 0) + 1);
  }
  // Pick the department this teacher teaches most often; ties broken
  // by the keyword check order above via insertion order.
  let bestDept = "Other";
  let bestCount = -1;
  for (const [dept, count] of tally) {
    if (count > bestCount) {
      bestCount = count;
      bestDept = dept;
    }
  }
  return bestDept;
}
