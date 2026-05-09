import { useEffect, useState } from "react";

interface QueueRow {
  id: number;
  room: string;
  studentId: string;
  firstName: string | null;
  lastName: string | null;
  destination: string;
  position: number;
  addedAt: string;
}

// Live chip that surfaces the per-kiosk Hall Pass Queue counts on the
// teacher's Hall Pass tile. Click to open a manage modal where staff can
// remove entries (e.g. a no-show) without walking over to the kiosk.
export function HallPassQueueChip() {
  const [entries, setEntries] = useState<QueueRow[]>([]);
  const [open, setOpen] = useState(false);

  async function load() {
    try {
      const res = await fetch("/api/hall-pass-queue", {
        credentials: "include",
      });
      if (!res.ok) return;
      const body = (await res.json()) as { entries?: QueueRow[] };
      setEntries(body.entries ?? []);
    } catch {
      // ignore — next poll retries
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  async function remove(id: number) {
    try {
      const res = await fetch(`/api/hall-pass-queue/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) await load();
    } catch {
      // ignore
    }
  }

  if (entries.length === 0) return null;

  // Group by room so the modal is grouped per kiosk.
  const byRoom = new Map<string, QueueRow[]>();
  for (const e of entries) {
    const arr = byRoom.get(e.room) ?? [];
    arr.push(e);
    byRoom.set(e.room, arr);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="no-print"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.4rem",
          background: "rgba(59,130,246,0.12)",
          border: "1px solid rgba(59,130,246,0.45)",
          color: "#1d4ed8",
          borderRadius: 999,
          padding: "0.3rem 0.75rem",
          fontSize: "0.85rem",
          fontWeight: 600,
          cursor: "pointer",
        }}
        aria-label={`Hall Pass Queue — ${entries.length} waiting`}
      >
        <span aria-hidden>📋</span>
        Queue · {entries.length} waiting
      </button>
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#fff",
              borderRadius: 12,
              width: "min(560px, 95vw)",
              maxHeight: "85vh",
              overflowY: "auto",
              padding: "1.25rem",
              boxShadow: "0 20px 50px rgba(0,0,0,0.3)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "0.75rem",
              }}
            >
              <h3 style={{ margin: 0 }}>Hall Pass Queue</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                style={{
                  background: "transparent",
                  border: "none",
                  fontSize: "1.4rem",
                  cursor: "pointer",
                  lineHeight: 1,
                }}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div style={{ fontSize: "0.85rem", opacity: 0.7, marginBottom: "0.75rem" }}>
              Live waiting line at each kiosk. Remove a student if they walked
              off — kiosk advances automatically when the active pass-holder
              taps "I'm back."
            </div>
            {[...byRoom.entries()].map(([room, rows]) => (
              <div key={room} style={{ marginBottom: "1rem" }}>
                <div
                  style={{
                    fontSize: "0.75rem",
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    opacity: 0.6,
                    marginBottom: "0.4rem",
                  }}
                >
                  {room} · {rows.length} waiting
                </div>
                {rows.map((r) => (
                  <div
                    key={r.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.6rem",
                      padding: "0.55rem 0.65rem",
                      background: "#f8fafc",
                      border: "1px solid #e5e7eb",
                      borderRadius: 8,
                      marginBottom: "0.35rem",
                    }}
                  >
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 14,
                        background: "#1d4ed8",
                        color: "#fff",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontWeight: 700,
                        fontSize: "0.85rem",
                        flexShrink: 0,
                      }}
                    >
                      {r.position}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>
                        {r.firstName ?? r.studentId}
                        {r.lastName ? ` ${r.lastName}` : ""}
                      </div>
                      <div style={{ fontSize: "0.8rem", opacity: 0.7 }}>
                        → {r.destination}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => remove(r.id)}
                      style={{
                        background: "transparent",
                        border: "1px solid #ef4444",
                        color: "#ef4444",
                        borderRadius: 6,
                        padding: "0.3rem 0.55rem",
                        fontSize: "0.8rem",
                        cursor: "pointer",
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
