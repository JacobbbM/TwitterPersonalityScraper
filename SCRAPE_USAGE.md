---
name: scrape-x-account
description: Use when a Claude session needs to scrape a Twitter/X account's tweets + replies (the /with_replies timeline) into normalized JSON, using the operator's own authenticated session cookies. Covers cookie handling, pagination behavior, the ~3,200 timeline cap, and locked-down-sandbox troubleshooting.
---

# SCRAPE_USAGE — scraping an X account's tweets + replies

You are a Claude session about to scrape a public X/Twitter account. This repo drives a
**real Chromium session authenticated with the operator's cookies** and reads tweets out
of the rendered DOM — no GraphQL reverse-engineering, no third-party API. Read this whole
file before running anything.

> **Companion:** once you have `output/<handle>.json`, see **`ANALYSIS_USAGE.md`** to turn it
> into a dossier.

---

## 0. The 30-second happy path

```bash
pnpm install
pnpm exec playwright install --with-deps chromium   # see §6 if you lack sudo
cp auth/cookies.example.json auth/cookies.json       # then paste in real cookies (§2)
pnpm scrape <handle> --max 3000                       # bare handle, @handle, or full URL
# -> output/<handle>.json   (gitignored)
```

If that all works, skip to §5 (what you get) and §4 (limits you must understand). If it
doesn't, §6 is the troubleshooting catalogue — most failures are cookies or missing libs.

---

## 1. What it actually does

1. Loads `auth/cookies.json` into a Playwright Chromium context (`context.addCookies`).
2. Verifies the session is logged in (fails loudly on a login wall — see §6).
3. Opens `https://x.com/<handle>/with_replies`.
4. **Scrolls incrementally**, extracting every rendered `<article data-testid="tweet">`
   on each step and **deduping by tweet id**. The timeline is *virtualized* — off-screen
   tweets are removed from the DOM — so the only way to capture them is to read-as-you-scroll.
5. Writes normalized JSON to `output/<handle>.json` **incrementally** (so a crash mid-run
   still leaves you with everything captured so far).
6. Stops when it hits `--max`, or when it idles (8 consecutive scrolls with 0 new tweets =
   the end of the reachable timeline).

`src/index.ts` (CLI) → `src/scraper.ts` (browser + scroll loop) → `src/extract.ts`
(in-page DOM extraction) → `src/cookies.ts` (cookie loading). `src/types.ts` is the row shape.

---

## 2. Cookies — the security-critical part

**The cookie jar grants full access to the operator's X account. Treat it like a password.**

- It lives at **`auth/cookies.json`**, which is **gitignored** (`/auth/cookies.json`). Keep it that way.
- **NEVER** commit it, paste its contents into a commit/PR/issue, `echo`/`cat` it into logs,
  or include any token value (especially `auth_token`) in output you show the user.
- If you ever print cookie debug info, redact `auth_token`, `ct0`, `kdt`, `twid`.

**Minimum cookies needed:** `auth_token` and `ct0`. Strongly recommended to also include
`__cf_bm` (Cloudflare) — it reduces transient interstitials. `guest_id`, `personalization_id`,
`kdt`, `twid`, `lang` help the session look normal.

**How the operator obtains them:** browser DevTools → Application → Cookies → `https://x.com`.

**Format** (`auth/cookies.example.json` is the committed template):

```json
[
  { "name": "auth_token", "value": "<redacted>", "domain": ".x.com", "path": "/",
    "secure": true, "httpOnly": true, "sameSite": "None", "expires": "2027-01-01T00:00:00Z" }
]
```

`src/cookies.ts` converts the ISO `expires` string to unix seconds (and uses `-1` for
session cookies). If `auth/cookies.json` is missing it throws a clear setup error.

---

## 3. Running it

```bash
pnpm scrape <handle|url> [--max N] [--headful]
```

| Arg | Meaning |
|---|---|
| `<handle\|url>` | Target account. Accepts `nasa`, `@nasa`, or `https://x.com/nasa/with_replies`. Normalized internally. |
| `--max N` | Stop after N tweets. Default **3000**. (Raising it does **not** beat the timeline cap — see §4.) |
| `--headful` | Show the browser. Needs a display / `xvfb` on a server. Default is headless. |

Progress prints per scroll round (`round N: +K new (total T, idle i/8)`). Let it run to
the idle-out; that's the signal you've reached the wall, not a bug.

---

## 4. Limits you MUST understand before reporting results

These are not tool bugs — they are how X's timeline works. Tell the user about them up front.

- **The ~3,200 timeline cap.** `/profile` and `/with_replies` stop serving older tweets in
  the low thousands. **`--max 30000` will not get you 30,000 tweets** of an active account —
  it will idle out at the wall. Expect roughly **the account's most recent few months**, not
  full history. (In practice a `/with_replies` run lands around ~5k *rows* because of
  interleaved context — see next point — while the target's *own* tweets flatten near ~3,200.)
- **`/with_replies` interleaves other authors.** It surfaces the *parent* tweets of
  conversations, reposts, and quoted tweets — so `output/<handle>.json` contains rows whose
  `author.handle` is **not** the target. **Filter by `author.handle`** to get the target's own
  posts + replies. (The CLI summary already splits this out for you.)
- **Date window = recent-N, not lifetime.** If the user wants the full back-catalogue of a
  prolific account, the timeline view physically cannot provide it. The only workaround is §7.
- **Counts are exact, locale-independent.** Engagement comes from `aria-label` integers, not
  the abbreviated display text — so don't "fix" them by scaling K/M/B (that *causes* the
  `61,000,000` bug; see §6).

---

## 5. What you get — the row schema

`output/<handle>.json` is an array of:

```ts
{
  id, url, text,
  createdAt,                       // ISO timestamp from <time datetime>
  author: { handle, name },
  isReply, isRepost, isQuote,      // type flags (can overlap: a reply may also quote)
  quoted: { handle, name, text } | null,   // embedded QRT content, when isQuote
  replyingTo: string[],            // @handles this reply targets
  replies, reposts, likes,         // exact integer counts
  views,                           // impressions, when X exposes them
  scrapedAt
}
```

Validate a run by spot-checking that `replies/reposts/likes/views` match the tweet's
`role="group"` aria-label on the live page.

---

## 6. Troubleshooting catalogue

**"Auth failed / landed on https://x.com/home" or a login wall.**
Usually the cookies are stale or incomplete. Re-grab fresh `auth_token` + `ct0` (+ `__cf_bm`).
Note: a transient bounce to `/home` can be a Cloudflare interstitial — the scraper retries
`openTimeline` up to 3×, so a single transient failure is not fatal. Only treat it as expired
cookies if it fails every retry.

**Chromium won't launch — missing `libatk-1.0.so.0` / `libnss3.so` / `libgbm.so.1` etc.,
and you have no `sudo` (locked-down sandbox).**
Fetch the libs into userland and point the loader at them:

```bash
mkdir -p "$HOME/cdeps/debs" "$HOME/cdeps/root"
cd "$HOME/cdeps/debs"
apt-get download \
  libatk1.0-0 libatk-bridge2.0-0 libcups2 libnss3 libnspr4 libxkbcommon0 \
  libgbm1 libgtk-3-0 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libdrm2 libxshmfence1
for d in *.deb; do dpkg -x "$d" "$HOME/cdeps/root"; done
export LD_LIBRARY_PATH="$HOME/cdeps/root/usr/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH"
# now run `pnpm scrape ...` in the SAME shell (env must be exported for the run)
```

Adjust the package list to whatever the launch error names. This is environment-specific —
do **not** bake it into committed code.

**`__name is not defined` inside `page.evaluate`.**
`tsx`/esbuild injects a `__name` keepNames helper that doesn't exist in the page. The scraper
already shims it via `addInitScript` (a no-op `globalThis.__name`). Don't remove that shim.

**Engagement numbers look absurd (e.g. likes = 61000000).**
A number regex matched localized text like "61 Me gusta" / "23 mil" and scaled it. Fixed by
parsing the **leading exact integer** from the aria-label with no K/M/B scaling. Keep it that way.

**`isReply` always false on a non-English account.**
Reply context is language-dependent ("Replying to" vs "En respuesta a"). `src/extract.ts`
carries a `REPLY_PREFIXES` multi-locale list — add the target's locale phrase if needed.

**Foreground `sleep` kills the process in some sandboxes.** Don't wrap the run in `sleep`;
let the scraper's own jittered waits pace it. Use background execution to run long scrapes.

---

## 7. Going past the cap (full history) — not yet built

To exceed ~3,200 you must switch from the timeline to **search windowing**: walk
`https://x.com/search?q=from:<handle> since:YYYY-MM-DD until:YYYY-MM-DD&f=live` in date
chunks (e.g. weekly), scraping each window with the same DOM extractor and deduping by id
across windows. This reaches years of history but is slower and rate-limit sensitive. It is a
**future enhancement** — `src/scraper.ts` currently only does the timeline. If the user needs
it, propose adding a `--mode search --since <date>` path before promising full history.

---

## 8. Checklist

- [ ] `pnpm install` + Chromium installed (or userland libs wired up, §6)
- [ ] `auth/cookies.json` present, valid, and **still gitignored**
- [ ] Ran `pnpm scrape <handle> --max <N>`; watched it idle-out or hit max
- [ ] Confirmed `output/<handle>.json` exists and spot-checked a few rows vs the live page
- [ ] Reported the real limits to the user (cap, recent-N window, interleaved authors)
- [ ] Did **not** commit cookies, output, or anything naming the target
