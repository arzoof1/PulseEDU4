#!/usr/bin/env python3
"""Generate the DevOps handoff runbook PDF for the PulseEDU district-approval
DevOps (DO-*) tasks. No personal names, no secret values (client deliverable)."""
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table, TableStyle,
    Preformatted, PageBreak, HRFlowable, KeepTogether,
)
from reportlab.lib.enums import TA_LEFT
import html

OUT = "/Users/apple/Downloads/PulseEDU_DevOps_Runbook.pdf"

styles = getSampleStyleSheet()
BRAND = colors.HexColor("#1f4e79")
ACCENT = colors.HexColor("#2e7d32")
WARN = colors.HexColor("#b23b00")
LIGHT = colors.HexColor("#eef3f8")
CODEBG = colors.HexColor("#f4f4f4")

styles.add(ParagraphStyle("H1b", parent=styles["Heading1"], textColor=BRAND, spaceBefore=16, spaceAfter=6, fontSize=16))
styles.add(ParagraphStyle("H2b", parent=styles["Heading2"], textColor=BRAND, spaceBefore=12, spaceAfter=4, fontSize=13))
styles.add(ParagraphStyle("H3b", parent=styles["Heading3"], textColor=colors.black, spaceBefore=8, spaceAfter=3, fontSize=11))
styles.add(ParagraphStyle("Body", parent=styles["BodyText"], fontSize=9.5, leading=13, spaceAfter=5, alignment=TA_LEFT))
styles.add(ParagraphStyle("Small", parent=styles["BodyText"], fontSize=8.5, leading=11, textColor=colors.HexColor("#444444")))
styles.add(ParagraphStyle("Mono", parent=styles["Code"], fontSize=8, leading=10.5, textColor=colors.HexColor("#111111")))
styles.add(ParagraphStyle("Ev", parent=styles["BodyText"], fontSize=9, leading=12, textColor=ACCENT, leftIndent=6))
styles.add(ParagraphStyle("Cover", parent=styles["Title"], textColor=BRAND, fontSize=26, leading=30))
styles.add(ParagraphStyle("CoverSub", parent=styles["Normal"], fontSize=12, textColor=colors.HexColor("#555555"), spaceBefore=8))

story = []

def P(t, s="Body"):
    story.append(Paragraph(t, styles[s]))

def bullets(items, s="Body"):
    for it in items:
        story.append(Paragraph("• " + it, ParagraphStyle("b", parent=styles[s], leftIndent=12, spaceAfter=3)))

def code(t):
    tbl = Table([[Preformatted(t, styles["Mono"])]], colWidths=[6.7*inch])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,-1), CODEBG),
        ("BOX", (0,0), (-1,-1), 0.5, colors.HexColor("#cccccc")),
        ("LEFTPADDING", (0,0), (-1,-1), 8), ("RIGHTPADDING", (0,0), (-1,-1), 8),
        ("TOPPADDING", (0,0), (-1,-1), 6), ("BOTTOMPADDING", (0,0), (-1,-1), 6),
    ]))
    story.append(tbl); story.append(Spacer(1, 6))

def evidence(lines):
    rows = [[Paragraph("<b>Evidence to capture &amp; how to close</b>", styles["Ev"])]]
    for l in lines:
        rows.append([Paragraph("&#10003; " + l, styles["Ev"])])
    tbl = Table(rows, colWidths=[6.7*inch])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,-1), colors.HexColor("#f0f7f0")),
        ("BOX", (0,0), (-1,-1), 0.6, ACCENT),
        ("LEFTPADDING", (0,0), (-1,-1), 8), ("RIGHTPADDING", (0,0), (-1,-1), 8),
        ("TOPPADDING", (0,0), (-1,-1), 4), ("BOTTOMPADDING", (0,0), (-1,-1), 4),
    ]))
    story.append(Spacer(1,4)); story.append(tbl); story.append(Spacer(1, 8))

def task_header(tid, title, impact, effort):
    rows = [[Paragraph(f"<b>{tid}</b>", ParagraphStyle('t', parent=styles['Body'], fontSize=12, textColor=colors.white)),
             Paragraph(f"<b>{html.escape(title)}</b>", ParagraphStyle('t2', parent=styles['Body'], fontSize=11, textColor=colors.white))]]
    t = Table(rows, colWidths=[0.9*inch, 5.8*inch])
    t.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,-1),BRAND),("VALIGN",(0,0),(-1,-1),"MIDDLE"),
                           ("LEFTPADDING",(0,0),(-1,-1),8),("TOPPADDING",(0,0),(-1,-1),5),("BOTTOMPADDING",(0,0),(-1,-1),5)]))
    story.append(t)
    meta = Table([[Paragraph(f"<b>Approval impact:</b> {impact}", styles["Small"]),
                   Paragraph(f"<b>Effort:</b> {effort}", styles["Small"])]], colWidths=[4.4*inch, 2.3*inch])
    meta.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,-1),LIGHT),("LEFTPADDING",(0,0),(-1,-1),8),
                              ("TOPPADDING",(0,0),(-1,-1),3),("BOTTOMPADDING",(0,0),(-1,-1),3)]))
    story.append(meta); story.append(Spacer(1,6))

# ---- header/footer ----
def on_page(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#888888"))
    canvas.drawString(0.9*inch, 0.55*inch, "PulseEDU — DevOps Runbook (District Approval)  ·  CONFIDENTIAL")
    canvas.drawRightString(7.6*inch, 0.55*inch, f"Page {doc.page}")
    canvas.setStrokeColor(colors.HexColor("#cccccc"))
    canvas.line(0.9*inch, 0.72*inch, 7.6*inch, 0.72*inch)
    canvas.restoreState()

doc = BaseDocTemplate(OUT, pagesize=LETTER, leftMargin=0.9*inch, rightMargin=0.9*inch,
                      topMargin=0.9*inch, bottomMargin=0.9*inch, title="PulseEDU DevOps Runbook")
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main")
doc.addPageTemplates([PageTemplate(id="tpl", frames=[frame], onPage=on_page)])

# ============================== COVER ==============================
story.append(Spacer(1, 1.4*inch))
P("PulseEDU", "Cover")
P("DevOps Task Runbook", "Cover")
P("District Security-Review Remediation &mdash; Infrastructure &amp; Operations (DO-*) tasks", "CoverSub")
P("Step-by-step instructions, ready-to-run commands, and the exact evidence to capture to close each task.", "CoverSub")
story.append(Spacer(1, 0.5*inch))
story.append(HRFlowable(width="100%", color=BRAND, thickness=1.5))
story.append(Spacer(1, 0.2*inch))
P("Audience: DevOps / Operations engineer &nbsp;|&nbsp; Prepared: 2026-08-05 &nbsp;|&nbsp; Classification: Confidential", "Small")
P("Environment: AWS (EC2 app host + RDS PostgreSQL + S3), region us-east-1. Production: https://pulseedu.pulsekinetics.us (port 8080). Registrar: GoDaddy.", "Small")
story.append(PageBreak())

# ============================== SECTION 1: HOW TO USE ==============================
P("1. How to use this document", "H1b")
P("This runbook covers the <b>12 open infrastructure/operations tasks (DO-01 through DO-14, excluding the two already completed: DO-07 and DO-11)</b> from the district approval tracker. Each task has: <b>why it matters</b>, <b>prerequisites</b>, <b>step-by-step actions</b>, and a green <b>Evidence</b> box telling you exactly what to capture so the task can be marked closed.")
P("Work top to bottom within each group. The tasks are grouped by effort:")
bullets([
    "<b>Group A &mdash; Quick account/console wins</b> (DO-04, DO-05, DO-14): a few hours, no code.",
    "<b>Group B &mdash; AWS configuration</b> (DO-06, DO-03, DO-09, DO-10, DO-12): a day or two.",
    "<b>Group C &mdash; Infrastructure builds</b> (DO-01, DO-02, DO-13): the real effort; DO-01 and DO-02 are hard gates for full approval.",
    "<b>Group D &mdash; Secret rotation</b> (DO-08): scripted, but read the cautions carefully.",
])
P("<b>Two tasks are already done by the engineering side</b> and need nothing from you: DO-07 (MFA_ENC_KEY boot check) and DO-11 (CSP/HSTS/security headers). They are listed at the end for reference.")

P("1.1 Access you need before starting", "H2b")
bullets([
    "<b>AWS console + CLI</b> access (IAM user/role) with permissions for RDS, S3, CloudWatch, AWS Backup, and (for DO-12) WAF/CloudFront. Region us-east-1.",
    "<b>Production host access</b> (SSH to the EC2 instance running the app) and the ability to read/edit the deployment <b>.env</b> or the secrets store the app reads.",
    "<b>GoDaddy account</b> access (registrar) for DO-04 and possibly DO-05.",
    "The <b>S3 bucket name</b> the app uses (env var S3_BUCKET) and the RDS instance identifier.",
    "<b>aws-cli v2</b> installed and configured (aws configure) on your workstation.",
])

P("1.2 Evidence capture standards (read once, apply to every task)", "H2b")
P("The district requires <b>proof</b>, not just a statement, for each closed item. Keep every artifact in one place so it can be handed over as a package.")
bullets([
    "Create a folder per task: <font face='Courier'>deliverables/evidence/DO-XX/</font> in the project repo (or a shared drive).",
    "Name files with the task id + date: <font face='Courier'>DO-04-godaddy-mfa-2026-08-10.png</font>.",
    "Screenshots must clearly show the setting <b>enabled/active</b> and the resource it applies to. Include the browser URL bar or console breadcrumb where possible.",
    "For CLI evidence, save the <b>command AND its output</b> to a .txt file (e.g. <font face='Courier'>DO-06-verify.txt</font>).",
    "<b>Redact secrets</b> before saving: blur/black-out access keys, passwords, tokens, and full account numbers. Never paste a live secret value into an evidence file.",
    "For each task write one line in a <font face='Courier'>DO-XX/README.txt</font>: what was done, by whom (role), date, and where the change lives.",
])
P("These artifacts feed the district evidence package (tracker items SC-03 / SC-05). When a task's evidence is captured, tell the project owner so the tracker row can be flipped to <b>Complete &mdash; Evidence captured</b>.", "Small")
story.append(PageBreak())

# ============================== GROUP A ==============================
P("Group A &mdash; Quick account/console wins", "H1b")

# DO-04
task_header("DO-04", "Confirm MFA on the GoDaddy registrar account", "Full-approval supporting (High)", "~30 min")
P("<b>Why:</b> The domain registrar is the keys-to-the-kingdom for the site. If the GoDaddy login is phished, an attacker can redirect the domain. MFA on the registrar is a baseline the district checks.")
P("<b>Steps:</b>")
bullets([
    "Log into GoDaddy with the account that owns <b>pulsekinetics.us</b>.",
    "Go to <b>Account Settings &rarr; Login &amp; PIN</b> (or <b>Security</b>) &rarr; <b>2-Step Verification</b>.",
    "Enable <b>Authenticator app</b> (preferred over SMS). Complete the enrollment and save backup codes in your password manager.",
    "Repeat for <b>every</b> login that has access to the registrar account (delegate/team members).",
])
evidence([
    "Screenshot of the GoDaddy 2-Step Verification page showing status = <b>ON</b> (redact the account email).",
    "Save as <font face='Courier'>DO-04/DO-04-godaddy-mfa-YYYY-MM-DD.png</font>.",
])

# DO-05
task_header("DO-05", "Configure or confirm DNSSEC", "Full-approval supporting (High)", "~1 hour")
P("<b>Why:</b> DNSSEC signs your DNS records so resolvers can detect spoofed/tampered answers (cache-poisoning defense).")
P("<b>Steps:</b> First determine who hosts DNS for pulsekinetics.us (GoDaddy DNS, or AWS Route 53).")
P("<b>If DNS is on GoDaddy:</b>")
bullets([
    "Domain Portfolio &rarr; select the domain &rarr; <b>DNSSEC</b> (under Additional Settings) &rarr; <b>Enable</b>. GoDaddy manages the DS record automatically when it is both registrar and DNS host.",
])
P("<b>If DNS is on Route 53:</b>")
bullets([
    "Route 53 &rarr; Hosted zone &rarr; <b>DNSSEC signing</b> &rarr; Enable signing (creates a KSK in KMS).",
    "Copy the generated <b>DS record</b> and add it at the registrar (GoDaddy &rarr; DNSSEC &rarr; add DS record).",
])
P("<b>Verify</b> from your workstation:")
code("dig +dnssec pulseedu.pulsekinetics.us A | grep -E 'RRSIG|ad'\n"
     "dig DS pulsekinetics.us +short\n"
     "# Or use the visual checker at https://dnsviz.net/d/pulsekinetics.us/dnssec/")
evidence([
    "Screenshot of the DNSSEC-enabled setting at the DNS host.",
    "Text file of the <font face='Courier'>dig</font> output showing an RRSIG / DS record, or a dnsviz.net report screenshot.",
    "Save under <font face='Courier'>DO-05/</font>.",
])

# DO-14
task_header("DO-14", "Written attestation: no real student PII in dev/preview", "Full-approval supporting (Medium)", "~30 min")
P("<b>Why:</b> The district needs assurance that real student data was never copied into non-production environments. This is a signed written statement, not a technical change.")
P("<b>Steps:</b> Confirm the history of every non-production environment (local dev, preview, staging, any demo), then write and sign the attestation. Template:")
code("PulseEDU — Non-Production Data Handling Attestation\n"
     "Date: __________\n\n"
     "I confirm that, to the best of my knowledge and based on review of our\n"
     "environment history and data-loading procedures:\n\n"
     "  1. No real student personally identifiable information (PII) has ever\n"
     "     been loaded into development, preview, staging, or demo environments.\n"
     "  2. Those environments use only synthetic / demo data generated by the\n"
     "     application's seed routines.\n"
     "  3. Production data (real rosters) resides only in the production RDS\n"
     "     database and encrypted backups, accessible to authorized operators.\n\n"
     "Signed (role): DevOps / Operations Engineer\n"
     "Signature: __________________________")
evidence([
    "The signed attestation saved as <font face='Courier'>DO-14/DO-14-pii-attestation.pdf</font>.",
    "If any real data ever touched a non-prod environment, do NOT sign &mdash; escalate to the project owner first.",
])
story.append(PageBreak())

# ============================== GROUP B ==============================
P("Group B &mdash; AWS configuration", "H1b")

# DO-06
task_header("DO-06", "Lifecycle expiry for raw roster-import files in S3", "Tracked remediation (Medium)", "~1 hour")
P("<b>Why:</b> Raw import files can contain student PII. Data-minimization means they should auto-delete after a short window rather than linger forever.")
P("<b>Step 1 &mdash; Confirm where import files live.</b> List the private prefix and find the folder that holds raw roster/import uploads:")
code("aws s3 ls s3://<S3_BUCKET>/private/ --recursive | head -30\n"
     "# Look for a prefix like private/imports/ or private/rosters/ .\n"
     "# Also check for any EXISTING lifecycle rules first (DO-06 is 'partially resolved'):\n"
     "aws s3api get-bucket-lifecycle-configuration --bucket <S3_BUCKET>")
P("<b>Step 2 &mdash; Apply the lifecycle rule.</b> Save this as <font face='Courier'>do06-lifecycle.json</font> (adjust the Prefix to the real folder and Days to the approved retention, e.g. 30):")
code('{\n'
     '  "Rules": [\n'
     '    {\n'
     '      "ID": "expire-raw-roster-imports",\n'
     '      "Filter": { "Prefix": "private/imports/" },\n'
     '      "Status": "Enabled",\n'
     '      "Expiration": { "Days": 30 },\n'
     '      "NoncurrentVersionExpiration": { "NoncurrentDays": 7 },\n'
     '      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }\n'
     '    }\n'
     '  ]\n'
     '}')
P("<b>Important:</b> if the bucket already has lifecycle rules (from Step 1), <b>merge</b> this rule into the existing JSON &mdash; put-bucket-lifecycle-configuration <b>replaces</b> the whole configuration.")
code("aws s3api put-bucket-lifecycle-configuration \\\n"
     "  --bucket <S3_BUCKET> \\\n"
     "  --lifecycle-configuration file://do06-lifecycle.json\n\n"
     "# Verify (this is your evidence):\n"
     "aws s3api get-bucket-lifecycle-configuration --bucket <S3_BUCKET> > DO-06-verify.txt")
evidence([
    "<font face='Courier'>DO-06-verify.txt</font> showing the active rule (Prefix + Expiration Days).",
    "The <font face='Courier'>do06-lifecycle.json</font> you applied.",
    "One line in README.txt stating the approved retention period and who approved it.",
])

# DO-03
task_header("DO-03", "Backup immutability / isolation against ransomware", "Tracked remediation (Medium)", "~half day")
P("<b>Why:</b> If an attacker gains write access, mutable backups can be encrypted/deleted too. Immutable (write-once) backups guarantee a clean restore point.")
P("<b>Recommended approach (AWS Backup + Vault Lock):</b>")
bullets([
    "Create an <b>AWS Backup vault</b> and enable <b>Vault Lock (Compliance mode)</b> with a minimum retention. Compliance mode cannot be disabled, even by root &mdash; test in Governance mode first.",
    "Create a backup plan that snapshots the <b>RDS</b> instance (and the S3 backup bucket if used) into that locked vault on a schedule.",
    "Alternatively/additionally: enable <b>S3 Versioning + Object Lock</b> on the backup bucket, or replicate backups to a <b>separate AWS account</b> the app's IAM role cannot reach.",
])
code("# Example: create a locked vault (governance first to validate, then compliance)\n"
     "aws backup create-backup-vault --backup-vault-name pulseedu-immutable\n"
     "aws backup put-backup-vault-lock-configuration \\\n"
     "  --backup-vault-name pulseedu-immutable \\\n"
     "  --min-retention-days 30 --changeable-for-days 3   # governance window to validate")
evidence([
    "Screenshot of the AWS Backup vault showing <b>Vault Lock = enabled</b> (mode + min retention), OR",
    "Screenshot of S3 bucket <b>Object Lock = enabled</b> / cross-account replication rule.",
    "A short note describing the chosen immutability model. Save under <font face='Courier'>DO-03/</font>.",
])

# DO-09
task_header("DO-09", "Ship operational &amp; request logs to durable storage", "Tracked remediation (Low)", "~half day")
P("<b>Why:</b> The app logs to stdout (pino). On a single host those logs vanish on redeploy/restart. Durable, searchable logs are needed for incident forensics.")
P("<b>Steps (CloudWatch Logs via the agent on EC2):</b>")
bullets([
    "Install the <b>CloudWatch agent</b> on the EC2 app host.",
    "Point it at the app's log source: if the app runs under <b>systemd</b>, collect the journald unit; if it writes a file, collect that path.",
    "Create a log group (e.g. <font face='Courier'>/pulseedu/app</font>) with a <b>retention policy</b> (e.g. 365 days).",
])
code("# set retention on the log group (evidence-friendly)\n"
     "aws logs put-retention-policy --log-group-name /pulseedu/app --retention-in-days 365\n"
     "aws logs describe-log-groups --log-group-name-prefix /pulseedu > DO-09-verify.txt")
evidence([
    "Screenshot of the CloudWatch log group receiving recent app log events.",
    "<font face='Courier'>DO-09-verify.txt</font> showing the group and its retention. Save under <font face='Courier'>DO-09/</font>.",
])

# DO-10
task_header("DO-10", "External security alerting and monitoring", "Tracked remediation (Medium)", "~half day")
P("<b>Why:</b> You need to be told when the app is down or when a security event fires &mdash; not find out from a user.")
P("<b>Steps:</b>")
bullets([
    "Create an <b>SNS topic</b> and subscribe an ops email (or Slack webhook via chatbot).",
    "Add <b>CloudWatch alarms</b>: EC2 CPU high, RDS free storage low, RDS CPU high, and an <b>uptime check</b> hitting <font face='Courier'>https://pulseedu.pulsekinetics.us/api/health</font>.",
    "Wire each alarm's action to the SNS topic. Optionally forward the app's own security-alert events (it raises them internally) to the same channel.",
    "Send a <b>test</b> notification and confirm it arrives.",
])
code("aws sns create-topic --name pulseedu-ops-alerts\n"
     "aws sns subscribe --topic-arn <arn> --protocol email --notification-endpoint ops@<domain>\n"
     "# health-check based alarm can be a Route53 health check or a CloudWatch Synthetics canary hitting /api/health")
evidence([
    "Screenshot of the CloudWatch alarms list (state OK) + the SNS subscription confirmed.",
    "Screenshot/text of a <b>received test alert</b>. Save under <font face='Courier'>DO-10/</font>.",
])

# DO-12
task_header("DO-12", "Add a WAF, or obtain acceptance of the residual", "Tracked remediation (Medium)", "~half day OR a decision")
P("<b>Why:</b> A Web Application Firewall filters common web attacks (SQLi, XSS, bad bots). The district will either want one or want a documented, accepted reason it is absent.")
P("<b>Option 1 &mdash; Add AWS WAF</b> (if the app is behind CloudFront or an ALB):")
bullets([
    "Create a <b>WAFv2 Web ACL</b> with the AWS <b>Managed Rules</b> (Core rule set, Known-bad-inputs, SQLi, IP-reputation, and rate-limit).",
    "Associate it with the CloudFront distribution or ALB in front of the app. Start in <b>Count</b> mode, review false positives, then switch to <b>Block</b>.",
])
P("<b>Option 2 &mdash; Documented residual:</b> if a WAF is not feasible now, write a short risk-acceptance note (compensating controls: security headers already shipped, rate-limiting in the app, tenant isolation) and get the <b>district</b> to accept it in writing.")
evidence([
    "Screenshot of the WAF Web ACL associated with the distribution/ALB (rules + mode), OR",
    "The written residual-risk acceptance signed off by the district. Save under <font face='Courier'>DO-12/</font>.",
])
story.append(PageBreak())

# ============================== GROUP C ==============================
P("Group C &mdash; Infrastructure builds (the real effort)", "H1b")

# DO-01
task_header("DO-01", "Perform a dated backup restoration drill", "FULL-APPROVAL GATE (Critical)", "~half day")
P("<b>Why:</b> A backup you have never restored is a hope, not a backup. The district requires a <b>dated, passed</b> restore drill. This is a hard gate.")
P("<b>Runbook (RDS snapshot &rarr; throwaway instance &rarr; verify &rarr; tear down):</b>")
code("# 1) Find the most recent automated snapshot of the prod DB\n"
     "aws rds describe-db-snapshots --db-instance-identifier <PROD_DB_ID> \\\n"
     "  --snapshot-type automated \\\n"
     "  --query \"reverse(sort_by(DBSnapshots,&SnapshotCreateTime))[0].DBSnapshotIdentifier\" --output text\n\n"
     "# 2) Restore it to a NEW, isolated instance (not publicly accessible)\n"
     "aws rds restore-db-instance-from-db-snapshot \\\n"
     "  --db-instance-identifier pulseedu-restore-drill \\\n"
     "  --db-snapshot-identifier <SNAPSHOT_ID> \\\n"
     "  --db-instance-class db.t3.small --no-publicly-accessible\n\n"
     "# 3) Wait until available, then get its endpoint\n"
     "aws rds wait db-instance-available --db-instance-identifier pulseedu-restore-drill\n"
     "aws rds describe-db-instances --db-instance-identifier pulseedu-restore-drill \\\n"
     "  --query \"DBInstances[0].Endpoint.Address\" --output text")
code("# 4) Verify the restored data (row counts should match production scale)\n"
     "psql \"postgresql://<user>:<pass>@<restore-endpoint>:5432/pulseedu\" \\\n"
     "  -c \"select count(*) as students from students;\" \\\n"
     "  -c \"select count(*) as staff from staff;\" \\\n"
     "  -c \"select max(created_at) from auth_audit_log;\"\n\n"
     "# 5) (optional but strong) Boot a throwaway app instance against the restore\n"
     "#    and confirm GET /api/health returns 200.\n\n"
     "# 6) TEAR DOWN the drill instance so it does not linger or cost money\n"
     "aws rds delete-db-instance --db-instance-identifier pulseedu-restore-drill \\\n"
     "  --skip-final-snapshot")
evidence([
    "A dated log <font face='Courier'>DO-01/DO-01-restore-drill-YYYY-MM-DD.md</font> containing: the snapshot id used, each command + its output, the verified row counts, and a clear <b>PASS/FAIL</b> with the date/time.",
    "Screenshot of the restored instance in the RDS console (and the /api/health 200 if you did step 5).",
    "Confirmation the drill instance was deleted.",
])

# DO-02
task_header("DO-02", "Fix / document fresh-environment provisioning", "FULL-APPROVAL GATE (High)", "~1 day")
P("<b>Why:</b> The district must see you can stand up a clean environment repeatably (disaster recovery, new tenant). The app's boot ensures are already idempotent; this task is the <b>runbook + a proven clean stand-up</b>.")
P("<b>Provisioning runbook:</b>")
bullets([
    "<b>1. Provision infra:</b> a new RDS PostgreSQL instance (same engine/version as prod) and an app host (EC2), in a private subnet with a security group allowing the app &rarr; DB on 5432 only.",
    "<b>2. Create the database:</b> <font face='Courier'>createdb pulseedu</font> (or via RDS).",
    "<b>3. Provision the schema.</b> Preferred once the migration toolchain is fixed: <font face='Courier'>drizzle-kit push</font>. Until then, use the committed schema builder that creates all tables from the Drizzle schema:",
])
code("DATABASE_URL=postgres://<user>:<pass>@<new-db>:5432/pulseedu \\\n"
     "  node scripts/node_modules/.bin/tsx scripts/src/testSchemaSync.mts\n"
     "# creates all ~198 tables (idempotent).")
bullets([
    "<b>4. Set env &amp; boot:</b> copy <font face='Courier'>.env.production.example</font> to <font face='Courier'>.env</font>, fill in DATABASE_URL / SESSION_SECRET / the encryption keys / AWS S3 vars. Set <font face='Courier'>RUN_BOOT_SEED=true</font> (schema top-ups) and leave <font face='Courier'>SEED_DEMO_DATA</font> unset (no demo data in a real env).",
    "<b>5. Deploy:</b> build (<font face='Courier'>node build.mjs</font>) and start (<font face='Courier'>node --env-file=.env dist/index.mjs</font>) under systemd/pm2.",
    "<b>6. Verify:</b> <font face='Courier'>curl -f https://&lt;host&gt;/api/health</font> returns 200; boot log shows the MFA_ENC_KEY line (DO-07) and 'Server listening'.",
])
evidence([
    "The written runbook saved as <font face='Courier'>DO-02/DO-02-fresh-env-runbook.md</font>.",
    "A log of an actual clean stand-up (commands + the successful /api/health 200 + table count). This doubles as proof for DR readiness.",
])

# DO-13
task_header("DO-13", "Create a staging environment", "Full-approval supporting (High)", "~1 day")
P("<b>Why:</b> A staging environment lets changes be validated before they touch production &mdash; the district expects a non-prod validation step.")
P("<b>Steps:</b> Reuse the DO-02 runbook to stand up a <b>separate, isolated</b> environment:")
bullets([
    "Separate RDS instance/database and app host (never share the prod DB).",
    "A staging <font face='Courier'>.env</font> with its own SESSION_SECRET and its own encryption keys; point object storage at a staging bucket/prefix.",
    "A staging hostname (e.g. staging.pulseedu.pulsekinetics.us) with TLS.",
    "Deploy the same build artifact you would ship to prod. Keep AI/SMS/email disabled here too unless testing them.",
])
evidence([
    "The staging URL reachable over HTTPS with <font face='Courier'>/api/health</font> = 200 (screenshot).",
    "A short note describing the staging topology and how it is isolated from prod. Save under <font face='Courier'>DO-13/</font>.",
])
story.append(PageBreak())

# ============================== GROUP D ==============================
P("Group D &mdash; Secret rotation", "H1b")
task_header("DO-08", "Define and enforce routine secret-rotation schedules", "Tracked remediation (Medium)", "~half day + ongoing")
P("<b>Why:</b> Rotating secrets limits how long a leaked credential is useful. The district wants a defined cadence and evidence of at least one rotation.")

P("<b>Step 1 &mdash; Inventory the secrets and note their rotation type.</b> Rotation is NOT one-size-fits-all &mdash; some are safe to rotate anytime, others require care:", "H3b")
rot = [
    ["Secret", "Cadence", "Rotation caution"],
    ["RESEND_API_KEY", "Now, then 90d", "SAFE now — email is disabled. Rotate in the Resend dashboard, update env, redeploy, revoke old key."],
    ["AWS access keys", "90 days", "Create new key, deploy, verify, then deactivate+delete old. Prefer IAM roles to remove static keys entirely."],
    ["SESSION_SECRET", "180 days", "CAUTION: rotating logs out ALL users (sessions invalidated). Schedule off-hours; communicate."],
    ["DATABASE_URL pwd", "180 days", "Change the RDS master/app password, update env, redeploy. Brief connection blip."],
    ["MFA_ENC_KEY", "Rare / on incident", "DANGER: rotating requires RE-ENCRYPTING stored MFA seeds. Do NOT rotate without a migration. Back it up."],
    ["DATA_ENC_KEY", "Rare / on incident", "DANGER: encrypts sensitive records at rest. Rotating requires re-encrypting all rows. Back it up; never lose it."],
    ["Twilio keys", "90 days (when enabled)", "SMS currently disabled; rotate when the feature is turned on."],
]
t = Table(rot, colWidths=[1.5*inch, 1.1*inch, 4.1*inch])
t.setStyle(TableStyle([
    ("BACKGROUND",(0,0),(-1,0),BRAND),("TEXTCOLOR",(0,0),(-1,0),colors.white),
    ("FONTSIZE",(0,0),(-1,-1),8),("VALIGN",(0,0),(-1,-1),"TOP"),
    ("GRID",(0,0),(-1,-1),0.4,colors.HexColor("#cccccc")),
    ("ROWBACKGROUNDS",(0,1),(-1,-1),[colors.white, LIGHT]),
    ("LEFTPADDING",(0,0),(-1,-1),5),("RIGHTPADDING",(0,0),(-1,-1),5),
    ("TOPPADDING",(0,0),(-1,-1),3),("BOTTOMPADDING",(0,0),(-1,-1),3),
]))
story.append(t); story.append(Spacer(1,8))

P("<b>Step 2 &mdash; Do the one safe rotation now to prove the process: the Resend key.</b>", "H3b")
bullets([
    "In the Resend dashboard, create a new API key and revoke the old one.",
    "Update <font face='Courier'>RESEND_API_KEY</font> in the production secrets/.env and redeploy.",
    "Because email is globally disabled, there is no user impact.",
])
P("<b>Step 3 &mdash; Document the cadence.</b> Put the table above into a one-page policy (<font face='Courier'>SECRET-ROTATION.md</font>) with owners and next-due dates, and set calendar reminders.")
evidence([
    "The <font face='Courier'>SECRET-ROTATION.md</font> policy (cadence + owners + next-due dates).",
    "A dated rotation log entry for the RESEND key rotation (old key revoked, new key deployed) &mdash; redact the values.",
    "Save under <font face='Courier'>DO-08/</font>.",
])
P("<b>Do NOT rotate MFA_ENC_KEY or DATA_ENC_KEY as part of routine cadence</b> &mdash; they require a re-encryption migration. Flag them to engineering if a rotation is ever needed.", "Small")

story.append(PageBreak())
# ============================== ALREADY DONE + SUMMARY ==============================
P("Already completed (no action needed)", "H1b")
P("<b>DO-07 &mdash; MFA_ENC_KEY boot check.</b> The app now logs the MFA_ENC_KEY configuration state on every boot. <b>Your action:</b> after you confirm MFA_ENC_KEY is set in the production secrets store, you may set <font face='Courier'>MFA_ENC_KEY_REQUIRED=true</font> to make a missing key a hard boot failure going forward. Evidence: a boot-log screenshot showing the <font face='Courier'>[mfa] MFA_ENC_KEY is configured</font> line.")
P("<b>DO-11 &mdash; Security headers (CSP/HSTS/Permissions-Policy).</b> Shipped and tested in code. <b>Optional evidence:</b> run <font face='Courier'>curl -sI https://pulseedu.pulsekinetics.us/</font> and save the response headers showing Strict-Transport-Security (with preload), Content-Security-Policy, Referrer-Policy, and Permissions-Policy.")
code("curl -sI https://pulseedu.pulsekinetics.us/ | grep -iE \\\n"
     "  'strict-transport|content-security|referrer-policy|permissions-policy|x-content-type' \\\n"
     "  > DO-11/DO-11-headers.txt")

P("Summary checklist", "H1b")
summ = [
    ["Task", "What you deliver", "Gate?"],
    ["DO-04", "GoDaddy MFA enabled + screenshot", "Supporting"],
    ["DO-05", "DNSSEC enabled + dig/dnsviz proof", "Supporting"],
    ["DO-14", "Signed no-PII attestation", "Supporting"],
    ["DO-06", "S3 lifecycle rule + get-lifecycle output", "Remediation"],
    ["DO-03", "Immutable backups (Vault Lock/Object Lock) + screenshot", "Remediation"],
    ["DO-09", "Logs in CloudWatch + retention set", "Remediation"],
    ["DO-10", "Alarms + received test alert", "Remediation"],
    ["DO-12", "WAF associated OR signed residual acceptance", "Remediation"],
    ["DO-01", "Dated PASSED restore-drill log", "GATE"],
    ["DO-02", "Fresh-env runbook + clean stand-up log", "GATE"],
    ["DO-13", "Staging env reachable (HTTPS /api/health 200)", "Supporting"],
    ["DO-08", "Rotation policy + one proven rotation (Resend)", "Remediation"],
]
t = Table(summ, colWidths=[0.8*inch, 4.6*inch, 1.3*inch])
t.setStyle(TableStyle([
    ("BACKGROUND",(0,0),(-1,0),BRAND),("TEXTCOLOR",(0,0),(-1,0),colors.white),
    ("FONTSIZE",(0,0),(-1,-1),8.5),("VALIGN",(0,0),(-1,-1),"MIDDLE"),
    ("GRID",(0,0),(-1,-1),0.4,colors.HexColor("#cccccc")),
    ("ROWBACKGROUNDS",(0,1),(-1,-1),[colors.white, LIGHT]),
    ("TEXTCOLOR",(2,9),(2,10),WARN),("FONTNAME",(2,9),(2,10),"Helvetica-Bold"),
    ("LEFTPADDING",(0,0),(-1,-1),5),("TOPPADDING",(0,0),(-1,-1),4),("BOTTOMPADDING",(0,0),(-1,-1),4),
]))
story.append(t); story.append(Spacer(1,10))
P("<b>Priority order:</b> knock out Group A (quick wins) first, then the two GATE items DO-01 and DO-02 (they block full approval), then the rest of Group B/C/D in parallel. Hand each task's evidence folder to the project owner as you finish so the tracker can be updated.", "Small")
P("<b>Note:</b> Full district approval also requires items outside DevOps &mdash; the signed legal DPA(s), an independent third-party penetration test, and district sign-off. Those run in parallel and are tracked separately.", "Small")

doc.build(story)
print("WROTE", OUT)
