import { useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";

interface Props {
  firstName: string;
  lastName: string;
  photoObjectKey?: string | null;
  photoConsent?: boolean | null;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

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

// Cache resolved blob URLs across the page so the same student photo
// only triggers one network round-trip per session even if it's
// rendered in many surfaces (roster, finder, profile, etc.). Keyed by
// objectKey because that's globally unique per photo.
const photoUrlCache = new Map<string, string>();
const photoFetchInFlight = new Map<string, Promise<string | null>>();

async function fetchPhotoUrl(objectKey: string): Promise<string | null> {
  const cached = photoUrlCache.get(objectKey);
  if (cached) return cached;
  const inflight = photoFetchInFlight.get(objectKey);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      // The storage GET requires a Bearer token from sessionStorage.
      // A plain <img src> only sends cookies, so we must fetch via
      // authFetch and turn the bytes into a blob URL the <img> can
      // load without credentials.
      const r = await authFetch(`/api/storage${objectKey}`);
      if (!r.ok) return null;
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      photoUrlCache.set(objectKey, url);
      return url;
    } catch {
      return null;
    } finally {
      photoFetchInFlight.delete(objectKey);
    }
  })();
  photoFetchInFlight.set(objectKey, p);
  return p;
}

// Reusable student avatar. Renders the on-file photo when (a) bytes are
// present and (b) the school's photo_consent flag is true. Otherwise
// falls back to a colored initials bubble — no broken-image icons.
//
// Photos are served via the auth-gated /api/storage/objects/* route
// which requires a Bearer token; we resolve the bytes via authFetch
// into a blob URL so the <img> tag can render them.
export default function StudentPhoto({
  firstName,
  lastName,
  photoObjectKey,
  photoConsent,
  size = 32,
  className,
  style,
}: Props) {
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setImgFailed(false);
    setResolvedUrl(null);
    if (!photoObjectKey || photoConsent !== true) return;
    let cancelled = false;
    void fetchPhotoUrl(photoObjectKey).then((url) => {
      if (cancelled) return;
      if (!url) {
        setImgFailed(true);
        return;
      }
      setResolvedUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [photoObjectKey, photoConsent]);

  const initials = initialsOf(firstName, lastName);
  const showPhoto =
    Boolean(photoObjectKey) &&
    photoConsent === true &&
    !imgFailed &&
    !!resolvedUrl;
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
  if (showPhoto && resolvedUrl) {
    return (
      <img
        src={resolvedUrl}
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
