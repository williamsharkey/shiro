/** A node guest's (a Worker: no document): the page's, from its start message */
let fromPage: string | null = null;
export function setShiroOrigin(origin: string | null): void { fromPage = origin; }

export function getShiroOrigin(): string {
  if (fromPage) return fromPage;
  if (typeof document !== 'undefined') {
    const baseHref =
      document.querySelector('base[href]')?.getAttribute('href') ||
      document.baseURI;
    if (baseHref) {
      try {
        const origin = new URL(
          baseHref,
          typeof window !== 'undefined' ? window.location.href : 'https://shiro.computer/',
        ).origin;
        if (origin && origin !== 'null') return origin;
      } catch {}
    }
  }

  if (typeof window !== 'undefined') {
    const origin = window.location.origin;
    if (origin && origin !== 'null') return origin;
  }

  return 'https://shiro.computer';
}
