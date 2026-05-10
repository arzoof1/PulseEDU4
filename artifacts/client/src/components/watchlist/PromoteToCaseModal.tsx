import { useState } from "react";
import { X } from "lucide-react";
import { authFetch } from "../../lib/authToken";
import { WL_COLORS as C } from "./colors";

interface Props {
  statement: {
    id: number;
    summary: string;
    kind: string;
    occurredAt: string;
    participants: Array<{ studentId: string; firstName: string; lastName: string }>;
  };
  onClose: () => void;
  onPromoted: (caseId: number) => void;
}

// Promote a single witness statement into a brand-new case. The
// statement becomes the case's *lead statement* (its origin story);
// every later statement attached to the case is read against this one.
// The user can re-title, pick a Core Team lead, and choose whether
// the statement's tagged students should appear as Players on the
// new case (they almost always should — that's why it defaults on).
export default function PromoteToCaseModal({ statement, onClose, onPromoted }: Props) {
  const [title, setTitle] = useState(
    statement.summary.length > 80
      ? statement.summary.slice(0, 80).trimEnd() + "…"
      : statement.summary || `${statement.kind} — ${new Date(statement.occurredAt).toLocaleDateString()}`,
  );
  const [summary, setSummary] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!title.trim()) {
      setError("Give the case a short title.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const r = await authFetch(
        `/api/watchlist/interactions/${statement.id}/promote-to-case`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title.trim(),
            summary: summary.trim(),
          }),
        },
      );
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || "Failed to promote.");
      }
      const d = (await r.json()) as { case: { id: number } };
      onPromoted(d.case.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to promote.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border shadow-xl"
        style={{ borderColor: C.line, background: C.panel }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between border-b px-5 py-3"
          style={{ borderColor: C.line }}
        >
          <h2 className="text-base font-bold tracking-tight">
            Promote to case
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1"
            style={{ color: C.inkSoft }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 p-5">
          <div
            className="rounded-md border p-3 text-xs"
            style={{ borderColor: C.line, background: C.bg, color: C.inkSoft }}
          >
            <div className="font-semibold uppercase tracking-wider" style={{ color: C.ink }}>
              Lead statement #{statement.id}
            </div>
            <div className="mt-1 line-clamp-3" style={{ color: C.ink }}>
              {statement.summary || <em>(no summary)</em>}
            </div>
            {statement.participants.length > 0 ? (
              <div className="mt-1.5">
                Tagged: {statement.participants
                  .map((p) => `${p.firstName} ${p.lastName}`)
                  .join(", ")}
              </div>
            ) : null}
          </div>

          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: C.inkSoft }}>
              Case title
            </span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              className="mt-1 w-full rounded-md border px-2.5 py-1.5 text-sm"
              style={{ borderColor: C.line, background: "#fff", color: C.ink }}
            />
          </label>

          <label className="block">
            <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: C.inkSoft }}>
              Working summary <span className="font-normal">(optional)</span>
            </span>
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              maxLength={2000}
              rows={3}
              placeholder="What's the through-line you're investigating?"
              className="mt-1 w-full rounded-md border px-2.5 py-1.5 text-sm"
              style={{ borderColor: C.line, background: "#fff", color: C.ink }}
            />
          </label>

          {statement.participants.length > 0 ? (
            <div
              className="rounded-md border px-3 py-2 text-[11px]"
              style={{ borderColor: C.line, background: C.bg, color: C.inkSoft }}
            >
              The {statement.participants.length} student
              {statement.participants.length === 1 ? "" : "s"} tagged on this
              statement will appear on the case as Players. You can adjust
              roles or add more from the case detail page.
            </div>
          ) : null}

          {error ? (
            <div
              className="rounded-md border px-3 py-2 text-xs"
              style={{ borderColor: C.alert, background: C.alertSoft, color: C.alert }}
            >
              {error}
            </div>
          ) : null}
        </div>
        <div
          className="flex items-center justify-end gap-2 border-t px-5 py-3"
          style={{ borderColor: C.line }}
        >
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-sm font-semibold"
            style={{ borderColor: C.line, color: C.ink, background: C.panel }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting}
            className="rounded-md px-3 py-1.5 text-sm font-bold"
            style={{ background: C.brand, color: "#FFFFFF", opacity: submitting ? 0.6 : 1 }}
          >
            {submitting ? "Creating…" : "Create case"}
          </button>
        </div>
      </div>
    </div>
  );
}
