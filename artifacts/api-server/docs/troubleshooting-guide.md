# PulseEDU — Troubleshooting Guide

**Audience:** School administrators, support staff, and platform operators  
**Production URL:** https://pulseedu.pulsekinetics.us/  
**Document type:** Problem → diagnosis → resolution reference

---

## 1. Purpose of this guide

Use this guide when something **does not work as expected** in PulseEDU. For initial setup and configuration tasks, use the **System Administration Guide**.

**Before deep troubleshooting:**

1. Confirm you are on https://pulseedu.pulsekinetics.us/ (not an old bookmark or dev URL)  
2. Hard refresh the browser (Ctrl+Shift+R / Cmd+Shift+R)  
3. Confirm you are signed in and viewing the **correct school** (top bar badge for SuperUser/District Admin)  
4. Try an incognito/private window to rule out stale cookies  

---

## 2. Quick symptom index

| Symptom | Go to section |
|---------|----------------|
| Cannot sign in | Section 3 — Login and session |
| Saves fail with “403” or CSRF error | Section 3 — Login and session |
| “Sign-in required” on actions | Section 3 — Login and session |
| Wrong school’s data | Section 4 — School context |
| Feature missing from sidebar | Section 5 — Features and permissions |
| Hall pass queue wrong period | Section 6 — Hall passes and bell schedule |
| Kiosk will not activate | Section 7 — Kiosk |
| PBIS cannot award points | Section 8 — PBIS |
| Pullout email/SMS not received | Section 9 — Pullouts and notifications |
| Parent invite will not work | Section 10 — Parent portal |
| CSV import failed | Section 11 — Data imports |
| Student not found | Section 12 — Students and roster |
| Page blank or network error | Section 13 — Browser and connectivity |
| Suspected data breach | Section 14 — Security escalation |

---

## 3. Login, session, and CSRF

### 3.1 Invalid email or password

**Symptoms:** Login form returns a generic invalid-credentials message.

**Checks:**

- Email must match **allowlist** entry (Settings → Teacher Sign-in Allowlist)  
- Staff account must be **active**  
- Use **Forgot password** if password unknown; reset link expires  

**Fix:** Admin adds email to allowlist or resets password flow; deactivate duplicate test accounts if needed.

---

### 3.2 Signed out unexpectedly / “Sign-in required”

**Symptoms:** Actions fail with “Sign-in required” or you return to login.

**Checks:**

- Session expired (inactive ~14 days max cookie life; closing browser may end session depending on browser settings)  
- Server maintenance restart  
- Multiple tabs logged in as different users  

**Fix:** Sign in again. If frequent, check production server uptime and clock sync.

---

### 3.3 CSRF errors (`csrf_token_required` / `csrf_token_invalid`)

**Symptoms:** POST/save returns **403** with CSRF error in network tab.

**Checks:**

- Usually stale tab open before deploy, or cookie blocked  
- Third-party iframe embedding (production expects same-origin use)  
- Browser extensions blocking cookies  

**Fix:**

1. Sign out and sign back in  
2. Hard refresh  
3. Ensure using official URL only  
4. Disable strict tracking protection for the district domain if IT policy allows  

---

### 3.4 Too many login attempts

**Symptoms:** Login temporarily blocked after repeated failures.

**Fix:** Wait for cooldown period; verify correct password; admin confirms account is active.

---

## 4. School context (wrong data)

### 4.1 SuperUser acting as wrong school

**Symptoms:** Roster, students, or settings do not match expected building.

**Checks:** Top bar shows **Acting as: &lt;school&gt;** vs home school.

**Fix:** Use school switcher to select correct school before making changes.

---

### 4.2 Parent sees wrong student or no student

**Symptoms:** Parent portal empty or sibling missing.

**Checks:**

- Parent account is per **school**; same email at two schools = two accounts  
- `parent_students` link must exist for each child  
- Student must belong to same `school_id` as parent  

**Fix:** Admin resends invite from **Parent Access** for correct student; parent accepts with same email.

---

## 5. Features and permissions

### 5.1 Menu item missing (PBIS, Pullouts, Settings, etc.)

**Checks:**

1. **School Features Switchboard** — module may be OFF  
2. Staff **role** does not include that feature (e.g. teacher vs admin)  
3. **Capability flag** may hide page even if role sounds right  

**Fix:** Admin enables feature in switchboard; adjust Staff & Roles; use Staff Preview (admin QA tool) to verify what teacher sees.

---

### 5.2 “Forbidden” / 403 on admin action

**Checks:**

- User is not Admin / District Admin / SuperUser for that action  
- Route requires Core Team or specific role (Dean, MTSS, etc.)  

**Fix:** Admin updates role flags; user signs out and back in.

---

## 6. Hall passes and bell schedule

### 6.1 Hall Pass Queue does not reset between periods

**Symptoms:** Queue carries over across periods incorrectly.

**Cause (common):** No **default bell schedule** configured.

**Fix:** Settings → Bell Schedule → create schedule → mark **one** as **default**. See onboarding step “Bell Schedule (default)”.

---

### 6.2 Cannot select destination / origin

**Symptoms:** Dropdown empty or missing rooms.

**Fix:** Settings → Locations → add active locations; mark origin/destination flags.

---

### 6.3 Pass limits exceeded

**Symptoms:** Student blocked from new pass.

**Checks:** Per-student limits and school-wide daily cap in school settings.

**Fix:** Admin adjusts limits or ends active passes from admin tools.

---

## 7. Kiosk

### 7.1 Activation fails

**Symptoms:** Kiosk activation code rejected.

**Checks:**

- Code expired or already used  
- Kiosk feature enabled for school  
- Device clock correct (TLS issues rare)  

**Fix:** Settings → Kiosk Setup → generate new activation; complete pairing flow on device.

---

### 7.2 Kiosk pass does not appear in queue

**Checks:** Same school as activating admin; locations configured; network to `/api/kiosk/*` reachable from device browser.

---

## 8. PBIS

### 8.1 Cannot award points — no reasons

**Symptoms:** Reason dropdown empty.

**Fix:** Add at least one active **school-wide** PBIS reason (PBIS Reasons admin screen).

---

### 8.2 Milestone email not sent to parent

**Checks:**

- **FamilyComm** / related feature enabled  
- Milestone thresholds configured  
- Student has valid `parent_email`  
- Resend/email provider configured on server (`RESEND_API_KEY`)  
- Check milestone email log status in app  

---

## 9. Pullouts and notifications

### 9.1 Dispatch email not received

**Symptoms:** Teacher submitted pullout; Admin/Dean/MTSS/ISS did not get email.

**Checks:**

1. Recipients have role: Admin, Dean, MTSS Coordinator, or ISS Teacher  
2. Recipients are **active** with valid **email** on staff record  
3. Pullout row shows `dispatch_email_status` (support can verify in DB or UI if exposed)  
4. Resend API key and from-address configured in production `.env`  
5. District spam filter quarantine  

**Fix:** Update staff emails; test with one known good address; contact operator if status is `error` with provider message.

---

### 9.2 SMS not received (when SMS enabled)

**Checks:**

1. AWS SNS configured and account not in SMS sandbox restriction  
2. Staff **cell phone** populated in Staff Directory (E.164 format)  
3. Same dispatch roles as email  
4. SMS message kept short; carrier filtering  

**Fix:** Admin verifies phone numbers; platform operator verifies SNS publish logs in AWS CloudWatch.

---

### 9.3 Parent pullout email not sent

**Checks:** Parent email on student record; pullout reached step that triggers parent email (arrival/return/ISS); `parent_email_status` on pullout.

---

## 10. Parent portal

### 10.1 Invite link invalid or expired

**Symptoms:** “Invite no longer valid” on accept page.

**Fix:** Admin resends invite from Parent Access; parent uses latest link within expiry window.

---

### 10.2 Parent cannot see section (PBIS, ISS, etc.)

**Checks:**

- **Parent Portal Sections** school toggles  
- Parent cannot override school-off sections  
- Parent preference may hide allowed sections  

**Fix:** Admin enables section at school level; parent enables in preferences if school allows.

---

### 10.3 Weekly PDF email not received

**Checks:** School allows weekly email; parent opted in; student school matches parent school; spam filter.

---

## 11. Data imports

### 11.1 Import preview shows many errors

**Symptoms:** High error count before commit.

**Fix:**

- Download error log from importer  
- Fix CSV headers to match template  
- Remove duplicate student IDs  
- Commit only after preview is clean  

---

### 11.2 Wrong data after import

**Fix:**

- **Do not** run a second import to “fix” blindly  
- Use import **History → Roll back** for that job if `import_job_id` was used  
- Re-import corrected file  

---

### 11.3 District import routed to wrong school

**Checks:** `school_code` column values match `schools.state_school_code` or importer mapping rules.

---

## 12. Students and roster

### 12.1 Student not found

**Symptoms:** 404 or “Student not found” when ID typed correctly.

**Checks:**

- Student exists in **active school** context  
- `student_id` string matches district ID format  
- Student not only in another school (multi-school district)  

**Fix:** Import roster or add student; verify school switcher.

---

### 12.2 Duplicate or wrong roster data

**Fix:** Correct source SIS/CSV; rollback bad import; re-sync when ClassLink live sync is available.

---

## 13. Browser and connectivity

### 13.1 API errors / network failed

**Checks:**

- https://pulseedu.pulsekinetics.us loads  
- Browser devtools → Network → `/api/` calls return 200/401/403 (not blocked CORS)  
- District firewall allows district domain  

**Fix:** IT allowlists domain; avoid proxy stripping cookies.

---

### 13.2 CORS blocked (rare in production)

**Symptoms:** Console shows CORS error; API from wrong origin.

**Fix:** Use only official production URL; do not host client on a different domain without updating server `CORS_ORIGINS`.

---

## 14. Security escalation

Contact platform operator and district leadership immediately if:

- Suspected unauthorized access to student data  
- Staff account compromise  
- Parent reports seeing another family’s data  
- Lost device with active admin session  

**Immediate steps:**

1. Deactivate affected staff accounts  
2. Rotate `SESSION_SECRET` and affected API keys (operator)  
3. Preserve logs and timestamps  
4. Follow district breach notification policy  

Platform operators should follow the **Incident Response and Credential Rotation Runbook**.

---

## 15. When to escalate to platform support

Escalate with **screenshots**, **time (with timezone)**, **school name**, **user role**, and **steps to reproduce** when:

- Issue persists after sections 3–13  
- Widespread outage (all users cannot sign in)  
- Data visible across schools (tenant isolation concern)  
- Email/SMS provider errors on server with no local fix  
- Database or server unreachable  

**Do not escalate without trying:** refresh, re-login, correct school context, and allowlist/feature checks.

---

## 16. Document control

| Field | Value |
|-------|--------|
| **Version** | 1.0 |
| **Applies to** | PulseEDU production at `pulseedu.pulsekinetics.us` |
