import { Router, type IRouter } from "express";

const router: IRouter = Router();

const TEST_PARENT_EMAIL = "coachclifford@me.com";

router.post("/send-test-parent-email", (req, res) => {
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

  console.log("[stub email] To:", recipient);
  if (usedFallback) {
    console.log("[stub email] (no parent email on file - using test email)");
  }
  console.log("[stub email] Subject:", finalSubject);
  console.log("[stub email] Body:\n" + finalBody);

  res.status(200).json({
    ok: true,
    to: recipient,
    usedFallback,
    subject: finalSubject,
    body: finalBody,
    note: "Email send is stubbed; logged to server console only.",
  });
});

export default router;
