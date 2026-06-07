import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const RESULT_PATH = join(__dirname, "result.txt");
const VERIFIED_PATH = join(__dirname, "verifiedKey.txt");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

interface CliOptions {
  apiKey: string;
  filePath: string;
  showAll: boolean;
  verbose: boolean;
  numThreads: number;
}

interface ModelAccess {
  gpt4: string[];
  gpt35: string[];
  others: string[];
}

interface ValidationResult {
  valid: boolean;
  models: ModelAccess;
  error?: string;
}

interface OpenAIModel {
  id: string;
}

interface ModelsResponse {
  data?: OpenAIModel[];
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
    filePath = RESULT_PATH;
  }

  return { apiKey, filePath, showAll, verbose, numThreads };
}

function categorizeModels(modelIds: string[]): ModelAccess {
  const gpt4: string[] = [];
  const gpt35: string[] = [];
  const others: string[] = [];

  for (const id of modelIds) {
    if (id.startsWith("gpt-4") || id.startsWith("o1") || id.startsWith("o3")) {
      gpt4.push(id);
    } else if (id.startsWith("gpt-3.5-turbo")) {
      gpt35.push(id);
    } else {
      others.push(id);
    }
  }

  return {
    gpt4: gpt4.sort(),
    gpt35: gpt35.sort(),
    others: others.sort(),
  };
}

function hasChatModelAccess(models: ModelAccess): boolean {
  return models.gpt4.length > 0 || models.gpt35.length > 0;
}

function formatModelSummary(models: ModelAccess): string {
  const parts: string[] = [];
  if (models.gpt4.length > 0) parts.push("GPT-4");
  if (models.gpt35.length > 0) parts.push("GPT-3.5");
  if (parts.length === 0 && models.others.length > 0) parts.push("Others only");
  return parts.join(", ");
}

function formatVerboseModels(models: ModelAccess): string {
  const lines: string[] = [];

  if (models.gpt4.length > 0) {
    lines.push("GPT-4:");
    for (const id of models.gpt4) lines.push(`  ${id}`);
  }
  if (models.gpt35.length > 0) {
    lines.push("GPT-3.5-Turbo:");
    for (const id of models.gpt35) lines.push(`  ${id}`);
  }
  if (models.others.length > 0) {
    lines.push("Others:");
    for (const id of models.others) lines.push(`  ${id}`);
  }

  return lines.join("\n");
}

async function listOpenAIModels(apiKey: string): Promise<ValidationResult> {
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const body = await res.text();
      return {
        valid: false,
        models: { gpt4: [], gpt35: [], others: [] },
        error: body || `HTTP ${res.status}`,
      };
    }

    const payload = (await res.json()) as ModelsResponse;
    const modelIds = (payload.data ?? []).map((model) => model.id);
    const models = categorizeModels(modelIds);

    return { valid: true, models };
  } catch (err) {
    return {
      valid: false,
      models: { gpt4: [], gpt35: [], others: [] },
      error: String(err),
    };
  }
}

function readKeysFromFile(filePath: string): string[] {
  const content = readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function writeVerifiedKeys(keys: string[]): void {
  const lines = [...new Set(keys)].sort();
  writeFileSync(VERIFIED_PATH, lines.length ? `${lines.join("\n")}\n` : "", "utf-8");
  console.log(`\nUpdated ${VERIFIED_PATH} (${lines.length} key(s) with chat model access)`);
}

function logKeyResult(
  key: string,
  result: ValidationResult,
  verbose: boolean,
  showAll: boolean,
): "usable" | "validOnly" | "invalid" {
  if (!result.valid) {
    if (showAll) {
      console.log(`${RED}${key} is invalid.${RESET}`);
      if (result.error) {
        console.log(`${RED}  ${result.error}${RESET}`);
      }
    }
    return "invalid";
  }

  const summary = formatModelSummary(result.models);
  const chatAccess = hasChatModelAccess(result.models);

  if (chatAccess) {
    console.log(`${GREEN}${key} is valid. Models: ${summary}${RESET}`);
  } else {
    console.log(`${YELLOW}${key} is valid but has no GPT-4 / GPT-3.5 access.${RESET}`);
    if (result.models.others.length > 0) {
      console.log(`${YELLOW}  Available: ${result.models.others.length} other model(s)${RESET}`);
    }
  }

  if (verbose) {
    console.log(`${CYAN}${formatVerboseModels(result.models)}${RESET}`);
  }

  return chatAccess ? "usable" : "validOnly";
}

async function runPool(
  keys: string[],
  numThreads: number,
  showAll: boolean,
  verbose: boolean,
): Promise<{
  usableKeys: string[];
  usableCount: number;
  validOnlyCount: number;
  invalidCount: number;
}> {
  const usableKeys: string[] = [];
  let usableCount = 0;
  let validOnlyCount = 0;
  let invalidCount = 0;

  let index = 0;

  async function worker(): Promise<void> {
    while (true) {
      const current = index++;
      if (current >= keys.length) break;

      const key = keys[current]!;
      const result = await listOpenAIModels(key);
      const status = logKeyResult(key, result, verbose, showAll);

      if (status === "usable") {
        usableKeys.push(key);
        usableCount++;
      } else if (status === "validOnly") {
        validOnlyCount++;
      } else {
        invalidCount++;
      }
    }
  }

  const workers = Array.from({ length: Math.min(numThreads, keys.length) }, () => worker());
  await Promise.all(workers);

  return { usableKeys, usableCount, validOnlyCount, invalidCount };
}

async function main(): Promise<void> {
  const { apiKey, filePath, showAll, verbose, numThreads } = parseArgs();

  if (!apiKey && !filePath) {
    console.log("Usage: -k <Single OpenAI API key> or -f <path to file containing API keys>");
    console.log("Options: -d (show invalid keys), -v (list all models), -t <threads> (default: 1)");
    return;
  }

  if (apiKey) {
    const result = await listOpenAIModels(apiKey);
    const status = logKeyResult(apiKey, result, verbose, true);

    if (status === "usable") {
      writeVerifiedKeys([apiKey]);
      console.log("Keys with chat model access: 1");
    } else {
      writeVerifiedKeys([]);
      console.log("Keys with chat model access: 0");
    }

    if (status === "invalid") {
      console.log("Invalid keys: 1");
    } else if (status === "validOnly") {
      console.log("Valid but no GPT-4 / GPT-3.5 access: 1");
    }
    return;
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
    writeVerifiedKeys([]);
    return;
  }

  console.log(`Checking ${keys.length} key(s) from ${filePath} with ${numThreads} thread(s)...`);

  const { usableKeys, usableCount, validOnlyCount, invalidCount } = await runPool(
    keys,
    numThreads,
    showAll,
    verbose,
  );

  writeVerifiedKeys(usableKeys);

  console.log(`Keys with chat model access: ${usableCount}`);
  if (validOnlyCount > 0) {
    console.log(`Valid but no GPT-4 / GPT-3.5 access: ${validOnlyCount}`);
  }
  if (showAll) {
    console.log(`Invalid keys: ${invalidCount}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
