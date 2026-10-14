# Spike D results — 2026-10-14

Device profile: iPhone 14 (Playwright descriptor), headless Chromium. Screenshot = full page capped at 12000 px.

| Site | Category | Status | Frameable? | Why | Screenshot | Time |
|---|---|---|---|---|---|---|
| local open | self-test | 200 | yes | no framing restrictions in headers | 390×2809 | 3465 ms |
| local XFO DENY | self-test | 200 | **no** | X-Frame-Options DENY | 390×2788 | 1841 ms |
| local XFO SAMEORIGIN | self-test | 200 | **no** | X-Frame-Options SAMEORIGIN | 390×2833 | 1874 ms |
| local CSP none | self-test | 200 | **no** | CSP frame-ancestors 'none' | 390×2788 | 1765 ms |
| local heavy (Spike 0 page) | self-test | 200 | yes | no framing restrictions in headers | 390×12000 “Dirt — Spike 0 heavy test page” | 9346 ms |

Frameable: 2 / 5. Clean screenshots: 5 / 5.
