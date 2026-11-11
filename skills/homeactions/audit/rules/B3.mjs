// B3: long artefact retention (default 90 days) and loose cache keys. Storage, not minutes.
import { result, ev, zero } from "../lib/rule-kit.mjs";

export const id = "B3";
export const area = "budget";
export const title = "Long artefact retention";
const meta = { id, area, title, risk: "low", effort: "low", reversible: true, appliesOn: "both",
  fix: "Set `retention-days:` (e.g. 3-7 for CI artefacts, 14 for reports) on every upload-artifact step; key caches on lockfile hashes." };

export const MAX_DAYS = 14;

export function detect(ctx) {
  const ups = [];
  for (const j of ctx.jobs) for (const s of j.steps) if (typeof s.uses === "string" && /^actions\/upload-artifact@/.test(s.uses)) ups.push({ j, s, days: s.with?.["retention-days"] });
  if (!ups.length) return result(meta, "not-found", { summary: "No upload-artifact step." });
  const long = ups.filter((u) => u.days == null || (typeof u.days === "number" && u.days > MAX_DAYS));
  const storage = zero("storage, not minutes: artefact storage is billed in GB-months, separately from minutes");
  if (!long.length) return result(meta, "already-done", { summary: `All ${ups.length} artefact uploads keep ${MAX_DAYS} days or less.`, evidence: ups.map((u) => ev(u.j.file, u.s._line)), minutes: storage });
  return result(meta, "found", {
    summary: long.map((u) => `${u.j.key}: ${u.days == null ? "no retention-days (repository default, up to 90)" : `retention-days ${u.days}`}`).join("; "),
    evidence: long.map((u) => ev(u.j.file, u.s._line)),
    minutes: storage,
  });
}
export default { id, area, title, detect };
