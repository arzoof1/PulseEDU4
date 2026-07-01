import { useEffect, useRef, useState } from "react";

type AccountMenuProps = {
  /** Initials shown in the avatar circle (a photo may replace this later). */
  initials: string;
  /** Full display name shown next to the avatar. */
  name: string;
  onChangePassword: () => void;
  onSignOut: () => void;
};

/**
 * Compact account control for the header: an "app-style" rounded container
 * holding the avatar (initials for now, photo later) + name and a kebab (⋮)
 * indicator. Clicking it opens a small dropdown with Change password and
 * Sign out. Closes on outside-click or Escape.
 */
export function AccountMenu({
  initials,
  name,
  onChangePassword,
  onSignOut,
}: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="account-menu" ref={rootRef}>
      <button
        type="button"
        className="account-menu-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        title={name}
      >
        <span className="avatar">{initials || "?"}</span>
        <span className="account-menu-name">{name}</span>
        <span className="account-menu-kebab" aria-hidden="true">
          ⋮
        </span>
      </button>
      {open && (
        <div className="account-menu-panel">
          <button
            type="button"
            className="account-menu-item"
            onClick={() => {
              setOpen(false);
              onChangePassword();
            }}
          >
            Change password
          </button>
          <button
            type="button"
            className="account-menu-item"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export default AccountMenu;
