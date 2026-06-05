# PulseEDU — FERPA & COPPA Summary (Client-Facing)

**One-page overview for districts and launch sign-off.**  
Full detail is in the **FERPA Alignment Summary** and **COPPA Alignment Summary** (included in this documentation package).

> Legal review by district counsel is required before final compliance sign-off.

---

## Purpose

PulseEDU helps schools manage daily operations (behavior, hall passes, MTSS, ISS, parent communication, and related workflows). Student data is processed **for the school’s educational purposes** under the school’s access policies.

---

## FERPA (education records)

| Topic | PulseEDU approach |
|-------|-------------------|
| **Who owns the data** | The school/district |
| **Who can access** | Authorized staff by role; parents only for linked students via invite |
| **Isolation** | School-scoped (`school_id`) multi-tenant design |
| **What is stored** | Roster and operational education records (behavior, support, academics where enabled) |
| **Third parties** | Hosting, database, email; optional SMS and roster/SSO per deployment |
| **Parent rights** | Portal provides a limited view; formal FERPA requests go through the district |
| **Incidents** | Documented response and rotation runbook; district notified per contract |

**District must:** Execute appropriate agreements, configure portal visibility, train staff, assign access owners, and obtain legal sign-off.

---

## COPPA (children under 13 online)

| Topic | PulseEDU approach |
|-------|-------------------|
| **Directed to children?** | No — primary users are school staff; not a child sign-up consumer app |
| **Student accounts** | Students do not self-register for staff/parent login systems by default |
| **Parent access** | Invite-only adult accounts; school controls visible sections |
| **Collection** | Student data entered/imported by school systems and staff for school operations |
| **Consent** | Typically via school’s authority and parent notices (counsel to confirm) |
| **Messaging** | Operational email/SMS; avoid unnecessary student PII in short alerts |

**District must:** Confirm consent/notice model with counsel, update privacy notices, configure sensitive portal sections off unless intended.

---

## Launch status (typical)

| Item | Engineering | Legal / district |
|------|-------------|------------------|
| Technical access controls | Documented + verification checklist | Review evidence |
| FERPA alignment summary | FERPA Alignment Summary (this package) | Sign-off |
| COPPA alignment summary | COPPA Alignment Summary (this package) | Sign-off |
| DPA / subprocessor list | Provide list to district | Execute agreement |

---

## Contact / ownership (fill before launch)

| Role | Name | Email |
|------|------|-------|
| District data owner | | |
| District legal contact | | |
| Platform technical contact | | |
| Incident escalation (DevOps) | | |
