import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  db,
  staffTable,
  schoolSettingsTable,
  supportNotesTable,
  studentsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { getUncachableResendClient } from "../lib/resendClient";

const router: IRouter = Router();

type StaffRow = typeof staffTable.$inferSelect;

async function loadStaff(req: Request): Promise<StaffRow | null> {
  const id = req.staffId;
  if (!id) return null;
  const [s] = await db.select().from(staffTable).where(eq(staffTable.id, id));
  return s && s.active ? s : null;
}

function requireAuth() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const staff = await loadStaff(req);
    if (!staff) {
      res.status(401).json({ error: "Sign-in required" });
      return;
    }
    (req as Request & { staff: StaffRow }).staff = staff;
    next();
  };
}

function formatFromHeader(fromName: string, fromEmail: string): string {
  if (!fromName) return fromEmail;
  if (fromEmail.includes("<")) return fromEmail;
  const safeName = fromName.replace(/"/g, "'");
  return `${safeName} <${fromEmail}>`;
}

router.post(
  "/parent-email/send",
  requireAuth(),
  async (req: Request, res: Response) => {
    const staff = (req as Request & { staff: StaffRow }).staff;
    const { studentId, recipient, subject, body } = req.body ?? {};

    const sId = typeof studentId === "string" ? studentId.trim() : "";
    const to = typeof recipient === "string" ? recipient.trim() : "";
    const subj = typeof subject === "string" ? subject.trim() : "";
    const bod = typeof body === "string" ? body : "";

    if (!sId) {
      res.status(400).json({ error: "studentId is required." });
      return;
    }
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      res
        .status(400)
        .json({ error: "A valid recipient email address is required." });
      return;
    }
    if (!subj) {
      res.status(400).json({ error: "Subject is required." });
      return;
    }
    if (!bod.trim()) {
      res.status(400).json({ error: "Message body is required." });
      return;
    }

    const [student] = await db
      .select()
      .from(studentsTable)
      .where(eq(studentsTable.studentId, sId));
    if (!student) {
      res.status(404).json({ error: "Student not found." });
      return;
    }

    let providerId: string | undefined;
    let sendError: string | null = null;
    try {
      const { client, fromEmail } = await getUncachableResendClient();
      const [settings] = await db
        .select()
        .from(schoolSettingsTable)
        .limit(1);
      const fromName = settings?.fromName?.trim() || "";
      const result = await client.emails.send({
        from: formatFromHeader(fromName, fromEmail),
        to,
        subject: subj,
        text: bod,
        html: `<pre style="font-family: inherit; white-space: pre-wrap;">${bod
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")}</pre>`,
      });
      if (result.error) {
        sendError = result.error.message ?? "Resend rejected the request.";
      } else {
        providerId = result.data?.id;
      }
    } catch (e) {
      sendError = e instanceof Error ? e.message : String(e);
    }

    const preview = bod.length > 240 ? `${bod.slice(0, 240)}…` : bod;
    const status = sendError ? "failed" : "sent";
    const noteText =
      `Parent email ${status} to ${to}\n` +
      `Subject: ${subj}\n` +
      (sendError ? `Error: ${sendError}\n` : "") +
      `---\n${preview}`;

    try {
      await db.insert(supportNotesTable).values({
        studentId: sId,
        noteType: "parent_email",
        noteText,
        staffName: staff.displayName,
        createdAt: new Date().toISOString(),
      });
    } catch (logErr) {
      console.error("[parent-email] support note log failed:", logErr);
    }

    if (sendError) {
      res.status(502).json({
        ok: false,
        error: "Email provider rejected the request.",
        detail: sendError,
        to,
      });
      return;
    }

    res.status(200).json({
      ok: true,
      to,
      subject: subj,
      providerId,
    });
  },
);

export default router;
