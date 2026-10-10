export function createUrlModule(cwd: () => string = () => '/'): any {
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
    // Legacy url.resolve: the base may be relative ("/a/b") or protocol-relative
    // ("//host/"), which new URL() rejects (pnpm's registry auth keys)
    resolve: (from: string, to: string) => {
      const r = new URL(to, new URL(from, 'resolve://'));
      if (r.protocol !== 'resolve:') return r.href;
      const rest = r.href.slice('resolve:'.length);
      return from.startsWith('//') || to.startsWith('//') ? rest : r.pathname + r.search + r.hash;
    },
    fileURLToPath: (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.href;
      if (u.startsWith('file://')) return decodeURIComponent(u.slice(7));
      return u;
    },
    // As node: a relative path is resolved against the cwd, and the path is a
    // URL pathname (rolldown's ids like "\0rolldown/runtime.js" made file://%00...,
    // an invalid URL)
    pathToFileURL: (path: string) => {
      let p = String(path);
      if (!p.startsWith('/')) p = (cwd().replace(/\/$/, '') || '') + '/' + p;
      const u = new URL('file://');
      u.pathname = p.replace(/%/g, '%25').replace(/\\/g, '%5C').replace(/\n/g, '%0A').replace(/\r/g, '%0D').replace(/\t/g, '%09');
      return u;
    },
  };
}
