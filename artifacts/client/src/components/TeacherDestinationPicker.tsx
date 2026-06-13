import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { BarcodeFormat, MultiFormatWriter } from "@zxing/library";
import { authFetch } from "../lib/authToken";

// Render a Code 128 barcode of `text` to a PNG data URL. Mirrors the
// barcode on the printed kiosk card so a classroom device with a 1D
// scanner can read the on-screen code off a teacher's phone. QR + the
// big PIN cover camera kiosks and manual entry; this covers laser/USB
// scanners. Returns "" if encoding fails (UI then just omits it).
function code128DataUrl(text: string): string {
  try {
    const targetW = 360;
    const targetH = 90;
    const matrix = new MultiFormatWriter().encode(
      text,
      BarcodeFormat.CODE_128,
      targetW,
      targetH,
      new Map(),
    );
    const w = matrix.getWidth();
    const h = matrix.getHeight();
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#000000";
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (matrix.get(x, y)) ctx.fillRect(x, y, 1, 1);
      }
    }
    return canvas.toDataURL("image/png");
  } catch {
    return "";
  }
}

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
  const [tab, setTab] = useState<"locations" | "url">("locations");
  // The teacher's own 6-digit kiosk PIN — the same code printed on their
  // badge, revealed owner-only from GET /api/kiosk/my-pin.
  //   undefined  = not loaded yet
  //   "ok"       = pin present (myPin holds it)
  //   "legacy"   = a working badge exists but its code can't be read back
  //                (printed before reversible storage) → reprint to reveal
  //   "none"     = no badge issued yet
  const [myPin, setMyPin] = useState<string | null>(null);
  const [pinStatus, setPinStatus] = useState<
    "ok" | "legacy" | "none" | undefined
  >(undefined);
  const [pinCopied, setPinCopied] = useState(false);

  // Teacher self-service "generate a new code" flow. On success the server
  // returns the raw token + PIN ONCE; we render an on-screen card (QR +
  // barcode + big PIN) the teacher can hold up to the kiosk camera or read
  // off to type — so they never have to write anything down or wait for
  // an admin to reprint.
  const [regenBusy, setRegenBusy] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);
  const [newCode, setNewCode] = useState<{
    enrollToken: string;
    pin: string;
  } | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [barcodeDataUrl, setBarcodeDataUrl] = useState<string>("");
  // "End my live kiosks" — reuses the existing self-scoped revoke-all.
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeMsg, setRevokeMsg] = useState<string | null>(null);

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
    setTab("locations");
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

  // Reveal the teacher's own kiosk PIN when the modal opens. Owner-only on
  // the server; cleared between opens so a stale code never flashes.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setMyPin(null);
    setPinStatus(undefined);
    setPinCopied(false);
    setNewCode(null);
    setQrDataUrl("");
    setBarcodeDataUrl("");
    setRegenError(null);
    setRevokeMsg(null);
    authFetch("/api/kiosk/my-pin")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("pin"))))
      .then((data: { pin: string | null; status: "ok" | "legacy" | "none" }) => {
        if (cancelled) return;
        setMyPin(data.pin ?? null);
        setPinStatus(data.status);
      })
      .catch(() => {
        if (!cancelled) setPinStatus("none");
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const copyPin = async () => {
    if (!myPin) return;
    try {
      await navigator.clipboard.writeText(myPin);
      setPinCopied(true);
      setTimeout(() => setPinCopied(false), 1500);
    } catch {
      setPinCopied(false);
    }
  };

  // Kill the teacher's current code and mint a fresh one, then render it
  // on screen (QR + barcode + PIN). The old card/code stops working right
  // away, so confirm first.
  const regenerate = async () => {
    if (regenBusy) return;
    const confirmed = window.confirm(
      "Generate a new kiosk code?\n\nYour current code stops working right away — any printed badge or screenshot you have will no longer activate a kiosk. You'll get a new QR + PIN to use instead.",
    );
    if (!confirmed) return;
    setRegenBusy(true);
    setRegenError(null);
    setRevokeMsg(null);
    try {
      const res = await authFetch("/api/kiosk/my-code/regenerate", {
        method: "POST",
      });
      if (!res.ok) throw new Error("regen");
      const data: { enrollToken: string; pin: string } = await res.json();
      const qrUrl = `${kioskUrl}?enroll=${encodeURIComponent(data.enrollToken)}`;
      const qr = await QRCode.toDataURL(qrUrl, { width: 240, margin: 1 });
      setQrDataUrl(qr);
      setBarcodeDataUrl(code128DataUrl(data.enrollToken));
      setNewCode({ enrollToken: data.enrollToken, pin: data.pin });
      // Reflect the new code in the existing PIN reveal too.
      setMyPin(data.pin);
      setPinStatus("ok");
    } catch {
      setRegenError("Couldn't generate a new code. Try again.");
    } finally {
      setRegenBusy(false);
    }
  };

  // End any kiosks currently activated under this teacher (e.g. a device
  // left logged in, or a lost screenshot that's still live). Reuses the
  // existing self-scoped revoke-all endpoint.
  const endLiveKiosks = async () => {
    if (revokeBusy) return;
    setRevokeBusy(true);
    setRevokeMsg(null);
    try {
      const res = await authFetch("/api/kiosk/my-active/revoke-all", {
        method: "POST",
      });
      if (!res.ok) throw new Error("revoke");
      const data: { revoked: number } = await res.json();
      setRevokeMsg(
        data.revoked > 0
          ? `Ended ${data.revoked} live kiosk${data.revoked === 1 ? "" : "s"}.`
          : "No kiosks were active.",
      );
    } catch {
      setRevokeMsg("Couldn't end live kiosks. Try again.");
    } finally {
      setRevokeBusy(false);
    }
  };

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
    <div className="cp-overlay tdp-overlay" onClick={onClose}>
      <div
        className="cp-card tdp-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Choose pass destinations for your students"
      >
        <div className="cp-header tdp-header">
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
        <div className="tdp-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "locations"}
            className={`tdp-tab${tab === "locations" ? " is-active" : ""}`}
            onClick={() => setTab("locations")}
          >
            Set locations
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "url"}
            className={`tdp-tab${tab === "url" ? " is-active" : ""}`}
            onClick={() => setTab("url")}
          >
            Get kiosk URL
          </button>
        </div>

        <div className="tdp-body">
          {tab === "url" ? (
            <div className="tdp-kiosk-url">
              <div className="tdp-kiosk-url-label">Teacher kiosk URL</div>
              <p className="tdp-kiosk-url-hint">
                Open this on a classroom device, then activate it with your card
                QR or 6-digit PIN.
              </p>
              <div className="tdp-kiosk-url-row">
                <code className="tdp-kiosk-url-code">{kioskUrl}</code>
              </div>
              <div className="tdp-kiosk-url-actions">
                <button
                  type="button"
                  className="tdp-kiosk-url-copy"
                  onClick={() => void copyKioskUrl()}
                  title="Copy kiosk URL"
                >
                  {kioskUrlCopied ? "Copied!" : "Copy URL"}
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

              <div className="tdp-kiosk-pin">
                <div className="tdp-kiosk-url-label">Your 6-digit PIN</div>
                {pinStatus === undefined ? (
                  <p className="tdp-kiosk-url-hint">Loading…</p>
                ) : pinStatus === "ok" && myPin ? (
                  <>
                    <p className="tdp-kiosk-url-hint">
                      The same code printed on your kiosk badge. Type it on the
                      activation screen to start your room.
                    </p>
                    <div className="tdp-kiosk-url-row">
                      <code
                        className="tdp-kiosk-url-code"
                        style={{ letterSpacing: "0.25em", fontSize: "1.25rem" }}
                      >
                        {myPin.slice(0, 3)} {myPin.slice(3)}
                      </code>
                    </div>
                    <div className="tdp-kiosk-url-actions">
                      <button
                        type="button"
                        className="tdp-kiosk-url-copy"
                        onClick={() => void copyPin()}
                        title="Copy PIN"
                      >
                        {pinCopied ? "Copied!" : "Copy PIN"}
                      </button>
                    </div>
                  </>
                ) : pinStatus === "legacy" ? (
                  <p className="tdp-kiosk-url-hint">
                    Your printed badge code still works on the kiosk, but it
                    can&apos;t be shown here — older badges were stored securely
                    and can&apos;t be read back. Ask an admin to reprint your
                    kiosk badge to get a fresh code that will appear here.
                  </p>
                ) : (
                  <p className="tdp-kiosk-url-hint">
                    No kiosk code yet. Tap{" "}
                    <b>Generate a new code</b> below to create your first one —
                    no admin needed.
                  </p>
                )}
              </div>

              <div className="tdp-kiosk-regen">
                <div className="tdp-kiosk-url-label">Generate a new code</div>
                <p className="tdp-kiosk-url-hint">
                  Lost your badge, or want to replace your code? Generate a new
                  one here — it works instantly and you don&apos;t need to print
                  anything. Your old code stops working right away.
                </p>
                <div className="tdp-kiosk-url-actions">
                  <button
                    type="button"
                    className="tdp-kiosk-url-copy"
                    onClick={() => void regenerate()}
                    disabled={regenBusy}
                  >
                    {regenBusy
                      ? "Generating…"
                      : newCode
                        ? "Generate another"
                        : "Generate a new code"}
                  </button>
                </div>
                {regenError && <div className="cp-error">{regenError}</div>}

                {newCode && (
                  <div className="tdp-newcode">
                    <p className="tdp-newcode-instr">
                      Hold this up to the kiosk camera, or type the code on the
                      activation screen. No need to write anything down.
                    </p>
                    {qrDataUrl && (
                      <img
                        className="tdp-newcode-qr"
                        src={qrDataUrl}
                        alt="Kiosk activation QR code"
                        width={240}
                        height={240}
                      />
                    )}
                    <div className="tdp-newcode-pin">
                      <span className="tdp-newcode-pin-label">6-digit code</span>
                      <span className="tdp-newcode-pin-value">
                        {newCode.pin.slice(0, 3)} {newCode.pin.slice(3)}
                      </span>
                    </div>
                    {barcodeDataUrl && (
                      <img
                        className="tdp-newcode-barcode"
                        src={barcodeDataUrl}
                        alt="Kiosk activation barcode"
                      />
                    )}
                    <p className="tdp-newcode-note">
                      Treat this like a password. If you screenshot it and lose
                      your phone, just come back and generate a new code — that
                      instantly cancels the old one.
                    </p>
                  </div>
                )}
              </div>

              <div className="tdp-kiosk-regen">
                <div className="tdp-kiosk-url-label">End my live kiosks</div>
                <p className="tdp-kiosk-url-hint">
                  Sign out any classroom device that&apos;s currently activated
                  under your name (for example, one you left logged in).
                </p>
                <div className="tdp-kiosk-url-actions">
                  <button
                    type="button"
                    className="tdp-kiosk-url-copy"
                    onClick={() => void endLiveKiosks()}
                    disabled={revokeBusy}
                  >
                    {revokeBusy ? "Ending…" : "End my live kiosks"}
                  </button>
                </div>
                {revokeMsg && (
                  <p className="tdp-kiosk-url-hint" style={{ marginTop: "0.4rem" }}>
                    {revokeMsg}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <>
              <p className="tdp-intro">
                Choose which restrooms and common areas students may select when
                making a pass from your room
                {currentStaffUser ? ` (${currentStaffUser})` : ""}. Classrooms
                and teacher rooms are never shown here. Leave everything checked
                to keep all locations available.
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
                      {options.length} location{options.length === 1 ? "" : "s"}{" "}
                      · scroll to see all
                    </span>
                  </div>
                  <div className="tdp-scroll">
                    {renderGroup("Restrooms", restrooms)}
                    {renderGroup("Common areas & offices", facilities)}
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {tab === "locations" && (
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
        )}
      </div>
    </div>
  );
}
