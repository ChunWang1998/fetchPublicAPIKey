/*
target URL:
https://github.com/search?q=%28path%3A*.xml+OR+path%3A*.json+OR+path%3A*.properties+OR+path%3A*.sql+OR+path%3A*.txt+OR+path%3A*.log+OR+path%3A*.tmp+OR+path%3A*.backup+OR+path%3A*.bak+OR+path%3A*.enc+OR+path%3A*.yml+OR+path%3A*.yaml+OR+path%3A*.toml+OR+path%3A*.ini+OR+path%3A*.config+OR+path%3A*.conf+OR+path%3A*.cfg+OR+path%3A*.env+OR+path%3A*.envrc+OR+path%3A*.prod+OR+path%3A*.secret+OR+path%3A*.private+OR+path%3A*.key%29+AND+%28access_key+OR+secret_key+OR+access_token+OR+api_key+OR+apikey+OR+api_secret+OR+apiSecret+OR+app_secret+OR+application_key+OR+app_key+OR+appkey+OR+auth_token+OR+authsecret%29+AND+%28%22sk-proj%22%29+NOT+%22sk-proj-xxx%22+NOT+%22sk-proj-...%22+NOT+%22sk-proj-***%22+NOT+%22sk-proj-+%22+NOT+%22sk-proj-password%22+NOT+%22sk-proj-YOURKEY%22+NOT+%22gsk-%22+NOT+%22sk-proj-123%22+NOT+%22sk-proj-abc%22+NOT+%22sk-proj-+%5Cn%22&type=code
*/

import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAX_PAGES = 3;
const RESULT_PATH = join(__dirname, "result.txt");

const SK_PROJ_REGEX = /sk-proj-[A-Za-z0-9_-]+/g;

const PLACEHOLDER_SUFFIXES = new Set([
  "...",
  "***",
  "password",
  "yourkey",
  "your",
  "openai",
  "key_here",
  "123",
  "abc",
]);

// Short tokens use exact suffix match only (substring would drop real keys).
const PLACEHOLDER_EXACT_ONLY = new Set(["123", "abc"]);

// GitHub REST /search/code uses legacy syntax (max 256 chars, max 5 AND/OR/NOT).
// prompt.txt targets github.com web UI; these simpler queries work with the API.
const SEARCH_QUERIES = [
  ...[
    "env",
    "json",
    "yaml",
    "yml",
    "xml",
    "properties",
    "sql",
    "txt",
    "log",
    "toml",
    "ini",
    "conf",
    "cfg",
    "config",
    "bak",
    "backup",
    "key",
    "secret",
    "private",
    "prod",
    "enc",
  ].map((ext) => `"sk-proj" extension:${ext}`),
  '"sk-proj" filename:.env',
  '"sk-proj" filename:.envrc',
  '"sk-proj"',
];

interface CodeSearchItem {
  path: string;
  sha: string;
  git_url: string;
  html_url: string;
  text_matches?: Array<{ fragment?: string }>;
  repository: { full_name: string };
}

interface CodeSearchResponse {
  total_count: number;
  items: CodeSearchItem[];
}

function loadEnv(): void {
  for (const envPath of [join(__dirname, ".env"), join(__dirname, "../.env")]) {
    try {
      const content = readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (!process.env[key]) process.env[key] = value;
      }
    } catch {
      // ignore missing env files
    }
  }
}

function isPlaceholder(key: string): boolean {
  if (!key.startsWith("sk-proj-")) return true;
  const suffix = key.slice("sk-proj-".length);
  if (!suffix) return true;
  if (suffix.length < 20) return true;

  const lower = suffix.toLowerCase();
  if (/^(.)\1+$/.test(suffix)) return true;
  if (/x{4,}/i.test(suffix)) return true;

  for (const token of PLACEHOLDER_SUFFIXES) {
    if (PLACEHOLDER_EXACT_ONLY.has(token)) {
      if (lower === token) return true;
    } else if (lower.includes(token)) {
      return true;
    }
  }
  return false;
}

function extractKeys(text: string): string[] {
  const matches = text.match(SK_PROJ_REGEX) ?? [];
  return matches.filter((key) => !isPlaceholder(key));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeResult(allKeys: Set<string>): void {
  const lines = [...allKeys].sort();
  writeFileSync(RESULT_PATH, lines.length ? `${lines.join("\n")}\n` : "", "utf-8");
  console.log(`  updated ${RESULT_PATH} (${lines.length} unique key(s))`);
}

async function searchGithubCode(
  token: string,
  query: string,
  page: number,
  retries = 3,
): Promise<CodeSearchResponse | null> {
  const url = new URL("https://api.github.com/search/code");
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", "100");
  url.searchParams.set("page", String(page));

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.text-match+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (res.status === 403) {
    const retryAfter = Number(res.headers.get("retry-after") ?? "60");
    console.log(`  rate limited, waiting ${retryAfter}s...`);
    await sleep(retryAfter * 1000);
    return searchGithubCode(token, query, page, retries);
  }

  if ((res.status === 503 || res.status === 502) && retries > 0) {
    console.log(`  transient error ${res.status}, retrying (${retries} left)...`);
    await sleep(5000);
    return searchGithubCode(token, query, page, retries - 1);
  }

  if (!res.ok) {
    console.warn(`  search failed (${res.status}): ${await res.text()}`);
    return null;
  }

  return res.json() as Promise<CodeSearchResponse>;
}

async function fetchBlobContent(
  gitUrl: string,
  token: string,
): Promise<string | null> {
  try {
    const res = await fetch(gitUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return null;
    const blob = (await res.json()) as { content?: string; encoding?: string };
    if (!blob.content || blob.encoding !== "base64") return null;
    return Buffer.from(blob.content, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  loadEnv();

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("GITHUB_TOKEN is required (set in .env or environment)");
    process.exit(1);
  }

  const allKeys = new Set<string>();
  const seenFiles = new Set<string>();

  for (const query of SEARCH_QUERIES) {
    console.log(`Query: ${query}`);

    for (let page = 1; page <= MAX_PAGES; page++) {
      console.log(`  page ${page}...`);
      await sleep(2000);
      const data = await searchGithubCode(token, query, page);
      if (!data) break;

      if (page === 1) {
        console.log(`  total matches: ${data.total_count}`);
      }

      const items = data.items ?? [];
      if (items.length === 0) break;

      for (const item of items) {
        for (const match of item.text_matches ?? []) {
          for (const key of extractKeys(match.fragment ?? "")) {
            allKeys.add(key);
          }
        }

        const fileKey = `${item.repository.full_name}:${item.path}:${item.sha}`;
        if (seenFiles.has(fileKey)) continue;
        seenFiles.add(fileKey);

        const content = await fetchBlobContent(item.git_url, token);
        if (content) {
          for (const key of extractKeys(content)) {
            allKeys.add(key);
          }
        }

        await sleep(200);
      }

      writeResult(allKeys);

      if (items.length < 100) break;
      await sleep(6000);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
