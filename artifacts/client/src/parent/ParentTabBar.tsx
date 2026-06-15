// Phone-style bottom tab bar for the Parent Portal. Each tab maps to a
// self-contained screen in Dashboard.tsx, so the same screen boundaries
// transfer cleanly to a future native (iOS/Android) tab navigator. Fixed
// to the bottom with safe-area padding so it sits above the home indicator
// on notched phones.
import type { LucideIcon } from "lucide-react";
import { Home, Star, BookOpen, Mail, MoreHorizontal } from "lucide-react";

export type ParentTab = "home" | "behavior" | "academics" | "messages" | "more";

const TABS: Array<{ id: ParentTab; label: string; icon: LucideIcon }> = [
  { id: "home", label: "Home", icon: Home },
  { id: "behavior", label: "Behavior", icon: Star },
  { id: "academics", label: "Academics", icon: BookOpen },
  { id: "messages", label: "Messages", icon: Mail },
  { id: "more", label: "More", icon: MoreHorizontal },
];

export default function ParentTabBar({
  active,
  onChange,
  unreadMessages = 0,
  newAcademics = 0,
}: {
  active: ParentTab;
  onChange: (tab: ParentTab) => void;
  unreadMessages?: number;
  newAcademics?: number;
}) {
  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label="Parent portal sections"
    >
      <div className="max-w-2xl mx-auto grid grid-cols-5">
        {TABS.map((t) => {
          const isActive = t.id === active;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onChange(t.id)}
              aria-current={isActive ? "page" : undefined}
              className={
                "flex flex-col items-center justify-center gap-1 py-2 text-[11px] font-medium transition-colors " +
                (isActive
                  ? "text-violet-700"
                  : "text-slate-400 hover:text-slate-600")
              }
            >
              <span
                className={
                  "relative flex items-center justify-center h-9 w-9 rounded-full transition-colors " +
                  (isActive ? "bg-violet-100" : "")
                }
              >
                <Icon className="h-5 w-5" />
                {t.id === "messages" && unreadMessages > 0 && (
                  <span
                    className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-rose-600 text-white text-[10px] font-bold leading-none ring-2 ring-white"
                    aria-label={`${unreadMessages} unread messages`}
                  >
                    {unreadMessages > 9 ? "9+" : unreadMessages}
                  </span>
                )}
                {t.id === "academics" && newAcademics > 0 && (
                  <span
                    className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-rose-600 text-white text-[10px] font-bold leading-none ring-2 ring-white"
                    aria-label={`${newAcademics} new Learning at Home classes`}
                  >
                    {newAcademics > 9 ? "9+" : newAcademics}
                  </span>
                )}
              </span>
              {t.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
