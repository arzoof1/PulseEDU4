import { useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";
import { HowToUseHelp, HowToSection, RoleSection } from "./HowToUseHelp";

interface Props {
  staffUsers: string[];
  allDestinations: string[];
  allowlistMap: Record<string, string[]>;
  onChange: (next: Record<string, string[]>) => void;
  onEditLocations?: () => void;
}

export default function TeacherAllowlistAdmin({
  staffUsers,
  allDestinations,
  allowlistMap,
  onChange,
  onEditLocations,
}: Props) {
  const [filter, setFilter] = useState("");
  const [savingFor, setSavingFor] = useState<string | null>(null);
  const [errorFor, setErrorFor] = useState<{ name: string; msg: string } | null>(
    null,
  );
  const [bulkBusy, setBulkBusy] = useState<string | null>(null);

  const RESTROOM_RE = /(restroom|bathroom|\brr\b|\bwc\b)/i;
  const isRestroom = (name: string) => RESTROOM_RE.test(name);
  const restroomCount = useMemo(
    () => allDestinations.filter(isRestroom).length,
    [allDestinations],
  );

  const sortedStaff = useMemo(
    () =>
      [...staffUsers]
        .filter((s) => s)
        .sort((a, b) => a.localeCompare(b))
        .filter((s) => s.toLowerCase().includes(filter.trim().toLowerCase())),
    [staffUsers, filter],
  );

  const save = async (staffName: string, destinations: string[]) => {
    setSavingFor(staffName);
    setErrorFor(null);
    try {
      const res = await authFetch(
        `/api/teacher-allowlist/${encodeURIComponent(staffName)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ destinations }),
        },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Save failed.");
      }
      const next = { ...allowlistMap, [staffName]: [...destinations].sort() };
      if (destinations.length === 0) {
        delete next[staffName];
      }
      onChange(next);
    } catch (e: unknown) {
      setErrorFor({
        name: staffName,
        msg: e instanceof Error ? e.message : "Save failed.",
      });
    } finally {
      setSavingFor(null);
    }
  };

  const toggle = (staffName: string, destination: string) => {
    const current = new Set(allowlistMap[staffName] ?? []);
    if (current.has(destination)) current.delete(destination);
    else current.add(destination);
    save(staffName, Array.from(current));
  };

  const bulkToggleColumn = async (destination: string, turnOn: boolean) => {
    setBulkBusy(destination);
    setErrorFor(null);

    // Compute the new state synchronously and apply it optimistically so the
    // grid updates immediately. Then fire all PUTs in parallel and roll back
    // any rows whose save failed.
    const changes: { staffName: string; destinations: string[] }[] = [];
    const optimistic: Record<string, string[]> = { ...allowlistMap };
    for (const staffName of sortedStaff) {
      const current = new Set(allowlistMap[staffName] ?? []);
      const has = current.has(destination);
      if (turnOn && has) continue;
      if (!turnOn && !has) continue;
      if (turnOn) current.add(destination);
      else current.delete(destination);
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
      // Roll back failed rows to their pre-bulk values.
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
        <table className="pulse-table"
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
              {allDestinations.map((d, idx) => {
                const allChecked =
                  sortedStaff.length > 0 &&
                  sortedStaff.every((name) =>
                    (allowlistMap[name] ?? []).includes(d),
                  );
                const rr = isRestroom(d);
                const isLastRestroom =
                  rr && restroomCount > 0 && idx === restroomCount - 1;
                return (
                  <th
                    key={d}
                    style={{
                      textAlign: "center",
                      padding: "0.4rem 0.5rem",
                      borderBottom: "1px solid #e2e8f0",
                      borderRight: isLastRestroom
                        ? "2px solid #cbd5e1"
                        : undefined,
                      background: rr ? "#f0f9ff" : undefined,
                      fontWeight: rr ? 600 : 500,
                      color: rr ? "#0369a1" : "var(--text-muted)",
                      whiteSpace: "nowrap",
                      verticalAlign: "bottom",
                    }}
                  >
                    <div>{d}</div>
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
                        allChecked
                          ? `Uncheck "${d}" for every visible teacher`
                          : `Check "${d}" for every visible teacher`
                      }
                    >
                      <input
                        type="checkbox"
                        checked={allChecked}
                        disabled={
                          bulkBusy !== null || sortedStaff.length === 0
                        }
                        onChange={(e) =>
                          bulkToggleColumn(d, e.target.checked)
                        }
                      />
                      {bulkBusy === d ? "saving…" : "all"}
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
                  {allDestinations.map((d, idx) => {
                    const rr = isRestroom(d);
                    const isLastRestroom =
                      rr && restroomCount > 0 && idx === restroomCount - 1;
                    return (
                    <td
                      key={d}
                      style={{
                        textAlign: "center",
                        padding: "0.3rem 0.5rem",
                        borderBottom: "1px solid #f1f5f9",
                        borderRight: isLastRestroom
                          ? "2px solid #cbd5e1"
                          : undefined,
                        background: rr ? "#f0f9ff" : undefined,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={allowed.has(d)}
                        disabled={savingFor === name || bulkBusy !== null}
                        onChange={() => toggle(name, d)}
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
                  colSpan={allDestinations.length + 1}
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
