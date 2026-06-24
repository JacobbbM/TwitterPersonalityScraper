import { resolve } from "node:path";
import { scrape } from "./scraper.js";

interface CliArgs {
  handle: string;
  max: number;
  headless: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let handle = "";
  let max = 3000;
  let headless = true;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--max") max = parseInt(args[++i], 10);
    else if (a === "--headful" || a === "--no-headless") headless = false;
    else if (a === "--headless") headless = true;
    else if (!a.startsWith("-")) positional.push(a);
  }

  if (positional[0]) {
    handle = positional[0]
      .replace(/^@/, "")
      .replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "")
      .split(/[/?]/)[0];
  }
  if (process.env.HEADLESS === "false") headless = false;

  return { handle, max, headless };
}

const USAGE = `Usage: pnpm scrape <handle|url> [--max N] [--headful]
  <handle|url>   target account — a bare handle, @handle, or full x.com URL
  --max N        stop after N tweets (default 3000)
  --headful      show the browser instead of running headless`;

async function main(): Promise<void> {
  const { handle, max, headless } = parseArgs(process.argv);
  if (!handle) {
    console.error(USAGE);
    process.exit(1);
  }
  const cookiesPath = resolve("auth/cookies.json");
  const outPath = resolve(`output/${handle}.json`);

  console.log(`Twitter scrape: @${handle}  (max ${max}, headless ${headless})`);
  const tweets = await scrape({ handle, max, headless, cookiesPath, outPath });

  const byTarget = tweets.filter(
    (t) => (t.author.handle || "").toLowerCase() === handle.toLowerCase(),
  );
  const replies = byTarget.filter((t) => t.isReply).length;

  console.log("\n──── Done ────");
  console.log(`Total tweets captured: ${tweets.length}`);
  console.log(
    `  by @${handle}: ${byTarget.length}  (replies: ${replies}, posts: ${byTarget.length - replies})`,
  );
  console.log(`  other authors (conversation context): ${tweets.length - byTarget.length}`);
  console.log(`Saved → ${outPath}`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("\n❌ Scrape failed:", message);
  process.exitCode = 1;
});
