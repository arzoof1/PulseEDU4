import { useEffect, useState } from "react";
import type {
  PulseBrainLabGroup,
  PulseBrainLabGroupDetail,
  PulseBrainLabGradeBand,
} from "@workspace/api-client-react";
import {
  fetchGroups,
  createGroup,
  deleteGroup,
  type StudentHit,
} from "./data";
import StudentSearchInput from "./StudentSearchInput";
import GroupDetailPanel from "./GroupDetailPanel";

const GRADE_BANDS: PulseBrainLabGradeBand[] = ["K-2", "3-5", "6-8", "9-12"];

export default function GroupsTab() {
  const [groups, setGroups] = useState<PulseBrainLabGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [openGroupId, setOpenGroupId] = useState<number | null>(null);

  const reload = () => {
    setLoading(true);
    setError(null);
    fetchGroups()
      .then(setGroups)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setLoading(false));
  };

  useEffect(reload, []);

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "1rem",
        }}
      >
        <h3 style={{ margin: 0, fontSize: "1rem", color: "#0f172a" }}>
          Groups{" "}
          <span style={{ color: "#94a3b8", fontWeight: 400 }}>
            ({groups.length})
          </span>
        </h3>
        <button
          type="button"
          onClick={() => setCreating(true)}
          style={{
            background: "#0e7490",
            color: "white",
            border: "none",
            borderRadius: 8,
            padding: "0.5rem 0.9rem",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          + New group
        </button>
      </div>

      {loading && <div style={{ color: "#64748b" }}>Loading groups…</div>}
      {error && (
        <div style={{ color: "#b91c1c", marginBottom: "0.75rem" }}>{error}</div>
      )}
      {!loading && !error && groups.length === 0 && (
        <div style={{ color: "#64748b" }}>
          No groups yet. Create one to start scheduling sessions.
        </div>
      )}

      <div style={{ display: "grid", gap: "0.5rem" }}>
        {groups.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => setOpenGroupId(g.id)}
            style={{
              textAlign: "left",
              background: "white",
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              padding: "0.75rem 0.9rem",
              cursor: "pointer",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>
              <span style={{ fontWeight: 600, color: "#0f172a" }}>
                {g.name}
              </span>
              <span
                style={{
                  color: "#64748b",
                  fontSize: "0.85rem",
                  marginLeft: "0.5rem",
                }}
              >
                Grades {g.gradeBand} · {g.schoolYear}
              </span>
            </span>
            <span style={{ color: "#94a3b8", fontSize: "0.85rem" }}>
              {g.memberCount} {g.memberCount === 1 ? "student" : "students"}
            </span>
          </button>
        ))}
      </div>

      {creating && (
        <CreateGroupModal
          onClose={() => setCreating(false)}
          onCreated={(detail) => {
            setCreating(false);
            reload();
            setOpenGroupId(detail.id);
          }}
        />
      )}

      {openGroupId !== null && (
        <GroupDetailPanel
          groupId={openGroupId}
          onClose={() => {
            setOpenGroupId(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function CreateGroupModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (detail: PulseBrainLabGroupDetail) => void;
}) {
  const [name, setName] = useState("");
  const [gradeBand, setGradeBand] = useState<PulseBrainLabGradeBand>("K-2");
  const [picked, setPicked] = useState<StudentHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const detail = await createGroup({
        name: name.trim(),
        gradeBand,
        studentIds: picked.map((p) => p.studentId),
      });
      onCreated(detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <ModalShell title="New group" onClose={onClose}>
      <label style={labelStyle}>Group name</label>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Tuesday Focus Group"
        style={inputStyle}
      />

      <label style={labelStyle}>Grade band</label>
      <select
        value={gradeBand}
        onChange={(e) =>
          setGradeBand(e.target.value as PulseBrainLabGradeBand)
        }
        style={inputStyle}
      >
        {GRADE_BANDS.map((g) => (
          <option key={g} value={g}>
            {g}
          </option>
        ))}
      </select>

      <label style={labelStyle}>Add students (optional)</label>
      <StudentSearchInput
        excludeIds={new Set(picked.map((p) => p.studentId))}
        onPick={(hit) => setPicked((prev) => [...prev, hit])}
      />
      {picked.length > 0 && (
        <div style={{ marginTop: "0.6rem", display: "grid", gap: "0.3rem" }}>
          {picked.map((p) => (
            <div
              key={p.studentId}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: 6,
                padding: "0.35rem 0.6rem",
                fontSize: "0.88rem",
              }}
            >
              <span>
                {p.lastName}, {p.firstName}{" "}
                <span style={{ color: "#94a3b8" }}>
                  ({p.localSisId ?? "—"})
                </span>
              </span>
              <button
                type="button"
                onClick={() =>
                  setPicked((prev) =>
                    prev.filter((x) => x.studentId !== p.studentId),
                  )
                }
                style={removeBtnStyle}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div style={{ color: "#b91c1c", marginTop: "0.6rem" }}>{error}</div>
      )}

      <div style={modalActionsStyle}>
        <button type="button" onClick={onClose} style={secondaryBtnStyle}>
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          style={{ ...primaryBtnStyle, opacity: busy ? 0.7 : 1 }}
        >
          {busy ? "Creating…" : "Create group"}
        </button>
      </div>
    </ModalShell>
  );
}

export function ModalShell({
  title,
  onClose,
  children,
  onDelete,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  onDelete?: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.45)",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        padding: "3rem 1rem",
        zIndex: 1000,
        overflowY: "auto",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(560px, 100%)",
          background: "white",
          borderRadius: 12,
          padding: "1.5rem",
          boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "1rem",
          }}
        >
          <h2 style={{ margin: 0, fontSize: "1.2rem" }}>{title}</h2>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            {onDelete && (
              <button
                type="button"
                onClick={onDelete}
                style={{
                  border: "1px solid #fecaca",
                  background: "#fef2f2",
                  color: "#b91c1c",
                  borderRadius: 6,
                  padding: "0.3rem 0.6rem",
                  fontSize: "0.8rem",
                  cursor: "pointer",
                }}
              >
                Delete
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{
                border: "none",
                background: "none",
                fontSize: "1.5rem",
                cursor: "pointer",
                color: "#94a3b8",
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

export const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.8rem",
  fontWeight: 600,
  color: "#334155",
  margin: "0.85rem 0 0.3rem",
};

export const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.7rem",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  fontSize: "0.9rem",
  boxSizing: "border-box",
};

export const modalActionsStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.5rem",
  marginTop: "1.25rem",
};

export const primaryBtnStyle: React.CSSProperties = {
  background: "#0e7490",
  color: "white",
  border: "none",
  borderRadius: 8,
  padding: "0.55rem 1rem",
  fontWeight: 600,
  cursor: "pointer",
};

export const secondaryBtnStyle: React.CSSProperties = {
  background: "white",
  color: "#334155",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  padding: "0.55rem 1rem",
  fontWeight: 600,
  cursor: "pointer",
};

export const removeBtnStyle: React.CSSProperties = {
  border: "none",
  background: "none",
  color: "#b91c1c",
  fontSize: "0.8rem",
  cursor: "pointer",
};
