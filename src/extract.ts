import type { RawTweet } from "./types.js";

/**
 * Runs INSIDE the browser via page.evaluate(). It must be fully self-contained:
 * no references to module-scope variables or imports (types are erased at runtime).
 *
 * Reads every currently-rendered tweet <article> and normalizes it. Because the
 * timeline is virtualized, the caller must call this repeatedly while scrolling
 * and dedupe by id — each call only sees what's currently in the DOM.
 *
 * Counts come from aria-labels, which carry the EXACT integer regardless of the
 * abbreviated display ("61") or the UI language ("61 Me gusta" / "61 Likes"). We
 * therefore parse the leading integer and never apply K/M/B scaling (that scaling
 * previously misread Spanish "Me gusta"/"mil" as mega/kilo).
 */
export function extractVisibleTweets(): RawTweet[] {
  // Reply-context prefixes across the locales we expect to encounter.
  const REPLY_PREFIXES = ["replying to", "en respuesta a", "respondiendo a"];

  /** First integer in a string, stripping any thousands separators. */
  function leadingInt(text: string | null | undefined): number {
    if (!text) return 0;
    const m = text.match(/\d[\d.,\s]*/);
    if (!m) return 0;
    const digits = m[0].replace(/[.,\s]/g, "");
    const n = parseInt(digits, 10);
    return Number.isFinite(n) ? n : 0;
  }

  function buttonCount(article: Element, testid: string): number {
    const el = article.querySelector('[data-testid="' + testid + '"]');
    if (!el) return 0;
    return leadingInt(el.getAttribute("aria-label"));
  }

  const out: RawTweet[] = [];
  const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));

  for (const article of articles) {
    // Canonical permalink — the anchor wrapping the <time> element.
    const links = Array.from(article.querySelectorAll('a[href*="/status/"]'));
    let permalink: Element | undefined;
    for (const a of links) {
      if (a.querySelector("time")) {
        permalink = a;
        break;
      }
    }
    if (!permalink) permalink = links[0];
    const href = permalink ? permalink.getAttribute("href") || "" : "";
    const match = href.match(/^\/([^/]+)\/status\/(\d+)/);
    if (!match) continue; // ads / non-tweet articles

    const handle = match[1];
    const id = match[2];

    const timeEl = article.querySelector("time");
    const createdAt = timeEl ? timeEl.getAttribute("datetime") : null;

    // A quote tweet (QRT) embeds another tweet as a div[role="link"] that contains
    // its own User-Name block. (Plain link-preview cards also use role="link" but
    // have no User-Name, so this distinguishes a QRT from a URL card.)
    let quoteCard: Element | null = null;
    for (const card of Array.from(article.querySelectorAll('div[role="link"]'))) {
      if (card.querySelector('[data-testid="User-Name"]')) {
        quoteCard = card;
        break;
      }
    }

    // Main text = the first tweetText NOT inside the quoted card. (A QRT with no
    // commentary has only the quoted tweet's text, which must not be mistaken for
    // this tweet's own text.)
    let text = "";
    for (const tt of Array.from(article.querySelectorAll('[data-testid="tweetText"]'))) {
      if (!quoteCard || !quoteCard.contains(tt)) {
        text = (tt as HTMLElement).innerText;
        break;
      }
    }

    // Display name from the User-Name block.
    let name: string | null = null;
    const nameEl = article.querySelector('[data-testid="User-Name"]');
    if (nameEl) {
      const firstLink = nameEl.querySelector("a");
      const source = firstLink ? (firstLink as HTMLElement) : (nameEl as HTMLElement);
      name = source.innerText.split("\n")[0] || null;
    }

    // Social context (repost / pinned). Matches en + es ("reposteó", "fijado").
    const social = article.querySelector('[data-testid="socialContext"]');
    const socialText = social ? (social as HTMLElement).innerText : "";
    const isRepost = /repost|retweet|reposte/i.test(socialText);

    // "En respuesta a @x" / "Replying to @x" block.
    let isReply = false;
    const replyingTo: string[] = [];
    for (const d of Array.from(article.querySelectorAll("div"))) {
      if (quoteCard && quoteCard.contains(d)) continue; // ignore the quoted tweet's own reply context
      const dt = ((d as HTMLElement).innerText || "").trim();
      if (dt.length === 0 || dt.length > 120) continue;
      const low = dt.toLowerCase();
      if (REPLY_PREFIXES.some((p) => low.startsWith(p)) && d.querySelector("a")) {
        isReply = true;
        for (const a of Array.from(d.querySelectorAll("a"))) {
          const h = (a as HTMLElement).innerText.trim();
          if (h.startsWith("@") && !replyingTo.includes(h)) replyingTo.push(h);
        }
        break;
      }
    }

    // Views: the engagement group's aria-label lists metrics in a fixed order
    // (replies, reposts, likes, bookmarks, views), zeros omitted — views is last.
    let views: number | null = null;
    const group = article.querySelector('[role="group"]');
    if (group) {
      const label = group.getAttribute("aria-label") || "";
      const nums = label.match(/\d[\d.,]*/g);
      if (nums && nums.length > 0) {
        views = leadingInt(nums[nums.length - 1]);
      }
    }

    // Embedded quoted tweet content, when this is a QRT.
    let quoted: { handle: string | null; name: string | null; text: string } | null = null;
    if (quoteCard) {
      const qNameEl = quoteCard.querySelector('[data-testid="User-Name"]');
      let qHandle: string | null = null;
      let qName: string | null = null;
      if (qNameEl) {
        const rawName = (qNameEl as HTMLElement).innerText;
        qName = rawName.split("\n")[0] || null;
        const hm = rawName.match(/@(\w+)/);
        qHandle = hm ? "@" + hm[1] : null;
      }
      const qTextEl = quoteCard.querySelector('[data-testid="tweetText"]');
      quoted = {
        handle: qHandle,
        name: qName,
        text: qTextEl ? (qTextEl as HTMLElement).innerText : "",
      };
    }

    out.push({
      id,
      url: "https://x.com/" + handle + "/status/" + id,
      text,
      createdAt,
      author: { handle, name },
      isReply,
      isRepost,
      isQuote: Boolean(quoteCard),
      quoted,
      replyingTo,
      replies: buttonCount(article, "reply"),
      reposts: buttonCount(article, "retweet"),
      likes: buttonCount(article, "like"),
      views,
    });
  }

  return out;
}
