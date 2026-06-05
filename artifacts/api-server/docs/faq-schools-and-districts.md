# PulseEDU — FAQ for Schools and Districts

**Audience:** Administrators, teachers, parents, and district technology staff  
**Production URL:** https://pulseedu.pulsekinetics.us/

---

## General

### What is PulseEDU?

PulseEDU is a web-based platform for daily school operations: hall passes, PBIS recognition, behavior support, MTSS/ISS workflows, investigations (Core Team), parent HeartBEAT updates, and digital hallway signage.

### Who is PulseEDU for?

- **Staff** (teachers, admins, deans, counselors, ISS, PBIS coordinators) use the main application.  
- **Parents** use a separate **Parent Portal** (invite only).  
- **Students** do not sign up for staff accounts; kiosks are school-operated devices.

### What is the website address?

**https://pulseedu.pulsekinetics.us/** — use this URL for staff and parent portal links.

### Is PulseEDU the same for every school?

Each **school** has its own data and settings inside the platform. Staff normally see only their school. District-level roles can work across schools in the same district.

---

## Access and accounts

### How do staff get access?

A school **Admin** adds staff emails to the **Teacher Sign-in Allowlist** (Settings). New employees cannot sign in until they are on the list and have an active account.

### I forgot my password.

Use **Forgot password** on the login page, or ask your school Admin to help with account recovery.

### Why do I see “Sign-in required” or errors when saving?

You may be signed out or your session expired. Sign in again and refresh the page. If it continues, try another browser or contact your Admin.

### Can one person work at two schools?

Staff have a **home school**. District **SuperUser** / **District Admin** roles can switch schools from the top bar. Parents may have separate accounts per school if the same email is used at multiple schools.

---

## Setup and administration

### What should we configure before go-live?

Use **Settings → Onboarding Checklist** — it walks through branding, allowlist, locations, bell schedule, PBIS, MTSS, and parent portal steps in order.

### Why is the Hall Pass Queue not resetting between periods?

Usually there is **no default bell schedule**. Go to **Settings → Bell Schedule**, create a schedule, and mark **one** as **default**.

### How do we turn features on or off?

**Settings → School Features Switchboard** — modules left OFF are hidden from all staff at your school (PBIS, pullouts, accommodations, etc.).

### How do we import students and roster data?

**Settings → Data Importer** — upload CSV, preview, then commit. Bad imports can often be **rolled back** from import history.

### Who can change roles (Admin, Dean, MTSS, etc.)?

School **Admin** (or District Admin / SuperUser) via **Staff & Roles** in Admin Hub.

---

## Hall passes and kiosks

### How do teachers issue hall passes?

From the teacher workflow (Send Pass / hall pass tools) after **locations** and **bell schedule** are configured.

### What is the kiosk for?

A school device logged in for students to request or return passes at a fixed station. Set up under **Settings → Kiosk Setup**.

### Pass destinations are missing.

An Admin must add **locations** under Settings and mark them as origin and/or destination.

---

## PBIS

### Teachers cannot award PBIS points — no reasons listed.

An Admin must add at least one active **school-wide PBIS reason** before staff can award points.

### Can parents see PBIS points?

Only if the school enables that section in **Parent Portal Sections** and the parent has portal access.

---

## Request Pullout and notifications

### What happens when a teacher submits a Request Pullout?

The request is recorded in PulseEDU. **Dispatch staff** (Admin, Dean, MTSS Coordinator, ISS Teacher at that school) are notified to review and route the student.

### How are dispatchers notified today?

By **email** to the address on each staff member’s account.

### Will text messages (SMS) be used?

**Yes — planned.** Staff with a **cell phone** in the Staff Directory can receive a short **SMS alert** via **AWS SNS** (in addition to email). SMS will not include student names or detailed reasons; staff open PulseEDU for details. Rollout is scheduled shortly after AWS SMS is fully connected.

### A dispatcher did not get the pullout alert.

Check: correct **role**, **active** account, valid **email** on file, and (for SMS) valid **cell phone** in Staff Directory. Ask IT to confirm email/SMS services are configured on the server. See the **Troubleshooting Guide** (pullouts and notifications).

---

## ISS and discipline

### Where do we log ISS/OSS?

**Admin Hub** — Add ISS log / Add OSS log. Configure capacity and reasons under **Settings → ISS Settings**.

### Can we cancel a future ISS day?

Yes for **future** days that have not been served; served days stay in the record for audit purposes.

---

## Parent portal (HeartBEAT)

### How do parents get access?

Admins send an **invite** from **Parent Access**. Parent clicks the link, sets a password, and sees linked students only.

### Why can’t a parent see a section (MTSS, staff notes, ISS)?

The **school** controls which sections are available. Parents cannot turn on sections the school has disabled. Check **Settings → Parent Portal Sections**.

### Can parents message teachers by text through PulseEDU?

**Not at launch.** Parent–teacher messaging would be a **new feature** requiring separate design, permissions, and SMS/email rules. Launch SMS focuses on **staff operational alerts** (e.g. pullouts).

---

## Investigations and student data

### Who can see investigations / cases?

Core Team roles (e.g. Admin, Dean, Behavior Specialist, MTSS — per your school’s role setup). Access is school-scoped.

### Is student data shared between schools?

No — when the system is used correctly, each school’s data is isolated by `school_id`. District admins only see schools in their district.

### How is student data protected?

HTTPS, role-based access, school tenancy, session security, and district policies. Technical details are in the **Student Data Security Overview**, **Security and Privacy Evidence Pack**, and **FERPA Alignment Summary**. Legal sign-off is the district’s responsibility.

---

## ClassLink and roster sync

### Does PulseEDU sync automatically with ClassLink?

**Automatic OneRoster sync is in progress.** Until live sync is complete, schools typically use **CSV Data Importer** and manual roster updates. See ClassLink timeline / integration materials from your project team.

---

## Technology and hosting

### Where is PulseEDU hosted?

On **AWS** (EC2 application server, PostgreSQL database, load balancer). Domain **pulseedu.pulsekinetics.us** is registered via GoDaddy. See the **AWS Hosting and Infrastructure Overview**.

### What if the site is down?

Contact your district IT or PulseEDU support contact. They check server health, DNS, and database status. Schools should follow district communication procedures during outages.

### Are backups taken?

Backup and restore procedures are documented in the **Backup and Disaster Recovery Guide**. District infrastructure owner confirms schedules and restore drills.

---

## Costs and third parties

### What services does the district pay for?

Typically: **AWS** (hosting, SNS SMS usage), **domain** (GoDaddy), and **email** (Resend or equivalent). PulseEDU application licensing is per your contract with the vendor.

### Does SMS cost extra?

**Yes** — AWS bills per SMS message. Volume depends on how many pullouts and how many dispatch staff have SMS enabled with valid numbers.

---

## Getting help

| Issue type | Who to contact first |
|------------|----------------------|
| Login, roles, school settings | School Admin |
| District-wide or multi-school | District Admin / SuperUser |
| Site down, email/SMS infrastructure | District IT / platform operator |
| Legal/privacy policy | District legal / FERPA officer |

For step-by-step fixes, administrators use the **Troubleshooting Guide**. For configuration tasks, use the **System Administration Guide**.

---

## Document control

| Field | Value |
|-------|--------|
| **Version** | 1.0 |
| **Applies to** | Production at `pulseedu.pulsekinetics.us` |
