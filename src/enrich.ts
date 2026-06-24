import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Tweet } from "./types.js";

/**
 * Turns a raw scrape (output/<handle>.json) into analysis-ready artifacts:
 *   analysis/<handle>/enriched.json   every authored row + derived fields
 *   analysis/<handle>/corpus_*.txt    behavior-sliced text corpora for an LLM
 *   analysis/<handle>/stats.md        quantified fingerprint (graph, topics, tiers)
 *
 * All the cheap structural work — thread-stitching self-QRTs, mention extraction,
 * engagement tiering by like-RATE (not raw reach) — happens here in plain code so
 * the LLM pass only does what an LLM is uniquely good at: judgment.
 */

interface Enriched extends Tweet {
  /** @handles mentioned in the body (excluding self). */
  mentionedUsers: string[];
  /** True when this QRT quotes the author themselves (a self-thread step). */
  isSelfThread: boolean;
  /** Quoted train-of-thought reconstructed: parent text -> his comment. */
  threadText: string;
  /** likes per 1,000 impressions — reach-normalized resonance. */
  likeRate: number;
  /** Engagement bucket for authored, broadcast (non-reply) text posts. */
  tier: "resonated" | "ignored" | "reach" | "mid" | "n/a";
  /** Heuristic: does the post push a product / link / revenue claim? */
  hasPlug: boolean;
}

const STOP = new Set(
  ("a an the and or but if then so as at by for in of on to up with from into out " +
    "is are was were be been being am do does did doing have has had having i you he she " +
    "it we they me him her us them my your his its our their this that these those there here " +
    "not no yes can will just dont cant im ive id youre thats whats how what when where why who " +
    "which whom get got go going get like really very much more most some any all just now new " +
    "one two also even still about over after before than them too s t re ve ll m d u r " +
    "http https www com co t co amp rt via &amp")
    .split(/\s+/),
);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z'$]+/g) || []).filter(
    (w) => w.length > 2 && !STOP.has(w),
  );
}

function topN<T>(counts: Map<T, number>, n: number): Array<[T, number]> {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function bump<T>(m: Map<T, number>, k: T, by = 1): void {
  m.set(k, (m.get(k) || 0) + by);
}

/** Best-effort de-mangle of Twitter's display URLs (newlines + trailing ellipsis). */
function domainsIn(text: string): string[] {
  const joined = text.replace(/\s+/g, "");
  const out: string[] = [];
  const re = /(?:https?:\/\/)?([a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(joined))) {
    const d = m[1].toLowerCase();
    if (!d.endsWith(".com") && !d.includes(".")) continue;
    if (["x.com", "twitter.com", "t.co"].includes(d)) continue;
    out.push(d);
  }
  return out;
}

function pct(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function main(): void {
  const handle = (process.argv[2] || "").replace(/^@/, "");
  if (!handle) {
    console.error("Usage: pnpm enrich <handle>");
    process.exit(1);
  }
  const inPath = resolve(`output/${handle}.json`);
  const outDir = resolve(`analysis/${handle}`);
  mkdirSync(outDir, { recursive: true });

  const rows: Tweet[] = JSON.parse(readFileSync(inPath, "utf8"));
  const self = handle.toLowerCase();
  const mine = rows.filter((r) => (r.author.handle || "").toLowerCase() === self);

  // --- enrich each authored row ---
  const enriched: Enriched[] = mine.map((r) => {
    const text = r.text || "";
    const mentionedUsers = [
      ...new Set((text.match(/@(\w{1,15})/g) || []).map((m) => m.toLowerCase())),
    ].filter((m) => m !== "@" + self);
    const isSelfThread =
      r.isQuote && (r.quoted?.handle || "").toLowerCase() === "@" + self;
    const threadText =
      r.isQuote && r.quoted
        ? `${r.quoted.name || r.quoted.handle || "?"}: ${r.quoted.text}\n   ↪ ${text}`
        : text;
    const likeRate = r.views && r.views > 0 ? (r.likes / r.views) * 1000 : 0;
    const hasPlug =
      /https?:|\.com|\bMRR\b|\$\d|\bAI\b.*\bapp\b|\blifetime\b|\bcharge\b/i.test(text);
    return {
      ...r,
      mentionedUsers,
      isSelfThread,
      threadText,
      likeRate: Number(likeRate.toFixed(2)),
      tier: "n/a",
      hasPlug,
    };
  });

  // --- engagement tiers: only broadcast (non-reply) text posts with real reach ---
  const REACH = 1000;
  const broadcast = enriched.filter(
    (e) => !e.isReply && (e.text || "").trim().length > 0,
  );
  const reached = broadcast.filter((e) => (e.views || 0) >= REACH);
  const rateHi = pct(reached.map((e) => e.likeRate), 90);
  const rateLo = pct(reached.map((e) => e.likeRate), 25);
  const viewHi = pct(broadcast.map((e) => e.views || 0), 90);
  for (const e of broadcast) {
    if ((e.views || 0) >= REACH && e.likeRate >= rateHi) e.tier = "resonated";
    else if ((e.views || 0) >= REACH && e.likeRate <= rateLo) e.tier = "ignored";
    else if ((e.views || 0) >= viewHi) e.tier = "reach";
    else e.tier = "mid";
  }

  // --- aggregate graphs & topics ---
  const repliesTo = new Map<string, number>();
  const quotes = new Map<string, number>();
  const mentions = new Map<string, number>();
  const unigrams = new Map<string, number>();
  const domains = new Map<string, number>();
  for (const e of enriched) {
    for (const h of e.replyingTo) bump(repliesTo, h.toLowerCase());
    if (e.isQuote && e.quoted?.handle) bump(quotes, e.quoted.handle.toLowerCase());
    for (const h of e.mentionedUsers) bump(mentions, h);
    for (const w of tokenize(e.text || "")) bump(unigrams, w);
    for (const d of domainsIn(e.text || "")) bump(domains, d);
  }

  // --- write corpora (the slices the LLM will actually read) ---
  const fmt = (e: Enriched) =>
    `[${e.likes}♥ ${e.reposts}⇄ ${e.views ?? "?"}v rate=${e.likeRate}/1k${
      e.hasPlug ? " PLUG" : ""
    }] ${e.createdAt?.slice(0, 10)}\n${e.text}\n`;

  const byRate = (a: Enriched, b: Enriched) => b.likeRate - a.likeRate;
  const resonated = broadcast.filter((e) => e.tier === "resonated").sort(byRate);
  const ignored = broadcast
    .filter((e) => e.tier === "ignored")
    .sort((a, b) => (b.views || 0) - (a.views || 0));
  const replies = enriched.filter((e) => e.isReply);
  const qrts = enriched
    .filter((e) => e.isQuote && (e.text || "").trim())
    .sort((a, b) => (b.likes || 0) - (a.likes || 0));
  // deterministic voice sample across the mid tier (every Nth, to capture default register)
  const mid = broadcast.filter((e) => e.tier === "mid" || e.tier === "reach");
  const step = Math.max(1, Math.floor(mid.length / 120));
  const voice = mid.filter((_, i) => i % step === 0);

  const write = (name: string, header: string, items: Enriched[], body = fmt) =>
    writeFileSync(
      resolve(outDir, name),
      `# ${header}  (${items.length})\n\n${items.map(body).join("\n")}`,
    );

  write("corpus_resonated.txt", `RESONATED — top like-rate, >=${REACH} views`, resonated);
  write("corpus_ignored.txt", `IGNORED — high reach, near-zero likes`, ignored);
  write(
    "corpus_replies.txt",
    `REPLIES — interaction style`,
    replies,
    (e) => `-> ${e.replyingTo.join(" ") || "?"} [${e.likes}♥]\n${e.text}\n`,
  );
  write(
    "corpus_qrts.txt",
    `QUOTE TWEETS — what he amplifies (parent -> his take)`,
    qrts,
    (e) =>
      `[${e.likes}♥ ${e.isSelfThread ? "SELF-THREAD" : "ext"}] ${e.createdAt?.slice(0, 10)}\n${e.threadText}\n`,
  );
  write("corpus_voice.txt", `VOICE SAMPLE — default register (every ${step}th mid post)`, voice);

  writeFileSync(resolve(outDir, "enriched.json"), JSON.stringify(enriched, null, 2));

  // --- stats.md ---
  const tierCount = (t: string) => broadcast.filter((e) => e.tier === t).length;
  const months = new Map<string, number>();
  for (const e of enriched) if (e.createdAt) bump(months, e.createdAt.slice(0, 7));
  const plugShare = enriched.filter((e) => e.hasPlug).length;

  const list = (pairs: Array<[string, number]>) =>
    pairs.map(([k, v]) => `- ${k} — ${v}`).join("\n");

  const stats = `# @${handle} — quantified fingerprint

Authored rows: **${mine.length}**  ·  with text: ${enriched.filter((e) => (e.text || "").trim()).length}
Date range: ${enriched.map((e) => e.createdAt).filter(Boolean).sort()[0]?.slice(0, 10)} → ${enriched
    .map((e) => e.createdAt)
    .filter(Boolean)
    .sort()
    .slice(-1)[0]
    ?.slice(0, 10)}
Self-promo posts (hasPlug): **${plugShare}** (${((100 * plugShare) / mine.length).toFixed(0)}%)

## Engagement tiers (broadcast posts, ${broadcast.length})
- resonated (top-decile like-rate): ${tierCount("resonated")}
- ignored (high reach, bottom-quartile like-rate): ${tierCount("ignored")}
- reach (top-decile raw views): ${tierCount("reach")}
- mid: ${tierCount("mid")}
- like-rate cutoffs: hi(p90)=${rateHi.toFixed(2)}/1k  lo(p25)=${rateLo.toFixed(2)}/1k

## The orbit — who he replies TO (top 15)
${list(topN(repliesTo, 15))}

## The orbit — who he QUOTES (top 15)
${list(topN(quotes, 15))}

## Mentioned in body (top 15)
${list(topN(mentions, 15))}

## Domains he plugs (top 15)
${list(topN(domains, 15))}

## Topic fingerprint — top 40 content words
${list(topN(unigrams, 40))}

## Posting cadence (posts/month)
${list([...months.entries()].sort())}
`;
  writeFileSync(resolve(outDir, "stats.md"), stats);

  console.log(`Enriched ${mine.length} authored rows → ${outDir}`);
  console.log(
    `  tiers: resonated ${tierCount("resonated")} · ignored ${tierCount("ignored")} · reach ${tierCount("reach")} · mid ${tierCount("mid")}`,
  );
  console.log(
    `  corpora: resonated(${resonated.length}) ignored(${ignored.length}) replies(${replies.length}) qrts(${qrts.length}) voice(${voice.length})`,
  );
  console.log(`  self-threads: ${enriched.filter((e) => e.isSelfThread).length} · plugs: ${plugShare}`);
}

main();
