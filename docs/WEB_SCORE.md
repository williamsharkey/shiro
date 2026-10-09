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

- **The sandbox re-signs TLS.** Its egress gateway terminates TLS for every
  host with its own CA, so `--extra-roots` adds that CA to the Browser's trust
  store, as a user would add a company proxy's. That means the subtls
  numbers here are TLS 1.3 against *the gateway*, not against each site.
  Real-world TLS compatibility (TLS 1.2-only servers, unusual chain
  algorithms) has to be measured on tabcomputer.com: the same command works
  there without `--extra-roots`.
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


## Results

<!-- web-score:begin -->
<!-- web-score:end -->
