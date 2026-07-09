import { useEffect, useState } from "react";
import { authFetch } from "../../lib/authToken";
import { useFeatures } from "../../lib/features";

// Below-the-textarea hint: "We think this also references: X, Y."
// Calls /watchlist/statements/:id/suggest-mentions on a debounce after
// the body changes. Suggestions are advisory — clicking inserts the
// chip token into the body via the supplied onInsert callback.

interface Suggestion {
  studentId: string;
  localSisId?: string | null;
  displayName: string;
  reason: string;
}

interface Props {
  statementId: number | null;
  body: string;
  onInsert: (chip: string) => void;
}

export default function MentionSuggestStrip({
  statementId,
  body,
  onInsert,
}: Props) {
  const features = useFeatures();
  const aiEnabled = features.has("aiAssist");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!aiEnabled || !statementId || body.trim().length < 25) {
      setSuggestions([]);
      return;
    }
    const t = window.setTimeout(async () => {
      try {
        const r = await authFetch(
          `/api/watchlist/statements/${statementId}/suggest-mentions`,
          { method: "POST" },
        );
        if (!r.ok) return;
        const j = (await r.json()) as { suggestions: Suggestion[] };
        setSuggestions(j.suggestions ?? []);
      } catch {
        // silent — feature is purely additive
      }
    }, 1500);
    return () => window.clearTimeout(t);
  }, [aiEnabled, statementId, body]);

  const visible = suggestions.filter((s) => !dismissed.has(s.studentId));
  if (!aiEnabled || !statementId || visible.length === 0) return null;

  return (
    <div
      className="mt-1 flex flex-wrap items-center gap-1 rounded-md border px-2 py-1 text-[11px]"
      style={{
        borderColor: "#5C7CFA",
        background: "rgba(92,124,250,0.08)",
      }}
    >
      <span style={{ color: "#3B5BDB", fontWeight: 600 }}>
        AI sees these names too:
      </span>
      {visible.map((s) => (
        <button
          key={s.studentId}
          type="button"
          title={s.reason || "Click to add as @-mention"}
          onClick={() => {
            onInsert(`@[${s.displayName}|${s.localSisId ?? s.studentId}] `);
            setDismissed((d) => new Set(d).add(s.studentId));
          }}
          style={{
            border: "1px solid #5C7CFA",
            background: "#fff",
            color: "#3B5BDB",
            borderRadius: 999,
            padding: "1px 8px",
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          + {s.displayName}
        </button>
      ))}
      <button
        type="button"
        onClick={() => setDismissed(new Set(visible.map((s) => s.studentId)))}
        style={{
          marginLeft: "auto",
          fontSize: 10,
          color: "#3B5BDB",
          background: "transparent",
          border: "none",
          cursor: "pointer",
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
