// Debug-only HTML preview of the dormant intervention reminder
// templates. Mounted at /api/admin/email-preview/<type>; intended for
// SuperUser eyes during the email rollout. Returns plain HTML so the
// browser can render the template inline.
//
// NOTE: this never sends mail and is safe to leave on in production —
// the templates render against canned sample data; the real audience
// resolver lives in lib/scheduler.ts (and is itself dormant until
// EMAIL_REMINDERS_ENABLED is true).
import { Router, type IRouter } from "express";
import { db, staffTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  renderTier2Morning,
  renderTier3WeeklyLoad,
  renderCoreTeamFriday,
  type EmailReminderType,
} from "../lib/emails/interventionReminders.js";

const router: IRouter = Router();

router.get("/admin/email-preview/:type", async (req, res) => {
  const staffId = req.staffId;
  if (!staffId) {
    res.status(401).type("text/plain").send("Unauthorized");
    return;
  }
  const [me] = await db.select().from(staffTable).where(eq(staffTable.id, staffId));
  if (!me?.isSuperUser) {
    res.status(403).type("text/plain").send("SuperUser only");
    return;
  }

  const kind = req.params.type as EmailReminderType;
  const ctx = {
    recipientName: me.displayName,
    schoolName: "Sample School",
    asOfDate: new Date().toISOString().slice(0, 10),
  };
  const sampleOwed = [
    { studentName: "Sample Student A", tier: 2 as const, reason: "Tier 2 daily" },
    { studentName: "Sample Student B", tier: 3 as const, reason: "Tier 3 — Mon" },
  ];
  const sampleCoreTeamRows = [
    {
      studentName: "Sample Student A",
      tier: 2 as const,
      completed: 4,
      expected: 5,
      teacherCount: 1,
    },
    {
      studentName: "Sample Student B",
      tier: 3 as const,
      completed: 3,
      expected: 5,
      teacherCount: 2,
    },
  ];

  let rendered: { subject: string; html: string };
  switch (kind) {
    case "tier2-morning":
      rendered = renderTier2Morning(ctx, sampleOwed);
      break;
    case "tier3-weekly-load":
      rendered = renderTier3WeeklyLoad(ctx, sampleOwed);
      break;
    case "core-team-friday":
      rendered = renderCoreTeamFriday(ctx, sampleCoreTeamRows);
      break;
    default:
      res.status(404).type("text/plain").send("Unknown preview type");
      return;
  }

  res
    .type("text/html")
    .send(
      `<div style="background:#f1f5f9;padding:1rem;font-family:system-ui">
         <div style="margin-bottom:0.5rem;font-size:0.85rem;color:#64748b">
           Preview — type=<strong>${kind}</strong> ·
           subject=<em>${rendered.subject.replace(/</g, "&lt;")}</em>
         </div>
         <div style="background:white;padding:1rem;border:1px solid #e2e8f0;border-radius:6px">
           ${rendered.html}
         </div>
       </div>`,
    );
});

export default router;
