import { useEffect, useMemo, useState } from "react";

interface SchoolSettings {
  schoolName: string;
}

interface LocationRow {
  id: number;
  name: string;
  isOrigin: boolean;
  isDestination: boolean;
  studentVisible: boolean;
  active: boolean;
}

interface AllowedRow {
  id: number;
  originLocationId: number;
  destinationLocationId: number;
}

function getRoomFromUrl(): string {
  const params = new URLSearchParams(window.location.search);
  return (params.get("room") ?? "").trim();
}

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; studentId: string; destination: string }
  | { kind: "error"; message: string };

export default function Kiosk() {
  const room = getRoomFromUrl();
  const [school, setSchool] = useState<SchoolSettings | null>(null);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [allowed, setAllowed] = useState<AllowedRow[]>([]);
  const [now, setNow] = useState(new Date());
  const [studentId, setStudentId] = useState("");
  const [destination, setDestination] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  useEffect(() => {
    fetch("/api/school-settings")
      .then((r) => r.json())
      .then((d: SchoolSettings) => setSchool(d))
      .catch(() => setSchool(null));
    fetch("/api/locations")
      .then((r) => r.json())
      .then((d: LocationRow[]) => setLocations(d))
      .catch(() => setLocations([]));
    fetch("/api/location-allowed-destinations")
      .then((r) => r.json())
      .then((d: AllowedRow[]) => setAllowed(d))
      .catch(() => setAllowed([]));
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const originLocation = useMemo(
    () => locations.find((l) => l.name === room) ?? null,
    [locations, room],
  );

  const destinationOptions = useMemo(() => {
    if (!originLocation) return [];
    const allowedDestIds = new Set(
      allowed
        .filter((a) => a.originLocationId === originLocation.id)
        .map((a) => a.destinationLocationId),
    );
    return locations
      .filter(
        (l) =>
          l.active &&
          l.studentVisible &&
          l.isDestination &&
          allowedDestIds.has(l.id),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [locations, allowed, originLocation]);

  function resetForm() {
    setStudentId("");
    setDestination("");
    setStatus({ kind: "idle" });
  }

  useEffect(() => {
    if (status.kind !== "success") return;
    const id = setTimeout(resetForm, 8000);
    return () => clearTimeout(id);
  }, [status.kind]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!studentId.trim() || !destination) return;
    setStatus({ kind: "submitting" });
    try {
      const res = await fetch("/api/kiosk/hall-passes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: studentId.trim(),
          originRoom: room,
          destination,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setStatus({
          kind: "error",
          message: body.error ?? `Request failed (${res.status})`,
        });
        return;
      }
      setStatus({
        kind: "success",
        studentId: studentId.trim(),
        destination,
      });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    }
  }

  if (!room) {
    return (
      <Shell>
        <h1 style={{ fontSize: "2rem", marginBottom: "1rem" }}>
          Kiosk not configured
        </h1>
        <p style={{ opacity: 0.8 }}>
          This device's URL is missing a <code>?room=</code> parameter.
          <br />
          Example: <code>/kiosk?room=Room%20101</code>
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
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
          fontSize: "clamp(2rem, 5vw, 3.5rem)",
          margin: "0.25rem 0 0.5rem",
          fontWeight: 700,
        }}
      >
        {room}
      </h1>
      <div style={{ fontSize: "1rem", opacity: 0.7, marginBottom: "2rem" }}>
        {now.toLocaleString([], {
          weekday: "long",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}
      </div>

      {status.kind === "success" ? (
        <SuccessCard
          studentId={status.studentId}
          destination={status.destination}
          onReset={resetForm}
        />
      ) : (
        <form
          onSubmit={handleSubmit}
          style={{
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 12,
            padding: "1.5rem",
            width: "min(480px, 92vw)",
            display: "flex",
            flexDirection: "column",
            gap: "1rem",
          }}
        >
          <Field label="Student ID">
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              autoFocus
              value={studentId}
              onChange={(e) => setStudentId(e.target.value)}
              placeholder="e.g. 12345"
              style={inputStyle}
              disabled={status.kind === "submitting"}
            />
          </Field>

          <Field label="Where are you going?">
            <select
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              style={inputStyle}
              disabled={status.kind === "submitting"}
            >
              <option value="">Select a destination…</option>
              {destinationOptions.map((d) => (
                <option key={d.id} value={d.name}>
                  {d.name}
                </option>
              ))}
            </select>
            {originLocation && destinationOptions.length === 0 && (
              <div style={{ fontSize: "0.85rem", opacity: 0.7, marginTop: 6 }}>
                No student-visible destinations are configured for this room.
              </div>
            )}
            {!originLocation && (
              <div style={{ fontSize: "0.85rem", color: "#fca5a5", marginTop: 6 }}>
                "{room}" is not a known location. Check the kiosk URL.
              </div>
            )}
          </Field>

          {status.kind === "error" && (
            <div
              style={{
                background: "rgba(239,68,68,0.15)",
                border: "1px solid rgba(239,68,68,0.4)",
                color: "#fecaca",
                padding: "0.75rem 1rem",
                borderRadius: 8,
                fontSize: "0.95rem",
              }}
            >
              {status.message}
            </div>
          )}

          <button
            type="submit"
            disabled={
              status.kind === "submitting" ||
              !studentId.trim() ||
              !destination
            }
            style={{
              background:
                status.kind === "submitting" ||
                !studentId.trim() ||
                !destination
                  ? "rgba(59,130,246,0.4)"
                  : "#3b82f6",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "0.9rem 1rem",
              fontSize: "1.1rem",
              fontWeight: 600,
              cursor:
                status.kind === "submitting" ||
                !studentId.trim() ||
                !destination
                  ? "not-allowed"
                  : "pointer",
            }}
          >
            {status.kind === "submitting" ? "Creating pass…" : "Get Pass"}
          </button>
        </form>
      )}
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
        background: "linear-gradient(180deg, #0f172a 0%, #1e293b 100%)",
        color: "#fff",
        fontFamily: "system-ui, sans-serif",
        padding: "2rem",
        textAlign: "center",
      }}
    >
      {children}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, textAlign: "left" }}>
      <span style={{ fontSize: "0.85rem", opacity: 0.8, fontWeight: 500 }}>
        {label}
      </span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  background: "rgba(15,23,42,0.6)",
  border: "1px solid rgba(255,255,255,0.2)",
  color: "#fff",
  borderRadius: 8,
  padding: "0.75rem 0.9rem",
  fontSize: "1.05rem",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

function SuccessCard({
  studentId,
  destination,
  onReset,
}: {
  studentId: string;
  destination: string;
  onReset: () => void;
}) {
  return (
    <div
      style={{
        background: "rgba(34,197,94,0.12)",
        border: "1px solid rgba(34,197,94,0.5)",
        borderRadius: 12,
        padding: "2rem",
        width: "min(480px, 92vw)",
      }}
    >
      <div style={{ fontSize: "3rem", marginBottom: "0.5rem" }}>✓</div>
      <div style={{ fontSize: "1.5rem", fontWeight: 600, marginBottom: "0.5rem" }}>
        Pass created
      </div>
      <div style={{ opacity: 0.85, marginBottom: "1.5rem" }}>
        Student <strong>{studentId}</strong> → <strong>{destination}</strong>
      </div>
      <div style={{ fontSize: "0.85rem", opacity: 0.55, marginBottom: "1rem" }}>
        Resetting in a few seconds…
      </div>
      <button
        type="button"
        onClick={onReset}
        style={{
          background: "rgba(255,255,255,0.12)",
          color: "#fff",
          border: "1px solid rgba(255,255,255,0.2)",
          borderRadius: 8,
          padding: "0.75rem 1.5rem",
          fontSize: "1rem",
          cursor: "pointer",
        }}
      >
        Done
      </button>
    </div>
  );
}
