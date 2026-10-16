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

The harness is proven against the synthetic pages (open / `DENY` / `SAMEORIGIN` / `frame-ancestors 'none'`
/ the Spike-0 heavy page — see `RESULTS.LOCAL.md`). **The live 22-site run has not happened**: the
container this was built in has no outbound web access (every external host fails DNS or the
proxy's CONNECT). Run `npm run probe` from any machine with internet; it takes about two minutes
and writes `RESULTS.md`.

Expectations to check against, from these sites' published headers (not measured here): the big
news sites, Instagram, X, YouTube, GitHub, Amazon, Google and Wikipedia all send `X-Frame-Options`
or `frame-ancestors` that forbid framing, so the iframe path will mostly be a bonus for small and
personal sites, and the screenshot path is the realistic default.

## Notes for the findings

- The iframe path is also hostile UX: Dirt sits above the frame (`pointer-events: none`), but a
  detected-blocked frame still fires `load`, so blocked frames must be decided from headers, as
  done here, not from the frame itself.
- Screenshots of paywalled and login-walled sites show the wall, not the article; that is the
  honest experience of a logged-out reader and arguably on theme.
- Privacy: this server sees every URL and fetches it; it logs nothing but keeps cached PNGs for an
  hour. The iOS routes never leave the device.
- Security: a public deployment must keep the local-address block (`validateTarget`) and should add
  rate limiting; `ALLOW_LOCAL=1` is for the self-test only.
