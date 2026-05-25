# PulseEDU Help Articles

This folder is the **knowledge base** for the in-app AI Help Assistant
(floating "?" bubble bottom-right of every page).

The AI is grounded **only in these articles** — it is instructed never
to invent steps. If a user asks something not covered here, the AI says
so rather than making up an answer.

## Conventions

- One `.md` file per feature. Filename = the feature's URL-safe slug
  (e.g. `hall-pass-create.md`).
- Each file starts with YAML frontmatter:
  ```
  ---
  title: How to create a hall pass
  paths: ["/", "/hall-passes"]      # routes where this is "current"
  audience: ["teacher"]              # who the article is written for
  keywords: ["hall pass", "pass", "bathroom", "kiosk"]
  ---
  ```
- Body is plain Markdown. Use the **actual button labels** as they appear
  in the app. Short bullets > paragraphs.
- When you ship a new feature, drop a new `.md` here. No code change needed
  — the assistant picks it up on next server restart.

## Privacy guardrail

Never put student PII, staff PII, or anything tenant-specific in an
article. Articles are sent to the LLM verbatim alongside the user's
question.
