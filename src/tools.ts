import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pExec = promisify(execFile);

const WHITELIST: RegExp[] = [
  /^npm\s+(run|test|install|ci)\b/,
  /^git\s+(status|log|diff|show|branch|remote)\b/,
  /^tsc\b/,
  /^eslint\b/,
  /^node\b/,
  /^ls\b/,
  /^dir\b/,
  /^cat\b/,
];

const CATASTROPHIC: RegExp[] = [
  /rm\s+-rf\s+\//,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bhalt\b/i,
  /\bmkfs\b/i,
];

export async function runCommand(cwd: string, command: string, timeout = 120000): Promise<string> {
  for (const c of CATASTROPHIC) if (c.test(command)) throw new Error("COMMAND_BLOCKED: catastrophic");
  const ok = WHITELIST.some((r) => r.test(command));
  if (!ok) throw new Error("COMMAND_DENIED: not in whitelist");
  const isWin = process.platform === "win32";
  const shell = isWin ? "cmd.exe" : "sh";
  const args = isWin ? ["/c", command] : ["-c", command];
  try {
    const { stdout, stderr } = await pExec(shell, args, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 });
    return `stdout:\n${stdout}\nstderr:\n${stderr}`;
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return `exit error: ${err.message}\nstdout:\n${err.stdout ?? ""}\nstderr:\n${err.stderr ?? ""}`;
  }
}
