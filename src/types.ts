export interface TweetAuthor {
  handle: string | null;
  name: string | null;
}

/** The embedded tweet inside a quote tweet (QRT). */
export interface QuotedTweet {
  handle: string | null;
  name: string | null;
  text: string;
}

export interface Tweet {
  /** Numeric status id (string to avoid precision loss). */
  id: string;
  url: string;
  text: string;
  /** ISO timestamp from the tweet's <time datetime>. */
  createdAt: string | null;
  author: TweetAuthor;
  /** True if this tweet is a reply (has a "Replying to …" block). */
  isReply: boolean;
  /** True if shown as a repost/retweet in the timeline. */
  isRepost: boolean;
  /** True if this tweet quotes another tweet (QRT). */
  isQuote: boolean;
  /** The embedded quoted tweet, when present. */
  quoted: QuotedTweet | null;
  /** @handles this tweet was replying to, when detectable. */
  replyingTo: string[];
  replies: number;
  reposts: number;
  likes: number;
  /** View count, when Twitter exposes it. */
  views: number | null;
  /** When we captured this row. */
  scrapedAt: string;
}

/** Shape returned from the in-page extractor (before we stamp scrapedAt). */
export type RawTweet = Omit<Tweet, "scrapedAt">;
