// Deployment-level AI master switch. Kept dependency-free so both
// featureLicensing and aiFeatures can import without cycles.

export function isAiGloballyEnabled(): boolean {
  const raw = process.env.AI_FEATURES_ENABLED;
  if (raw === undefined || raw === "") return true;
  const v = raw.trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "no" && v !== "off";
}
