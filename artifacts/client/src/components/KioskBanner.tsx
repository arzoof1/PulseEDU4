import { useEffect, useState } from "react";

// Mirrors the key Kiosk.tsx uses so we can detect "this device is also
// running a kiosk" from inside the staff app.
const TOKEN_KEY = "pulseed.kiosk.token";

interface ActivationInfo {
  room: string;
  staffName: string | null;
  expiresAt: string | null;
}

// Banner that appears at the top of the staff app whenever this device's
// localStorage carries a still-valid kiosk activation token. Solves the
// "I forgot which tab the kiosk was in" problem by giving teachers a
// one-click way back. Self-hides if the token is gone, expired, or
// revoked — no other UI needs to coordinate with it.
export function KioskBanner() {
  const [info, setInfo] = useState<ActivationInfo | null>(null);
  const [token, setToken] = useState<string | null>(null);

  async function check() {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(TOKEN_KEY);
    } catch {
      // Storage disabled — nothing to surface.
    }
    if (!stored) {
      setInfo(null);
      setToken(null);
      return;
    }
    try {
      const res = await fetch(
        `/api/kiosk/activation/${encodeURIComponent(stored)}`,
      );
      if (!res.ok) {
        // Stale / revoked token — drop it so we don't keep nagging.
        try {
          localStorage.removeItem(TOKEN_KEY);
        } catch {
          // ignore
        }
        setInfo(null);
        setToken(null);
        return;
      }
      const data = (await res.json()) as ActivationInfo;
      setInfo(data);
      setToken(stored);
    } catch {
      // Network blip — leave whatever we last had on screen and try again.
    }
  }

  useEffect(() => {
    check();
    // Re-check every 60s so an admin remotely deactivating a kiosk causes
    // the banner to disappear within a minute.
    const id = setInterval(check, 60_000);
    // Other tabs (the kiosk itself) may write/clear the token; pick that
    // up immediately.
    const onStorage = (e: StorageEvent) => {
      if (e.key === TOKEN_KEY) check();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      clearInterval(id);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  if (!info || !token) return null;

  return (
    <div
      className="no-print"
      role="status"
      style={{
        background: "linear-gradient(90deg, #1e3a8a, #3b82f6)",
        color: "#fff",
        padding: "0.5rem 1rem",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "0.75rem",
        flexWrap: "wrap",
        fontSize: "0.9rem",
        boxShadow: "0 1px 0 rgba(0,0,0,0.1)",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span aria-hidden style={{ fontSize: "1rem" }}>
          🖥️
        </span>
        Kiosk Mode is active on this device for{" "}
        <strong>{info.room}</strong>
        {info.staffName ? ` · ${info.staffName}` : ""}
      </span>
      <a
        href={`${import.meta.env.BASE_URL}kiosk`}
        target="_blank"
        rel="noreferrer"
        style={{
          background: "rgba(255,255,255,0.18)",
          color: "#fff",
          padding: "0.3rem 0.75rem",
          borderRadius: 6,
          fontWeight: 600,
          textDecoration: "none",
        }}
      >
        Return to kiosk →
      </a>
    </div>
  );
}
