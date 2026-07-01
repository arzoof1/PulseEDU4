// Shared teacher-picker types + department styling. Single source of
// truth so every teacher dropdown across the app groups and tints
// identically (see TeacherPicker.tsx).

export interface TeacherOpt {
  id: number;
  displayName: string | null;
  // Server-inferred department label (from course names on
  // class_sections). May be missing on older bundles, and some
  // endpoints return it explicitly null.
  department?: string | null;
}

// Canonical department sequence so the dropdowns stay consistent year
// over year regardless of insertion order.
export const DEPARTMENT_ORDER: string[] = [
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
];

// Color tints per department for the picker. Light pastel backgrounds so
// the colored rows remain legible against black option text. Chrome and
// Firefox honor inline backgroundColor on <option>; Safari ignores it
// (rows still group via <optgroup>, just without color).
export const DEPARTMENT_TINTS: Record<string, string> = {
  ELA: "#dbeafe",
  Math: "#fee2e2",
  Science: "#dcfce7",
  "Social Studies": "#fef3c7",
  "World Languages": "#ede9fe",
  "PE / Health": "#ffedd5",
  Electives: "#fce7f3",
  "CTE / STEM": "#cffafe",
  Support: "#f1f5f9",
  Other: "#ffffff",
};

export function deptOf(t: TeacherOpt): string {
  return t.department ?? "Other";
}

export function tintFor(dept: string): string {
  return DEPARTMENT_TINTS[dept] ?? "#ffffff";
}

// Departments actually present in a given teacher list, in canonical order.
export function presentDepartments(teachers: TeacherOpt[]): string[] {
  return DEPARTMENT_ORDER.filter((d) =>
    teachers.some((t) => deptOf(t) === d),
  );
}
