import { Router, type IRouter } from "express";
import { getUncachableResendClient } from "../lib/resendClient";

const router: IRouter = Router();

const TEST_PARENT_EMAIL = "coachclifford@me.com";

router.post("/send-test-parent-email", async (req, res) => {
  const { studentName, subject, body, parentEmail } = req.body ?? {};

  if (typeof studentName !== "string" || !studentName) {
    res.status(400).json({ error: "studentName is required" });
    return;
  }

  const finalSubject =
    typeof subject === "string" && subject ? subject : "Student Activity Update";
  const finalBody = typeof body === "string" ? body : "";

  const trimmedParentEmail =
    typeof parentEmail === "string" ? parentEmail.trim() : "";
  const usedFallback = !trimmedParentEmail;
  const recipient = usedFallback ? TEST_PARENT_EMAIL : trimmedParentEmail;

  try {
    const { client, fromEmail } = await getUncachableResendClient();
    const result = await client.emails.send({
      from: fromEmail,
      to: recipient,
      subject: finalSubject,
      text: finalBody,
    });

    if (result.error) {
      console.error("[email] Resend error:", result.error);
      res.status(502).json({
        error: "Email provider rejected the request.",
        detail: result.error.message,
      });
      return;
    }

    console.log("[email] Sent via Resend to:", recipient, "id:", result.data?.id);
    res.status(200).json({
      ok: true,
      to: recipient,
      usedFallback,
      subject: finalSubject,
      body: finalBody,
      providerId: result.data?.id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[email] Send failed:", message);
    res.status(500).json({
      error: "Failed to send email.",
      detail: message,
    });
  }
});

export default router;
