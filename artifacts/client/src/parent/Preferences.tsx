import { useEffect, useState } from "react";
import { ArrowLeft, Mail, Eye, EyeOff, Shield, RotateCcw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { parentFetch } from "./api";

type SectionKey =
  | "showRecognition"
  | "showAttendance"
  | "showHallPasses"
  | "showAccommodations"
  | "showFastScores"
  | "showCommHistory"
  | "showPullouts"
  | "showInterventions"
  | "showStaffNotes"
  | "showIss"
  | "showMtss"
  | "showOss";

interface SectionRow {
  key: SectionKey;
  schoolEnabled: boolean;
  parentPref: boolean | null;
}

interface PrefsResponse {
  studentId: number;
  sections: SectionRow[];
  weeklyEmailAllowed: boolean;
  weeklyEmailEnabled: boolean;
  dateRangeDefault: "semester" | "month" | "all";
}

interface SectionLabel {
  key: SectionKey;
  label: string;
  description: string;
  sensitive?: boolean;
}

const SECTION_LABELS: SectionLabel[] = [
  {
    key: "showRecognition",
    label: "Recognition",
    description: "PBIS points, weekly mood meter, and recent praise.",
  },
  {
    key: "showAttendance",
    label: "Attendance",
    description: "Tardies, check-ins, and check-outs this week.",
  },
  {
    key: "showHallPasses",
    label: "Hall passes",
    description: "Hall pass count and recent destinations.",
  },
  {
    key: "showAccommodations",
    label: "Accommodations",
    description:
      "Active 504 / IEP / ELL accommodations on file (no plan documents).",
  },
  {
    key: "showFastScores",
    label: "FAST scores",
    description: "Florida ELA + Math PM1 / PM2 / PM3 results.",
  },
  {
    key: "showCommHistory",
    label: "Communication history",
    description: "Recent emails and calls between school staff and family.",
  },
  {
    key: "showPullouts",
    label: "Pullouts",
    description: "Scheduled academic supports your child is pulled for.",
  },
  {
    key: "showInterventions",
    label: "Interventions",
    description:
      "Tier 2 / Tier 3 interventions logged by staff.",
    sensitive: true,
  },
  {
    key: "showStaffNotes",
    label: "Staff notes",
    description:
      "Free-form notes from teachers, counselors, or administrators.",
    sensitive: true,
  },
  {
    key: "showIss",
    label: "ISS (in-school suspension)",
    description: "ISS placements and durations.",
    sensitive: true,
  },
  {
    key: "showOss",
    label: "OSS (out-of-school suspension)",
    description:
      "Out-of-school suspension days this year. Reasons appear only if your school chose to share them.",
    sensitive: true,
  },
  {
    key: "showMtss",
    label: "MTSS plans",
    description: "Active multi-tiered support plan, goals, and progress notes.",
    sensitive: true,
  },
];

interface Props {
  studentId: number;
  studentName: string;
  onBack: () => void;
}

export default function Preferences({ studentId, studentName, onBack }: Props) {
  const [data, setData] = useState<PrefsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<SectionKey | "weeklyEmail" | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    parentFetch(`/api/parent/heartbeat-prefs?studentId=${studentId}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        return (await r.json()) as PrefsResponse;
      })
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not load preferences");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId]);

  async function savePref(updates: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await parentFetch("/api/parent/heartbeat-prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId, ...updates }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
      return false;
    }
  }

  async function toggleSection(key: SectionKey, currentlyShown: boolean) {
    if (!data) return;
    setSavingKey(key);
    setError(null);
    // currently shown means parentPref is null OR true. We hide by writing
    // false. We re-show by writing null (revert to inherit).
    const newPref: boolean | null = currentlyShown ? false : null;
    const previous = data.sections.find((s) => s.key === key)?.parentPref ?? null;
    setData({
      ...data,
      sections: data.sections.map((s) =>
        s.key === key ? { ...s, parentPref: newPref } : s,
      ),
    });
    const ok = await savePref({ prefs: { [key]: newPref } });
    if (!ok) {
      // Roll back on failure
      setData((d) =>
        d
          ? {
              ...d,
              sections: d.sections.map((s) =>
                s.key === key ? { ...s, parentPref: previous } : s,
              ),
            }
          : d,
      );
    }
    setSavingKey(null);
  }

  async function toggleWeeklyEmail() {
    if (!data) return;
    setSavingKey("weeklyEmail");
    setError(null);
    const next = !data.weeklyEmailEnabled;
    const previous = data.weeklyEmailEnabled;
    setData({ ...data, weeklyEmailEnabled: next });
    const ok = await savePref({ weeklyEmailEnabled: next });
    if (!ok) {
      setData((d) => (d ? { ...d, weeklyEmailEnabled: previous } : d));
    }
    setSavingKey(null);
  }

  return (
    <div className="min-h-screen bg-slate-50 font-sans pb-24">
      <div className="h-1.5 w-full bg-gradient-to-r from-violet-600 via-teal-600 to-green-600" />
      <main className="max-w-3xl mx-auto px-6 pt-8 space-y-6">
        <div className="flex items-center justify-between">
          <Button variant="ghost" onClick={onBack} className="gap-2">
            <ArrowLeft className="h-4 w-4" />
            Back to {studentName}'s snapshot
          </Button>
        </div>

        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            What you see
          </h1>
          <p className="text-sm text-slate-600">
            Choose which parts of {studentName}'s HeartBEAT snapshot you want
            visible. You can hide a section the school has shown — you can't
            reveal one the school has hidden.
          </p>
        </div>

        {error && (
          <div
            className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-3 text-sm"
            role="alert"
          >
            {error}
          </div>
        )}

        {loading && (
          <div className="text-sm text-slate-500 text-center py-12">
            Loading…
          </div>
        )}

        {data && !loading && (
          <>
            <Card>
              <CardContent className="p-0">
                {SECTION_LABELS.map((s, idx) => {
                  const row = data.sections.find((x) => x.key === s.key);
                  if (!row) return null;
                  const visible =
                    row.schoolEnabled && row.parentPref !== false;
                  const hiddenByParent =
                    row.schoolEnabled && row.parentPref === false;
                  const isSaving = savingKey === s.key;
                  return (
                    <div
                      key={s.key}
                      className={
                        "flex items-start gap-4 p-4 " +
                        (idx > 0 ? "border-t border-slate-100" : "")
                      }
                    >
                      <div className="mt-0.5 text-slate-400">
                        {visible ? (
                          <Eye className="h-4 w-4" />
                        ) : (
                          <EyeOff className="h-4 w-4" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-slate-900">
                            {s.label}
                          </span>
                          {s.sensitive && (
                            <Badge
                              variant="outline"
                              className="text-[10px] uppercase tracking-wider border-amber-300 text-amber-700"
                            >
                              Sensitive
                            </Badge>
                          )}
                          {!row.schoolEnabled && (
                            <Badge
                              variant="outline"
                              className="text-[10px] uppercase tracking-wider border-slate-300 text-slate-500 gap-1"
                            >
                              <Shield className="h-3 w-3" />
                              Hidden by school
                            </Badge>
                          )}
                          {hiddenByParent && (
                            <Badge
                              variant="outline"
                              className="text-[10px] uppercase tracking-wider border-slate-300 text-slate-500"
                            >
                              You hid this
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm text-slate-600 mt-1 leading-snug">
                          {s.description}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 pt-1">
                        <Switch
                          checked={visible}
                          disabled={!row.schoolEnabled || isSaving}
                          onCheckedChange={() =>
                            toggleSection(s.key, visible)
                          }
                          aria-label={`${visible ? "Hide" : "Show"} ${s.label}`}
                        />
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            {/* Weekly email opt-in */}
            <Card>
              <CardContent className="p-4">
                <div className="flex items-start gap-4">
                  <div className="mt-0.5 text-violet-500">
                    <Mail className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-slate-900">
                        Weekly email
                      </span>
                      {!data.weeklyEmailAllowed && (
                        <Badge
                          variant="outline"
                          className="text-[10px] uppercase tracking-wider border-slate-300 text-slate-500 gap-1"
                        >
                          <Shield className="h-3 w-3" />
                          Disabled by school
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-slate-600 mt-1 leading-snug">
                      Receive a Sunday-evening snapshot summary by email for{" "}
                      {studentName}.
                    </p>
                  </div>
                  <div className="flex items-center pt-1">
                    <Switch
                      checked={data.weeklyEmailEnabled}
                      disabled={
                        !data.weeklyEmailAllowed ||
                        savingKey === "weeklyEmail"
                      }
                      onCheckedChange={toggleWeeklyEmail}
                      aria-label="Toggle weekly email"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="text-xs text-slate-500 flex items-center gap-1.5">
              <RotateCcw className="h-3 w-3" />
              Toggling a hidden section back on returns it to the school's
              default — flipping it off hides it from your view only.
            </div>
          </>
        )}
      </main>
    </div>
  );
}
