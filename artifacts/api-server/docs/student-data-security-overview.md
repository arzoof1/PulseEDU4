# PulseEDU — Student Data Security Overview

**Document type:** Client-facing security and privacy overview  
**Audience:** District administrators, school leadership, technology staff, and legal counsel  
**Production URL:** https://pulseedu.pulsekinetics.us/

---

## 1. Purpose

This document explains **what student-related data PulseEDU stores**, **where it is stored**, **how it is protected**, and **who may access it**. It supports launch discussions with districts, school boards, and technology teams.

> **Note:** This is a technical and operational security overview. Legal determinations under FERPA, COPPA, and state law require review by district counsel. Compliance alignment detail is in the **FERPA Alignment Summary** and **COPPA Alignment Summary** (included in this documentation package).

---

## 2. What PulseEDU is

PulseEDU is a **school-operated web application** used by authorized staff for daily operations (behavior, hall passes, MTSS, ISS, investigations, parent communication, and analytics). Parents may access a **limited, school-controlled view** of their child’s information through an invite-only portal.

PulseEDU is **not** a consumer application for students to self-register or browse social content.

---

## 3. Categories of student information stored

Depending on enabled features and imports, PulseEDU may store:

| Category | Examples | Typical source |
|----------|----------|----------------|
| **Identity & enrollment** | District student ID, name, grade, school assignment | SIS import, CSV, or future ClassLink sync |
| **Demographics / programs** | ELL, ESE, 504, gender, race/ethnicity (when imported) | SIS / roster feed |
| **Family contact** | Parent/guardian name, email, phone | Roster or manual entry |
| **Daily operations** | Hall passes, tardies, PBIS points, pullouts | Staff in application |
| **Support & intervention** | MTSS plans, accommodations, safety plans, trusted adults | Staff and coordinators |
| **Discipline / ISS** | ISS/OSS assignments, attendance in ISS room | Admin and ISS staff |
| **Investigations** | Interactions, cases, witness statements (Core Team) | Authorized staff |
| **Academics (where enabled)** | FAST and other assessment imports | CSV importers |
| **Parent portal visibility** | Subset of above, per school toggles | School configuration |

PulseEDU stores **education records** used by schools for official purposes, not marketing profiles of children.

---

## 4. Where data is stored

| Layer | Location | Notes |
|-------|----------|-------|
| **Primary database** | PostgreSQL on production AWS EC2 | All structured school and student records |
| **Sessions** | PostgreSQL (`user_sessions`) | Staff and parent login sessions |
| **Uploaded files** | Object storage (when configured) | Logos, signage media, import files — tenant-bound |
| **Email delivery** | Resend (third party) | Message content for notifications; provider processes recipient addresses |
| **SMS (when enabled)** | AWS SNS | Short staff alerts; minimal message content |
| **Application code** | Git repository + deployed build on EC2 | No student data in source code |

Production hosting is summarized in the **AWS Hosting and Infrastructure Overview**.  
Database structure is described in the **Database Architecture Overview**.

---

## 5. How data is protected

### 5.1 Network and transport

- Production is served over **HTTPS** (`https://pulseedu.pulsekinetics.us`).
- **TLS** encrypts data in transit between browsers and the server.
- API requests from the official site use **same-origin** `/api` paths where configured.

### 5.2 Authentication

| User type | Method |
|-----------|--------|
| **Staff** | Email + password; session stored in **HttpOnly** cookie |
| **Parents** | Invite-only account; separate login from staff |
| **Kiosk** | School-issued activation tokens (not full staff accounts) |

Production cookies use `Secure` flag over HTTPS and `SameSite=Lax`. Optional staff bearer tokens are **disabled by default** in production.

### 5.3 Authorization and school isolation

- Every school’s operational data is scoped by **`school_id`**.
- Staff see data for their **active school** (SuperUser/District Admin can switch within their district only).
- **Role flags** (Admin, Dean, MTSS, Teacher, etc.) control which features and screens are available.
- **Parent portal** shows only students linked to that parent; schools control which sections are visible.

Queries are designed so one school cannot read another school’s records when the system is used as intended.

### 5.4 Application security controls

| Control | Purpose |
|---------|---------|
| **CSRF protection** | Prevents cross-site abuse of logged-in staff/parent sessions |
| **CORS allowlist** | Blocks unauthorized websites from calling the API with browser credentials |
| **Helmet / CSP** | Reduces common web attacks in production |
| **Rate limiting** | Throttles repeated failed logins |
| **Structured logging** | Request logging without exposing secrets in URLs |

### 5.5 Encryption at rest

- Encryption at rest is provided by the **hosting layer** (EBS volume, PostgreSQL, S3 policies).
- PulseEDU does not implement separate field-level encryption for standard roster columns; districts should enable provider encryption on database and backups.

### 5.6 AI and external models (where used)

For case consistency and similar features, **student names are replaced with aliases** before text is sent to an external model. Authorized staff see real names only inside the protected application.

### 5.7 Notifications and minimal exposure

- **Email** may include more context for operational messages (e.g. pullout details to dispatch staff).
- **SMS** is designed for **short staff alerts without student PII** in the message body.

---

## 6. Who can access student data

| Actor | Access level |
|-------|----------------|
| **School staff** | Role-based access within their school (and district roles across district schools) |
| **Parents** | Linked students only; school-limited HeartBEAT sections |
| **Platform operators** | Infrastructure and application support under contract — not for routine browsing of student records |
| **Third-party processors** | Hosting, email, SMS, future ClassLink — only as needed to provide the service |

Schools remain the **owner** of education records; PulseEDU processes them on the school’s direction.

---

## 7. Audit, retention, and incident response

| Topic | Practice |
|-------|----------|
| **Audit trails** | Investigation cases, safety plans, and other domains maintain change history; HTTP access is logged |
| **Retention** | Defined by district contract and policy; export/deletion on transition off platform |
| **Backups** | Database backups per the **Backup and Disaster Recovery Guide** |
| **Incidents** | **Incident Response and Credential Rotation Runbook** — containment, rotation, district notification |

---

## 8. District and school responsibilities

To maintain security, districts and schools should:

1. Manage **staff access** (allowlist, deactivate leavers, appropriate roles).  
2. Configure **parent portal** sections to match district disclosure policy.  
3. Keep **roster and contact data** accurate.  
4. Use **HTTPS** and supported browsers only; discourage password sharing.  
5. Report suspected misuse or unauthorized access immediately.  
6. Complete **legal review** of FERPA/COPPA posture before launch.  
7. Maintain **AWS and domain** ownership with secured credentials.

---

## 9. Subprocessors and integrations

When enabled, these services may process data:

| Service | Function |
|---------|----------|
| **AWS** | Hosting, database storage, SNS SMS |
| **GoDaddy** | DNS for public domain |
| **Resend** | Transactional email |
| **ClassLink / OneRoster** (planned) | Roster sync into PulseEDU |

A formal subprocessor list should appear in the district **data processing agreement**.

---

## 10. Verification and launch evidence

Before launch sign-off, the district may request evidence that controls are operating in production. The following companion documents in the launch package describe what to verify and how:

| Evidence type | Document in launch package |
|---------------|----------------------------|
| HTTPS and cookie settings | **Security Verification Checklist** (sections 1–2) |
| CSRF and CORS | **Security Verification Checklist** (sections 3–4) |
| School isolation test | **Security Verification Checklist** (section 5) |
| Backup and restore | **Backup and Disaster Recovery Guide** |
| Technical control map (engineering) | **Security and Privacy Evidence Pack** |

---

## 11. Document control

| Field | Value |
|-------|--------|
| **Version** | 1.0 |
| **Applies to** | PulseEDU production |
| **Review** | After major architecture or compliance changes |
