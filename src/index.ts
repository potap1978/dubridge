#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import chalk from "chalk";
import { Sandbox } from "./sandbox.js";
import { runCommand } from "./tools.js";
import { launchBrowser, sendPrompt, waitForResponse } from "./cdp.js";

const TOOL_PROMPT = `You are dubridge, a local coding agent. Reply ONLY with a tool call in this exact format when you need to act:

\u0060\u0060\u0060tool_call
{"calls":[{"id":"c1","tool":"read_file","args":{"path":"src/index.ts"}}]}
\u0060\u0060\u0060

Available tools:
- read_file(path, offset?, limit?)
- write_file(path, content, create_dirs?)
- edit_file(path, old_text, new_text, replace_all?)
- list_dir(path, depth?)
- search(query, path?, mode?, glob?, context?, max_results?)
- run_command(command, cwd?, timeout_ms?)

If no action is needed, reply with normal text. Sandbox root is the workspace directory. Reply in Russian.`;

interface ToolCall { id: string; tool: string; args: Record<string, unknown>; }

async function executeCalls(root: string, calls: ToolCall[]): Promise<string> {
  const sb = new Sandbox(root);
  const out: string[] = [];
  for (const c of calls) {
    try {
      let r: string;
      switch (c.tool) {
        case "read_file": r = await sb.read(String(c.args.path), Number(c.args.offset ?? 1), Number(c.args.limit ?? 2000)); break;
        case "write_file": await sb.write(String(c.args.path), String(c.args.content)); r = "ok"; break;
        case "edit_file": r = await sb.edit(String(c.args.path), String(c.args.old_text), String(c.args.new_text), Boolean(c.args.replace_all)); break;
        case "list_dir": r = await sb.list(String(c.args.path ?? "."), Number(c.args.depth ?? 1)); break;
        case "search": r = await sb.search(String(c.args.query), String(c.args.path ?? "."), c.args as Record<string, unknown>); break;
        case "run_command": r = await runCommand(String(c.args.cwd ?? root), String(c.args.command), Number(c.args.timeout_ms ?? 120000)); break;
        default: r = `UNKNOWN_TOOL: ${c.tool}`;
      }
      out.push(`[${c.id}] ${c.tool} - OK\n${r}`);
    } catch (e: unknown) {
      out.push(`[${c.id}] ${c.tool} - ERR ${(e as Error).message}`);
    }
  }
  return out.join("\n\n");
}

function parseCalls(text: string): ToolCall[] | null {
  const m = text.match(/\u0060\u0060\u0060tool_call\s*([\s\S]*?)\u0060\u0060\u0060/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1].trim());
    if (Array.isArray(parsed)) return parsed as ToolCall[];
    if (parsed && Array.isArray(parsed.calls)) return parsed.calls as ToolCall[];
    return [parsed as ToolCall];
  } catch { return null; }
}

const program = new Command();
program.name("dubridge").description("Local agent bridging DeepSeek web chat to your repo").version("0.1.0");

program
  .command("run")
  .description("Start agent loop in workspace")
  .option("-w, --workspace <path>", "workspace root", ".")
  .option("-p, --prompt <text>", "initial prompt")
  .action(async (opts: { workspace: string; prompt?: string }) => {
    const root = path.resolve(opts.workspace);
    console.log(chalk.green(`dubridge workspace: ${root}`));
    const { browser, page } = await launchBrowser();
    console.log(chalk.gray("Chrome ready. Log in to DeepSeek in the opened window, then wait."));
    await new Promise((r) => setTimeout(r, 4000));
    const prompt = opts.prompt ?? "Start.";
    await sendPrompt(page, `${TOOL_PROMPT}\n\n---\n\n${prompt}`);
    for (let i = 0; i < 50; i++) {
      const resp = await waitForResponse(page);
      console.log(chalk.cyan("\n--- model ---\n") + resp);
      const calls = parseCalls(resp);
      if (!calls) { console.log(chalk.green("\n[done]")); break; }
      const result = await executeCalls(root, calls);
      console.log(chalk.yellow("\n--- tool results ---\n") + result.slice(0, 2000));
      await sendPrompt(page, "Tool results:\n" + result);
    }
    await browser.close();
  });

program.parseAsync(process.argv).catch((e) => { console.error(e); process.exit(1); });
