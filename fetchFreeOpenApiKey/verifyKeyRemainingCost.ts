import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const VERIFIED_PATH = join(__dirname, "verifiedKey.txt");
const REMAINED_COST_PATH = join(__dirname, "keyRemainedCost.txt");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

// Probe models in preference order for maximum compatibility with old trial keys.
// Many leaked sk-proj keys from 2023-2024 only have gpt-3.5-turbo access.
const PROBE_MODELS = ["gpt-3.5-turbo", "gpt-4o-mini"] as const;

interface CliOptions {
  apiKey: string;
  filePath: string;
  showAll: boolean;
  verbose: boolean;
  numThreads: number;
}

interface CreditInfo {
  hasCredit: boolean;
  remaining?: number; // USD remaining from credit_grants
  source: "credit_grants" | "test_call" | "none";
  model?: string; // which model succeeded in the probe (for test_call)
  error?: string;
}

interface CreditGrantsResponse {
  total_available?: number;
  total_granted?: number;
  total_used?: number;
  object?: string;
}

interface OpenAIErrorResponse {
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  let apiKey = "";
  let filePath = "";
  let showAll = false;
  let verbose = false;
  let numThreads = 1;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "-k":
        apiKey = args[++i] ?? "";
        break;
      case "-f":
        filePath = args[++i] ?? "";
        break;
      case "-d":
        showAll = true;
        break;
      case "-v":
        verbose = true;
        break;
      case "-t":
        numThreads = Math.max(1, Number(args[++i]) || 1);
        break;
      default:
        break;
    }
  }

  if (!apiKey && !filePath) {
    filePath = VERIFIED_PATH;
  }

  return { apiKey, filePath, showAll, verbose, numThreads };
}

function readKeysFromFile(filePath: string): string[] {
  const content = readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function writeRemainedCostKeys(keys: string[]): void {
  const lines = [...new Set(keys)].sort();
  writeFileSync(REMAINED_COST_PATH, lines.length ? `${lines.join("\n")}\n` : "", "utf-8");
  console.log(`\nUpdated ${REMAINED_COST_PATH} (${lines.length} key(s) with remaining credit)`);
}

async function checkCreditGrants(apiKey: string): Promise<CreditInfo> {
  try {
    const res = await fetch("https://api.openai.com/v1/dashboard/billing/credit_grants", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const body = await res.text();
      // Many keys will get "session key required" or similar errors now
      return {
        hasCredit: false,
        source: "none",
        error: body || `HTTP ${res.status}`,
      };
    }

    const payload = (await res.json()) as CreditGrantsResponse;

    // total_available is the key field for remaining USD credits
    const remaining = typeof payload.total_available === "number" ? payload.total_available : undefined;

    if (remaining !== undefined && remaining > 0) {
      return {
        hasCredit: true,
        remaining,
        source: "credit_grants",
      };
    }

    // Credit grants endpoint worked but shows zero or no available field
    return {
      hasCredit: false,
      remaining: remaining ?? 0,
      source: "credit_grants",
      error: remaining === 0 ? "No credit remaining" : "No credit info available",
    };
  } catch (err) {
    return {
      hasCredit: false,
      source: "none",
      error: String(err),
    };
  }
}

async function testMinimalCompletion(
  apiKey: string,
  model: string,
): Promise<{ success: boolean; error?: string; isQuotaError: boolean; isModelUnavailable: boolean }> {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "." }],
        max_tokens: 1,
        temperature: 0,
      }),
    });

    if (!res.ok) {
      // Read body as text first (safe), then try to parse JSON for structured error
      const rawBody = await res.text();
      let message = rawBody;
      try {
        const parsed = JSON.parse(rawBody) as OpenAIErrorResponse;
        if (parsed.error?.message) message = parsed.error.message;
      } catch {
        // body was not JSON, use raw text
      }

      const isQuotaError =
        res.status === 429 ||
        /insufficient_quota|quota/i.test(message) ||
        /exceeded your current quota/i.test(message);

      const isModelUnavailable =
        /model_not_found|does not exist|permission denied|not have access|model.*unavailable/i.test(message);

      return {
        success: false,
        error: message || `HTTP ${res.status}`,
        isQuotaError,
        isModelUnavailable,
      };
    }

    return { success: true, isQuotaError: false, isModelUnavailable: false };
  } catch (err) {
    return {
      success: false,
      error: String(err),
      isQuotaError: false,
      isModelUnavailable: false,
    };
  }
}

async function probeForRemainingCredit(apiKey: string): Promise<CreditInfo> {
  const attempted: string[] = [];
  let lastNonQuotaError: string | undefined;

  for (const model of PROBE_MODELS) {
    attempted.push(model);
    const probe = await testMinimalCompletion(apiKey, model);

    if (probe.success) {
      return {
        hasCredit: true,
        source: "test_call",
        model,
      };
    }

    if (probe.isQuotaError) {
      // Definitive: this key has no spendable credit left
      return {
        hasCredit: false,
        source: "none",
        error: `Insufficient quota (probed with ${model})`,
      };
    }

    if (probe.isModelUnavailable) {
      // This specific model is not available to the key/project.
      // Try the next (older/cheaper) model in the list.
      lastNonQuotaError = probe.error;
      continue;
    }

    // Other error (invalid key, org rate limit, network, etc.)
    lastNonQuotaError = probe.error;
    // Continue to try other models — some orgs have per-model limits
  }

  // All probes exhausted without a clear quota error and without success.
  // Surface the most useful error we saw (often the real reason, e.g. bad key).
  const detail = lastNonQuotaError ? `: ${lastNonQuotaError}` : "";
  return {
    hasCredit: false,
    source: "none",
    error: `No working probe model among [${attempted.join(", ")}]${detail}`,
  };
}

async function checkKeyRemainingCost(apiKey: string): Promise<CreditInfo> {
  // Strategy 1: Try the credit_grants endpoint (works for some trial/free keys)
  const grantsResult = await checkCreditGrants(apiKey);

  if (grantsResult.hasCredit) {
    return grantsResult;
  }

  // If credit_grants gave us a definitive "no credit" with no other error,
  // we can still try the test call as a fallback (some keys may have credit
  // via subscription rather than prepaid grants)
  if (grantsResult.source === "credit_grants" && grantsResult.remaining === 0) {
    // Credit grants explicitly says zero — no need to waste a test call
    return grantsResult;
  }

  // Strategy 2: Multi-model probe call.
  // Tries gpt-3.5-turbo first (best compatibility with old leaked trial keys),
  // then gpt-4o-mini. Distinguishes true quota exhaustion from model access issues.
  const probeResult = await probeForRemainingCredit(apiKey);

  if (probeResult.hasCredit) {
    return probeResult;
  }

  // Combine error info if both strategies failed
  return {
    hasCredit: false,
    source: "none",
    error: probeResult.error || grantsResult.error || "Unable to determine credit status",
  };
}

function logKeyResult(
  key: string,
  result: CreditInfo,
  verbose: boolean,
  showAll: boolean,
): boolean {
  if (!result.hasCredit) {
    if (showAll) {
      console.log(`${RED}${key} has no remaining credit.${RESET}`);
      if (result.error) {
        console.log(`${RED}  ${result.error}${RESET}`);
      }
    }
    return false;
  }

  if (result.source === "credit_grants" && result.remaining !== undefined) {
    console.log(`${GREEN}${key} has credit: $${result.remaining.toFixed(4)} remaining${RESET}`);
  } else {
    const modelInfo = result.model ? ` via ${result.model}` : "";
    console.log(`${GREEN}${key} has remaining credit (verified via test call${modelInfo})${RESET}`);
  }

  if (verbose) {
    console.log(`${CYAN}  Source: ${result.source}${RESET}`);
    if (result.model) {
      console.log(`${CYAN}  Working model: ${result.model}${RESET}`);
    }
    if (result.remaining !== undefined) {
      console.log(`${CYAN}  Total available: $${result.remaining.toFixed(4)}${RESET}`);
    }
  }

  return true;
}

async function runPool(
  keys: string[],
  numThreads: number,
  showAll: boolean,
  verbose: boolean,
): Promise<{
  keysWithCredit: string[];
  withCreditCount: number;
  withoutCreditCount: number;
}> {
  const keysWithCredit: string[] = [];
  let withCreditCount = 0;
  let withoutCreditCount = 0;

  let index = 0;

  async function worker(): Promise<void> {
    while (true) {
      const current = index++;
      if (current >= keys.length) break;

      const key = keys[current]!;
      const result = await checkKeyRemainingCost(key);
      const hasCredit = logKeyResult(key, result, verbose, showAll);

      if (hasCredit) {
        keysWithCredit.push(key);
        withCreditCount++;
      } else {
        withoutCreditCount++;
      }
    }
  }

  const workers = Array.from({ length: Math.min(numThreads, keys.length) }, () => worker());
  await Promise.all(workers);

  return { keysWithCredit, withCreditCount, withoutCreditCount };
}

async function main(): Promise<void> {
  const { apiKey, filePath, showAll, verbose, numThreads } = parseArgs();

  if (!apiKey && !filePath) {
    console.log("Usage: -k <Single OpenAI API key> or -f <path to file containing API keys>");
    console.log("Options: -d (show keys without credit), -v (verbose), -t <threads> (default: 1)");
    return;
  }

  if (apiKey) {
    const result = await checkKeyRemainingCost(apiKey);
    const hasCredit = logKeyResult(apiKey, result, verbose, true);

    if (hasCredit) {
      writeRemainedCostKeys([apiKey]);
      console.log("Keys with remaining credit: 1");
    } else {
      writeRemainedCostKeys([]);
      console.log("Keys with remaining credit: 0");
    }

    if (!hasCredit) {
      console.log("Keys without credit: 1");
    }
    return;
  }

  // If using default path and it doesn't exist, show usage instead of raw error
  if (filePath === VERIFIED_PATH) {
    try {
      // Quick existence check
      readFileSync(VERIFIED_PATH, "utf-8");
    } catch {
      console.log("Usage: -k <Single OpenAI API key> or -f <path to file containing API keys>");
      console.log("Options: -d (show keys without credit), -v (verbose), -t <threads> (default: 1)");
      console.log(`\nDefault file ${VERIFIED_PATH} not found. Run verify first or provide -f.`);
      return;
    }
  }

  let keys: string[] = [];
  try {
    keys = readKeysFromFile(filePath);
  } catch (err) {
    console.error("Error opening file:", err);
    process.exit(1);
  }

  if (keys.length === 0) {
    console.log(`No keys found in ${filePath}`);
    writeRemainedCostKeys([]);
    return;
  }

  console.log(`Checking remaining credit for ${keys.length} key(s) from ${filePath} with ${numThreads} thread(s)...`);

  const { keysWithCredit, withCreditCount, withoutCreditCount } = await runPool(
    keys,
    numThreads,
    showAll,
    verbose,
  );

  writeRemainedCostKeys(keysWithCredit);

  console.log(`Keys with remaining credit: ${withCreditCount}`);
  if (showAll || withoutCreditCount > 0) {
    console.log(`Keys without credit: ${withoutCreditCount}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
