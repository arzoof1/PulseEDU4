import { Router, type IRouter } from "express";

const router: IRouter = Router();

const TEST_PARENT_EMAIL = "coachclifford@me.com";

router.post("/send-test-parent-email", (req, res) => {
  const { studentName, subject, body } = req.body ?? {};

  if (typeof studentName !== "string" || !studentName) {
    res.status(400).json({ error: "studentName is required" });
    return;
  }

  const finalSubject =
    typeof subject === "string" && subject ? subject : "Student Activity Update";
  const finalBody = typeof body === "string" ? body : "";

  console.log("[stub email] To:", TEST_PARENT_EMAIL);
  console.log("[stub email] Subject:", finalSubject);
  console.log("[stub email] Body:\n" + finalBody);

  res.status(200).json({
    ok: true,
    to: TEST_PARENT_EMAIL,
    subject: finalSubject,
    body: finalBody,
    note: "Email send is stubbed; logged to server console only.",
  });
});

export default router;
