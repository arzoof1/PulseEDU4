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

  // Re-derive the letter rows whenever the acronym changes, preserving
  // any words the user has already typed for letters that still appear.
  useEffect(() => {
    const upper = acronym.trim().toUpperCase();
    if (!upper) {
      setLetters([]);
      return;
    }
    setLetters((prev) => {
      const wordByLetter = new Map<string, string>();
      for (const row of prev) {
        if (!wordByLetter.has(row.letter)) wordByLetter.set(row.letter, row.word);
      }
      return Array.from(upper).map((ch) => ({
        letter: ch,
        word: wordByLetter.get(ch) ?? "",
      }));
    });
  }, [acronym]);

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
        <input
          value={acronym}
          onChange={(e) => setAcronym(e.target.value.toUpperCase().slice(0, 12))}
          style={{
            padding: "0.4rem 0.6rem",
            borderRadius: 6,
            border: "1px solid #cbd5e1",
            width: 180,
          }}
          disabled={loading}
        />
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
          </tr>
        </thead>
        <tbody>
          {letters.map((row, idx) => (
            <tr key={`${row.letter}-${idx}`}>
              <td
                style={{
                  padding: "0.3rem",
                  fontWeight: 700,
                  width: 60,
                  textAlign: "center",
                }}
              >
                {row.letter}
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
            </tr>
          ))}
        </tbody>
      </table>

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
