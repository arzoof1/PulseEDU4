# PulseEDU

PulseEDU is a multi-tenant application providing tools for school operations, student support, and insights.

## Run & Operate

- `pnpm run typecheck`: Full typecheck across all packages.
- `pnpm run build`: Typecheck + build all packages.
- `pnpm --filter @workspace/api-spec run codegen`: Regenerate API hooks and Zod schemas from OpenAPI spec.
- `pnpm --filter @workspace/db run push`: Push DB schema changes (dev only).
- `pnpm --filter @workspace/api-server run dev`: Run API server locally.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Where things live

- `lib/db/src/schema/`: Database schemas (source of truth).
- `artifacts/api-server/src/routes/`: API endpoints.
- `artifacts/client/src/`: Frontend application code.
- `artifacts/client/src/index.css`: Global CSS, including UI style conventions.
- `artifacts/api-server/src/lib/scope.ts`: Multi-tenancy and school-scoping helpers.
- `artifacts/api-server/src/seed.ts`: Database seeding logic.
- `artifacts/api-server/src/lib/coreTeam.ts`: Core team role definitions.
- `artifacts/client/src/parent/`: Standalone parent portal application.
- `artifacts/mockup-sandbox/src/`: Mockup components for design review.

## Architecture decisions

- **Multi-Tenancy**: `school_id` is central to data isolation, filtering every read/write. SuperUser role is district-wide, others are school-scoped. `req.schoolId` in middleware ensures correct context.
- **API Versioning/Schema Evolution**: Drizzle-kit is not used for non-interactive schema changes; direct SQL `ALTER TABLE IF NOT EXISTS` is preferred for additive changes to avoid blocking interactive prompts.
- **Object Storage**: Custom object storage routes (`/api/storage/*`) with ACLs enforce school-level tenant isolation for uploaded assets (e.g., store item thumbnails) using `bindObjectToSchool` and `pendingUploads` ledger.
- **Client-Side Routing/Bundling**: The application uses a single Vite client with path-based dispatch (`/signage/*`, `/parent/*`, `/*`) handled in `main.tsx` to serve different user experiences (signage, parent portal, staff app) from a unified bundle.
- **UI Design Philosophy**: Screenshots from other products are treated as conceptual references for "what" to build, not "how" to build it. PulseEDU designs from scratch, focusing on improved functionality and distinct visual identity.

## Product

- **Display Management**: Per-school playlists for digital signage TVs, supporting image, video, audio, and PDF items. Includes scheduling, PBIS house standings, active hall pass displays, and Heartbeat signage.
- **Safety Plans**: Per-student behavioral/physical safety checklists with library items, audit logs, and role-based access (Guidance Counselor/Core Team for editing, all staff for viewing). Integrated into student rosters and profiles.
- **PBIS Hub & Store**: PBIS point tracking, student recognition, and two reward catalogs (Classroom Store, School Store). School Store is school-wide and read-only for teachers, with full edit controls for admins/PBIS coordinators.
- **MTSS Intervention Plans**: Tier 2/3 intervention plan tracking for students, including goal setting, weekly progress monitoring, strategy categories, and completion reports. Features a tier-aware launcher and bell notification system.
- **Parent Portal**: Secure portal for parents to view their student's HeartBEAT data (PBIS, hall passes, tardies, accommodations, staff notes). Features admin-managed invites, sibling switching, configurable section visibility, and PDF export of reports.
- **Insights Dashboards**: Suite of analytics dashboards (Engagement, Behavior, Academics, SEB/SEL, Equity, Early Warning) providing aggregate data, trends, and top-N lists. Features grade/window filters, demographic disaggregation, and drill-down to student profiles.
- **Teacher Roster**: Comprehensive view for teachers of their students, including FAST scores, ESE/504/ELL program flags, and safety plan indicators. Core Team members can view any teacher's roster.
- **Data Importer**: Generic importer for assessments, rosters, and behavior data, supporting CSV uploads with template mapping, preview, commit, and rollback functionality.

## User preferences

_Populate as you build_

## Future work

- **Verify Pullouts visibility for BS/Dean/MTSS/PBIS Coord** — `canVerifyPullouts` in `App.tsx` already includes Behavior Specialist, but the user reports the "Verify Pullouts" notification only appears for Admin. Investigate `pendingPulloutCount` data fetch (around `App.tsx` line 7466 `pendingPulloutsTick` effect) and the server gate in `routes/pullouts.ts` to confirm non-Admin verifiers actually receive a non-zero pending count, plus the Quick Access promotion path at `App.tsx:8227`.
- **Admin Hub A4 surfaces** — Parent portal OSS section and ISS Dashboard polish are both complete. Remaining: Pullouts visibility for non-Admin verifiers (see top of Future work).

## Gotchas

- **Timezone handling**: Be careful with date comparisons and `new Date()` as it can lead to UTC pitfalls. Use local `YYYY-MM-DD` strings for comparisons.
- **Multi-tenancy on unique indexes**: `student_id` and `displayName` are not globally unique. Ensure every query touching tenant-scoped tables includes `eq(table.schoolId, schoolId)`. Unique indexes are typically composite `(school_id, column)`.
- **API route shadowing**: When adding new API routes, especially with dynamic segments, ensure more specific routes are defined before broader ones to prevent shadowing.
- **Cron jobs and environment variables**: Cron jobs are often conditional on `NODE_ENV` and other environment flags. Verify `EMAIL_REMINDERS_ENABLED` and `RESEND_FROM_ADDRESS` for email functionality.
- **Drizzle-kit `db push`**: It can be blocked by interactive prompts on rename detection. For additive schema changes, direct `ALTER TABLE` SQL is often used as a workaround. Ensure `lib/db/src/schema/*.ts` files are updated to reflect the true schema.

## Pointers

- [pnpm-workspace skill](https://replit.com/path/to/pnpm-workspace-skill-docs): For workspace structure, TypeScript setup, and package details.
- [Drizzle ORM documentation](https://orm.drizzle.team/docs/overview): For database schema and query building.
- [Zod documentation](https://zod.dev/): For data validation.
- [Orval documentation](https://orval.dev/): For OpenAPI-based API code generation.
- [Recharts documentation](https://recharts.org/en-US/guide/GettingStarted): For charting components used in dashboards.
- [pdfkit documentation](http://pdfkit.org/docs/getting_started.html): For server-side PDF generation.