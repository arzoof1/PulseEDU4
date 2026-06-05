# PulseEDU — Backup and Disaster Recovery

**Document type:** Operational procedures for data protection and service recovery  
**Audience:** Client infrastructure owners, AWS administrators, and platform operators  
**Production URL:** https://pulseedu.pulsekinetics.us/  
**Environment:** AWS EC2 (`c7i-flex.large`, 50 GB) with co-located PostgreSQL

---

## 1. Purpose and scope

This document defines how PulseEDU production data and services are **backed up**, how they are **restored** after failure, and who is responsible for each step. It supports launch readiness (“backup and recovery plan”) and district expectations for protecting student education records.

| In scope | Out of scope |
|----------|----------------|
| Production PostgreSQL database | Development / Replit preview environments |
| EC2 application host and EBS storage | ClassLink, Resend, or other vendor SaaS internals |
| DNS (`pulseedu.pulsekinetics.us` via GoDaddy) | End-user device backups |
| Application secrets and deploy artifacts | Legal breach notification policy (see district counsel) |

---

## 2. Critical assets

| Asset | Location | Recovery priority |
|-------|----------|-------------------|
| **PostgreSQL database** | EC2 instance (same host as API) | **P0** — all schools and student records |
| **Environment configuration** | Server `.env` (e.g. `DATABASE_URL`, `SESSION_SECRET`, API keys) | **P0** — required for app to start |
| **Application build** | Deployed on EC2; source in git repository | **P1** — redeploy from tagged release |
| **Reverse proxy / TLS config** | EC2 (in front of Node API on port 8080) | **P1** — required for HTTPS |
| **DNS records** | GoDaddy → AWS load balancer | **P1** — required for public access |
| **Uploaded media / imports** | Object storage paths when configured | **P2** — logos, displays, CSV archives |
| **Session table** | PostgreSQL `user_sessions` | **P3** — users re-authenticate after restore |

---

## 3. Current architecture constraints

Understanding these constraints sets realistic recovery expectations:

- **Single EC2 instance** runs the API, static client, and PostgreSQL together.
- **No automatic database failover** unless infrastructure is upgraded (e.g. Amazon RDS Multi-AZ).
- A failure of the instance affects **both** application and database until restore or replacement completes.
- **Load balancer** in front of EC2 allows scaling out later; today recovery is typically **replace or restore one instance**.

Recommended long-term improvements are listed in Section 12.

---

## 4. Backup strategy

Backups should use **multiple layers**. Relying on only one method (e.g. snapshots on the same disk as the live database) is insufficient for serious disaster recovery.

### 4.1 PostgreSQL — logical backup (primary for point-in-time recovery)

| Item | Recommendation |
|------|----------------|
| **Tool** | `pg_dump` (custom format `-Fc` or plain SQL) |
| **Frequency** | At least **daily** (nightly off-peak) |
| **Storage** | **Amazon S3** (or equivalent) in the client AWS account — **not** only on the EC2 root volume |
| **Encryption** | S3 SSE-S3 or SSE-KMS; bucket not public |
| **Retention** | Minimum **30 days** (adjust per district policy) |
| **Naming** | Include date and environment, e.g. `pulseedu-prod-YYYYMMDD.dump` |

**Command example (operator runs on server or backup host with DB access):**

```bash
pg_dump -Fc -h 127.0.0.1 -U <db_user> -d pulseedu -f pulseedu-prod-$(date +%Y%m%d).dump
```

Upload the file to the designated S3 bucket after each run. Automate via cron or AWS Systems Manager.

### 4.2 EBS volume snapshot (primary for full-disk recovery)

| Item | Recommendation |
|------|----------------|
| **Scope** | EBS volume attached to production EC2 (50 GB) |
| **Frequency** | **Daily** automated snapshot via AWS Backup or Data Lifecycle Manager |
| **Retention** | e.g. **7–14 days** (cost vs. recovery window) |
| **Use case** | Fast rollback of entire disk; less granular than `pg_dump` for single-table mistakes |

### 4.3 Application and configuration

| Item | Method |
|------|--------|
| **Source code** | Git repository; deploy known **tag/commit** to production |
| **`.env` secrets** | Encrypted copy in secrets manager or secure vault; **never** only on the live server |
| **Proxy/service config** | Document paths; backup nginx/Caddy/systemd files with infrastructure |

### 4.4 DNS and load balancer

| Item | Method |
|------|--------|
| **GoDaddy DNS** | Export or document A/CNAME records quarterly and after any change |
| **AWS LB target** | Document load balancer ARN, target group, health check path |

### 4.5 In-application recovery (not a substitute for DB backup)

PulseEDU supports **CSV import rollback** for some data: rows tied to an `import_job_id` can be removed without restoring the full database. Use this for a bad roster import before invoking full DR.

---

## 5. Backup schedule (fill with confirmed values)

Infrastructure owner should complete this table and keep it current:

| Backup | Frequency | Retention | Destination | Automated? | Owner | Last successful run |
|--------|-----------|-----------|-------------|------------|-------|---------------------|
| `pg_dump` → S3 | _TBD_ | _TBD_ | S3 bucket: _TBD_ | _TBD_ | Client AWS | _TBD_ |
| EBS snapshot | _TBD_ | _TBD_ | AWS same region | _TBD_ | Client AWS | _TBD_ |
| Secrets inventory | On change | 2 versions | Secure vault | Manual | Client | _TBD_ |
| DNS export | Quarterly | 1 year | Internal IT | Manual | Client | _TBD_ |

---

## 6. Recovery objectives

Targets below are **recommended** for launch planning. Update after restore drills prove achievable.

| Metric | Definition | Recommended target (v1) |
|--------|------------|---------------------------|
| **RPO** | Maximum acceptable data loss | **24 hours** with nightly `pg_dump`; **1 hour** if hourly dumps added |
| **RTO** | Maximum acceptable downtime | **4–8 hours** full instance rebuild; **1–3 hours** DB-only restore to existing host |

Stricter RPO/RTO requires RDS, replication, or warm standby — not the current single-EC2 design.

---

## 7. Recovery procedures

### 7.1 Scenario A — Bad CSV import (limited scope)

**Symptoms:** Wrong roster or assessment data after a committed import.

**Steps:**

1. Identify `import_job_id` in Data Importer history.  
2. Use in-app **rollback** for that job (deletes rows associated with that import).  
3. Re-import corrected CSV after preview validation.  
4. Do **not** restore full database unless rollback is unavailable.

**Verification:** Spot-check student counts and sample records in the affected school.

---

### 7.2 Scenario B — Database corruption or failed migration

**Symptoms:** API errors on all writes; PostgreSQL will not start; obviously corrupt data.

**Steps:**

1. **Stop the API** process to prevent further writes.  
2. Identify latest **known-good** `pg_dump` from S3 (not the failed run).  
3. Create empty database or drop/recreate `pulseedu` database (operator judgment).  
4. Restore:
   ```bash
   pg_restore -h 127.0.0.1 -U <db_user> -d pulseedu --clean --if-exists pulseedu-prod-YYYYMMDD.dump
   ```
   (Adjust flags for plain SQL dumps.)  
5. Start API; run smoke tests (Section 9).  
6. Notify district that sessions were invalidated — users sign in again.

**Verification:** Login, student search, one write action (e.g. test hall pass in non-prod or controlled prod test).

---

### 7.3 Scenario C — EC2 instance failure or loss

**Symptoms:** Instance terminated, hardware failure, unrecoverable OS corruption.

**Steps:**

1. Launch replacement **c7i-flex.large** (or approved size) with **≥ 50 GB** EBS.  
2. **Option 1 — EBS snapshot:** Create volume from latest snapshot; attach to new instance.  
3. **Option 2 — Clean build:** Install OS stack, PostgreSQL, Node; restore `pg_dump`; redeploy app from git tag.  
4. Restore `.env` from secrets vault.  
5. Reattach instance to **load balancer** target group; confirm health checks pass.  
6. Confirm **GoDaddy DNS** still points to load balancer.  
7. Run smoke tests (Section 9).

**Verification:** Public URL loads; HTTPS valid; staff login works.

---

### 7.4 Scenario D — Application-only failure (database intact)

**Symptoms:** 502/503 from proxy; Node crash; bad deploy.

**Steps:**

1. Confirm PostgreSQL is running and reachable on `DATABASE_URL`.  
2. Roll back deploy to previous git tag / build artifact.  
3. Restart API process (systemd/PM2).  
4. Review proxy logs for upstream errors.

**Verification:** `/api` health or login succeeds.

---

### 7.5 Scenario E — DNS or certificate failure

**Symptoms:** Domain does not resolve; certificate warnings.

**Steps:**

1. Verify GoDaddy records against infrastructure documentation.  
2. Verify load balancer listener and certificate attachment.  
3. Re-issue or renew TLS cert if expired.

**Verification:** Browser shows valid HTTPS for `pulseedu.pulsekinetics.us`.

---

### 7.6 Scenario F — Credential compromise

**Symptoms:** Suspected unauthorized access; leaked `.env`.

**Steps:**

1. Follow the **Incident Response and Credential Rotation Runbook** (contain, assess scope).  
2. Rotate `SESSION_SECRET`, database password, `RESEND_API_KEY`, SNS keys, SSH keys.  
3. Invalidate active sessions (all users re-login).  
4. Review audit logs if available.  
5. Consider restore from pre-incident backup if data tampering suspected.

---

## 8. Restore drill (required for launch evidence)

Perform at least **one non-production restore** before marking backup/recovery complete on the launch tracker.

| Field | Record here |
|-------|-------------|
| **Drill date** | |
| **Performed by** | |
| **Method** | `pg_dump` restore / EBS snapshot / other |
| **Environment** | Staging instance or isolated restore VM |
| **Duration** | Start → verified working |
| **Result** | Pass / Fail |
| **Issues found** | |
| **Corrective actions** | |
| **Next drill due** | e.g. quarterly |

---

## 9. Post-recovery smoke tests

After any full or database recovery, verify:

| # | Test |
|---|------|
| 1 | https://pulseedu.pulsekinetics.us loads without certificate errors |
| 2 | Staff login succeeds |
| 3 | Active school context shows expected school name |
| 4 | Student search returns known test student |
| 5 | Read-only admin screen loads (Settings or Admin Hub) |
| 6 | Optional: create and cancel a test hall pass in agreed test school |
| 7 | Parent portal login (if parents exist in restored DB) |

Document results in the restore drill log (Section 8).

---

## 10. Roles and responsibilities

| Role | Responsibility |
|------|----------------|
| **Client / district IT** | Own AWS account, billing, backup automation, S3, snapshots, DNS |
| **Infrastructure operator** | Execute `pg_dump`, snapshots, restore commands, EC2 rebuild |
| **Application operator** | Redeploy app, verify smoke tests, communicate outage window |
| **School administrators** | No backup execution; resume use after all-clear communication |

---

## 11. Security and confidentiality

- Backup files contain **FERPA-protected education records**.  
- Encrypt backups at rest (S3 encryption).  
- Restrict IAM to least privilege; no public read on backup buckets.  
- Transfer dumps only over TLS (S3 HTTPS).  
- Delete local dump files on EC2 after upload to S3.  
- Align retention with district records retention policy.

---

## 12. Roadmap (recommended upgrades)

| Upgrade | Benefit |
|---------|---------|
| **Amazon RDS for PostgreSQL** | Automated backups, PITR, separation from app server |
| **Multi-AZ RDS** | Lower RTO for database failures |
| **Separate EC2 for app only** | DB survives app compromise/rebuild |
| **Cross-region S3 replication** | Protection against regional outage |
| **AWS Backup centralized policies** | Audit and compliance reporting |

---

## 13. Communication during outage

| Audience | Message |
|----------|---------|
| **District leadership** | Estimated RTO, data loss window (RPO), no action required from schools until cleared |
| **School staff** | “PulseEDU is temporarily unavailable; do not use paper workaround policy per district” |
| **Parents** | Only if parent portal down beyond SLA; use district communication channels |

Maintain a contact list: infrastructure on-call, application on-call, district IT lead.

---

## 14. Document control

| Field | Value |
|-------|--------|
| **Version** | 1.0 |
| **Applies to** | Production — `pulseedu.pulsekinetics.us` |
| **Review trigger** | After infra change, failed drill, or annual review |
| **Sections requiring client input** | Section 5 schedule table, Section 8 drill log |

**Action before launch sign-off:** Infrastructure owner completes Section 5 and passes one restore drill (Section 8).
