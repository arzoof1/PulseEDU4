// AI Help Assistant — floating "?" sidebar.
//
// Grounded in `docs/help/*.md` so the model can only describe
// features that are actually documented. The system prompt is strict
// about not inventing steps; if the docs don't cover something, the
// model is instructed to say so and offer to flag it.
//
// No conversation persistence — the client owns the message history
// and posts the rolling thread on each turn. Help conversations are
// short and ephemeral; persisting would add scope without value.
//
// Privacy: we never include student / staff PII in the prompt. Only
// (a) the current page path, (b) the user's typed messages,
// (c) the curated help articles.

import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  loadHelpArticles,
  rankArticles,
  type HelpArticle,
} from "../lib/helpKnowledgeBase";

const router: IRouter = Router();

// All help-assistant routes require a signed-in staff session — the
// chat endpoint hits a paid LLM, so we cannot expose it anonymously.
function requireStaff(req: Request, res: Response, next: NextFunction): void {
  if (!req.staffId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  next();
}

// Cheap in-memory rate limiter — per-staff sliding window. Help chats
// are interactive, so the budget is generous; the limiter exists to
// stop runaway clients or scripted abuse, not to ration normal use.
const CHAT_WINDOW_MS = 60_000;
const CHAT_MAX_PER_WINDOW = 12;
const chatHits = new Map<number, number[]>();

function rateLimitChat(req: Request, res: Response, next: NextFunction): void {
  const sid = req.staffId;
  if (!sid) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const now = Date.now();
  const cutoff = now - CHAT_WINDOW_MS;
  const recent = (chatHits.get(sid) ?? []).filter((t) => t > cutoff);
  if (recent.length >= CHAT_MAX_PER_WINDOW) {
    res.status(429).json({
      error: "rate_limited",
      retryAfterSeconds: Math.ceil(
        (recent[0] + CHAT_WINDOW_MS - now) / 1000,
      ),
    });
    return;
  }
  recent.push(now);
  chatHits.set(sid, recent);
  next();
}

router.use("/help-assistant", requireStaff);

const ChatMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(4000),
});

const ChatBody = z.object({
  messages: z.array(ChatMessage).min(1).max(20),
  currentPath: z.string().max(500).nullable().optional(),
});

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1024; // help answers are short by design
const TOP_K_ARTICLES = 5;

function buildSystemPrompt(articles: HelpArticle[], currentPath: string | null): string {
  const knowledge = articles
    .map(
      (a) =>
        `## Article: ${a.title}\n(slug: ${a.slug}, relevant pages: ${a.paths.join(", ") || "any"})\n\n${a.body}`,
    )
    .join("\n\n---\n\n");

  return `You are the PulseEDU in-app help assistant. PulseEDU is a multi-tenant school operations app used by teachers, admins, and front-office staff.

Your job: give friendly, step-by-step walkthroughs of PulseEDU features in plain English. Your users are not technical — speak warmly, avoid jargon, use short sentences.

## RULES (these are absolute)

1. **Only answer from the help articles below.** If the user asks about something not covered, say so honestly: "I don't have a walkthrough for that yet — want me to flag it for your admin?" Do not guess. Do not invent button names, menu paths, or features.
2. **Use the exact button labels and page names from the articles.** Wrap UI element names in **bold**. Never claim a button or action lives on a page unless an article explicitly puts it there — if the article says "open X in the sidebar, then click Y", always tell the user to open X first; don't imply Y is reachable from wherever they are now.
3. **Format as numbered steps** when describing how to do something. Keep each step to one short sentence.
4. **Never request or reference student data, staff names, or any PII.** You don't have access to the user's school data.
5. **Be concise.** Aim for 4–8 short steps unless the user explicitly asks for more detail. No long preambles.
6. **Do not announce the user's current page or assume where they are.** The app's internal navigation isn't tied to URLs, so any path you might see is unreliable. Just answer the question directly with the steps to get there from the sidebar.

## HELP ARTICLES (your only source of truth)

${knowledge || "(no articles available — tell the user the help library is empty)"}

## RESPONSE FORMAT

Respond in plain Markdown. Use **bold** for UI labels, numbered lists for steps, and short headings only when truly needed. End with a single one-line offer to help further (e.g. "Want me to walk you through anything else?").`;
}

router.post("/help-assistant/chat", rateLimitChat, async (req, res) => {
  const parsed = ChatBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", detail: parsed.error.message });
    return;
  }
  const { messages, currentPath } = parsed.data;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    res.status(400).json({ error: "no_user_message" });
    return;
  }

  const all = loadHelpArticles();
  const ranked = rankArticles(all, currentPath ?? null, lastUser.content);
  const top = ranked.slice(0, TOP_K_ARTICLES);
  const system = buildSystemPrompt(top, currentPath ?? null);

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });
    const text = response.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    res.json({
      content: text,
      sources: top.map((a) => ({ slug: a.slug, title: a.title })),
    });
  } catch (err) {
    req.log?.error({ err }, "help-assistant chat failed");
    res.status(502).json({ error: "ai_request_failed" });
  }
});

router.get("/help-assistant/articles", (_req, res) => {
  const all = loadHelpArticles();
  res.json(
    all.map((a) => ({
      slug: a.slug,
      title: a.title,
      paths: a.paths,
      audience: a.audience,
      keywords: a.keywords,
    })),
  );
});

router.get("/help-assistant/suggestions", (req, res) => {
  const path = typeof req.query.path === "string" ? req.query.path : "";
  const all = loadHelpArticles();
  const ranked = rankArticles(all, path, "");
  const top = ranked.slice(0, 4);
  res.json({
    suggestions: top.map((a) => ({ slug: a.slug, title: a.title })),
  });
});

export default router;
