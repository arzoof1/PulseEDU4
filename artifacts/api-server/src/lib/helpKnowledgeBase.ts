import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface HelpArticle {
  slug: string;
  title: string;
  paths: string[];
  audience: string[];
  keywords: string[];
  body: string;
}

function parseFrontmatter(raw: string): {
  data: Record<string, unknown>;
  body: string;
} {
  if (!raw.startsWith("---")) return { data: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { data: {}, body: raw };
  const block = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\n+/, "");
  const data: Record<string, unknown> = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([a-zA-Z_]+):\s*(.+)$/);
    if (!m) continue;
    const [, key, valueRaw] = m;
    const v = valueRaw.trim();
    if (v.startsWith("[") && v.endsWith("]")) {
      data[key] = v
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      data[key] = v.replace(/^["']|["']$/g, "");
    }
  }
  return { data, body };
}

function findHelpDir(): string | null {
  // Walk up from cwd looking for `docs/help`. Works whether the
  // server runs from artifacts/api-server, project root, or dist.
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "docs", "help");
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // ignore
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let cached: HelpArticle[] | null = null;

export function loadHelpArticles(): HelpArticle[] {
  if (cached) return cached;
  const dir = findHelpDir();
  if (!dir) {
    cached = [];
    return cached;
  }
  const out: HelpArticle[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md") || file === "README.md") continue;
    const raw = readFileSync(join(dir, file), "utf8");
    const { data, body } = parseFrontmatter(raw);
    const slug = file.replace(/\.md$/, "");
    out.push({
      slug,
      title: typeof data.title === "string" ? data.title : slug,
      paths: Array.isArray(data.paths) ? (data.paths as string[]) : [],
      audience: Array.isArray(data.audience)
        ? (data.audience as string[])
        : [],
      keywords: Array.isArray(data.keywords)
        ? (data.keywords as string[])
        : [],
      body: body.trim(),
    });
  }
  cached = out;
  return cached;
}

export function resetHelpCache(): void {
  cached = null;
}

/**
 * Score each article against the current page + recent user message.
 * Cheap heuristic — works fine for ~50 articles. If we grow past
 * a couple hundred, swap in embeddings.
 */
export function rankArticles(
  articles: HelpArticle[],
  currentPath: string | null,
  userText: string,
): HelpArticle[] {
  const text = userText.toLowerCase();
  const path = (currentPath ?? "").toLowerCase();
  const scored = articles.map((a) => {
    let score = 0;
    for (const p of a.paths) {
      const lp = p.toLowerCase();
      if (path === lp) score += 5;
      // Require a `/` boundary so `/roster` doesn't match `/rosterXYZ`.
      else if (lp !== "/" && (path === lp || path.startsWith(lp + "/"))) {
        score += 3;
      }
    }
    for (const k of a.keywords) {
      if (text.includes(k.toLowerCase())) score += 2;
    }
    if (text.includes(a.title.toLowerCase())) score += 4;
    return { a, score };
  });
  scored.sort((x, y) => y.score - x.score);
  return scored.map((s) => s.a);
}
