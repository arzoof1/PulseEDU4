# OneRoster v1.1 fixture dataset (ClassLink-style)

Synthetic roster data for local development and tests **before** district ClassLink credentials are available.

## Format

Responses follow the [OneRoster 1.1 JSON binding](https://www.imsglobal.org/oneroster-v11-final-specification):

| File | Simulated endpoint | Root key |
|------|-------------------|----------|
| `orgs.json` | `GET /orgs` | `orgs` |
| `users.json` | `GET /users` | `users` |
| `courses.json` | `GET /courses` | `courses` |
| `classes.json` | `GET /classes` | `classes` |
| `enrollments.json` | `GET /enrollments` | `enrollments` |
| `demographics.json` | `GET /demographics` | `demographics` |

Collection responses use the **plural** root key; single-item endpoints would use the singular key (`user`, `class`, etc.).

## Scenario

**Hernando County School District** — pilot school **D. S. Parrott Middle School**

- District org `org-hernando-district`
- School org `org-parrott-0241` with `identifier: "0241"` (matches PulseEDU `schools.state_school_code`)
- 8 students (grade 6), 3 teachers, 1 administrator
- 4 scheduled classes (periods 1–4) with student + teacher enrollments
- Demographics rows keyed by the same `sourcedId` as each student user

## Base URL (for `href` fields)

```
https://demo.classlink.com/oneroster/v1p1
```

## Usage

Set `CLASSLINK_MOCK=true` (or `useFixtures: true` in `district_integrations.sis_config`), then call `ClasslinkRosterAdapter`:

```ts
import { ClasslinkRosterAdapter } from "@workspace/sis-adapters";

const adapter = new ClasslinkRosterAdapter({});
await adapter.listStudents(); // reads from these JSON files
```

Or load fixtures directly: `loadOneRosterFixtures()` from `@workspace/sis-adapters`.
