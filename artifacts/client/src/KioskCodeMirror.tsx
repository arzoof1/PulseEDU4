import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { code128DataUrl } from "./lib/barcode";

// Phone "carry over" mirror for a teacher's kiosk activation code.
//
// Flow: the staff app shows a QR that points HERE (/kiosk-code#t=<token>&p=<pin>).
// The teacher scans it with their phone, which opens this page. This page
// then displays the REAL activation QR (encoding the kiosk ?enroll= URL) plus
// the 6-digit code, so the teacher can walk to the classroom kiosk and hold
// the phone up to the kiosk camera to activate the room.
//
// Nothing here activates anything or talks to the server — it is a pure,
// client-side render of credentials passed in the URL hash fragment (the
// fragment is never sent to the server, kept out of access logs/Referer).
// The route is /kiosk-code; main.tsx dispatches here before /kiosk so the
// full activation flow does not steal the path.

function parseHash(): { token: string | null; pin: string | null } {
  // Hash looks like #t=<token>&p=<pin>. Tolerate a leading "#".
  const raw = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(raw);
  const token = params.get("t");
  const pin = params.get("p");
  return {
    token: token && token.length >= 16 ? token : null,
    pin: pin && /^\d{4,8}$/.test(pin) ? pin : null,
  };
}

export default function KioskCodeMirror() {
  const [{ token, pin }, setParsed] = useState(parseHash);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [barcodeDataUrl, setBarcodeDataUrl] = useState<string | null>(null);
  const [renderError, setRenderError] = useState(false);

  // Re-parse if the hash changes (e.g. teacher re-scans a fresh code on the
  // same already-open tab).
  useEffect(() => {
    const onHash = () => setParsed(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setQrDataUrl(null);
      setBarcodeDataUrl(null);
      return;
    }
    const enrollUrl = `${window.location.origin}${import.meta.env.BASE_URL}kiosk?enroll=${encodeURIComponent(token)}`;
    QRCode.toDataURL(enrollUrl, { width: 320, margin: 1 })
      .then((url) => {
        if (cancelled) return;
        setQrDataUrl(url);
        setBarcodeDataUrl(code128DataUrl(token));
        setRenderError(false);
      })
      .catch(() => {
        if (!cancelled) setRenderError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!token) {
    return (
      <Shell>
        <div style={{ fontSize: "1.3rem", fontWeight: 700 }}>
          No code to show
        </div>
        <div style={{ opacity: 0.7, marginTop: 10, maxWidth: 320 }}>
          This page opens when you scan your kiosk code from the staff app.
          Generate a new code there, then scan it with your phone.
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div
        style={{
          width: "100%",
          maxWidth: 380,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 18,
          textAlign: "center",
        }}
      >
        <div>
          <div style={{ fontSize: "1.35rem", fontWeight: 800 }}>
            Your kiosk code
          </div>
          <div style={{ opacity: 0.75, marginTop: 6, fontSize: "0.95rem" }}>
            Hold this screen up to the kiosk camera to activate your room.
          </div>
        </div>

        {renderError ? (
          <div style={{ opacity: 0.8 }}>
            Couldn&apos;t draw the code. Go back to the staff app and generate a
            new one.
          </div>
        ) : qrDataUrl ? (
          <img
            src={qrDataUrl}
            alt="Kiosk activation QR code"
            width={300}
            height={300}
            style={{
              width: 300,
              height: 300,
              background: "#fff",
              borderRadius: 16,
              padding: 12,
              boxSizing: "border-box",
            }}
          />
        ) : (
          <div style={{ opacity: 0.6, padding: "4rem 0" }}>Loading…</div>
        )}

        {pin && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span
              style={{
                fontSize: "0.7rem",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                opacity: 0.6,
              }}
            >
              6-digit code
            </span>
            <span
              style={{
                fontSize: "2.6rem",
                fontWeight: 800,
                letterSpacing: "0.18em",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {pin.slice(0, 3)} {pin.slice(3)}
            </span>
            <span style={{ fontSize: "0.8rem", opacity: 0.6 }}>
              Or type this on the kiosk screen.
            </span>
          </div>
        )}

        {barcodeDataUrl && (
          <img
            src={barcodeDataUrl}
            alt="Kiosk activation barcode"
            style={{
              width: "100%",
              maxWidth: 320,
              height: "auto",
              background: "#fff",
              borderRadius: 10,
              padding: 8,
              boxSizing: "border-box",
            }}
          />
        )}

        <div style={{ fontSize: "0.72rem", opacity: 0.5, maxWidth: 320 }}>
          Keep this code private. It stops working once you generate a new one
          in the staff app.
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--brand-header-bg, #0f172a)",
        color: "#fff",
        fontFamily: "system-ui, sans-serif",
        padding: "2rem 1rem",
      }}
    >
      {children}
    </div>
  );
}
