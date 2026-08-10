import { useEffect, useState } from "react";
import StudentPhoto from "./StudentPhoto";

// Shared "tap to enlarge" student photo: renders the normal StudentPhoto
// circle (photo or initials fallback) as a tap target; tapping opens a
// near-full-screen overlay with a big photo plus the student's name and
// grade; tapping anywhere on the overlay closes it. Used on the admin
// pullout queue, the Student Finder results, and the Teacher Roster so
// the behavior stays identical everywhere.
//
// The overlay is rendered inline (not a portal) with position:fixed and a
// z-index above every other app layer (highest known is 1100).

interface Props {
  firstName: string;
  lastName: string;
  grade?: number | string | null;
  photoObjectKey?: string | null;
  photoConsent?: boolean | null;
  /** Circle diameter of the small (in-page) photo. */
  size?: number;
  style?: React.CSSProperties;
}

export default function EnlargeableStudentPhoto({
  firstName,
  lastName,
  grade,
  photoObjectKey,
  photoConsent,
  size = 28,
  style,
}: Props) {
  const [open, setOpen] = useState(false);

  // Escape closes the overlay (keyboard parity with tap-anywhere).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      {/* span (not button) so this can live inside clickable rows that are
          themselves <button>s without producing invalid nested buttons. */}
      <span
        role="button"
        tabIndex={0}
        aria-label={`Enlarge photo of ${firstName} ${lastName}`.trim()}
        title="Tap to enlarge photo"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            e.preventDefault();
            setOpen(true);
          }
        }}
        style={{
          display: "inline-flex",
          cursor: "pointer",
          lineHeight: 0,
          flexShrink: 0,
          ...style,
        }}
      >
        <StudentPhoto
          firstName={firstName}
          lastName={lastName}
          photoObjectKey={photoObjectKey}
          photoConsent={photoConsent}
          size={size}
        />
      </span>
      {open && (
        <div
          onClick={(e) => {
            e.stopPropagation();
            setOpen(false);
          }}
          role="button"
          aria-label="Close photo"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1300,
            background: "rgba(0, 0, 0, 0.8)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "1rem",
            cursor: "pointer",
            padding: "1rem",
          }}
        >
          <StudentPhoto
            firstName={firstName}
            lastName={lastName}
            photoObjectKey={photoObjectKey}
            photoConsent={photoConsent}
            size={360}
            // CSS min() keeps the circle responsive if the phone rotates
            // while the overlay is open (style overrides the numeric size).
            style={{
              width: "min(360px, 80vmin)",
              height: "min(360px, 80vmin)",
            }}
          />
          <div style={{ textAlign: "center", color: "white" }}>
            <div style={{ fontSize: "1.4rem", fontWeight: 700 }}>
              {firstName} {lastName}
            </div>
            {grade != null && grade !== "" && (
              <div style={{ fontSize: "1.05rem", color: "#cbd5e1" }}>
                Grade {grade}
              </div>
            )}
            <div style={{ fontSize: "0.85rem", color: "#94a3b8", marginTop: 6 }}>
              Tap anywhere to close
            </div>
          </div>
        </div>
      )}
    </>
  );
}
