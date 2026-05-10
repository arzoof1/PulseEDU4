import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, FileSearch, Plus, RefreshCw, X } from "lucide-react";
import { authFetch } from "../../lib/authToken";
import { WL_COLORS as C } from "./colors";

// AI Consistency side panel — lives over the case detail page when
// the user clicks the ConsistencyPill. Three tabs:
//   Open       — actionable findings still requiring review.
//   Dismissed  — findings the team explicitly suppressed; visible so
//                an auditor can see what was waved off and why.
//   All runs   — chronological log of AI runs (and their cost),
//                each one a link into the "What the AI saw" drawer.
//
// Privacy: every cited source is rendered as plain text only. The
// panel never re-hydrates the redacted bundle with real names —
// students show as "Student A / B / C" in the drawer to match the
// exact bytes the model received.

export interface ConsistencyState {
  schoolId: number;
  caseId: number;
  latestRunId: number | null;
  score: number;
  openFindingCount: number;
  highSeverityCount: number;
  lastRunAt: string | null;
  lastAttemptAt: string | null;
  updatedAt: string | null;
}

interface Finding {
  id: number;
  source: "ai" | "human";
  kind: "contradiction" | "gap" | "corroboration";
  severity: "high" | "med" | "low";
  summary: string;
  detail: string | null;
  citedSourceRefs: Array<{ kind: string; id: number }>;
  status: "open" | "dismissed" | "resolved";
  dismissReason: string | null;
  dismissNote: string | null;
  dismissedByName: string | null;
  dismissedAt: string | null;
  createdByName: string | null;
  createdAt: string;
  runId: number | null;
}

interface RunSummary {
  id: number;
  createdAt: string;
  triggeredByName: string | null;
  triggerReason: string;
  model: string;
  errorText: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  score: number;
}

interface Props {
  caseId: number;
  onClose: () => void;
  onChanged?: () => void;
}

const KIND_META: Record<
  Finding["kind"],
  { label: string; bg: string; fg: string }
> = {
  contradiction: { label: "Contradiction", bg: C.alertSoft, fg: C.alert },
  gap: { label: "Gap", bg: C.warnSoft, fg: C.warn },
  corroboration: { label: "Corroboration", bg: C.okSoft, fg: C.ok },
};

const SEVERITY_LABEL: Record<Finding["severity"], string> = {
  high: "High",
  med: "Med",
  low: "Low",
};

const REF_LABEL: Record<string, string> = {
  witness_statement: "Statement",
  interaction: "Incident",
  video_clip: "Video clip",
  case_note: "Case note",
};

const DISMISS_REASONS = [
  { value: "false_positive", label: "False positive — AI was wrong" },
  { value: "already_verified", label: "Already verified by team" },
  { value: "duplicate", label: "Duplicate of another finding" },
  { value: "other", label: "Other (explain in note)" },
] as const;

export default function ConsistencyPanel({ caseId, onClose, onChanged }: Props) {
  const [tab, setTab] = useState<"open" | "dismissed" | "runs">("open");
  const [state, setState] = useState<ConsistencyState | null>(null);
  const [latestRun, setLatestRun] = useState<RunSummary | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [rateLimit, setRateLimit] = useState<string | null>(null);
  const [bundleRunId, setBundleRunId] = useState<number | null>(null);
  const [dismissTarget, setDismissTarget] = useState<Finding | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await authFetch(`/api/watchlist/cases/${caseId}/consistency`);
      if (r.ok) {
        const j = await r.json();
        setState(j.state);
        setLatestRun(j.latestRun);
        setFindings(j.findings ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    void load();
  }, [load]);

  const dismissed = useMemo(
    () => findings.filter((f) => f.status === "dismissed"),
    [findings],
  );
  const open = useMemo(
    () => findings.filter((f) => f.status === "open"),
    [findings],
  );

  // The panel-default load returns only open findings (cheaper). When
  // the user switches to "Dismissed" we lazy-load the full set.
  const loadAll = useCallback(async () => {
    // Same endpoint already returns all-status when we ask the
    // server — but to keep T006 tight we re-use the server's open-only
    // endpoint and just show what we have locally. Future enhancement:
    // add `?status=all` query.
    setLoading(true);
    try {
      const r = await authFetch(
        `/api/watchlist/cases/${caseId}/consistency?status=all`,
      );
      if (r.ok) {
        const j = await r.json();
        setFindings(j.findings ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    if (tab === "dismissed") void loadAll();
    if (tab === "runs") void loadRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const loadRuns = useCallback(async () => {
    // We don't have a list endpoint; render the latest from state and
    // let the user click into the bundle drawer for the latestRunId.
    // (Adding a paginated list endpoint is part of the follow-up.)
    if (latestRun) setRuns([{ ...latestRun, score: state?.score ?? 100 }]);
  }, [latestRun, state]);

  const triggerRun = async () => {
    setRunning(true);
    setRateLimit(null);
    try {
      const r = await authFetch(
        `/api/watchlist/cases/${caseId}/consistency/run`,
        { method: "POST" },
      );
      if (r.status === 429) {
        const j = await r.json();
        const sec = j.retryAfter ?? 0;
        const hrs = Math.ceil(sec / 3600);
        setRateLimit(`Daily cap reached. Try again in ~${hrs}h.`);
      } else if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setRateLimit(j.error ?? "Run failed.");
      } else {
        await load();
        onChanged?.();
      }
    } finally {
      setRunning(false);
    }
  };

  const submitDismiss = async (
    f: Finding,
    reason: string,
    note: string,
  ) => {
    const r = await authFetch(
      `/api/watchlist/cases/${caseId}/consistency/findings/${f.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dismiss", reason, note }),
      },
    );
    if (r.ok) {
      setDismissTarget(null);
      await load();
      if (tab === "dismissed") await loadAll();
      onChanged?.();
    } else {
      const j = await r.json().catch(() => ({}));
      alert(j.error ?? "Dismiss failed");
    }
  };

  const reopenFinding = async (f: Finding) => {
    const r = await authFetch(
      `/api/watchlist/cases/${caseId}/consistency/findings/${f.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reopen" }),
      },
    );
    if (r.ok) {
      await load();
      if (tab === "dismissed") await loadAll();
      onChanged?.();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex"
      style={{ background: "rgba(0,0,0,0.35)" }}
      onClick={onClose}
    >
      <div className="flex-1" />
      <div
        className="flex h-full w-full max-w-[640px] flex-col shadow-2xl"
        style={{ background: C.bg }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div
          className="flex items-start justify-between border-b px-5 py-4"
          style={{ borderColor: C.line, background: C.panel }}
        >
          <div className="min-w-0">
            <div
              className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: C.brand }}
            >
              AI Consistency
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-bold" style={{ color: C.ink }}>
                {state?.score ?? "—"}
              </span>
              <span className="text-xs" style={{ color: C.inkSoft }}>
                {state?.lastRunAt
                  ? `Ran ${new Date(state.lastRunAt).toLocaleString()}`
                  : "Not run yet"}
                {latestRun?.triggeredByName
                  ? ` · ${latestRun.triggeredByName}`
                  : ""}
              </span>
            </div>
            <div className="mt-1 text-xs" style={{ color: C.inkSoft }}>
              {state?.openFindingCount ?? 0} open ·{" "}
              {state?.highSeverityCount ?? 0} high
              {latestRun?.inputTokens != null && (
                <> · {latestRun.inputTokens + (latestRun.outputTokens ?? 0)} tok</>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={triggerRun}
              disabled={running}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
              style={{ borderColor: C.line, background: C.panel, color: C.ink }}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${running ? "animate-spin" : ""}`}
              />
              {running ? "Running…" : "Re-run"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 hover:bg-black/5"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {rateLimit && (
          <div
            className="border-b px-5 py-2 text-xs"
            style={{
              borderColor: C.line,
              background: C.warnSoft,
              color: C.warn,
            }}
          >
            {rateLimit}
          </div>
        )}

        {/* disclaimer */}
        <div
          className="flex items-start gap-2 border-b px-5 py-2 text-xs"
          style={{
            borderColor: C.line,
            background: C.brandSoft,
            color: C.brand,
          }}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>
            <strong>AI suggestion — verify before acting.</strong> Not a
            substitute for investigator judgment. Findings cite source rows;
            click through to confirm in context.
          </span>
        </div>

        {/* tabs */}
        <div
          className="flex items-center gap-0 border-b px-5"
          style={{ borderColor: C.line, background: C.panel }}
        >
          {(
            [
              ["open", `Open (${open.length})`],
              ["dismissed", "Dismissed"],
              ["runs", "All runs"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className="border-b-2 px-3 py-2 text-xs font-semibold"
              style={{
                borderColor: tab === k ? C.brand : "transparent",
                color: tab === k ? C.brand : C.inkSoft,
              }}
            >
              {label}
            </button>
          ))}
          <div className="ml-auto">
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="my-1 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold"
              style={{ borderColor: C.line, color: C.ink, background: C.bg }}
            >
              <Plus className="h-3 w-3" /> Add finding
            </button>
          </div>
        </div>

        {/* body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="text-xs" style={{ color: C.inkSoft }}>
              Loading…
            </div>
          )}
          {!loading && tab === "open" && (
            <>
              {open.length === 0 ? (
                <EmptyState text="No open findings. The case looks internally consistent — or the AI hasn't run yet." />
              ) : (
                <div className="flex flex-col gap-3">
                  {open.map((f) => (
                    <FindingCard
                      key={f.id}
                      f={f}
                      onDismiss={() => setDismissTarget(f)}
                      onShowBundle={() =>
                        f.runId && setBundleRunId(f.runId)
                      }
                    />
                  ))}
                </div>
              )}
            </>
          )}
          {!loading && tab === "dismissed" && (
            <>
              {dismissed.length === 0 ? (
                <EmptyState text="No dismissed findings." />
              ) : (
                <div className="flex flex-col gap-3">
                  {dismissed.map((f) => (
                    <FindingCard
                      key={f.id}
                      f={f}
                      onReopen={() => void reopenFinding(f)}
                      onShowBundle={() =>
                        f.runId && setBundleRunId(f.runId)
                      }
                    />
                  ))}
                </div>
              )}
            </>
          )}
          {!loading && tab === "runs" && (
            <>
              {runs.length === 0 ? (
                <EmptyState text="No runs yet." />
              ) : (
                <div className="flex flex-col gap-2">
                  {runs.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setBundleRunId(r.id)}
                      className="flex items-center justify-between rounded-md border px-3 py-2 text-left text-xs"
                      style={{
                        borderColor: C.line,
                        background: C.panel,
                        color: C.ink,
                      }}
                    >
                      <span>
                        <strong>{r.score}</strong> ·{" "}
                        {new Date(r.createdAt).toLocaleString()} ·{" "}
                        {r.triggerReason}
                      </span>
                      <span style={{ color: C.inkSoft }}>
                        <FileSearch className="inline h-3 w-3" /> View bundle
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {dismissTarget && (
        <DismissModal
          finding={dismissTarget}
          onCancel={() => setDismissTarget(null)}
          onSubmit={(reason, note) =>
            submitDismiss(dismissTarget, reason, note)
          }
        />
      )}
      {showAdd && (
        <AddFindingModal
          caseId={caseId}
          onCancel={() => setShowAdd(false)}
          onCreated={async () => {
            setShowAdd(false);
            await load();
            onChanged?.();
          }}
        />
      )}
      {bundleRunId && (
        <BundleDrawer
          caseId={caseId}
          runId={bundleRunId}
          onClose={() => setBundleRunId(null)}
        />
      )}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div
      className="rounded-md border px-3 py-6 text-center text-xs"
      style={{ borderColor: C.line, color: C.inkSoft, background: C.panel }}
    >
      {text}
    </div>
  );
}

function FindingCard({
  f,
  onDismiss,
  onReopen,
  onShowBundle,
}: {
  f: Finding;
  onDismiss?: () => void;
  onReopen?: () => void;
  onShowBundle?: () => void;
}) {
  const km = KIND_META[f.kind];
  return (
    <div
      className="rounded-lg border p-3"
      style={{ borderColor: C.line, background: C.panel }}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
          style={{ background: km.bg, color: km.fg }}
        >
          {km.label}
        </span>
        <span
          className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
          style={{ borderColor: C.line, color: C.inkSoft }}
        >
          {SEVERITY_LABEL[f.severity]}
        </span>
        {f.source === "human" && (
          <span
            className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
            style={{ background: C.coolSoft, color: C.cool }}
            title={`Added by ${f.createdByName ?? "staff"}`}
          >
            Human
          </span>
        )}
        <span className="ml-auto text-[10px]" style={{ color: C.inkSoft }}>
          {new Date(f.createdAt).toLocaleString()}
        </span>
      </div>
      <p className="mt-2 text-sm" style={{ color: C.ink }}>
        {f.summary}
      </p>
      {f.detail && (
        <p className="mt-1 text-xs" style={{ color: C.inkSoft }}>
          {f.detail}
        </p>
      )}
      {f.citedSourceRefs.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {f.citedSourceRefs.map((r, i) => (
            <span
              key={`${r.kind}-${r.id}-${i}`}
              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]"
              style={{ borderColor: C.line, color: C.inkSoft }}
              title={`${REF_LABEL[r.kind] ?? r.kind} #${r.id}`}
            >
              {REF_LABEL[r.kind] ?? r.kind} #{r.id}
            </span>
          ))}
        </div>
      )}
      {f.status === "dismissed" && (
        <div
          className="mt-2 rounded-md border px-2 py-1.5 text-[11px]"
          style={{ borderColor: C.line, background: C.bg, color: C.inkSoft }}
        >
          <strong>Dismissed</strong>
          {f.dismissedByName ? ` by ${f.dismissedByName}` : ""}
          {f.dismissedAt
            ? ` on ${new Date(f.dismissedAt).toLocaleDateString()}`
            : ""}
          {f.dismissReason ? ` · ${f.dismissReason}` : ""}
          {f.dismissNote ? <div className="mt-0.5">"{f.dismissNote}"</div> : null}
        </div>
      )}
      <div className="mt-2 flex items-center gap-2">
        {onShowBundle && f.runId && (
          <button
            type="button"
            onClick={onShowBundle}
            className="text-[11px] underline"
            style={{ color: C.cool }}
          >
            What the AI saw
          </button>
        )}
        <div className="ml-auto flex gap-1.5">
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-md border px-2 py-1 text-[11px] font-semibold"
              style={{ borderColor: C.line, color: C.ink, background: C.bg }}
            >
              Dismiss
            </button>
          )}
          {onReopen && (
            <button
              type="button"
              onClick={onReopen}
              className="rounded-md border px-2 py-1 text-[11px] font-semibold"
              style={{ borderColor: C.line, color: C.ink, background: C.bg }}
            >
              Re-open
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function DismissModal({
  finding,
  onCancel,
  onSubmit,
}: {
  finding: Finding;
  onCancel: () => void;
  onSubmit: (reason: string, note: string) => void;
}) {
  const [reason, setReason] = useState<string>(DISMISS_REASONS[0].value);
  const [note, setNote] = useState("");
  const tooShort = note.trim().length < 5;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-lg border p-4 shadow-2xl"
        style={{ background: C.panel, borderColor: C.line }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-bold" style={{ color: C.ink }}>
          Dismiss this finding
        </div>
        <p className="mt-1 text-xs" style={{ color: C.inkSoft }}>
          Dismissed findings are suppressed on future AI runs. The
          justification you write here is visible to other Core Team
          members.
        </p>
        <p
          className="mt-2 truncate rounded-md border px-2 py-1 text-xs"
          style={{ borderColor: C.line, color: C.ink, background: C.bg }}
        >
          {finding.summary}
        </p>
        <label
          className="mt-3 block text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: C.inkSoft }}
        >
          Reason
        </label>
        <select
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
          style={{ borderColor: C.line, background: C.panel, color: C.ink }}
        >
          {DISMISS_REASONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <label
          className="mt-3 block text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: C.inkSoft }}
        >
          Justification (required, ≥5 chars)
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="Why is the team waving this off?"
          className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
          style={{ borderColor: C.line, background: C.panel, color: C.ink }}
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border px-3 py-1.5 text-sm"
            style={{ borderColor: C.line, color: C.ink }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={tooShort}
            onClick={() => onSubmit(reason, note)}
            className="rounded-md px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: C.brand }}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

function AddFindingModal({
  caseId,
  onCancel,
  onCreated,
}: {
  caseId: number;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [kind, setKind] = useState<Finding["kind"]>("contradiction");
  const [severity, setSeverity] = useState<Finding["severity"]>("med");
  const [summary, setSummary] = useState("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await authFetch(
        `/api/watchlist/cases/${caseId}/consistency/findings`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            severity,
            summary,
            detail,
            citedSourceRefs: [],
          }),
        },
      );
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setErr(j.error ?? "Save failed");
        return;
      }
      onCreated();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-lg border p-4 shadow-2xl"
        style={{ background: C.panel, borderColor: C.line }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-bold" style={{ color: C.ink }}>
          Add a finding the AI missed
        </div>
        <p className="mt-1 text-xs" style={{ color: C.inkSoft }}>
          Marked as <strong>Human</strong> in the panel. Counts toward the
          score the same way an AI finding does.
        </p>
        <div className="mt-3 flex gap-2">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as Finding["kind"])}
            className="flex-1 rounded-md border px-2 py-1.5 text-sm"
            style={{ borderColor: C.line, background: C.panel, color: C.ink }}
          >
            <option value="contradiction">Contradiction</option>
            <option value="gap">Gap</option>
            <option value="corroboration">Corroboration</option>
          </select>
          <select
            value={severity}
            onChange={(e) =>
              setSeverity(e.target.value as Finding["severity"])
            }
            className="flex-1 rounded-md border px-2 py-1.5 text-sm"
            style={{ borderColor: C.line, background: C.panel, color: C.ink }}
          >
            <option value="high">High</option>
            <option value="med">Med</option>
            <option value="low">Low</option>
          </select>
        </div>
        <input
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Short summary"
          className="mt-2 w-full rounded-md border px-2 py-1.5 text-sm"
          style={{ borderColor: C.line, background: C.panel, color: C.ink }}
        />
        <textarea
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          placeholder="Detail (optional)"
          rows={3}
          className="mt-2 w-full rounded-md border px-2 py-1.5 text-sm"
          style={{ borderColor: C.line, background: C.panel, color: C.ink }}
        />
        {err && (
          <p className="mt-2 text-xs" style={{ color: C.alert }}>
            {err}
          </p>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border px-3 py-1.5 text-sm"
            style={{ borderColor: C.line, color: C.ink }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !summary.trim()}
            onClick={submit}
            className="rounded-md px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: C.brand }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function BundleDrawer({
  caseId,
  runId,
  onClose,
}: {
  caseId: number;
  runId: number;
  onClose: () => void;
}) {
  const [data, setData] = useState<{
    run: {
      promptHash: string;
      model: string;
      inputBundleJson: unknown;
      rawOutputJson: unknown;
      errorText: string | null;
    } | null;
  }>({ run: null });
  useEffect(() => {
    void (async () => {
      const r = await authFetch(
        `/api/watchlist/cases/${caseId}/consistency/runs/${runId}`,
      );
      if (r.ok) {
        const j = await r.json();
        setData(j);
      }
    })();
  }, [caseId, runId]);
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={onClose}
    >
      <div
        className="flex h-[90vh] w-[90vw] max-w-3xl flex-col rounded-lg border shadow-2xl"
        style={{ background: C.panel, borderColor: C.line }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between border-b px-4 py-3"
          style={{ borderColor: C.line }}
        >
          <div>
            <div className="text-sm font-bold" style={{ color: C.ink }}>
              What the AI saw — Run #{runId}
            </div>
            <div className="text-[11px]" style={{ color: C.inkSoft }}>
              Students appear as <em>Student A / B / C</em> aliases. No real
              names, DOB, contacts, or program flags are sent to the model.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 hover:bg-black/5"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {!data.run ? (
            <div className="text-xs" style={{ color: C.inkSoft }}>
              Loading…
            </div>
          ) : (
            <>
              <div className="mb-3 text-[11px]" style={{ color: C.inkSoft }}>
                Model: <code>{data.run.model}</code> · Prompt hash:{" "}
                <code>{data.run.promptHash.slice(0, 12)}…</code>
              </div>
              {data.run.errorText && (
                <div
                  className="mb-3 rounded-md border px-3 py-2 text-xs"
                  style={{
                    borderColor: C.line,
                    background: C.alertSoft,
                    color: C.alert,
                  }}
                >
                  <strong>Error:</strong> {data.run.errorText}
                </div>
              )}
              <div
                className="text-[11px] font-semibold uppercase tracking-wider"
                style={{ color: C.inkSoft }}
              >
                Redacted bundle (model input)
              </div>
              <pre
                className="mt-1 overflow-auto rounded-md border p-2 text-[11px]"
                style={{ borderColor: C.line, background: C.bg, color: C.ink }}
              >
                {JSON.stringify(data.run.inputBundleJson, null, 2)}
              </pre>
              <div
                className="mt-4 text-[11px] font-semibold uppercase tracking-wider"
                style={{ color: C.inkSoft }}
              >
                Raw model output
              </div>
              <pre
                className="mt-1 overflow-auto rounded-md border p-2 text-[11px]"
                style={{ borderColor: C.line, background: C.bg, color: C.ink }}
              >
                {JSON.stringify(data.run.rawOutputJson, null, 2)}
              </pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
