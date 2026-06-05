// Settings → School: configure the school-wide expectation acronym (e.g.
// PRIDE) and the letter→word mapping. Persists to /api/school-settings.
//
// The Tier 3 weekly form reads the acronym from /api/school-settings and
// renders it as the row label for the optional expectations score row.
import { useEffect, useState } from "react";
import { authFetch } from "../lib/authToken";

interface Letter {
  letter: string;
  word: string;
}

interface Settings {
  schoolWideExpectationAcronym?: string | null;
  schoolWideExpectationLetters?: Letter[] | null;
}

export default function SchoolWideExpectationsPanel() {
  const [acronym, setAcronym] = useState("PRIDE");
  const [letters, setLetters] = useState<Letter[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await authFetch("/api/school-settings");
      if (!r.ok) throw new Error(await r.text());
      const data = (await r.json()) as Settings;
      setAcronym(data?.schoolWideExpectationAcronym ?? "PRIDE");
      setLetters(
        Array.isArray(data?.schoolWideExpectationLetters)
          ? data.schoolWideExpectationLetters
          : [],
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // Seed letter rows from the acronym only when the row list is empty
  // (first load with no saved letters). After that, letters and acronym
  // are independent — schools can repeat a letter (e.g. "B.E.E.S." with
  // two E rows), use digits, or add extra rows that don't appear in the
  // acronym at all. This avoids the previous behavior that wiped saved
  // word rows whenever the admin tweaked the acronym text.
  useEffect(() => {
    if (loading) return;
    setLetters((prev) => {
      if (prev.length > 0) return prev;
      const upper = acronym.trim().toUpperCase();
      if (!upper) return prev;
      return Array.from(upper).map((ch) => ({ letter: ch, word: "" }));
    });
  }, [acronym, loading]);

  const addRow = () => {
    setLetters((prev) => [...prev, { letter: "", word: "" }]);
  };
  const removeRow = (idx: number) => {
    setLetters((prev) => prev.filter((_, i) => i !== idx));
  };
  const syncFromAcronym = () => {
    const upper = acronym.trim().toUpperCase();
    if (!upper) return;
    const wordByLetter = new Map<string, string>();
    for (const row of letters) {
      if (row.letter && !wordByLetter.has(row.letter)) {
        wordByLetter.set(row.letter, row.word);
      }
    }
    setLetters(
      Array.from(upper).map((ch) => ({
        letter: ch,
        word: wordByLetter.get(ch) ?? "",
      })),
    );
  };

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const r = await authFetch("/api/school-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schoolWideExpectationAcronym: acronym.trim().toUpperCase(),
          schoolWideExpectationLetters: letters,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      setMsg("Saved.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section style={{ display: "grid", gap: "0.75rem", maxWidth: 560 }}>
      <h3 style={{ margin: 0 }}>School-wide Expectations</h3>
      <p style={{ margin: 0, color: "#475569", fontSize: "0.85rem" }}>
        Used by the Tier 3 weekly tracking form when a plan opts in to
        school-wide expectations scoring.
      </p>

      <label style={{ display: "grid", gap: 4 }}>
        <span style={{ fontSize: "0.85rem", color: "#475569" }}>Acronym</span>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <input
            value={acronym}
            onChange={(e) =>
              setAcronym(e.target.value.toUpperCase().slice(0, 12))
            }
            style={{
              padding: "0.4rem 0.6rem",
              borderRadius: 6,
              border: "1px solid #cbd5e1",
              width: 180,
            }}
            disabled={loading}
          />
          <button
            type="button"
            onClick={syncFromAcronym}
            disabled={loading || !acronym.trim()}
            title="Replace the rows below with one row per letter in the acronym (existing words for matching letters are kept)."
            style={{
              background: "#f1f5f9",
              color: "#0f172a",
              border: "1px solid #cbd5e1",
              padding: "0.4rem 0.7rem",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: "0.8rem",
            }}
          >
            Rebuild rows from acronym
          </button>
        </div>
        <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
          Letters and acronym are independent — you can repeat letters,
          use digits, or add extra rows.
        </span>
      </label>

      <table className="pulse-table" style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th
              style={{
                textAlign: "left",
                padding: "0.3rem",
                fontSize: "0.8rem",
                color: "#475569",
              }}
            >
              Letter
            </th>
            <th
              style={{
                textAlign: "left",
                padding: "0.3rem",
                fontSize: "0.8rem",
                color: "#475569",
              }}
            >
              Word
            </th>
            <th style={{ width: 60 }} />
          </tr>
        </thead>
        <tbody>
          {letters.map((row, idx) => (
            <tr key={idx}>
              <td
                style={{
                  padding: "0.3rem",
                  width: 60,
                  textAlign: "center",
                }}
              >
                <input
                  value={row.letter}
                  onChange={(e) => {
                    const next = [...letters];
                    next[idx] = {
                      ...next[idx],
                      letter: e.target.value.toUpperCase().slice(0, 2),
                    };
                    setLetters(next);
                  }}
                  aria-label={`Letter for row ${idx + 1}`}
                  style={{
                    padding: "0.3rem",
                    borderRadius: 4,
                    border: "1px solid #cbd5e1",
                    width: 44,
                    textAlign: "center",
                    fontWeight: 700,
                  }}
                />
              </td>
              <td style={{ padding: "0.3rem" }}>
                <input
                  value={row.word}
                  onChange={(e) => {
                    const next = [...letters];
                    next[idx] = { ...next[idx], word: e.target.value };
                    setLetters(next);
                  }}
                  placeholder={`e.g. ${row.letter === "P" ? "Prepared" : ""}`}
                  style={{
                    padding: "0.3rem 0.5rem",
                    borderRadius: 4,
                    border: "1px solid #cbd5e1",
                    width: 240,
                  }}
                />
              </td>
              <td style={{ padding: "0.3rem", textAlign: "center" }}>
                <button
                  type="button"
                  onClick={() => removeRow(idx)}
                  aria-label={`Remove row ${idx + 1}`}
                  title="Remove this row"
                  style={{
                    background: "transparent",
                    color: "#b91c1c",
                    border: "1px solid #fecaca",
                    padding: "0.15rem 0.45rem",
                    borderRadius: 4,
                    cursor: "pointer",
                    fontSize: "0.8rem",
                  }}
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div>
        <button
          type="button"
          onClick={addRow}
          disabled={loading}
          style={{
            background: "#f1f5f9",
            color: "#0f172a",
            border: "1px dashed #94a3b8",
            padding: "0.3rem 0.7rem",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: "0.8rem",
          }}
        >
          + Add letter
        </button>
      </div>

      {msg && (
        <div
          style={{
            fontSize: "0.85rem",
            color: msg === "Saved." ? "#047857" : "#b91c1c",
          }}
        >
          {msg}
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={save}
          disabled={saving || loading}
          style={{
            background: "#2563eb",
            color: "white",
            border: "none",
            padding: "0.4rem 0.9rem",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
}
