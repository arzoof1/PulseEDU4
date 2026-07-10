import { useEffect, useRef, useState, type CSSProperties } from "react";

type AccountMenuProps = {
  /** Initials shown in the avatar circle (a photo may replace this later). */
  initials: string;
  /** Full display name shown next to the avatar. */
  name: string;
  onChangePassword: () => void;
  onManageTwoFactor?: () => void;
  /** When true, show an attention dot (2FA required for this role but not yet
   *  enrolled) on the trigger and next to the Two-factor item. */
  twoFactorAttention?: boolean;
  onSignOut: () => void;
};

const ATTENTION_DOT_STYLE: CSSProperties = {
  display: "inline-block",
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: "#ea580c",
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
  onManageTwoFactor,
  twoFactorAttention,
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
        {twoFactorAttention && (
          <span
            aria-label="Two-factor setup required"
            title="Two-factor authentication setup required"
            style={{ ...ATTENTION_DOT_STYLE, marginLeft: 2 }}
          />
        )}
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
          {onManageTwoFactor && (
            <button
              type="button"
              className="account-menu-item"
              onClick={() => {
                setOpen(false);
                onManageTwoFactor();
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                justifyContent: "space-between",
              }}
            >
              <span>Two-factor authentication</span>
              {twoFactorAttention && <span style={ATTENTION_DOT_STYLE} />}
            </button>
          )}
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
