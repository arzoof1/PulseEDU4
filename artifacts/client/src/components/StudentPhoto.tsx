import { useState } from "react";

interface Props {
  firstName: string;
  lastName: string;
  photoObjectKey?: string | null;
  photoConsent?: boolean | null;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

// Deterministic palette so the same student always gets the same bubble
// color across surfaces (teacher roster, walker gate, spider view) — a
// teacher who learned "Rachel = teal" by sight at 8am can spot her again
// in the pickup line at 3pm without reading the name.
const BUBBLE_PALETTE = [
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
  "#6366f1",
  "#84cc16",
];

function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return BUBBLE_PALETTE[h % BUBBLE_PALETTE.length]!;
}

function initialsOf(firstName: string, lastName: string): string {
  const fi = (firstName ?? "").trim().charAt(0).toUpperCase();
  const li = (lastName ?? "").trim().charAt(0).toUpperCase();
  return `${fi}${li}` || "?";
}

// Reusable student avatar. Renders the on-file photo when (a) bytes are
// present and (b) the school's photo_consent flag is true. Otherwise
// falls back to a colored initials bubble — no broken-image icons.
//
// Photos are served via the existing /api/storage/objects/* route which
// is school-scoped and auth-gated, so this component is safe to drop
// into any staff surface without re-implementing ACL.
export default function StudentPhoto({
  firstName,
  lastName,
  photoObjectKey,
  photoConsent,
  size = 32,
  className,
  style,
}: Props) {
  const [imgFailed, setImgFailed] = useState(false);
  const initials = initialsOf(firstName, lastName);
  // Fail-closed on consent: only render the photo when consent is
  // explicitly true. If a caller forgets to pass photoConsent (or the
  // server omits it from a future surface), we fall back to initials
  // rather than silently leaking a face. Every integrated surface in
  // this codebase explicitly passes the field; new surfaces must too.
  const showPhoto =
    Boolean(photoObjectKey) && photoConsent === true && !imgFailed;
  const baseStyle: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    ...style,
  };
  if (showPhoto) {
    return (
      <img
        src={`/api/storage${photoObjectKey}`}
        alt={`${firstName} ${lastName}`.trim()}
        width={size}
        height={size}
        onError={() => setImgFailed(true)}
        className={className}
        style={{ ...baseStyle, objectFit: "cover", background: "#f3f4f6" }}
      />
    );
  }
  const bg = colorFor(`${firstName}${lastName}`);
  return (
    <div
      aria-label={`${firstName} ${lastName}`.trim()}
      className={className}
      style={{
        ...baseStyle,
        background: bg,
        color: "white",
        fontWeight: 700,
        fontSize: Math.max(10, Math.round(size * 0.4)),
        letterSpacing: 0.5,
        lineHeight: 1,
      }}
    >
      {initials}
    </div>
  );
}
