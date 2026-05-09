export const WL_COLORS = {
  bg: "#F4F1EA",
  panel: "#FFFFFF",
  ink: "#1F1B16",
  inkSoft: "#5B5249",
  line: "#E7E0D2",
  brand: "#7A1F2B",
  brandSoft: "#F5E2E5",
  accent: "#C9A961",
  warn: "#B8531A",
  warnSoft: "#FBE6D4",
  alert: "#9B1C2E",
  alertSoft: "#F6D7DC",
  ok: "#3B6B4C",
  okSoft: "#DDEBDF",
  cool: "#2D4F6B",
  coolSoft: "#DCE6EE",
  graphBg: "#FAF7F0",
};

export type Role =
  | "direct"
  | "target"
  | "instigator"
  | "rumor"
  | "witness"
  | "peripheral"
  | "deescalator";

export const ROLE_META: Record<Role, { label: string; color: string; soft: string }> = {
  direct: { label: "Direct", color: WL_COLORS.alert, soft: WL_COLORS.alertSoft },
  target: { label: "Target", color: WL_COLORS.brand, soft: WL_COLORS.brandSoft },
  instigator: { label: "Instigator", color: "#7A2E1A", soft: "#EFD9CF" },
  rumor: { label: "Rumor spreader", color: WL_COLORS.warn, soft: WL_COLORS.warnSoft },
  witness: { label: "Witness", color: WL_COLORS.cool, soft: WL_COLORS.coolSoft },
  peripheral: { label: "Peripheral", color: "#7A6B5A", soft: "#E6DFD3" },
  deescalator: { label: "De-escalator", color: WL_COLORS.ok, soft: WL_COLORS.okSoft },
};

export const INTERACTION_KINDS = [
  { value: "fight", label: "Fight" },
  { value: "verbal", label: "Verbal altercation" },
  { value: "rumor", label: "Rumor" },
  { value: "property", label: "Property damage" },
  { value: "bullying", label: "Bullying" },
  { value: "peripheral_note", label: "Peripheral note" },
  { value: "other", label: "Other" },
] as const;

export function initialsOf(first: string, last: string): string {
  const a = (first || "").trim().charAt(0).toUpperCase();
  const b = (last || "").trim().charAt(0).toUpperCase();
  return (a + b) || "??";
}

export function severityChipStyle(s: number): { bg: string; fg: string; label: string } {
  if (s >= 4) return { bg: WL_COLORS.alertSoft, fg: WL_COLORS.alert, label: "High" };
  if (s === 3) return { bg: WL_COLORS.warnSoft, fg: WL_COLORS.warn, label: "Med" };
  if (s === 2) return { bg: WL_COLORS.okSoft, fg: WL_COLORS.ok, label: "Low" };
  return { bg: WL_COLORS.coolSoft, fg: WL_COLORS.cool, label: "Note" };
}

export function statusPillStyle(s: string): { bg: string; fg: string; label: string } {
  if (s === "escalated") return { bg: WL_COLORS.alertSoft, fg: WL_COLORS.alert, label: "Escalated" };
  if (s === "monitoring") return { bg: WL_COLORS.coolSoft, fg: WL_COLORS.cool, label: "Monitoring" };
  if (s === "closed") return { bg: WL_COLORS.bg, fg: WL_COLORS.inkSoft, label: "Closed" };
  return { bg: WL_COLORS.brandSoft, fg: WL_COLORS.brand, label: "Open" };
}
