---
name: orval *Params name collision
description: Why a new OpenAPI operation can break codegen with TS2308 on a `<OperationId>Params` symbol, and how to dodge it.
---

# orval `<OperationId>Params` collision (TS2308)

**Symptom:** after adding a new OpenAPI operation and running
`pnpm --filter @workspace/api-spec run codegen`, the bundled
`typecheck:libs` fails with
`TS2308: Module "./generated/api" has already exported a member named '<OperationId>Params'`.

**Cause:** the `@workspace/api-zod` barrel re-exports BOTH the zod side
(`generated/api.ts`) and the react-query types side (`generated/types/`).
- The zod generator emits `<OperationId>Params` for an operation's **path**
  params (and `<OperationId>QueryParams` for query params).
- The react-query types generator emits `<OperationId>Params` for an
  operation's **query** params (only when query params exist; a path-only
  operation produces no `types/*Params.ts`).

So an operation that has **both** a path param AND a query param produces two
different `<OperationId>Params` exports that collide in the barrel. Operations
with only-path (e.g. `getPulseBrainLabLesson`) or only-query (e.g.
`listPulseBrainLabLessons`) never collide.

**Why:** the two orval generators name things independently and the api-zod
barrel flattens both with `export *`.

**How to apply / fixes (cheapest first):**
- Convert the query param into a **path segment** so the operation is
  path-only (no `types/*Params.ts` → no collision). Did this for the parent-card
  endpoint: `…/parent-card/{lang}` instead of `…/parent-card?lang=`.
- Or rename to avoid the clash. (Related, separate precedent: request-body
  **input** schemas are suffixed `*Input` in the spec to dodge a different
  collision with the auto-generated `<OperationId>Body` type.)
