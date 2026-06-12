import { useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "../lib/authToken";
import StudentPhoto from "./StudentPhoto";
import {
  HowToUseHelp,
  HowToSection,
  RoleSection,
  howtoListStyle,
} from "./HowToUseHelp";

// ClassPhotoDayPage
// -----------------
// Settings tile: line up a class and snap student photos one at a time.
// Picks a teacher (core team) + period, loads the roster, then walks
// through students with a single live-camera viewport. Each capture is
// previewed before upload; on confirm we POST /api/students/:id/photo
// and auto-advance to the next student in the queue.
//
// Reuses the same upload pipe the per-student manager uses:
//   1) POST /api/storage/uploads/request-url
//   2) PUT  uploadURL  (file body)
//   3) POST /api/students/:studentId/photo  { objectPath }
//
// Uploaded-this-session state is tracked locally; refreshing the page
// will re-show students as "needs photo" until you reload the roster.

interface Teacher {
  id: number;
  displayName: string | null;
}

interface RosterStudent {
  studentId: string;
  localSisId?: string | null;
  firstName: string;
  lastName: string;
  gradeLevel: number | string | null;
}

interface RosterResponse {
  teacher: { id: number; displayName: string | null };
  availablePeriods: number[];
  selectedPeriod: number | null;
  students: RosterStudent[];
}

type RowStatus = "pending" | "done" | "skipped" | "failed";

const btn: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  padding: "0.4rem 0.75rem",
  fontSize: "0.85rem",
  cursor: "pointer",
  color: "#0f172a",
};
const btnPrimary: React.CSSProperties = {
  ...btn,
  background: "#0ea5e9",
  border: "1px solid #0284c7",
  color: "#fff",
  fontWeight: 600,
};
const btnDanger: React.CSSProperties = {
  ...btn,
  borderColor: "#fecaca",
  color: "#b91c1c",
};

interface Props {
  defaultTeacherId: number | null;
  isCoreTeam: boolean;
  onBack?: () => void;
}

export default function ClassPhotoDayPage({
  defaultTeacherId,
  isCoreTeam,
  onBack,
}: Props) {
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [teacherId, setTeacherId] = useState<number | null>(defaultTeacherId);
  const [period, setPeriod] = useState<number | null>(null);
  const [roster, setRoster] = useState<RosterResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Per-student status for the current roster. Keyed by studentId.
  const [status, setStatus] = useState<Record<string, RowStatus>>({});
  // Index into the filtered "needs photo" queue. We always render the
  // student at queue[cursor]; advancing skips already-done students.
  const [cursor, setCursor] = useState(0);

  // Camera state.
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ---------- Load teacher list ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await authFetch("/api/teacher-roster/teachers");
      if (!r.ok || cancelled) return;
      const j = (await r.json()) as { teachers: Teacher[] };
      if (cancelled) return;
      setTeachers(j.teachers);
      if (!teacherId && j.teachers.length > 0) {
        setTeacherId(defaultTeacherId ?? j.teachers[0].id);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Load roster on teacher/period change ----------
  useEffect(() => {
    if (!teacherId) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    (async () => {
      const params = new URLSearchParams();
      params.set("teacherId", String(teacherId));
      if (period != null) params.set("period", String(period));
      try {
        const r = await authFetch(`/api/teacher-roster?${params.toString()}`);
        if (!r.ok) throw new Error(`Could not load roster (${r.status})`);
        const j = (await r.json()) as RosterResponse;
        if (cancelled) return;
        setRoster(j);
        // Fresh roster → reset queue state.
        setStatus({});
        setCursor(0);
        // If period unset, snap to first available so the queue isn't
        // the whole-day union (which can repeat students across periods
        // — server already dedupes, but the period chip looks empty).
        if (period == null && j.availablePeriods.length > 0) {
          setPeriod(j.availablePeriods[0]);
        }
      } catch (e) {
        if (!cancelled)
          setErr(e instanceof Error ? e.message : "Failed to load roster");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teacherId, period]);

  // ---------- Camera lifecycle ----------
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        for (const t of streamRef.current.getTracks()) t.stop();
        streamRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!cameraOpen) return;
    if (previewBlob) return; // showing the still preview, not video
    let cancelled = false;
    setCameraReady(false);
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: 1280, height: 960 },
          audio: false,
        });
        if (cancelled) {
          for (const t of stream.getTracks()) t.stop();
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current;
        if (!v) {
          for (const t of stream.getTracks()) t.stop();
          streamRef.current = null;
          setErr("Camera UI didn't mount in time — try again.");
          return;
        }
        v.srcObject = stream;
        const onReady = () => {
          v.removeEventListener("loadedmetadata", onReady);
          v.removeEventListener("playing", onReady);
          if (!cancelled) setCameraReady(true);
        };
        v.addEventListener("loadedmetadata", onReady);
        v.addEventListener("playing", onReady);
        try {
          await v.play();
        } catch (playErr) {
          setErr(
            playErr instanceof Error
              ? `Camera couldn't start: ${playErr.message}`
              : "Camera couldn't start.",
          );
        }
      } catch (e) {
        if (cancelled) return;
        setErr(
          e instanceof Error
            ? `Camera unavailable: ${e.message}`
            : "Camera unavailable",
        );
        setCameraOpen(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cameraOpen, previewBlob]);

  // Object-URL housekeeping for the still preview.
  useEffect(() => {
    if (!previewBlob) {
      setPreviewUrl((u) => {
        if (u) URL.revokeObjectURL(u);
        return null;
      });
      return;
    }
    const url = URL.createObjectURL(previewBlob);
    setPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [previewBlob]);

  function closeCamera() {
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) t.stop();
      streamRef.current = null;
    }
    setCameraOpen(false);
    setCameraReady(false);
    setPreviewBlob(null);
  }

  // Square center-crop snap. Captures whatever the live video shows,
  // crops to the shorter edge, and outputs a 600×600 JPEG.
  function snap() {
    const v = videoRef.current;
    if (!v || !v.videoWidth || !v.videoHeight) return;
    const size = Math.min(v.videoWidth, v.videoHeight);
    const sx = (v.videoWidth - size) / 2;
    const sy = (v.videoHeight - size) / 2;
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 600;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, sx, sy, size, size, 0, 0, 600, 600);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        setPreviewBlob(blob);
        // Stop the camera stream while showing the preview so the LED
        // turns off — restarted on retake.
        if (streamRef.current) {
          for (const t of streamRef.current.getTracks()) t.stop();
          streamRef.current = null;
        }
      },
      "image/jpeg",
      0.9,
    );
  }

  // ---------- Queue derivation ----------
  // Queue = roster in order. `current` is the student at cursor IF that
  // student is still pending; once everyone is processed `current` is
  // null and the "class complete" banner takes over. Skipped students
  // stay in the queue (yellow chip) so you can jump back to them
  // manually from the roster strip.
  const queue = roster?.students ?? [];
  const remainingCount = useMemo(
    () => queue.filter((s) => (status[s.studentId] ?? "pending") === "pending")
      .length,
    [queue, status],
  );
  const current = useMemo(() => {
    if (queue.length === 0) return null;
    if (remainingCount === 0) return null;
    return queue[cursor] ?? null;
  }, [queue, cursor, remainingCount]);

  // advanceFrom: pure helper — takes the *current* status map and finds
  // the next pending index after `fromIdx`, wrapping once. Pulled out so
  // the post-upload path can pass the fresh status object directly,
  // avoiding the stale-closure bug where setTimeout(() => advance())
  // would read the pre-update status and re-land on the just-finished
  // student (especially visible in single-student or last-pending
  // rosters).
  function advanceFrom(fromIdx: number, st: Record<string, RowStatus>) {
    setPreviewBlob(null);
    const n = queue.length;
    if (n === 0) return;
    for (let step = 1; step <= n; step++) {
      const idx = (fromIdx + step) % n;
      const rowStatus = st[queue[idx].studentId] ?? "pending";
      if (rowStatus === "pending") {
        setCursor(idx);
        return;
      }
    }
    // Nothing pending anywhere — close the camera so the LED turns off.
    // `current` will compute to null on the next render and the
    // "class complete" banner takes over.
    closeCamera();
  }

  // ---------- Upload pipeline ----------
  async function uploadBlobForStudent(blob: Blob, studentId: string) {
    setUploading(true);
    setErr(null);
    try {
      const reqRes = await authFetch("/api/storage/uploads/request-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${studentId}.jpg`,
          size: blob.size,
          contentType: blob.type || "image/jpeg",
        }),
      });
      if (!reqRes.ok) throw new Error("Could not start upload");
      const { uploadURL, objectPath } = (await reqRes.json()) as {
        uploadURL: string;
        objectPath: string;
      };
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": blob.type || "image/jpeg" },
        body: blob,
      });
      if (!putRes.ok) throw new Error("Upload failed");
      const saveRes = await authFetch(
        `/api/students/${encodeURIComponent(studentId)}/photo`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ objectPath }),
        },
      );
      if (!saveRes.ok) {
        const j = (await saveRes.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(j.error ?? "Could not save photo");
      }
      // Build the fresh status map up-front and hand it to advanceFrom
      // so the cursor jumps to the *next* pending student — never back
      // to the one we just finished. (Reading `status` from the closure
      // here would still be stale.)
      const fresh: Record<string, RowStatus> = { ...status, [studentId]: "done" };
      setStatus(fresh);
      setPreviewBlob(null);
      // Use the current cursor as the search origin. We compute it from
      // the queue so a manual jump (clicking a chip) is respected.
      const fromIdx = queue.findIndex((s) => s.studentId === studentId);
      advanceFrom(fromIdx >= 0 ? fromIdx : cursor, fresh);
    } catch (e) {
      setStatus((p) => ({ ...p, [studentId]: "failed" }));
      setErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking same file
    if (!file || !current) return;
    await uploadBlobForStudent(file, current.studentId);
  }

  function handleConfirm() {
    if (!previewBlob || !current) return;
    void uploadBlobForStudent(previewBlob, current.studentId);
  }

  function handleRetake() {
    setPreviewBlob(null);
  }

  function handleSkip() {
    if (!current) return;
    // Mirror the upload path: build a fresh status map and advance
    // from it so a skipped student never lands as `current` again on
    // the next render.
    const fresh: Record<string, RowStatus> = {
      ...status,
      [current.studentId]: "skipped",
    };
    setStatus(fresh);
    advanceFrom(cursor, fresh);
  }

  // ---------- Render ----------
  const doneCount = useMemo(
    () => Object.values(status).filter((s) => s === "done").length,
    [status],
  );
  const skippedCount = useMemo(
    () => Object.values(status).filter((s) => s === "skipped").length,
    [status],
  );

  return (
    <div style={{ padding: "1rem", maxWidth: 1100, margin: "0 auto" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: "0.75rem",
        }}
      >
        <div>
          <div style={{ fontSize: "1.4rem", fontWeight: 700 }}>
            📸 Class Photo Day
          </div>
          <div style={{ color: "#64748b", fontSize: "0.85rem" }}>
            Line the class up — one tap per student. Photos save straight to
            each student's profile.
          </div>
        </div>
        {onBack && (
          <button type="button" style={btn} onClick={onBack}>
            ← Back to Settings
          </button>
        )}
      </div>
      <HowToUseHelp title="How to use Class Photo Day">
        <HowToSection title="What this page is">
          A fast capture flow for picture day — work through a class and take
          one photo per student, saved straight to each profile.
        </HowToSection>
        <HowToSection title="Day-to-day">
          <ul style={howtoListStyle}>
            <li>Pick the class, then tap a student to capture or retake.</li>
            <li>
              Saved photos appear on the student profile and anywhere avatars
              show (rosters, PBIS cards).
            </li>
          </ul>
        </HowToSection>
        <RoleSection for={["admin", "coreTeam"]} title="Good to know">
          Photos are stored school-private and staff-only. Use a retake any time
          a shot doesn't land.
        </RoleSection>
      </HowToUseHelp>

      {/* Picker row */}
      <div
        style={{
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          alignItems: "center",
          padding: "0.6rem 0.75rem",
          background: "#f8fafc",
          border: "1px solid #e2e8f0",
          borderRadius: 8,
          marginBottom: "0.75rem",
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: "0.85rem", color: "#475569" }}>Teacher</span>
          <select
            value={teacherId ?? ""}
            onChange={(e) => setTeacherId(Number(e.target.value) || null)}
            disabled={!isCoreTeam && teachers.length <= 1}
            style={{
              padding: "0.35rem 0.5rem",
              borderRadius: 6,
              border: "1px solid #cbd5e1",
              minWidth: 200,
            }}
          >
            {teachers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.displayName ?? `Teacher #${t.id}`}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: "0.85rem", color: "#475569" }}>Period</span>
          <select
            value={period ?? ""}
            onChange={(e) => setPeriod(Number(e.target.value) || null)}
            style={{
              padding: "0.35rem 0.5rem",
              borderRadius: 6,
              border: "1px solid #cbd5e1",
              minWidth: 100,
            }}
          >
            <option value="">All periods</option>
            {(roster?.availablePeriods ?? []).map((p) => (
              <option key={p} value={p}>
                Period {p}
              </option>
            ))}
          </select>
        </label>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: "0.85rem", color: "#475569" }}>
          {loading ? (
            "Loading…"
          ) : roster ? (
            <>
              <strong>{queue.length}</strong> students ·{" "}
              <span style={{ color: "#16a34a" }}>{doneCount} done</span> ·{" "}
              <span style={{ color: "#b45309" }}>
                {skippedCount} skipped
              </span>{" "}
              · <strong>{remainingCount}</strong> left
            </>
          ) : null}
        </div>
      </div>

      {err && (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#b91c1c",
            padding: "0.5rem 0.75rem",
            borderRadius: 6,
            marginBottom: "0.75rem",
            fontSize: "0.85rem",
          }}
        >
          {err}
        </div>
      )}

      {/* Main capture area */}
      {current ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) 280px",
            gap: 16,
            alignItems: "start",
          }}
        >
          {/* Left: live camera or preview */}
          <div
            style={{
              background: "#0f172a",
              borderRadius: 10,
              overflow: "hidden",
              aspectRatio: "1 / 1",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
            }}
          >
            {previewUrl ? (
              <img
                src={previewUrl}
                alt="Preview"
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }}
              />
            ) : cameraOpen ? (
              <>
                <video
                  ref={videoRef}
                  muted
                  playsInline
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    // Mirror like a selfie cam so subjects can self-align.
                    transform: "scaleX(-1)",
                  }}
                />
                {!cameraReady && (
                  <div
                    style={{
                      position: "absolute",
                      color: "#fff",
                      fontSize: "0.9rem",
                    }}
                  >
                    Starting camera…
                  </div>
                )}
              </>
            ) : (
              <div
                style={{
                  color: "#cbd5e1",
                  fontSize: "0.95rem",
                  textAlign: "center",
                  padding: "1rem",
                }}
              >
                <div style={{ fontSize: "3rem", marginBottom: 8 }}>📷</div>
                <div>
                  Click <strong>Start camera</strong> to begin, or upload a
                  file for the current student.
                </div>
              </div>
            )}
          </div>

          {/* Right: current student card + controls */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div
              style={{
                background: "#fff",
                border: "1px solid #e2e8f0",
                borderRadius: 10,
                padding: "0.75rem",
                textAlign: "center",
              }}
            >
              <div style={{ marginBottom: 6 }}>
                <StudentPhoto
                  firstName={current.firstName}
                  lastName={current.lastName}
                  photoObjectKey={null}
                  photoConsent={true}
                  size={72}
                />
              </div>
              <div style={{ fontSize: "1.1rem", fontWeight: 700 }}>
                {current.firstName} {current.lastName}
              </div>
              <div style={{ color: "#64748b", fontSize: "0.8rem" }}>
                ID {current.localSisId ?? "—"}
                {current.gradeLevel != null && ` · Grade ${current.gradeLevel}`}
              </div>
            </div>

            {/* Action buttons */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {previewBlob ? (
                <>
                  <button
                    type="button"
                    style={btnPrimary}
                    onClick={handleConfirm}
                    disabled={uploading}
                  >
                    {uploading ? "Saving…" : "✓ Use this photo"}
                  </button>
                  <button
                    type="button"
                    style={btn}
                    onClick={handleRetake}
                    disabled={uploading}
                  >
                    ↺ Retake
                  </button>
                </>
              ) : cameraOpen ? (
                <>
                  <button
                    type="button"
                    style={btnPrimary}
                    onClick={snap}
                    disabled={!cameraReady}
                  >
                    📸 Capture
                  </button>
                  <button type="button" style={btn} onClick={closeCamera}>
                    Stop camera
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  style={btnPrimary}
                  onClick={() => setCameraOpen(true)}
                >
                  Start camera
                </button>
              )}
              <button
                type="button"
                style={btn}
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                Upload file…
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                style={{ display: "none" }}
                onChange={handleFilePicked}
              />
              <button
                type="button"
                style={btnDanger}
                onClick={handleSkip}
                disabled={uploading}
              >
                Skip → next
              </button>
            </div>
          </div>
        </div>
      ) : roster && queue.length === 0 ? (
        <div
          style={{
            padding: "2rem",
            textAlign: "center",
            color: "#64748b",
            background: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: 8,
          }}
        >
          No students on this roster.
        </div>
      ) : roster ? (
        <div
          style={{
            padding: "2rem",
            textAlign: "center",
            color: "#16a34a",
            background: "#f0fdf4",
            border: "1px solid #bbf7d0",
            borderRadius: 8,
            fontWeight: 600,
          }}
        >
          🎉 Class complete — every student has been processed.
        </div>
      ) : null}

      {/* Roster strip — click any student to jump to them */}
      {roster && queue.length > 0 && (
        <div style={{ marginTop: "1rem" }}>
          <div
            style={{
              fontSize: "0.8rem",
              color: "#475569",
              marginBottom: 6,
              fontWeight: 600,
            }}
          >
            Line up
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
            }}
          >
            {queue.map((s, idx) => {
              const st = status[s.studentId] ?? "pending";
              const isCurrent = idx === cursor;
              const bg =
                st === "done"
                  ? "#dcfce7"
                  : st === "skipped"
                    ? "#fef3c7"
                    : st === "failed"
                      ? "#fee2e2"
                      : isCurrent
                        ? "#e0f2fe"
                        : "#fff";
              const border =
                st === "done"
                  ? "#86efac"
                  : st === "skipped"
                    ? "#fcd34d"
                    : st === "failed"
                      ? "#fca5a5"
                      : isCurrent
                        ? "#0ea5e9"
                        : "#e2e8f0";
              return (
                <button
                  key={s.studentId}
                  type="button"
                  onClick={() => {
                    setPreviewBlob(null);
                    setCursor(idx);
                  }}
                  title={`${s.firstName} ${s.lastName} — ${st}`}
                  style={{
                    background: bg,
                    border: `1px solid ${border}`,
                    borderRadius: 6,
                    padding: "0.3rem 0.55rem",
                    fontSize: "0.78rem",
                    cursor: "pointer",
                    fontWeight: isCurrent ? 700 : 500,
                    color: "#0f172a",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  {st === "done" && "✓ "}
                  {st === "skipped" && "↷ "}
                  {st === "failed" && "✗ "}
                  {s.lastName}, {s.firstName.charAt(0)}.
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
