# Browser (research spike)

tabcomputer's Browser app is a browser *shell*: tabs, an address bar,
back/forward, history, bookmarks and a password vault. The engine underneath is
the host browser's own. Rendering, JavaScript and media come free with the
iframes the tabs are built from. The one thing the host browser won't do for
us is make a request as another site. So the spike's real work is a network
and origin layer that lets an iframe on our domain show
`https://en.wikipedia.org/` as if it were there.

How well it works is measured in [WEB_SCORE.md](WEB_SCORE.md)
(`tests/browser/web-score.mjs`), as DEBIAN_SCORE.md does for Debian.

- Code: `src/browser/*` (no DOM in most of it; unit tested), `src/desktop/apps/browser.ts`
  (the app) and `browser-passwords.ts`, `scripts/build-browse.mjs`, the
  browse-host routes in `server.mjs`.
- Tests: `tests/tests/shiro-vitest/browser-core.test.ts` (origin map, HTTP/1.1,
  TLS 1.3 against a local server, keep-alive, PSL, cookie jar, WebSocket
  framing), `browser-rewrite.test.ts`, `browser-broker.test.ts` (credential, CORS, partition, navigation and framing rules), `browser-passwords.test.ts`,
  `browse-server.test.ts`, and the scoreboard.

## Moving parts

```
 desktop page (tabcomputer.com, cross-origin isolated)                       server.mjs
 ┌──────────────────────────────────────────────────────────┐
 │ Browser app ── Broker ── cookie jar (partitioned, IDB)    │
 │   tabs         │  HTTP/1.1 ── subtls TLS 1.3 ── kernel ───┼── WebSocket ──▶ /tcp relay ── TCP ──▶ site:443
 │   history      │  (keep-alive pool)            TCP socket │   (ciphertext only)
 │   vault        │                                          │
 │  ┌─────────────┼───── MessagePort per document ─────────┐ │
 │  │ iframe https://en-wikipedia-org.web.tabcomputer.com/…  │ │  first visit: bootstrap page + /__tc/{sw,boot,client}.js
 │  │   service worker (/__tc/sw.js): every request → port   │ │
 │  │   page runtime (/__tc/client.js): cookies, WebSocket,  │ │
 │  │   navigations, frames, passkey detection, autofill     │ │
 │  └────────────────────────────────────────────────────────┘ │
 └──────────────────────────────────────────────────────────┘
```

### Origins: one per proxied origin

Every real origin gets its own **browse origin**: a single DNS label that
encodes scheme, host and port (`src/browser/origin-map.ts`), substituted into a
template.

| real origin | browse origin (template `https://{key}.web.tabcomputer.com`) |
|---|---|
| `https://en.wikipedia.org` | `https://en-wikipedia-org.web.tabcomputer.com` |
| `https://a-b.example.com` | `https://a--b-example-com.web.tabcomputer.com` |
| `http://example.com:8080` | `https://example-com---h8080.web.tabcomputer.com` |

Browse origins live in their own zone, `web.`, because first-level
subdomains are users' own instances (music.tabcomputer.com and the like;
owner decision). Every instance shares that zone. So a browse host can't name
*the* app it belongs to: it lists the allowed parents (`https://tabcomputer.com`,
`https://*.tabcomputer.com`) in `frame-ancestors`, and each browse document
takes its app from the top of `location.ancestorOrigins`, which the browser
fills in and pages can't forge, checked against that list
(`parentAppOrigin`). The tab iframes therefore carry no
`referrerpolicy=no-referrer`, since that would mask the entry.

The encoding: `.`→`-`, `-`→`--`, and metadata after `---`. It is reversible and
needs no table, so the service worker, the page runtime and the broker all map
URLs on their own. Hostname labels can't start or end with `-`, so a run of
three dashes never comes from a host. Hosts that don't fit in one 63-character
label, single-label hosts and IPv6 literals have no browse origin; the app
offers "Open in a real tab" for those.

Why not one shared origin, as Ultraviolet and Scramjet use? A proxied page on
tabcomputer.com's own origin is same-origin with the desktop. It could read
the user's IndexedDB filesystem, the GitHub token in `localStorage` and every
other proxied site's data, and no in-page hook can stop that (an
`about:blank` iframe hands back pristine globals). Those proxies accept the
risk because their host page holds nothing; ours holds a computer. With one
origin per real origin, **the host browser itself** keeps every proxied
origin's storage, service worker and scripts apart from the desktop and from
each other.

It is also more compatible. Root-relative URLs, `location.pathname`,
`location.origin + '/api'` and same-origin `fetch` all work without
rewriting any JavaScript.

### The service worker and the navigation shell

A browse host serves only `/__tc/sw.js`, `/__tc/boot.js` and
`/__tc/client.js`. Every other path gets a bootstrap page that installs the
origin's service worker (scope `/`) and reloads. The server never serves the
app, `/api`, `/tcp` or anything else there (`handleBrowseHost` in server.mjs).
Its headers are COEP credentialless, CORP cross-origin, `Origin-Agent-Cluster`,
and `frame-ancestors` limited to the app and browse origins.

**Cross-origin isolation.** The desktop is cross-origin isolated (COEP
credentialless), so a cross-origin iframe loads only if its document sends
COEP and CORP or the iframe carries the `credentialless` attribute. Browse
origins send both headers themselves: the server for the bootstrap, the SW's
shell, and the broker for every proxied document. So the tab iframes don't
need the attribute, and must not use it. A credentialless iframe gets a new,
ephemeral storage partition for each top-level page load, which would throw
away the origin's service worker registration and the site's own
`localStorage`/IndexedDB. The desktop doesn't delegate `cross-origin-isolated`
to the frames, so proxied pages get no SharedArrayBuffer or high-resolution
timers from it.

From then on the service worker answers every request. It owns nothing
itself: it forwards each request over a `MessagePort` to the broker, and
**the app binds each port to one document**:

1. A navigation reaches the SW without context: it can't tell which tab, or
   which frame in a tab, asked for it. So the SW stores the request and
   answers with a tiny shell document (no network).
2. The shell posts `{tc:'hello'}` to the app with an exact `targetOrigin`.
   The app takes the shell's origin from `event.origin` and its place from the
   browser's `WindowProxy` chain (`event.source.parent…` up to a tab's
   iframe), never from the message. It answers with a fresh `MessageChannel`
   port bound to that tab, that real origin and that frame position.
3. The shell hands the port to the SW, which sends the navigation through
   it. The broker fetches, and the shell replaces itself with
   `?__tc_nav=<token>`, a one-time token for the stored response. The page
   runtime strips the token from the URL before any page script runs.
4. The SW gives the same port to the new document (`resultingClientId`) for
   its subresources. If the SW is restarted and loses ports, it asks the
   document to fetch a new one (`need-port`).

The extra hop is local and costs a few milliseconds. In exchange, nothing
security-relevant (cookie partition, whether a frame is nested, framing
rules) is ever guessed from a URL or a header the page controls.

### Network: TLS in the page

The broker speaks HTTP/1.1 (`http1.ts`) over TLS 1.3 done in the page
(`tls.ts`), over kernel TCP sockets through the existing relay
(`kernel/net.ts`, docs/NETWORKING.md). So:

- **The server only ever sees ciphertext**, exactly as for `curl` in the
  terminal today. The relay's egress policy (no private, loopback or
  metadata addresses) and its limits apply unchanged.
- Certificates are verified against Mozilla's root store (`public/browse/cacert.pem`
  from curl.se) plus any roots the user adds in the app (a company proxy's;
  the scoreboard adds its sandbox's egress CA that way).
- TLS is **subtls** (MIT; TypeScript TLS 1.3 on WebCrypto). Its limits are the
  spike's biggest known gap: TLS 1.3 only, P-256 key share, AES-128-GCM, a
  few signature algorithms, and no chain building. A TLS 1.2-only site (Hacker
  News was one when subtls was written) fails with `tls-version`, and the app
  offers a real tab. Hardening path: rustls compiled to WASM, built by us
  (Apache/MIT); epoxy-tls, which does exactly this, is AGPL.
- Connections are pooled per origin (6, idle 60 s, `netfetch.ts`). That
  matters twice over: every new connection costs a relay WebSocket and a TLS
  handshake, and the relay rate-limits connects per client IP (60/min by
  default). A news site touching 40 hosts gets close to that limit, so
  production needs browse-specific limits (an owner decision; see below).
- gzip and deflate are decoded with `DecompressionStream`. Brotli is too,
  where the browser has it; otherwise the broker doesn't advertise `br`.
- No HTTP/2 yet. Sites work over HTTP/1.1, but only with 6 parallel
  connections per origin.

The alternative is the server fetching for the page, which would see every
page and password in plaintext. It exists only as a local comparison
(`server-fetch.ts`, `SHIRO_BROWSE_SERVER_FETCH=1`, the scoreboard's
`tab-server` column) and is never on in production.

### What the broker changes

Requests (`broker.ts`) get browser-like headers: `User-Agent`,
`Accept`/`Accept-Language`, `Sec-Fetch-*`, client hints, `Origin`, and
`Referer` under the page's referrer policy. Cookies come from the jar. Page
JS can't set `Cookie`, `Origin`, `Referer` or `Host`. Cross-origin
non-simple CORS requests get a real preflight, and responses are checked
against `Access-Control-Allow-Origin` for the **real** initiating origin
before the page sees them (the SW returns constructed responses, so the
broker is what enforces CORS). Cross-origin `no-cors` requests (images, scripts, `fetch(…, {mode:'no-cors'})`)
go **without cookies**: our documents declare COEP credentialless, which
means exactly that. The rule also matters because a service worker can't make
its constructed responses opaque, so a credentialed no-cors read would hand
the page another site's private data. Each port's cookie partition is fixed
when the port is bound, so a port that outlives its document can't use a
later site's jar. Redirects are followed for subresources;
for navigations they go back to the shell, so the frame's URL follows.

Responses lose `Set-Cookie` (it goes to the jar), HSTS, Alt-Svc, COOP/COEP/CORP
(replaced with our own) and X-Frame-Options. For documents:

- **CSP** (`rewrite.ts`): `'self'` also names the real origin, and the
  runtime's nonce is added to `script-src`. `frame-ancestors`, `sandbox`,
  reporting and Trusted Types are removed. Removing `sandbox` keeps the
  service worker. Removing reporting stops the browse origin leaking to report
  collectors. Trusted Types is a known gap. `<meta http-equiv=CSP>` is
  removed.
- **HTML** (handled as latin1, so any encoding survives byte for byte): the
  runtime's `<script>` goes first in `<head>`. Absolute links, form actions,
  frames, `<base>` and meta refresh point at browse origins. Subresource URLs
  stay as they are, since the SW sees those requests anyway. A missing charset
  is filled in from `<meta charset>` so the injected tag can't push it past
  the 1024-byte sniffing window.
- **Framing**: a *nested* document is refused per its X-Frame-Options /
  `frame-ancestors`, checked against its ancestors' real origins, because the
  host browser now only sees our frame-ancestors. A tab's top document is
  never refused: the app is the browser.

### The page runtime (`client.ts`)

It is a classic script that runs before the page's own. **It is a
compatibility layer, not a security boundary.** The page can undo all of it,
and doing so gains nothing beyond what its browse origin already has.

- `document.cookie`: a snapshot from the broker, refreshed every 2 s; writes
  go back to the broker. HttpOnly cookies never reach it.
- Navigations to other origins (Navigation API `navigate` events, including
  form POSTs with their data) go to those origins' browse origins.
  `target=_blank`, modifier-clicks and `window.open` open app tabs. Iframe
  `src` (setter, `setAttribute`, parser-inserted) is pointed at browse
  origins.
- `WebSocket` is a shim that goes through the broker. The broker dials the
  real server through the relay with TLS in the page and does RFC 6455 itself
  (`websocket.ts`), sending the real `Origin` and the jar's cookies.
- `MessageEvent.origin` and `document.referrer` report real origins. The
  page's own `navigator.serviceWorker.register` is refused, because a site
  worker on the same scope would replace ours.
- Passkeys: a `navigator.credentials.get/create` call with `publicKey` is
  refused and reported, and the app shows its fallback banner. Conditional
  (autofill) requests just stay pending, as in a browser with no passkeys, so
  sites offering passkey autofill aren't flagged.
- Sign-in forms: it reports a visible password field (the app shows "🔑
  Fill"), fills only when the app says so, and reports submitted logins so
  the app can offer to save them.

Known gaps: `location.hostname`/`origin` show the browse origin, since
`location` can't be redefined. UV and Scramjet rewrite all JavaScript to
work around this (Scramjet with a Rust/WASM rewriter), and it is the largest
compatibility lever left. Also missing: `postMessage` with a real-origin
`targetOrigin` to *another* window is dropped by the browser,
`document.domain`, and `window.opener` for popups (we open app tabs instead).

### Cookies

`cookies.ts` follows RFC 6265bis: Domain validated against the Public Suffix
List (so `user.github.io` can't set cookies for every github.io site), Path,
Secure, HttpOnly, SameSite (Lax by default; a cross-site response may only
set `SameSite=None`), `__Host-`/`__Secure-` prefixes, Max-Age/Expires, and
per-domain and total limits. The jar is **partitioned by the tab's top-level
site**, like a browser that blocks third-party cookies, so a page in one tab
can't ride the session another site collected. It persists only persistent
cookies, in IndexedDB on the app's origin.

### Fallback: "Open in a real tab"

There's a button in the toolbar, and a banner when a page can't work here:

| reason | detected by |
|---|---|
| `webauthn` | the runtime: a non-conditional passkey request (passkeys are bound to the real origin) |
| `google-signin` | the broker: a navigation to `accounts.google.com` (Google refuses unknown embedders) |
| `tls` | a TLS 1.2-only server |
| `unproxyable` | an origin with no browse origin (long host, IPv6 literal, non-http scheme) |
| `no-service-worker` | the bootstrap page couldn't register its SW (third-party storage blocked) |

The banner's button opens the real URL in a host-browser tab. That can't
happen without a click, since browsers block popups that don't follow a user
gesture, so "automatic" means the problem is detected and the offer appears
with no other step.

## Passwords

`passwords.ts` and `browser-passwords.ts`:

- **Vault**: AES-256-GCM, with the key derived from a passphrase (PBKDF2-SHA-256,
  600 000 iterations, random salt; associated data tags the format). It lives
  in IndexedDB on the app's origin, which no browse origin can read. It is
  unlocked in memory (the derived key, not the passphrase) and locks after
  15 minutes idle. Nothing is synced or sent anywhere.
- **Autofill**: when a document shows a sign-in form, the app shows "🔑 Fill".
  Logins match the exact origin: one for `a.example.com` isn't offered on
  `b.example.com`, and nothing is ever offered to a third-party frame. Filling
  happens only on the user's click. Submitted logins prompt "Save the
  password…?".
- **Import from Google**: the panel walks the user through Google's own
  export: open passwords.google.com in a real tab, Settings → Export
  passwords, then choose the CSV. It also says to delete the file afterwards.
  The app never signs in to Google, never automates that page and never reads
  it. Chrome, Bitwarden, 1Password, Firefox and generic CSVs work the same way.
- **Re-import merges** (`planMerge`/`applyMerge`), as the owner asked:
  - entries match on normalized origin (scheme, host and port, lower-case;
    `android://` kept) plus username (trimmed; e-mail addresses
    case-insensitive);
  - a changed password updates the entry and pushes the old one into its
    history;
  - new entries are added;
  - rows repeated in the file count once;
  - entries that source contributed before and its new export lacks are
    **flagged for review, never deleted**;
  - one source never flags another's entries.
  
  Before anything is applied, the panel shows a one-line diff, e.g. "3 new,
  1 changed, 40 unchanged, 2 no longer in google (kept, marked for review)",
  with the names involved.
- **Bitwarden sync (designed, not built)**: Bitwarden's API is open
  (`/identity/accounts/prelogin` → KDF → `/identity/connect/token` →
  `/api/sync`, with items decrypted client-side using the master key). The
  broker's network path is a native client's, with no CORS in the way, so a
  sync could run entirely in the page. The same merge rules would apply,
  with `source: 'bitwarden'`.

## Threat model

**Assets**: the desktop (filesystem, GitHub token, shell), each site's
cookies and storage, saved passwords, and the user's traffic.

**Adversaries**: a malicious or compromised site the user browses to,
including one embedding other sites in frames; a network observer; the
tabcomputer server (honest but curious, or compromised); other origins on
the web.

| threat | mitigation | residual |
|---|---|---|
| A proxied page reaches the desktop's data or APIs | It runs on its own browse origin, cross-origin to the desktop. The tab iframe is sandboxed without `allow-top-navigation`. Browse hosts never serve the app. | Same-site subdomains (option A below) share a renderer process with the desktop under Chrome's site isolation, so Spectre-class reads are possible in principle. `Origin-Agent-Cluster` is set, and the desktop's isolation isn't delegated to frames. |
| One proxied site reads another's cookies or storage | Different browse origins for storage. The cookie jar lives in the broker, partitioned by top-level site, and a document's port is bound to its origin by `event.origin`. | Origins of the *same* site share our jar partition, as cookies do in a real browser. |
| A page forges context (pretends to be a tab's top document, another origin, another partition) | Context comes from `event.origin` and the `WindowProxy` chain, never from messages. Navigation tokens are 128-bit, single-use and expire in 60 s. A `sw` port may only navigate its own origin. | — |
| Reading another site with its cookies (`no-cors`, images on canvas) | Constructed SW responses are never opaque, so cross-origin `no-cors` requests carry no cookies (COEP credentialless semantics). CORS-mode reads need the real server's `Access-Control-Allow-Origin` for the real initiating origin. | Sites that need cookies on cross-origin images or scripts lose them (as under COEP credentialless). |
| Cross-site request forgery through the jar | Partitioned jar, SameSite enforcement, real `Origin`/`Sec-Fetch-Site` headers, CORS preflights and response checks in the broker. | Our CORS checks replace the browser's: a bug there is a cross-origin read. They are covered by WPT runs on the scoreboard. |
| Clickjacking a site inside another | Nested documents get X-Frame-Options / `frame-ancestors` enforced against their real ancestors. | — |
| Password theft by a page | The vault is on the app origin and encrypted at rest. Fill happens only on a click, only for the exact origin, and only into the top document's origin. | A page that is already malicious on its own origin can read what's typed or filled into it, as in any browser. |
| A network observer | TLS end to end from the page. The relay WebSocket is itself `wss:`. | — |
| The server sees traffic | It only relays ciphertext: SNI and IPs are visible, not content. | The relay operator sees which sites are visited (SNI), as an ISP would. |
| The server sees decrypted traffic (a fetch-through-server design) | Only with `SHIRO_BROWSE_SERVER_FETCH=1`, for local measurement; never in production (owner decision). | — |
| One instance's Browser reads another's site storage (music.tabcomputer.com vs art.tabcomputer.com) | Cookies and passwords live in each instance's own broker. | Browse-origin storage (a site's `localStorage`, IndexedDB, and our service worker) is partitioned by top-level *site*, and every instance is the same site, so instances share it. A fix would put an instance tag in the key (`www-example-com---i…`). |
| Cookie tossing from browse origins onto `.tabcomputer.com` | The page runtime's `document.cookie` never writes host cookies. | A page can still set a real cookie on `Domain=tabcomputer.com` through a pristine `Document.prototype`. The desktop and server use no cookies today, so that must stay true, or a separate domain must be used. |
| Untrusted TLS code | subtls verifies chains, names and validity, and the tests check that a bad chain and a name mismatch are refused. | subtls is "not intended for production" and unaudited. Replacing it (rustls/WASM) comes before shipping. |
| Proxy abuse (using tabcomputer as an open proxy) | The same relay policy and limits as `curl`. Optional GitHub sign-in (`TABCOMPUTER_TCP_REQUIRE_SIGNIN`). | Browsing raises connect rates; limits need tuning, not removing. |

## Prior art

- **Ultraviolet** (Titanium Network) and **Scramjet** (Mercury Workshop) are
  interception proxies with one origin and a URL prefix
  (`/service/<encoded URL>`). They rewrite HTML, CSS and *all JavaScript* so
  `location`, `document.domain`, `postMessage` and storage see the real site.
  Scramjet's rewriter is Rust in WASM. Their network goes through bare-mux
  transports, mostly Wisp (TCP multiplexed over one WebSocket) with TLS in
  the page via epoxy-tls (rustls/WASM) or libcurl.js.
- **Licenses**: both packages' npm metadata says MIT, but both tarballs ship
  an **AGPL-3.0** LICENSE file. epoxy-tls and the libcurl transport are AGPL;
  libcurl.js and wisp-js are LGPL. None is vendored here; only the design
  ideas are used.
- Taken: SW interception, TLS in the page over a WebSocket TCP tunnel, the
  runtime hooks (WebSocket, cookies, frames).
- Differs: origins per real origin instead of a shared one (security and
  compatibility, see above); a broker in the trusted page owning cookies,
  CORS and context, instead of in the SW; no JS rewriting yet; our own relay
  protocol (one WebSocket per TCP connection, docs/NETWORKING.md) instead of
  Wisp.

## Deploying

- Browse origins default to `https://{key}.web.<brand domain>` on the brand
  domain and its instances, and to `http://{key}.localhost:PORT` on localhost
  (Chromium resolves `*.localhost` itself). This needs a wildcard DNS record
  and a certificate for `*.web.tabcomputer.com` (DNS-01). `SHIRO_BROWSE_ORIGIN`
  overrides the template, `SHIRO_BROWSE_APP_ORIGINS` the allowed parents, and
  `SHIRO_BROWSE=0` turns it off. Elsewhere (no template) the app says pages
  can only open in real tabs.
- The relay must be on (`TABCOMPUTER_TCP_RELAY=1`), with the app's origins in
  `TABCOMPUTER_TCP_ORIGINS`.
- nginx: proxy `*.web.tabcomputer.com` to node like the main server block. No
  WebSocket is needed on browse hosts.
- `SHIRO_BROWSE_SERVER_FETCH=1` adds `POST /browse/fetch`, where the server
  makes the request and sees plaintext. It exists **for local measurement
  only** (the scoreboard's `tab-server` column) and must never be set in a
  production config. Even with it on, the app uses it only when its own
  `transport` setting asks.

## Decisions (owner, 2026-10-09)

1. **Domain**: subdomains of tabcomputer.com (same-site, so they survive
   third-party storage blocking), in their own zone `*.web.tabcomputer.com` so
   they never collide with users' instances. Residual risks: one renderer
   process shared with the desktop, and storage shared between instances
   (threat model).
2. **Server-side decrypting fetch: local measurement only**, behind
   `SHIRO_BROWSE_SERVER_FETCH=1`, never in production. TLS in the page over
   `/tcp` is the product path.
3. Open: **relay limits for browsing.** 60 connects/min and 16 concurrent per
   IP are tight for news sites. Options: higher limits for signed-in users, or
   multiplexing (Wisp-like) so one WebSocket carries many TCP streams.
4. User-facing strings stay brand-neutral ("the Browser app"), so the move to
   the tabcomputer repo is a rename.

## Next steps

Ordered by what the scoreboard says matters:

1. JS rewriting of `location`/`origin`, or a smaller targeted version.
2. HTTP/2.
3. TLS 1.2 and wider algorithms (rustls/WASM).
4. Multiplexed relay.
5. Persisting the HTTP cache (none yet; every visit refetches).
6. Popups with `opener` (OAuth).
7. Downloads.
