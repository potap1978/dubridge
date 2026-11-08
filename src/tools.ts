import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

const pExec = promisify(execFile);

const DEFAULT_WHITELIST: RegExp[] = [
  /^npm\s+(run|test|install|ci)\b/,
  /^git\s+(status|log|diff|show|branch|remote)\b/,
  /^tsc\b/,
  /^eslint\b/,
  /^node\b/,
  /^ls\b/,
  /^dir\b/,
  /^cat\b/,
];

const EXTRA_WHITELIST: RegExp[] = config.commandWhitelistExtra.map(
  (cmd) => new RegExp(`^${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
);

const CATASTROPHIC: RegExp[] = [
  /rm\s+-rf\s+\//,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bhalt\b/i,
  /\bmkfs\b/i,
];

export async function runCommand(cwd: string, command: string, timeout?: number): Promise<string> {
  for (const c of CATASTROPHIC) if (c.test(command)) throw new Error("COMMAND_BLOCKED: catastrophic");
  
  const ok = [...DEFAULT_WHITELIST, ...EXTRA_WHITELIST].some((r) => r.test(command));
  
  if (!ok && !config.autoApproveCommands) {
    throw new Error("COMMAND_DENIED: not in whitelist (set DUB_AUTO_APPROVE_COMMANDS=true to allow all)");
  }
  
  const isWin = process.platform === "win32";
  const shell = isWin ? "cmd.exe" : "sh";
  const args = isWin ? ["/c", command] : ["-c", command];
  const execTimeout = timeout ?? config.commandTimeoutMs;
  
  try {
    const { stdout, stderr } = await pExec(shell, args, { cwd, timeout: execTimeout, maxBuffer: 10 * 1024 * 1024 });
    return `stdout:\n${stdout}\nstderr:\n${stderr}`;
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return `exit error: ${err.message}\nstdout:\n${err.stdout ?? ""}\nstderr:\n${err.stderr ?? ""}`;
  }
}
