import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { authFetch } from "../../lib/authToken";
import { WL_COLORS as C, ROLE_META, severityChipStyle } from "./colors";

interface ParticipantOut {
  id: number;
  studentId: string;
  firstName: string;
  lastName: string;
  grade: string | null;
  role: string;
  notes: string | null;
}

interface StatementOut {
  id: number;
  studentId: string;
  status: string;
  requestedAt: string;
  completedAt: string | null;
  body: string | null;
  formattedId?: string | null;
}

interface InteractionOut {
  id: number;
  occurredAt: string;
  occurredDate: string;
  kind: string;
  severity: number;
  location: string | null;
  summary: string;
  detail: string | null;
  caseId: number | null;
  status?: string | null;
  witnessStudentId?: string | null;
  witnessStudentName?: string | null;
  dismissedAt?: string | null;
  dismissedReason?: string | null;
  dismissedByName?: string | null;
  formattedCaseId?: string | null;
}

interface DetailsResponse {
  interaction: InteractionOut;
  participants: ParticipantOut[];
  statements: StatementOut[];
}

interface Props {
  interactionId: number;
  onClose: () => void;
  onOpenCase?: (caseId: number) => void;
}

export default function StatementDetailsModal({
  interactionId,
  onClose,
  onOpenCase,
}: Props) {
  const [data, setData] = useState<DetailsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    setData(null);
    void (async () => {
      try {
        const r = await authFetch(`/api/watchlist/interactions/${interactionId}`);
        if (!r.ok) throw new Error(await r.text());
        const d = (await r.json()) as DetailsResponse;
        if (alive) setData(d);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Failed to load");
      }
    })();
    return () => {
      alive = false;
    };
  }, [interactionId]);

  // ESC closes the modal — keeps the keyboard-only triage flow snappy.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const i = data?.interaction;
  const sev = i ? severityChipStyle(i.severity) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4"
      style={{ background: "rgba(15, 23, 42, 0.55)" }}
      onClick={onClose}
    >
      <div
        className="mt-10 w-full max-w-2xl rounded-xl border shadow-xl"
        style={{ borderColor: C.line, background: C.panel }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between border-b px-5 py-3"
          style={{ borderColor: C.line }}
        >
          <div>
            <div
              className="text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: C.inkSoft }}
            >
              Statement details
            </div>
            <div className="text-base font-bold" style={{ color: C.ink }}>
              {i ? `${i.formattedCaseId ?? `#${i.id}`} · ${i.kind}` : "Loading…"}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 hover:bg-[--hov]"
            style={
              {
                ["--hov" as never]: C.bg,
                color: C.inkSoft,
              } as React.CSSProperties
            }
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {error ? (
          <div className="p-5 text-sm" style={{ color: C.alert }}>
            {error}
          </div>
        ) : !data || !i || !sev ? (
          <div className="p-5 text-sm" style={{ color: C.inkSoft }}>
            Loading statement…
          </div>
        ) : (
          <div className="space-y-4 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
                style={{ background: sev.bg, color: sev.fg }}
              >
                {sev.label}
              </span>
              <span
                className="text-[11px] font-semibold"
                style={{ color: C.inkSoft }}
              >
                {new Date(i.occurredAt).toLocaleString()}
              </span>
              {i.location ? (
                <span className="text-[11px]" style={{ color: C.inkSoft }}>
                  · {i.location}
                </span>
              ) : null}
              {i.caseId ? (
                <button
                  type="button"
                  onClick={() => {
                    onOpenCase?.(i.caseId!);
                    onClose();
                  }}
                  className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  style={{ background: C.brandSoft, color: C.brand }}
                >
                  {i.formattedCaseId ? `Case ${i.formattedCaseId}` : `Case #${i.caseId}`} →
                </button>
              ) : i.status === "dismissed" ? (
                <span
                  className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  style={{ background: C.alertSoft, color: C.alert }}
                >
                  Dismissed
                </span>
              ) : (
                <span
                  className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  style={{ background: C.bg, color: C.inkSoft }}
                >
                  Awaiting triage
                </span>
              )}
            </div>

            <div>
              <div
                className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
                style={{ color: C.inkSoft }}
              >
                Statement from
              </div>
              <div className="text-sm font-semibold" style={{ color: C.ink }}>
                {i.witnessStudentName?.trim() || (
                  <span className="font-normal italic" style={{ color: C.inkSoft }}>
                    (legacy entry — no witness on record)
                  </span>
                )}
                {i.witnessStudentId ? (
                  <span
                    className="ml-1 text-[11px] font-normal"
                    style={{ color: C.inkSoft }}
                  >
                    · {i.witnessStudentId}
                  </span>
                ) : null}
              </div>
            </div>

            <div>
              <div
                className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
                style={{ color: C.inkSoft }}
              >
                Summary
              </div>
              <div className="text-sm" style={{ color: C.ink }}>
                {i.summary}
              </div>
            </div>

            <div>
              <div
                className="mb-1 text-[11px] font-semibold uppercase tracking-wider"
                style={{ color: C.inkSoft }}
              >
                Student statement
              </div>
              <div
                className="whitespace-pre-wrap rounded-md border p-3 text-sm"
                style={{
                  borderColor: C.line,
                  background: C.bg,
                  color: i.detail?.trim() ? C.ink : C.inkSoft,
                }}
              >
                {i.detail?.trim() || "(no statement body recorded)"}
              </div>
            </div>

            <div>
              <div
                className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider"
                style={{ color: C.inkSoft }}
              >
                <span>Participants tagged</span>
                <span>{data.participants.length}</span>
              </div>
              {data.participants.length === 0 ? (
                <div className="text-sm" style={{ color: C.inkSoft }}>
                  No participants tagged.
                </div>
              ) : (
                <ul className="divide-y rounded-md border" style={{ borderColor: C.line }}>
                  {data.participants.map((p) => {
                    const meta =
                      (ROLE_META as Record<string, { label: string; color: string; soft: string } | undefined>)[
                        p.role
                      ] ?? { label: p.role, color: C.inkSoft, soft: C.bg };
                    return (
                      <li
                        key={p.id}
                        className="flex items-start justify-between gap-3 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-semibold" style={{ color: C.ink }}>
                            {p.firstName} {p.lastName}{" "}
                            <span
                              className="text-[11px] font-normal"
                              style={{ color: C.inkSoft }}
                            >
                              · Gr {p.grade ?? "?"} · {p.studentId}
                            </span>
                          </div>
                          {p.notes ? (
                            <div
                              className="mt-0.5 text-[12px]"
                              style={{ color: C.inkSoft }}
                            >
                              {p.notes}
                            </div>
                          ) : null}
                        </div>
                        <span
                          className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                          style={{ background: meta.soft, color: meta.color }}
                        >
                          {meta.label}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {i.status === "dismissed" && (i.dismissedReason || i.dismissedByName) ? (
              <div
                className="rounded-md border p-3 text-[12px]"
                style={{
                  borderColor: C.alertSoft,
                  background: C.alertSoft,
                  color: C.alert,
                }}
              >
                <div className="font-semibold">Dismissed</div>
                <div>
                  {i.dismissedByName ? `by ${i.dismissedByName}` : ""}
                  {i.dismissedAt
                    ? ` · ${new Date(i.dismissedAt).toLocaleString()}`
                    : ""}
                </div>
                {i.dismissedReason ? (
                  <div className="mt-1 italic">"{i.dismissedReason}"</div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

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
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
