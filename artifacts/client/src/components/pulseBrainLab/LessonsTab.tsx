import { useEffect, useMemo, useState } from "react";
import type {
  PulseBrainLabLessonSummary,
  PulseBrainLabParentCard,
  PulseBrainLabGradeBand,
} from "@workspace/api-client-react";
import {
  fetchLessons,
  fetchParentCard,
  facilitationPdfUrl,
  downloadPdf,
} from "./data";

const GRADE_BANDS: PulseBrainLabGradeBand[] = ["K-2", "3-5", "6-8", "9-12"];

const TAG_COLORS: Record<string, string> = {
  Spotlight: "#b45309",
  Velcro: "#0e7490",
  Echo: "#7c3aed",
  Rewire: "#be185d",
};

export default function LessonsTab() {
  const [gradeBand, setGradeBand] = useState<PulseBrainLabGradeBand | "all">(
    "all",
  );
  const [lessons, setLessons] = useState<PulseBrainLabLessonSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PulseBrainLabLessonSummary | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchLessons(gradeBand === "all" ? undefined : gradeBand)
      .then((rows) => {
        if (cancelled) return;
        setLessons(rows);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [gradeBand]);

  const grouped = useMemo(() => {
    const map = new Map<string, PulseBrainLabLessonSummary[]>();
    for (const l of lessons) {
      const arr = map.get(l.gradeBand) ?? [];
      arr.push(l);
      map.set(l.gradeBand, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.week - b.week || a.session - b.session);
    }
    return map;
  }, [lessons]);

  const orderedBands =
    gradeBand === "all" ? GRADE_BANDS : [gradeBand];

  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: "0.4rem",
          flexWrap: "wrap",
          marginBottom: "1rem",
        }}
      >
        <FilterChip
          active={gradeBand === "all"}
          label="All grades"
          onClick={() => setGradeBand("all")}
        />
        {GRADE_BANDS.map((g) => (
          <FilterChip
            key={g}
            active={gradeBand === g}
            label={g}
            onClick={() => setGradeBand(g)}
          />
        ))}
      </div>

      {loading && <div style={{ color: "#64748b" }}>Loading lessons…</div>}
      {error && (
        <div style={{ color: "#b91c1c", marginBottom: "0.75rem" }}>{error}</div>
      )}

      {!loading && !error && lessons.length === 0 && (
        <div style={{ color: "#64748b" }}>No lessons found.</div>
      )}

      {!loading &&
        !error &&
        orderedBands.map((band) => {
          const rows = grouped.get(band) ?? [];
          if (rows.length === 0) return null;
          return (
            <div key={band} style={{ marginBottom: "1.5rem" }}>
              <h3
                style={{
                  margin: "0 0 0.5rem",
                  fontSize: "1rem",
                  color: "#0f172a",
                }}
              >
                Grades {band}{" "}
                <span style={{ color: "#94a3b8", fontWeight: 400 }}>
                  ({rows.length})
                </span>
              </h3>
              <div style={{ display: "grid", gap: "0.5rem" }}>
                {rows.map((l) => (
                  <button
                    key={l.lessonKey}
                    type="button"
                    onClick={() => setSelected(l)}
                    style={{
                      textAlign: "left",
                      background: "white",
                      border: "1px solid #e2e8f0",
                      borderRadius: 8,
                      padding: "0.7rem 0.9rem",
                      cursor: "pointer",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "0.75rem",
                    }}
                  >
                    <span>
                      <span style={{ fontWeight: 600, color: "#0f172a" }}>
                        {l.title}
                      </span>
                      <span
                        style={{
                          color: "#64748b",
                          fontSize: "0.85rem",
                          marginLeft: "0.5rem",
                        }}
                      >
                        {l.skillArea}
                      </span>
                    </span>
                    <span
                      style={{
                        display: "flex",
                        gap: "0.5rem",
                        alignItems: "center",
                        flexShrink: 0,
                      }}
                    >
                      <BrainTag tag={l.brainModelTag} />
                      <span style={{ color: "#94a3b8", fontSize: "0.8rem" }}>
                        Wk {l.week} · S{l.session}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}

      {selected && (
        <LessonDetail
          lesson={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function FilterChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: active ? "1px solid #0e7490" : "1px solid #cbd5e1",
        background: active ? "#0e7490" : "white",
        color: active ? "white" : "#334155",
        borderRadius: 999,
        padding: "0.35rem 0.85rem",
        fontSize: "0.85rem",
        fontWeight: active ? 600 : 500,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function BrainTag({ tag }: { tag: string }) {
  const color = TAG_COLORS[tag] ?? "#475569";
  return (
    <span
      style={{
        background: `${color}1a`,
        color,
        borderRadius: 999,
        padding: "0.15rem 0.6rem",
        fontSize: "0.75rem",
        fontWeight: 600,
      }}
    >
      {tag}
    </span>
  );
}

function LessonDetail({
  lesson,
  onClose,
}: {
  lesson: PulseBrainLabLessonSummary;
  onClose: () => void;
}) {
  const [lang, setLang] = useState<"en" | "es">("en");
  const [card, setCard] = useState<PulseBrainLabParentCard | null>(null);
  const [cardLoading, setCardLoading] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCardLoading(true);
    setCardError(null);
    fetchParentCard(lesson.lessonKey, lang)
      .then((c) => {
        if (!cancelled) setCard(c);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setCardError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setCardLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lesson.lessonKey, lang]);

  const onDownload = async () => {
    setPdfBusy(true);
    setPdfError(null);
    try {
      await downloadPdf(
        facilitationPdfUrl(lesson.lessonKey),
        `${lesson.lessonKey}-facilitation.pdf`,
      );
    } catch (e) {
      setPdfError(e instanceof Error ? e.message : String(e));
    } finally {
      setPdfBusy(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.45)",
        display: "flex",
        justifyContent: "flex-end",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(520px, 100%)",
          background: "white",
          height: "100%",
          overflowY: "auto",
          padding: "1.5rem",
          boxShadow: "-8px 0 24px rgba(0,0,0,0.15)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: "1rem",
          }}
        >
          <div>
            <h2 style={{ margin: "0 0 0.25rem", fontSize: "1.25rem" }}>
              {lesson.title}
            </h2>
            <div style={{ color: "#64748b", fontSize: "0.9rem" }}>
              Grades {lesson.gradeBand} · {lesson.skillArea} · Wk {lesson.week}{" "}
              · Session {lesson.session}
            </div>
            <div style={{ marginTop: "0.5rem" }}>
              <BrainTag tag={lesson.brainModelTag} />
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: "none",
              background: "none",
              fontSize: "1.5rem",
              cursor: "pointer",
              color: "#94a3b8",
              lineHeight: 1,
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div style={{ marginTop: "1.25rem" }}>
          <button
            type="button"
            onClick={onDownload}
            disabled={pdfBusy}
            style={{
              background: "#0e7490",
              color: "white",
              border: "none",
              borderRadius: 8,
              padding: "0.6rem 1rem",
              fontWeight: 600,
              cursor: pdfBusy ? "default" : "pointer",
              opacity: pdfBusy ? 0.7 : 1,
            }}
          >
            {pdfBusy ? "Preparing…" : "Open facilitation guide (PDF)"}
          </button>
          {pdfError && (
            <div
              style={{
                color: "#b91c1c",
                fontSize: "0.85rem",
                marginTop: "0.4rem",
              }}
            >
              {pdfError}
            </div>
          )}
        </div>

        <div style={{ marginTop: "1.75rem" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "0.6rem",
            }}
          >
            <h3 style={{ margin: 0, fontSize: "1rem" }}>
              Reinforce at Home card
            </h3>
            <div style={{ display: "flex", gap: "0.25rem" }}>
              <LangChip
                active={lang === "en"}
                label="EN"
                onClick={() => setLang("en")}
              />
              <LangChip
                active={lang === "es"}
                label="ES"
                onClick={() => setLang("es")}
              />
            </div>
          </div>

          {cardLoading && (
            <div style={{ color: "#64748b" }}>Loading card…</div>
          )}
          {cardError && <div style={{ color: "#b91c1c" }}>{cardError}</div>}
          {card && !cardLoading && (
            <div
              style={{
                border: "1px solid #e2e8f0",
                borderRadius: 10,
                padding: "1rem",
                background: "#f8fafc",
              }}
            >
              <p style={{ margin: "0 0 0.75rem", color: "#0f172a" }}>
                {card.summary}
              </p>
              <CardSection title="Ask your child">
                <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.1rem" }}>
                  {card.askYourChild.map((q, i) => (
                    <li key={i} style={{ marginBottom: "0.25rem" }}>
                      {q}
                    </li>
                  ))}
                </ul>
              </CardSection>
              <CardSection title="Why this works">
                {card.whyThisWorks}
              </CardSection>
              <CardSection title="Try together">
                {card.tryTogether}
              </CardSection>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LangChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: active ? "1px solid #0e7490" : "1px solid #cbd5e1",
        background: active ? "#0e7490" : "white",
        color: active ? "white" : "#334155",
        borderRadius: 6,
        padding: "0.2rem 0.6rem",
        fontSize: "0.8rem",
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function CardSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginTop: "0.75rem" }}>
      <div
        style={{
          fontSize: "0.75rem",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.03em",
          color: "#0e7490",
          marginBottom: "0.2rem",
        }}
      >
        {title}
      </div>
      <div style={{ color: "#334155", fontSize: "0.9rem" }}>{children}</div>
    </div>
  );
}
