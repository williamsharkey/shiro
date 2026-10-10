# Web scoreboard

How well tabcomputer's Browser app ([BROWSER.md](BROWSER.md)) shows the real
web, next to the host browser showing the same pages in a real tab. Like
[DEBIAN_SCORE.md](DEBIAN_SCORE.md), this file is what the work is steered by.

```sh
npm run build
TABCOMPUTER_TCP_RELAY=1 TABCOMPUTER_TCP_ORIGINS=http://localhost:5299 TABCOMPUTER_TCP_CONNECTS_PER_MIN=3000 TABCOMPUTER_TCP_MAX_CONNS_PER_IP=256 \
  PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &     # + TABCOMPUTER_TCP_UPSTREAM_PROXY=$HTTPS_PROXY in a proxied sandbox
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
  (`TABCOMPUTER_BROWSE_SERVER_FETCH=1`, never in production; BROWSER.md,
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
  (`TABCOMPUTER_TCP_UPSTREAM_PROXY=$HTTPS_PROXY`). Chromium uses that proxy for the
  direct column, and the sandbox's direct egress blocks some hosts the proxy
  allows (BBC, Reddit, Stack Overflow, …). Without it, the tab column lost
  those sites to the environment rather than to the Browser.
- **The relay ran with raised limits** (`TABCOMPUTER_TCP_CONNECTS_PER_MIN=3000`,
  `TABCOMPUTER_TCP_MAX_CONNS_PER_IP=256`). The production defaults are now 300/min
  and 64 concurrent (raised for browsing; BROWSER.md, "Decisions").


## NetSurf and Dillo in the VM

The same machine's other way to browse: Debian's NetSurf 3.10 (GTK 3) and
Dillo 3.0.5 (FLTK), x86-64 binaries in Blink, X11 on the desktop, and OpenSSL
in the guest over the relay (docs/GUI.md). Run with
`node tests/browser/web-score-vm.mjs`. Loaded means the window's title became
the page's; rendered means the window shows more than a blank or error page.
Neither browser runs JavaScript, so interactivity isn't measured. The guest
connects by IP address (its own resolver), which this sandbox's proxy
refuses, so this ran on a relay with direct egress and the sandbox CA in the
guest's store.

| site | NetSurf | Dillo | Browser app (TLS in the page) |
|---|---:|---:|---:|
| example.com | ✓ 24.4 s | ✓ 7.1 s | – (not in the list) |
| en.wikipedia.org/wiki/Web_browser | ✗ (window gone: crashed) | ✓ 11.8 s | ✓ 1.1 s (Main_Page) |
| news.ycombinator.com | ✓ 24.4 s | ✓ 6.2 s | ✓ 1.4 s |
| www.debian.org | ✓ 46.4 s | ✓ 9.3 s | – |
| www.google.com | ✓ 30.6 s | ✓ 5.1 s | ✓ 1.1 s |
| github.com | ✓ 80.4 s | ✓ 12.4 s | ✓ 2.1 s |
| developer.mozilla.org | ✓ 48.1 s | ✓ 10.9 s | ✓ 0.6 s |
| www.w3schools.com | ✓ 55.7 s | ✓ 11.8 s | ✓ 2.1 s |

So the VM's browsers reach most static pages, at 5 to 80 seconds a page and
without JavaScript, layout of the modern web, or video. The Browser app shows
the same pages in 1 to 2 seconds, with everything the host browser can do.

## Reading the results

Summary of the 2026-10-09 run (Chrome-shaped TLS, HTTP/2 and `location`
rewriting): the Browser app **loads 49 of 52 pages** (direct: 50),
**renders 38** (direct: 43) and is **interactive on 32** (direct: 35). Before
this round it was 50 / 37 / 29. It runs the Speedometer subset at **86% of
a real tab** (10.8 vs 12.5). Median time to load is 1.5 s against 0.8 s. The
tab-server column and the WPT tables are from the previous run (HTTP/1.1, no
script rewriting) and weren't rerun.

What changed since the previous run:

- Microsoft sign-in (`live-login`) and Zoom now work: both read their own
  hostname through `location`, which rewritten scripts now see as the real
  one (BROWSER.md, "Scripts: location and top").
- Craigslist, OpenStreetMap, gov.uk and DuckDuckGo became interactive. The
  harness now compares links with `document.URL` (real in both columns) and
  submits a search form when a narrow layout hides its box.
- Reddit no longer says "blocked by network security". It now serves its
  JavaScript challenge page, which doesn't get past it in this run.

Where the Browser still loses to the direct tab:

| site | cause | fix |
|---|---|---|
| reddit | its JS challenge page (`js_challenge=1`) after the TLS check passes | the rest of Chrome's hello (X25519MLKEM768, certificate compression); investigate the challenge |
| amazon | a bot check in both columns; in the tab its captcha page's script fails a request (`Network response was not ok`) | investigate |
| spotify, booking, cloudflare | blank or timed out in this run; each loads on its own afterwards (spotify, cloudflare: title, 3 MB, 40–150 requests) | variance; rerun |
| walmart | loads and renders; the search box didn't navigate | investigate |
| google-signin | by design: the fallback offers a real tab | — |

The tab does better than direct on Yahoo, X and Instagram, where the direct
tab tripped on bot checks or the harness's timing. Sites that fail in *both*
columns (CNN, NYTimes, eBay, IMDb, PayPal, Etsy) serve headless Chromium a
bot check or nothing, so they say nothing about the Browser. PayPal's page
was a hang until this round (a duplicate `Upgrade-Insecure-Requests` header
over HTTP/2); it now shows its security check.

The WPT totals differ between columns because testharness reports subtests
from more than one completion in some files. Compare files, not exact
fractions. The clearest gaps are request headers (98/142: the broker drops
or rewrites headers the tests set and expect echoed), redirect counting and
modes (the broker follows redirects itself), and CORS basics.

## Results

<!-- web-score:begin -->
Run 2026-10-09 20:54 UTC, Chromium 141.0.7390.37, app http://localhost:5299.

| | direct | tab | tab-server |
|---|---:|---:|---:|
| loads | 50/52 | 49/52 | 46/52 |
| renders | 43/52 | 38/52 | 33/52 |
| interactive | 35/52 | 32/52 | 28/52 |
| median time to load | 804 ms | 1454 ms | 1195 ms |
| median download per page | 1.6 MB | 1.5 MB | 1.5 MB |
| median JS heap per tab | 13.6 MB | 12.1 MB | 8.5 MB |

| site | kind | direct L R I | tab L R I | tab-server L R I | direct load | tab load | tab-server load | direct MB | tab MB | tab-server MB | notes |
|---|---|:---:|:---:|:---:|---:|---:|---:|---:|---:|---:|---|
| [google](https://www.google.com/) | search | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 0.8 s | 1.5 s | 0.5 s | 0.8 | 0.8 | 0.8 |  |
| [youtube](https://www.youtube.com/) | search | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 1.9 s | 1.7 s | 2.3 s | 3.6 | 3.2 | 4.4 |  |
| [wikipedia](https://en.wikipedia.org/wiki/Main_Page) | search | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 0.5 s | 1.1 s | 0.8 s | 0.7 | 0.5 | 0.4 |  |
| [amazon](https://www.amazon.com/) | search | ✓ ✗ ✗ | ✗ – – | ✓ ✓ ✓ | 0.9 s | – | 1.6 s | 0.3 | – | 10.1 | timeout |
| [reddit](https://www.reddit.com/) | link | ✓ ✓ ✗ | ✓ ✗ ✗ | ✗ – – | 0.8 s | 0.9 s | – | 0.9 | 0.2 | – | render: {"text":143,"imgs":1,"svgs":0,"canvases":0,"sheets":1,"h":632,"styled":true}; interactive: no link |
| [github](https://github.com/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 1.4 s | 2.7 s | 3.7 s | 3.7 | 4.1 | 4.0 |  |
| [stackoverflow](https://stackoverflow.com/questions) | link | ✓ ✓ ✗ | ✓ ✓ ✗ | ✗ – – | 0.4 s | 0.7 s | – | 1.4 | 1.5 | – | interactive: click https://stackoverflow.com/help did not navigate |
| [bing](https://www.bing.com/) | search | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 1.1 s | 1.5 s | 3.1 s | 4.3 | 3.0 | 1.5 |  |
| [duckduckgo](https://duckduckgo.com/) | search | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 0.6 s | 1.0 s | 2.8 s | 1.6 | 1.7 | 1.5 |  |
| [yahoo](https://www.yahoo.com/) | search | ✓ ✓ ✗ | ✓ ✓ ✓ | ✓ ✓ ✓ | 1.1 s | 3.2 s | 1.4 s | 3.6 | 3.8 | 2.8 |  |
| [bbc](https://www.bbc.com/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✗ – – | 1.4 s | 1.4 s | – | 3.2 | 1.7 | – |  |
| [cnn](https://www.cnn.com/) | link | ✓ ✗ ✗ | ✓ ✗ ✗ | ✓ ✗ ✗ | 0.2 s | 0.6 s | 0.6 s | 0.0 | 0.0 | 0.0 | render: {"text":13,"imgs":0,"svgs":0,"canvases":0,"sheets":0,"h":632,"styled":false}; interactive: no link |
| [nytimes](https://www.nytimes.com/) | link | ✓ ✗ ✗ | ✓ ✗ ✗ | ✗ – – | 0.6 s | 0.9 s | – | 0.3 | 0.0 | – | render: {"text":0,"imgs":0,"svgs":0,"canvases":0,"sheets":1,"h":632,"styled":true}; interactive: no link |
| [theguardian](https://www.theguardian.com/international) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✗ – – | 0.7 s | 1.1 s | – | 2.4 | 2.6 | – |  |
| [x](https://x.com/) | link | ✗ – – | ✓ ✗ ✗ | ✓ ✗ ✗ | – | 0.6 s | 0.4 s | – | 0.0 | – | render: {"text":0,"imgs":0,"svgs":0,"canvases":0,"sheets":0,"h":632,"styled":false}; interactive: no link |
| [facebook](https://www.facebook.com/) | login | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 0.7 s | 1.9 s | 0.9 s | 2.0 | 2.3 | 2.2 |  |
| [instagram](https://www.instagram.com/accounts/login/) | login | ✗ – – | ✓ ✗ ✗ | ✓ ✗ ✗ | – | 0.4 s | 0.4 s | – | 0.0 | – | render: {"text":0,"imgs":0,"svgs":0,"canvases":0,"sheets":0,"h":632,"styled":false}; interactive: no sign-in form |
| [linkedin](https://www.linkedin.com/login) | login | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 1.4 s | 2.4 s | 0.9 s | 1.3 | 1.7 | 1.7 |  |
| [netflix](https://www.netflix.com/login) | login | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 1.4 s | 2.8 s | 1.8 s | 3.0 | 2.9 | 2.9 |  |
| [microsoft](https://www.microsoft.com/en-us/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 2.6 s | 2.7 s | 4.6 s | 9.9 | 9.0 | 4.7 |  |
| [apple](https://www.apple.com/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 0.8 s | 1.6 s | 2.1 s | 1.6 | 1.6 | 1.5 |  |
| [ebay](https://www.ebay.com/) | search | ✓ ✗ ✗ | ✓ ✗ ✗ | ✓ ✗ ✗ | 0.3 s | 0.9 s | 0.9 s | 0.1 | 0.1 | 0.1 | render: {"text":194,"imgs":0,"svgs":0,"canvases":0,"sheets":1,"h":692,"styled":true}; interactive: no #gh-ac,input[name=_nkw],input[type=sea |
| [craigslist](https://sfbay.craigslist.org/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✗ | 0.5 s | 1.5 s | 1.1 s | 0.4 | 0.4 | 0.4 |  |
| [imdb](https://www.imdb.com/) | search | ✓ ✗ ✗ | ✓ ✗ ✗ | ✓ ✗ ✗ | 0.5 s | 0.9 s | 0.6 s | 0.0 | 0.0 | 0.0 | render: {"text":13,"imgs":0,"svgs":0,"canvases":0,"sheets":0,"h":632,"styled":false}; interactive: no #suggestion-search,input[name=q],input |
| [twitch](https://www.twitch.tv/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 1.7 s | 3.3 s | 3.5 s | 3.4 | 3.4 | 3.1 |  |
| [espn](https://www.espn.com/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✗ ✗ | 1.3 s | 1.8 s | 1.4 s | 3.4 | 3.6 | 0.3 |  |
| [weather](https://weather.com/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✗ ✗ | 0.7 s | 2.7 s | 1.0 s | 3.1 | 2.8 | 2.8 |  |
| [paypal](https://www.paypal.com/signin) | login | ✓ ✗ ✗ | ✓ ✗ ✗ | ✓ ✗ ✗ | 0.7 s | 0.6 s | 0.6 s | 0.3 | 0.0 | 0.0 | render: {"text":43,"imgs":0,"svgs":0,"canvases":0,"sheets":1,"h":632,"styled":true}; interactive: no sign-in form |
| [hackernews](https://news.ycombinator.com/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 0.8 s | 0.9 s | 0.9 s | 0.0 | 0.0 | 0.0 |  |
| [mdn](https://developer.mozilla.org/en-US/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 0.4 s | 0.8 s | 0.3 s | 0.5 | 0.5 | 0.5 |  |
| [npm](https://www.npmjs.com/) | search | ✓ ✓ ✗ | ✓ ✓ ✗ | ✓ ✓ ✗ | 0.4 s | 1.7 s | 0.4 s | 1.0 | 0.1 | 0.1 | interactive: no input[name=q],input[type=search],input[name=q],textarea[name=q],input[name=p],input[aria-label*=earch i],input[placeholder*= |
| [archive](https://archive.org/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 0.9 s | 0.6 s | 0.6 s | 0.7 | 0.7 | 0.4 |  |
| [openstreetmap](https://www.openstreetmap.org/) | search | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✗ | 0.9 s | 1.8 s | 1.2 s | 0.8 | 0.8 | 0.8 |  |
| [booking](https://www.booking.com/) | link | ✓ ✓ ✗ | ✓ ✗ ✗ | ✓ ✗ ✗ | 0.8 s | 4.9 s | 1.1 s | 3.8 | 0.3 | 0.3 | render: {"text":0,"imgs":0,"svgs":0,"canvases":0,"sheets":1,"h":632,"styled":true}; interactive: no link |
| [airbnb](https://www.airbnb.com/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 1.0 s | 2.7 s | 2.4 s | 4.6 | 4.1 | 3.1 |  |
| [spotify](https://open.spotify.com/) | link | ✓ ✓ ✓ | ✓ ✗ ✗ | ✓ ✓ ✓ | 1.4 s | 3.6 s | 1.7 s | 4.8 | 3.2 | 4.5 | render: {"text":0,"imgs":0,"svgs":0,"canvases":0,"sheets":4,"h":632,"styled":true}; interactive: no link |
| [zoom](https://zoom.us/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✗ ✗ | 1.9 s | 2.6 s | 1.8 s | 4.0 | 3.8 | 2.1 |  |
| [dropbox](https://www.dropbox.com/login) | login | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 1.6 s | 3.9 s | 3.1 s | 3.1 | 2.3 | 2.1 |  |
| [medium](https://medium.com/) | link | ✓ ✓ ✗ | ✓ ✓ ✗ | ✓ ✓ ✗ | 0.5 s | 0.7 s | 0.6 s | 0.0 | 0.0 | 0.0 | interactive: no link |
| [pinterest](https://www.pinterest.com/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 0.4 s | 0.9 s | 0.6 s | 5.3 | 4.3 | 3.4 |  |
| [tiktok](https://www.tiktok.com/) | link | ✓ ✓ ✗ | ✓ ✓ ✗ | ✓ ✗ ✗ | 1.0 s | 2.9 s | 1.6 s | 2.9 | 3.1 | 2.7 | interactive: no link |
| [walmart](https://www.walmart.com/) | search | ✓ ✓ ✓ | ✓ ✓ ✗ | ✓ ✓ ✓ | 1.2 s | 0.9 s | 0.6 s | 3.4 | 3.2 | 2.0 | interactive: no navigation (text 4466→4554) |
| [cloudflare](https://www.cloudflare.com/) | link | ✓ ✓ ✓ | ✗ – – | ✓ ✓ ✓ | 1.1 s | – | 1.3 s | 2.2 | – | 1.9 | timeout |
| [w3schools](https://www.w3schools.com/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 0.8 s | 1.7 s | 1.2 s | 1.3 | 1.2 | 1.1 |  |
| [nasa](https://www.nasa.gov/) | link | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 1.4 s | 2.6 s | 0.9 s | 9.1 | 6.0 | 7.7 |  |
| [govuk](https://www.gov.uk/) | search | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✗ | 0.3 s | 0.7 s | 31.2 s | 0.2 | 0.2 | 0.2 |  |
| [etsy](https://www.etsy.com/) | search | ✓ ✗ ✗ | ✓ ✗ ✗ | ✓ ✗ ✗ | 0.6 s | 1.2 s | 0.6 s | 0.0 | 0.0 | 0.3 | render: {"text":0,"imgs":0,"svgs":0,"canvases":0,"sheets":1,"h":632,"styled":true}; interactive: no input[name=search_query],input[type=sear |
| [live-login](https://login.live.com/) | login | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✗ | 1.7 s | 2.9 s | 1.7 s | 0.8 | 0.8 | 0.8 |  |
| [discord-login](https://discord.com/login) | login | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✗ ✓ | 2.2 s | 6.5 s | 25.8 s | 6.6 | 7.4 | 5.4 |  |
| [google-signin](https://accounts.google.com/) | login | ✓ ✓ ✓ | ✗ – – | ✗ – – | 0.6 s | – | – | 0.2 | – | – | fallback: google-signin; fallback: google-signin |
| [video](https://commons.wikimedia.org/wiki/File:Big_Buck_Bunny_4K.webm) | video | ✓ ✓ ✗ | ✓ ✓ ✗ | ✓ ✓ ✓ | 0.7 s | 0.6 s | 2.6 s | 1.2 | 1.2 | 1.1 | interactive: no src: t=0.0 rs=0 err=-; no src: t=0.0 rs=0 err=- |
| [websocket](https://echo.websocket.org/.ws) | ws | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | 0.5 s | 1.2 s | 0.6 s | 0.0 | 0.0 | 0.0 |  |

**Speedometer 3.1 subset** (TodoMVC-JavaScript-ES5, TodoMVC-Preact-Complex-DOM, NewsSite-Next; 3 iterations):

| | direct | tab | tab-server |
|---|---:|---:|---:|
| score | 12.5 | 10.8 | – |

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
