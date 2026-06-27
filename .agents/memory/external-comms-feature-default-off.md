---
name: External-comms feature flags default OFF
description: Why family/parent-email-triggering feature flags opt-in at both gate halves
---

Feature flags whose effect is sending email (or any message) to families/parents
must default FALSE on BOTH halves of the feature-licensing dual gate (the district/
SuperUser `superFeature*` half AND the school-admin `feature*` half). Effective =
super && admin; a SuperUser disable wins.

**Why:** the repo convention is `default(true)` for most feature flags, but external
communication to families is high-blast-radius — turning it on must be a deliberate,
two-level opt-in (district enables the capability, school admin flips it on). Shipping
it default-on would email real guardians the moment the code merges.

**How to apply:** when adding any feature that emails/texts families on an event
(fulfillment, alerts, digests), register it in both FEATURE_KEYS registries like any
gate, but set the schema column defaults to FALSE and add a FALSE-default boot ensure
in seed.ts (don't piggyback on a default(true) ensure loop). Precedent: School Store
fulfillment notify (`featureSchoolStoreNotify` / `superFeatureSchoolStoreNotify`).
