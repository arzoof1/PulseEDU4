---
name: Generic JSX type args break Replit Babel metadata plugin
description: Why <Comp<T> ...> renders a blank page in the Vite dev runtime even though tsc passes
---

Writing an explicit generic type argument on a JSX element — `<StudentPicker<Student> ...props>` — type-checks fine under `tsc` but **breaks the Replit Vite dev runtime**. The dev-only Babel "metadata" plugin (it injects `data-replit-metadata` / `data-component-name` attributes) cannot parse the `<Tag<T>` form: Babel throws `Unexpected token (line:col)` as a Vite "Pre-transform error" / "Internal server error", and the app serves a **blank page**.

**Why this is a trap:** `pnpm typecheck` is green (tsc accepts the syntax), so the bug is invisible to typechecking. It only shows up at runtime in the dev preview, and the symptom (blank screen) looks like an auth/logged-out state or a re-seed hiccup, not a syntax error. You must read the client vite workflow log for the `Pre-transform error ... Unexpected token` line to see it.

**Fix / rule:** never put an explicit generic type argument on a JSX tag. Drop the `<T>` and let inference pin the generic via a prop (e.g. `items={...}` for local mode or `fetcher={...}` for async mode). Inference unified `T` across all StudentPicker call sites with zero typecheck changes.

**How to apply:** when authoring a generic React component, infer `T` from props; if you ever see a blank dev page that typechecks clean, grep the changed TSX for `<Component<` and strip the type arg.
