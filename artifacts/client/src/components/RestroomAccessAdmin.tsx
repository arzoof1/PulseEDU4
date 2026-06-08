import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, RoleSection } from "./HowToUseHelp";

type LocationRow = {
  id: number;
  name: string;
  kind: string;
  isOrigin: boolean;
  isDestination: boolean;
  active: boolean;
};

type RestroomAccessPayload = {
  enabled: boolean;
  restrooms: { id: number; name: string }[];
  restroomNames: string[];
  roomDefaults: Record<string, string[]>;
  teacherOverrides: Record<string, string[]>;
};

interface Props {
  /** Staff display names, for the per-teacher override section. */
  staffUsers: string[];
  /**
   * Fired after any successful save so the parent (App.tsx) can refresh
   * the data the Create Pass modal reads.
   */
  onChanged?: () => void;
}

export default function RestroomAccessAdmin({ staffUsers, onChanged }: Props) {
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [data, setData] = useState<RestroomAccessPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [teacherQuery, setTeacherQuery] = useState("");

  async function reload() {
    try {
      const [locRes, accessRes] = await Promise.all([
        authFetch("/api/locations"),
        authFetch("/api/restroom-access"),
      ]);
      if (locRes.ok) setLocations(await locRes.json());
      if (accessRes.ok) setData(await accessRes.json());
    } catch {
      setError("Failed to load restroom access settings.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  // Restroom universe (active, restroom-kind). Names map to ids for PUTs.
  const restrooms = useMemo(
    () =>
      locations
        .filter((l) => l.kind === "restroom" && l.active)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [locations],
  );
  const restroomIdByName = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of restrooms) m.set(r.name, r.id);
    return m;
  }, [restrooms]);

  // Origin rooms (active, origin-flagged).
  const rooms = useMemo(
    () =>
      locations
        .filter((l) => l.isOrigin && l.active)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [locations],
  );

  const enabled = Boolean(data?.enabled);
  const roomDefaults = data?.roomDefaults ?? {};
  const teacherOverrides = data?.teacherOverrides ?? {};

  async function toggleEnabled(next: boolean) {
    setSavingKey("toggle");
    setError(null);
    try {
      const res = await authFetch("/api/school-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restroomAccessControlEnabled: next }),
      });
      if (!res.ok) throw new Error("save failed");
      setData((prev) => (prev ? { ...prev, enabled: next } : prev));
      onChanged?.();
    } catch {
      setError("Could not update the on/off setting.");
    } finally {
      setSavingKey(null);
    }
  }

  async function saveRoom(room: LocationRow, restroomNames: string[]) {
    setSavingKey(`room:${room.id}`);
    setError(null);
    try {
      const restroomLocationIds = restroomNames
        .map((n) => restroomIdByName.get(n))
        .filter((id): id is number => typeof id === "number");
      const res = await authFetch(`/api/restroom-access/room/${room.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restroomLocationIds }),
      });
      if (!res.ok) throw new Error("save failed");
      await reload();
      onChanged?.();
    } catch {
      setError(`Could not save restrooms for ${room.name}.`);
    } finally {
      setSavingKey(null);
    }
  }

  async function saveTeacher(staffName: string, restroomNames: string[]) {
    setSavingKey(`teacher:${staffName}`);
    setError(null);
    try {
      const restroomLocationIds = restroomNames
        .map((n) => restroomIdByName.get(n))
        .filter((id): id is number => typeof id === "number");
      const res = await authFetch(
        `/api/restroom-access/teacher/${encodeURIComponent(staffName)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ restroomLocationIds }),
        },
      );
      if (!res.ok) throw new Error("save failed");
      await reload();
      onChanged?.();
    } catch {
      setError(`Could not save the override for ${staffName}.`);
    } finally {
      setSavingKey(null);
    }
  }

  function toggleRoomRestroom(room: LocationRow, restroomName: string) {
    const current = roomDefaults[room.name] ?? [];
    const next = current.includes(restroomName)
      ? current.filter((n) => n !== restroomName)
      : [...current, restroomName];
    void saveRoom(room, next);
  }

  // Per-column bulk apply: add or remove one restroom across every room
  // default in a single pass. `checked` true = allow this restroom for all
  // rooms; false = remove it from all rooms.
  async function applyColumnToAllRooms(restroomName: string, checked: boolean) {
    setSavingKey(`col:${restroomName}`);
    setError(null);
    try {
      for (const room of rooms) {
        const current = roomDefaults[room.name] ?? [];
        const has = current.includes(restroomName);
        if (checked === has) continue; // already in desired state
        const nextNames = checked
          ? [...current, restroomName]
          : current.filter((n) => n !== restroomName);
        const restroomLocationIds = nextNames
          .map((n) => restroomIdByName.get(n))
          .filter((id): id is number => typeof id === "number");
        const res = await authFetch(`/api/restroom-access/room/${room.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ restroomLocationIds }),
        });
        if (!res.ok) throw new Error("save failed");
      }
      await reload();
      onChanged?.();
    } catch {
      setError(`Could not apply ${restroomName} to all rooms.`);
    } finally {
      setSavingKey(null);
    }
  }

  function toggleTeacherRestroom(staffName: string, restroomName: string) {
    const current = teacherOverrides[staffName] ?? [];
    const next = current.includes(restroomName)
      ? current.filter((n) => n !== restroomName)
      : [...current, restroomName];
    void saveTeacher(staffName, next);
  }

  const filteredTeachers = useMemo(() => {
    const q = teacherQuery.trim().toLowerCase();
    const list = staffUsers
      .filter((s) => s && s.trim())
      .sort((a, b) => a.localeCompare(b));
    return q ? list.filter((s) => s.toLowerCase().includes(q)) : list;
  }, [staffUsers, teacherQuery]);

  if (loading) {
    return <div style={{ padding: "1rem" }}>Loading…</div>;
  }

  return (
    <div style={{ display: "grid", gap: "1.25rem" }}>
      <div>
        <h2 style={{ margin: "0 0 0.25rem" }}>Restroom Access Control</h2>
        <p style={{ margin: 0, color: "var(--muted)", fontSize: 14 }}>
          Decide which restrooms appear on a hall pass — by room and,
          optionally, per teacher. Unselected restrooms are hidden entirely
          from the Create Pass screen.
        </p>
      </div>

      <HowToUseHelp title="How Restroom Access Control works">
        <RoleSection for={["admin", "coreTeam"]} title="Setting this up">
          <ul style={{ margin: "0.25rem 0", paddingLeft: "1.1rem" }}>
            <li>
              Turn the feature ON below. While OFF, every restroom shows on
              passes exactly as before — nothing changes.
            </li>
            <li>
              <strong>Room defaults:</strong> for each room, check the
              restrooms staff in that room may send students to.
            </li>
            <li>
              <strong>Teacher overrides:</strong> optional. If a teacher has
              an override, it fully replaces the room default for that
              teacher — only the restrooms you check here will show.
            </li>
            <li>
              If a room has no restrooms checked and the teacher has no
              override, <strong>no restrooms</strong> appear on the pass.
            </li>
          </ul>
        </RoleSection>
      </HowToUseHelp>

      {error && (
        <div
          style={{
            padding: "0.6rem 0.8rem",
            borderRadius: 8,
            background: "var(--danger-bg, #fee2e2)",
            color: "var(--danger, #b91c1c)",
            fontSize: 14,
          }}
        >
          {error}
        </div>
      )}

      {/* On/off toggle */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.6rem",
          padding: "0.75rem 1rem",
          border: "1px solid var(--border)",
          borderRadius: 10,
        }}
      >
        <label
          style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}
        >
          <input
            type="checkbox"
            checked={enabled}
            disabled={savingKey === "toggle"}
            onChange={(e) => void toggleEnabled(e.target.checked)}
          />
          <strong>Enable Restroom Access Control</strong>
        </label>
        <span style={{ color: "var(--muted)", fontSize: 13 }}>
          {enabled
            ? "ON — restrooms on passes are limited to your selections below."
            : "OFF — all restrooms show on passes (default)."}
        </span>
      </div>

      {restrooms.length === 0 ? (
        <div style={{ color: "var(--muted)", fontSize: 14 }}>
          No restroom-kind locations are configured yet. Add restrooms under{" "}
          <strong>Locations</strong> (set Kind = Restroom), then return here.
        </div>
      ) : (
        <>
          {/* Room defaults */}
          <section>
            <h3 style={{ margin: "0 0 0.5rem" }}>Room defaults</h3>
            <p
              style={{
                margin: "0 0 0.75rem",
                color: "var(--muted)",
                fontSize: 13,
              }}
            >
              Check the restrooms each room is allowed to send students to.
            </p>
            <div style={{ overflowX: "auto" }}>
              <table
                className="pulse-table"
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 14,
                }}
              >
                <thead>
                  <tr
                    style={{
                      textAlign: "left",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <th style={{ padding: "0.4rem 0.5rem" }}>Room</th>
                    {restrooms.map((r) => {
                      const allOn =
                        rooms.length > 0 &&
                        rooms.every((room) =>
                          (roomDefaults[room.name] ?? []).includes(r.name),
                        );
                      const colBusy = savingKey === `col:${r.name}`;
                      return (
                        <th
                          key={r.id}
                          style={{
                            padding: "0.4rem 0.5rem",
                            textAlign: "center",
                          }}
                        >
                          <div>{r.name}</div>
                          <button
                            type="button"
                            disabled={colBusy || rooms.length === 0}
                            onClick={() =>
                              void applyColumnToAllRooms(r.name, !allOn)
                            }
                            title={
                              allOn
                                ? "Remove this restroom from all rooms"
                                : "Allow this restroom for all rooms"
                            }
                            style={{
                              marginTop: 4,
                              fontSize: 11,
                              padding: "1px 6px",
                              cursor: "pointer",
                            }}
                          >
                            {allOn ? "Clear all" : "All rooms"}
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {rooms.map((room) => {
                    const allowed = roomDefaults[room.name] ?? [];
                    const busy = savingKey === `room:${room.id}`;
                    return (
                      <tr
                        key={room.id}
                        style={{
                          borderBottom: "1px solid var(--border)",
                          opacity: busy ? 0.6 : 1,
                        }}
                      >
                        <td style={{ padding: "0.4rem 0.5rem" }}>
                          {room.name}
                        </td>
                        {restrooms.map((r) => (
                          <td
                            key={r.id}
                            style={{
                              padding: "0.4rem 0.5rem",
                              textAlign: "center",
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={allowed.includes(r.name)}
                              disabled={busy}
                              onChange={() =>
                                toggleRoomRestroom(room, r.name)
                              }
                            />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* Teacher overrides */}
          <section>
            <h3 style={{ margin: "0 0 0.5rem" }}>Teacher overrides</h3>
            <p
              style={{
                margin: "0 0 0.75rem",
                color: "var(--muted)",
                fontSize: 13,
              }}
            >
              Optional. A teacher with an override ignores their room default —
              only the restrooms checked here show for them. Uncheck all to
              clear the override and go back to the room default.
            </p>
            <input
              type="text"
              placeholder="Filter teachers…"
              value={teacherQuery}
              onChange={(e) => setTeacherQuery(e.target.value)}
              style={{ maxWidth: 240, marginBottom: "0.5rem" }}
            />
            <div style={{ overflowX: "auto" }}>
              <table
                className="pulse-table"
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 14,
                }}
              >
                <thead>
                  <tr
                    style={{
                      textAlign: "left",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <th style={{ padding: "0.4rem 0.5rem" }}>Teacher</th>
                    <th style={{ padding: "0.4rem 0.5rem" }}>Status</th>
                    {restrooms.map((r) => (
                      <th
                        key={r.id}
                        style={{ padding: "0.4rem 0.5rem", textAlign: "center" }}
                      >
                        {r.name}
                      </th>
                    ))}
                    <th style={{ padding: "0.4rem 0.5rem" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTeachers.map((staffName) => {
                    const hasOverride =
                      Object.prototype.hasOwnProperty.call(
                        teacherOverrides,
                        staffName,
                      );
                    const allowed = teacherOverrides[staffName] ?? [];
                    const busy = savingKey === `teacher:${staffName}`;
                    return (
                      <tr
                        key={staffName}
                        style={{
                          borderBottom: "1px solid var(--border)",
                          opacity: busy ? 0.6 : 1,
                        }}
                      >
                        <td style={{ padding: "0.4rem 0.5rem" }}>
                          {staffName}
                        </td>
                        <td
                          style={{
                            padding: "0.4rem 0.5rem",
                            color: "var(--muted)",
                            fontSize: 12,
                          }}
                        >
                          {hasOverride ? "Override" : "Room default"}
                        </td>
                        {restrooms.map((r) => (
                          <td
                            key={r.id}
                            style={{
                              padding: "0.4rem 0.5rem",
                              textAlign: "center",
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={allowed.includes(r.name)}
                              disabled={busy}
                              onChange={() =>
                                toggleTeacherRestroom(staffName, r.name)
                              }
                            />
                          </td>
                        ))}
                        <td style={{ padding: "0.4rem 0.5rem" }}>
                          {hasOverride && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void saveTeacher(staffName, [])}
                              title="Clear this teacher's override"
                            >
                              Clear
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
