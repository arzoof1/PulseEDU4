import { useEffect, useMemo, useRef, useState } from "react";
import TourWalk from "./TourWalk";

// =============================================================================
// TourApp — public, UNAUTHENTICATED enrollment surface for School Tours.
//
// Path-dispatched (no react-router, mirrors PickupApp):
//   /tour/:schoolId          — the school's public "brag page" + request form
//   /tour/survey/:token      — post-tour survey tied back to a lead
//
// Everything here is open to the world: a family clicks a link from a flyer
// QR code or Facebook post and never signs in. The school is identified by
// the numeric :schoolId (brag page) or the opaque :token (survey).
//
// Bilingual: a small EN/ES toggle flips all family-facing copy. The chosen
// language is submitted with the lead so staff know how to follow up.
// =============================================================================

type Lang = "en" | "es";

const T = {
  en: {
    requestTour: "Request Your Tour",
    requestSub:
      "Tell us a little about your family and we'll reach out within one school day.",
    familyName: "Family / parent name",
    phone: "Phone number",
    email: "Email (optional)",
    students: "Student(s)",
    studentName: "Student name",
    grade: "Incoming grade",
    addStudent: "+ Add another student",
    checkpointsHeading: "What would you like to see on your tour?",
    checkpointsHint: "Pick any that interest you — we'll build your tour around them.",
    alwaysIncludedHeading: "Always included on every tour",
    alwaysIncludedHint: "We'll make sure you see these highlights.",
    interests: "Anything else? (optional)",
    interestsPh:
      "Programs, electives, sports, after-school care, anything on your mind…",
    submit: "Request my tour",
    submitting: "Sending…",
    thanksTitle: "Thank you!",
    thanksBody:
      "We received your tour request. A member of our team will reach out within one school day to find a time that works for you.",
    programs: "Programs",
    electives: "Electives",
    proudOf: "What we're proud of",
    flyers: "School Flyers",
    viewFlyer: "View flyer",
    downloadFlyer: "Download",
    openFlyer: "Open in new tab",
    pdfMobileHint: "Tap to view or download this document.",
    required: "Please add your name, a phone number, and at least one student.",
    error: "Something went wrong. Please try again.",
    contact: "Questions? Reach us at",
    surveyTitle: "How was your visit?",
    surveySub: "Your feedback helps us serve families better. Thank you!",
    rating: "Overall, how was your tour?",
    liked: "What stood out to you?",
    questions: "Anything you're still wondering about?",
    comments: "Anything else you'd like to share?",
    surveySubmit: "Share my feedback",
    surveyThanks: "Thanks for sharing — we're grateful you visited!",
    surveyDone: "This survey has already been submitted. Thank you!",
    notFound: "We couldn't find that page.",
    translating: "Translating…",
  },
  es: {
    requestTour: "Solicite su recorrido",
    requestSub:
      "Cuéntenos un poco sobre su familia y nos comunicaremos en un día escolar.",
    familyName: "Nombre de la familia / padre",
    phone: "Número de teléfono",
    email: "Correo electrónico (opcional)",
    students: "Estudiante(s)",
    studentName: "Nombre del estudiante",
    grade: "Grado de ingreso",
    addStudent: "+ Agregar otro estudiante",
    checkpointsHeading: "¿Qué le gustaría ver en su recorrido?",
    checkpointsHint:
      "Elija las que le interesen — organizaremos su recorrido en torno a ellas.",
    alwaysIncludedHeading: "Siempre incluido en cada recorrido",
    alwaysIncludedHint: "Nos aseguraremos de que vea estos lugares destacados.",
    interests: "¿Algo más? (opcional)",
    interestsPh:
      "Programas, materias optativas, deportes, cuidado después de clases…",
    submit: "Solicitar mi recorrido",
    submitting: "Enviando…",
    thanksTitle: "¡Gracias!",
    thanksBody:
      "Recibimos su solicitud. Un miembro de nuestro equipo se comunicará en un día escolar para coordinar una hora.",
    programs: "Programas",
    electives: "Materias optativas",
    proudOf: "De lo que estamos orgullosos",
    flyers: "Folletos de la escuela",
    viewFlyer: "Ver folleto",
    downloadFlyer: "Descargar",
    openFlyer: "Abrir en pestaña nueva",
    pdfMobileHint: "Toque para ver o descargar este documento.",
    required:
      "Agregue su nombre, un teléfono y al menos un estudiante.",
    error: "Algo salió mal. Inténtelo de nuevo.",
    contact: "¿Preguntas? Contáctenos en",
    surveyTitle: "¿Cómo estuvo su visita?",
    surveySub:
      "Sus comentarios nos ayudan a servir mejor a las familias. ¡Gracias!",
    rating: "En general, ¿cómo estuvo su recorrido?",
    liked: "¿Qué le llamó la atención?",
    questions: "¿Tiene alguna duda todavía?",
    comments: "¿Algo más que quiera compartir?",
    surveySubmit: "Enviar mis comentarios",
    surveyThanks: "¡Gracias por compartir y por visitarnos!",
    surveyDone: "Esta encuesta ya fue enviada. ¡Gracias!",
    notFound: "No encontramos esa página.",
    translating: "Traduciendo…",
  },
} as const;

type TourPage = {
  schoolName: string;
  headline: string;
  subheadline: string;
  intro: string;
  sections: { title: string; body: string }[];
  checkpoints: { key: string; label: string; alwaysInclude?: boolean }[];
  programs: string[];
  electives: string[];
  proudOf: string[];
  photos: string[];
  textPlacement: "top" | "bottom";
  flyers: { label: string; kind: "image" | "pdf"; url: string }[];
  ctaText: string;
  accentColor: string;
  headerTextColor: string;
  contactEmail: string | null;
  contactPhone: string | null;
  // District-level branding (set once by SuperUser; every school in the
  // district inherits it). null when the school has no district or no logo.
  district: {
    tagline: string | null;
    hasLogo: boolean;
    logoUrl: string | null;
    placements: { heroTop: boolean; footer: boolean; watermark: boolean };
  } | null;
};

function useAccent(hex: string | undefined): string {
  return hex && /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : "#0ea5a4";
}

function safeColor(hex: string | undefined, fallback: string): string {
  return hex && /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : fallback;
}

const page: React.CSSProperties = {
  minHeight: "100vh",
  background: "#f6f8fb",
  color: "#1f2937",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
};
const wrap: React.CSSProperties = {
  maxWidth: 880,
  margin: "0 auto",
  padding: "0 20px 64px",
};
const card: React.CSSProperties = {
  background: "#fff",
  borderRadius: 16,
  boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
  padding: 24,
  marginTop: 20,
};
const label: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: "#475569",
  marginBottom: 6,
};
const input: React.CSSProperties = {
  width: "100%",
  padding: "11px 13px",
  borderRadius: 10,
  border: "1px solid #cbd5e1",
  fontSize: 15,
  boxSizing: "border-box",
  background: "#fff",
  color: "#1f2937",
};

function LangToggle({
  lang,
  setLang,
  accent,
}: {
  lang: Lang;
  setLang: (l: Lang) => void;
  accent: string;
}) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {(["en", "es"] as Lang[]).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          style={{
            padding: "5px 12px",
            borderRadius: 999,
            border: `1px solid ${lang === l ? accent : "rgba(255,255,255,0.6)"}`,
            background: lang === l ? "#fff" : "rgba(255,255,255,0.15)",
            color: lang === l ? accent : "#fff",
            fontWeight: 600,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          {l === "en" ? "English" : "Español"}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Swipeable photo carousel — native scroll-snap (swipe on touch), with arrow
// controls + dots for desktop.
// ---------------------------------------------------------------------------
function PhotoCarousel({
  photos,
  accent,
}: {
  photos: string[];
  accent: string;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [idx, setIdx] = useState(0);

  const goTo = (i: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    const n = Math.max(0, Math.min(photos.length - 1, i));
    el.scrollTo({ left: n * el.clientWidth, behavior: "smooth" });
  };
  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    setIdx(Math.round(el.scrollLeft / el.clientWidth));
  };

  const multi = photos.length > 1;

  return (
    <div style={{ position: "relative", marginTop: 20 }}>
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        style={{
          display: "flex",
          overflowX: "auto",
          scrollSnapType: "x mandatory",
          borderRadius: 16,
          boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
          background: "#e2e8f0",
          scrollbarWidth: "none",
        }}
      >
        {photos.map((u, i) => (
          <img
            key={i}
            src={u}
            alt=""
            style={{
              flex: "0 0 100%",
              width: "100%",
              height: 380,
              objectFit: "cover",
              scrollSnapAlign: "center",
              display: "block",
            }}
          />
        ))}
      </div>

      {multi && (
        <>
          <button
            type="button"
            aria-label="Previous photo"
            onClick={() => goTo(idx - 1)}
            style={arrowBtn("left", idx === 0)}
          >
            ‹
          </button>
          <button
            type="button"
            aria-label="Next photo"
            onClick={() => goTo(idx + 1)}
            style={arrowBtn("right", idx === photos.length - 1)}
          >
            ›
          </button>
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              gap: 7,
              marginTop: 12,
            }}
          >
            {photos.map((_, i) => (
              <button
                key={i}
                type="button"
                aria-label={`Go to photo ${i + 1}`}
                onClick={() => goTo(i)}
                style={{
                  width: i === idx ? 22 : 8,
                  height: 8,
                  borderRadius: 999,
                  border: "none",
                  background: i === idx ? accent : "#cbd5e1",
                  cursor: "pointer",
                  transition: "width 0.2s",
                  padding: 0,
                }}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function arrowBtn(side: "left" | "right", disabled: boolean): React.CSSProperties {
  return {
    position: "absolute",
    top: 190,
    transform: "translateY(-50%)",
    [side]: 10,
    width: 40,
    height: 40,
    borderRadius: 999,
    border: "none",
    background: "rgba(255,255,255,0.92)",
    color: "#1f2937",
    fontSize: 24,
    lineHeight: 1,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.4 : 1,
    boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
    display: "grid",
    placeItems: "center",
  } as React.CSSProperties;
}

// ---------------------------------------------------------------------------
// Brag page + request form
// ---------------------------------------------------------------------------
function BragPage({ schoolId }: { schoolId: number }) {
  const [lang, setLang] = useState<Lang>("en");
  const t = T[lang];
  const [data, setData] = useState<TourPage | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "missing">(
    "loading",
  );
  const [showForm, setShowForm] = useState(false);
  // True while the page is being (machine-)translated into the selected
  // language for the first time — admin free text is translated server-side on
  // demand, which can take a moment on the first non-English view.
  const [translating, setTranslating] = useState(false);
  const source = useMemo(
    () => new URLSearchParams(window.location.search).get("source") || "",
    [],
  );
  // Cache the fetched page per language so toggling EN<->ES is instant after
  // the first load and we never re-hit the translation endpoint needlessly.
  const pageCache = useRef<Record<string, TourPage>>({});

  useEffect(() => {
    let cancelled = false;
    const cached = pageCache.current[lang];
    if (cached) {
      setData(cached);
      setStatus("ok");
      setTranslating(false);
      return;
    }
    // Only show the "translating" hint for non-English first loads; the very
    // first English load uses the normal full-page loading state.
    if (lang !== "en") setTranslating(true);
    (async () => {
      try {
        const res = await fetch(
          `/api/tours/public/${schoolId}/page?lang=${encodeURIComponent(lang)}`,
        );
        if (!res.ok) throw new Error("missing");
        const json = (await res.json()) as TourPage;
        // Defensive defaults so an older/partial API response can never crash
        // the render (the carousel + flyers section read these directly).
        json.flyers = Array.isArray(json.flyers) ? json.flyers : [];
        json.photos = Array.isArray(json.photos) ? json.photos : [];
        json.checkpoints = Array.isArray(json.checkpoints)
          ? json.checkpoints
          : [];
        json.textPlacement = json.textPlacement === "bottom" ? "bottom" : "top";
        pageCache.current[lang] = json;
        if (!cancelled) {
          setData(json);
          setStatus("ok");
        }
      } catch {
        if (!cancelled) setStatus("missing");
      } finally {
        if (!cancelled) setTranslating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [schoolId, lang]);

  const accent = useAccent(data?.accentColor);
  // Some mobile browsers won't render an embedded PDF inline (blank frame), so
  // on phones we swap the inline viewer for a tappable view/download card.
  const isMobile =
    typeof navigator !== "undefined" &&
    /Mobi|Android|iPhone|iPod/i.test(navigator.userAgent);

  if (status === "loading") {
    return (
      <div style={{ ...page, display: "grid", placeItems: "center" }}>
        <div style={{ color: "#64748b" }}>Loading…</div>
      </div>
    );
  }
  if (status === "missing" || !data) {
    return (
      <div style={{ ...page, display: "grid", placeItems: "center" }}>
        <div style={{ color: "#64748b" }}>{t.notFound}</div>
      </div>
    );
  }

  const introBlock = data.intro ? (
    <div style={card} key="intro">
      <p style={{ fontSize: 16, lineHeight: 1.6, margin: 0 }}>{data.intro}</p>
    </div>
  ) : null;

  const galleryBlock =
    data.photos.length > 0 ? (
      <PhotoCarousel key="gallery" photos={data.photos} accent={accent} />
    ) : null;

  const flyersBlock =
    data.flyers.length > 0 ? (
      <div style={{ ...card, marginTop: 20 }} key="flyers">
        <h2 style={{ fontSize: 20, margin: "0 0 14px", color: accent }}>
          {t.flyers}
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {data.flyers.map((f, i) => {
            const title = f.label || `${t.viewFlyer} ${i + 1}`;
            const baseName = (f.label || `flyer-${i + 1}`).replace(
              /[^\w.-]+/g,
              "_",
            );
            const downloadName =
              f.kind === "pdf" && !/\.pdf$/i.test(baseName)
                ? `${baseName}.pdf`
                : baseName;
            return (
              <div
                key={i}
                style={{
                  border: "1px solid #e2e8f0",
                  borderRadius: 12,
                  overflow: "hidden",
                  background: "#fff",
                }}
              >
                {/* Header: label + actions */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 12,
                    flexWrap: "wrap",
                    padding: "12px 16px",
                    borderBottom: "1px solid #f1f5f9",
                  }}
                >
                  <div
                    style={{ fontSize: 16, fontWeight: 700, color: "#1f2937" }}
                  >
                    {title}
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <a
                      href={f.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        textDecoration: "none",
                        fontSize: 14,
                        fontWeight: 600,
                        color: accent,
                        border: `1px solid ${accent}`,
                        borderRadius: 8,
                        padding: "7px 12px",
                      }}
                    >
                      ↗ {t.openFlyer}
                    </a>
                    <a
                      href={f.url}
                      download={downloadName}
                      style={{
                        textDecoration: "none",
                        fontSize: 14,
                        fontWeight: 700,
                        color: "#fff",
                        background: accent,
                        borderRadius: 8,
                        padding: "8px 14px",
                      }}
                    >
                      ⬇️ {t.downloadFlyer}
                    </a>
                  </div>
                </div>

                {/* Body: full inline document */}
                {f.kind === "image" ? (
                  <img
                    src={f.url}
                    alt={title}
                    style={{
                      width: "100%",
                      display: "block",
                      background: "#f1f5f9",
                    }}
                  />
                ) : isMobile ? (
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      textDecoration: "none",
                      display: "grid",
                      placeItems: "center",
                      gap: 10,
                      padding: "44px 16px",
                      background: "#fef2f2",
                      color: "#dc2626",
                    }}
                  >
                    <div style={{ fontSize: 30, fontWeight: 800 }}>PDF</div>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: "#7f1d1d",
                        textAlign: "center",
                      }}
                    >
                      {t.pdfMobileHint}
                    </div>
                  </a>
                ) : (
                  <iframe
                    src={f.url}
                    title={title}
                    style={{
                      width: "100%",
                      height: 680,
                      border: "none",
                      display: "block",
                      background: "#f8fafc",
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    ) : null;

  return (
    <div style={page}>
      {/* Hero */}
      <div
        style={{
          position: "relative",
          background: `linear-gradient(135deg, ${accent} 0%, #1e293b 140%)`,
          color: safeColor(data.headerTextColor, "#fff"),
          padding: "28px 20px 56px",
          overflow: "hidden",
        }}
      >
        {/* District corner watermark (faint, decorative) */}
        {data.district?.placements.watermark && data.district.logoUrl && (
          <img
            src={data.district.logoUrl}
            alt=""
            aria-hidden="true"
            style={{
              position: "absolute",
              top: 12,
              right: 12,
              width: 120,
              maxHeight: 120,
              objectFit: "contain",
              opacity: 0.12,
              pointerEvents: "none",
            }}
          />
        )}
        {/* District hero-top strip (logo + tagline above the school name) */}
        {data.district?.placements.heroTop &&
          (data.district.logoUrl || data.district.tagline) && (
            <div
              style={{
                position: "relative",
                maxWidth: 880,
                margin: "0 auto 16px",
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              {data.district.logoUrl && (
                <img
                  src={data.district.logoUrl}
                  alt="District logo"
                  style={{
                    height: 40,
                    maxWidth: 160,
                    objectFit: "contain",
                  }}
                />
              )}
              {data.district.tagline && (
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    opacity: 0.92,
                    color: safeColor(data.headerTextColor, "#fff"),
                  }}
                >
                  {data.district.tagline}
                </span>
              )}
            </div>
          )}
        <div
          style={{
            position: "relative",
            maxWidth: 880,
            margin: "0 auto",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div
            style={{
              fontWeight: 700,
              opacity: 0.9,
              color: safeColor(data.headerTextColor, "#fff"),
            }}
          >
            {data.schoolName}
          </div>
          <div
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            {translating && (
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  padding: "4px 10px",
                  borderRadius: 999,
                  background: "rgba(255,255,255,0.22)",
                  color: safeColor(data.headerTextColor, "#fff"),
                  whiteSpace: "nowrap",
                }}
              >
                {t.translating}
              </span>
            )}
            <LangToggle lang={lang} setLang={setLang} accent={accent} />
          </div>
        </div>
        <div style={{ maxWidth: 880, margin: "24px auto 0" }}>
          <h1
            style={{
              fontSize: 40,
              fontWeight: 800,
              margin: 0,
              lineHeight: 1.1,
              color: safeColor(data.headerTextColor, "#fff"),
            }}
          >
            {data.headline}
          </h1>
          {data.subheadline && (
            <p
              style={{
                fontSize: 19,
                opacity: 0.92,
                marginTop: 12,
                color: safeColor(data.headerTextColor, "#fff"),
              }}
            >
              {data.subheadline}
            </p>
          )}
          <button
            type="button"
            onClick={() => setShowForm(true)}
            style={{
              marginTop: 20,
              padding: "14px 28px",
              borderRadius: 12,
              border: "none",
              background: "#fff",
              color: accent,
              fontWeight: 700,
              fontSize: 17,
              cursor: "pointer",
              boxShadow: "0 6px 20px rgba(0,0,0,0.18)",
            }}
          >
            {data.ctaText || t.requestTour}
          </button>
        </div>
      </div>

      <div style={{ ...wrap, marginTop: -32 }}>
        {/* Flyers — pinned to the top of the content. */}
        {flyersBlock}

        {/* Intro at the top unless the school chose "bottom" placement, in
            which case it sits just above the photo gallery further down. */}
        {data.textPlacement !== "bottom" && introBlock}

        {data.sections.map((s, i) => (
          <div key={i} style={card}>
            <h2 style={{ fontSize: 20, margin: "0 0 8px", color: accent }}>
              {s.title}
            </h2>
            <p style={{ fontSize: 15, lineHeight: 1.6, margin: 0 }}>{s.body}</p>
          </div>
        ))}

        <div
          style={{
            marginTop: 20,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 16,
          }}
        >
          {([
            [t.programs, data.programs],
            [t.electives, data.electives],
            [t.proudOf, data.proudOf],
          ] as const)
            .filter(([, list]) => list.length > 0)
            .map(([title, list]) => (
              <div key={title} style={{ ...card, marginTop: 0 }}>
                <h3 style={{ fontSize: 16, margin: "0 0 10px", color: accent }}>
                  {title}
                </h3>
                <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
                  {list.map((item, i) => (
                    <li key={i} style={{ fontSize: 14 }}>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </div>

        {/* Intro just above the gallery when the school chose "bottom". */}
        {data.textPlacement === "bottom" && introBlock}

        {/* Photo gallery — pinned to the bottom of the content. */}
        {galleryBlock}

        <div style={{ textAlign: "center", marginTop: 28 }}>
          <button
            type="button"
            onClick={() => setShowForm(true)}
            style={{
              padding: "14px 32px",
              borderRadius: 12,
              border: "none",
              background: accent,
              color: "#fff",
              fontWeight: 700,
              fontSize: 17,
              cursor: "pointer",
            }}
          >
            {data.ctaText || t.requestTour}
          </button>
          {(data.contactPhone || data.contactEmail) && (
            <p style={{ marginTop: 14, color: "#64748b", fontSize: 14 }}>
              {t.contact}{" "}
              {data.contactPhone && <strong>{data.contactPhone}</strong>}
              {data.contactPhone && data.contactEmail && " · "}
              {data.contactEmail && <strong>{data.contactEmail}</strong>}
            </p>
          )}
        </div>
      </div>

      {/* District footer band */}
      {data.district?.placements.footer &&
        (data.district.logoUrl || data.district.tagline) && (
          <div
            style={{
              background: "#0f172a",
              color: "#fff",
              padding: "24px 20px",
            }}
          >
            <div
              style={{
                maxWidth: 880,
                margin: "0 auto",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 14,
                flexWrap: "wrap",
                textAlign: "center",
              }}
            >
              {data.district.logoUrl && (
                <img
                  src={data.district.logoUrl}
                  alt="District logo"
                  style={{ height: 44, maxWidth: 180, objectFit: "contain" }}
                />
              )}
              {data.district.tagline && (
                <span style={{ fontSize: 14, opacity: 0.9 }}>
                  {data.district.tagline}
                </span>
              )}
            </div>
          </div>
        )}

      {showForm && (
        <RequestForm
          schoolId={schoolId}
          lang={lang}
          setLang={setLang}
          accent={accent}
          source={source}
          schoolName={data.schoolName}
          checkpoints={data.checkpoints}
          onClose={() => setShowForm(false)}
        />
      )}
    </div>
  );
}

function RequestForm({
  schoolId,
  lang,
  setLang,
  accent,
  source,
  schoolName,
  checkpoints,
  onClose,
}: {
  schoolId: number;
  lang: Lang;
  setLang: (l: Lang) => void;
  accent: string;
  source: string;
  schoolName: string;
  checkpoints: { key: string; label: string; alwaysInclude?: boolean }[];
  onClose: () => void;
}) {
  const t = T[lang];
  const [familyName, setFamilyName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [children, setChildren] = useState<{ name: string; grade: string }[]>([
    { name: "", grade: "" },
  ]);
  const [interests, setInterests] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  // Split checkpoints: the school's "always include" stops are shown as a
  // read-only highlight list; the rest are the family's selectable picks.
  const selectableCheckpoints = checkpoints.filter((c) => !c.alwaysInclude);
  const alwaysIncludedCheckpoints = checkpoints.filter((c) => c.alwaysInclude);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  const submit = async () => {
    setErr("");
    const cleanChildren = children
      .map((c) => ({ name: c.name.trim(), grade: c.grade.trim() }))
      .filter((c) => c.name);
    if (!familyName.trim() || !phone.trim() || cleanChildren.length === 0) {
      setErr(t.required);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/tours/public/${schoolId}/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          familyName: familyName.trim(),
          phone: phone.trim(),
          email: email.trim() || undefined,
          children: cleanChildren,
          interests: interests.trim(),
          interestSelections: selected,
          source: source || undefined,
          preferredLanguage: lang,
        }),
      });
      if (!res.ok) throw new Error("failed");
      setDone(true);
    } catch {
      setErr(t.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.55)",
        display: "grid",
        placeItems: "center",
        padding: 16,
        zIndex: 1000,
        overflowY: "auto",
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 16,
          maxWidth: 560,
          width: "100%",
          maxHeight: "92vh",
          overflowY: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            background: accent,
            color: "#fff",
            padding: "18px 24px",
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <div style={{ fontSize: 13, opacity: 0.85 }}>{schoolName}</div>
            <div style={{ fontWeight: 700, fontSize: 19 }}>{t.requestTour}</div>
          </div>
          <LangToggle lang={lang} setLang={setLang} accent={accent} />
        </div>

        <div style={{ padding: 24 }}>
          {done ? (
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              <div style={{ fontSize: 44 }}>🎉</div>
              <h2 style={{ margin: "10px 0 8px", color: accent }}>
                {t.thanksTitle}
              </h2>
              <p style={{ color: "#475569", lineHeight: 1.6 }}>{t.thanksBody}</p>
              <button
                type="button"
                onClick={onClose}
                style={{
                  marginTop: 14,
                  padding: "11px 24px",
                  borderRadius: 10,
                  border: "none",
                  background: accent,
                  color: "#fff",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                ✕
              </button>
            </div>
          ) : (
            <>
              <p style={{ color: "#64748b", marginTop: 0, fontSize: 14 }}>
                {t.requestSub}
              </p>
              <div style={{ marginBottom: 14 }}>
                <label style={label}>{t.familyName}</label>
                <input
                  style={input}
                  value={familyName}
                  onChange={(e) => setFamilyName(e.target.value)}
                />
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 12,
                  marginBottom: 14,
                }}
              >
                <div>
                  <label style={label}>{t.phone}</label>
                  <input
                    style={input}
                    inputMode="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </div>
                <div>
                  <label style={label}>{t.email}</label>
                  <input
                    style={input}
                    inputMode="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
              </div>

              <label style={label}>{t.students}</label>
              {children.map((c, i) => (
                <div
                  key={i}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 120px auto",
                    gap: 8,
                    marginBottom: 8,
                  }}
                >
                  <input
                    style={input}
                    placeholder={t.studentName}
                    value={c.name}
                    onChange={(e) =>
                      setChildren((prev) =>
                        prev.map((x, j) =>
                          j === i ? { ...x, name: e.target.value } : x,
                        ),
                      )
                    }
                  />
                  <input
                    style={input}
                    placeholder={t.grade}
                    value={c.grade}
                    onChange={(e) =>
                      setChildren((prev) =>
                        prev.map((x, j) =>
                          j === i ? { ...x, grade: e.target.value } : x,
                        ),
                      )
                    }
                  />
                  {children.length > 1 ? (
                    <button
                      type="button"
                      onClick={() =>
                        setChildren((prev) => prev.filter((_, j) => j !== i))
                      }
                      style={{
                        border: "1px solid #cbd5e1",
                        background: "#fff",
                        borderRadius: 10,
                        cursor: "pointer",
                        padding: "0 12px",
                        color: "#64748b",
                      }}
                    >
                      ✕
                    </button>
                  ) : (
                    <span />
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setChildren((prev) => [...prev, { name: "", grade: "" }])
                }
                style={{
                  border: "none",
                  background: "none",
                  color: accent,
                  fontWeight: 600,
                  cursor: "pointer",
                  padding: 0,
                  marginBottom: 14,
                }}
              >
                {t.addStudent}
              </button>

              {selectableCheckpoints.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <label style={label}>{t.checkpointsHeading}</label>
                  <div
                    style={{
                      fontSize: 13,
                      color: "#64748b",
                      marginBottom: 8,
                    }}
                  >
                    {t.checkpointsHint}
                  </div>
                  <div style={{ display: "grid", gap: 8 }}>
                    {selectableCheckpoints.map((c) => {
                      const on = selected.includes(c.key);
                      return (
                        <label
                          key={c.key}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            padding: "10px 12px",
                            borderRadius: 10,
                            border: `1px solid ${on ? accent : "#e2e8f0"}`,
                            background: on ? `${accent}14` : "#fff",
                            cursor: "pointer",
                            fontSize: 15,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() =>
                              setSelected((prev) =>
                                prev.includes(c.key)
                                  ? prev.filter((k) => k !== c.key)
                                  : [...prev, c.key],
                              )
                            }
                            style={{ width: 18, height: 18, accentColor: accent }}
                          />
                          <span>{c.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {alwaysIncludedCheckpoints.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <label style={label}>{t.alwaysIncludedHeading}</label>
                  <div
                    style={{
                      fontSize: 13,
                      color: "#64748b",
                      marginBottom: 8,
                    }}
                  >
                    {t.alwaysIncludedHint}
                  </div>
                  <div style={{ display: "grid", gap: 8 }}>
                    {alwaysIncludedCheckpoints.map((c) => (
                      <div
                        key={c.key}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "10px 12px",
                          borderRadius: 10,
                          border: `1px solid ${accent}`,
                          background: `${accent}14`,
                          fontSize: 15,
                          color: "#0f172a",
                        }}
                      >
                        <span style={{ color: accent, fontWeight: 700 }}>★</span>
                        <span>{c.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ marginBottom: 16 }}>
                <label style={label}>{t.interests}</label>
                <textarea
                  style={{ ...input, minHeight: 80, resize: "vertical" }}
                  placeholder={t.interestsPh}
                  value={interests}
                  onChange={(e) => setInterests(e.target.value)}
                />
              </div>

              {err && (
                <div
                  style={{
                    background: "#fef2f2",
                    color: "#b91c1c",
                    padding: "10px 12px",
                    borderRadius: 10,
                    fontSize: 14,
                    marginBottom: 12,
                  }}
                >
                  {err}
                </div>
              )}

              <button
                type="button"
                onClick={submit}
                disabled={busy}
                style={{
                  width: "100%",
                  padding: "14px",
                  borderRadius: 12,
                  border: "none",
                  background: accent,
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: 16,
                  cursor: busy ? "default" : "pointer",
                  opacity: busy ? 0.7 : 1,
                }}
              >
                {busy ? t.submitting : t.submit}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Post-tour survey
// ---------------------------------------------------------------------------
type SurveyMeta = {
  schoolName: string;
  familyName: string;
  preferredLanguage: Lang;
  alreadySubmitted: boolean;
};

function SurveyPage({ token }: { token: string }) {
  const [lang, setLang] = useState<Lang>("en");
  const t = T[lang];
  const [meta, setMeta] = useState<SurveyMeta | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "missing">(
    "loading",
  );
  const [rating, setRating] = useState(0);
  const [liked, setLiked] = useState("");
  const [questions, setQuestions] = useState("");
  const [comments, setComments] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const accent = "#0ea5a4";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/tours/public/survey/${encodeURIComponent(token)}`,
        );
        if (!res.ok) throw new Error("missing");
        const json = (await res.json()) as SurveyMeta;
        if (!cancelled) {
          setMeta(json);
          setLang(json.preferredLanguage === "es" ? "es" : "en");
          setDone(json.alreadySubmitted);
          setStatus("ok");
        }
      } catch {
        if (!cancelled) setStatus("missing");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await fetch(
        `/api/tours/public/survey/${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rating: rating || undefined,
            liked: liked.trim(),
            questions: questions.trim(),
            comments: comments.trim(),
          }),
        },
      );
      if (!res.ok) throw new Error("failed");
      setDone(true);
    } catch {
      /* swallow — show generic */
    } finally {
      setBusy(false);
    }
  };

  if (status === "loading") {
    return (
      <div style={{ ...page, display: "grid", placeItems: "center" }}>
        <div style={{ color: "#64748b" }}>Loading…</div>
      </div>
    );
  }
  if (status === "missing" || !meta) {
    return (
      <div style={{ ...page, display: "grid", placeItems: "center" }}>
        <div style={{ color: "#64748b" }}>{t.notFound}</div>
      </div>
    );
  }

  return (
    <div style={page}>
      <div
        style={{
          background: `linear-gradient(135deg, ${accent} 0%, #1e293b 140%)`,
          color: "#fff",
          padding: "24px 20px",
        }}
      >
        <div
          style={{
            maxWidth: 620,
            margin: "0 auto",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={{ fontWeight: 700 }}>{meta.schoolName}</div>
          <LangToggle lang={lang} setLang={setLang} accent={accent} />
        </div>
      </div>
      <div style={{ maxWidth: 620, margin: "0 auto", padding: "0 20px 64px" }}>
        <div style={card}>
          {done ? (
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              <div style={{ fontSize: 44 }}>💚</div>
              <h2 style={{ margin: "10px 0 8px", color: accent }}>
                {meta.alreadySubmitted && !rating
                  ? t.surveyDone
                  : t.surveyThanks}
              </h2>
            </div>
          ) : (
            <>
              <h2 style={{ marginTop: 0, color: accent }}>{t.surveyTitle}</h2>
              <p style={{ color: "#64748b", marginTop: 0 }}>{t.surveySub}</p>

              <label style={label}>{t.rating}</label>
              <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setRating(n)}
                    style={{
                      fontSize: 30,
                      border: "none",
                      background: "none",
                      cursor: "pointer",
                      filter: n <= rating ? "none" : "grayscale(1) opacity(0.4)",
                    }}
                  >
                    ⭐
                  </button>
                ))}
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={label}>{t.liked}</label>
                <textarea
                  style={{ ...input, minHeight: 70, resize: "vertical" }}
                  value={liked}
                  onChange={(e) => setLiked(e.target.value)}
                />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={label}>{t.questions}</label>
                <textarea
                  style={{ ...input, minHeight: 70, resize: "vertical" }}
                  value={questions}
                  onChange={(e) => setQuestions(e.target.value)}
                />
              </div>
              <div style={{ marginBottom: 18 }}>
                <label style={label}>{t.comments}</label>
                <textarea
                  style={{ ...input, minHeight: 70, resize: "vertical" }}
                  value={comments}
                  onChange={(e) => setComments(e.target.value)}
                />
              </div>

              <button
                type="button"
                onClick={submit}
                disabled={busy}
                style={{
                  width: "100%",
                  padding: 14,
                  borderRadius: 12,
                  border: "none",
                  background: accent,
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: 16,
                  cursor: busy ? "default" : "pointer",
                  opacity: busy ? 0.7 : 1,
                }}
              >
                {busy ? t.submitting : t.surveySubmit}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function TourApp() {
  const path = window.location.pathname;
  // /tour/walk/<token> — guide-facing live tour capture (Phase 4)
  const walkMatch = path.match(/\/tour\/walk\/([^/]+)/);
  if (walkMatch) {
    return <TourWalk token={decodeURIComponent(walkMatch[1])} />;
  }
  // /tour/survey/<token>
  const surveyMatch = path.match(/\/tour\/survey\/([^/]+)/);
  if (surveyMatch) {
    return <SurveyPage token={decodeURIComponent(surveyMatch[1])} />;
  }
  // /tour/<schoolId>
  const pageMatch = path.match(/\/tour\/(\d+)/);
  if (pageMatch) {
    return <BragPage schoolId={Number(pageMatch[1])} />;
  }
  return (
    <div style={{ ...page, display: "grid", placeItems: "center" }}>
      <div style={{ color: "#64748b" }}>School tour link not found.</div>
    </div>
  );
}
