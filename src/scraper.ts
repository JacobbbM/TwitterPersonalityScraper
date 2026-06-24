import { chromium, type Browser, type Page } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { loadCookies } from "./cookies.js";
import { extractVisibleTweets } from "./extract.js";
import type { RawTweet, Tweet } from "./types.js";

export interface ScrapeOptions {
  handle: string;
  max: number;
  cookiesPath: string;
  outPath: string;
  headless: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const jitter = (base: number, spread: number): number => base + Math.floor(Math.random() * spread);

/** Number of consecutive scrolls with zero new tweets before we declare "end of timeline". */
const MAX_IDLE = 8;

export async function scrape(opts: ScrapeOptions): Promise<Tweet[]> {
  const cookies = await loadCookies(opts.cookiesPath);

  const browser: Browser = await chromium.launch({
    headless: opts.headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 1600 },
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });
  // tsx/esbuild injects a `__name` helper into transpiled functions to preserve
  // their .name. When we hand a function to page.evaluate(), its serialized source
  // references `__name`, which doesn't exist in the page world. Define a no-op shim
  // in every document so evaluated functions resolve it. (Passed as a string so it
  // isn't itself transpiled.)
  await context.addInitScript({
    content: "globalThis.__name = globalThis.__name || ((target) => target);",
  });
  await context.addCookies(cookies);
  const page = await context.newPage();

  try {
    const url = `https://x.com/${opts.handle}/with_replies`;
    console.log(`→ Opening ${url}`);
    await openTimeline(page, url);

    const seen = new Map<string, Tweet>();
    let idle = 0;
    let round = 0;

    while (seen.size < opts.max && idle < MAX_IDLE) {
      round++;
      const batch = (await page.evaluate(extractVisibleTweets)) as RawTweet[];
      const stamp = new Date().toISOString();

      let added = 0;
      for (const t of batch) {
        if (!seen.has(t.id)) {
          seen.set(t.id, { ...t, scrapedAt: stamp });
          added++;
          if (seen.size >= opts.max) break;
        }
      }

      if (added === 0) {
        idle++;
      } else {
        idle = 0;
        await writeOut(opts.outPath, [...seen.values()]);
      }
      console.log(
        `  round ${round}: +${added} new (total ${seen.size}, idle ${idle}/${MAX_IDLE})`,
      );

      // Recover from the occasional "Something went wrong" rail.
      const errRail = await page.$("text=/something went wrong/i");
      if (errRail) {
        await page.evaluate(() => window.scrollBy(0, -300));
        await sleep(2000);
      }

      await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.85)));
      await sleep(jitter(900, 800));
    }

    const tweets = [...seen.values()];
    await writeOut(opts.outPath, tweets);
    return tweets;
  } finally {
    await browser.close();
  }
}

/**
 * Navigate to the timeline and confirm we're authenticated. Resolves once tweets
 * render; throws on a real login wall. Retries through transient Cloudflare
 * "just a moment" interstitials and slow loads instead of failing on first miss.
 */
async function openTimeline(page: Page, url: string): Promise<void> {
  const READY =
    'article[data-testid="tweet"], [data-testid="loginButton"], [data-testid="LoginForm_Login_Button"], input[name="text"]';

  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(READY, { timeout: 30_000 }).catch(() => null);

    const state = await page.evaluate(() => {
      if (document.querySelector('article[data-testid="tweet"]')) return "ok";
      if (
        document.querySelector('[data-testid="loginButton"]') ||
        document.querySelector('[data-testid="LoginForm_Login_Button"]') ||
        document.querySelector('input[name="text"]') ||
        /\/login|i\/flow\/login/.test(location.pathname)
      ) {
        return "login";
      }
      return "pending";
    });

    if (state === "ok") {
      console.log("✅ Authenticated — timeline loaded.");
      return;
    }
    if (state === "login") {
      throw new Error(
        "Auth failed — a login wall was shown, so the cookies aren't a valid logged-in session. " +
          "Refresh auth_token + ct0 (and __cf_bm) from a live browser session.",
      );
    }
    console.log(`  timeline not ready yet (attempt ${attempt}/3) — waiting…`);
    await sleep(4000);
  }
  throw new Error(
    "Timeline failed to load after 3 attempts — likely a Cloudflare challenge or rate limit. Try again shortly.",
  );
}

async function writeOut(outPath: string, tweets: Tweet[]): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(tweets, null, 2), "utf8");
}
