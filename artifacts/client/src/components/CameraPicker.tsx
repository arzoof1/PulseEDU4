import { useEffect, useId, useState } from "react";
import { authFetch } from "../lib/authToken";

interface CameraOption {
  id: number;
  name: string;
  location: string | null;
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  borderColor?: string;
  bg?: string;
  inkSoft?: string;
  placeholder?: string;
  required?: boolean;
}

// Camera-name picker backed by the per-school camera registry. Uses a
// native <datalist> so we get free filterable autocomplete in every
// browser without pulling in a combobox dependency, and admins who
// genuinely need to type a one-off name (e.g. a temporary mobile
// camera not in the registry yet) can still do so — the input
// accepts arbitrary text and we just submit whatever they typed.
//
// Schools commonly run 200+ cameras with structured names like
// "Building 4 / 2nd Floor / East Hallway / Cam 12". Datalist filters
// substring matches as the admin types, so they can narrow to the
// right camera in 4–5 keystrokes instead of scrolling a giant select.
export default function CameraPicker({
  value,
  onChange,
  borderColor = "#E5E7EB",
  bg = "#FFFFFF",
  inkSoft = "#6B7280",
  placeholder = "Type to filter cameras…",
  required = false,
}: Props) {
  const [cameras, setCameras] = useState<CameraOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const listId = useId();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await authFetch("/api/watchlist/cameras");
        if (!r.ok) {
          // Most likely a non-admin viewer hit a form they shouldn't
          // see anyway (the admin gate returns 403). Degrade quietly
          // to plain text input — no dropdown, but typing still works.
          setLoadError(`Could not load cameras (HTTP ${r.status})`);
          return;
        }
        const j = (await r.json()) as { cameras: CameraOption[] };
        if (!cancelled) setCameras(j.cameras);
      } catch (e) {
        if (!cancelled) {
          setLoadError(
            e instanceof Error ? e.message : "Could not load cameras",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="block">
      <input
        type="text"
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        autoComplete="off"
        maxLength={200}
        className="w-full rounded-md border px-2.5 py-1.5"
        style={{ borderColor, background: bg }}
      />
      <datalist id={listId}>
        {cameras.map((cam) => (
          <option
            key={cam.id}
            value={cam.name}
            label={cam.location ?? undefined}
          />
        ))}
      </datalist>
      {loadError ? (
        <div
          className="mt-1 text-[10px]"
          style={{ color: inkSoft }}
          title={loadError}
        >
          Camera registry unavailable — type the camera name.
        </div>
      ) : cameras.length === 0 ? (
        <div className="mt-1 text-[10px]" style={{ color: inkSoft }}>
          No cameras configured yet. Add some in School Settings → Cameras,
          or type a name to log it now.
        </div>
      ) : (
        <div className="mt-1 text-[10px]" style={{ color: inkSoft }}>
          {cameras.length} camera{cameras.length === 1 ? "" : "s"} registered
          — start typing to filter, or type a one-off name.
        </div>
      )}
    </div>
  );
}
