# PulseEDU — COPPA Alignment Overview

**Document type:** Technical and operational alignment summary  
**Audience:** School districts, administrators, and legal counsel  
**Status:** Requires district/legal review before launch sign-off  

> **Disclaimer:** This document describes how PulseEDU is designed with respect to the Children’s Online Privacy Protection Act (COPPA). It is not legal advice. COPPA applicability and consent models in a school context should be confirmed by qualified counsel.

---

## 1. What COPPA Is (in this context)

COPPA regulates the online collection of personal information from children **under 13** by operators of websites and online services directed to children, or with actual knowledge that they are collecting from children under 13.

In a **K–12 school setting**, many ed-tech products are used under the school’s authority, and consent may be handled through the school’s relationship with parents (school official / educational purpose framework), depending on how the service is used and what counsel advises.

---

## 2. How PulseEDU Is Used (relevant to COPPA)

| User type | Typical use | COPPA relevance |
|-----------|-------------|-----------------|
| **Staff (teachers, admins, etc.)** | Primary users; operate the platform on behalf of the school | Adults; not child-directed account creation |
| **Parents / guardians** | Invite-only parent portal; view linked student’s school-shared information | Adult accounts; not student self-registration |
| **Students** | Generally do **not** create PulseEDU accounts or log in to the staff app | Reduces direct child-to-operator collection |
| **Kiosk / signage** | School-operated devices (hall pass kiosk, displays) under staff/school control | Not a child-directed social or marketing app |

PulseEDU is designed as a **school operations platform**, not a consumer app marketed directly to children under 13 for independent sign-up.

---

## 3. Does PulseEDU Collect Information Directly From Children?

**By default design:**

- Students do not register for staff accounts.
- The parent portal requires a **school-issued invite** and adult password creation.
- Operational data about students is entered or imported by **authorized school staff** (or synced from roster sources), which is consistent with school recordkeeping rather than unsolicited child registration.

**If** a district enables features where students interact directly with the system in a way that collects personal information online, that use case should be reviewed with counsel and documented in the district agreement.

---

## 4. Categories of Student Information (same data, COPPA lens)

When student data relates to users under 13, COPPA-relevant practices include limiting collection to what is needed for the educational purpose and securing it appropriately.

PulseEDU may process student personal information including:

- Name, student ID, grade, school  
- Parent/guardian contact information  
- Behavior, attendance-related, and support records (as configured)  
- Demographic/program flags when imported from roster  

Collection should be **purpose-limited** to school operations configured by the district.

---

## 5. Parental Consent and School Authorization

Common models (counsel to confirm which applies):

1. **School as agent:** The school authorizes collection/use of student information for educational purposes under its policies and notices to parents.  
2. **Direct parental consent:** Required for certain child-directed services; less typical for staff-operated school systems.

**PulseEDU practices that support a school-authorization model:**

- Parent access only after **admin-sent invite** tied to a specific student.  
- School controls which portal sections are visible (`school_heartbeat_settings`).  
- Parents cannot expand access beyond what the school enables.

**District action:** Ensure parent notices, handbooks, or consent processes cover use of district-approved educational technology, including PulseEDU, as counsel recommends.

---

## 6. Parent Portal — Privacy Controls

| Control | Description |
|---------|-------------|
| **Invite-only onboarding** | Token-based invite; expires; can be revoked |
| **Separate auth** | Parents are not staff users; isolated session identity |
| **Linked students only** | `parent_students` limits which student records a parent can access |
| **School section gates** | Interventions, staff notes, ISS, MTSS, OSS details off by default |
| **Parent preferences** | Parents may hide sections the school has enabled; cannot enable disabled sections |
| **Weekly email opt-in** | Parent must opt in; school can disable weekly email feature entirely |
| **Tenant check on email** | Weekly HeartBEAT email refuses send if parent school ≠ student school |

---

## 7. Notifications (Email / SMS)

- **Email** (e.g., Resend): used for invites, milestones, pullout/dispatch, optional weekly PDF.  
- **SMS** (e.g., AWS SNS, when enabled): intended for **staff** operational alerts (e.g., pullout dispatch), not marketing to children.

**Privacy practice:** Avoid including unnecessary student PII in SMS bodies; use short operational messages and in-app review for details.

---

## 8. AI and External Processing

For case consistency and similar features, student names and sensitive identifiers are **replaced with aliases** before data is sent to an external model; real names are re-associated only in staff UI for authorized users.

Districts should list AI/subprocessor use in agreements and notices as required.

---

## 9. Security Measures (supporting COPPA’s data protection expectations)

Align with the **Security and Privacy Evidence Pack**:

- Access control and authentication  
- Encryption in transit (HTTPS)  
- Encryption at rest via hosting provider  
- CSRF, CORS, session hardening  
- Logging and incident response runbook  

---

## 10. Third-Party Services (operators / subprocessors)

Schools should disclose to parents (per district policy) that PulseEDU may use:

- Cloud hosting and database  
- Email delivery provider  
- SMS provider (when enabled)  
- Roster/SSO providers (e.g., ClassLink, when enabled)  
- Object storage for media  

Maintain an updated subprocessor list in the DPA.

---

## 11. Parent Rights (access, deletion, correction)

| Request type | Recommended handling |
|--------------|----------------------|
| **View child’s information** | Parent portal (limited view) + district records process for official copies |
| **Correct inaccurate data** | District directs correction in SIS/roster or school admin updates source data in PulseEDU |
| **Delete account / stop portal access** | Revoke invite, deactivate parent account; district defines retention for underlying education records |
| **Opt out of weekly email** | Parent preference + school `allow_weekly_email` setting |

PulseEDU supports operational controls; **legal obligations and responses** remain with the school/district.

---

## 12. What the School / District Must Do

1. Confirm with counsel whether COPPA applies and which consent/notice model applies.  
2. Include PulseEDU in district privacy notices and approved technology lists.  
3. Configure parent portal sections consistent with what the district is willing to share with parents.  
4. Use invite workflow only for legitimate parent/guardian contacts.  
5. Train staff not to enter unnecessary personal data.  
6. Review subprocessors and AI use with counsel.  
7. Obtain **legal sign-off** before marking COPPA review complete on the launch tracker.

---

## 13. Launch Sign-Off Checklist (COPPA)

| Item | Owner | Status |
|------|--------|--------|
| Counsel confirms COPPA applicability and consent model | District legal | |
| Parent notice / handbook updated | District | |
| Parent portal defaults reviewed (sensitive sections off unless intended) | School admin | |
| No unintended student self-registration path | Engineering (verified) | |
| Subprocessor / AI disclosure complete | District + vendor | |
| SMS/email content avoids unnecessary child PII | Engineering + ops | |
| Incident response path documented | District + vendor | |

---

## 14. Companion documents (launch package)

These documents are provided together with this summary:

- **FERPA Alignment Summary**  
- **Security and Privacy Evidence Pack**  
- **Security Verification Checklist**  
- **Incident Response and Credential Rotation Runbook**  
- **Launch Readiness Tracker** (spreadsheet)  
