# TwitterPersonalityScraper

A toolkit to scrape an X/Twitter account's tweets + replies and analyze them into a dossier.

## Routing — read the right guide, then follow it

- When the user asks you to **scrape** a user's tweets → read **`SCRAPE_USAGE.md`** and follow it.
- When the user asks you to **analyze** the scraped tweets of a user → read **`ANALYSIS_USAGE.md`** and follow it.

## Always

- `auth/cookies.json` grants full access to the operator's account — **never commit, print, or log it** (it's gitignored).
- **Never commit anything under `output/` or `analysis/`** — raw scrapes and personal analysis (both gitignored).
- Keep the scraped account's identity out of any committed code or docs.
