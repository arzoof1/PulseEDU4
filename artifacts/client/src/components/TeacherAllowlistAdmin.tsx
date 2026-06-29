import { useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, RoleSection } from "./HowToUseHelp";

export interface RestroomAreaMeta {
  area: string;
  memberNames: string[];
}

// Rows posted to the bulk endpoint. Email is the locked matcher; name is a
// fallback only when unambiguous; area is the restroom-area name (blank clears).
type BulkUploadRow = { email: string; name: string; area: string };

type ZoneRuleRow = { roomFrom: number; roomTo: number; restroomArea: string };

type BulkResult = {
  committed: boolean;
  applied: number;
  batchId: number | null;
  matched: Array<{ staffName: string; area: string; grants: number }>;
  unmatchedTeachers: string[];
  invalidAreas: Array<{ teacher: string; area: string }>;
  knownAreas: string[];
};

// CSV cell with formula-injection neutralization (prefix a leading =,+,-,@,tab,
// or CR with an apostrophe) plus standard quote escaping.
function csvCell(v: string | number | null | undefined): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Minimal RFC-4180-ish CSV parser (handles quoted fields, escaped quotes, and
// CRLF/LF). Maps header columns by name so column order can drift in Excel.
function parseCsvUpload(text: string): BulkUploadRow[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
    } else if (c === "\r") {
      // swallow; the following \n closes the row
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const emailIdx = header.findIndex((h) => h.includes("email"));
  const nameIdx = header.findIndex(
    (h) => h.includes("teacher") || h === "name" || h.includes("staff"),
  );
  const areaIdx = header.findIndex(
    (h) => h.includes("restroom") || h.includes("area"),
  );
  const out: BulkUploadRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.every((c) => c.trim() === "")) continue;
    const email = emailIdx >= 0 ? (cells[emailIdx] ?? "").trim() : "";
    const name = nameIdx >= 0 ? (cells[nameIdx] ?? "").trim() : "";
    const area = areaIdx >= 0 ? (cells[areaIdx] ?? "").trim() : "";
    if (!email && !name) continue;
    out.push({ email, name, area });
  }
  return out;
}

interface Props {
  staffUsers: string[];
  allDestinations: string[];
  allowlistMap: Record<string, string[]>;
  onChange: (next: Record<string, string[]>) => void;
  onEditLocations?: () => void;
  // Re-fetch the allowlist map from the server (after a bulk commit/rollback
  // changes many teachers at once, the in-memory map must be refreshed).
  onReload?: () => void;
  // Named restroom groups (boys + girls variants). Rendered as ONE column;
  // toggling expands client-side to every member name so assigning the area
  // grants both variants at once.
  restroomAreas?: RestroomAreaMeta[];
  // Facilities (office/clinic/nurse) granted to EVERY teacher automatically.
  // Shown as an info banner and kept OUT of the per-teacher grid columns.
  schoolWideDefaults?: string[];
}

// A checkbox that can render the "some but not all" indeterminate dash.
function TriCheck({
  state,
  disabled,
  onToggle,
  title,
}: {
  state: "all" | "some" | "none";
  disabled?: boolean;
  onToggle: () => void;
  title?: string;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === "all"}
      disabled={disabled}
      onChange={onToggle}
      title={title}
    />
  );
}

type Col =
  | { kind: "single"; name: string; tier: 0 | 1 | 2 }
  | { kind: "area"; area: string; members: string[] };

export default function TeacherAllowlistAdmin({
  staffUsers,
  allDestinations,
  allowlistMap,
  onChange,
  onEditLocations,
  onReload,
  restroomAreas = [],
  schoolWideDefaults = [],
}: Props) {
  const [filter, setFilter] = useState("");
  const [savingFor, setSavingFor] = useState<string | null>(null);
  const [errorFor, setErrorFor] = useState<{ name: string; msg: string } | null>(
    null,
  );
  const [bulkBusy, setBulkBusy] = useState<string | null>(null);

  // ---- Bulk CSV round-trip (Phase 2) -------------------------------------
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [csvBusy, setCsvBusy] = useState<
    "download" | "preview" | "commit" | "rollback" | null
  >(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [csvNotice, setCsvNotice] = useState<string | null>(null);
  const [csvPreview, setCsvPreview] = useState<BulkResult | null>(null);
  const [csvRows, setCsvRows] = useState<BulkUploadRow[] | null>(null);
  const [lastBatch, setLastBatch] = useState<{
    id: number;
    appliedCount: number;
    createdAt: string;
  } | null>(null);

  // ---- Zone rules (Phase 3) ----------------------------------------------
  const [zoneRules, setZoneRules] = useState<ZoneRuleRow[]>([]);
  const [zoneOpen, setZoneOpen] = useState(false);
  const [zoneBusy, setZoneBusy] = useState<
    "load" | "save" | "preview" | null
  >(null);
  const [zoneError, setZoneError] = useState<string | null>(null);
  const [zoneSaved, setZoneSaved] = useState(false);
  // True when the current preview came from the zone auto-assign (so commit
  // posts back to the auto-assign endpoint, not the CSV /bulk endpoint).
  const [zoneAutoAssign, setZoneAutoAssign] = useState(false);

  const loadZoneRules = () => {
    setZoneBusy("load");
    authFetch("/api/teacher-allowlist/zone-rules")
      .then((r) => (r.ok ? r.json() : { rules: [] }))
      .then((j: { rules?: ZoneRuleRow[] }) =>
        setZoneRules(Array.isArray(j.rules) ? j.rules : []),
      )
      .catch(() => {})
      .finally(() => setZoneBusy(null));
  };
  useEffect(() => {
    if (zoneOpen && zoneRules.length === 0) loadZoneRules();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoneOpen]);

  async function saveZoneRules() {
    setZoneBusy("save");
    setZoneError(null);
    setZoneSaved(false);
    try {
      const clean = zoneRules
        .map((r) => ({
          roomFrom: Number(r.roomFrom),
          roomTo: Number(r.roomTo),
          restroomArea: (r.restroomArea ?? "").trim(),
        }))
        .filter(
          (r) =>
            Number.isInteger(r.roomFrom) &&
            Number.isInteger(r.roomTo) &&
            r.restroomArea.length > 0,
        );
      const res = await authFetch("/api/teacher-allowlist/zone-rules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules: clean }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d?.error || "Save failed.");
      }
      setZoneSaved(true);
    } catch (e) {
      setZoneError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setZoneBusy(null);
    }
  }

  async function autoAssignFromZones() {
    setCsvError(null);
    setCsvNotice(null);
    setCsvPreview(null);
    setCsvRows(null);
    setZoneBusy("preview");
    try {
      const res = await authFetch(
        "/api/teacher-allowlist/zone-rules/auto-assign",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commit: false }),
        },
      );
      const data = (await res.json()) as BulkResult & {
        error?: string;
        skippedNoRoom?: number;
        skippedNoRule?: number;
      };
      if (!res.ok) throw new Error(data?.error || "Auto-assign failed.");
      setCsvPreview(data);
      // No CSV rows to re-post; flag this as a zone auto-assign so commit posts
      // to the auto-assign endpoint instead of the bulk endpoint.
      setCsvRows(null);
      setZoneAutoAssign(true);
    } catch (e) {
      setCsvError(e instanceof Error ? e.message : "Auto-assign failed.");
    } finally {
      setZoneBusy(null);
    }
  }

  const refreshLastBatch = () => {
    authFetch("/api/teacher-allowlist/bulk/last")
      .then((r) => (r.ok ? r.json() : { batch: null }))
      .then((j: { batch: typeof lastBatch }) => setLastBatch(j.batch ?? null))
      .catch(() => {});
  };
  useEffect(() => {
    refreshLastBatch();
  }, []);

  async function downloadTemplate() {
    setCsvBusy("download");
    setCsvError(null);
    try {
      const res = await authFetch("/api/teacher-allowlist/template");
      if (!res.ok) throw new Error("Could not build the template.");
      const data = (await res.json()) as {
        columns: string[];
        rows: Array<{
          staffName: string;
          email: string;
          room: string;
          restroomArea: string;
        }>;
      };
      const lines = [
        data.columns.map(csvCell).join(","),
        ...data.rows.map((r) =>
          [r.staffName, r.email, r.room, r.restroomArea]
            .map(csvCell)
            .join(","),
        ),
      ];
      const blob = new Blob([lines.join("\r\n")], {
        type: "text/csv;charset=utf-8;",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "hall-pass-restroom-areas.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setCsvError(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setCsvBusy(null);
    }
  }

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setCsvError(null);
    setCsvNotice(null);
    setCsvPreview(null);
    setCsvRows(null);
    setCsvBusy("preview");
    try {
      const text = await file.text();
      const rows = parseCsvUpload(text);
      if (rows.length === 0)
        throw new Error("No data rows found in that file.");
      const res = await authFetch("/api/teacher-allowlist/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, commit: false }),
      });
      const data = (await res.json()) as BulkResult & { error?: string };
      if (!res.ok) throw new Error(data?.error || "Preview failed.");
      setCsvPreview(data);
      setCsvRows(rows);
    } catch (err) {
      setCsvError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setCsvBusy(null);
    }
  }

  async function commitUpload() {
    // Two commit sources share this preview UI: a CSV upload (csvRows set) and
    // the zone auto-assign (zoneAutoAssign set, no rows). Pick the endpoint.
    if (!csvRows && !zoneAutoAssign) return;
    setCsvBusy("commit");
    setCsvError(null);
    try {
      const res = zoneAutoAssign
        ? await authFetch("/api/teacher-allowlist/zone-rules/auto-assign", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ commit: true }),
          })
        : await authFetch("/api/teacher-allowlist/bulk", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rows: csvRows, commit: true }),
          });
      const data = (await res.json()) as BulkResult & { error?: string };
      if (!res.ok) throw new Error(data?.error || "Commit failed.");
      setCsvNotice(
        `Applied restroom areas to ${data.applied} teacher${
          data.applied === 1 ? "" : "s"
        }.`,
      );
      setCsvPreview(null);
      setCsvRows(null);
      setZoneAutoAssign(false);
      refreshLastBatch();
      onReload?.();
    } catch (err) {
      setCsvError(err instanceof Error ? err.message : "Commit failed.");
    } finally {
      setCsvBusy(null);
    }
  }

  async function rollbackLast() {
    if (!lastBatch) return;
    setCsvBusy("rollback");
    setCsvError(null);
    try {
      const res = await authFetch(
        `/api/teacher-allowlist/bulk/${lastBatch.id}/rollback`,
        { method: "POST" },
      );
      const data = (await res.json()) as { restored?: number; error?: string };
      if (!res.ok) throw new Error(data?.error || "Undo failed.");
      setCsvNotice(
        `Restored the previous allowlist for ${data.restored ?? 0} teacher${
          data.restored === 1 ? "" : "s"
        }.`,
      );
      setCsvPreview(null);
      setCsvRows(null);
      refreshLastBatch();
      onReload?.();
    } catch (err) {
      setCsvError(err instanceof Error ? err.message : "Undo failed.");
    } finally {
      setCsvBusy(null);
    }
  }

  // Column tiering — restrooms (blueish) → facilities (reddish) → teacher
  // rooms (no tint). Restroom AREAS always sort into the restroom band.
  const RESTROOM_RE = /(restroom|bathroom|\brr\b|\bwc\b)/i;
  const FACILITY_RE =
    /(office|clinic|nurse|guidance|counsel|library|media|cafeteria|cafe|gym|front\s*desk|admin|reception|isr|iss\b|ess\b|principal|dean|attendance|wellness|conference)/i;
  const TEACHER_RE = /\s[—–-]\s/;
  const tierOf = (name: string): 0 | 1 | 2 => {
    if (RESTROOM_RE.test(name)) return 0;
    if (TEACHER_RE.test(name) && !FACILITY_RE.test(name)) return 2;
    return 1;
  };

  const collator = useMemo(
    () => new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }),
    [],
  );

  // Build column descriptors:
  //   • Facilities granted school-wide are removed (auto-granted; shown in a
  //     banner instead — they never need a per-teacher toggle).
  //   • Restroom-area members collapse into one area column.
  //   • Everything else stays a single column.
  const columns = useMemo(() => {
    const areaList = restroomAreas.filter((a) => a.memberNames.length > 0);
    const areaMembers = new Set(areaList.flatMap((a) => a.memberNames));
    const swSet = new Set(schoolWideDefaults);
    const singles = allDestinations.filter(
      (d) => !swSet.has(d) && !areaMembers.has(d),
    );
    const cols: Col[] = [
      ...areaList.map(
        (a): Col => ({ kind: "area", area: a.area, members: a.memberNames }),
      ),
      ...singles.map((d): Col => ({ kind: "single", name: d, tier: tierOf(d) })),
    ];
    const tierOfCol = (c: Col) => (c.kind === "area" ? 0 : c.tier);
    const labelOfCol = (c: Col) => (c.kind === "area" ? c.area : c.name);
    cols.sort((a, b) => {
      const ta = tierOfCol(a);
      const tb = tierOfCol(b);
      if (ta !== tb) return ta - tb;
      return collator.compare(labelOfCol(a), labelOfCol(b));
    });
    return cols;
    // tierOf is pure; collator stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDestinations, restroomAreas, schoolWideDefaults, collator]);

  // Known restroom-area names for the zone-rule area picker (datalist).
  const areaNames = useMemo(
    () => restroomAreas.map((a) => a.area).sort((a, b) => a.localeCompare(b)),
    [restroomAreas],
  );

  const sortedStaff = useMemo(
    () =>
      [...staffUsers]
        .filter((s) => s)
        .sort((a, b) => a.localeCompare(b))
        .filter((s) => s.toLowerCase().includes(filter.trim().toLowerCase())),
    [staffUsers, filter],
  );

  // Names addressed by a column (one for single, all members for an area).
  const namesOf = (c: Col): string[] =>
    c.kind === "area" ? c.members : [c.name];

  const colState = (
    allowed: Set<string>,
    c: Col,
  ): "all" | "some" | "none" => {
    const names = namesOf(c);
    const present = names.filter((n) => allowed.has(n)).length;
    if (present === 0) return "none";
    if (present === names.length) return "all";
    return "some";
  };

  // PUT a teacher's full destination list (optimistic, with rollback). This is
  // the single write primitive; toggles build the full next list and call it.
  const save = (staffName: string, destinations: string[]) => {
    const sorted = [...new Set(destinations)].sort();
    const prior = allowlistMap[staffName];
    const next = { ...allowlistMap };
    if (sorted.length === 0) delete next[staffName];
    else next[staffName] = sorted;
    onChange(next);
    setErrorFor(null);
    setSavingFor(staffName);

    void (async () => {
      try {
        const res = await authFetch(
          `/api/teacher-allowlist/${encodeURIComponent(staffName)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ destinations: sorted }),
          },
        );
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || "Save failed.");
        }
      } catch (e: unknown) {
        const rollback = { ...allowlistMap };
        if (prior === undefined) delete rollback[staffName];
        else rollback[staffName] = prior;
        onChange(rollback);
        setErrorFor({
          name: staffName,
          msg: e instanceof Error ? e.message : "Save failed.",
        });
      } finally {
        setSavingFor((cur) => (cur === staffName ? null : cur));
      }
    })();
  };

  // Add/remove a SET of names for one teacher. For an area this grants/revokes
  // both gendered variants at once.
  const toggleColumn = (staffName: string, c: Col) => {
    const allowed = new Set(allowlistMap[staffName] ?? []);
    const names = namesOf(c);
    const turnOn = colState(allowed, c) !== "all";
    for (const n of names) {
      if (turnOn) allowed.add(n);
      else allowed.delete(n);
    }
    save(staffName, Array.from(allowed));
  };

  const bulkToggleColumn = async (c: Col, turnOn: boolean) => {
    const key = c.kind === "area" ? `area:${c.area}` : c.name;
    setBulkBusy(key);
    setErrorFor(null);
    const names = namesOf(c);

    const changes: { staffName: string; destinations: string[] }[] = [];
    const optimistic: Record<string, string[]> = { ...allowlistMap };
    for (const staffName of sortedStaff) {
      const current = new Set(allowlistMap[staffName] ?? []);
      const before = current.size;
      for (const n of names) {
        if (turnOn) current.add(n);
        else current.delete(n);
      }
      if (current.size === before && turnOn) {
        // already had everything (or area members) — but adding a missing
        // member still changes size; only skip when nothing changed.
        const allHad = names.every((n) => (allowlistMap[staffName] ?? []).includes(n));
        if (allHad) continue;
      }
      if (!turnOn) {
        const hadAny = names.some((n) =>
          (allowlistMap[staffName] ?? []).includes(n),
        );
        if (!hadAny) continue;
      }
      const destinations = Array.from(current).sort();
      changes.push({ staffName, destinations });
      if (destinations.length === 0) delete optimistic[staffName];
      else optimistic[staffName] = destinations;
    }
    if (changes.length === 0) {
      setBulkBusy(null);
      return;
    }
    onChange(optimistic);

    const results = await Promise.all(
      changes.map(async ({ staffName, destinations }) => {
        try {
          const res = await authFetch(
            `/api/teacher-allowlist/${encodeURIComponent(staffName)}`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ destinations }),
            },
          );
          if (!res.ok) throw new Error(await res.text());
          return { staffName, ok: true as const };
        } catch (e) {
          return {
            staffName,
            ok: false as const,
            msg: e instanceof Error ? e.message : "Save failed.",
          };
        }
      }),
    );

    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      const rolled: Record<string, string[]> = { ...optimistic };
      for (const f of failed) {
        const prev = allowlistMap[f.staffName] ?? [];
        if (prev.length === 0) delete rolled[f.staffName];
        else rolled[f.staffName] = prev;
      }
      onChange(rolled);
      const first = failed[0];
      setErrorFor({
        name: first.staffName,
        msg:
          failed.length === 1
            ? (first as { msg: string }).msg
            : `${failed.length} rows failed to save (first: ${first.staffName}).`,
      });
    }
    setBulkBusy(null);
  };

  const sortedSchoolWide = useMemo(
    () => [...schoolWideDefaults].sort((a, b) => collator.compare(a, b)),
    [schoolWideDefaults, collator],
  );

  return (
    <div className="card" style={{ marginTop: "1rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "0.75rem",
          flexWrap: "wrap",
        }}
      >
        <h2 style={{ margin: 0 }}>Allowed Locations per Teacher</h2>
        {onEditLocations && (
          <button
            type="button"
            onClick={onEditLocations}
            title="Add, rename, or remove the locations that appear as columns below."
            style={{
              background: "#f1f5f9",
              color: "#0f172a",
              border: "1px solid #cbd5e1",
              padding: "0.35rem 0.7rem",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: "0.85rem",
              whiteSpace: "nowrap",
            }}
          >
            Edit locations →
          </button>
        )}
      </div>
      <p style={{ color: "var(--text-subtle)", marginTop: "0.5rem" }}>
        Pick the destinations each teacher can send students to without
        confirming contact (typically the closest restrooms or rooms next
        door). Anything outside this list will require the teacher to check
        "I've contacted them" before sending. Hall&nbsp;Pass admins skip this
        check entirely.
        {onEditLocations && (
          <>
            {" "}
            Need a new column?{" "}
            <button
              type="button"
              onClick={onEditLocations}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                color: "#2563eb",
                cursor: "pointer",
                textDecoration: "underline",
                font: "inherit",
              }}
            >
              Edit locations
            </button>
            .
          </>
        )}
      </p>

      {sortedSchoolWide.length > 0 && (
        <div
          style={{
            background: "#f0fdf4",
            border: "1px solid #bbf7d0",
            borderRadius: 8,
            padding: "0.6rem 0.75rem",
            marginBottom: "0.75rem",
            fontSize: "0.85rem",
            color: "#166534",
          }}
        >
          <strong>Auto-granted to everyone:</strong>{" "}
          {sortedSchoolWide.join(", ")}. These facilities are always available
          from every classroom — no per-teacher setup needed, so they're not
          shown as columns below.
        </div>
      )}

      {restroomAreas.some((a) => a.memberNames.length > 1) && (
        <div
          style={{
            background: "#eff6ff",
            border: "1px solid #bfdbfe",
            borderRadius: 8,
            padding: "0.6rem 0.75rem",
            marginBottom: "0.75rem",
            fontSize: "0.85rem",
            color: "#1e40af",
          }}
        >
          <strong>Restroom areas</strong> bundle the boys + girls restrooms in
          one part of the building. Checking an area column grants both variants
          to that teacher in one click.
        </div>
      )}

      <div
        style={{
          background: "#fafafa",
          border: "1px solid #e2e8f0",
          borderRadius: 8,
          padding: "0.75rem 0.85rem",
          marginBottom: "0.75rem",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.6rem",
            flexWrap: "wrap",
          }}
        >
          <strong style={{ fontSize: "0.9rem" }}>
            Bulk assign restroom areas (Excel)
          </strong>
          <button
            type="button"
            onClick={downloadTemplate}
            disabled={csvBusy !== null}
            style={{
              background: "#1d4ed8",
              color: "#fff",
              border: "none",
              padding: "0.35rem 0.7rem",
              borderRadius: 6,
              cursor: csvBusy ? "default" : "pointer",
              fontSize: "0.82rem",
            }}
          >
            {csvBusy === "download" ? "Building…" : "Download template"}
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={csvBusy !== null}
            style={{
              background: "#f1f5f9",
              color: "#0f172a",
              border: "1px solid #cbd5e1",
              padding: "0.35rem 0.7rem",
              borderRadius: 6,
              cursor: csvBusy ? "default" : "pointer",
              fontSize: "0.82rem",
            }}
          >
            {csvBusy === "preview" ? "Reading…" : "Upload filled CSV"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            onChange={onFilePicked}
            style={{ display: "none" }}
          />
          {lastBatch && (
            <button
              type="button"
              onClick={rollbackLast}
              disabled={csvBusy !== null}
              title={`Restores the allowlist for ${lastBatch.appliedCount} teacher(s) to the state before the last upload.`}
              style={{
                background: "#fff",
                color: "#b91c1c",
                border: "1px solid #fecaca",
                padding: "0.35rem 0.7rem",
                borderRadius: 6,
                cursor: csvBusy ? "default" : "pointer",
                fontSize: "0.82rem",
                marginLeft: "auto",
              }}
            >
              {csvBusy === "rollback" ? "Undoing…" : "Undo last upload"}
            </button>
          )}
        </div>
        <p
          style={{
            margin: "0.5rem 0 0",
            fontSize: "0.8rem",
            color: "var(--text-subtle)",
          }}
        >
          Download the pre-filled template, set the <em>Restroom Area</em> column
          for each teacher in Excel, then upload it back. Teachers are matched by{" "}
          <strong>email</strong> — only the teachers in the file are changed, and
          their manual room grants are preserved. Leave the area blank to clear a
          teacher's restrooms.
        </p>

        {csvError && (
          <div
            style={{
              marginTop: "0.5rem",
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: 6,
              padding: "0.5rem 0.6rem",
              fontSize: "0.82rem",
              color: "#991b1b",
            }}
          >
            {csvError}
          </div>
        )}
        {csvNotice && (
          <div
            style={{
              marginTop: "0.5rem",
              background: "#f0fdf4",
              border: "1px solid #bbf7d0",
              borderRadius: 6,
              padding: "0.5rem 0.6rem",
              fontSize: "0.82rem",
              color: "#166534",
            }}
          >
            {csvNotice}
          </div>
        )}

        <div
          style={{
            marginTop: "0.75rem",
            paddingTop: "0.6rem",
            borderTop: "1px dashed #cbd5e1",
          }}
        >
          <button
            type="button"
            onClick={() => setZoneOpen((v) => !v)}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: "pointer",
              fontSize: "0.9rem",
              fontWeight: 600,
              color: "#0f172a",
            }}
          >
            {zoneOpen ? "▾" : "▸"} Zone rules (auto-suggest by room number)
          </button>
          {zoneOpen && (
            <div style={{ marginTop: "0.5rem" }}>
              <p
                style={{
                  margin: "0 0 0.5rem",
                  fontSize: "0.8rem",
                  color: "var(--text-subtle)",
                }}
              >
                Map a range of room numbers to a restroom area. The first
                matching rule wins. Rules pre-fill the template's{" "}
                <em>Restroom Area</em> column and power one-click auto-assign.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {zoneRules.map((rule, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      gap: 6,
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <span style={{ fontSize: "0.8rem" }}>Rooms</span>
                    <input
                      type="number"
                      value={Number.isFinite(rule.roomFrom) ? rule.roomFrom : ""}
                      onChange={(e) =>
                        setZoneRules((rs) =>
                          rs.map((r, j) =>
                            j === i
                              ? { ...r, roomFrom: Number(e.target.value) }
                              : r,
                          ),
                        )
                      }
                      style={{
                        width: 80,
                        padding: "0.3rem 0.4rem",
                        border: "1px solid #cbd5e1",
                        borderRadius: 6,
                        fontSize: "0.82rem",
                      }}
                    />
                    <span style={{ fontSize: "0.8rem" }}>to</span>
                    <input
                      type="number"
                      value={Number.isFinite(rule.roomTo) ? rule.roomTo : ""}
                      onChange={(e) =>
                        setZoneRules((rs) =>
                          rs.map((r, j) =>
                            j === i
                              ? { ...r, roomTo: Number(e.target.value) }
                              : r,
                          ),
                        )
                      }
                      style={{
                        width: 80,
                        padding: "0.3rem 0.4rem",
                        border: "1px solid #cbd5e1",
                        borderRadius: 6,
                        fontSize: "0.82rem",
                      }}
                    />
                    <span style={{ fontSize: "0.8rem" }}>→</span>
                    <input
                      type="text"
                      list="zone-area-list"
                      placeholder="Restroom area"
                      value={rule.restroomArea}
                      onChange={(e) =>
                        setZoneRules((rs) =>
                          rs.map((r, j) =>
                            j === i
                              ? { ...r, restroomArea: e.target.value }
                              : r,
                          ),
                        )
                      }
                      style={{
                        flex: "1 1 160px",
                        minWidth: 140,
                        padding: "0.3rem 0.4rem",
                        border: "1px solid #cbd5e1",
                        borderRadius: 6,
                        fontSize: "0.82rem",
                      }}
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setZoneRules((rs) => rs.filter((_, j) => j !== i))
                      }
                      title="Remove rule"
                      style={{
                        background: "#fff",
                        color: "#b91c1c",
                        border: "1px solid #fecaca",
                        borderRadius: 6,
                        padding: "0.3rem 0.5rem",
                        cursor: "pointer",
                        fontSize: "0.82rem",
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <datalist id="zone-area-list">
                  {areaNames.map((a) => (
                    <option key={a} value={a} />
                  ))}
                </datalist>
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  marginTop: "0.5rem",
                  flexWrap: "wrap",
                }}
              >
                <button
                  type="button"
                  onClick={() =>
                    setZoneRules((rs) => [
                      ...rs,
                      { roomFrom: 0, roomTo: 0, restroomArea: "" },
                    ])
                  }
                  style={{
                    background: "#f1f5f9",
                    color: "#0f172a",
                    border: "1px solid #cbd5e1",
                    padding: "0.35rem 0.7rem",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontSize: "0.82rem",
                  }}
                >
                  + Add rule
                </button>
                <button
                  type="button"
                  onClick={saveZoneRules}
                  disabled={zoneBusy !== null}
                  style={{
                    background: "#1d4ed8",
                    color: "#fff",
                    border: "none",
                    padding: "0.35rem 0.7rem",
                    borderRadius: 6,
                    cursor: zoneBusy ? "default" : "pointer",
                    fontSize: "0.82rem",
                  }}
                >
                  {zoneBusy === "save" ? "Saving…" : "Save rules"}
                </button>
                <button
                  type="button"
                  onClick={autoAssignFromZones}
                  disabled={zoneBusy !== null || csvBusy !== null}
                  title="Preview applying every zone rule to all teachers by their room number."
                  style={{
                    background: "#0d9488",
                    color: "#fff",
                    border: "none",
                    padding: "0.35rem 0.7rem",
                    borderRadius: 6,
                    cursor:
                      zoneBusy || csvBusy ? "default" : "pointer",
                    fontSize: "0.82rem",
                  }}
                >
                  {zoneBusy === "preview"
                    ? "Building preview…"
                    : "Auto-assign all from rules"}
                </button>
              </div>
              {zoneSaved && (
                <div
                  style={{
                    marginTop: "0.4rem",
                    fontSize: "0.8rem",
                    color: "#166534",
                  }}
                >
                  Zone rules saved.
                </div>
              )}
              {zoneError && (
                <div
                  style={{
                    marginTop: "0.4rem",
                    fontSize: "0.8rem",
                    color: "#991b1b",
                  }}
                >
                  {zoneError}
                </div>
              )}
            </div>
          )}
        </div>

        {csvPreview && (
          <div
            style={{
              marginTop: "0.6rem",
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              padding: "0.6rem 0.7rem",
              background: "#fff",
              fontSize: "0.82rem",
            }}
          >
            <div style={{ marginBottom: "0.4rem" }}>
              <strong>Preview:</strong> {csvPreview.matched.length} teacher
              {csvPreview.matched.length === 1 ? "" : "s"} matched
              {csvPreview.unmatchedTeachers.length > 0 && (
                <span style={{ color: "#b45309" }}>
                  {" "}
                  · {csvPreview.unmatchedTeachers.length} unmatched
                </span>
              )}
              {csvPreview.invalidAreas.length > 0 && (
                <span style={{ color: "#b91c1c" }}>
                  {" "}
                  · {csvPreview.invalidAreas.length} unknown area
                  {csvPreview.invalidAreas.length === 1 ? "" : "s"}
                </span>
              )}
            </div>

            {csvPreview.unmatchedTeachers.length > 0 && (
              <div style={{ color: "#92400e", marginBottom: "0.35rem" }}>
                <strong>Not matched (skipped):</strong>{" "}
                {csvPreview.unmatchedTeachers.slice(0, 20).join(", ")}
                {csvPreview.unmatchedTeachers.length > 20 &&
                  ` +${csvPreview.unmatchedTeachers.length - 20} more`}
              </div>
            )}
            {csvPreview.invalidAreas.length > 0 && (
              <div style={{ color: "#991b1b", marginBottom: "0.35rem" }}>
                <strong>Unknown restroom areas (skipped):</strong>{" "}
                {csvPreview.invalidAreas
                  .slice(0, 20)
                  .map((x) => `${x.teacher} → "${x.area}"`)
                  .join(", ")}
                . Known areas:{" "}
                {csvPreview.knownAreas.length > 0
                  ? csvPreview.knownAreas.join(", ")
                  : "(none configured)"}
                .
              </div>
            )}

            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                marginTop: "0.5rem",
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                onClick={commitUpload}
                disabled={csvBusy !== null || csvPreview.matched.length === 0}
                style={{
                  background:
                    csvPreview.matched.length === 0 ? "#94a3b8" : "#16a34a",
                  color: "#fff",
                  border: "none",
                  padding: "0.4rem 0.85rem",
                  borderRadius: 6,
                  cursor:
                    csvBusy || csvPreview.matched.length === 0
                      ? "default"
                      : "pointer",
                  fontSize: "0.82rem",
                }}
              >
                {csvBusy === "commit"
                  ? "Applying…"
                  : `Apply to ${csvPreview.matched.length} teacher${
                      csvPreview.matched.length === 1 ? "" : "s"
                    }`}
              </button>
              <button
                type="button"
                onClick={() => {
                  setCsvPreview(null);
                  setCsvRows(null);
                  setZoneAutoAssign(false);
                }}
                disabled={csvBusy !== null}
                style={{
                  background: "#f1f5f9",
                  color: "#0f172a",
                  border: "1px solid #cbd5e1",
                  padding: "0.4rem 0.85rem",
                  borderRadius: 6,
                  cursor: csvBusy ? "default" : "pointer",
                  fontSize: "0.82rem",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <HowToUseHelp title="How to use the Teacher Allowlist">
        <HowToSection title="What it does">
          Reduces friction for the destinations each teacher uses
          every day (their closest bathrooms, the room next door)
          while keeping the contact-confirmation guardrail for
          everywhere else.
        </HowToSection>
        <RoleSection for={["admin", "coreTeam"]} title="Quick setup">
          For most teachers, two or three destinations cover 90% of
          their passes. Add too many and you defeat the purpose —
          this list should be small.
        </RoleSection>
      </HowToUseHelp>
      <input
        type="text"
        placeholder="Filter staff…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{ marginBottom: "0.75rem", maxWidth: "20rem" }}
      />
      <div style={{ overflowX: "auto" }}>
        <table
          className="pulse-table"
          style={{
            borderCollapse: "collapse",
            width: "100%",
            fontSize: "0.9rem",
          }}
        >
          <thead>
            <tr>
              <th
                style={{
                  textAlign: "left",
                  padding: "0.4rem 0.5rem",
                  borderBottom: "1px solid #e2e8f0",
                  position: "sticky",
                  left: 0,
                  background: "#fff",
                  minWidth: "10rem",
                }}
              >
                Teacher
              </th>
              {columns.map((c, idx) => {
                const tier = c.kind === "area" ? 0 : c.tier;
                const next = columns[idx + 1];
                const nextTier =
                  next === undefined
                    ? tier
                    : next.kind === "area"
                      ? 0
                      : next.tier;
                const divider = next !== undefined && nextTier !== tier;
                const tint =
                  tier === 0 ? "#f0f9ff" : tier === 1 ? "#fef2f2" : undefined;
                const tintFg =
                  tier === 0
                    ? "#0369a1"
                    : tier === 1
                      ? "#b91c1c"
                      : "var(--text-muted)";
                const label = c.kind === "area" ? `${c.area} 🚻` : c.name;
                const key = c.kind === "area" ? `area:${c.area}` : c.name;
                const headerState: "all" | "some" | "none" =
                  sortedStaff.length === 0
                    ? "none"
                    : sortedStaff.every(
                          (name) =>
                            colState(
                              new Set(allowlistMap[name] ?? []),
                              c,
                            ) === "all",
                        )
                      ? "all"
                      : sortedStaff.some(
                            (name) =>
                              colState(
                                new Set(allowlistMap[name] ?? []),
                                c,
                              ) !== "none",
                          )
                        ? "some"
                        : "none";
                return (
                  <th
                    key={key}
                    style={{
                      textAlign: "center",
                      padding: "0.4rem 0.5rem",
                      borderBottom: "1px solid #e2e8f0",
                      borderRight: divider ? "2px solid #cbd5e1" : undefined,
                      background: tint,
                      fontWeight: tier !== 2 ? 600 : 500,
                      color: tintFg,
                      whiteSpace: "nowrap",
                      verticalAlign: "bottom",
                    }}
                  >
                    <div title={c.kind === "area" ? c.members.join(", ") : label}>
                      {label}
                    </div>
                    <label
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        marginTop: 4,
                        fontSize: "0.7rem",
                        color: "var(--text-subtle)",
                        fontWeight: 400,
                        cursor: bulkBusy ? "wait" : "pointer",
                      }}
                      title={
                        headerState === "all"
                          ? `Uncheck "${label}" for every visible teacher`
                          : `Check "${label}" for every visible teacher`
                      }
                    >
                      <TriCheck
                        state={headerState}
                        disabled={bulkBusy !== null || sortedStaff.length === 0}
                        onToggle={() =>
                          bulkToggleColumn(c, headerState !== "all")
                        }
                      />
                      {bulkBusy === key ? "saving…" : "all"}
                    </label>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedStaff.map((name) => {
              const allowed = new Set(allowlistMap[name] ?? []);
              return (
                <tr key={name}>
                  <td
                    style={{
                      padding: "0.4rem 0.5rem",
                      borderBottom: "1px solid #f1f5f9",
                      position: "sticky",
                      left: 0,
                      background: "#fff",
                      fontWeight: 600,
                    }}
                  >
                    {name}
                    {savingFor === name && (
                      <span
                        style={{
                          marginLeft: "0.5rem",
                          color: "var(--text-subtle)",
                          fontWeight: 400,
                          fontSize: "0.8rem",
                        }}
                      >
                        saving…
                      </span>
                    )}
                    {errorFor?.name === name && (
                      <div
                        style={{
                          color: "var(--accent)",
                          fontWeight: 400,
                          fontSize: "0.8rem",
                        }}
                      >
                        {errorFor.msg}
                      </div>
                    )}
                  </td>
                  {columns.map((c, idx) => {
                    const tier = c.kind === "area" ? 0 : c.tier;
                    const next = columns[idx + 1];
                    const nextTier =
                      next === undefined
                        ? tier
                        : next.kind === "area"
                          ? 0
                          : next.tier;
                    const divider = next !== undefined && nextTier !== tier;
                    const tint =
                      tier === 0
                        ? "#f0f9ff"
                        : tier === 1
                          ? "#fef2f2"
                          : undefined;
                    const key = c.kind === "area" ? `area:${c.area}` : c.name;
                    const state = colState(allowed, c);
                    return (
                      <td
                        key={key}
                        style={{
                          textAlign: "center",
                          padding: "0.3rem 0.5rem",
                          borderBottom: "1px solid #f1f5f9",
                          borderRight: divider ? "2px solid #cbd5e1" : undefined,
                          background: tint,
                        }}
                      >
                        <TriCheck
                          state={state}
                          disabled={savingFor === name || bulkBusy !== null}
                          onToggle={() => toggleColumn(name, c)}
                          title={
                            c.kind === "area"
                              ? `${c.area}: ${c.members.join(", ")}`
                              : undefined
                          }
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {sortedStaff.length === 0 && (
              <tr>
                <td
                  colSpan={columns.length + 1}
                  style={{
                    padding: "0.75rem",
                    color: "var(--text-subtle)",
                  }}
                >
                  No staff match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
