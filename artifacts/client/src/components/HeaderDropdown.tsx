import { useEffect, useRef, useState, type ReactNode } from "react";

// Lightweight header dropdown: a caller-controlled trigger plus a floating
// panel that closes on outside-click or Escape. Used in the top bar to keep
// the header to a single row on laptops/PCs — account actions live behind the
// avatar, and secondary controls collapse into a "More" menu when space runs
// low. The panel is portal-free (absolutely positioned inside the trigger
// wrapper) so it inherits the header's stacking context.
export function HeaderDropdown({
  renderTrigger,
  children,
  align = "right",
  panelWidth = 220,
}: {
  renderTrigger: (state: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  panelWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      {renderTrigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          className="header-menu-panel"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: align === "right" ? 0 : undefined,
            left: align === "left" ? 0 : undefined,
            minWidth: panelWidth,
          }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
