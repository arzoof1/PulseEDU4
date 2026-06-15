import { useEffect, useState } from "react";
import { GraduationCap, ChevronDown, FileText } from "lucide-react";
import {
  fetchLearningAtHomeCards,
  fetchLearningAtHomeImage,
  type LearningAtHomeCard,
  type LearningAtHomeSample,
  type AcademicSubject,
} from "./learningAtHome";

// Family-facing "Learning at Home" surface on the parent Academics tab. One card
// per class on the child's read-only schedule; each card opens to that class's
// PUBLISHED academic work samples. Same collapsed "purposeful review" model as
// Reinforce at Home, so several classes pushing work stays calm on screen.
//
// onLoaded reports how many cards carry at least one shared sample so the parent
// AcademicsTab can decide whether the tab is truly empty. studentId is the
// integer students.id; the FLEID never reaches the client.
export default function LearningAtHomeSection({
  studentId,
  onLoaded,
}: {
  studentId: number;
  onLoaded?: (sharedCardCount: number) => void;
}) {
  const [cards, setCards] = useState<LearningAtHomeCard[] | null>(null);
  const [error, setError] = useState("");
  const [lang, setLang] = useState<"en" | "es">("en");

  useEffect(() => {
    let alive = true;
    setCards(null);
    setError("");
    fetchLearningAtHomeCards(studentId)
      .then((r) => {
        if (!alive) return;
        setCards(r.cards);
        onLoaded?.(r.cards.filter((c) => c.samples.length > 0).length);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [studentId, onLoaded]);

  const t = (en: string, es: string) => (lang === "en" ? en : es);

  if (error) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {error}
      </div>
    );
  }
  // Only show classes that actually have shared work — an empty schedule card
  // would just be noise on the Academics tab.
  const withWork = (cards ?? []).filter((c) => c.samples.length > 0);
  if (cards === null || withWork.length === 0) return null;

  return (
    <div className="rounded-2xl border border-indigo-200 bg-white p-5 shadow-sm space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-full bg-indigo-100 flex items-center justify-center">
            <GraduationCap className="h-5 w-5 text-indigo-600" />
          </div>
          <div>
            <div className="font-semibold text-slate-900">
              {t("Learning at Home", "Aprendizaje en casa")}
            </div>
            <div className="text-xs text-slate-500">
              {t(
                "See the classwork your child's teachers shared.",
                "Vea el trabajo que compartieron los maestros de su hijo/a.",
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

      <div className="space-y-3">
        {withWork.map((card) => (
          <ClassCard
            key={card.sectionId}
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

function subjectLabel(s: AcademicSubject, lang: "en" | "es"): string {
  if (s === "ela") return lang === "en" ? "Reading / ELA" : "Lectura / ELA";
  if (s === "math") return lang === "en" ? "Math" : "Matemáticas";
  if (s === "social_studies")
    return lang === "en" ? "Social Studies" : "Estudios Sociales";
  if (s === "science") return lang === "en" ? "Science" : "Ciencias";
  if (s === "leader_in_me")
    return lang === "en" ? "Leader in Me" : "Líder en Mí";
  return lang === "en" ? "Behavior Intervention" : "Intervención de Conducta";
}

function ClassCard({
  studentId,
  card,
  lang,
  t,
}: {
  studentId: number;
  card: LearningAtHomeCard;
  lang: "en" | "es";
  t: (en: string, es: string) => string;
}) {
  const [open, setOpen] = useState(false);

  // "New" badge + collapse: the card stays closed until the family taps it open.
  // A per-card signature of the latest activity (newest published timestamp +
  // count) is stored in localStorage on open; if the live signature differs the
  // card shows "New" again.
  const latest = card.samples[0]?.publishedAt ?? "";
  const signature = `${latest}|${card.samples.length}`;
  const seenKey = `pulseed.lah.seen.${studentId}.${card.sectionId}`;
  const [isNew, setIsNew] = useState(() => {
    try {
      return localStorage.getItem(seenKey) !== signature;
    } catch {
      return true;
    }
  });

  function handleToggle() {
    setOpen((v) => {
      const next = !v;
      if (next && isNew) {
        setIsNew(false);
        try {
          localStorage.setItem(seenKey, signature);
        } catch {
          // best-effort; private mode may block storage
        }
      }
      return next;
    });
  }

  const title = card.period
    ? t(`Period ${card.period}`, `Período ${card.period}`)
    : card.courseName || t("Class", "Clase");

  return (
    <div className="rounded-xl border border-slate-200">
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 p-4 text-left"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold text-slate-900">
              {title}
            </span>
            {isNew && (
              <span className="inline-flex shrink-0 items-center rounded-full bg-rose-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                {t("New", "Nuevo")}
              </span>
            )}
          </div>
          <div className="text-xs text-slate-500">
            {card.courseName ? `${card.courseName} · ` : ""}
            {card.teacherName ? `${card.teacherName} · ` : ""}
            {card.samples.length}{" "}
            {t("work sample(s)", "muestra(s) de trabajo")}
          </div>
        </div>
        <ChevronDown
          className={`h-5 w-5 shrink-0 text-slate-400 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div className="space-y-3 border-t border-slate-100 p-4 pt-3">
          {card.samples.map((s) => (
            <SampleBlock
              key={s.id}
              studentId={studentId}
              sample={s}
              lang={lang}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SampleBlock({
  studentId,
  sample,
  lang,
  t,
}: {
  studentId: number;
  sample: LearningAtHomeSample;
  lang: "en" | "es";
  t: (en: string, es: string) => string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium text-slate-900">{sample.assignmentTitle}</div>
        <span className="shrink-0 rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">
          {subjectLabel(sample.subject, lang)}
        </span>
      </div>
      {sample.publishedAt && (
        <div className="mt-0.5 text-xs text-slate-500">
          {new Date(sample.publishedAt).toLocaleDateString()}
        </div>
      )}
      {sample.note && (
        <p className="mt-2 text-sm text-slate-700">{sample.note}</p>
      )}
      <div className="mt-2">
        <SampleMedia studentId={studentId} sample={sample} t={t} />
      </div>
    </div>
  );
}

// Authed image/PDF for one published sample, pulled via parentFetch into a blob
// URL (a bare <img src> can't carry the Bearer token in the preview iframe).
function SampleMedia({
  studentId,
  sample,
  t,
}: {
  studentId: number;
  sample: LearningAtHomeSample;
  t: (en: string, es: string) => string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [contentType, setContentType] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    let created: string | null = null;
    setUrl(null);
    setErr("");
    fetchLearningAtHomeImage(studentId, sample.id)
      .then(({ objectUrl, contentType }) => {
        if (alive) {
          created = objectUrl;
          setUrl(objectUrl);
          setContentType(contentType);
        } else {
          URL.revokeObjectURL(objectUrl);
        }
      })
      .catch((e) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [studentId, sample.id]);

  if (err) {
    return (
      <div className="flex h-32 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 p-3 text-center text-xs text-slate-500">
        {t("Could not load this work sample.", "No se pudo cargar la muestra.")}
      </div>
    );
  }
  if (!url) {
    return (
      <div className="flex h-32 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-xs text-slate-400">
        {t("Loading…", "Cargando…")}
      </div>
    );
  }
  if (contentType.includes("pdf")) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700"
      >
        <FileText className="h-3.5 w-3.5" />
        {t("Open the document", "Abrir el documento")}
      </a>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" className="block">
      <img
        src={url}
        alt={t("Shared classwork", "Trabajo compartido")}
        className="w-full rounded-lg border border-slate-200 object-contain"
      />
    </a>
  );
}
