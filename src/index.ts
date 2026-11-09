#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { z } from "zod";
import { config } from "./config.js";
import { Sandbox } from "./sandbox.js";
import { runCommand } from "./tools.js";
import { launchOrConnect, sendPrompt, waitForNewAiMessage, CDPPage } from "./cdp.js";
import { sshProbe, sshExec, sshCopy } from "./ssh.js";
import { setup } from "./setup.js";

const DEFAULT_PROMPT = [
  "You are dubridge, a local coding agent.",
  "When you need to use a tool, reply with a tool_call markdown block containing a JSON object like:",
  '{"calls":[{"id":"c1","tool":"read_file","args":{"path":"src/index.ts"}}]}',
  "Available tools: read_file, write_file, edit_file, list_dir, search, run_command.",
  "If no action is needed, reply with plain text.",
  "Reply in Russian. Sandbox root is the workspace directory.",
].join("\n");

function findPkgRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  let dir = __dirname;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return __dirname;
}

function loadSystemPrompt(): string {
  const pkgRoot = findPkgRoot();
  const envPath = process.env.DUB_PROMPT_FILE;
  if (envPath) {
    const candidates = [path.resolve(envPath), path.resolve(pkgRoot, envPath)];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        const content = fs.readFileSync(c, "utf8");
        const match = content.match(/---\s*\n([\s\S]*?)\n\s*---/);
        return match ? match[1].trim() : content;
      }
    }
  }
  const promptPath = path.join(pkgRoot, "prompts", "deepseek-system-prompt.md");
  if (fs.existsSync(promptPath)) {
    const content = fs.readFileSync(promptPath, "utf8");
    const match = content.match(/---\s*\n([\s\S]*?)\n\s*---/);
    return match ? match[1].trim() : content;
  }
  return DEFAULT_PROMPT;
}

const ReadFileSchema = z.object({ path: z.string(), offset: z.number().optional(), limit: z.number().optional() });
const WriteFileSchema = z.object({ path: z.string(), content: z.string(), create_dirs: z.boolean().optional() });
const EditFileSchema = z.object({ path: z.string(), old_text: z.string(), new_text: z.string(), replace_all: z.boolean().optional() });
const ListDirSchema = z.object({ path: z.string().optional(), depth: z.number().optional() });
const SearchSchema = z.object({
  query: z.string(),
  path: z.string().optional(),
  mode: z.enum(["content", "filename"]).optional(),
  glob: z.string().optional(),
  context: z.number().optional(),
  max_results: z.number().optional(),
  case_sensitive: z.boolean().optional()
});
const RunCommandSchema = z.object({ command: z.string(), cwd: z.string().optional(), timeout_ms: z.number().optional() });

const AuthSchema = z.object({
  type: z.enum(["key", "password"]),
  key: z.string().optional(),
  passphrase: z.string().optional(),
  password: z.string().optional(),
  password_env: z.string().optional(),
}).optional();

const SshProbeSchema = z.object({ host: z.string(), port: z.number().optional(), auth: AuthSchema });
const SshExecSchema = z.object({ host: z.string(), command: z.string(), cwd: z.string().optional(), port: z.number().optional(), auth: AuthSchema, timeout_ms: z.number().optional() });
const SshCopySchema = z.object({ host: z.string(), direction: z.enum(["up", "down"]), src: z.string(), dst: z.string(), port: z.number().optional(), auth: AuthSchema, overwrite: z.boolean().optional(), timeout_ms: z.number().optional() });

const ToolCallSchema = z.object({
  id: z.string(),
  tool: z.enum(["read_file", "write_file", "edit_file", "list_dir", "search", "run_command", "ssh_probe", "ssh_exec", "ssh_copy"]),
  args: z.record(z.any())
});

const ParsedResponseSchema = z.object({
  calls: z.array(ToolCallSchema)
});

async function executeCalls(root: string, calls: z.infer<typeof ToolCallSchema>[]): Promise<string> {
  const sb = new Sandbox(root);
  const out: string[] = [];
  for (const c of calls) {
    try {
      let r: string;
      switch (c.tool) {
        case "read_file": {
          const a = ReadFileSchema.parse(c.args);
          r = await sb.read(a.path, a.offset ?? 1, a.limit ?? 2000);
          break;
        }
        case "write_file": {
          const a = WriteFileSchema.parse(c.args);
          await sb.write(a.path, a.content);
          r = "ok";
          break;
        }
        case "edit_file": {
          const a = EditFileSchema.parse(c.args);
          r = await sb.edit(a.path, a.old_text, a.new_text, a.replace_all ?? false);
          break;
        }
        case "list_dir": {
          const a = ListDirSchema.parse(c.args);
          r = await sb.list(a.path ?? ".", a.depth ?? 1);
          break;
        }
        case "search": {
          const a = SearchSchema.parse(c.args);
          r = await sb.search(a.query, a.path ?? ".", a);
          break;
        }
        case "run_command": {
          const a = RunCommandSchema.parse(c.args);
          r = await runCommand(a.cwd ?? root, a.command, a.timeout_ms);
          break;
        }
        case "ssh_probe": {
          const a = SshProbeSchema.parse(c.args);
          r = await sshProbe(a.host, a.port, a.auth);
          break;
        }
        case "ssh_exec": {
          const a = SshExecSchema.parse(c.args);
          r = await sshExec(a.host, a.command, a.cwd, a.port, a.auth, a.timeout_ms);
          break;
        }
        case "ssh_copy": {
          const a = SshCopySchema.parse(c.args);
          r = await sshCopy(a.host, a.direction, a.src, a.dst, a.port, a.auth, a.overwrite, a.timeout_ms);
          break;
        }
        default:
          r = `UNKNOWN_TOOL: ${c.tool}`;
      }
      out.push(`[${c.id}] ${c.tool} - OK\n${r}`);
    } catch (e: unknown) {
      if (e instanceof z.ZodError) {
        out.push(`[${c.id}] ${c.tool} - VALIDATION_ERROR\nInvalid arguments: ${e.errors.map(err => `${err.path.join(".")}: ${err.message}`).join(", ")}`);
      } else {
        out.push(`[${c.id}] ${c.tool} - ERR ${(e as Error).message}`);
      }
    }
  }
  return out.join("\n\n").slice(0, config.maxResultChars);
}

function parseCalls(text: string): z.infer<typeof ToolCallSchema>[] | null {
  const m = text.match(/```tool_call\s*([\s\S]*?)```/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1].trim());
    const validated = ParsedResponseSchema.parse(parsed);
    return validated.calls;
  } catch (e: unknown) {
    if (e instanceof z.ZodError) {
      console.error(chalk.red("Zod validation failed:"), e.errors);
    }
    return null;
  }
}

async function processAiMessage(page: CDPPage, root: string, text: string): Promise<boolean> {
  console.log(chalk.cyan("\n--- model ---\n") + text);
  const calls = parseCalls(text);
  if (!calls) {
    console.log(chalk.gray("[dubridge] Agent idle. Write your next message in the browser chat..."));
    return false;
  }
  const result = await executeCalls(root, calls);
  console.log(chalk.yellow("\n--- tool results ---\n") + result.slice(0, 2000));
  await sendPrompt(page, "Tool results:\n" + result);
  return true;
}

const program = new Command();
program.name("dubridge").description("Local agent bridging DeepSeek web chat to your repo").version("0.1.0");

program
  .command("run")
  .description("Server mode: listens to DeepSeek chat, executes tools")
  .option("-w, --workspace <path>", "workspace root", config.workspaceRoot)
  .option("--no-launch", "Connect to already running Chrome on DUB_CDP_PORT")
  .option("--no-prompt", "Do not send system prompt on startup")
  .action(async (opts: { workspace: string; launch?: boolean; prompt?: boolean }) => {
    const root = path.resolve(opts.workspace);
    console.log(chalk.green(`dubridge workspace: ${root}`));

    if (opts.launch === false) {
      config.launchChrome = false;
    }

    const { page } = await launchOrConnect();
    console.log(chalk.gray("Chrome connected. Log in to DeepSeek if needed."));

    if (opts.prompt !== false) {
      console.log(chalk.gray("Sending system prompt..."));
      const systemPrompt = loadSystemPrompt();
      await sendPrompt(page, systemPrompt + "\n\nОтветь: Готов. Жди задачи от меня в этом же чате.");
      console.log(chalk.gray("System prompt sent. Waiting for reply..."));
      const firstReply = await waitForNewAiMessage(page, 0, 5 * 60 * 1000);
      if (firstReply) {
        console.log(chalk.cyan("\n--- model ---\n") + firstReply.text);
      }
    }

    console.log(chalk.green("\n[dubridge] Listening. Write tasks in the browser chat.\n"));
    let baseline = await page.getAiMessageCount();
    console.log(chalk.gray(`[dubridge] baseline AI messages: ${baseline}`));

    while (true) {
      const next = await waitForNewAiMessage(page, baseline, 3600 * 1000);
      if (!next) {
        console.log(chalk.gray("[dubridge] idle timeout, exiting."));
        break;
      }
      baseline = next.count;
      await processAiMessage(page, root, next.text);
    }
  });

program
  .command("setup")
  .description("Create C:\\DeepSeek structure and download browser (Windows)")
  .action(async () => {
    try {
      await setup();
    } catch (e) {
      console.error(chalk.red("Setup failed:"), e);
      process.exit(1);
    }
  });

if (process.argv.length <= 2) {
  setup()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
} else {
  program.parseAsync(process.argv).catch((e) => { console.error(e); process.exit(1); });
}
