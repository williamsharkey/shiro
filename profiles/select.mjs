// Which product profile serves a host (docs/PROFILES.md). Shared by the page
// (src/profile.ts) and server.mjs, so both pick the same one. Plain JS with no
// imports: server.mjs runs it as is.

/** Whether `hostname` matches a profile host pattern ("example.com" or "*.example.com"). */
export function hostMatches(pattern, hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  const p = String(pattern).toLowerCase();
  if (p.startsWith('*.')) return h.endsWith(p.slice(1));
  return h === p;
}

/**
 * The profile for a page: `override` (a profile id, from ?profile=) when it
 * names one, else the first whose hosts match, else the default one.
 */
export function pickProfile(profiles, hostname, override) {
  if (override) {
    const named = profiles.find((p) => p.id === override);
    if (named) return named;
  }
  return profiles.find((p) => (p.hosts || []).some((pat) => hostMatches(pat, hostname)))
    ?? profiles.find((p) => p.default)
    ?? profiles[0];
}
