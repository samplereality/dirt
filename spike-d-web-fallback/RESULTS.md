# Spike D results — 2026-10-17

Device profile: iPhone 14 (Playwright descriptor), headless Chromium. Screenshot = full page capped at 12000 px.

| Site | Category | Status | Frameable? | Why | Screenshot | Usable? | Time |
|---|---|---|---|---|---|---|---|
| NYTimes | news, ad-heavy, paywall | 403 | **no** | X-Frame-Options DENY | 390×664 “nytimes.com” | **suspect** | 11826 ms |
| Guardian | news, ad-heavy | 200 | **no** | X-Frame-Options SAMEORIGIN | 390×12000 “Latest news, sport and opinion from the ” | yes | 8558 ms |
| BBC | news | 200 | **no** | X-Frame-Options SAMEORIGIN | 390×10196 “BBC News - Breaking news, video and the ” | yes | 6713 ms |
| Washington Post | news, paywall | 200 | **no** | X-Frame-Options SAMEORIGIN | 390×12000 “The Washington Post - Breaking news and ” | yes | 8822 ms |
| Wikipedia | reference | 200 | yes | no framing restrictions in headers | 390×7088 “Soil - Wikipedia” | yes | 3831 ms |
| Instagram | social, login wall | 200 | **no** | X-Frame-Options DENY | 390×709 “Instagram” | **suspect** | 2326 ms |
| X / Twitter | social, JS app | 200 | **no** | CSP frame-ancestors 'self' https://x.com https://x.com:443 https://twitter.com https://twitter.com:443 (not our origin) | 390×664 “X. It’s what’s happening / X” | **suspect** | 26169 ms |
| Reddit | social, JS app | 200 | **no** | X-Frame-Options SAMEORIGIN | 390×12000 “Gardening, Plants, and Agriculture.” | yes | 8452 ms |
| YouTube | video, JS app | 200 | **no** | X-Frame-Options SAMEORIGIN | 390×664 “YouTube” | **suspect** | 2404 ms |
| GitHub | app | 200 | **no** | CSP frame-ancestors 'none' (not our origin) | 390×1317 “GitHub - samplereality/dirt: Bury the We” | yes | 2784 ms |
| WSJ | paywall | 401 | yes | no framing restrictions in headers | 390×664 “wsj.com” | **suspect** | 3400 ms |
| New Yorker | paywall, long-form | 200 | **no** | CSP frame-ancestors 'self' https://copilot-app.condenast.io https://stg-copilot-app.condenast.io (not our origin) | 390×12000 “The New Yorker” | yes | 32935 ms |
| Medium | metered paywall | 200 | **no** | CSP frame-ancestors 'self' https://medium.com (not our origin) | 390×664 “Medium: Read and write stories.” | **suspect** | 2751 ms |
| Substack | newsletter | 200 | **no** | CSP frame-ancestors 'self' https://*.substack.com https://substack.com (not our origin) | 390×12000 “Substack” | yes | 9407 ms |
| Amazon | commerce, heavy | 200 | yes | no framing restrictions in headers | 390×4242 “Amazon.com. Spend less. Smile more.” | yes | 29036 ms |
| Apple | marketing, animations | 200 | **no** | X-Frame-Options SAMEORIGIN | 390×12000 “Apple” | yes | 7382 ms |
| Google Maps | JS-heavy app, WebGL | 200 | **no** | X-Frame-Options SAMEORIGIN | 390×664 “Google Maps” | **suspect** | 2888 ms |
| Craigslist | plain HTML | 200 | **no** | CSP frame-ancestors https://*.craigslist.org (not our origin) | 390×664 “craigslist: charlotte jobs, apartments, ” | **suspect** | 2923 ms |
| Internet Archive | archive | 200 | yes | no framing restrictions in headers | 390×7757 “Internet Archive: Digital Library of Fre” | yes | 6217 ms |
| Davidson College | institutional | 200 | **no** | X-Frame-Options SAMEORIGIN | 390×6970 “Davidson College | Davidson” | yes | 5961 ms |
| samplereality.com | personal site | 200 | **no** | X-Frame-Options SAMEORIGIN | 390×10922 “@samplereality – Digital Skulduggery & m” | yes | 7801 ms |
| MDN | documentation | 200 | **no** | X-Frame-Options DENY | 390×12000 “<iframe> HTML inline frame element - HTM” | yes | 5628 ms |

Frameable: 4 / 22. Screenshots captured: 22 / 22; usable (200 and taller than one screen): 14 / 22.

"Suspect" captures are one screen tall or a non-200 answer: a bot block (403/401), a login or consent wall, or an app shell that rendered nothing without interaction. Open the PNG in `cache/` to see which.
