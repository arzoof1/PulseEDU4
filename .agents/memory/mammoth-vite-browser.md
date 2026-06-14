---
name: mammoth in Vite (client-side docx parsing)
description: How to import the mammoth library in a Vite browser bundle for .docx → text without type/runtime breakage.
---

# mammoth in a Vite client bundle

To extract text from an uploaded `.docx` in the browser, import the **main**
entry and call `extractRawText`:

```ts
import mammoth from "mammoth";
const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
const text = result.value;
```

**Why:** mammoth ships a CJS main (`lib/index.js`, `export = mammoth`) WITH
types (`lib/index.d.ts`), plus a `"browser"` field in its package.json that
remaps only the node-specific internals (`lib/unzip.js`,
`lib/docx/files.js`) to browser equivalents. Vite honors that `"browser"`
field automatically, so the main import resolves to a browser-safe build at
bundle time **and** keeps full TypeScript types.

**How to apply:** Do NOT import a separate `mammoth/mammoth.browser` subpath —
it has no type declarations and isn't needed. Default import works because the
client tsconfig has esModuleInterop. Install into the client as a
devDependency (static/client artifact convention):
`pnpm --filter @workspace/client add -D mammoth`.
