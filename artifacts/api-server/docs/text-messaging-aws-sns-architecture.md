# PulseEDU — Text Messaging Architecture (AWS SNS)

**Document type:** Technical and operational reference  
**Audience:** Client administrators, district IT, and platform operators  
**Production URL:** https://pulseedu.pulsekinetics.us/

---

## 1. Document status

| Item | Status |
|------|--------|
| **AWS SNS account setup** | Configured on client AWS account (billing verified) |
| **Application integration** | **Planned — rolling out next week** |
| **Email dispatch (pullouts)** | **Live today** (Resend) |
| **SMS dispatch (pullouts)** | **Planned** — behavior described in this document matches intended implementation |

This document describes the **target architecture** so schools know what to expect. Minor implementation details (exact env var names, log table columns) may be adjusted during rollout; the **workflow and data flow will not change materially**.

---

## 2. Purpose

PulseEDU uses **SMS for short, time-sensitive staff alerts** — starting with **Request Pullout dispatch notifications**. SMS is not a separate product; it is triggered by the same events as email, using phone numbers already stored for staff in the school directory.

**Design principles:**

- **Staff-only operational texts** for launch (not mass parent texting).  
- **No student PII in SMS body** (no student name, ID, or behavior reason in the text).  
- **School-scoped** recipients (only staff at the pullout’s school).  
- **Email remains** as parallel channel; SMS failure does not block pullout creation.  

---

## 3. Why AWS SNS (not a separate SMS app)

| Approach | Role |
|----------|------|
| **Amazon SNS** | Delivers SMS to phone numbers; client-owned AWS billing and compliance |
| **PulseEDU API** | Decides **when**, **who**, and **what message** to send |
| **PostgreSQL** | Stores staff **cell phone** numbers and notification status |

SNS does **not** know about pullouts, schools, or roles. The application reads recipients from the database and calls SNS `Publish` per valid mobile number.

---

## 4. High-level flow (Request Pullout)

```mermaid
sequenceDiagram
  participant Teacher
  participant API as PulseEDU API
  participant DB as PostgreSQL
  participant Email as Resend Email
  participant SNS as AWS SNS

  Teacher->>API: Submit Request Pullout
  API->>DB: Insert pullout (pending)
  API->>DB: Load dispatch staff (roles + school_id)
  par Email today
    API->>Email: Send dispatch email
    Email-->>API: sent / error
    API->>DB: Save dispatch_email_* status
  and SMS planned
    API->>DB: Read cell_phone per dispatcher
    API->>SNS: Publish SMS (E.164 number)
    SNS-->>API: messageId / error
    API->>>DB: Save dispatch_sms_* status
  API-->>Teacher: Pullout created (success regardless of SMS)
```

**Trigger:** Teacher (or referring staff) submits a **Request Pullout**.

**Recipients (same as email dispatch today):** Active staff at the **same school** with any of these roles:

- Admin  
- Dean of Students  
- MTSS Coordinator  
- ISS Teacher  

**Phone source:** `staff.cell_phone` in **Settings → Staff Directory** (must be valid mobile, E.164 format recommended, e.g. `+15551234567`).

**Message content (planned):** Short operational text, for example:

> PulseEDU: New pullout request at [School Name]. Please review in Admin Hub.

Details (student, period, reason) remain in the app and in **email**, not in SMS.

---

## 5. AWS infrastructure (client account)

| Component | Responsibility |
|-----------|----------------|
| **AWS account** | Client-owned; paid/billing-verified (required for production SMS) |
| **SNS SMS** | Enabled in target region; origination identity registered per AWS/carrier rules |
| **IAM credentials** | Least privilege: `sns:Publish` for application runtime |
| **Spend limits** | SNS SMS monthly spend cap configured to prevent runaway cost |
| **Delivery logging** | CloudWatch logs for SNS delivery status (recommended) |

**Not stored in SNS:** Recipient phone books. Numbers are passed per message from PulseEDU at send time.

---

## 6. Application configuration (planned)

Environment variables on the production API server (exact names may match below):

| Variable | Purpose |
|----------|---------|
| `SMS_ENABLED` | `true` to send; `false` to disable instantly without code deploy |
| `AWS_REGION` | Region where SNS is configured (e.g. `us-east-1`) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Or instance IAM role with SNS publish (preferred) |
| `SMS_DEFAULT_TYPE` | Optional: `Transactional` for operational alerts |

Email continues to use **Resend** (`RESEND_API_KEY`, `RESEND_FROM_EMAIL`) independently of SMS.

---

## 7. Recipient rules and school control

| Rule | Detail |
|------|--------|
| **Role-based** | Only dispatch roles listed in Section 4 |
| **Active staff** | Inactive accounts are skipped |
| **Valid phone** | Empty or invalid numbers skipped; logged as skipped |
| **School scope** | Staff must belong to pullout’s `school_id` |
| **No parent SMS (launch)** | Parent-facing texts (e.g. return-to-class) are **future**; launch focuses on staff dispatch |

**School administrator actions:**

1. Ensure dispatch staff have correct **cell phone** in Staff Directory.  
2. Test with one known mobile before go-live.  
3. Ask staff to save PulseEDU dispatch number as contact (reduces ignored texts).  

There is no separate “SMS subscriber list” in AWS — the database is the list.

---

## 8. Privacy and compliance

| Topic | Practice |
|-------|----------|
| **FERPA** | SMS to **school staff** for official duties; message minimized |
| **Content** | No student name, ID, or discipline reason in SMS |
| **Logging** | Send attempts logged (success/fail, recipient, timestamp) for support |
| **Costs** | Per-message AWS charges; district owns AWS bill |

---

## 9. Reliability and failure behavior

| Behavior | Detail |
|----------|--------|
| **Pullout creation** | Succeeds even if SMS fails |
| **Email** | Continues to send in parallel when configured |
| **Partial success** | Some numbers may succeed and others fail; each logged |
| **Idempotency** | Re-submit or duplicate dispatch will not spam (same idempotency pattern as email) |
| **Disable switch** | `SMS_ENABLED=false` stops all SNS sends |

---

## 10. Costs (estimates)

Costs are **variable** by country, message length, and volume.

| Factor | Notes |
|--------|-------|
| **AWS SNS** | Per SMS segment; US transactional typically low per message |
| **Volume driver** | Number of pullouts × dispatchers with valid phones |
| **Control** | SNS spend limit; monitor in AWS Cost Explorer |

Example planning only: 20 pullouts/day × 4 staff × 30 school days ≈ 2,400 messages/month — confirm pricing in AWS console for your region.

---

## 11. Testing before go-live

| Step | Owner |
|------|--------|
| 1. Confirm SNS can publish to a test mobile in AWS console or CLI | Infrastructure |
| 2. Set `SMS_ENABLED=true` and credentials on staging or prod | Infrastructure |
| 3. Enter test staff cell numbers in Staff Directory | School admin |
| 4. Submit test pullout; verify text + email | Application + school |
| 5. Verify skipped behavior when phone missing | Application |
| 6. Document result on launch tracker | Project team |

---

## 12. Future extensions (not launch)

These require **separate** product work; SNS enablement alone does not activate them:

| Feature | Notes |
|---------|-------|
| Parent SMS (return-to-class, ISS) | Different recipients (`parent_phone`); consent/policy review |
| Parent ↔ teacher messaging | New UI, permissions, and workflows |
| Per-school SMS templates admin UI | May follow after launch |
| Two-way SMS (replies) | Not in SNS publish model; would need different service |

---

## 13. Troubleshooting

See the **Troubleshooting Guide**, Section 9 (Pullouts and notifications). Common causes:

- Missing/invalid `cell_phone`  
- SNS sandbox or billing restriction (resolved after AWS upgrade)  
- Carrier filtering — keep messages short and operational  
- `SMS_ENABLED` false  

---

## 14. Document control

| Field | Value |
|-------|--------|
| **Version** | 1.0 (pre-implementation architecture) |
| **Implementation target** | Next week |
| **Review after** | First production SMS send + launch tracker update |
