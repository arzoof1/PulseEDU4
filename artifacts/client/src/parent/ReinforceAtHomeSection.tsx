import { useEffect, useState } from "react";
import { Brain, Download, CheckCircle2 } from "lucide-react";
import DictateButton from "../components/DictateButton";
import {
  fetchParentHomeCards,
  submitParentHomeResponse,
  downloadParentPacket,
  type ParentHomeCard,
} from "./brainLab";

// Family-facing "Reinforce at Home" surface on the parent Home tab. Renders only
// when the school has shared a Brain Lab work sample for this child. Each lesson
// card shows the bilingual recall content, lets the family record a voice-to-text
// "Home Follow-Up" per prompt, and downloads the evidence packet. studentId is
// the integer students.id the portal uses; the FLEID never reaches the client.
export default function ReinforceAtHomeSection({
  studentId,
}: {
  studentId: number;
}) {
  const [cards, setCards] = useState<ParentHomeCard[] | null>(null);
  const [error, setError] = useState("");
  const [lang, setLang] = useState<"en" | "es">("en");

  useEffect(() => {
    let alive = true;
    setCards(null);
    setError("");
    fetchParentHomeCards(studentId)
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

  // Render nothing until loaded, and stay invisible when there is nothing
  // shared — the family should not see an empty placeholder.
  if (cards === null) return null;
  if (error) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {error}
      </div>
    );
  }
  if (cards.length === 0) return null;

  const t = (en: string, es: string) => (lang === "en" ? en : es);

  return (
    <div className="rounded-2xl border border-indigo-200 bg-white p-5 shadow-sm space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-full bg-indigo-100 flex items-center justify-center">
            <Brain className="h-5 w-5 text-indigo-600" />
          </div>
          <div>
            <div className="font-semibold text-slate-900">
              {t("Reinforce at Home", "Refuerce en casa")}
            </div>
            <div className="text-xs text-slate-500">
              {t(
                "Keep the learning going with a quick conversation.",
                "Continúe el aprendizaje con una breve conversación.",
              )}
            </div>
          </div>
        </div>
        <div className="flex gap-1">
          {(["en", "es"] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLang(l)}
              className={`rounded-md border px-2 py-1 text-xs ${
                lang === l
                  ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                  : "border-slate-200 bg-white text-slate-500"
              }`}
            >
              {l === "en" ? "English" : "Español"}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-4">
        {cards.map((card) => (
          <HomeCard
            key={card.lessonKey}
            studentId={studentId}
            card={card}
            lang={lang}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}

function HomeCard({
  studentId,
  card,
  lang,
  t,
}: {
  studentId: number;
  card: ParentHomeCard;
  lang: "en" | "es";
  t: (en: string, es: string) => string;
}) {
  const pr = card.parentReinforcement;
  const [downloading, setDownloading] = useState(false);
  const [dlError, setDlError] = useState("");

  async function handleDownload() {
    if (downloading) return;
    setDownloading(true);
    setDlError("");
    try {
      await downloadParentPacket(studentId, card.lessonKey, lang);
    } catch (e) {
      setDlError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-semibold text-slate-900">{card.lessonTitle}</div>
          <div className="text-xs text-slate-500">
            {card.skillArea}
            {card.sessionDate ? ` · ${card.sessionDate}` : ""}
          </div>
        </div>
        <button
          type="button"
          onClick={handleDownload}
          disabled={downloading}
          className="inline-flex items-center gap-1 rounded-lg border border-indigo-300 bg-indigo-50 px-2.5 py-1.5 text-xs font-medium text-indigo-700 disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" />
          {downloading
            ? t("Preparing…", "Preparando…")
            : t("Packet", "Paquete")}
        </button>
      </div>

      <p className="mt-2 text-sm text-slate-700">{pr.summary[lang]}</p>

      <div className="mt-3 rounded-lg bg-slate-50 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
          {t("Why this works", "Por qué funciona")}
        </div>
        <p className="mt-1 text-sm text-slate-700">{pr.whyThisWorks[lang]}</p>
        <div className="mt-2 text-xs font-semibold uppercase tracking-wide text-indigo-700">
          {t("Try together", "Practiquen juntos")}
        </div>
        <p className="mt-1 text-sm text-slate-700">{pr.tryTogether[lang]}</p>
      </div>

      <div className="mt-3 space-y-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
          {t("Ask your child", "Pregúntele a su hijo/a")}
        </div>
        {pr.askYourChild.map((q, i) => {
          const existing = card.homeResponses.find((r) => r.promptIndex === i);
          return (
            <HomePrompt
              key={i}
              studentId={studentId}
              card={card}
              promptIndex={i}
              prompt={q[lang]}
              lang={lang}
              existing={existing?.transcript ?? ""}
              t={t}
            />
          );
        })}
      </div>

      {dlError && <div className="mt-2 text-xs text-red-600">{dlError}</div>}
    </div>
  );
}

function HomePrompt({
  studentId,
  card,
  promptIndex,
  prompt,
  lang,
  existing,
  t,
}: {
  studentId: number;
  card: ParentHomeCard;
  promptIndex: number;
  prompt: string;
  lang: "en" | "es";
  existing: string;
  t: (en: string, es: string) => string;
}) {
  const [text, setText] = useState(existing);
  // Local baseline of the last-persisted answer. Tracked separately from the
  // `existing` prop so a successful save clears the "dirty" state immediately
  // (the prop only refreshes on a full refetch).
  const [baseline, setBaseline] = useState(existing);
  const [saved, setSaved] = useState(existing.length > 0);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // Re-seed when the family switches the active child (the section keeps the
  // same component instance keyed by promptIndex, so existing text would stay).
  useEffect(() => {
    setText(existing);
    setBaseline(existing);
    setSaved(existing.length > 0);
  }, [existing, studentId]);

  const dirty = text.trim() !== baseline.trim();

  async function handleSave() {
    if (saving || !text.trim()) return;
    setSaving(true);
    setErr("");
    try {
      await submitParentHomeResponse({
        studentId,
        lessonKey: card.lessonKey,
        sessionId: card.sessionId,
        promptIndex,
        transcript: text.trim(),
        language: lang,
      });
      setBaseline(text.trim());
      setSaved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="text-sm font-medium text-slate-800">{prompt}</div>
      <div className="mt-2 flex items-start gap-2">
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSaved(false);
          }}
          rows={2}
          placeholder={t(
            "Type or use the mic to capture what your child said…",
            "Escriba o use el micrófono para registrar lo que dijo su hijo/a…",
          )}
          className="flex-1 resize-y rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
        <DictateButton
          onAppend={(chunk) =>
            setText((prev) => {
              setSaved(false);
              return prev ? `${prev} ${chunk}` : chunk;
            })
          }
          borderColor="#c7d2fe"
          inkSoft="#6366f1"
        />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !dirty || !text.trim()}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {saving ? t("Saving…", "Guardando…") : t("Save answer", "Guardar")}
        </button>
        {saved && !dirty && (
          <span className="inline-flex items-center gap-1 text-xs text-green-600">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {t("Saved", "Guardado")}
          </span>
        )}
        {err && <span className="text-xs text-red-600">{err}</span>}
      </div>
    </div>
  );
}
