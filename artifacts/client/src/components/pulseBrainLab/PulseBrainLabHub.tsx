import { useState } from "react";
import LessonsTab from "./LessonsTab";
import GroupsTab from "./GroupsTab";
import EvidenceTab from "./EvidenceTab";

type Tab = "lessons" | "groups" | "evidence";

const TAB_LABELS: { key: Tab; label: string }[] = [
  { key: "lessons", label: "Lessons" },
  { key: "groups", label: "Groups" },
  { key: "evidence", label: "Evidence" },
];

export default function PulseBrainLabHub() {
  const [tab, setTab] = useState<Tab>("lessons");

  return (
    <section className="card">
      <div className="section-header-bar-teal" />
      <div className="section-header-band-hub">
        <h2
          style={{
            margin: 0,
            color: "white",
            fontSize: "1.5rem",
            fontWeight: 700,
          }}
        >
          PulseBrainLab
        </h2>
        <div
          style={{
            color: "rgba(255,255,255,0.85)",
            fontSize: "0.85rem",
            marginTop: "0.15rem",
          }}
        >
          Browse brain-based lessons, run your groups, and file student work — all
          in one place.
        </div>
      </div>

      <TabBar tab={tab} onChange={setTab} />

      {tab === "lessons" && <LessonsTab />}
      {tab === "groups" && <GroupsTab />}
      {tab === "evidence" && <EvidenceTab />}
    </section>
  );
}

function TabBar({
  tab,
  onChange,
}: {
  tab: Tab;
  onChange: (t: Tab) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: "0.25rem",
        borderBottom: "1px solid #e2e8f0",
        marginBottom: "1rem",
        flexWrap: "wrap",
      }}
    >
      {TAB_LABELS.map(({ key, label }) => {
        const active = key === tab;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            style={{
              background: "none",
              border: "none",
              padding: "0.6rem 1rem",
              fontSize: "0.95rem",
              fontWeight: active ? 600 : 500,
              color: active ? "#0e7490" : "#64748b",
              borderBottom: active
                ? "2px solid #0e7490"
                : "2px solid transparent",
              cursor: "pointer",
              marginBottom: "-1px",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function PlaceholderTab({ title }: { title: string }) {
  return (
    <div style={{ color: "#64748b", padding: "1.5rem 0.25rem" }}>
      {title} coming soon.
    </div>
  );
}
