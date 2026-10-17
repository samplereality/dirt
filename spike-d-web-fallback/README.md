# Spike D — web fallback (no iOS, no install)

A small Node server with Playwright. The reader pastes a URL; the server probes the response
headers and either frames the live page (when `X-Frame-Options` / `frame-ancestors` allow it) or
takes a full-page iPhone-sized screenshot; Dirt then buries whichever one is on screen.

```sh
npm install
npm run fallback                       # http://localhost:8787
ALLOW_LOCAL=1 npm run fallback         # also allow localhost targets (needed for the self-test)
npx playwright install chromium        # once; or skip it and use PW_CHANNEL=chrome below
npm run probe                          # run sites.json → results.json + RESULTS.md
PW_CHANNEL=chrome npm run probe        # same, driving the installed Google Chrome (no Playwright download needed)
ALLOW_LOCAL=1 node spike-d-web-fallback/probe-sites.mjs spike-d-web-fallback/sites.local.json   # offline self-test
```

Files

- `server.mjs` — `/api/probe?url=` (framing verdict from headers, following redirects, mobile UA),
  `/api/shot?url=` (PNG; `&meta=1` for JSON), synthetic `/test/*` pages with known headers, 1-hour disk cache in `cache/`.
- `public/index.html` — the paste-a-URL page. Mode `auto` uses the probe; `iframe` and `screenshot` force one path.
- `probe-sites.mjs`, `sites.json` — the 22-site test set and the harness that writes `RESULTS.md`.
- `sites.local.json`, `RESULTS.LOCAL.md` — the offline self-test and its output.

## Status

Live survey done (2026-10-17, `RESULTS.md`): 4 / 22 sites frameable, 14 / 22 screenshots usable.
The eight "suspect" captures are bot blocks (NYTimes 403, WSJ 401), login walls (Instagram, X)
and one-screen app shells (YouTube, Google Maps, Medium, Craigslist). `--rebuild` regenerates
the table from `results.json` without re-fetching, e.g. after a verdict-rule change.

The offline self-test (`sites.local.json`, `RESULTS.LOCAL.md`) covers open / `DENY` /
`SAMEORIGIN` / `frame-ancestors 'none'` against synthetic pages.

## Notes for the findings

- The iframe path is also hostile UX: Dirt sits above the frame (`pointer-events: none`), but a
  detected-blocked frame still fires `load`, so blocked frames must be decided from headers, as
  done here, not from the frame itself.
- Screenshots of paywalled and login-walled sites show the wall, not the article; that is the
  honest experience of a logged-out reader and arguably on theme. NYTimes and WSJ go further and
  refuse headless Chrome at the HTTP level (403 / 401).
- Privacy: this server sees every URL and fetches it; it logs nothing but keeps cached PNGs for an
  hour. The iOS routes never leave the device.
- Security: a public deployment must keep the local-address block (`validateTarget`) and should add
  rate limiting; `ALLOW_LOCAL=1` is for the self-test only.
