import { useEffect, useState } from "react";
import type { PulseBrainLabHomeCard } from "@workspace/api-client-react";
import { fetchStudentHomeCards, homePacketPdfUrl, downloadPdf } from "./data";

// Staff preview of the family-facing "Reinforce at Home" cards for one student.
// Shows EXACTLY what the home sees: only lessons with a shared work sample
// appear, with the bilingual recall content and any Home Follow-Up the family
// recorded. studentId is the canonical student_id (FLEID) — the join key only,
// NEVER rendered; cards carry localSisId for display.
export default function StudentHomeCards({
  studentId,
}: {
  studentId: string;
}) {
  const [cards, setCards] = useState<PulseBrainLabHomeCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState<"en" | "es">("en");

  useEffect(() => {
    let alive = true;
    setCards(null);
    setError(null);
    fetchStudentHomeCards(studentId)
      .then((c) => {
        if (alive) setCards(c);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [studentId]);

  if (error) {
    return (
      <div style={{ color: "#b91c1c", fontSize: "0.85rem", marginTop: "0.6rem" }}>
        Couldn't load Reinforce at Home: {error}
      </div>
    );
  }
  if (cards === null) {
    return (
      <div style={{ color: "#94a3b8", fontSize: "0.85rem", marginTop: "0.6rem" }}>
        Loading Reinforce at Home…
      </div>
    );
  }
  if (cards.length === 0) {
    return (
      <div
        style={{
          marginTop: "0.8rem",
          border: "1px dashed #cbd5e1",
          borderRadius: 10,
          padding: "0.9rem 1rem",
          color: "#64748b",
          fontSize: "0.85rem",
        }}
      >
        <strong style={{ color: "#475569" }}>Reinforce at Home</strong>
        <div style={{ marginTop: "0.3rem" }}>
          Nothing shared with this family yet. Mark a Brain Lab work sample as
          “Share with family” to surface the lesson’s home card.
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: "0.8rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "0.5rem",
        }}
      >
        <strong style={{ color: "#3730a3", fontSize: "0.95rem" }}>
          Reinforce at Home ({cards.length})
        </strong>
        <div style={{ display: "flex", gap: "0.3rem" }}>
          {(["en", "es"] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLang(l)}
              style={{
                border: `1px solid ${lang === l ? "#4338ca" : "#cbd5e1"}`,
                background: lang === l ? "#eef2ff" : "#fff",
                color: lang === l ? "#3730a3" : "#475569",
                borderRadius: 6,
                fontSize: "0.75rem",
                padding: "0.15rem 0.5rem",
                cursor: "pointer",
              }}
            >
              {l === "en" ? "English" : "Español"}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gap: "0.7rem" }}>
        {cards.map((card) => {
          const pr = card.parentReinforcement;
          return (
            <div
              key={card.lessonKey}
              style={{
                border: "1px solid #e2e8f0",
                borderRadius: 12,
                padding: "0.85rem 1rem",
                background: "#fff",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  gap: "0.6rem",
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, color: "#0f172a" }}>
                    {card.lessonTitle}
                  </div>
                  <div style={{ color: "#64748b", fontSize: "0.8rem" }}>
                    {card.skillArea}
                    {card.sessionDate ? ` · ${card.sessionDate}` : ""} ·{" "}
                    {card.workSamples.length} shared sample
                    {card.workSamples.length === 1 ? "" : "s"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    downloadPdf(
                      homePacketPdfUrl(studentId, card.lessonKey, lang),
                      `reinforce-at-home-${card.lessonKey}-${lang}.pdf`,
                    ).catch((e) =>
                      setError(e instanceof Error ? e.message : String(e)),
                    )
                  }
                  style={{
                    border: "1px solid #4338ca",
                    background: "#eef2ff",
                    color: "#3730a3",
                    borderRadius: 8,
                    fontSize: "0.78rem",
                    padding: "0.3rem 0.6rem",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  Download packet
                </button>
              </div>

              <div
                style={{
                  marginTop: "0.5rem",
                  color: "#334155",
                  fontSize: "0.85rem",
                }}
              >
                {pr.summary[lang]}
              </div>

              <div style={{ marginTop: "0.5rem" }}>
                <div
                  style={{
                    fontSize: "0.75rem",
                    fontWeight: 600,
                    color: "#4338ca",
                    textTransform: "uppercase",
                    letterSpacing: "0.03em",
                  }}
                >
                  {lang === "en" ? "Ask your child" : "Pregúntele a su hijo/a"}
                </div>
                <ol
                  style={{
                    margin: "0.3rem 0 0",
                    paddingLeft: "1.1rem",
                    color: "#334155",
                    fontSize: "0.85rem",
                  }}
                >
                  {pr.askYourChild.map((q, i) => {
                    const resp = card.homeResponses.find(
                      (r) => r.promptIndex === i,
                    );
                    return (
                      <li key={i} style={{ marginBottom: "0.3rem" }}>
                        {q[lang]}
                        {resp && (
                          <div
                            style={{
                              marginTop: "0.2rem",
                              background: "#f0fdf4",
                              border: "1px solid #bbf7d0",
                              borderRadius: 8,
                              padding: "0.35rem 0.5rem",
                              color: "#166534",
                              fontSize: "0.8rem",
                            }}
                          >
                            <span style={{ fontWeight: 600 }}>
                              {lang === "en"
                                ? "Family answered: "
                                : "La familia respondió: "}
                            </span>
                            {resp.transcript}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
