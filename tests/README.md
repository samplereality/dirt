# Checks

Headless Playwright scripts that exercise the core and the extension the way the device tests
do. They are the regression suite for `dirt-core.js` and `spike-b-safari-web-extension/`.

```sh
npm install                 # once; Playwright pinned to the preinstalled Chromium
npm test                    # everything (≈ 8 minutes: the bury and growth phases run in real time)
npm run test:core           # core only (≈ 4 min)
npm run test:ext            # extension only (≈ 4 min; runs sh build.sh first)
node tests/run.mjs core-bury ext-spill    # a subset, by name prefix
```

Each script prints what it measured and ends with `PASS` or `FAIL`; screenshots and other output
go to `tests/out/` (gitignored). Look at the pictures: several of these checks are about how the
dirt *looks*, and the numbers only catch the worst cases.

| Script | What it checks | Pictures |
|---|---|---|
| `core-settle` | The sand rule alone, no browser: a vertical face crumbles into a slope within 15 ticks. Fast; run it after touching `settle()`. | – |
| `core-bury` | Bury phase on phone and desktop viewports: mean fill reaches the line, no column more than ~12 % above it, no cliff taller than 8 rows at the end; bury time. | `bury-phone.png`, `bury-desktop.png` |
| `core-restore` | `Dirt.export()` of a finished garden and forest, restored into landscape and portrait. | `restore-*.png` |
| `core-resume` | `Dirt.checkpoint()` mid-bury and mid-growth, reload, `Dirt.resume()` continues. | – |
| `core-share` | Share button appears; with no host capture or Web Share it downloads a PNG. | `share-*.png` |
| `core-resize` | Height-only resize keeps the dirt put; rotation replays the scene. | `resize-*.png` |
| `ext-autorestore` | Bury, reload: the garden returns with no click (`autorestore.js`). | `ext-autorestore.png` |
| `ext-resume` | Leave mid-bury, return: the checkpoint in `storage.local` continues the bury; album gets one entry. | – |
| `ext-album` | Two burials → two cards with thumbnails → Forget one → storage cleaned. | `ext-album.png` |
| `ext-spill` | Dirt follows links: 45 / 22 / 10 % on the next pages, present when leaving mid-bury, both via the content script and via the background's own injection. | – |

## How the extension is tested headless

`_lib.mjs` → `prepareExtension()` runs `sh build.sh`, copies `dist/chrome/` into `tests/out/`
and adds `host_permissions: ["http://localhost/*"]`, because the per-site permission prompt
cannot be clicked in headless Chromium. Tests then drive the extension from its service worker
(`sw.evaluate`) and run code in tabs with `scripting.executeScript`. Things that bit before:

- The service worker's CSP forbids `new Function` and `eval`; pass real functions as `func`.
- `tabs.query({ url })` does not match URLs with a port; find tabs by comparing `t.url`.
- `captureVisibleTab` needs `activeTab` or `<all_urls>`; a per-site grant is not enough, so the
  thumbnail in these runs is the garden alone (the real click path captures the whole tab).
- Forest growth is the slowest; waits of 40 s or more are normal at full-length timings. Most
  tests pass short `buryMs` / `growMs`.
- `prefers-reduced-motion`, the permission prompts and the Safari share sheet cannot be
  exercised here; those are the device checklist in `PHASE2.md`.
