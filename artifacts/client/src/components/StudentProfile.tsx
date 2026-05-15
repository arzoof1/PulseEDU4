// Student Profile — eduCLIMBER-style whole-child page. Header (name,
// grade, demographics, MTSS tier), 5 pillar cards (academics, behavior,
// flow, supports, family), and a risk callout rail.
//
// Backed by GET /api/insights/students/:studentId/profile. The server
// enforces visibility (roster ∪ trusted-adult ∪ core team) and returns
// 403 if the caller can't see this student. We surface that gracefully.

import { useEffect, useRef, useState } from "react";
import StudentPhoto from "./StudentPhoto";
import { HowToUseHelp, HowToSection, RoleSection, howtoListStyle } from "./HowToUseHelp";
import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
} from "recharts";
import { authFetch } from "../lib/authToken";

type WindowKey = "3" | "7" | "15" | "30" | "custom";

interface ProfilePayload {
  header: {
    studentId: string;
    firstName: string;
    lastName: string;
    grade: number;
    gender: string | null;
    flags: {
      ell: boolean;
      ese: boolean;
      is504: boolean;
      ctEla: boolean;
      ctMath: boolean;
    };
    mtssTier: number;
    activeMtssPlanCount: number;
    visibilityPath: "core" | "roster" | "trusted_adult";
    // Grades the student was retained in (ascending). Empty when none.
    // Drives the "Retained: Grade N" Chip in the header and the
    // mark/unmark control in the demographics editor.
    retainedGrades: number[];
  };
  window: { from: string; to: string; label: string; days: number | null };
  pillars: {
    academics: {
      fastScores: Array<{
        subject: string;
        pm1: number | null;
        pm2: number | null;
        pm3: number | null;
        priorYearScore: number | null;
        priorYearBq: boolean;
      }>;
      ireadyScores: Array<{
        subject: "Reading" | "Math";
        ap1: number | null;
        ap2: number | null;
        ap3: number | null;
        ap1Level: string | null;
        ap2Level: string | null;
        ap3Level: string | null;
      }>;
      sciScores: {
        b1: number | null;
        b2: number | null;
        b3: number | null;
        b1Level: string | null;
        b2Level: string | null;
        b3Level: string | null;
      } | null;
      assessments: Array<{
        name: string;
        score: number | null;
        scoreLevel: string | null;
        administeredAt: string;
        source: string | null;
      }>;
    };
    behavior: {
      pbisPositiveCount: number;
      pbisNegativeCount: number;
      supportNoteCount: number;
      // Distinct-teacher count of active separation flags involving this
      // student in the current school year. Only displayed when >= 2 —
      // a single teacher's flag stays private to their own seating
      // workflow. No teacher names or paired-student details are
      // surfaced here on purpose.
      separationFlagTeacherCount?: number;
      recentSupportNotes: Array<{
        noteType: string;
        noteText: string;
        staffName: string;
        createdAt: string;
      }>;
      recentPbis: Array<{
        polarity: string;
        reason: string;
        staffName: string;
        createdAt: string;
        points: number;
      }>;
    };
    flow: {
      tardyCount: number;
      recentTardies: Array<{
        period: string;
        reason: string;
        createdAt: string;
      }>;
      issDayCount: number;
      recentIssDays: Array<{ day: string; source: string; notes: string | null }>;
      hallPassCount: number;
      hallPassSchoolAvg: number;
      recentPullouts: Array<{
        requestedAt: string;
        reason: string;
        status: string;
        referringTeacherName: string;
      }>;
    };
    supports: {
      activeAccommodationCount: number;
      accommodations: Array<{ id: number; label: string | null; assignedAt: string }>;
      recentInterventions: Array<{
        interventionType: string;
        note: string | null;
        staffName: string;
        createdAt: string;
      }>;
      activeMtssPlans: Array<{
        id: number;
        title: string;
        tier: number;
        openedAt: string;
        goals: string;
      }>;
      trustedAdults: Array<{ id: number; staffId: number; staffName: string | null }>;
    };
    family: {
      parentName: string | null;
      parentEmail: string | null;
      parentPhone: string | null;
      linkedParentAccountCount: number;
    };
  };
  riskFlags: Array<{
    code: string;
    severity: "info" | "watch" | "high";
    label: string;
  }>;
  radar: {
    axes: Array<{
      key: "academics" | "behavior" | "flow" | "supports" | "family";
      label: string;
      score: number;
      rationale: string;
      hasData: boolean;
      isResourceAxis?: boolean;
    }>;
  };
  trends: {
    pbisDaily: Array<{
      day: string;
      positive: number;
      negative: number;
      net: number;
    }>;
    tardiesDaily: Array<{ day: string; count: number }>;
    // UTC YYYY-MM-DD day-keys (within window) on which an intervention
    // was logged. Rendered as vertical markers on the PBIS sparkline so
    // the eye can correlate trend shifts with intervention activity.
    interventionDays: string[];
  };
  // Per-active-plan progress signals — see insights.ts MTSS progress block.
  // planId joins back to pillars.supports.activeMtssPlans[i].id.
  mtssProgress: Array<{
    planId: number;
    daysActive: number;
    interventionCount: number;
    pbisPositiveSinceOpen: number;
    pbisNegativeSinceOpen: number;
    pbisNetSinceOpen: number;
  }>;
}

const SEVERITY_STYLES: Record<
  "info" | "watch" | "high",
  { background: string; color: string; border: string }
> = {
  high: { background: "#fee2e2", color: "#991b1b", border: "#fca5a5" },
  watch: { background: "#fef3c7", color: "#92400e", border: "#fcd34d" },
  info: { background: "#e0e7ff", color: "#3730a3", border: "#c7d2fe" },
};

function Chip({
  label,
  sev,
}: {
  label: string;
  sev: "info" | "watch" | "high";
}) {
  const s = SEVERITY_STYLES[sev];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0.15rem 0.55rem",
        background: s.background,
        color: s.color,
        border: `1px solid ${s.border}`,
        borderRadius: 999,
        fontSize: "0.75rem",
        fontWeight: 600,
        marginRight: 4,
        marginBottom: 4,
      }}
    >
      {label}
    </span>
  );
}

function Card({
  title,
  children,
  empty,
}: {
  title: string;
  children: React.ReactNode;
  empty?: boolean;
}) {
  return (
    <div
      style={{
        background: "white",
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        padding: "1rem",
      }}
    >
      <h3 style={{ marginTop: 0, marginBottom: "0.5rem", fontSize: "1rem" }}>
        {title}
      </h3>
      {empty ? (
        <div style={{ color: "#9ca3af", fontSize: "0.9rem" }}>
          No data in this window.
        </div>
      ) : (
        children
      )}
    </div>
  );
}

function scoreColor(score: number): string {
  if (score >= 75) return "#16a34a"; // green
  if (score >= 50) return "#ca8a04"; // amber
  return "#dc2626"; // red
}

// Inline SVG sparkline. Renders a small trend line for daily data.
// Kept dependency-free (no recharts) so it stays light enough to
// embed inside a pillar Card without layout cost. Caller passes
// already-bucketed daily values; we just plot them on a fixed-size
// canvas. tooltip surfaces total + window via the title attr.
function Sparkline({
  values,
  width = 160,
  height = 32,
  stroke,
  fill,
  baseline = 0,
  ariaLabel,
  title,
  markerIndices,
  markerColor = "#6366f1",
}: {
  values: number[];
  width?: number;
  height?: number;
  stroke: string;
  fill?: string;
  baseline?: number;
  ariaLabel: string;
  title?: string;
  // Indices into `values` where a vertical marker tick should be drawn.
  // Used by the PBIS sparkline to overlay intervention-logged days so
  // the eye can correlate a trend shift with intervention activity.
  markerIndices?: number[];
  markerColor?: string;
}) {
  if (values.length === 0) {
    return (
      <div
        style={{
          width,
          height,
          color: "#9ca3af",
          fontSize: 11,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        no data
      </div>
    );
  }
  const max = Math.max(baseline, ...values);
  const min = Math.min(baseline, ...values);
  const range = max - min || 1;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const yFor = (v: number) => height - ((v - min) / range) * height;
  const points = values
    .map((v, i) => `${(i * stepX).toFixed(2)},${yFor(v).toFixed(2)}`)
    .join(" ");
  // Area path closes back to baseline so positive/negative shading
  // tells the eye which side of zero we're on.
  const baselineY = yFor(baseline);
  const areaPath =
    values.length > 1
      ? `M0,${baselineY} L${points.replace(/ /g, " L")} L${(width).toFixed(2)},${baselineY} Z`
      : "";
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel}
    >
      {title && <title>{title}</title>}
      {areaPath && fill && <path d={areaPath} fill={fill} opacity={0.25} />}
      {/* baseline (often zero) */}
      <line
        x1={0}
        x2={width}
        y1={baselineY}
        y2={baselineY}
        stroke="#e5e7eb"
        strokeWidth={1}
      />
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* highlight last point so the latest value reads at a glance */}
      {values.length > 0 && (
        <circle
          cx={(values.length - 1) * stepX}
          cy={yFor(values[values.length - 1]!)}
          r={2}
          fill={stroke}
        />
      )}
      {/* intervention markers — vertical ticks across the chart at days
          where an intervention was logged. Stroked thin + low opacity so
          they read as context (not as data) over the main trend line. */}
      {(markerIndices ?? [])
        .filter((i) => i >= 0 && i < values.length)
        .map((i) => (
          <line
            key={`mk-${i}`}
            x1={i * stepX}
            x2={i * stepX}
            y1={0}
            y2={height}
            stroke={markerColor}
            strokeWidth={1}
            strokeDasharray="2 2"
            opacity={0.7}
          />
        ))}
    </svg>
  );
}

function WholeChildRadar({ axes }: { axes: ProfilePayload["radar"]["axes"] }) {
  // For axes without data, plot null so recharts skips the vertex (and
  // doesn't fool the viewer with a synthetic 50). Append a "(no data)"
  // suffix so the axis label still tells you what's missing.
  const data = axes.map((a) => ({
    axis: a.hasData ? a.label : `${a.label} (no data)`,
    score: a.hasData ? a.score : null,
  }));
  // Stroke color reflects the lowest non-resource axis (the one most worth
  // looking at). Supports is excluded because high values there don't mean
  // wellness — they mean wraparound is in place.
  const lowest = axes
    .filter((a) => !a.isResourceAxis && a.hasData)
    .reduce<number | null>((m, a) => (m == null || a.score < m ? a.score : m), null);
  const stroke = lowest == null ? "#6b7280" : scoreColor(lowest);

  return (
    <div
      className="card"
      style={{
        marginBottom: 0,
        display: "grid",
        gridTemplateColumns: "minmax(280px, 360px) 1fr",
        gap: "1rem",
        alignItems: "center",
      }}
    >
      <div style={{ width: "100%", height: 280 }}>
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={data} outerRadius="75%">
            <PolarGrid stroke="#e5e7eb" />
            <PolarAngleAxis
              dataKey="axis"
              tick={{ fontSize: 12, fill: "#374151" }}
            />
            <PolarRadiusAxis
              angle={90}
              domain={[0, 100]}
              tick={{ fontSize: 10, fill: "#9ca3af" }}
              tickCount={5}
            />
            <Radar
              name="Score"
              dataKey="score"
              stroke={stroke}
              fill={stroke}
              fillOpacity={0.25}
              isAnimationActive={false}
            />
          </RadarChart>
        </ResponsiveContainer>
      </div>
      <div>
        <h3 style={{ margin: "0 0 0.5rem 0", fontSize: "1rem" }}>
          Whole-child snapshot
        </h3>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
          {axes.map((a) => (
            <div
              key={a.key}
              title={a.rationale}
              style={{
                display: "grid",
                gridTemplateColumns: "110px 36px 1fr",
                gap: "0.5rem",
                alignItems: "center",
                fontSize: "0.85rem",
              }}
            >
              <div style={{ fontWeight: 600, color: "#374151" }}>
                {a.label}
                {a.isResourceAxis && (
                  <span style={{ color: "#9ca3af", fontWeight: 400 }}> *</span>
                )}
              </div>
              <div
                style={{
                  fontWeight: 700,
                  color: a.hasData ? scoreColor(a.score) : "#9ca3af",
                  textAlign: "right",
                }}
              >
                {a.hasData ? a.score : "—"}
              </div>
              <div style={{ color: "#6b7280" }}>{a.rationale}</div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: "0.7rem", color: "#9ca3af", marginTop: "0.5rem" }}>
          Heuristic 0–100 scores. * Supports = scaffolding in place, not a
          wellness signal.
        </div>
      </div>
    </div>
  );
}

interface Props {
  studentId: string;
  onBack: () => void;
  // True when the signed-in user is on the core team (Admin / SuperUser /
  // Behavior Specialist / MTSS Coordinator / PBIS Coordinator). Drives the
  // visibility of the inline "Edit demographics" panel that calls
  // PATCH /api/students/:studentId/flags. Server still enforces the same
  // gate; this just hides the affordance for everyone else.
  canManage?: boolean;
  // True when the signed-in user can edit safety plans (Counselor /
  // Admin / Core Team). When provided alongside onOpenSafetyPlan, the
  // header card shows an "Edit safety plan" / "Create safety plan"
  // button. Without this flag, the button shows as "View safety plan"
  // (read-only) so every staff member still has an in-context entry.
  canEditSafetyPlan?: boolean;
  onOpenSafetyPlan?: (studentId: string) => void;
  // True when the signed-in user can print the cross-domain Student
  // Overall Report PDF (Admin / SuperUser / Behavior Specialist / MTSS
  // Coordinator / Guidance Counselor / School Psychologist). Server
  // re-checks via the same gate; this just hides the affordance.
  canPrintOverallReport?: boolean;
  // True only for actual school Admin / SuperUser (mirrors the
  // server's isAdminOrSuperUser gate). Distinct from canManage which
  // also includes Behavior Specialist / MTSS Coord / PBIS Coord.
  // Used to gate admin-only affordances such as the photo-consent
  // privacy toggle, which the server rejects (403) for non-admins.
  isAdmin?: boolean;
  // True when the signed-in user can upload / capture / remove the
  // student photo (admin / front-office / core team / counselor /
  // guidance / social worker). Mirrors server canManageStudentPhoto.
  // Distinct from canEditSafetyPlan because counselors + social
  // workers can manage photos but don't necessarily edit safety plans.
  canManagePhoto?: boolean;
}

// Single-entry student-photo manager — upload OR camera capture. Shown
// inside the StudentProfile header for users who can manage photos
// (Admin / Core Team / Guidance — same gate as canEditSafetyPlan).
// Bytes flow through the existing /api/storage/* presigned-PUT pipeline,
// then we POST the resulting objectPath to /api/students/:id/photo.
// The admin-only consent toggle calls PATCH /photo-consent.
function StudentPhotoManager({
  studentId,
  firstName,
  lastName,
  isAdmin,
}: {
  studentId: string;
  firstName: string;
  lastName: string;
  isAdmin: boolean;
}) {
  const [photoObjectKey, setPhotoObjectKey] = useState<string | null>(null);
  const [photoConsent, setPhotoConsent] = useState<boolean>(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bulkInputRef = useRef<HTMLInputElement | null>(null);
  // Per-file progress for the bulk multi-upload flow. Each row maps a
  // picked file → derived studentId (filename stem) → status. This is
  // intentionally local to the manager so the modal closes on unmount;
  // we don't need to persist it across navigations.
  const [bulkRows, setBulkRows] = useState<
    Array<{
      filename: string;
      studentId: string;
      status: "pending" | "uploading" | "ok" | "skipped" | "failed";
      error?: string;
    }>
  >([]);
  const [bulkRunning, setBulkRunning] = useState(false);

  // Pull current photo state on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await authFetch(
        `/api/students/${encodeURIComponent(studentId)}`,
      );
      if (!r.ok || cancelled) return;
      const j = (await r.json()) as {
        photoObjectKey?: string | null;
        photoConsent?: boolean;
      };
      if (cancelled) return;
      setPhotoObjectKey(j.photoObjectKey ?? null);
      setPhotoConsent(j.photoConsent ?? true);
    })();
    return () => {
      cancelled = true;
    };
  }, [studentId]);

  // Camera lifecycle: stop the stream on close or unmount so the
  // browser tab indicator doesn't stay red after the panel closes.
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        for (const t of streamRef.current.getTracks()) t.stop();
        streamRef.current = null;
      }
    };
  }, []);

  async function uploadBlob(blob: Blob, filename: string) {
    setBusy(true);
    setErr(null);
    try {
      const reqRes = await authFetch("/api/storage/uploads/request-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: filename,
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
        throw new Error(j.error ?? "Save failed");
      }
      setPhotoObjectKey(objectPath);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setErr("Please pick an image file.");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setErr("Image must be under 8 MB.");
      return;
    }
    await uploadBlob(file, file.name);
  }

  async function openCamera() {
    setErr(null);
    // Defensive: if a previous getUserMedia() stream is still live (user
    // double-clicked, or a prior open path didn't clean up), stop its
    // tracks before requesting a new one. Otherwise the browser keeps
    // the camera LED / tab indicator on for the orphaned stream.
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) t.stop();
      streamRef.current = null;
    }
    if (cameraOpen) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOpen(true);
      // Defer so the <video> element exists.
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play();
        }
      }, 0);
    } catch (e) {
      setErr(
        e instanceof Error
          ? `Camera unavailable: ${e.message}`
          : "Camera unavailable",
      );
    }
  }

  function closeCamera() {
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) t.stop();
      streamRef.current = null;
    }
    setCameraOpen(false);
  }

  async function snap() {
    const v = videoRef.current;
    if (!v) return;
    const w = v.videoWidth;
    const h = v.videoHeight;
    if (!w || !h) return;
    // Crop to a centered square so the bubble crop is consistent.
    const side = Math.min(w, h);
    const sx = (w - side) / 2;
    const sy = (h - side) / 2;
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, sx, sy, side, side, 0, 0, 512, 512);
    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.9),
    );
    if (!blob) {
      setErr("Could not capture image.");
      return;
    }
    closeCamera();
    await uploadBlob(blob, `${studentId}-snapshot.jpg`);
  }

  // Bulk upload — admin picks many files at once. Each filename's stem
  // (everything before the last dot) is treated as the studentId. We
  // iterate sequentially so a tenant uploading 800 yearbook photos
  // doesn't open 800 concurrent fetches and trigger backpressure / GCS
  // throttling. Per-row status updates render live so the operator
  // sees progress on a long batch. Errors don't abort the run — a bad
  // filename or a deactivated student just marks that row failed and
  // we move on.
  function studentIdFromFilename(name: string): string {
    const stem = name.replace(/\.[^./\\]+$/, "");
    return stem.trim();
  }

  async function uploadOne(file: File, studentId: string): Promise<void> {
    const reqRes = await authFetch("/api/storage/uploads/request-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: file.name,
        size: file.size,
        contentType: file.type || "image/jpeg",
      }),
    });
    if (!reqRes.ok) throw new Error("Could not start upload");
    const { uploadURL, objectPath } = (await reqRes.json()) as {
      uploadURL: string;
      objectPath: string;
    };
    const putRes = await fetch(uploadURL, {
      method: "PUT",
      headers: { "Content-Type": file.type || "image/jpeg" },
      body: file,
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
      const j = (await saveRes.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error ?? `Save failed (${saveRes.status})`);
    }
  }

  function handleBulkFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    const rows = files.map((f) => ({
      filename: f.name,
      studentId: studentIdFromFilename(f.name),
      status: f.type.startsWith("image/")
        ? ("pending" as const)
        : ("skipped" as const),
      error: f.type.startsWith("image/") ? undefined : "Not an image file",
    }));
    setBulkRows(rows);
    void runBulk(files, rows);
  }

  async function runBulk(
    files: File[],
    initial: Array<{ filename: string; studentId: string; status: string }>,
  ) {
    setBulkRunning(true);
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      const initRow = initial[i]!;
      if (initRow.status === "skipped") continue;
      if (file.size > 8 * 1024 * 1024) {
        setBulkRows((prev) =>
          prev.map((r, idx) =>
            idx === i
              ? { ...r, status: "failed", error: "Image > 8 MB" }
              : r,
          ),
        );
        continue;
      }
      if (!initRow.studentId) {
        setBulkRows((prev) =>
          prev.map((r, idx) =>
            idx === i
              ? { ...r, status: "failed", error: "Filename has no studentId" }
              : r,
          ),
        );
        continue;
      }
      setBulkRows((prev) =>
        prev.map((r, idx) =>
          idx === i ? { ...r, status: "uploading" } : r,
        ),
      );
      try {
        await uploadOne(file, initRow.studentId);
        setBulkRows((prev) =>
          prev.map((r, idx) =>
            idx === i ? { ...r, status: "ok" } : r,
          ),
        );
      } catch (err) {
        setBulkRows((prev) =>
          prev.map((r, idx) =>
            idx === i
              ? {
                  ...r,
                  status: "failed",
                  error: err instanceof Error ? err.message : "Upload failed",
                }
              : r,
          ),
        );
      }
    }
    setBulkRunning(false);
  }

  async function handleRemove() {
    if (!confirm("Remove this student's photo?")) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await authFetch(
        `/api/students/${encodeURIComponent(studentId)}/photo`,
        { method: "DELETE" },
      );
      if (!r.ok) throw new Error("Remove failed");
      setPhotoObjectKey(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggleConsent(next: boolean) {
    setBusy(true);
    setErr(null);
    try {
      const r = await authFetch(
        `/api/students/${encodeURIComponent(studentId)}/photo-consent`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ consent: next }),
        },
      );
      if (!r.ok) throw new Error("Could not update consent");
      setPhotoConsent(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not update consent");
    } finally {
      setBusy(false);
    }
  }

  const btn: React.CSSProperties = {
    border: "1px solid #cbd5e1",
    background: "#fff",
    padding: "0.3rem 0.7rem",
    borderRadius: 6,
    fontSize: "0.78rem",
    fontWeight: 600,
    cursor: busy ? "not-allowed" : "pointer",
    opacity: busy ? 0.6 : 1,
  };
  return (
    <div
      style={{
        marginTop: "0.6rem",
        padding: "0.6rem 0.75rem",
        background: "#f8fafc",
        border: "1px solid #cbd5e1",
        borderRadius: 6,
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: 12 }}
      >
        <StudentPhoto
          firstName={firstName}
          lastName={lastName}
          photoObjectKey={photoObjectKey}
          photoConsent={photoConsent}
          size={64}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: "0.85rem", fontWeight: 600 }}>
            Student photo
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              style={btn}
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
            >
              Upload
            </button>
            <button
              type="button"
              style={btn}
              disabled={busy}
              onClick={openCamera}
            >
              Take photo
            </button>
            {photoObjectKey && (
              <button
                type="button"
                style={{
                  ...btn,
                  borderColor: "#fecaca",
                  color: "#b91c1c",
                }}
                disabled={busy}
                onClick={handleRemove}
              >
                Remove
              </button>
            )}
            {isAdmin && (
              <button
                type="button"
                style={btn}
                disabled={bulkRunning}
                onClick={() => bulkInputRef.current?.click()}
                title="Pick many image files at once. Each filename (without extension) is matched to a student ID — e.g. 1234.jpg sets the photo for student 1234."
              >
                Bulk upload…
              </button>
            )}
            {/* capture="environment" hints to mobile browsers that
                tapping this opens the rear camera natively (iOS / Android),
                which is the most reliable phone/tablet capture path —
                getUserMedia in Safari has historically been finicky.
                On desktop the attribute is ignored and the user gets a
                normal file picker. */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: "none" }}
              onChange={handleFile}
            />
            <input
              ref={bulkInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: "none" }}
              onChange={handleBulkFiles}
            />
          </div>
          {isAdmin && (
            <label
              style={{
                fontSize: "0.75rem",
                color: "#475569",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <input
                type="checkbox"
                checked={photoConsent}
                disabled={busy}
                onChange={(e) => toggleConsent(e.target.checked)}
              />
              Photo consent (admin) — when off, every render falls back to
              initials regardless of whether bytes are stored.
            </label>
          )}
          {err && (
            <div style={{ color: "#b91c1c", fontSize: "0.75rem" }}>{err}</div>
          )}
        </div>
      </div>
      {bulkRows.length > 0 && (
        <div
          style={{
            marginTop: 10,
            padding: "0.5rem 0.7rem",
            background: "#fff",
            border: "1px solid #cbd5e1",
            borderRadius: 6,
            maxHeight: 240,
            overflowY: "auto",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: "0.78rem",
              fontWeight: 600,
              marginBottom: 4,
            }}
          >
            <span>
              Bulk upload —{" "}
              {bulkRows.filter((r) => r.status === "ok").length}/
              {bulkRows.length} done
              {bulkRunning ? " (uploading…)" : ""}
            </span>
            {!bulkRunning && (
              <button
                type="button"
                style={{
                  ...btn,
                  padding: "0.15rem 0.5rem",
                  fontSize: "0.7rem",
                }}
                onClick={() => setBulkRows([])}
              >
                Clear
              </button>
            )}
          </div>
          <table style={{ width: "100%", fontSize: "0.72rem" }}>
            <tbody>
              {bulkRows.map((r, i) => {
                const color =
                  r.status === "ok"
                    ? "#15803d"
                    : r.status === "failed"
                      ? "#b91c1c"
                      : r.status === "skipped"
                        ? "#6b7280"
                        : "#0f172a";
                return (
                  <tr key={i}>
                    <td
                      style={{
                        padding: "1px 4px",
                        whiteSpace: "nowrap",
                        color: "#64748b",
                      }}
                    >
                      {r.filename}
                    </td>
                    <td
                      style={{
                        padding: "1px 4px",
                        whiteSpace: "nowrap",
                      }}
                    >
                      → {r.studentId || "(no id)"}
                    </td>
                    <td style={{ padding: "1px 4px", color }}>
                      {r.status === "uploading"
                        ? "uploading…"
                        : r.status === "ok"
                          ? "✓"
                          : r.status === "skipped"
                            ? "skipped"
                            : r.status === "failed"
                              ? `✗ ${r.error ?? ""}`
                              : "queued"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {cameraOpen && (
        <div style={{ marginTop: 10 }}>
          <video
            ref={videoRef}
            playsInline
            muted
            style={{
              width: 320,
              height: 240,
              background: "#000",
              borderRadius: 6,
            }}
          />
          <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
            <button type="button" style={btn} onClick={snap} disabled={busy}>
              📸 Capture
            </button>
            <button type="button" style={btn} onClick={closeCamera}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Mark/unmark grade-level retentions for a single student. Lives inside
// the demographics editor so it shares the same admin/Core-Team gate.
// Existing retentions render as black "R Grade N" chips with an "x"
// to remove. The picker on the right marks a new grade. Server is
// idempotent on (student, grade), so a re-mark is a safe no-op.
function RetentionManager({
  studentId,
  retainedGrades,
  onChange,
}: {
  studentId: string;
  retainedGrades: number[];
  onChange: (next: number[]) => void;
}) {
  const [pickGrade, setPickGrade] = useState<number>(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");

  async function add() {
    if (busy) return;
    setErr("");
    setBusy(true);
    try {
      const r = await authFetch(
        `/api/students/${encodeURIComponent(studentId)}/retentions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gradeLevel: pickGrade }),
        },
      );
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setErr(j.error ?? `HTTP ${r.status}`);
        return;
      }
      // Merge locally — server is idempotent so no double-rows.
      const set = new Set(retainedGrades);
      set.add(pickGrade);
      onChange([...set].sort((a, b) => a - b));
    } finally {
      setBusy(false);
    }
  }

  async function remove(grade: number) {
    if (busy) return;
    setErr("");
    setBusy(true);
    try {
      const r = await authFetch(
        `/api/students/${encodeURIComponent(studentId)}/retentions/${grade}`,
        { method: "DELETE" },
      );
      if (!r.ok && r.status !== 204) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setErr(j.error ?? `HTTP ${r.status}`);
        return;
      }
      onChange(retainedGrades.filter((g) => g !== grade));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "0.4rem",
        paddingTop: "0.4rem",
        borderTop: "1px dashed #cbd5e1",
      }}
    >
      <span style={{ fontSize: "0.8rem", color: "#475569", fontWeight: 600 }}>
        Retention:
      </span>
      {retainedGrades.length === 0 && (
        <span style={{ fontSize: "0.8rem", color: "#94a3b8" }}>
          (none recorded)
        </span>
      )}
      {retainedGrades.map((g) => (
        <span
          key={g}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 8px",
            borderRadius: 999,
            background: "#0f172a",
            color: "white",
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          R · Grade {g}
          <button
            type="button"
            disabled={busy}
            onClick={() => remove(g)}
            title={`Remove Grade ${g} retention`}
            style={{
              background: "transparent",
              border: "none",
              color: "white",
              cursor: "pointer",
              fontSize: 12,
              padding: 0,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </span>
      ))}
      <span style={{ marginLeft: "auto", display: "inline-flex", gap: 4, alignItems: "center" }}>
        <select
          value={pickGrade}
          onChange={(e) => setPickGrade(Number(e.target.value))}
          disabled={busy}
          style={{ fontSize: "0.8rem", padding: "0.15rem 0.35rem" }}
        >
          {[1, 2, 3, 4, 5, 6, 7, 8].map((g) => (
            <option key={g} value={g}>
              Grade {g}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy}
          onClick={add}
          style={{
            fontSize: "0.8rem",
            padding: "0.2rem 0.55rem",
            border: "1px solid #cbd5e1",
            background: "#f8fafc",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          + Mark retained
        </button>
      </span>
      {err && (
        <span style={{ fontSize: "0.75rem", color: "#b91c1c" }}>{err}</span>
      )}
    </div>
  );
}

export default function StudentProfile({
  studentId,
  onBack,
  canManage = false,
  canEditSafetyPlan = false,
  isAdmin = false,
  canManagePhoto = false,
  onOpenSafetyPlan,
  canPrintOverallReport = false,
}: Props) {
  const [data, setData] = useState<ProfilePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [windowKey, setWindowKey] = useState<WindowKey>("30");
  // Emergency contacts come from /api/students/:id (separate endpoint
  // since the insights profile payload doesn't include SIS contact
  // slots). Loaded in a parallel fetch — failure is non-fatal.
  const [emergencyContacts, setEmergencyContacts] = useState<
    Array<{
      slot: number;
      name: string | null;
      relationship: string | null;
      phone: string | null;
    }>
  >([]);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  // Inline demographics editor — closed by default. When opened it
  // hydrates from the loaded profile; Save PATCHes only the changed
  // fields so the server-side merge stays minimal.
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [editGender, setEditGender] = useState("");
  const [editEll, setEditEll] = useState(false);
  const [editEse, setEditEse] = useState(false);
  const [editIs504, setEditIs504] = useState(false);
  const [editCtEla, setEditCtEla] = useState(false);
  const [editCtMath, setEditCtMath] = useState(false);

  // Unified intervention history (Tier 2 + Tier 3 + legacy + check-in/out).
  // Lives below the pillars grid as the canonical "everything we've tried
  // for this student" surface. The pillar Supports card keeps its quick
  // glance list; this panel is the full record.
  type HistoryRow = {
    source: "tier2" | "tier3" | "legacy" | "checkInOut";
    sourceId: number;
    studentId: string;
    staffId: number | null;
    staffName: string | null;
    occurredAt: string;
    date: string;
    tier: "t2" | "t3" | "legacy" | "quick";
    typeLabel: string;
    detail: string | null;
  };
  const [historyRows, setHistoryRows] = useState<HistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyErr, setHistoryErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryErr(null);
    authFetch(
      `/api/students/${encodeURIComponent(studentId)}/intervention-history`,
    )
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok) {
          setHistoryErr(body?.error || `HTTP ${r.status}`);
          setHistoryRows([]);
        } else {
          setHistoryRows(body?.rows ?? []);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setHistoryErr(String((e as Error)?.message || e));
          setHistoryRows([]);
        }
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId]);

  useEffect(() => {
    setLoading(true);
    setError("");
    let cancelled = false;
    const params = new URLSearchParams();
    params.set("window", windowKey);
    if (windowKey === "custom") {
      if (customFrom) params.set("from", customFrom);
      if (customTo) params.set("to", customTo);
    }
    authFetch(
      `/api/insights/students/${encodeURIComponent(studentId)}/profile?${params.toString()}`,
    )
      .then(async (r) => {
        if (r.status === 403) throw new Error("You don't have access to this student.");
        if (r.status === 404) throw new Error("Student not found.");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((p: ProfilePayload) => {
        if (!cancelled) setData(p);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message ?? "Failed to load profile");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, windowKey, customFrom, customTo]);

  // Parallel fetch for SIS-derived emergency contact slots. Independent
  // of the window filter — these are static per-student. Reset on
  // student change so a stale prior-student row never bleeds through
  // if the new fetch fails (privacy correctness).
  useEffect(() => {
    let cancelled = false;
    setEmergencyContacts([]);
    authFetch(`/api/students/${encodeURIComponent(studentId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { emergencyContacts?: typeof emergencyContacts } | null) => {
        if (cancelled || !j) return;
        setEmergencyContacts(j.emergencyContacts ?? []);
      })
      .catch(() => {
        /* non-fatal — block just stays empty */
      });
    return () => {
      cancelled = true;
    };
  }, [studentId]);

  if (loading) {
    return (
      <div className="card" style={{ marginBottom: "1rem" }}>
        <button type="button" onClick={onBack} style={{ marginBottom: "0.5rem" }}>
          ← Back to Investigations
        </button>
        <p style={{ color: "var(--text-subtle)" }}>Loading profile…</p>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="card" style={{ marginBottom: "1rem" }}>
        <button type="button" onClick={onBack} style={{ marginBottom: "0.5rem" }}>
          ← Back to Investigations
        </button>
        <p style={{ color: "#991b1b" }}>{error ?? "Failed to load."}</p>
      </div>
    );
  }

  const { header, pillars, riskFlags, window: win } = data;

  return (
    <div style={{ display: "grid", gap: "0.75rem", marginBottom: "1rem" }}>
      {/* Top bar — back + window picker */}
      <div className="card" style={{ marginBottom: 0 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "0.5rem",
          }}
        >
          <button
            type="button"
            onClick={onBack}
            style={{
              background: "transparent",
              border: "1px solid #d1d5db",
              padding: "0.3rem 0.75rem",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            ← Back to Investigations
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
            <span style={{ color: "#6b7280", fontSize: "0.85rem" }}>Window:</span>
            {(["3", "7", "15", "30", "custom"] as WindowKey[]).map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setWindowKey(w)}
                style={{
                  padding: "0.2rem 0.55rem",
                  border: "1px solid",
                  borderColor: windowKey === w ? "#0d9488" : "#d1d5db",
                  background: windowKey === w ? "#0d9488" : "white",
                  color: windowKey === w ? "white" : "#374151",
                  borderRadius: 999,
                  fontSize: "0.78rem",
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                {w === "custom" ? "Custom" : `${w}d`}
              </button>
            ))}
            {windowKey === "custom" && (
              <>
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  style={{ padding: "0.15rem" }}
                />
                <span>→</span>
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  style={{ padding: "0.15rem" }}
                />
              </>
            )}
            <span style={{ color: "#6b7280", fontSize: "0.78rem" }}>({win.label})</span>
          </div>
        </div>
      </div>

      <HowToUseHelp title="How to use the Student Profile">
        <HowToSection title="What this page is">
          The whole-child view of one student. Header shows identity,
          grade, demographics, and current MTSS tier. Below that are
          five pillar cards (Academics, Behavior, Flow, Supports,
          Family) and a risk callout rail with the actionable signals.
        </HowToSection>
        <HowToSection title="Reading the pillars">
          <ul style={howtoListStyle}>
            <li><strong>Academics</strong> — FAST trend, course grades, gap-to-proficiency.</li>
            <li><strong>Behavior</strong> — PBIS positives/negatives ratio, recent referrals.</li>
            <li><strong>Flow</strong> — attendance, hall passes, tardies, ISS/OSS history.</li>
            <li><strong>Supports</strong> — active interventions, plans, trusted adults.</li>
            <li><strong>Family</strong> — communication log + emergency contacts (read-only).</li>
          </ul>
        </HowToSection>
        <RoleSection for="teacher" title="What teachers can do here">
          You see this profile for any student on your roster. Use the
          intervention history below the pillars when building parent
          conferences — it's the canonical "everything we've tried"
          record.
        </RoleSection>
        <RoleSection for={["admin", "coreTeam", "guidanceCounselor"]} title="Admin / Core Team / Guidance">
          You can edit demographics inline (gender, ELL/ESE/504/CT
          flags) — saves PATCH only the changed fields. The Safety
          Plan button (when present) opens the editor; only Guidance
          Counselor / Admin / Core Team can save changes there.
        </RoleSection>
        <RoleSection for="admin" title="Print &amp; export">
          The Print Overall Report button (top right) produces a
          parent-friendly PDF of every pillar at the current window.
          Useful for IEP / 504 / SST meetings.
        </RoleSection>
      </HowToUseHelp>

      {/* Header card */}
      <div className="card" style={{ marginBottom: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "1rem" }}>
          <div>
            <h2 style={{ margin: 0 }}>
              {header.firstName} {header.lastName}
            </h2>
            <div style={{ color: "#6b7280", marginBottom: 6 }}>
              Grade {header.grade}
              {header.gender && <> &middot; {header.gender}</>}
              <> &middot; {header.studentId}</>
            </div>
            <div>
              {header.flags.ell && <Chip label="ELL" sev="info" />}
              {header.flags.ese && <Chip label="ESE" sev="info" />}
              {header.flags.is504 && <Chip label="504" sev="info" />}
              {header.flags.ctEla && <Chip label="CT ELA" sev="info" />}
              {header.flags.ctMath && <Chip label="CT Math" sev="info" />}
              {header.retainedGrades && header.retainedGrades.length > 0 && (
                <span
                  title={`Retained: ${header.retainedGrades
                    .map((g) => `Grade ${g}`)
                    .join(", ")}`}
                  aria-label={`Retained at ${header.retainedGrades
                    .map((g) => `Grade ${g}`)
                    .join(", ")}`}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 20,
                    height: 20,
                    borderRadius: "50%",
                    background: "#0f172a",
                    color: "white",
                    fontSize: 12,
                    fontWeight: 800,
                    lineHeight: 1,
                    marginLeft: 4,
                    marginRight: 2,
                    cursor: "help",
                    verticalAlign: "middle",
                  }}
                >
                  R
                </span>
              )}
              {header.mtssTier === 1 ? (
                <Chip label="Tier 1 (no plan)" sev="info" />
              ) : (
                <Chip label={`MTSS Tier ${header.mtssTier}`} sev={header.mtssTier === 3 ? "high" : "watch"} />
              )}
              {header.activeMtssPlanCount > 0 && (
                <Chip
                  label={`${header.activeMtssPlanCount} active plan${header.activeMtssPlanCount === 1 ? "" : "s"}`}
                  sev="watch"
                />
              )}
              {canPrintOverallReport && (
                <a
                  href={`/api/students/${encodeURIComponent(studentId)}/overall-report-pdf`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    marginLeft: 4,
                    background: "#dbeafe",
                    border: "1px solid #bfdbfe",
                    color: "#1e3a8a",
                    padding: "0.2rem 0.6rem",
                    borderRadius: 999,
                    fontSize: "0.78rem",
                    fontWeight: 600,
                    textDecoration: "none",
                    display: "inline-block",
                  }}
                  title="Print the cross-domain Student Overall Report (PDF)"
                >
                  🖨️ Print Overall Report
                </a>
              )}
              {onOpenSafetyPlan && (
                <button
                  type="button"
                  onClick={() => onOpenSafetyPlan(studentId)}
                  style={{
                    marginLeft: 4,
                    background: canEditSafetyPlan ? "#fee2e2" : "transparent",
                    border: `1px solid ${canEditSafetyPlan ? "#fecaca" : "#d1d5db"}`,
                    color: canEditSafetyPlan ? "#991b1b" : "#374151",
                    padding: "0.2rem 0.6rem",
                    borderRadius: 999,
                    fontSize: "0.78rem",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                  title={
                    canEditSafetyPlan
                      ? "Open the safety plan editor"
                      : "View safety plan (read-only)"
                  }
                >
                  {canEditSafetyPlan
                    ? "Edit safety plan"
                    : "View safety plan"}
                </button>
              )}
              {canManage && !editing && (
                <button
                  type="button"
                  onClick={() => {
                    // Hydrate inputs from the currently-loaded payload
                    // each time the editor opens; this also resets any
                    // unsaved typing if the user opened, closed, opened.
                    setEditGender(header.gender ?? "");
                    setEditEll(header.flags.ell);
                    setEditEse(header.flags.ese);
                    setEditIs504(header.flags.is504);
                    setEditCtEla(header.flags.ctEla);
                    setEditCtMath(header.flags.ctMath);
                    setSaveMsg("");
                    setEditing(true);
                  }}
                  style={{
                    marginLeft: 4,
                    background: "transparent",
                    border: "1px dashed #94a3b8",
                    color: "#475569",
                    padding: "0.15rem 0.55rem",
                    borderRadius: 999,
                    fontSize: "0.75rem",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  ✎ Edit demographics
                </button>
              )}
            </div>
            {/* Retention manager — gated on canEditSafetyPlan, which
                covers Admin / Behavior Specialist / MTSS Coordinator /
                Guidance Counselor / School Psych. Lives outside the
                demographics editor so a Counselor (who lacks
                canManage / canManageMtssPlans) can still mark/unmark
                retentions without needing the demographics editor. */}
            {canManagePhoto && data?.header && (
              <StudentPhotoManager
                studentId={studentId}
                firstName={data.header.firstName}
                lastName={data.header.lastName}
                isAdmin={isAdmin}
              />
            )}
            {canEditSafetyPlan && (
              <div style={{ marginTop: "0.6rem" }}>
                <RetentionManager
                  studentId={studentId}
                  retainedGrades={data?.header.retainedGrades ?? []}
                  onChange={(next) => {
                    setData((prev) =>
                      prev
                        ? {
                            ...prev,
                            header: { ...prev.header, retainedGrades: next },
                          }
                        : prev,
                    );
                  }}
                />
              </div>
            )}
            {canManage && editing && (
              <div
                style={{
                  marginTop: "0.6rem",
                  padding: "0.6rem 0.75rem",
                  background: "#f8fafc",
                  border: "1px solid #cbd5e1",
                  borderRadius: 6,
                  display: "grid",
                  gap: "0.4rem",
                }}
              >
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.6rem", alignItems: "center" }}>
                  <label style={{ fontSize: "0.8rem", color: "#475569" }}>
                    Gender:{" "}
                    <input
                      type="text"
                      value={editGender}
                      onChange={(e) => setEditGender(e.target.value)}
                      placeholder="(empty to clear)"
                      style={{ padding: "0.15rem 0.35rem", fontSize: "0.85rem", width: 120 }}
                    />
                  </label>
                  <label style={{ fontSize: "0.8rem" }}>
                    <input type="checkbox" checked={editEll} onChange={(e) => setEditEll(e.target.checked)} /> ELL
                  </label>
                  <label style={{ fontSize: "0.8rem" }}>
                    <input type="checkbox" checked={editEse} onChange={(e) => setEditEse(e.target.checked)} /> ESE
                  </label>
                  <label style={{ fontSize: "0.8rem" }}>
                    <input type="checkbox" checked={editIs504} onChange={(e) => setEditIs504(e.target.checked)} /> 504
                  </label>
                  <label style={{ fontSize: "0.8rem", color: "#0369a1", fontWeight: 600 }}>
                    <input type="checkbox" checked={editCtEla} onChange={(e) => setEditCtEla(e.target.checked)} /> CT ELA
                  </label>
                  <label style={{ fontSize: "0.8rem", color: "#0369a1", fontWeight: 600 }}>
                    <input type="checkbox" checked={editCtMath} onChange={(e) => setEditCtMath(e.target.checked)} /> CT Math
                  </label>
                </div>
                <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={async () => {
                      // Build a delta — only fields the user actually
                      // changed get sent. Server validates strict types
                      // and returns the canonical post-write row, which
                      // we splice back into the local payload so the
                      // chips refresh without a full re-fetch.
                      const body: Record<string, unknown> = {};
                      const initialGender = header.gender ?? "";
                      if (editGender !== initialGender) {
                        body.gender = editGender === "" ? null : editGender;
                      }
                      if (editEll !== header.flags.ell) body.ell = editEll;
                      if (editEse !== header.flags.ese) body.ese = editEse;
                      if (editIs504 !== header.flags.is504) body.is504 = editIs504;
                      if (editCtEla !== header.flags.ctEla) body.ctEla = editCtEla;
                      if (editCtMath !== header.flags.ctMath) body.ctMath = editCtMath;
                      if (Object.keys(body).length === 0) {
                        setSaveMsg("No changes.");
                        return;
                      }
                      setSaving(true);
                      setSaveMsg("");
                      try {
                        const r = await authFetch(
                          `/api/students/${encodeURIComponent(studentId)}/flags`,
                          {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(body),
                          },
                        );
                        if (!r.ok) {
                          const txt = await r.text().catch(() => "");
                          throw new Error(txt || `HTTP ${r.status}`);
                        }
                        const updated = (await r.json()) as {
                          gender: string | null;
                          ell: boolean;
                          ese: boolean;
                          is504: boolean;
                          ctEla: boolean;
                          ctMath: boolean;
                        };
                        setData((prev) =>
                          prev
                            ? {
                                ...prev,
                                header: {
                                  ...prev.header,
                                  gender: updated.gender,
                                  flags: {
                                    ell: updated.ell,
                                    ese: updated.ese,
                                    is504: updated.is504,
                                    ctEla: updated.ctEla,
                                    ctMath: updated.ctMath,
                                  },
                                },
                              }
                            : prev,
                        );
                        setSaveMsg("Saved.");
                        setEditing(false);
                      } catch (e) {
                        setSaveMsg(
                          (e as Error).message || "Failed to save",
                        );
                      } finally {
                        setSaving(false);
                      }
                    }}
                    style={{
                      background: "#0d9488",
                      color: "white",
                      border: "none",
                      padding: "0.3rem 0.8rem",
                      borderRadius: 6,
                      cursor: saving ? "not-allowed" : "pointer",
                      fontSize: "0.8rem",
                      fontWeight: 600,
                    }}
                  >
                    {saving ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      setEditing(false);
                      setSaveMsg("");
                    }}
                    style={{
                      background: "transparent",
                      border: "1px solid #cbd5e1",
                      padding: "0.3rem 0.8rem",
                      borderRadius: 6,
                      cursor: saving ? "not-allowed" : "pointer",
                      fontSize: "0.8rem",
                    }}
                  >
                    Cancel
                  </button>
                  {saveMsg && (
                    <span style={{ fontSize: "0.78rem", color: "#475569" }}>
                      {saveMsg}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
          <div style={{ fontSize: "0.78rem", color: "#9ca3af", textAlign: "right" }}>
            Visibility:{" "}
            {header.visibilityPath === "core"
              ? "Core team"
              : header.visibilityPath === "roster"
              ? "Your class roster"
              : "Trusted-adult assignment"}
          </div>
        </div>
      </div>

      {/* Risk callout rail */}
      {riskFlags.length > 0 && (
        <div className="card" style={{ marginBottom: 0 }}>
          <h3 style={{ margin: "0 0 0.5rem 0", fontSize: "1rem" }}>Things to know</h3>
          <div>
            {riskFlags.map((f) => (
              <Chip key={f.code} label={f.label} sev={f.severity} />
            ))}
          </div>
        </div>
      )}

      {/* Whole-child radar */}
      <WholeChildRadar axes={data.radar.axes} />

      {/* Pillars grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: "0.75rem",
        }}
      >
        <Card
          title="Academics"
          empty={
            pillars.academics.fastScores.length === 0 &&
            // Defensive `?? []` / `?? null` defaults — a stale-cache /
            // version-skew race (old API response in memory while the new
            // bundle expects the new shape) would otherwise crash the
            // whole page on the first HMR cycle. Type says these are
            // present; runtime trusts but verifies.
            (pillars.academics.ireadyScores ?? []).length === 0 &&
            !(pillars.academics.sciScores ?? null) &&
            pillars.academics.assessments.length === 0
          }
        >
          {pillars.academics.fastScores.length > 0 && (
            <div style={{ marginBottom: "0.5rem" }}>
              <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: 4 }}>
                FAST PM
              </div>
              <table className="pulse-table" style={{ width: "100%", fontSize: "0.85rem" }}>
                <thead>
                  <tr style={{ color: "#6b7280" }}>
                    <th style={{ textAlign: "left" }}>Subject</th>
                    <th style={{ textAlign: "right" }}>PM1</th>
                    <th style={{ textAlign: "right" }}>PM2</th>
                    <th style={{ textAlign: "right" }}>PM3</th>
                    <th style={{ textAlign: "right" }}>Prior Yr</th>
                  </tr>
                </thead>
                <tbody>
                  {pillars.academics.fastScores.map((s) => (
                    <tr key={s.subject}>
                      <td style={{ textTransform: "uppercase" }}>{s.subject}</td>
                      <td style={{ textAlign: "right" }}>{s.pm1 ?? "—"}</td>
                      <td style={{ textAlign: "right" }}>{s.pm2 ?? "—"}</td>
                      <td style={{ textAlign: "right" }}>{s.pm3 ?? "—"}</td>
                      <td style={{ textAlign: "right" }}>
                        {s.priorYearScore ?? "—"}
                        {s.priorYearBq && (
                          <span style={{ color: "#991b1b", marginLeft: 4 }}>(BQ)</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(pillars.academics.ireadyScores ?? []).length > 0 && (
            <div style={{ marginBottom: "0.5rem" }}>
              <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: 4 }}>
                iReady AP
              </div>
              <table className="pulse-table" style={{ width: "100%", fontSize: "0.85rem" }}>
                <thead>
                  <tr style={{ color: "#6b7280" }}>
                    <th style={{ textAlign: "left" }}>Subject</th>
                    <th style={{ textAlign: "right" }}>AP1</th>
                    <th style={{ textAlign: "right" }}>AP2</th>
                    <th style={{ textAlign: "right" }}>AP3</th>
                    <th style={{ textAlign: "left", paddingLeft: 8 }}>Latest Level</th>
                  </tr>
                </thead>
                <tbody>
                  {(pillars.academics.ireadyScores ?? []).map((s) => {
                    // Most-recent populated level wins, AP3 → AP2 → AP1.
                    const latestLevel =
                      s.ap3Level ?? s.ap2Level ?? s.ap1Level ?? null;
                    return (
                      <tr key={s.subject}>
                        <td>{s.subject}</td>
                        <td style={{ textAlign: "right" }}>{s.ap1 ?? "—"}</td>
                        <td style={{ textAlign: "right" }}>{s.ap2 ?? "—"}</td>
                        <td style={{ textAlign: "right" }}>{s.ap3 ?? "—"}</td>
                        <td
                          style={{
                            paddingLeft: 8,
                            color: "#6b7280",
                            fontSize: "0.78rem",
                          }}
                        >
                          {latestLevel ?? "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {pillars.academics.sciScores && (
            <div style={{ marginBottom: "0.5rem" }}>
              <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: 4 }}>
                SCI Benchmark
              </div>
              <table className="pulse-table" style={{ width: "100%", fontSize: "0.85rem" }}>
                <thead>
                  <tr style={{ color: "#6b7280" }}>
                    <th style={{ textAlign: "left" }}>Subject</th>
                    <th style={{ textAlign: "right" }}>B1</th>
                    <th style={{ textAlign: "right" }}>B2</th>
                    <th style={{ textAlign: "right" }}>B3</th>
                    <th style={{ textAlign: "left", paddingLeft: 8 }}>Latest Level</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Science</td>
                    <td style={{ textAlign: "right" }}>
                      {pillars.academics.sciScores.b1 != null
                        ? `${pillars.academics.sciScores.b1}%`
                        : "—"}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {pillars.academics.sciScores.b2 != null
                        ? `${pillars.academics.sciScores.b2}%`
                        : "—"}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {pillars.academics.sciScores.b3 != null
                        ? `${pillars.academics.sciScores.b3}%`
                        : "—"}
                    </td>
                    <td
                      style={{
                        paddingLeft: 8,
                        color: "#6b7280",
                        fontSize: "0.78rem",
                      }}
                    >
                      {pillars.academics.sciScores.b3Level ??
                        pillars.academics.sciScores.b2Level ??
                        pillars.academics.sciScores.b1Level ??
                        "—"}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          {pillars.academics.assessments.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: 4 }}>
                Recent assessments ({pillars.academics.assessments.length})
              </div>
              <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85rem" }}>
                {pillars.academics.assessments.slice(0, 6).map((a, i) => (
                  <li key={i}>
                    <strong>{a.name}</strong>:{" "}
                    {a.score != null ? a.score : a.scoreLevel ?? "—"}{" "}
                    <span style={{ color: "#6b7280" }}>
                      ({new Date(a.administeredAt).toLocaleDateString()})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card
          title="Behavior"
          empty={
            pillars.behavior.pbisPositiveCount === 0 &&
            pillars.behavior.pbisNegativeCount === 0 &&
            pillars.behavior.supportNoteCount === 0 &&
            (data.trends?.pbisDaily?.length ?? 0) === 0
          }
        >
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem", flexWrap: "wrap" }}>
            <Chip label={`+${pillars.behavior.pbisPositiveCount} PBIS`} sev="info" />
            {pillars.behavior.pbisNegativeCount > 0 && (
              <Chip label={`-${pillars.behavior.pbisNegativeCount} PBIS`} sev="watch" />
            )}
            {pillars.behavior.supportNoteCount > 0 && (
              <Chip label={`${pillars.behavior.supportNoteCount} notes`} sev="watch" />
            )}
            {/* Corroborated separation signal: only renders once two or
                more different teachers have independently flagged this
                student in different pairings. Single-teacher flags are
                deliberately omitted here so a one-off classroom-
                management request never surfaces on a student profile.
                We show the count only — no teacher names, no paired-
                student details, no reason tags. */}
            {(pillars.behavior.separationFlagTeacherCount ?? 0) >= 2 && (
              <Chip
                label={`Flagged for separation in ${pillars.behavior.separationFlagTeacherCount} classrooms`}
                sev="watch"
              />
            )}
          </div>
          {data.trends.pbisDaily.length > 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                marginBottom: "0.6rem",
                fontSize: "0.75rem",
                color: "#6b7280",
              }}
            >
              <span style={{ minWidth: 90 }}>PBIS net / day</span>
              <Sparkline
                values={data.trends.pbisDaily.map((d) => d.net)}
                stroke="#0d9488"
                fill="#14b8a6"
                ariaLabel="Daily PBIS net (positives minus negatives) with intervention overlay"
                title={`Net PBIS by day in ${data.window.label.toLowerCase()}; vertical ticks mark intervention-logged days`}
                markerIndices={(() => {
                  // Map intervention day-keys to indices in pbisDaily so
                  // the sparkline can draw the overlay ticks at the right
                  // x-positions. Building a Map once is O(N) and cheaper
                  // than per-day indexOf when intervention counts grow.
                  const idx = new Map<string, number>();
                  data.trends.pbisDaily.forEach((d, i) => idx.set(d.day, i));
                  return (data.trends.interventionDays ?? [])
                    .map((d) => idx.get(d) ?? -1)
                    .filter((i) => i >= 0);
                })()}
                markerColor="#6366f1"
              />
              <span>
                {data.trends.pbisDaily.reduce((s, d) => s + d.net, 0) >= 0 ? "+" : ""}
                {data.trends.pbisDaily.reduce((s, d) => s + d.net, 0)} net
              </span>
              {(data.trends.interventionDays?.length ?? 0) > 0 && (
                <span style={{ color: "#6366f1" }} title="Intervention overlay">
                  · {data.trends.interventionDays.length} intervention day
                  {data.trends.interventionDays.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
          )}
          {pillars.behavior.recentSupportNotes.length > 0 && (
            <div style={{ marginBottom: "0.5rem" }}>
              <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>Recent notes</div>
              <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85rem" }}>
                {pillars.behavior.recentSupportNotes.slice(0, 5).map((n, i) => (
                  <li key={i}>
                    <strong>{n.noteType}</strong>: {n.noteText.slice(0, 120)}
                    <span style={{ color: "#6b7280" }}> — {n.staffName}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {pillars.behavior.recentPbis.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>Recent PBIS</div>
              <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85rem" }}>
                {pillars.behavior.recentPbis.slice(0, 5).map((p, i) => (
                  <li key={i}>
                    <span
                      style={{
                        color: p.polarity === "negative" ? "#991b1b" : "#0d9488",
                      }}
                    >
                      {p.polarity === "negative" ? "−" : "+"}
                      {p.points}
                    </span>{" "}
                    {p.reason}{" "}
                    <span style={{ color: "#6b7280" }}>— {p.staffName}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card
          title="Attendance & Flow"
          empty={
            pillars.flow.tardyCount === 0 &&
            pillars.flow.issDayCount === 0 &&
            pillars.flow.hallPassCount === 0 &&
            pillars.flow.recentPullouts.length === 0 &&
            (data.trends?.tardiesDaily?.length ?? 0) === 0
          }
        >
          <div style={{ display: "flex", gap: "0.4rem", marginBottom: "0.5rem", flexWrap: "wrap" }}>
            {pillars.flow.tardyCount > 0 && (
              <Chip label={`${pillars.flow.tardyCount} tardies`} sev={pillars.flow.tardyCount >= 5 ? "high" : "watch"} />
            )}
            {pillars.flow.issDayCount > 0 && (
              <Chip label={`${pillars.flow.issDayCount} ISS days`} sev="high" />
            )}
            {pillars.flow.hallPassCount > 0 && (
              <Chip
                label={`${pillars.flow.hallPassCount} hall passes (peer avg ${pillars.flow.hallPassSchoolAvg.toFixed(1)})`}
                sev={
                  pillars.flow.hallPassSchoolAvg > 0 &&
                  pillars.flow.hallPassCount > pillars.flow.hallPassSchoolAvg * 2
                    ? "watch"
                    : "info"
                }
              />
            )}
          </div>
          {data.trends.tardiesDaily.length > 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                marginBottom: "0.6rem",
                fontSize: "0.75rem",
                color: "#6b7280",
              }}
            >
              <span style={{ minWidth: 90 }}>Tardies / day</span>
              <Sparkline
                values={data.trends.tardiesDaily.map((d) => d.count)}
                stroke="#dc2626"
                fill="#fecaca"
                ariaLabel="Daily tardy count"
                title={`Tardies by day in ${data.window.label.toLowerCase()}`}
              />
              <span>
                {data.trends.tardiesDaily.reduce((s, d) => s + d.count, 0)} total
              </span>
            </div>
          )}
          {pillars.flow.recentPullouts.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>Recent pullouts</div>
              <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85rem" }}>
                {pillars.flow.recentPullouts.slice(0, 5).map((p, i) => (
                  <li key={i}>
                    <span style={{ color: "#6b7280" }}>
                      {new Date(p.requestedAt).toLocaleDateString()}
                    </span>{" "}
                    {p.reason} — {p.referringTeacherName} <em>({p.status})</em>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card
          title="Supports"
          empty={
            pillars.supports.activeAccommodationCount === 0 &&
            pillars.supports.activeMtssPlans.length === 0 &&
            pillars.supports.recentInterventions.length === 0 &&
            pillars.supports.trustedAdults.length === 0
          }
        >
          {pillars.supports.activeMtssPlans.length > 0 && (
            <div style={{ marginBottom: "0.5rem" }}>
              <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>
                Active MTSS plans
              </div>
              <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85rem" }}>
                {pillars.supports.activeMtssPlans.map((p) => {
                  const prog = (data.mtssProgress ?? []).find(
                    (m) => m.planId === p.id,
                  );
                  // Color the net-since-open chip by direction. We treat zero
                  // as a watch state too — a Tier 2/3 plan that hasn't moved
                  // the needle in 30+ days deserves an eye, even if nothing
                  // has gotten worse.
                  const netColor =
                    !prog || prog.pbisNetSinceOpen < 0
                      ? "#991b1b"
                      : prog.pbisNetSinceOpen > 0
                        ? "#0d9488"
                        : "#6b7280";
                  // Surface "no logged interventions" as a soft warning when
                  // the plan has been open long enough that activity should
                  // exist by now.
                  const stalled =
                    prog != null &&
                    prog.daysActive >= 14 &&
                    prog.interventionCount === 0;
                  return (
                    <li key={p.id} style={{ marginBottom: "0.35rem" }}>
                      <strong>Tier {p.tier}</strong>: {p.title}{" "}
                      <span style={{ color: "#6b7280" }}>
                        (opened {new Date(p.openedAt).toLocaleDateString()})
                      </span>
                      {prog && (
                        <div
                          style={{
                            marginTop: "0.2rem",
                            display: "flex",
                            flexWrap: "wrap",
                            gap: "0.4rem",
                            fontSize: "0.75rem",
                            color: "#6b7280",
                            alignItems: "center",
                          }}
                        >
                          <span>
                            {prog.daysActive} day
                            {prog.daysActive === 1 ? "" : "s"} active
                          </span>
                          <span>·</span>
                          <span style={{ color: stalled ? "#b45309" : "inherit" }}>
                            {prog.interventionCount} intervention
                            {prog.interventionCount === 1 ? "" : "s"} logged
                            {stalled ? " (stalled)" : ""}
                          </span>
                          <span>·</span>
                          <span style={{ color: netColor, fontWeight: 600 }}>
                            {prog.pbisNetSinceOpen >= 0 ? "+" : ""}
                            {prog.pbisNetSinceOpen} PBIS net since opened
                          </span>
                          <span style={{ color: "#9ca3af" }}>
                            ({prog.pbisPositiveSinceOpen}+ /{" "}
                            {prog.pbisNegativeSinceOpen}−)
                          </span>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {pillars.supports.activeAccommodationCount > 0 && (
            <div style={{ marginBottom: "0.5rem" }}>
              <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>
                Active accommodations ({pillars.supports.activeAccommodationCount})
              </div>
              <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85rem" }}>
                {pillars.supports.accommodations.slice(0, 6).map((a) => (
                  <li key={a.id}>{a.label ?? "(unnamed)"}</li>
                ))}
              </ul>
            </div>
          )}
          {pillars.supports.recentInterventions.length > 0 && (
            <div style={{ marginBottom: "0.5rem" }}>
              <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>
                Recent interventions
              </div>
              <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85rem" }}>
                {pillars.supports.recentInterventions.slice(0, 5).map((n, i) => (
                  <li key={i}>
                    {n.interventionType}{" "}
                    <span style={{ color: "#6b7280" }}>— {n.staffName}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {pillars.supports.trustedAdults.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>Trusted adults</div>
              <div>
                {pillars.supports.trustedAdults.map((t) => (
                  <Chip
                    key={t.id}
                    label={t.staffName ?? `Staff #${t.staffId}`}
                    sev="info"
                  />
                ))}
              </div>
            </div>
          )}
        </Card>

        <Card
          title="Family"
          empty={
            !pillars.family.parentName &&
            !pillars.family.parentEmail &&
            !pillars.family.parentPhone &&
            pillars.family.linkedParentAccountCount === 0
          }
        >
          {pillars.family.parentName && (
            <div>
              <strong>{pillars.family.parentName}</strong>
            </div>
          )}
          {pillars.family.parentEmail && (
            <div style={{ fontSize: "0.85rem" }}>
              <a href={`mailto:${pillars.family.parentEmail}`}>
                {pillars.family.parentEmail}
              </a>
            </div>
          )}
          {pillars.family.parentPhone && (
            <div style={{ fontSize: "0.85rem", color: "#6b7280" }}>
              {pillars.family.parentPhone}
            </div>
          )}
          <div style={{ marginTop: "0.4rem", fontSize: "0.8rem", color: "#6b7280" }}>
            {pillars.family.linkedParentAccountCount > 0
              ? `${pillars.family.linkedParentAccountCount} linked parent portal account${pillars.family.linkedParentAccountCount === 1 ? "" : "s"}`
              : "No parent portal account linked yet"}
          </div>
          {/* SIS-derived emergency contact slots (read-only). Blank
              slots are hidden so the block stays compact when only
              one or two slots are populated. */}
          {emergencyContacts.some((c) => c.name || c.phone) && (
            <div style={{ marginTop: "0.75rem" }}>
              <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: 4 }}>
                Emergency contacts
              </div>
              <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.85rem" }}>
                {emergencyContacts
                  .filter((c) => c.name || c.phone)
                  .map((c) => (
                    <li key={c.slot}>
                      <strong>{c.name ?? "(unnamed)"}</strong>
                      {c.relationship && (
                        <span style={{ color: "#6b7280" }}> — {c.relationship}</span>
                      )}
                      {c.phone && (
                        <div style={{ color: "#6b7280" }}>{c.phone}</div>
                      )}
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </Card>
      </div>

      <div
        className="card"
        style={{ marginTop: "1rem", padding: "1rem 1.25rem" }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "0.75rem",
            flexWrap: "wrap",
          }}
        >
          <h3 style={{ margin: 0, color: "#7c3aed", fontSize: "1.05rem" }}>
            Intervention history
          </h3>
          <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
            {historyRows.length === 0
              ? ""
              : `${historyRows.length} entr${historyRows.length === 1 ? "y" : "ies"} — newest first`}
          </span>
        </div>
        <p
          style={{
            margin: "0.25rem 0 0.75rem",
            color: "var(--text-subtle, #64748b)",
            fontSize: "0.85rem",
          }}
        >
          Every Tier 2, Tier 3, Trusted-Adult, and Quick Check-in entry
          recorded for this student, across all staff who logged them.
        </p>
        {historyErr && (
          <div
            style={{
              padding: "0.5rem 0.75rem",
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#b91c1c",
              borderRadius: 6,
              marginBottom: "0.5rem",
            }}
          >
            {historyErr}
          </div>
        )}
        {historyLoading ? (
          <div style={{ color: "#64748b" }}>Loading…</div>
        ) : historyRows.length === 0 ? (
          <p style={{ color: "var(--text-subtle, #64748b)", margin: 0 }}>
            No interventions logged for this student yet.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="pulse-table"
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.85rem",
              }}
            >
              <thead>
                <tr
                  style={{
                    textAlign: "left",
                    borderBottom: "2px solid #cbd5e1",
                    background: "#f8fafc",
                  }}
                >
                  <th
                    style={{
                      padding: "0.5rem",
                      fontSize: "0.72rem",
                      color: "#64748b",
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                      whiteSpace: "nowrap",
                    }}
                  >
                    Date
                  </th>
                  <th
                    style={{
                      padding: "0.5rem",
                      fontSize: "0.72rem",
                      color: "#64748b",
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                    }}
                  >
                    Type
                  </th>
                  <th
                    style={{
                      padding: "0.5rem",
                      fontSize: "0.72rem",
                      color: "#64748b",
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                    }}
                  >
                    Logged by
                  </th>
                  <th
                    style={{
                      padding: "0.5rem",
                      fontSize: "0.72rem",
                      color: "#64748b",
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                    }}
                  >
                    Detail
                  </th>
                </tr>
              </thead>
              <tbody>
                {historyRows.map((r) => {
                  const tierColor =
                    r.tier === "t2"
                      ? { bg: "#fef3c7", fg: "#92400e", bd: "#fde68a" }
                      : r.tier === "t3"
                        ? { bg: "#ede9fe", fg: "#5b21b6", bd: "#c4b5fd" }
                        : r.tier === "quick"
                          ? { bg: "#dbeafe", fg: "#1e40af", bd: "#93c5fd" }
                          : { bg: "#f1f5f9", fg: "#475569", bd: "#cbd5e1" };
                  return (
                    <tr
                      key={`${r.source}-${r.sourceId}`}
                      style={{ borderBottom: "1px solid #f1f5f9" }}
                    >
                      <td style={{ padding: "0.5rem", whiteSpace: "nowrap" }}>
                        {r.date}
                      </td>
                      <td style={{ padding: "0.5rem" }}>
                        <span
                          style={{
                            padding: "2px 8px",
                            borderRadius: 999,
                            fontWeight: 600,
                            fontSize: "0.72rem",
                            background: tierColor.bg,
                            color: tierColor.fg,
                            border: `1px solid ${tierColor.bd}`,
                          }}
                        >
                          {r.typeLabel}
                        </span>
                      </td>
                      <td style={{ padding: "0.5rem" }}>
                        {r.staffName || "—"}
                      </td>
                      <td
                        style={{
                          padding: "0.5rem",
                          color: r.detail ? "#0f172a" : "#cbd5e1",
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        {r.detail || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
