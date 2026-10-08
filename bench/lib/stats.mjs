// Order statistics for benchmark samples.

export function quantile(sorted, q) {
  if (!sorted.length) return null;
  // Nearest-rank on the sorted samples (p90 of 5 samples is the 5th)
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

export function summarize(samples) {
  const s = samples.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return { median: null, p90: null, min: null, max: null, n: 0 };
  const mid = s.length >> 1;
  const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return { median, p90: quantile(s, 0.9), min: s[0], max: s[s.length - 1], n: s.length };
}

export function round(x, digits = 3) {
  if (x == null || !Number.isFinite(x)) return x;
  const abs = Math.abs(x);
  const d = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 10 ? 2 : digits;
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
