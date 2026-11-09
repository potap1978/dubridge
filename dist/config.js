import dotenv from "dotenv";
import path from "node:path";
import os from "node:os";
dotenv.config();
export const config = {
    cdpHost: process.env.DUB_CDP_HOST || "127.0.0.1",
    cdpPort: parseInt(process.env.DUB_CDP_PORT || "9222", 10),
    launchChrome: process.env.DUB_LAUNCH_CHROME !== "false",
    targetUrl: process.env.DUB_TARGET_URL || "https://chat.deepseek.com/",
    chromePath: process.env.DUB_CHROME_PATH || "",
    chromeProfileDir: process.env.DUB_CHROME_PROFILE_DIR || path.join(os.homedir(), ".dubridge", "chrome-profile"),
    workspaceRoot: process.env.DUB_WORKSPACE_ROOT || (process.platform === "win32" ? "C:\\DeepSeek\\Work-dir" : path.join(os.homedir(), "Work-dir")),
    maxFileBytes: parseInt(process.env.DUB_MAX_FILE_BYTES || "262144", 10),
    maxResultChars: parseInt(process.env.DUB_MAX_RESULT_CHARS || "16384", 10),
    autoApproveCommands: process.env.DUB_AUTO_APPROVE_COMMANDS === "true",
    commandWhitelistExtra: (process.env.DUB_COMMAND_WHITELIST_EXTRA || "").split(",").map(s => s.trim()).filter(Boolean),
    commandTimeoutMs: parseInt(process.env.DUB_COMMAND_TIMEOUT_MS || "120000", 10),
    skipSystemPrompt: process.env.DUB_SKIP_SYSTEM_PROMPT === "true",
    maxIterations: parseInt(process.env.DUB_MAX_ITERATIONS || "50", 10),
    logLevel: process.env.DUB_LOG_LEVEL || "info",
};
//# sourceMappingURL=config.js.map