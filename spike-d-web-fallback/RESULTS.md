# Spike D results — 2026-10-17

Device profile: iPhone 14 (Playwright descriptor), headless Chromium. Screenshot = full page capped at 12000 px.

| Site | Category | Status | Frameable? | Why | Screenshot | Time |
|---|---|---|---|---|---|---|
| NYTimes | news, ad-heavy, paywall | 403 | **no** | X-Frame-Options DENY | 390×664 “nytimes.com” | 11826 ms |
| Guardian | news, ad-heavy | 200 | **no** | X-Frame-Options SAMEORIGIN | 390×12000 “Latest news, sport and opinion from the ” | 8558 ms |
| BBC | news | 200 | **no** | X-Frame-Options SAMEORIGIN | 390×10196 “BBC News - Breaking news, video and the ” | 6713 ms |
| Washington Post | news, paywall | 200 | **no** | X-Frame-Options SAMEORIGIN | 390×12000 “The Washington Post - Breaking news and ” | 8822 ms |
| Wikipedia | reference | 200 | yes | no framing restrictions in headers | 390×7088 “Soil - Wikipedia” | 3831 ms |
| Instagram | social, login wall | 200 | **no** | X-Frame-Options DENY | 390×709 “Instagram” | 2326 ms |
| X / Twitter | social, JS app | 200 | **no** | CSP frame-ancestors 'self' https://x.com https://x.com:443 https://twitter.com https://twitter.com:443 (allows some origins; may still block ours) | 390×664 “X. It’s what’s happening / X” | 26169 ms |
| Reddit | social, JS app | 200 | **no** | X-Frame-Options SAMEORIGIN | 390×12000 “Gardening, Plants, and Agriculture.” | 8452 ms |
| YouTube | video, JS app | 200 | **no** | X-Frame-Options SAMEORIGIN | 390×664 “YouTube” | 2404 ms |
| GitHub | app | 200 | **no** | CSP frame-ancestors 'none' | 390×1317 “GitHub - samplereality/dirt: Bury the We” | 2784 ms |
| WSJ | paywall | 401 | yes | no framing restrictions in headers | 390×664 “wsj.com” | 3400 ms |
| New Yorker | paywall, long-form | 200 | **no** | CSP frame-ancestors 'self' https://copilot-app.condenast.io https://stg-copilot-app.condenast.io (allows some origins; may still block ours) | 390×12000 “The New Yorker” | 32935 ms |
| Medium | metered paywall | 200 | **no** | CSP frame-ancestors 'self' https://medium.com (allows some origins; may still block ours) | 390×664 “Medium: Read and write stories.” | 2751 ms |
| Substack | newsletter | 200 | yes | CSP frame-ancestors 'self' https://*.substack.com https://substack.com (allows some origins; may still block ours) | 390×12000 “Substack” | 9407 ms |
| Amazon | commerce, heavy | 200 | yes | no framing restrictions in headers | 390×4242 “Amazon.com. Spend less. Smile more.” | 29036 ms |
| Apple | marketing, animations | 200 | **no** | X-Frame-Options SAMEORIGIN | 390×12000 “Apple” | 7382 ms |
| Google Maps | JS-heavy app, WebGL | 200 | **no** | X-Frame-Options SAMEORIGIN | 390×664 “Google Maps” | 2888 ms |
| Craigslist | plain HTML | 200 | yes | CSP frame-ancestors https://*.craigslist.org (allows some origins; may still block ours) | 390×664 “craigslist: charlotte jobs, apartments, ” | 2923 ms |
| Internet Archive | archive | 200 | yes | no framing restrictions in headers | 390×7757 “Internet Archive: Digital Library of Fre” | 6217 ms |
| Davidson College | institutional | 200 | **no** | X-Frame-Options SAMEORIGIN | 390×6970 “Davidson College | Davidson” | 5961 ms |
| samplereality.com | personal site | 200 | **no** | X-Frame-Options SAMEORIGIN | 390×10922 “@samplereality – Digital Skulduggery & m” | 7801 ms |
| MDN | documentation | 200 | **no** | X-Frame-Options DENY | 390×12000 “<iframe> HTML inline frame element - HTM” | 5628 ms |

Frameable: 6 / 22. Clean screenshots: 22 / 22.
