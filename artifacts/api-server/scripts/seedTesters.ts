import { db, staffTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import bcrypt from "bcryptjs";

const PASSWORD = "PulseED-launch-2026!";

type Role = "admin" | "dean" | "behavior_specialist" | "teacher";
const testers: { name: string; email: string; role: Role }[] = [
  { name: "Brandon Wright",  email: "brandon.wright@school.local",  role: "admin" },
  { name: "Chris Clifford",  email: "chris.clifford@school.local",  role: "admin" },
  { name: "Lamon Neal",      email: "lamon.neal@school.local",      role: "behavior_specialist" },
  { name: "Carrie LaBarge",  email: "carrie.labarge@school.local",  role: "dean" },
  { name: "Kelly Smith",     email: "kelly.smith@school.local",     role: "teacher" },
  { name: "Jessica Bates",   email: "jessica.bates@school.local",   role: "teacher" },
  { name: "Shannon Brening", email: "shannon.brening@school.local", role: "teacher" },
];

function caps(role: Role) {
  const base = {
    isAdmin: false, isDean: false, isMtssCoordinator: false, isBehaviorSpecialist: false,
    isIssTeacher: false, isPbisCoordinator: false, isEseCoordinator: false,
    capHallPassesViewAll: false, capPbisManage: false, capAccommodationManage: false,
    capPulloutsVerify: false, capPulloutsReview: false, capInterventionManage: false,
    capIssDashboard: false, capManageLocations: false, capManageStaff: false,
  };
  if (role === "admin") {
    return { ...base, isAdmin: true,
      capHallPassesViewAll: true, capPbisManage: true, capAccommodationManage: true,
      capPulloutsVerify: true, capPulloutsReview: true, capInterventionManage: true,
      capIssDashboard: true, capManageLocations: true, capManageStaff: true };
  }
  if (role === "dean") {
    return { ...base, isDean: true, capPulloutsVerify: true, capInterventionManage: true };
  }
  if (role === "behavior_specialist") {
    return { ...base, isBehaviorSpecialist: true, capPulloutsReview: true, capInterventionManage: true };
  }
  return base;
}

const hash = await bcrypt.hash(PASSWORD, 10);
for (const t of testers) {
  const c = caps(t.role);
  await db.insert(staffTable).values({
    email: t.email, displayName: t.name, passwordHash: hash, active: true, ...c,
  }).onConflictDoUpdate({
    target: staffTable.email,
    set: { displayName: t.name, passwordHash: hash, active: true, ...c },
  });
  console.log(`  ✓ ${t.name} (${t.role})`);
}

const rows = await db.execute(sql`
  SELECT display_name, email, is_admin, is_dean, is_behavior_specialist, cap_manage_staff
  FROM staff WHERE email = ANY(${testers.map(t => t.email)})
  ORDER BY display_name
`);
console.table(rows.rows);
process.exit(0);
