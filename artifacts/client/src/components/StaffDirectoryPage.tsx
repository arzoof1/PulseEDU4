import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, RoleSection } from "./HowToUseHelp";

// Staff Directory — per-school list of active staff (fed by the SIS
// staff import) with two PulseEDU-owned phone columns: a low-sensitivity
// work extension visible to every signed-in staff member, and a
// high-sensitivity personal cell number whose visibility is controlled
// by a school-wide toggle. Edits are restricted to Core Team / Admin /
// SuperUser regardless of the toggle. The server is the source of
// truth for the redaction; the client never receives a cell number it
// isn't allowed to see.

interface DirectoryStaff {
  id: number;
  displayName: string;
  email: string;
  defaultRoom: string | null;
  externalId: string | null;
  workExtension: string | null;
  cellPhone: string | null;
  isAdmin: boolean;
  isDistrictAdmin: boolean;
  isSuperUser: boolean;
  isEseCoordinator: boolean;
  isPbisCoordinator: boolean;
  isBehaviorSpecialist: boolean;
  isMtssCoordinator: boolean;
  isCounselor: boolean;
  isGuidanceCounselor: boolean;
  isDean: boolean;
  isSchoolPsychologist: boolean;
  isIssTeacher: boolean;
  isSocialWorker: boolean;
}

interface DirectoryPayload {
  canEdit: boolean;
  showCellPhone: boolean;
  staff: DirectoryStaff[];
}

function roleBadges(s: DirectoryStaff): string[] {
  const badges: string[] = [];
  if (s.isSuperUser) badges.push("SuperUser");
  if (s.isDistrictAdmin) badges.push("District Admin");
  if (s.isAdmin) badges.push("Admin");
  if (s.isBehaviorSpecialist) badges.push("Behavior Specialist");
  if (s.isMtssCoordinator) badges.push("MTSS Coord");
  if (s.isSchoolPsychologist) badges.push("School Psych");
  if (s.isEseCoordinator) badges.push("ESE Coord");
  if (s.isPbisCoordinator) badges.push("PBIS Coord");
  if (s.isCounselor) badges.push("Counselor");
  if (s.isGuidanceCounselor) badges.push("Guidance");
  if (s.isDean) badges.push("Dean");
  if (s.isIssTeacher) badges.push("ISS Teacher");
  if (s.isSocialWorker) badges.push("Social Worker");
  return badges;
}

interface RowDraft {
  workExtension: string;
  cellPhone: string;
  status: "idle" | "saving" | "saved" | "error";
  error?: string;
}

export default function StaffDirectoryPage({
  showCellPhoneSetting,
  onToggleShowCellPhone,
}: {
  showCellPhoneSetting: boolean;
  onToggleShowCellPhone: (next: boolean) => Promise<void> | void;
}) {
  const [data, setData] = useState<DirectoryPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<number, RowDraft>>({});
  const [filter, setFilter] = useState("");

  const load = () => {
    setLoading(true);
    setError(null);
    authFetch("/api/staff-directory")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const payload = (await r.json()) as DirectoryPayload;
        setData(payload);
        const initial: Record<number, RowDraft> = {};
        for (const s of payload.staff) {
          initial[s.id] = {
            workExtension: s.workExtension ?? "",
            cellPhone: s.cellPhone ?? "",
            status: "idle",
          };
        }
        setDrafts(initial);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return data.staff;
    return data.staff.filter((s) => {
      const hay = [
        s.displayName,
        s.email,
        s.defaultRoom ?? "",
        s.externalId ?? "",
        ...roleBadges(s),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [data, filter]);

  async function saveRow(id: number) {
    const draft = drafts[id];
    if (!draft) return;
    setDrafts((d) => ({ ...d, [id]: { ...draft, status: "saving" } }));
    try {
      const r = await authFetch(`/api/staff-directory/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workExtension: draft.workExtension,
          cellPhone: draft.cellPhone,
        }),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        throw new Error(txt || `HTTP ${r.status}`);
      }
      const updated = (await r.json()) as {
        workExtension: string | null;
        cellPhone: string | null;
      };
      setDrafts((d) => ({
        ...d,
        [id]: {
          workExtension: updated.workExtension ?? "",
          cellPhone: updated.cellPhone ?? "",
          status: "saved",
        },
      }));
      setData((cur) =>
        cur
          ? {
              ...cur,
              staff: cur.staff.map((s) =>
                s.id === id
                  ? {
                      ...s,
                      workExtension: updated.workExtension,
                      cellPhone: updated.cellPhone,
                    }
                  : s,
              ),
            }
          : cur,
      );
      window.setTimeout(() => {
        setDrafts((d) => {
          const cur = d[id];
          if (!cur || cur.status !== "saved") return d;
          return { ...d, [id]: { ...cur, status: "idle" } };
        });
      }, 1500);
    } catch (e) {
      setDrafts((d) => ({
        ...d,
        [id]: { ...draft, status: "error", error: (e as Error).message },
      }));
    }
  }

  function rowDirty(id: number, original: DirectoryStaff): boolean {
    const draft = drafts[id];
    if (!draft) return false;
    return (
      draft.workExtension !== (original.workExtension ?? "") ||
      draft.cellPhone !== (original.cellPhone ?? "")
    );
  }

  const canEdit = !!data?.canEdit;
  const showCell = !!data?.showCellPhone;

  return (
    <div className="card" style={{ marginTop: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>Staff Directory</h2>
      <p style={{ color: "var(--text-subtle)", marginTop: 0 }}>
        Active staff fed from the SIS, with default room and contact phone
        numbers. Numbers entered here surface in the Finder so a hall
        monitor or front-office staff member can reach the right person
        quickly.
      </p>
      <HowToUseHelp title="How to use Staff Directory">
        <HowToSection title="What this page is">
          The contact card for every active staff member at the school.
          Edits here are visible in the Student Finder, hall pass
          flow, and any "find a teacher right now" surface.
        </HowToSection>
        <RoleSection for={["admin", "coreTeam"]} title="Admin tasks">
          Cell phone numbers are optional and only shown to staff —
          never to parents. Confirm verbal consent before entering.
          Default room is the fallback for kiosk activation when SIS
          sync hasn't placed the teacher yet.
        </RoleSection>
      </HowToUseHelp>

      <div
        style={{
          background: "#fef3c7",
          color: "#78350f",
          border: "1px solid #f59e0b",
          padding: "8px 12px",
          borderRadius: 8,
          fontSize: 13,
          margin: "0.5rem 0 1rem",
        }}
      >
        <strong>Personal phone numbers are directory information for
        school operations.</strong>{" "}
        Confirm staff have consented before entering. Cell numbers are
        never shown on any parent-facing surface.
      </div>

      <label
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: "0.5rem",
          padding: "0.6rem 0.75rem",
          border: "1px solid var(--border-subtle, #e2e8f0)",
          borderRadius: 6,
          background: "var(--surface-subtle, #f8fafc)",
          marginBottom: "1rem",
        }}
      >
        <input
          type="checkbox"
          checked={showCellPhoneSetting}
          onChange={(e) => onToggleShowCellPhone(e.target.checked)}
          style={{ marginTop: "0.2rem" }}
        />
        <span style={{ display: "grid", gap: "0.15rem" }}>
          <span style={{ fontWeight: 600 }}>
            Show cell phone numbers to all staff in the Finder
          </span>
          <span
            style={{
              color: "var(--text-subtle, #64748b)",
              fontSize: "0.85rem",
              fontWeight: "normal",
            }}
          >
            Off by default. Core Team (Admin, Behavior Specialist, MTSS
            Coordinator, School Psychologist, SuperUser) always sees cell
            numbers. Work extensions are always visible to everyone.
          </span>
        </span>
      </label>

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name, email, room, or role…"
          style={{
            flex: 1,
            padding: "8px 10px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            fontSize: 14,
          }}
        />
      </div>

      {loading && (
        <div style={{ color: "var(--text-subtle)" }}>Loading staff…</div>
      )}
      {error && (
        <div
          role="alert"
          style={{
            background: "#fee2e2",
            color: "#991b1b",
            padding: 10,
            borderRadius: 8,
            fontSize: 14,
          }}
        >
          {error}
        </div>
      )}

      {!loading && !error && data && (
        <>
          {!canEdit && (
            <div
              style={{
                background: "#eff6ff",
                color: "#1e3a8a",
                border: "1px solid #93c5fd",
                padding: "8px 12px",
                borderRadius: 6,
                fontSize: 13,
                marginBottom: "0.75rem",
              }}
            >
              You can view the directory but only Core Team / Admin /
              SuperUser can edit phone numbers.
            </div>
          )}
          <div style={{ overflowX: "auto" }}>
            <table className="pulse-table" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Roles</th>
                  <th>Default Room</th>
                  <th>Work Extension</th>
                  <th>Cell Phone</th>
                  {canEdit && <th style={{ width: 90 }}>Save</th>}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td
                      colSpan={canEdit ? 6 : 5}
                      style={{
                        color: "var(--text-subtle)",
                        textAlign: "center",
                        padding: 16,
                      }}
                    >
                      No staff match that filter.
                    </td>
                  </tr>
                )}
                {filtered.map((s) => {
                  const draft = drafts[s.id];
                  const dirty = rowDirty(s.id, s);
                  const cellHidden = !showCell;
                  return (
                    <tr key={s.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{s.displayName}</div>
                        <div
                          style={{
                            fontSize: 12,
                            color: "var(--text-subtle)",
                          }}
                        >
                          {s.email}
                        </div>
                      </td>
                      <td>
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 4,
                          }}
                        >
                          {roleBadges(s).map((b) => (
                            <span
                              key={b}
                              style={{
                                fontSize: 11,
                                padding: "1px 6px",
                                borderRadius: 4,
                                background: "#e2e8f0",
                                color: "#1e293b",
                              }}
                            >
                              {b}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td style={{ color: "var(--text-subtle)" }}>
                        {s.defaultRoom ?? "—"}
                      </td>
                      <td>
                        {canEdit ? (
                          <input
                            type="tel"
                            value={draft?.workExtension ?? ""}
                            onChange={(e) =>
                              setDrafts((d) => ({
                                ...d,
                                [s.id]: {
                                  ...(d[s.id] ?? {
                                    workExtension: "",
                                    cellPhone: "",
                                    status: "idle",
                                  }),
                                  workExtension: e.target.value,
                                  status: "idle",
                                },
                              }))
                            }
                            placeholder="x4012"
                            style={{
                              width: "100%",
                              padding: "4px 6px",
                              fontSize: 13,
                              border: "1px solid var(--border)",
                              borderRadius: 4,
                            }}
                          />
                        ) : (
                          <span>{s.workExtension ?? "—"}</span>
                        )}
                      </td>
                      <td>
                        {cellHidden ? (
                          <span
                            style={{
                              color: "var(--text-subtle)",
                              fontStyle: "italic",
                              fontSize: 12,
                            }}
                          >
                            hidden by school setting
                          </span>
                        ) : canEdit ? (
                          <input
                            type="tel"
                            value={draft?.cellPhone ?? ""}
                            onChange={(e) =>
                              setDrafts((d) => ({
                                ...d,
                                [s.id]: {
                                  ...(d[s.id] ?? {
                                    workExtension: "",
                                    cellPhone: "",
                                    status: "idle",
                                  }),
                                  cellPhone: e.target.value,
                                  status: "idle",
                                },
                              }))
                            }
                            placeholder="(555) 123-4567"
                            style={{
                              width: "100%",
                              padding: "4px 6px",
                              fontSize: 13,
                              border: "1px solid var(--border)",
                              borderRadius: 4,
                            }}
                          />
                        ) : (
                          <span>{s.cellPhone ?? "—"}</span>
                        )}
                      </td>
                      {canEdit && (
                        <td>
                          <button
                            type="button"
                            onClick={() => saveRow(s.id)}
                            disabled={!dirty || draft?.status === "saving"}
                            style={{
                              padding: "4px 10px",
                              fontSize: 12,
                              borderRadius: 4,
                              border: "1px solid var(--border)",
                              background: dirty
                                ? "var(--accent, #3b82f6)"
                                : "transparent",
                              color: dirty ? "white" : "var(--text-subtle)",
                              cursor: dirty ? "pointer" : "default",
                            }}
                          >
                            {draft?.status === "saving"
                              ? "Saving…"
                              : draft?.status === "saved"
                                ? "Saved"
                                : draft?.status === "error"
                                  ? "Retry"
                                  : "Save"}
                          </button>
                          {draft?.status === "error" && (
                            <div
                              style={{
                                fontSize: 11,
                                color: "#991b1b",
                                marginTop: 2,
                              }}
                              title={draft.error}
                            >
                              Failed
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
