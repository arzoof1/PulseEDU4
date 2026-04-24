import { useState } from "react";
import {
  Award,
  ShoppingBag,
  Clock,
  Footprints,
  ArrowRightLeft,
  HeartHandshake,
  Accessibility,
  GraduationCap,
  Layers,
  Mail,
  StickyNote,
  CalendarClock,
  ChevronDown,
  Lock,
  FileDown,
  Send,
  Eye,
  X,
} from "lucide-react";

type SectionKey =
  | "recognition"
  | "store"
  | "tardies"
  | "passes"
  | "pullouts"
  | "interventions"
  | "accommodations"
  | "fast"
  | "mtss"
  | "comms"
  | "notes"
  | "iss";

type Section = {
  key: SectionKey;
  label: string;
  icon: typeof Award;
  schoolHidden?: boolean;
  description: string;
};

const SECTIONS: Section[] = [
  { key: "recognition", label: "Recognition & PBIS Points", icon: Award, description: "Points, milestones, recognition entries" },
  { key: "store", label: "School Store Activity", icon: ShoppingBag, description: "Items earned and redeemed" },
  { key: "tardies", label: "Attendance & Tardies", icon: Clock, description: "Late arrivals by period" },
  { key: "passes", label: "Hall Pass Activity", icon: Footprints, description: "Movement, destinations, durations" },
  { key: "pullouts", label: "Pullouts Received", icon: ArrowRightLeft, description: "Counselor, behavior, academic pullouts" },
  { key: "interventions", label: "Intervention Log", icon: HeartHandshake, schoolHidden: true, description: "Trusted-adult check-ins and supports" },
  { key: "accommodations", label: "Accommodations Log", icon: Accessibility, description: "IEP / 504 supports provided" },
  { key: "fast", label: "FAST Academic Scores", icon: GraduationCap, description: "ELA + Math PM1 / PM2 / PM3" },
  { key: "mtss", label: "MTSS Plan Summary", icon: Layers, description: "Tier, goals, progress" },
  { key: "comms", label: "Communication History", icon: Mail, description: "All emails sent home" },
  { key: "notes", label: "Notes from Staff", icon: StickyNote, schoolHidden: true, description: "Qualitative observations" },
  { key: "iss", label: "ISS Attendance", icon: CalendarClock, description: "In-school suspension days" },
];

const DEFAULT_ON: SectionKey[] = [
  "recognition",
  "store",
  "tardies",
  "passes",
  "accommodations",
  "fast",
  "mtss",
  "comms",
];

export function ReportToggle() {
  const [included, setIncluded] = useState<Set<SectionKey>>(new Set(DEFAULT_ON));
  const [format, setFormat] = useState<"app" | "pdf" | "email">("app");
  const [weekly, setWeekly] = useState(true);

  const toggle = (k: SectionKey, disabled?: boolean) => {
    if (disabled) return;
    setIncluded((s) => {
      const n = new Set(s);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
  };

  const enabledCount = SECTIONS.filter((s) => !s.schoolHidden && included.has(s.key)).length;
  const totalAvailable = SECTIONS.filter((s) => !s.schoolHidden).length;

  return (
    <div className="min-h-screen bg-slate-100 flex items-start justify-center p-6 font-sans">
      <div className="w-full max-w-[560px] bg-white rounded-2xl shadow-2xl ring-1 ring-slate-200 overflow-hidden">
        {/* Brand band */}
        <div className="h-1.5 bg-gradient-to-r from-violet-600 via-teal-600 to-green-600" />

        {/* Header */}
        <div className="px-6 pt-5 pb-4 border-b border-slate-100 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-600 to-green-600 flex items-center justify-center text-white">
                <FileDown className="w-4 h-4" />
              </div>
              <h2 className="text-lg font-bold text-slate-900">HeartBEAT Report Settings</h2>
            </div>
            <p className="text-xs text-slate-500 mt-1.5 ml-10">
              Choose what's included when you view, download, or email the HeartBEAT Report for{" "}
              <span className="font-medium text-slate-700">Maya Rodriguez</span>.
            </p>
          </div>
          <button className="text-slate-400 hover:text-slate-600 -mt-1" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-4 space-y-5">
          {/* Date range */}
          <div>
            <label className="text-xs font-semibold text-slate-700 uppercase tracking-wide">
              Date range
            </label>
            <div className="mt-2 relative">
              <select
                defaultValue="semester"
                className="w-full appearance-none border border-slate-300 rounded-lg pl-3 pr-9 py-2.5 text-sm font-medium text-slate-800 bg-white hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-500"
              >
                <option value="7">Past 7 days</option>
                <option value="30">Past 30 days</option>
                <option value="quarter">This quarter</option>
                <option value="semester">This semester</option>
                <option value="year">School year</option>
              </select>
              <ChevronDown className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            </div>
          </div>

          {/* Format */}
          <div>
            <label className="text-xs font-semibold text-slate-700 uppercase tracking-wide">
              Format
            </label>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {[
                { v: "app" as const, label: "View", icon: Eye },
                { v: "pdf" as const, label: "PDF", icon: FileDown },
                { v: "email" as const, label: "Email", icon: Send },
              ].map(({ v, label, icon: Icon }) => {
                const active = format === v;
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setFormat(v)}
                    className={[
                      "flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-medium border transition",
                      active
                        ? "border-violet-500 bg-violet-50 text-violet-800 ring-2 ring-violet-500/20"
                        : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50",
                    ].join(" ")}
                  >
                    <Icon className="w-4 h-4" />
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Sections */}
          <div>
            <div className="flex items-baseline justify-between">
              <label className="text-xs font-semibold text-slate-700 uppercase tracking-wide">
                Include in this report
              </label>
              <span className="text-[11px] text-slate-500">
                {enabledCount} of {totalAvailable} selected
              </span>
            </div>
            <div className="mt-2 border border-slate-200 rounded-xl divide-y divide-slate-100 overflow-hidden">
              {SECTIONS.map((s) => {
                const checked = included.has(s.key);
                const disabled = !!s.schoolHidden;
                const Icon = s.icon;
                return (
                  <label
                    key={s.key}
                    className={[
                      "flex items-start gap-3 px-3.5 py-2.5 cursor-pointer transition",
                      disabled ? "bg-slate-50/60 cursor-not-allowed" : "hover:bg-slate-50",
                    ].join(" ")}
                  >
                    <div
                      onClick={() => toggle(s.key, disabled)}
                      className={[
                        "mt-0.5 w-9 h-5 rounded-full relative shrink-0 transition",
                        disabled
                          ? "bg-slate-200"
                          : checked
                          ? "bg-gradient-to-r from-violet-600 to-green-600"
                          : "bg-slate-300",
                      ].join(" ")}
                    >
                      <div
                        className={[
                          "absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all",
                          checked && !disabled ? "left-[18px]" : "left-0.5",
                        ].join(" ")}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Icon
                          className={[
                            "w-4 h-4 shrink-0",
                            disabled ? "text-slate-400" : "text-slate-600",
                          ].join(" ")}
                        />
                        <span
                          className={[
                            "text-sm font-medium truncate",
                            disabled ? "text-slate-500" : "text-slate-800",
                          ].join(" ")}
                        >
                          {s.label}
                        </span>
                        {disabled && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-slate-200 text-slate-600">
                            <Lock className="w-2.5 h-2.5" />
                            School: hidden
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-500 mt-0.5 ml-6 leading-snug">
                        {s.description}
                      </p>
                    </div>
                  </label>
                );
              })}
            </div>
            <p className="text-[11px] text-slate-500 mt-2 leading-snug">
              Sections marked <span className="font-medium">School: hidden</span> have been disabled
              by your school and can't be turned on here.
            </p>
          </div>

          {/* Weekly email */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 py-3 flex items-start gap-3">
            <div
              onClick={() => setWeekly((v) => !v)}
              className={[
                "mt-0.5 w-9 h-5 rounded-full relative shrink-0 cursor-pointer transition",
                weekly ? "bg-gradient-to-r from-violet-600 to-green-600" : "bg-slate-300",
              ].join(" ")}
            >
              <div
                className={[
                  "absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all",
                  weekly ? "left-[18px]" : "left-0.5",
                ].join(" ")}
              />
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-slate-800">Email me this report every Sunday</p>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Sent to <span className="font-medium">parent@example.com</span>. You can pause or
                change this anytime.
              </p>
            </div>
          </div>
        </div>

        {/* Footer actions */}
        <div className="px-6 py-4 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between gap-3">
          <button className="text-sm font-medium text-slate-600 hover:text-slate-800 px-3 py-2">
            Cancel
          </button>
          <div className="flex items-center gap-2">
            <button className="text-sm font-medium text-slate-700 hover:text-slate-900 px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50">
              Save preferences
            </button>
            <button className="text-sm font-semibold text-white px-4 py-2 rounded-lg bg-gradient-to-r from-violet-600 via-teal-600 to-green-600 hover:opacity-95 shadow-sm">
              Generate Report
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
