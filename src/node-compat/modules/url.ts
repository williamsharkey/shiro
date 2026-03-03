export function createUrlModule(): any {
  return {
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    parse: (urlStr: string) => {
      try {
        const u = new URL(urlStr);
        return {
          protocol: u.protocol,
          slashes: u.protocol.endsWith(':'),
          auth: u.username ? (u.password ? `${u.username}:${u.password}` : u.username) : null,
          host: u.host,
          hostname: u.hostname,
          port: u.port || null,
          pathname: u.pathname,
          search: u.search || null,
          query: u.search ? u.search.slice(1) : null,
          hash: u.hash || null,
          path: u.pathname + (u.search || ''),
          href: u.href,
        };
      } catch { return { protocol: null, hostname: null, pathname: urlStr, path: urlStr, href: urlStr }; }
    },
    format: (urlObj: any) => {
      if (urlObj instanceof URL || urlObj.toString) return urlObj.toString();
      const { protocol, hostname, port, pathname, search, hash } = urlObj;
      return `${protocol || ''}//${hostname || ''}${port ? ':' + port : ''}${pathname || '/'}${search || ''}${hash || ''}`;
    },
    resolve: (from: string, to: string) => new URL(to, from).href,
    fileURLToPath: (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.href;
      if (u.startsWith('file://')) return decodeURIComponent(u.slice(7));
      return u;
    },
    pathToFileURL: (path: string) => new URL('file://' + encodeURI(path)),
  };
}
