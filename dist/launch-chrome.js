#!/usr/bin/env node

// scripts/launch-chrome.ts
import process3 from "process";

// src/server/config.ts
import { existsSync, statSync } from "fs";
import path from "path";
import process2 from "process";
import { z } from "zod";
var DEFAULT_COMMAND_WHITELIST = [
  "npm run",
  "npm test",
  "npm ci",
  "npm ls",
  "pnpm run",
  "pnpm test",
  "yarn run",
  "yarn test",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git rev-parse",
  "git add",
  "git commit",
  "tsc",
  "vitest",
  "jest",
  "eslint",
  "prettier",
  "vite build",
  "tsx --version",
  "cargo build",
  "cargo check",
  "cargo test",
  "go build",
  "go vet",
  "go test",
  "dotnet build",
  "dotnet test",
  "mvn test",
  "gradle build",
  "dir",
  "ls",
  "pwd",
  "type",
  "cat",
  "echo",
  "where",
  "findstr",
  "rg"
];
var envSchema = z.object({
  DUB_CDP_HOST: z.string().trim().min(1).default("127.0.0.1"),
  DUB_CDP_PORT: z.coerce.number().int().min(1).max(65535).default(9222),
  DUB_TARGET_URL_PREFIX: z.string().trim().min(1).default("https://chat.deepseek.com"),
  DUB_API_PATH_PATTERN: z.string().trim().min(1).default("/api/v0/chat/completion"),
  DUB_CONTENT_PATH: z.string().trim().min(1).default("response/fragments/-1/content"),
  DUB_WORKSPACE_ROOT: z.string().trim().default(""),
  DUB_AUTO_APPROVE_COMMANDS: z.string().trim().default("false").transform((v) => v.toLowerCase() === "true" || v === "1"),
  DUB_COMMAND_WHITELIST: z.string().trim().default(""),
  DUB_COMMAND_WHITELIST_EXTRA: z.string().trim().default(""),
  DUB_MAX_FILE_BYTES: z.coerce.number().int().min(1024).default(256 * 1024),
  DUB_MAX_RESULT_CHARS: z.coerce.number().int().min(256).default(16 * 1024),
  DUB_RESPECT_GITIGNORE: z.string().trim().default("true").transform((v) => v.toLowerCase() === "true" || v === "1"),
  DUB_READ_ONLY: z.string().trim().default("false").transform((v) => v.toLowerCase() === "true" || v === "1"),
  DUB_MAX_RESPONSE_CHARS: z.coerce.number().int().min(4096).default(200 * 1024),
  DUB_SEND_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(3e3),
  DUB_REPLY_MIN_GAP_MS: z.coerce.number().int().min(0).default(2e3),
  DUB_FILL_WAIT_MS: z.coerce.number().int().min(0).default(5e3),
  DUB_STREAM_CONFIRM_MS: z.coerce.number().int().min(0).default(8e3),
  DUB_RESPONSE_TIMEOUT_MS: z.coerce.number().int().min(5e3).default(18e4),
  DUB_MAX_REPEAT_CALLS: z.coerce.number().int().min(1).max(50).default(3),
  DUB_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(1e3).default(12e4),
  DUB_MAX_COMMAND_OUTPUT_CHARS: z.coerce.number().int().min(256).default(16 * 1024),
  DUB_COMMAND_CWD: z.string().trim().default(""),
  DUB_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DUB_CHROME_PATH: z.string().trim().default(""),
  DUB_CHROME_PROFILE_DIR: z.string().trim().default(""),
  DUB_AUTO_SEND_PROMPT: z.string().trim().default("true").transform((v) => v.toLowerCase() === "true" || v === "1"),
  DUB_PROMPT_FILE: z.string().trim().min(1).default("prompts/deepseek-system-prompt.md"),
  DUB_AGENT_FILE: z.string().trim().default("agent.md")
});
function loadDotEnv(cwd = process2.cwd()) {
  const envPath = path.resolve(cwd, ".env");
  if (!existsSync(envPath)) return null;
  try {
    process2.loadEnvFile(envPath);
    return envPath;
  } catch {
    return null;
  }
}
function splitList(raw) {
  return raw.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}
function assertDirectory(dir, label) {
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    throw new Error(`${label} \u4E0D\u5B58\u5728\u6216\u4E0D\u53EF\u8BBF\u95EE\uFF1A${dir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} \u4E0D\u662F\u76EE\u5F55\uFF1A${dir}`);
  }
}
function loadConfig(options = {}) {
  const cwd = options.cwd ?? process2.cwd();
  if (options.loadEnv !== false) {
    loadDotEnv(cwd);
  }
  const parsed = envSchema.safeParse(process2.env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    throw new Error(`\u914D\u7F6E\u6821\u9A8C\u5931\u8D25\uFF1A${details}`);
  }
  const env = parsed.data;
  const workspaceRoot = path.resolve(cwd, env.DUB_WORKSPACE_ROOT || ".");
  assertDirectory(workspaceRoot, "\u5DE5\u4F5C\u76EE\u5F55 DUB_WORKSPACE_ROOT");
  const commandCwd = env.DUB_COMMAND_CWD ? path.resolve(cwd, env.DUB_COMMAND_CWD) : workspaceRoot;
  assertDirectory(commandCwd, "\u547D\u4EE4\u5DE5\u4F5C\u76EE\u5F55 DUB_COMMAND_CWD");
  const baseWhitelist = env.DUB_COMMAND_WHITELIST ? splitList(env.DUB_COMMAND_WHITELIST) : [...DEFAULT_COMMAND_WHITELIST];
  const whitelist = [.../* @__PURE__ */ new Set([...baseWhitelist, ...splitList(env.DUB_COMMAND_WHITELIST_EXTRA)])];
  const config = {
    cdpHost: env.DUB_CDP_HOST,
    cdpPort: env.DUB_CDP_PORT,
    targetUrlPrefix: env.DUB_TARGET_URL_PREFIX,
    apiPathPattern: env.DUB_API_PATH_PATTERN,
    contentPath: env.DUB_CONTENT_PATH,
    workspaceRoot,
    autoApproveCommands: env.DUB_AUTO_APPROVE_COMMANDS,
    commandWhitelist: whitelist,
    maxFileBytes: env.DUB_MAX_FILE_BYTES,
    maxResultChars: env.DUB_MAX_RESULT_CHARS,
    respectGitignore: env.DUB_RESPECT_GITIGNORE,
    readOnly: env.DUB_READ_ONLY,
    maxResponseChars: env.DUB_MAX_RESPONSE_CHARS,
    sendMinIntervalMs: env.DUB_SEND_MIN_INTERVAL_MS,
    replyMinGapMs: env.DUB_REPLY_MIN_GAP_MS,
    fillWaitMs: env.DUB_FILL_WAIT_MS,
    streamConfirmMs: env.DUB_STREAM_CONFIRM_MS,
    responseTimeoutMs: env.DUB_RESPONSE_TIMEOUT_MS,
    maxRepeatCalls: env.DUB_MAX_REPEAT_CALLS,
    commandTimeoutMs: env.DUB_COMMAND_TIMEOUT_MS,
    maxCommandOutputChars: env.DUB_MAX_COMMAND_OUTPUT_CHARS,
    commandCwd,
    logLevel: env.DUB_LOG_LEVEL,
    ...env.DUB_CHROME_PATH ? { chromePath: env.DUB_CHROME_PATH } : {},
    ...env.DUB_CHROME_PROFILE_DIR ? { chromeProfileDir: env.DUB_CHROME_PROFILE_DIR } : {},
    autoSendPrompt: env.DUB_AUTO_SEND_PROMPT,
    promptFilePath: env.DUB_PROMPT_FILE,
    agentFilePath: env.DUB_AGENT_FILE
  };
  return { ...config, ...options.overrides };
}

// src/server/launch-chrome.ts
import { spawn } from "child_process";
import { existsSync as existsSync2, mkdirSync } from "fs";
import os from "os";
import path2 from "path";

// src/cdp/discover.ts
var CdpUnavailableError = class extends Error {
  name = "CdpUnavailableError";
};
function cdpBaseUrl(config) {
  return `http://${config.cdpHost}:${config.cdpPort}`;
}
async function fetchJson(url, timeoutMs) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new CdpUnavailableError(`\u8BF7\u6C42 ${url} \u5931\u8D25\uFF1A${cause}`);
  }
  if (!response.ok) {
    throw new CdpUnavailableError(`\u8BF7\u6C42 ${url} \u8FD4\u56DE HTTP ${response.status}`);
  }
  return response.json();
}
async function listTargets(config, timeoutMs = 3e3) {
  const raw = await fetchJson(`${cdpBaseUrl(config)}/json/list`, timeoutMs);
  if (!Array.isArray(raw)) {
    throw new CdpUnavailableError(`\u8C03\u8BD5\u7AEF\u53E3\u8FD4\u56DE\u4E86\u975E\u9884\u671F\u7684\u76EE\u6807\u6E05\u5355\uFF1A${typeof raw}`);
  }
  return raw.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item;
    const id = typeof record.id === "string" ? record.id : "";
    if (!id) return [];
    const target = {
      id,
      type: typeof record.type === "string" ? record.type : "",
      title: typeof record.title === "string" ? record.title : "",
      url: typeof record.url === "string" ? record.url : ""
    };
    if (typeof record.webSocketDebuggerUrl === "string") {
      target.webSocketDebuggerUrl = record.webSocketDebuggerUrl;
    }
    return [target];
  });
}

// src/server/launch-chrome.ts
function parseLaunchArgs(argv, config) {
  let port = config.cdpPort;
  let url = config.targetUrlPrefix;
  let profileDir = config.chromeProfileDir ?? path2.join(os.tmpdir(), "dubridge-chrome-profile");
  let dryRun = false;
  let chromePath = config.chromePath;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--port" && next) {
      port = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--url" && next) {
      url = next;
      i += 1;
    } else if (arg === "--profile" && next) {
      profileDir = next;
      i += 1;
    } else if (arg === "--chrome" && next) {
      chromePath = next;
      i += 1;
    } else if (arg === "--dry-run") {
      dryRun = true;
    }
  }
  const options = { port, url, profileDir, dryRun };
  if (chromePath) options.chromePath = chromePath;
  return options;
}
var CHROME_CANDIDATES_WIN = [
  path2.join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
  path2.join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Google",
    "Chrome",
    "Application",
    "chrome.exe"
  ),
  path2.join(process.env["LocalAppData"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  path2.join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Google", "Chrome Beta", "Application", "chrome.exe"),
  path2.join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft",
    "Edge",
    "Application",
    "msedge.exe"
  ),
  path2.join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe")
];
var CHROME_CANDIDATES_POSIX = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
];
function detectChrome() {
  const candidates = process.platform === "win32" ? CHROME_CANDIDATES_WIN : CHROME_CANDIDATES_POSIX;
  for (const candidate of candidates) {
    if (candidate && existsSync2(candidate)) return candidate;
  }
  return null;
}
function buildChromeArgs(options) {
  return [
    `--remote-debugging-port=${options.port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${options.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    options.url
  ];
}
var READY_POLL_MS = 500;
var DEFAULT_READY_TIMEOUT_MS = 1e4;
async function launchChrome(options, log, readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS) {
  const logger = log.child("launch");
  const probe = { cdpHost: "127.0.0.1", cdpPort: options.port };
  const existing = await listTargets(probe).catch(() => null);
  if (existing && existing.length > 0) {
    logger.info("\u8C03\u8BD5\u7AEF\u53E3\u5DF2\u5C31\u7EEA\uFF0C\u65E0\u9700\u91CD\u590D\u542F\u52A8", { \u7AEF\u53E3: options.port, \u6807\u7B7E\u9875\u6570: existing.length });
    return {
      status: "already-running",
      detail: `\u8C03\u8BD5\u7AEF\u53E3 ${options.port} \u5DF2\u5C31\u7EEA`,
      command: "",
      targets: existing
    };
  }
  const chromePath = options.chromePath ?? detectChrome();
  const args = buildChromeArgs(options);
  const command = chromePath ? `"${chromePath}" ${args.join(" ")}` : `chrome ${args.join(" ")}`;
  if (!chromePath) {
    logger.error("\u672A\u80FD\u81EA\u52A8\u627E\u5230 Chrome\uFF0C\u8BF7\u7528 --chrome <\u8DEF\u5F84> \u6307\u5B9A\uFF0C\u6216\u624B\u52A8\u6267\u884C\u4E0B\u9762\u7684\u547D\u4EE4\uFF1A");
    logger.info(command);
    return { status: "no-browser", detail: "\u672A\u627E\u5230 Chrome / Edge \u53EF\u6267\u884C\u6587\u4EF6", command };
  }
  if (!existsSync2(options.profileDir)) {
    mkdirSync(options.profileDir, { recursive: true });
  }
  logger.info("\u5373\u5C06\u542F\u52A8\u8C03\u8BD5\u6A21\u5F0F\u6D4F\u89C8\u5668", {
    \u53EF\u6267\u884C\u6587\u4EF6: chromePath,
    \u914D\u7F6E\u76EE\u5F55: options.profileDir,
    \u7AEF\u53E3: options.port
  });
  logger.info("\u63D0\u793A\uFF1A\u8BE5\u5B9E\u4F8B\u4E0E\u4F60\u7684\u65E5\u5E38\u6D4F\u89C8\u5668\u4E92\u76F8\u9694\u79BB\uFF0C\u9996\u6B21\u542F\u52A8\u9700\u8981\u5728\u8FD9\u4E2A\u7A97\u53E3\u91CC\u767B\u5F55 DeepSeek\u3002");
  if (options.dryRun) {
    logger.info("--dry-run \u5DF2\u6307\u5B9A\uFF0C\u672A\u5B9E\u9645\u542F\u52A8");
    return { status: "dry-run", detail: "\u5DF2\u8DF3\u8FC7\u5B9E\u9645\u542F\u52A8", command };
  }
  const child = spawn(chromePath, args, { detached: true, stdio: "ignore" });
  child.unref();
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    const targets = await listTargets(probe).catch(() => null);
    if (targets && targets.length > 0) {
      logger.info("\u8C03\u8BD5\u7AEF\u53E3\u5DF2\u5C31\u7EEA", { \u6807\u7B7E\u9875\u6570: targets.length });
      return {
        status: "started",
        detail: `\u8C03\u8BD5\u7AEF\u53E3 ${options.port} \u5DF2\u5C31\u7EEA`,
        command,
        targets
      };
    }
  }
  const seconds = Math.round(readyTimeoutMs / 1e3);
  logger.warn(
    `\u5DF2\u542F\u52A8\u6D4F\u89C8\u5668\uFF0C\u4F46\u8C03\u8BD5\u7AEF\u53E3\u5728 ${seconds} \u79D2\u5185\u4ECD\u672A\u5C31\u7EEA\u3002\u8BF7\u786E\u8BA4\u6CA1\u6709\u5176\u5B83 Chrome \u5B9E\u4F8B\u5360\u7528\u4E86\u540C\u4E00\u914D\u7F6E\u76EE\u5F55\u3002`
  );
  return { status: "timeout", detail: `\u8C03\u8BD5\u7AEF\u53E3\u5728 ${seconds} \u79D2\u5185\u672A\u5C31\u7EEA`, command };
}

// src/server/logger.ts
var LEVEL_ORDER = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};
var LVL_TAG = {
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR"
};
var COLOR = {
  debug: "\x1B[90m",
  info: "\x1B[36m",
  warn: "\x1B[33m",
  error: "\x1B[31m"
};
var DIM = "\x1B[90m";
var RESET = "\x1B[0m";
var MAX_LOG_CHARS = 4e3;
var SENSITIVE_KEY_RE = /(token|cookie|authorization|auth|password|passwd|secret|apikey|api_key)/i;
function redact(value, depth = 0) {
  if (depth > 4) return "[deep]";
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack?.split("\n").slice(0, 5).join("\n") };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => redact(item, depth + 1));
  }
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? "[redacted]" : redact(val, depth + 1);
  }
  return out;
}
function formatMeta(meta) {
  if (meta === void 0) return "";
  const safe = redact(meta);
  let text;
  if (typeof safe === "string") {
    text = safe;
  } else {
    try {
      text = JSON.stringify(safe);
    } catch {
      text = String(safe);
    }
  }
  if (text.length > MAX_LOG_CHARS) {
    text = `${text.slice(0, MAX_LOG_CHARS)}\u2026[+${text.length - MAX_LOG_CHARS} \u5B57\u7B26]`;
  }
  return text;
}
function timestamp() {
  const now = /* @__PURE__ */ new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}
function createLogger(options, scope = "dubridge") {
  const threshold = LEVEL_ORDER[options.level];
  const color = options.color ?? Boolean(process.stdout.isTTY);
  const emit = (level, message, meta) => {
    if (LEVEL_ORDER[level] < threshold) return;
    const prefix = color ? `${DIM}${timestamp()}${RESET} ${COLOR[level]}${LVL_TAG[level]}${RESET} ${DIM}[${scope}]${RESET}` : `${timestamp()} ${LVL_TAG[level]} [${scope}]`;
    const tail = formatMeta(meta);
    const line = tail ? `${prefix} ${message} ${DIM}${tail}${RESET}` : `${prefix} ${message}`;
    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
    stream.write(`${line}
`);
  };
  return {
    level: options.level,
    debug: (message, meta) => emit("debug", message, meta),
    info: (message, meta) => emit("info", message, meta),
    warn: (message, meta) => emit("warn", message, meta),
    error: (message, meta) => emit("error", message, meta),
    child: (childScope) => createLogger(options, `${scope}:${childScope}`)
  };
}

// scripts/launch-chrome.ts
async function main() {
  const logger = createLogger({ level: "info" }).child("launch");
  const config = loadConfig();
  const options = parseLaunchArgs(process3.argv.slice(2), config);
  const result = await launchChrome(options, logger);
  if (result.status === "no-browser" || result.status === "timeout") {
    process3.exitCode = 1;
    return;
  }
  if (result.status === "started") {
    logger.info("\u4E0B\u4E00\u6B65\uFF1A\u5728\u521A\u6253\u5F00\u7684\u7A97\u53E3\u91CC\u767B\u5F55 DeepSeek\uFF0C\u7136\u540E\u8FD0\u884C  npm run doctor");
  } else if (result.status === "already-running") {
    const deepseek = (result.targets ?? []).find((t) => t.url.startsWith(options.url));
    if (!deepseek) {
      logger.warn("\u5DF2\u6709\u8C03\u8BD5\u7AEF\u53E3\uFF0C\u4F46\u6CA1\u6709\u6253\u5F00\u76EE\u6807\u9875\u9762\u3002\u8BF7\u5728\u8BE5\u6D4F\u89C8\u5668\u4E2D\u6253\u5F00\uFF1A", { url: options.url });
    }
  }
}
main().catch((error) => {
  createLogger({ level: "error" }).error("\u542F\u52A8\u5931\u8D25", {
    message: error instanceof Error ? error.message : String(error)
  });
  process3.exitCode = 1;
});
