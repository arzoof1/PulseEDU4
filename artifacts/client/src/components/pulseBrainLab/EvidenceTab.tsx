import { useEffect, useRef, useState } from "react";
import type { PulseBrainLabUnmatchedScan } from "@workspace/api-client-react";
import { CameraScanner } from "../CameraScanner";
import {
  uploadObject,
  routeScan,
  batchScan,
  fetchUnmatched,
  assignUnmatched,
  discardUnmatched,
} from "./data";
import AssignUnmatchedModal from "./AssignUnmatchedModal";
import { primaryBtnStyle, secondaryBtnStyle } from "./GroupsTab";

type Mode = "phone" | "batch";

export default function EvidenceTab() {
  const [mode, setMode] = useState<Mode>("phone");
  const [unmatched, setUnmatched] = useState<PulseBrainLabUnmatchedScan[]>([]);
  const [unmatchedLoading, setUnmatchedLoading] = useState(true);
  const [assigning, setAssigning] = useState<PulseBrainLabUnmatchedScan | null>(
    null,
  );
  const [trayError, setTrayError] = useState<string | null>(null);

  const reloadUnmatched = () => {
    setUnmatchedLoading(true);
    fetchUnmatched()
      .then(setUnmatched)
      .catch((e: unknown) =>
        setTrayError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setUnmatchedLoading(false));
  };

  useEffect(reloadUnmatched, []);

  return (
    <div>
      <div style={{ display: "flex", gap: "0.4rem", marginBottom: "1rem" }}>
        <ModeChip
          active={mode === "phone"}
          label="Phone scan"
          onClick={() => setMode("phone")}
        />
        <ModeChip
          active={mode === "batch"}
          label="Copier batch (PDF)"
          onClick={() => setMode("batch")}
        />
      </div>

      {mode === "phone" ? (
        <PhoneScanPanel onFiled={reloadUnmatched} />
      ) : (
        <BatchUploadPanel onDone={reloadUnmatched} />
      )}

      <div style={{ marginTop: "2rem" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "0.6rem",
          }}
        >
          <h3 style={{ margin: 0, fontSize: "1rem", color: "#0f172a" }}>
            Unmatched tray{" "}
            <span style={{ color: "#94a3b8", fontWeight: 400 }}>
              ({unmatched.length})
            </span>
          </h3>
          <button
            type="button"
            onClick={reloadUnmatched}
            style={{ ...secondaryBtnStyle, padding: "0.35rem 0.7rem", fontSize: "0.82rem" }}
          >
            Refresh
          </button>
        </div>

        {unmatchedLoading && (
          <div style={{ color: "#64748b" }}>Loading…</div>
        )}
        {trayError && <div style={{ color: "#b91c1c" }}>{trayError}</div>}
        {!unmatchedLoading && unmatched.length === 0 && (
          <div style={{ color: "#64748b" }}>
            Nothing waiting — every scan was filed automatically.
          </div>
        )}

        <div style={{ display: "grid", gap: "0.4rem" }}>
          {unmatched.map((u) => (
            <div
              key={u.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                background: "#fffbeb",
                border: "1px solid #fde68a",
                borderRadius: 8,
                padding: "0.55rem 0.75rem",
                gap: "0.5rem",
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontSize: "0.88rem", color: "#92400e" }}>
                {u.batchLabel ? `${u.batchLabel} · ` : ""}
                {u.source === "batch" ? "Copier page" : "Phone scan"}
                {typeof u.pageIndex === "number" && u.pageIndex !== null
                  ? ` · p.${u.pageIndex + 1}`
                  : ""}{" "}
                <span style={{ color: "#b45309" }}>
                  · {new Date(u.createdAt).toLocaleDateString()}
                </span>
              </span>
              <span style={{ display: "flex", gap: "0.4rem" }}>
                <button
                  type="button"
                  onClick={() => setAssigning(u)}
                  style={{
                    ...primaryBtnStyle,
                    padding: "0.3rem 0.7rem",
                    fontSize: "0.82rem",
                  }}
                >
                  Assign
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    setTrayError(null);
                    try {
                      await discardUnmatched(u.id);
                      reloadUnmatched();
                    } catch (e) {
                      setTrayError(
                        e instanceof Error ? e.message : String(e),
                      );
                    }
                  }}
                  style={{
                    border: "1px solid #fecaca",
                    background: "white",
                    color: "#b91c1c",
                    borderRadius: 6,
                    padding: "0.3rem 0.7rem",
                    fontSize: "0.82rem",
                    cursor: "pointer",
                  }}
                >
                  Discard
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>

      {assigning && (
        <AssignUnmatchedModal
          onClose={() => setAssigning(null)}
          onAssign={async (sessionId, studentId) => {
            await assignUnmatched(assigning.id, sessionId, studentId);
            setAssigning(null);
            reloadUnmatched();
          }}
        />
      )}
    </div>
  );
}

function ModeChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: active ? "1px solid #0e7490" : "1px solid #cbd5e1",
        background: active ? "#0e7490" : "white",
        color: active ? "white" : "#334155",
        borderRadius: 999,
        padding: "0.4rem 0.9rem",
        fontSize: "0.88rem",
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

// Phone path: (1) decode the worksheet QR live with the camera, (2) snap/upload
// a photo of that same worksheet, (3) route both to the matched student.
function PhoneScanPanel({ onFiled }: { onFiled: () => void }) {
  const [scanning, setScanning] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onPhoto = async (file: File) => {
    if (!token) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const objectPath = await uploadObject(file);
      const sample = await routeScan({
        token,
        objectPath,
        source: "phone",
      });
      const who =
        sample.lastName && sample.firstName
          ? `${sample.firstName} ${sample.lastName}`
          : (sample.localSisId ?? "student");
      setStatus(`Filed to ${who}.`);
      setToken(null);
      onFiled();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: 10,
        padding: "1rem",
        background: "#f8fafc",
      }}
    >
      {!token && !scanning && (
        <button
          type="button"
          onClick={() => {
            setScanning(true);
            setStatus(null);
            setError(null);
          }}
          style={primaryBtnStyle}
        >
          Scan worksheet code
        </button>
      )}

      {scanning && (
        <div style={{ maxWidth: 360 }}>
          <CameraScanner
            embedded
            label="Point at the worksheet QR code"
            onScan={(text) => {
              setToken(text);
              setScanning(false);
            }}
            onCancel={() => setScanning(false)}
          />
        </div>
      )}

      {token && (
        <div>
          <div style={{ color: "#15803d", marginBottom: "0.6rem" }}>
            Code captured. Now add a photo of the worksheet.
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onPhoto(f);
              e.target.value = "";
            }}
          />
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              style={{ ...primaryBtnStyle, opacity: busy ? 0.7 : 1 }}
            >
              {busy ? "Uploading…" : "Add worksheet photo"}
            </button>
            <button
              type="button"
              onClick={() => setToken(null)}
              style={secondaryBtnStyle}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {status && (
        <div style={{ color: "#15803d", marginTop: "0.75rem" }}>{status}</div>
      )}
      {error && (
        <div style={{ color: "#b91c1c", marginTop: "0.75rem" }}>{error}</div>
      )}
    </div>
  );
}

// Copier path: upload ONE multi-page scanned PDF; the server decodes each page's
// QR and reports how many filed automatically vs. landed in the tray.
function BatchUploadPanel({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    matched: number;
    unmatched: number;
    pages: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onPdf = async (file: File) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const objectPath = await uploadObject(file);
      const r = await batchScan({ objectPath, batchLabel: file.name });
      setResult({
        matched: r.matchedCount,
        unmatched: r.unmatchedCount,
        pages: r.pageCount,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: 10,
        padding: "1rem",
        background: "#f8fafc",
      }}
    >
      <p style={{ margin: "0 0 0.75rem", color: "#475569", fontSize: "0.9rem" }}>
        Scan the completed stack at the office copier into one PDF, then upload it
        here. Pages route to each student automatically.
      </p>
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onPdf(f);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => fileRef.current?.click()}
        style={{ ...primaryBtnStyle, opacity: busy ? 0.7 : 1 }}
      >
        {busy ? "Processing…" : "Upload scanned PDF"}
      </button>

      {result && (
        <div
          style={{
            marginTop: "0.85rem",
            color: "#0f172a",
            fontSize: "0.9rem",
          }}
        >
          <strong>{result.pages}</strong> page(s) ·{" "}
          <span style={{ color: "#15803d" }}>
            {result.matched} filed automatically
          </span>{" "}
          ·{" "}
          <span style={{ color: "#b45309" }}>
            {result.unmatched} to the tray
          </span>
        </div>
      )}
      {error && (
        <div style={{ color: "#b91c1c", marginTop: "0.75rem" }}>{error}</div>
      )}
    </div>
  );
}
