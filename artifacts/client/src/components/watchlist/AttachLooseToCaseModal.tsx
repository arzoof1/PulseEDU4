import { useEffect, useMemo, useState } from "react";
import { X, Search } from "lucide-react";
import { authFetch } from "../../lib/authToken";
import { WL_COLORS as C } from "./colors";

interface Props {
  statement: {
    id: number;
    summary: string;
    kind: string;
    occurredAt: string;
  };
  onClose: () => void;
  onAttached: (caseId: number) => void;
}

type CaseRow = {
  id: number;
  caseNumber: number;
  schoolYearLabel: string;
  title: string;
  status: string;
  leadStaffName: string | null;
  openedAt: string;
  counts?: { incidents: number; students: number; lastActivity: string | null };
};

// Pick an existing open case to attach this loose statement onto.
// Counterpart to PromoteToCaseModal — same row, but instead of opening
// a brand-new case file, the statement becomes another entry on a case
// that already exists.
export default function AttachLooseToCaseModal({ statement, onClose, onAttached }: Props) {
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [includeClosed, setIncludeClosed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const r = await authFetch("/api/watchlist/cases");
        if (!alive || !r.ok) return;
        const d = (await r.json()) as { cases: CaseRow[] };
        setCases(d.cases);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return cases
      .filter((c) => includeClosed || c.status === "open")
      .filter((c) => {
        if (!needle) return true;
        return (
          c.title.toLowerCase().includes(needle) ||
          `${c.caseNumber}`.includes(needle) ||
          (c.leadStaffName ?? "").toLowerCase().includes(needle)
        );
      });
  }, [cases, q, includeClosed]);

  const attach = async (caseId: number) => {
    setBusyId(caseId);
    setError(null);
    try {
      const r = await authFetch(`/api/watchlist/interactions/${statement.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId }),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(t || "Failed to attach.");
      }
      onAttached(caseId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to attach.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-auto p-4"
      style={{ background: "rgba(31,27,22,0.55)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl border shadow-xl"
        style={{ background: C.panel, borderColor: C.line }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between border-b px-5 py-3"
          style={{ borderColor: C.line }}
        >
          <div>
            <h2 className="text-lg font-bold">Attach to existing case</h2>
            <div className="text-[11px]" style={{ color: C.inkSoft }}>
              Pick the case this statement belongs to. The statement stays
              the same — only the case link is added.
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 hover:opacity-70"
            style={{ color: C.inkSoft }}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-5">
          {/* Statement preview so the picker has context */}
          <div
            className="rounded-md border px-3 py-2 text-xs"
            style={{ borderColor: C.line, background: C.bg, color: C.ink }}
          >
            <div className="font-semibold uppercase tracking-wide" style={{ color: C.inkSoft, fontSize: 10 }}>
              Statement to attach
            </div>
            <div className="mt-0.5 line-clamp-2">
              <span className="font-semibold">{statement.kind}</span> · {statement.summary || "(no summary)"}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search
                className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
                style={{ color: C.inkSoft }}
              />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search by case #, title, or lead…"
                className="w-full rounded-md border py-1.5 pl-7 pr-2 text-sm"
                style={{ borderColor: C.line, background: C.bg }}
              />
            </div>
            <label className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: C.inkSoft }}>
              <input
                type="checkbox"
                checked={includeClosed}
                onChange={(e) => setIncludeClosed(e.target.checked)}
              />
              Include closed
            </label>
          </div>

          {loading ? (
            <div className="text-sm" style={{ color: C.inkSoft }}>
              Loading cases…
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-md border p-3 text-sm" style={{ borderColor: C.line, color: C.inkSoft }}>
              No matching cases. {includeClosed ? "" : "Try \"Include closed\" or "}use Promote to open a brand-new case for this statement instead.
            </div>
          ) : (
            <div className="max-h-[55vh] space-y-2 overflow-auto">
              {filtered.map((c) => (
                <div
                  key={c.id}
                  className="rounded-md border p-2"
                  style={{ borderColor: C.line, background: C.panel }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        <span
                          className="rounded-full px-1.5 py-0.5 font-bold"
                          style={{
                            background: c.status === "open" ? C.brand : C.bg,
                            color: c.status === "open" ? "#FFFFFF" : C.inkSoft,
                          }}
                        >
                          CASE-{c.schoolYearLabel}-{String(c.caseNumber).padStart(4, "0")}
                        </span>
                        <span style={{ color: C.inkSoft }}>{c.status}</span>
                        {c.leadStaffName ? (
                          <span style={{ color: C.inkSoft }}>· lead: {c.leadStaffName}</span>
                        ) : null}
                        {c.counts ? (
                          <span style={{ color: C.inkSoft }}>
                            · {c.counts.incidents} incidents · {c.counts.students} players
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 truncate text-sm font-semibold" style={{ color: C.ink }}>
                        {c.title}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void attach(c.id)}
                      disabled={busyId !== null}
                      className="shrink-0 rounded-md px-2.5 py-1 text-[11px] font-bold disabled:opacity-50"
                      style={{ background: C.brand, color: "#FFFFFF" }}
                    >
                      {busyId === c.id ? "Attaching…" : "Attach"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {error && (
            <div
              className="rounded-md px-3 py-2 text-sm font-semibold"
              style={{ background: C.alert, color: "#FFFFFF" }}
            >
              {error}
            </div>
          )}
        </div>

        <div
          className="flex items-center justify-end gap-2 border-t px-5 py-3"
          style={{ borderColor: C.line, background: C.bg }}
        >
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-sm font-semibold"
            style={{ borderColor: C.line, color: C.ink }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
