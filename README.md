# TwitterPersonalityScraper

Scrapes a Twitter/X account's **tweets + replies** (the `/with_replies` timeline) by
driving a real Chromium session authenticated with your own cookies — no GraphQL
reverse-engineering, no third-party API. Built as a feasibility test.

## How it works

1. Loads your cookie jar (`auth/cookies.json`) into a Playwright Chromium context.
2. Verifies the session is logged in.
3. Opens `https://x.com/<handle>/with_replies`.
4. Scrolls incrementally, extracting tweets from the DOM each step and deduping by id
   (the timeline is virtualized — off-screen tweets are removed from the DOM, so we
   must read-as-we-scroll).
5. Writes normalized JSON to `output/<handle>.json`, incrementally.

## Setup

```bash
pnpm install
pnpm exec playwright install chromium
```

Copy the cookie template and fill in your own values (from your browser's
DevTools → Application → Cookies on x.com):

```bash
cp auth/cookies.example.json auth/cookies.json
```

You need at least `auth_token` and `ct0`. **`auth/cookies.json` is gitignored** —
`auth_token` grants full access to your account, treat it like a password.

## Usage

```bash
# scrape an account's tweets + replies (full timeline)
pnpm scrape <handle>

# accepts a bare handle, @handle, or a full URL; cap with --max
pnpm scrape @nasa --max 200
pnpm scrape https://x.com/nasa/with_replies --max 500

# watch the browser (needs a display / xvfb on a server)
pnpm scrape <handle> --headful
```

Output rows: `id, url, text, createdAt, author{handle,name}, isReply, isRepost,
replyingTo[], replies, reposts, likes, views, scrapedAt`.

The `/with_replies` timeline also surfaces the *parent* tweets of conversations, so
output can include tweets by other authors — filter by `author.handle` to keep only
the target's own posts and replies.
