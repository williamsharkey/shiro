# Web scoreboard

How well tabcomputer's Browser app ([BROWSER.md](BROWSER.md)) shows the real
web, next to the host browser showing the same pages in a real tab. Like
[DEBIAN_SCORE.md](DEBIAN_SCORE.md), this file is what the work is steered by.

```sh
npm run build
SHIRO_TCP_RELAY=1 SHIRO_TCP_ORIGINS=http://localhost:5299 SHIRO_TCP_CONNECTS_PER_MIN=3000 SHIRO_TCP_MAX_CONNS_PER_IP=256 \
  PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &     # + SHIRO_TCP_UPSTREAM_PROXY=$HTTPS_PROXY in a proxied sandbox
node tests/browser/web-score.mjs --speedometer --wpt --json /tmp/web.json --md docs/WEB_SCORE.md
node tests/browser/web-score.mjs --only google,github --modes tab     # a few sites, one column
node tests/browser/web-score.mjs --from-json /tmp/web.json --md docs/WEB_SCORE.md   # re-render
```

## Columns

- **direct**: the host browser (headless Chromium) loads the site in a real
  tab. This is the ceiling: it shows what bot checks and the network allow at
  all.
- **tab**: the Browser app on the desktop, with the site on its browse origin,
  the broker doing cookies and headers, and TLS in the page over the relay.
- **tab-server**: the same app with the server doing the fetches, so the
  server sees plaintext. It's a local comparison only
  (`SHIRO_BROWSE_SERVER_FETCH=1`, never in production; BROWSER.md,
  "Decisions").
- **NetSurf / Dillo in the VM** (unix/gui's Linux GUI browsers, in Blink)
  are measured separately, on a small subset, below. They render about one
  page per half minute, so a 51-site column isn't practical.

## What each check means

Each site is loaded in a fresh tab and given 3 s to settle.

| check | passes when |
|---|---|
| **L**oads | the document (not our navigation shell) reaches `interactive` within 45 s, with no fallback |
| **R**enders | styled, ≥ 200 characters of text (open shadow roots included) or ≥ 3 images/SVGs/canvases, and ≥ 200 px tall |
| **I**nteractive | *search*: typing "web browser" + Enter in the search box navigates; *link*: clicking the first same-site link navigates; *login*: a password or username field is visible; *video*: a `<video>` plays past 1 s; *ws*: a WebSocket to wss://echo.websocket.org echoes a message from inside the page |

Download is the bytes on the wire for the page load: Playwright's response
sizes for **direct**, and the bytes the broker read from TLS for **tab**. JS
heap is the page's own V8 heap (`Runtime.getHeapUsage` on its renderer
target). For **tab** that excludes the broker, which lives in the desktop
page; it shows up as part of the desktop's heap.

## Caveats of the sandbox this ran in

- **TLS is mostly real.** The relay dials through the sandbox's HTTP proxy
  (below). For most hosts that proxy passes the site's own certificate chain
  through (BBC, Google, CNN, HN: GlobalSign, Google Trust Services, Let's
  Encrypt). For some hosts (GitHub, …) it re-signs with its own CA, which
  `--extra-roots` adds to the Browser's trust store, as a user would add a
  company proxy's. So TLS failures here are, for most sites, the in-page TLS
  meeting the real server.
- **Headless Chromium meets bot checks** (Amazon's captcha page, 403s). They
  hit both columns, which is why the direct column is there.
- **The relay dialed through the sandbox's HTTP proxy**
  (`SHIRO_TCP_UPSTREAM_PROXY=$HTTPS_PROXY`). Chromium uses that proxy for the
  direct column, and the sandbox's direct egress blocks some hosts the proxy
  allows (BBC, Reddit, Stack Overflow, …). Without it, the tab column lost
  those sites to the environment rather than to the Browser.
- **The relay ran with raised limits** (`SHIRO_TCP_CONNECTS_PER_MIN=3000`,
  `SHIRO_TCP_MAX_CONNS_PER_IP=256`). With the production defaults (60/min,
  16 concurrent) a news site alone exhausts them; see BROWSER.md, "Decisions".


## Reading the results

Summary of the 2026-10-09 run: the Browser app **loads 50 of 52 pages**
(direct: 49), **renders 37** (direct: 41) and is **interactive on 29**
(direct: 33). It runs the Speedometer subset at **84% of a real tab** (10.7
vs 12.7). Median time to load is 1.3 s against 0.9 s. The server-side fetch
does *not* do better (46/33/28): the extra round trip buys nothing, and
Node's TLS fingerprint meets the same bot walls.

Where the Browser loses to the direct tab, and why:

| site | cause | fix |
|---|---|---|
| reddit | "blocked by network security": bot detection on our TLS ClientHello | a Chrome-shaped ClientHello (rustls/WASM: X25519, ALPN, GREASE) |
| duckduckgo | this sandbox's path to DuckDuckGo drops handshakes intermittently, OpenSSL's included; in this run both TLS versions failed | none needed (retry) |
| weather, zoom | their requests now succeed (the TLS 1.2 fallback fixed weather.com's CDN), but the apps' own scripts give up after load: weather.com shows "This page couldn't load" and Zoom an empty body. Likely `location`/origin checks | `location` rewriting; investigate |
| live-login | Microsoft's sign-in script checks its own hostname and shows "Something went wrong" | `location` rewriting |
| google-signin | by design: the fallback offers a real tab | — |
| tiktok, craigslist | the clicked link didn't change the address within 15 s (client-side routing / the harness) | investigate |

Sites that fail in *both* columns (Amazon, CNN, NYTimes, eBay, IMDb, PayPal,
Booking, Etsy, X, Instagram) serve headless Chromium a bot check or nothing.
The Browser gets the same page, so they say nothing about it. The Browser
does better than direct on archive.org, Yahoo and Medium, where the direct
tab tripped on bot checks or the harness's timing.

The WPT totals differ between columns because testharness reports subtests
from more than one completion in some files. Compare files, not exact
fractions. The clearest gaps are request headers (98/142: the broker drops
or rewrites headers the tests set and expect echoed), redirect counting and
modes (the broker follows redirects itself), and CORS basics.

## Results

<!-- web-score:begin -->
Run 2026-10-09 17:38 UTC, Chromium 141.0.7390.37, app http://localhost:5299.

| | direct | tab | tab-server |
|---|---:|---:|---:|
| loads | 49/52 | 50/52 | 46/52 |
| renders | 41/52 | 37/52 | 33/52 |
| interactive | 33/52 | 29/52 | 28/52 |
| median time to load | 940 ms | 1317 ms | 1195 ms |
| median download per page | 1.5 MB | 1.6 MB | 1.5 MB |
| median JS heap per tab | 10.9 MB | 10.2 MB | 8.5 MB |

| site | kind | direct L R I | tab L R I | tab-server L R I | direct load | tab load | tab-server load | direct MB | tab MB | tab-server MB | notes |
|---|---|:---:|:---:|:---:|---:|---:|---:|---:|---:|---:|---|
| [google](https://www.google.com/) | search | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 0.8 s | 1.1 s | 0.5 s | 0.8 | 0.8 | 0.8 |  |
| [youtube](https://www.youtube.com/) | search | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 2.1 s | 3.3 s | 2.3 s | 3.6 | 4.5 | 4.4 |  |
| [wikipedia](https://en.wikipedia.org/wiki/Main_Page) | search | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 0.6 s | 1.1 s | 0.8 s | 0.7 | 0.4 | 0.4 |  |
| [amazon](https://www.amazon.com/) | search | ✓ ✗ ✗ | ✓ ✗ ✗ | ✓ ✓ ✓ | 0.9 s | 0.9 s | 1.6 s | 0.3 | 0.3 | 10.1 | render: {"text":0,"imgs":0,"svgs":0,"canvases":0,"sheets":1,"h":632,"styled":true}; interactive: no #twotabsearchtextbox,input[type=search], |
| [reddit](https://www.reddit.com/) | link | ✓ ✓ ✗ | ✓ ✗ ✗ | ✗ – – | 0.9 s | 0.9 s | – | 0.9 | 0.2 | – | render: {"text":143,"imgs":1,"svgs":0,"canvases":0,"sheets":1,"h":632,"styled":true}; interactive: no link |
| [github](https://github.com/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 1.5 s | 2.1 s | 3.7 s | 3.7 | 4.1 | 4.0 |  |
| [stackoverflow](https://stackoverflow.com/questions) | link | ✓ ✓ ✗ | ✓ ✓ ✗ | ✗ – – | 0.5 s | 0.7 s | – | 1.5 | 0.1 | – | interactive: no link |
| [bing](https://www.bing.com/) | search | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 1.2 s | 1.7 s | 3.1 s | 3.2 | 3.1 | 1.5 |  |
| [duckduckgo](https://duckduckgo.com/) | search | ✓ ✓ ✓ | ✗ – – | ✓ ✓ ✓ | 8.1 s | – | 2.8 s | 1.6 | – | 1.5 | fallback: tls; fallback: tls |
| [yahoo](https://www.yahoo.com/) | search | ✓ ✓ ✗ | ✓ ✓ ✓ | ✓ ✓ ✓ | 0.8 s | 2.0 s | 1.4 s | 3.7 | 3.7 | 2.8 |  |
| [bbc](https://www.bbc.com/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✗ – – | 1.3 s | 1.3 s | – | 3.2 | 1.7 | – |  |
| [cnn](https://www.cnn.com/) | link | ✓ ✗ ✗ | ✓ ✗ ✗ | ✓ ✗ ✗ | 0.2 s | 0.6 s | 0.6 s | 0.0 | 0.0 | 0.0 | render: {"text":13,"imgs":0,"svgs":0,"canvases":0,"sheets":0,"h":632,"styled":false}; interactive: no link |
| [nytimes](https://www.nytimes.com/) | link | ✓ ✗ ✗ | ✓ ✗ ✗ | ✗ – – | 0.5 s | 0.6 s | – | 0.3 | 0.0 | – | render: {"text":0,"imgs":0,"svgs":0,"canvases":0,"sheets":1,"h":632,"styled":true}; interactive: no link |
| [theguardian](https://www.theguardian.com/international) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✗ – – | 1.0 s | 0.9 s | – | 2.4 | 2.3 | – |  |
| [x](https://x.com/) | link | ✗ – – | ✓ ✗ ✗ | ✓ ✗ ✗ | – | 0.6 s | 0.4 s | – | 0.0 | – | render: {"text":0,"imgs":0,"svgs":0,"canvases":0,"sheets":0,"h":632,"styled":false}; interactive: no link |
| [facebook](https://www.facebook.com/) | login | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 0.9 s | 1.2 s | 0.9 s | 2.0 | 2.2 | 2.2 |  |
| [instagram](https://www.instagram.com/accounts/login/) | login | ✗ – – | ✓ ✗ ✗ | ✓ ✗ ✗ | – | 0.4 s | 0.4 s | – | 0.0 | – | render: {"text":0,"imgs":0,"svgs":0,"canvases":0,"sheets":0,"h":632,"styled":false}; interactive: no sign-in form |
| [linkedin](https://www.linkedin.com/login) | login | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 1.5 s | 1.8 s | 0.9 s | 1.3 | 1.7 | 1.7 |  |
| [netflix](https://www.netflix.com/login) | login | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 1.7 s | 2.2 s | 1.8 s | 3.0 | 2.9 | 2.9 |  |
| [microsoft](https://www.microsoft.com/en-us/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 3.2 s | 2.1 s | 4.6 s | 9.0 | 5.3 | 4.7 |  |
| [apple](https://www.apple.com/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 1.3 s | 1.8 s | 2.1 s | 1.6 | 1.6 | 1.5 |  |
| [ebay](https://www.ebay.com/) | search | ✓ ✗ ✗ | ✓ ✗ ✗ | ✓ ✗ ✗ | 0.5 s | 0.9 s | 0.9 s | 0.1 | 0.1 | 0.1 | render: {"text":194,"imgs":0,"svgs":0,"canvases":0,"sheets":1,"h":692,"styled":true}; interactive: no #gh-ac,input[name=_nkw],input[type=sea |
| [craigslist](https://sfbay.craigslist.org/) | link | ✓ ✓ ✓ | ✓ ✓ ✗ | ✓ ✓ ✗ | 1.0 s | 1.5 s | 1.1 s | 0.4 | 0.4 | 0.4 | interactive: click http://www-craigslist-org.localhost:5299/subarea/sfc did not navigate |
| [imdb](https://www.imdb.com/) | search | ✓ ✗ ✗ | ✓ ✗ ✗ | ✓ ✗ ✗ | 0.4 s | 0.6 s | 0.6 s | 0.0 | 0.0 | 0.0 | render: {"text":13,"imgs":0,"svgs":0,"canvases":0,"sheets":0,"h":632,"styled":false}; interactive: no #suggestion-search,input[name=q],input |
| [twitch](https://www.twitch.tv/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 2.0 s | 2.8 s | 3.5 s | 3.6 | 3.3 | 3.1 |  |
| [espn](https://www.espn.com/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✗ ✗ | 2.2 s | 2.1 s | 1.4 s | 3.6 | 3.0 | 0.3 |  |
| [weather](https://weather.com/) | link | ✓ ✓ ✓ | ✓ ✗ ✗ | ✓ ✗ ✗ | 0.8 s | 1.5 s | 1.0 s | 3.1 | 2.5 | 2.8 | render: {"text":70,"imgs":0,"svgs":1,"canvases":0,"sheets":7,"h":632,"styled":true}; interactive: no link |
| [paypal](https://www.paypal.com/signin) | login | ✓ ✗ ✗ | ✓ ✗ ✗ | ✓ ✗ ✗ | 0.6 s | 1.2 s | 0.6 s | 0.1 | 0.0 | 0.0 | render: {"text":43,"imgs":0,"svgs":0,"canvases":0,"sheets":1,"h":632,"styled":true}; interactive: no sign-in form |
| [hackernews](https://news.ycombinator.com/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 0.6 s | 1.4 s | 0.9 s | 0.0 | 0.0 | 0.0 |  |
| [mdn](https://developer.mozilla.org/en-US/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 0.4 s | 0.6 s | 0.3 s | 0.5 | 0.5 | 0.5 |  |
| [npm](https://www.npmjs.com/) | search | ✓ ✓ ✗ | ✓ ✓ ✗ | ✓ ✓ ✗ | 0.4 s | 0.6 s | 0.4 s | 0.9 | 0.1 | 0.1 | interactive: no input[name=q],input[type=search],input[name=q],textarea[name=q],input[name=p],input[aria-label*=earch i],input[placeholder*= |
| [archive](https://archive.org/) | link | ✗ – – | ✓ ✓ ✓ | ✓ ✓ ✓ | – | 0.7 s | 0.6 s | – | 0.6 | 0.4 |  |
| [openstreetmap](https://www.openstreetmap.org/) | search | ✓ ✓ ✗ | ✓ ✓ ✗ | ✓ ✓ ✗ | 0.7 s | 1.9 s | 1.2 s | 0.8 | 0.8 | 0.8 | interactive: no navigation (text 565→565) |
| [booking](https://www.booking.com/) | link | ✓ ✗ ✗ | ✓ ✗ ✗ | ✓ ✗ ✗ | 1.4 s | 0.9 s | 1.1 s | 0.3 | 0.3 | 0.3 | render: {"text":0,"imgs":0,"svgs":0,"canvases":0,"sheets":1,"h":632,"styled":true}; interactive: no link |
| [airbnb](https://www.airbnb.com/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 1.3 s | 2.7 s | 2.4 s | 3.9 | 4.3 | 3.1 |  |
| [spotify](https://open.spotify.com/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 1.4 s | 2.3 s | 1.7 s | 5.0 | 4.8 | 4.5 |  |
| [zoom](https://zoom.us/) | link | ✓ ✓ ✓ | ✓ ✗ ✗ | ✓ ✗ ✗ | 2.3 s | 2.2 s | 1.8 s | 3.9 | 3.1 | 2.1 | render: {"text":0,"imgs":0,"svgs":0,"canvases":0,"sheets":0,"h":632,"styled":false}; interactive: no link |
| [dropbox](https://www.dropbox.com/login) | login | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 1.7 s | 3.5 s | 3.1 s | 3.1 | 2.1 | 2.1 |  |
| [medium](https://medium.com/) | link | ✓ ✓ ✗ | ✓ ✓ ✓ | ✓ ✓ ✗ | 0.5 s | 1.3 s | 0.6 s | 0.0 | 2.4 | 0.0 |  |
| [pinterest](https://www.pinterest.com/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 0.5 s | 0.9 s | 0.6 s | 5.0 | 5.7 | 3.4 |  |
| [tiktok](https://www.tiktok.com/) | link | ✓ ✓ ✓ | ✓ ✓ ✗ | ✓ ✗ ✗ | 1.5 s | 1.2 s | 1.6 s | 3.8 | 3.0 | 2.7 | interactive: no link |
| [walmart](https://www.walmart.com/) | search | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 1.3 s | 1.3 s | 0.6 s | 2.8 | 3.8 | 2.0 |  |
| [cloudflare](https://www.cloudflare.com/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 1.0 s | 2.3 s | 1.3 s | 2.2 | 2.8 | 1.9 |  |
| [w3schools](https://www.w3schools.com/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 0.7 s | 2.1 s | 1.2 s | 1.3 | 1.2 | 1.1 |  |
| [nasa](https://www.nasa.gov/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 1.2 s | 1.6 s | 0.9 s | 10.0 | 1.7 | 7.7 |  |
| [govuk](https://www.gov.uk/) | search | ✓ ✓ ✗ | ✓ ✓ ✗ | ✓ ✓ ✗ | 0.4 s | 0.7 s | 31.2 s | 0.2 | 0.1 | 0.2 | interactive: no navigation (text 3697→3697) |
| [etsy](https://www.etsy.com/) | search | ✓ ✗ ✗ | ✓ ✗ ✗ | ✓ ✗ ✗ | 0.8 s | 1.1 s | 0.6 s | 0.3 | 0.0 | 0.3 | render: {"text":0,"imgs":0,"svgs":0,"canvases":0,"sheets":1,"h":632,"styled":true}; interactive: no input[name=search_query],input[type=sear |
| [live-login](https://login.live.com/) | login | ✓ ✓ ✓ | ✓ ✓ ✗ | ✓ ✓ ✗ | 1.5 s | 2.3 s | 1.7 s | 0.8 | 0.8 | 0.8 | interactive: no sign-in form |
| [discord-login](https://discord.com/login) | login | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✗ ✓ | 2.3 s | 7.9 s | 25.8 s | 6.6 | 7.1 | 5.4 |  |
| [google-signin](https://accounts.google.com/) | login | ✓ ✓ ✓ | ✗ – – | ✗ – – | 0.7 s | – | – | 0.2 | – | – | fallback: google-signin; fallback: google-signin |
| [video](https://commons.wikimedia.org/wiki/File:Big_Buck_Bunny_4K.webm) | video | ✓ ✓ ✗ | ✓ ✓ ✗ | ✓ ✓ ✓ | 0.4 s | 1.2 s | 2.6 s | 1.2 | 1.2 | 1.1 | interactive: ebm/Big_Buck_Bunny_4K.webm.240p.vp9.webm: t=0.0 rs=0 err=-; ebm/Big_Buck_Bunny_4K.webm.240p.vp9.webm: t=0.0 rs=0 err=- |
| [websocket](https://echo.websocket.org/.ws) | ws | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 0.8 s | 0.9 s | 0.6 s | 0.0 | 0.0 | 0.0 |  |

**Speedometer 3.1 subset** (TodoMVC-JavaScript-ES5, TodoMVC-Preact-Complex-DOM, NewsSite-Next; 3 iterations):

| | direct | tab | tab-server |
|---|---:|---:|---:|
| score | 12.7 | 10.7 | – |

**Web Platform Tests** (wpt.live; passed/total subtests):

| test | direct | tab | tab-server |
|---|---:|---:|---:|
| [/fetch/api/basic/request-headers.any.html](https://wpt.live/fetch/api/basic/request-headers.any.html) | 175/175 | 98/142 | – |
| [/fetch/api/basic/accept-header.any.html](https://wpt.live/fetch/api/basic/accept-header.any.html) | 16/16 | 16/16 | – |
| [/fetch/api/basic/response-url.sub.any.html](https://wpt.live/fetch/api/basic/response-url.sub.any.html) | 0/4 | 0/4 | – |
| [/fetch/api/redirect/redirect-count.any.html](https://wpt.live/fetch/api/redirect/redirect-count.any.html) | 30/30 | 10/17 | – |
| [/fetch/api/redirect/redirect-mode.any.html](https://wpt.live/fetch/api/redirect/redirect-mode.any.html) | 90/121 | 48/101 | – |
| [/fetch/api/cors/cors-basic.any.html](https://wpt.live/fetch/api/cors/cors-basic.any.html) | 13/24 | 7/24 | – |
| [/fetch/api/cors/cors-preflight.any.html](https://wpt.live/fetch/api/cors/cors-preflight.any.html) | 10/22 | 57/64 | – |
| [/fetch/api/credentials/cookies.any.html](https://wpt.live/fetch/api/credentials/cookies.any.html) | 49/49 | 49/49 | – |
| [/fetch/content-encoding/gzip/gzip-body.any.html](https://wpt.live/fetch/content-encoding/gzip/gzip-body.any.html) | 6/6 | 6/6 | – |
| [/fetch/range/general.any.html](https://wpt.live/fetch/range/general.any.html) | 20/22 | 17/20 | – |
| [/xhr/send-redirect.htm](https://wpt.live/xhr/send-redirect.htm) | 136/136 | 115/129 | – |
| [/cookies/attributes/path.html](https://wpt.live/cookies/attributes/path.html) | 0/21 | 0/21 | – |
| [/cookies/samesite/fetch.https.html](https://wpt.live/cookies/samesite/fetch.https.html) | 0/12 | harness did not complete in 90 s | – |
| [/html/browsers/history/the-location-interface/location_hostname.html](https://wpt.live/html/browsers/history/the-location-interface/location_hostname.html) | 2/2 | 2/2 | – |
<!-- web-score:end -->
