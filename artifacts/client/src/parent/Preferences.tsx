import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Mail,
  Eye,
  EyeOff,
  Shield,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import QRCode from "qrcode";
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

            <TwoStepCard />
          </>
        )}
      </main>
    </div>
  );
}

// =============================================================================
// Two-step verification (TOTP). Optional, per-parent. Enrolls via:
//   1) "Set up" → password gate → server returns a fresh secret + otpauth URI
//   2) Parent scans the QR with Google Authenticator / 1Password / Authy
//   3) Enters first 6-digit code → server verifies and persists
// Disable requires both password AND a current code (so a stolen password
// alone can't turn off 2FA).
// =============================================================================
type TotpMode =
  | { kind: "idle" }
  | { kind: "setup-password" }
  | {
      kind: "setup-confirm";
      secret: string;
      otpauthUri: string;
      qrDataUrl: string;
    }
  | { kind: "disable" };

function TwoStepCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [enabledAt, setEnabledAt] = useState<string | null>(null);
  const [mode, setMode] = useState<TotpMode>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");

  useEffect(() => {
    loadStatus();
  }, []);

  async function loadStatus() {
    try {
      const r = await parentFetch("/api/parent-auth/totp/status");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as {
        enabled: boolean;
        enabledAt: string | null;
      };
      setEnabled(j.enabled);
      setEnabledAt(j.enabledAt);
    } catch {
      setEnabled(false);
    }
  }

  function reset() {
    setMode({ kind: "idle" });
    setPassword("");
    setCode("");
    setErr(null);
  }

  async function startSetup(e: React.FormEvent) {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await parentFetch("/api/parent-auth/totp/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: password }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        secret?: string;
        otpauthUri?: string;
        error?: string;
      };
      if (!r.ok || !j.secret || !j.otpauthUri) {
        setErr(j.error ?? "Could not start setup");
        return;
      }
      const qrDataUrl = await QRCode.toDataURL(j.otpauthUri, { margin: 1 });
      setMode({
        kind: "setup-confirm",
        secret: j.secret,
        otpauthUri: j.otpauthUri,
        qrDataUrl,
      });
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  async function confirmSetup(e: React.FormEvent) {
    e.preventDefault();
    if (mode.kind !== "setup-confirm" || code.length < 6) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await parentFetch("/api/parent-auth/totp/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: mode.secret, code }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        setErr(j.error ?? "That code didn't match.");
        return;
      }
      reset();
      await loadStatus();
    } finally {
      setBusy(false);
    }
  }

  async function disable(e: React.FormEvent) {
    e.preventDefault();
    if (!password || code.length < 6) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await parentFetch("/api/parent-auth/totp/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: password, code }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        setErr(j.error ?? "Could not turn off two-step verification.");
        return;
      }
      reset();
      await loadStatus();
    } finally {
      setBusy(false);
    }
  }

  if (enabled === null) return null;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start gap-4">
          <div className="mt-0.5 text-violet-500">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-slate-900">
                Two-step verification
              </span>
              {enabled ? (
                <Badge className="text-[10px] uppercase tracking-wider bg-green-100 text-green-800 hover:bg-green-100">
                  On
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="text-[10px] uppercase tracking-wider border-slate-300 text-slate-500"
                >
                  Off
                </Badge>
              )}
            </div>
            <p className="text-sm text-slate-600 mt-1 leading-snug">
              {enabled
                ? `Sign-in requires a 6-digit code from your authenticator app${enabledAt ? ` (since ${new Date(enabledAt).toLocaleDateString()})` : ""}.`
                : "Add a second step at sign-in with an authenticator app like Google Authenticator, 1Password, or Authy."}
            </p>
          </div>
          {mode.kind === "idle" && (
            <Button
              variant={enabled ? "outline" : "default"}
              size="sm"
              onClick={() =>
                setMode({ kind: enabled ? "disable" : "setup-password" })
              }
            >
              {enabled ? "Turn off" : "Set up"}
            </Button>
          )}
        </div>

        {mode.kind === "setup-password" && (
          <form onSubmit={startSetup} className="space-y-2 pl-8">
            <label className="text-sm text-slate-700 block">
              Confirm your current password to continue.
            </label>
            <input
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
            />
            {err && (
              <div className="text-xs text-red-600">{err}</div>
            )}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={busy || !password}>
                Continue
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={reset}
                disabled={busy}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}

        {mode.kind === "setup-confirm" && (
          <form onSubmit={confirmSetup} className="space-y-3 pl-8">
            <div className="text-sm text-slate-700">
              Scan this QR code with your authenticator app, then enter the
              6-digit code it shows.
            </div>
            <div className="flex flex-col sm:flex-row gap-4 items-start">
              <img
                src={mode.qrDataUrl}
                alt="Authenticator QR code"
                className="h-40 w-40 border border-slate-200 rounded"
              />
              <div className="flex-1 min-w-0 space-y-2">
                <div className="text-xs text-slate-500">
                  Can't scan? Type this key into your app:
                </div>
                <div className="font-mono text-xs bg-slate-50 border border-slate-200 rounded px-2 py-1.5 break-all">
                  {mode.secret}
                </div>
                <label className="text-sm text-slate-700 block pt-1">
                  6-digit code
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) =>
                    setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  disabled={busy}
                  className="w-32 border border-slate-300 rounded-md px-3 py-2 text-base font-mono tracking-[0.3em] text-center"
                />
              </div>
            </div>
            {err && <div className="text-xs text-red-600">{err}</div>}
            <div className="flex gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={busy || code.length < 6}
              >
                Turn on
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={reset}
                disabled={busy}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}

        {mode.kind === "disable" && (
          <form onSubmit={disable} className="space-y-2 pl-8">
            <div className="text-sm text-slate-700">
              Enter your password and a current 6-digit code to turn off
              two-step verification.
            </div>
            <input
              type="password"
              autoComplete="current-password"
              autoFocus
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
            />
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="6-digit code"
              value={code}
              onChange={(e) =>
                setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
              }
              disabled={busy}
              className="w-32 border border-slate-300 rounded-md px-3 py-2 text-base font-mono tracking-[0.3em] text-center"
            />
            {err && <div className="text-xs text-red-600">{err}</div>}
            <div className="flex gap-2">
              <Button
                type="submit"
                size="sm"
                variant="destructive"
                disabled={busy || !password || code.length < 6}
              >
                Turn off
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={reset}
                disabled={busy}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
