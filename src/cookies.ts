import { readFile } from "node:fs/promises";

/** Human-friendly cookie shape stored in auth/cookies.json. */
interface RawCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  /** ISO date string; omitted => session cookie. */
  expires?: string;
}

/** Cookie shape Playwright's context.addCookies() expects. */
export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

/**
 * Load the cookie jar and convert it to Playwright's addCookies() format,
 * translating ISO expiry strings to unix seconds (-1 == session cookie).
 */
export async function loadCookies(path: string): Promise<PlaywrightCookie[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `Cookie jar not found at ${path}. Copy auth/cookies.example.json to auth/cookies.json and fill in your auth_token + ct0.`,
    );
  }

  const raw = JSON.parse(text) as RawCookie[];
  return raw.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path ?? "/",
    secure: c.secure ?? true,
    httpOnly: c.httpOnly ?? false,
    sameSite: c.sameSite ?? "Lax",
    expires: c.expires ? Math.floor(new Date(c.expires).getTime() / 1000) : -1,
  }));
}
