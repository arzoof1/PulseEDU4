# PulseEDU — System Administration Guide

**Audience:** School administrators, district administrators (District Admin / SuperUser), and designated IT coordinators  
**Production URL:** https://pulseedu.pulsekinetics.us/  
**Document type:** Operational reference for setup and ongoing administration

---

## 1. Purpose of this guide

This guide explains **how to configure and manage** PulseEDU for a school or district: staff access, schedules, features, imports, parent portal, and day-to-day admin tasks. It is not a troubleshooting guide — use the **Troubleshooting Guide** when something breaks.

---

## 2. Who can administer what

PulseEDU uses **role flags** on each staff account. Common roles:

| Role | Typical administration tasks |
|------|------------------------------|
| **Admin** (school) | Full Settings for their home school, staff/roles, onboarding, imports, parent access, ISS settings |
| **District Admin** | Same as Admin across **all schools in the district** (can switch school context) |
| **SuperUser** | District-wide access plus **Tenancy** (create schools), school plans, logo tools |
| **PBIS Coordinator** | PBIS Hub, reasons, milestones, school store |
| **Dean / Behavior Specialist / MTSS Coordinator** | Behavior workflows, pullouts, investigations (not full Settings) |

Most configuration lives under **Settings** in the sidebar. If you do not see Settings, your account lacks admin capability — contact a school Admin or SuperUser.

---

## 3. First-time school setup (recommended path)

Use the built-in checklist so nothing is missed:

1. Sign in at https://pulseedu.pulsekinetics.us/
2. Open **Settings → Onboarding Checklist**
3. Work through all five phases in order:
   - Identity & Access  
   - Schedule & Operations  
   - Behavior & PBIS  
   - Interventions & MTSS  
   - Family & Outreach  
4. Use **Open →** on each row to jump to the correct screen  
5. Mark steps **done** when complete; download the **PDF checklist** for offline tracking  

The checklist auto-detects some steps (e.g. locations exist, default bell schedule set). Others require manual confirmation.

---

## 4. Settings hub overview

Open **Settings** from the sidebar. Tiles are grouped as follows.

### 4.1 Hall Pass Operations

| Tile | What to configure |
|------|-------------------|
| **Kiosk Setup** | Generate activation for hall-pass kiosks; pair devices to your school |
| **Locations** | Rooms/offices/bathrooms as pass origins and destinations |
| **Teacher Sign-in Allowlist** | Which staff emails may sign in |
| **Staff Directory** | Display names, default rooms, **cell phones** (used for SMS alerts when enabled) |
| **Notifications** | School notification preferences where applicable |

### 4.2 School Identity & Schedule

| Tile | What to configure |
|------|-------------------|
| **School Branding** | Logo, colors, display name (reports and signage) |
| **School Info** | School name, email signature, period count, hall pass time limits |
| **Bell Schedule** | Period times; **mark one schedule as default** (required for hall pass queue period resets) |

### 4.3 Family & Signage

| Tile | What to configure |
|------|-------------------|
| **Parent Portal Sections** | Which HeartBEAT sections parents may see (PBIS, ISS, staff notes, etc.) |
| **Signage / Displays** | TV playlist URLs for hall passes, houses, HeartBEAT displays |

### 4.4 Feature Configuration

| Tile | What to configure |
|------|-------------------|
| **School Features Switchboard** | Turn modules on/off: PBIS, FamilyComm, School Store, Accommodations, Log Intervention, Request Pullout, etc. |
| **PBIS Thresholds** | Quiet teacher, invisible student, reason imbalance alerts |
| **School-wide Expectations** | Acronym (PRIDE, ROAR) for Tier 3 logs |
| **Intervention Strategies** | Tier 3 strategy catalog |
| **ISS Settings** | Daily ISS capacity, soft/hard capacity behavior, closed days, discipline reasons |
| **Separation Reason Tags** | Reasons for student separation pairs |
| **Case Outcomes** | Investigation case outcome types (Admin / District Admin) |
| **Camera Registry** | Named cameras for case video evidence |

### 4.5 Admin & Tenancy (restricted)

| Tile | Who | What to configure |
|------|-----|-------------------|
| **Tenancy** | SuperUser | Create schools, assign district, multi-school context |
| **School Plans** | SuperUser | Subscription/plan assignment per school |
| **Logo Generator** | SuperUser | Brand asset tools |
| **Staff Preview** | Admin+ | QA: preview app as another staff member (banner shown) |
| **Data Importer** | Admin / District Admin | CSV rosters, assessments, behavior history |
| **Onboarding Checklist** | Admin | Launch checklist (this guide’s Section 3) |

---

## 5. Staff access management

### 5.1 Allowlist (who can sign in)

**Settings → Teacher Sign-in Allowlist**

- Toggle staff **on** to grant sign-in  
- New hires must be added before they can log in  
- Bulk paste supported for many emails at once  

### 5.2 Roles and capabilities

**Admin Hub → Staff & Roles** (or equivalent staff management screen)

- Assign role flags (Admin, Dean, MTSS, ISS, PBIS, etc.)  
- **Capability flags** (`cap_*`) control individual pages/features for finer control than roles alone  
- Deactivate staff when they leave — do not leave active accounts for former employees  

### 5.3 Staff directory and SMS readiness

**Settings → Staff Directory**

- Set **default room** (pre-fills hall passes and pullouts)  
- Set **cell phone** in E.164 format (e.g. `+15551234567`) for staff who should receive **SMS** dispatch alerts (Admin, Dean, MTSS, ISS roles)  

---

## 6. Multi-school and district administration

### 6.1 School context

- Regular staff see **one home school**  
- **SuperUser** and **District Admin** can switch schools from the **school badge** in the top bar  
- Data actions always apply to the **active school** shown in the UI  

### 6.2 Adding a new school (SuperUser)

**Settings → Tenancy**

1. Create school under the correct district  
2. Switch into the new school  
3. Run the **Onboarding Checklist** from scratch  
4. Import roster via **Data Importer**  

---

## 7. Data importer administration

**Settings → Data Importer**

| Import type | Typical use |
|-------------|-------------|
| Roster | Students, sections, staff linkage |
| Assessments | FAST, iReady, MAP, etc. |
| Behavior history | Prior PBIS or behavior rows |

**Workflow:**

1. Upload CSV  
2. Review column mapping and **preview**  
3. **Commit** when correct  
4. Use **History** tab to **roll back** a bad import (deletes rows tied to that `import_job_id`)  

**District-wide imports:** District Admin / SuperUser can upload files with a `school_code` column to fan out to multiple schools.

---

## 8. Parent portal administration

### 8.1 Enable visibility

**Settings → Parent Portal Sections**

- School controls which sections exist for parents (interventions, staff notes, ISS, MTSS are **off by default**)  
- Parents cannot enable sections the school has disabled  

### 8.2 Invite parents

**Parent Access** (sidebar section)

1. Select student  
2. Send invite to parent email on file  
3. Parent accepts link, sets password  
4. Parent sees only **linked** students (siblings via additional links)  

### 8.3 Weekly HeartBEAT email

- School can allow or disable weekly email in HeartBEAT settings  
- Parent opts in per student in the parent portal  

---

## 9. Behavior and operations modules

| Module | Admin setup | Daily use |
|--------|-------------|-----------|
| **Hall passes** | Locations, bell schedule, kiosk, allowlist | Teachers issue passes; queue resets per period when default bell schedule exists |
| **PBIS** | Reasons, milestones, school store, switchboard | Staff award points; coordinators run PBIS Hub |
| **Request Pullout** | Enable in switchboard; staff phones in directory | Teachers submit; dispatch roles receive **email** (and **SMS** when configured) |
| **ISS/OSS** | ISS settings, discipline reasons | Admin Hub logs; ISS dashboard for room staff |
| **MTSS** | Templates, strategies, expectations | Coordinators manage plans and weekly records |
| **Investigations** | Cameras, case outcomes | Core Team cases and watchlist |
| **Displays** | Playlists and signage URLs | Hallway TVs |

---

## 10. Feature switchboard (turning modules on)

**Settings → School Features Switchboard**

- Modules **off** are hidden from all staff at that school  
- SuperUser may need to allow a feature at platform level before the school can enable it  
- Enable only what you are ready to train staff on  

Recommended minimum before go-live:

- Allowlist + staff directory + locations + **default bell schedule**  
- Features you will use in the first month (often PBIS, hall passes, pullouts)  

---

## 11. Ongoing maintenance calendar

| Frequency | Task |
|-----------|------|
| **As needed** | Add/deactivate staff; update allowlist |
| **Start of year** | Roster import; section updates; new parent invites |
| **Each term** | Review PBIS reasons and ISS capacity |
| **After incidents** | Review investigation audit needs; rotate staff on dispatch list |
| **Quarterly** | Review parent portal section visibility with leadership |
| **Annually** | Confirm school branding, closed days, discipline reason catalog |

---

## 12. Environment and credentials (client-owned)

Production runs on client AWS infrastructure (see the **AWS Hosting and Infrastructure Overview**). Administrators should ensure:

- DNS for `pulseedu.pulsekinetics.us` remains correct  
- SSL certificate valid  
- `DATABASE_URL` and `SESSION_SECRET` secured on the server only  
- Email (Resend) and SMS (AWS SNS) keys rotated per security policy  

Application admins configure **school data inside PulseEDU**; server secrets are maintained by whoever operates the EC2 host.

---

## 13. Document control

| Field | Value |
|-------|--------|
| **Version** | 1.0 |
| **Applies to** | PulseEDU production at `pulseedu.pulsekinetics.us` |
