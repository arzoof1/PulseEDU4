---
name: docx Word generation (scripts)
description: Gotchas when generating .docx files with the `docx` npm lib in @workspace/scripts
---

# Generating Word (.docx) docs with the `docx` npm lib

The repo has no pandoc / python-docx. To produce Word files, use the `docx`
npm package (devDependency in `@workspace/scripts`). Pattern lives in
`scripts/src/generateUserGuideDocx.ts` (run: `pnpm --filter @workspace/scripts
run user-guide-docx`). Note `scripts/src/generateUserGuide.ts` is a *separate,
older* pdfkit PDF generator — different output, don't confuse them.

## Restarting numbered lists per section
A single `numbering` reference shared across many paragraphs renders as ONE
continuous numbered list (1,2,3,4...) across the whole document. To restart at
1 for each logical group, pass a distinct `instance` integer per group:
`numbering: { reference: "how-steps", level: 0, instance: N }`. Each unique
`instance` is a separate concrete list that restarts.
**Why:** an early version had every feature's "How to use it" steps continue
the previous feature's count. **How to apply:** increment an instance counter
once per group (feature) and pass it down.

## TableOfContents typing
`TableOfContents` is a valid section child but is NOT a `Paragraph`. Type the
children arrays as `FileChild[]` (imported from `docx`) instead of casting with
`as unknown as Paragraph`.

## Validation
`file <name>.docx` should report "Microsoft Word 2007+". `unzip` is not
installed in this environment, so don't rely on it to inspect the archive.
Set `features: { updateFields: true }` so Word offers to refresh the TOC.
