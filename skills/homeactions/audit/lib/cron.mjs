// POSIX cron (5 fields, as GitHub's `schedule:` uses) -> how often it fires.

function expand(field, lo, hi) {
  const out = new Set();
  for (const part of String(field).split(",")) {
    const [range, stepS] = part.split("/");
    const step = stepS ? Number(stepS) : 1;
    let a = lo;
    let b = hi;
    if (range !== "*") {
      const [x, y] = range.split("-");
      a = Number(x);
      b = y === undefined ? (stepS ? hi : a) : Number(y);
    }
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(step) || step < 1) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

/** Average number of fires per day, or null if the expression is not understood. */
export function firesPerDay(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) return null;
  const min = expand(f[0], 0, 59);
  const hour = expand(f[1], 0, 23);
  const dom = expand(f[2], 1, 31);
  const mon = expand(f[3], 1, 12);
  const dow = expand(f[4].replace(/7/g, "0"), 0, 6);
  if (!min || !hour || !dom || !mon || !dow) return null;
  const perDay = min.size * hour.size;
  let dayShare;
  const domAll = f[2] === "*";
  const dowAll = f[4] === "*";
  if (domAll && dowAll) dayShare = 1;
  else if (domAll) dayShare = dow.size / 7;
  else if (dowAll) dayShare = dom.size / 30.44;
  else dayShare = Math.min(1, dom.size / 30.44 + dow.size / 7); // cron ORs dom and dow when both are set
  return perDay * dayShare * (mon.size / 12);
}
