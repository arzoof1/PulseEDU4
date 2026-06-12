import { useEffect, useMemo, useState } from "react";
import { authFetch } from "../lib/authToken";

interface Props {
  open: boolean;
  onClose: () => void;
  currentStaffUser: string;
  /** The teacher's current allowlist (location names). Empty = show all. */
  currentAllowlist: string[];
  /** Called with the saved list (empty array = "show all" default). */
  onSaved: (next: string[]) => void;
}

interface LocationRow {
  name: string;
  kind: string;
  isDestination: boolean;
  studentVisible: boolean;
  active: boolean;
}

const PICKABLE_KINDS = new Set(["restroom", "common_area", "office"]);

// Two display buckets: restrooms first (highest-frequency), then the
// shared facilities (offices, clinic, front office, guidance, etc.).
function bucketOf(kind: string): 0 | 1 {
  return kind === "restroom" ? 0 : 1;
}

export default function TeacherDestinationPicker({
  open,
  onClose,
  currentStaffUser,
  currentAllowlist,
  onSaved,
}: Props) {
  const [options, setOptions] = useState<LocationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [kioskUrlCopied, setKioskUrlCopied] = useState(false);

  // The kiosk screen a teacher opens on a classroom device. Same URL shown
  // in Settings → Kiosk Setup; surfaced here for quick teacher access.
  // Loading it just shows the activation screen — activation still requires
  // the teacher's card QR or PIN, so the URL itself is not sensitive.
  const kioskUrl = `${window.location.origin}${import.meta.env.BASE_URL}kiosk`;

  const copyKioskUrl = async () => {
    try {
      await navigator.clipboard.writeText(kioskUrl);
      setKioskUrlCopied(true);
      setTimeout(() => setKioskUrlCopied(false), 1500);
    } catch {
      setKioskUrlCopied(false);
    }
  };

  // Stable dependency for the load effect. The parent passes
  // `teacherAllowlistMap[user] ?? []`, which is a BRAND-NEW array on every
  // render — depending on the array itself would re-fire this effect every
  // render (refetch → setState → re-render → refetch), making the modal
  // blink and reset its checkboxes. Key off the content instead.
  const allowlistKey = currentAllowlist.join("\u0000");

  // Load the school's pickable destinations whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setSaveError(null);
    authFetch("/api/locations")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("load"))))
      .then((rows: LocationRow[]) => {
        if (cancelled) return;
        const pickable = (Array.isArray(rows) ? rows : [])
          .filter(
            (l) =>
              l.active &&
              l.isDestination &&
              typeof l.kind === "string" &&
              PICKABLE_KINDS.has(l.kind),
          )
          .sort((a, b) => {
            const ba = bucketOf(a.kind);
            const bb = bucketOf(b.kind);
            if (ba !== bb) return ba - bb;
            return a.name.localeCompare(b.name);
          });
        setOptions(pickable);
        // Default: pre-check the teacher's saved list. When they have no
        // list yet, everything is available today, so pre-check ALL so the
        // teacher narrows down rather than starting from nothing.
        const names = pickable.map((l) => l.name);
        setSelected(
          currentAllowlist.length > 0
            ? new Set(currentAllowlist.filter((n) => names.includes(n)))
            : new Set(names),
        );
      })
      .catch(() => {
        if (!cancelled) setLoadError("Couldn't load locations. Try again.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // currentAllowlist is intentionally read via allowlistKey (its stable
    // content hash) to avoid an every-render refetch loop. See above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, allowlistKey]);

  const restrooms = useMemo(
    () => options.filter((l) => l.kind === "restroom"),
    [options],
  );
  const facilities = useMemo(
    () => options.filter((l) => l.kind !== "restroom"),
    [options],
  );

  if (!open) return null;

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const allChecked = options.length > 0 && selected.size === options.length;

  const save = async (names: string[]) => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await authFetch("/api/teacher-allowlist/me", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destinations: names }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || "Save failed.");
      }
      onSaved([...names].sort((a, b) => a.localeCompare(b)));
      onClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  // Saving the FULL set explicitly would freeze the list as-is and silently
  // exclude any location added later. "Show all" instead clears the list so
  // the default ("everything available") resumes and stays future-proof.
  const handleSave = () => {
    if (allChecked) void save([]);
    else void save([...selected]);
  };

  const renderGroup = (label: string, rows: LocationRow[]) =>
    rows.length > 0 ? (
      <>
        <div className="cp-group-label">{label}</div>
        <ul className="cp-list">
          {rows.map((l) => (
            <li key={l.name}>
              <label className="cp-list-item" style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={selected.has(l.name)}
                  onChange={() => toggle(l.name)}
                  style={{ marginRight: "0.6rem" }}
                />
                <span className="cp-list-text">
                  <strong>{l.name}</strong>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </>
    ) : null;

  return (
    <div className="cp-overlay" onClick={onClose}>
      <div
        className="cp-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Choose pass destinations for your students"
      >
        <div className="cp-header">
          <div className="cp-title">Locations students can pick</div>
          <button
            type="button"
            className="cp-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="tdp-body">
          <div className="tdp-kiosk-url">
            <div className="tdp-kiosk-url-label">Teacher kiosk URL</div>
            <p className="tdp-kiosk-url-hint">
              Open this on a classroom device, then activate it with your card
              QR or 6-digit PIN.
            </p>
            <div className="tdp-kiosk-url-row">
              <code className="tdp-kiosk-url-code">{kioskUrl}</code>
              <button
                type="button"
                className="tdp-kiosk-url-copy"
                onClick={() => void copyKioskUrl()}
                title="Copy kiosk URL"
              >
                {kioskUrlCopied ? "Copied!" : "Copy"}
              </button>
              <a
                href={kioskUrl}
                target="_blank"
                rel="noreferrer"
                className="tdp-kiosk-url-open"
              >
                Open
              </a>
            </div>
          </div>

          <p className="tdp-intro">
            Choose which restrooms and common areas students may select when
            making a pass from your room
            {currentStaffUser ? ` (${currentStaffUser})` : ""}. Classrooms and
            teacher rooms are never shown here. Leave everything checked to
            keep all locations available.
          </p>

          {loading && <p className="cp-empty">Loading locations…</p>}
          {loadError && <div className="cp-error">{loadError}</div>}

          {!loading && !loadError && options.length === 0 && (
            <p className="cp-empty">
              No restrooms or common areas are set up yet. An admin can add
              them under Settings → Locations.
            </p>
          )}

          {!loading && !loadError && options.length > 0 && (
            <>
              <div className="tdp-toolbar">
                <label className="tdp-selectall">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? new Set(options.map((l) => l.name))
                          : new Set(),
                      )
                    }
                  />
                  Select all
                </label>
                <span className="tdp-count">
                  {options.length} location{options.length === 1 ? "" : "s"} ·
                  scroll to see all
                </span>
              </div>
              <div className="tdp-scroll">
                {renderGroup("Restrooms", restrooms)}
                {renderGroup("Common areas & offices", facilities)}
              </div>
            </>
          )}
        </div>

        <div className="tdp-footer">
          {saveError && <div className="cp-error">{saveError}</div>}
          <button
            type="button"
            className="cp-send"
            onClick={handleSave}
            disabled={saving || loading || Boolean(loadError)}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
