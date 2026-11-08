# dubridge

Turn your chat.deepseek.com web session into a local coding agent via CDP. No API key, no browser extension.

The agent reads/writes files, searches the repo and runs commands **inside a sandboxed workspace**. Mutations never leave the workspace.

## How it works

1. Launches local Chrome with --remote-debugging.
2. Opens chat.deepseek.com; you log in once.
3. Sends user prompt + tool-protocol description.
4. Parses ```tool_call {...}``` blocks from model reply.
5. Executes each call inside workspace, appends results as next user turn.
6. Repeats until model replies without tool calls.

## Install

```bash
npm i -g dubridge
# or
npx dubridge run -w /path/to/repo -p "add a README"
```

Set CHROME_PATH if Chrome autodetection fails.

## Usage

```bash
dubridge run --workspace ./my-repo --prompt "refactor src/index.ts"
```

Options:

- -w, --workspace <path>: sandbox root (default: .)
- -p, --prompt <text>: initial prompt

## Tools exposed to the model

- read_file(path, offset?, limit?)
- write_file(path, content, create_dirs?)
- edit_file(path, old_text, new_text, replace_all?)
- list_dir(path, depth?)
- search(query, path?, mode?, glob?, context?, max_results?)
- run_command(command, cwd?, timeout_ms?) - whitelist only

## Safety

- Path sandbox: every resolved path must stay inside workspace (OUT_OF_SANDBOX otherwise).
- Binary/non-UTF8 files rejected for writes.
- run_command whitelist: npm run/test/install/ci, git status/log/diff/show/branch/remote, tsc, eslint, node, ls, dir, cat. Anything else -> COMMAND_DENIED. Catastrophic -> COMMAND_BLOCKED.
- Full-overwrite only via write_file; partial edits use edit_file with exact old_text.

## Development

```bash
npm install
npm run dev -- run -w . -p "hello"
npm run build
npm start -- run -w . -p "hello"
```

## License

MIT
