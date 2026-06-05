# PulseEDU — FERPA Alignment Overview

**Document type:** Technical and operational alignment summary  
**Audience:** School districts, administrators, and legal counsel  
**Status:** Requires district/legal review before launch sign-off  

> **Disclaimer:** This document describes how PulseEDU is designed to support FERPA-aligned use. It is not legal advice. Final FERPA compliance determinations depend on your district’s policies, contracts, and counsel.

---

## 1. What FERPA Is (in this context)

The Family Educational Rights and Privacy Act (FERPA) protects the privacy of student **education records** and limits who may access them without appropriate authorization.

PulseEDU is intended to be used by **schools and districts** as an operational tool for authorized school personnel—not as a public consumer app open to arbitrary users.

---

## 2. Role of PulseEDU

| Party | Role |
|--------|------|
| **School / district** | Owns student education records; decides who may access them and for what educational purpose |
| **PulseEDU (service)** | Processes records on the school’s behalf under the school’s direction and access rules |
| **Staff users** | School officials or designees acting within assigned roles |
| **Parent users** | Adults invited by the school to view information about their linked student(s) only |

---

## 3. Categories of Student Information Stored

PulseEDU may store education-related data including, depending on enabled features:

| Category | Examples (non-exhaustive) |
|----------|---------------------------|
| **Identifiers** | District student ID, name, grade, school assignment |
| **Demographics / program flags** | ELL, ESE, 504, gender, race/ethnicity (when imported from roster) |
| **Contact** | Parent/guardian name, email, phone (when provided by school) |
| **Behavior & operations** | PBIS points, hall passes, tardies, pullouts, ISS/OSS records |
| **Support & intervention** | MTSS plans, accommodations, safety plans, trusted adults |
| **Academic (where enabled)** | FAST scores and related progress data |
| **Investigations (where enabled)** | Case notes, witness statements, interaction records (staff-only; AI features use de-identified aliases before external model calls) |

Source of truth for roster fields is typically the school’s SIS or CSV import; operational data is created by authorized staff in PulseEDU.

---

## 4. How Access Is Restricted to Authorized Users

### 4.1 Authentication

- **Staff:** Session-based login (HttpOnly cookies in production); optional bearer tokens are disabled by default in production unless explicitly enabled.
- **Parents:** Separate identity system (`parents` table); invite-based account creation with password set on accept; not the same login as staff.

### 4.2 Multi-tenant isolation (school scoping)

- Data is scoped by `school_id` on tenant tables.
- API requests resolve an active school context (`req.schoolId`) for staff.
- Queries on school-scoped resources are intended to include `school_id` filters so one school cannot read another school’s records when correctly configured.

### 4.3 Role-based access control (RBAC)

Staff capabilities are enforced via role flags (e.g., Admin, Dean, MTSS Coordinator, ISS, PBIS, Core Team) and route-level checks. Sensitive areas (settings, investigations, certain admin actions) require appropriate roles.

### 4.4 Parent portal boundaries

- Parents see only students linked via `parent_students` after accepting a school-issued invite.
- What parents can see is further limited by **school HeartBEAT settings** (admin toggles per section) and optional parent preferences (parents can hide sections the school has enabled; they cannot enable sections the school has disabled).
- Sensitive sections (e.g., interventions, staff notes, ISS/MTSS) are **off by default** until the school opts in.

### 4.5 Staff directory sensitivity

- Staff cell phone numbers in the directory can be redacted from API responses based on school policy (`staff_directory_show_cell_phone`).

---

## 5. Use of Third-Party Services (Subprocessors)

Schools should be aware that certain features rely on infrastructure and vendors configured for deployment, for example:

| Service | Typical use |
|---------|-------------|
| **PostgreSQL hosting** | Primary database for education records |
| **Application hosting** | API and web client (e.g., district-owned server or cloud) |
| **Resend (or similar)** | Transactional email (parent invites, notifications, HeartBEAT digests) |
| **AWS SNS (when enabled)** | SMS alerts to staff (e.g., pullout dispatch); message content should avoid unnecessary student PII |
| **Object storage** | School branding, display media, uploads (tenant-bound where implemented) |
| **ClassLink / OneRoster (when enabled)** | Roster sync and/or SSO per district configuration |

A formal **subprocessor list** should be maintained in the district contract or Data Processing Agreement (DPA).

---

## 6. Security Controls Supporting FERPA

Technical controls documented in the **Security and Privacy Evidence Pack** include:

- HTTPS in production  
- Secure session cookies (`httpOnly`, `secure` in production)  
- CSRF protection on session-authenticated mutating requests  
- CORS allowlist  
- Helmet / CSP (production)  
- Structured logging (URLs logged without query strings by default)  
- Domain audit trails for selected workflows (e.g., cases, safety plans)  

Operational controls are described in:

- **Security Verification Checklist**  
- **Incident Response and Credential Rotation Runbook**  

---

## 7. Directory Information vs. Non-Directory Records

FERPA distinguishes **directory information** (often publishable with notice/opt-out) from other education records.

- PulseEDU stores both operational/education records and fields that may overlap with directory information (e.g., name, grade).
- **Whether** a field may be shared as directory information is a **school/district policy** decision, not determined by PulseEDU alone.
- Schools should align PulseEDU parent-portal visibility settings with their directory-information and parent-notification policies.

---

## 8. Parent Rights Under FERPA

FERPA grants parents (and eligible students) rights including inspection and amendment of education records, subject to school procedures.

**In PulseEDU:**

- Parents access a **limited, school-configured view** (HeartBEAT / parent portal), not the full education record held by the district.
- Requests to inspect, correct, or dispute official records should be directed to the **school/district**, which may use PulseEDU exports or SIS processes as appropriate.
- PulseEDU does not replace the district’s official records request process.

---

## 9. Data Retention and Deletion

Retention and deletion should be defined in the **services agreement** between the district and the platform operator. Recommended practices:

- Define retention period after contract end.  
- Define export format and timeline for transition off the platform.  
- Define secure deletion of tenant data from production systems and backups per policy.  
- Document roster import rollback (import job ID) for correcting bad imports without affecting unrelated records.

---

## 10. Incident Response and Breach Notification

Suspected unauthorized access to student data should follow the **Incident Response and Credential Rotation Runbook**, including:

- Containment and scope assessment  
- Credential rotation where needed  
- Notification to the district per contract and applicable law  

Districts remain responsible for notifying affected parties when required by law and policy.

---

## 11. What the School / District Must Do

Before launch, the district should:

1. Execute appropriate agreements (terms of service, DPA, or equivalent) defining PulseEDU as a school official or service provider under FERPA, as counsel advises.  
2. Confirm staff are trained on acceptable use and role assignments.  
3. Configure parent portal visibility to match district policy.  
4. Maintain accurate roster and parent contact data.  
5. Assign an internal owner for access reviews (staff offboarding, allowlist updates).  
6. Obtain **legal sign-off** on this alignment summary and contract language.

---

## 12. Launch Sign-Off Checklist (FERPA)

| Item | Owner | Status |
|------|--------|--------|
| DPA / school official designation reviewed by counsel | District legal | |
| Subprocessor list agreed | District + vendor | |
| Staff access and role matrix documented | School IT / admin | |
| Parent portal section toggles reviewed | School admin | |
| Tenant isolation test evidence collected | Engineering | |
| Incident response contacts assigned | District + vendor | |
| Retention/deletion terms in contract | District legal | |

---

## 13. Companion documents (launch package)

These documents are provided together with this summary:

- **Security and Privacy Evidence Pack**  
- **Security Verification Checklist**  
- **Incident Response and Credential Rotation Runbook**  
- **COPPA Alignment Summary**  
- **Launch Readiness Tracker** (spreadsheet)  
