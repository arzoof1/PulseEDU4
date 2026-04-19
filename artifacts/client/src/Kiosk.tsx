import { useEffect, useState } from "react";

interface SchoolSettings {
  schoolName: string;
}

function getRoomFromUrl(): string {
  const params = new URLSearchParams(window.location.search);
  return (params.get("room") ?? "").trim();
}

export default function Kiosk() {
  const room = getRoomFromUrl();
  const [school, setSchool] = useState<SchoolSettings | null>(null);
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    fetch("/api/school-settings")
      .then((r) => r.json())
      .then((data: SchoolSettings) => setSchool(data))
      .catch(() => setSchool(null));
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!room) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0f172a",
          color: "#fff",
          fontFamily: "system-ui, sans-serif",
          padding: "2rem",
          textAlign: "center",
        }}
      >
        <div>
          <h1 style={{ fontSize: "2rem", marginBottom: "1rem" }}>
            Kiosk not configured
          </h1>
          <p style={{ opacity: 0.8 }}>
            This device's URL is missing a <code>?room=</code> parameter.
            <br />
            Example: <code>/kiosk?room=Room%20101</code>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(180deg, #0f172a 0%, #1e293b 100%)",
        color: "#fff",
        fontFamily: "system-ui, sans-serif",
        padding: "2rem",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: "0.875rem",
          letterSpacing: "0.15em",
          opacity: 0.6,
          textTransform: "uppercase",
          marginBottom: "0.5rem",
        }}
      >
        {school?.schoolName ?? "PulseED"} · Hall Pass Kiosk
      </div>
      <h1
        style={{
          fontSize: "clamp(2.5rem, 6vw, 4.5rem)",
          margin: "0.25rem 0 1rem",
          fontWeight: 700,
        }}
      >
        Welcome — {room}
      </h1>
      <div
        style={{
          fontSize: "1.25rem",
          opacity: 0.7,
          marginBottom: "2rem",
        }}
      >
        {now.toLocaleString([], {
          weekday: "long",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}
      </div>
      <div
        style={{
          background: "rgba(255,255,255,0.06)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 12,
          padding: "1.5rem 2rem",
          maxWidth: 480,
        }}
      >
        <p style={{ margin: 0, opacity: 0.85 }}>
          Pass-creation form coming soon. This device is configured for{" "}
          <strong>{room}</strong>.
        </p>
      </div>
    </div>
  );
}
