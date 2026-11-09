import { spawn, spawnSync } from "child_process";
import crypto from "crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import os from "os";
import path from "path";
import { z } from "zod";

class SshError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "SshError";
  }
}

const resolveCache = new Map();
const hostKeyCache = new Map();
const probeCache = new Map();
const passwordCache = new Map();
let pythonCommand = null;

const CATASTROPHIC_PATTERNS = [
  /\brm\s+-\S*[rf]\S*\s+\/(?:\s|$)/i,
  /\brm\s+-\S*[rf]\S*\s+\/\*/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\b[^\n;|&]*\bof=\/dev\/sd[a-z0-9]*/i,
  />\s*\/dev\/sd[a-z0-9]*/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/
];
const SHUTDOWN_PATTERN = /\b(shutdown|reboot|poweroff|halt|systemctl\s+(?:reboot|poweroff|halt)|init\s+[06])\b/i;
const READONLY_COMMANDS = new Set([
  "ls", "cat", "cd", "pwd", "whoami", "id", "uname", "hostname", "date", "uptime", "cal",
  "ps", "top", "free", "df", "du", "ss", "netstat", "ip", "route", "arp", "ifconfig",
  "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "ack", "find", "fd",
  "stat", "file", "wc", "which", "whereis", "type", "printenv", "env", "echo", "printf",
  "test", "true", "false", "journalctl", "dmesg", "lsblk", "lscpu", "lsmod", "lspci",
  "lsusb", "getent", "groups", "last", "w", "who", "ping", "dig", "nslookup", "host",
  "xxd", "od", "hexdump", "strings", "tree", "basename", "dirname", "seq", "sort",
  "uniq", "cut", "tr", "rev", "comm", "join", "column", "md5sum", "sha1sum", "sha256sum", "cksum"
]);
const NESTED_READONLY = {
  systemctl: new Set(["status", "is-active", "is-enabled", "show", "list-units", "list-timers", "list-sockets", "cat", "help"]),
  docker: new Set(["ps", "images", "version", "info", "logs", "inspect", "stats", "top", "port", "diff"]),
  podman: new Set(["ps", "images", "version", "info", "logs", "inspect", "stats", "top", "port", "diff"]),
  git: new Set(["status", "log", "diff", "show", "branch", "remote", "rev-parse", "describe", "blame", "tag", "ls-files", "ls-tree", "shortlog", "reflog", "stash", "help", "version"]),
  kubectl: new Set(["get", "describe", "logs", "version", "top", "config", "cluster-info", "explain"]),
  npm: new Set(["ls", "list", "view", "info", "outdated", "docs", "help", "root", "prefix", "version"]),
  yarn: new Set(["list", "info", "why", "versions"])
};
const WRAPPER_TOKENS = new Set(["sudo", "doas", "nice", "nohup", "time", "command", "exec", "env"]);

function expandTilde(value) {
  return String(value).replace(/^~(?=$|[\\/])/, os.homedir());
}

function resolvePython() {
  if (pythonCommand) return pythonCommand;
  const fromEnv = process.env.DUB_PYTHON;
  const candidates = fromEnv ? [fromEnv] : ["python", "py -3", "python3"];
  for (const candidate of candidates) {
    const parts = candidate.split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    let probe;
    try {
      probe = spawnSync(parts[0], [...parts.slice(1), "--version"], { encoding: "utf8", timeout: 15000, windowsHide: true });
    } catch {
      continue;
    }
    if (!probe.error && probe.status === 0) {
      pythonCommand = parts;
      return parts;
    }
  }
  throw new SshError(
    "SSH_CONN_FAILED",
    "Python не найден. Установите Python 3 с пакетом paramiko (`python -m pip install paramiko`) или укажите путь в переменной DUB_PYTHON"
  );
}

function runHelper(job, timeoutMs, signal) {
  const parts = resolvePython();
  const script = path.join(import.meta.dirname, "ssh_helper.py");
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(parts[0], [...parts.slice(1), script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      reject(new SshError("SSH_CONN_FAILED", `не удалось запустить Python: ${error.message}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const onAbort = () => child.kill();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new SshError(
          "SSH_CONN_FAILED",
          `не удалось запустить Python: ${error.message}. Проверьте DUB_PYTHON или установите Python с paramiko`
        )
      );
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (signal?.aborted) {
        reject(new SshError("SSH_CONN_FAILED", "SSH-операция прервана: сервис завершается"));
        return;
      }
      if (timedOut) {
        reject(new SshError("SSH_TIMEOUT", `SSH-операция превысила лимит ${timeoutMs}ms и была завершена`));
        return;
      }
      const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
      const last = lines[lines.length - 1];
      if (!last) {
        const detail = stderr.trim().slice(-1500);
        reject(new SshError("SSH_CONN_FAILED", `SSH-хелпер не вернул результата${detail ? `: ${detail}` : ""}`));
        return;
      }
      let payload;
      try {
        payload = JSON.parse(last);
      } catch {
        reject(new SshError("SSH_CONN_FAILED", `некорректный ответ SSH-хелпера: ${last.slice(0, 300)}`));
        return;
      }
      resolve(payload);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(job));
  });
}

function unwrap(payload) {
  if (!payload || payload.ok !== true) {
    throw new SshError(payload?.error || "SSH_CONN_FAILED", payload?.message || "неизвестная ошибка SSH");
  }
  return payload;
}

function parseHost(host) {
  const at = host.lastIndexOf("@");
  if (at > 0) return { user: host.slice(0, at), alias: host.slice(at + 1) };
  return { user: null, alias: host };
}

function knownHostsPath() {
  return path.join(os.homedir(), ".ssh", "known_hosts");
}

function matchHashedEntry(entry, hostname) {
  const parts = entry.split("|");
  if (parts.length !== 4 || parts[0] !== "" || parts[1] !== "1") return false;
  const salt = Buffer.from(parts[2], "base64");
  const digest = Buffer.from(parts[3], "base64");
  if (salt.length === 0 || digest.length === 0) return false;
  const mac = crypto.createHmac("sha1", salt).update(hostname).digest();
  if (mac.length !== digest.length) return false;
  return crypto.timingSafeEqual(mac, digest);
}

function hostMatches(field, hostname, port) {
  for (const raw of field.split(",")) {
    const entry = raw.trim();
    if (!entry || entry.startsWith("!")) continue;
    if (port !== 22) {
      if (entry === `[${hostname}]:${port}`) return true;
      continue;
    }
    if (entry.startsWith("|1|")) {
      if (matchHashedEntry(entry, hostname)) return true;
      continue;
    }
    if (entry === hostname) return true;
    if (entry.startsWith("*.") && hostname.endsWith(entry.slice(1)) && hostname.length > entry.length - 1) return true;
  }
  return false;
}

function collectKnownHostKeys(hostname, port) {
  const file = knownHostsPath();
  if (!existsSync(file)) return [];
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const keys = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("@")) continue;
    const [field, keyType, key] = trimmed.split(/\s+/);
    if (!field || !keyType || !key) continue;
    if (hostMatches(field, hostname, port)) keys.push(`${keyType} ${key}`);
  }
  return keys;
}

function runKeyScan(hostname, port, signal) {
  const args = port === 22 ? [hostname] : ["-p", String(port), hostname];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("ssh-keyscan", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      reject(new SshError("SSH_HOST_KEY_UNKNOWN", `ssh-keyscan не удалось запустить: ${error.message}`));
      return;
    }
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => child.kill(), 20000);
    const onAbort = () => child.kill();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new SshError("SSH_HOST_KEY_UNKNOWN", `ssh-keyscan недоступен (${error.message}); добавьте ключ хоста вручную: ssh-keyscan -p ${port} ${hostname} >> ~/.ssh/known_hosts`));
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      cleanup();
      const keys = [];
      const rawLines = [];
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const [field, keyType, key] = trimmed.split(/\s+/);
        if (!field || !keyType || !key) continue;
        keys.push(`${keyType} ${key}`);
        rawLines.push(`${field} ${keyType} ${key}`);
      }
      if (rawLines.length > 0) {
        try {
          const dir = path.dirname(knownHostsPath());
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
          appendFileSync(knownHostsPath(), rawLines.join("\n") + "\n", "utf8");
        } catch {
          keys.length = 0;
        }
      }
      resolve(keys);
    });
  });
}

async function ensureHostKeys(hostname, port, context) {
  const cacheKey = `${hostname}:${port}`;
  const cached = hostKeyCache.get(cacheKey);
  if (cached && cached.length > 0) return cached;
  let keys = collectKnownHostKeys(hostname, port);
  if (keys.length === 0) {
    const label = port === 22 ? hostname : `[${hostname}]:${port}`;
    const allowed = await context.confirm(
      `ssh-keyscan ${label}`,
      `Хост ${label} отсутствует в known_hosts. Разрешить получить ключ сервера через ssh-keyscan, добавить его в ~/.ssh/known_hosts и подключиться?`
    );
    if (!allowed) {
      throw new SshError(
        "SSH_HOST_KEY_UNKNOWN",
        `хост ${label} отсутствует в known_hosts, пользователь отклонил добавление ключа; соединение не установлено`
      );
    }
    keys = await runKeyScan(hostname, port, context.signal);
    if (keys.length === 0) {
      throw new SshError(
        "SSH_HOST_KEY_UNKNOWN",
        `ssh-keyscan не вернул ключей для ${label}; добавьте ключ вручную и повторите попытку`
      );
    }
  }
  hostKeyCache.set(cacheKey, keys);
  return keys;
}

async function prepareConnection(args, context) {
  const { user, alias } = parseHost(args.host);
  const cacheKey = `${alias}|${user ?? ""}|${args.port ?? ""}`;
  let resolved = resolveCache.get(cacheKey);
  if (!resolved) {
    const payload = unwrap(await runHelper({ action: "resolve", host: alias }, 25000, context.signal));
    resolved = payload.resolved || {};
    if (resolved.proxy) {
      throw new SshError(
        "COMMAND_DENIED",
        `ProxyJump/ProxyCommand в ~/.ssh/config запрещены правилом 11 (без туннелей и пробросов): ${resolved.proxy}`
      );
    }
    resolveCache.set(cacheKey, resolved);
  }
  const hostname = resolved.hostname || alias;
  const port = Number(args.port ?? resolved.port ?? 22);
  const username = user ?? resolved.user ?? null;
  return {
    alias,
    user: username,
    hostname,
    port,
    resolved,
    hostKey: `${hostname}:${port}|${username ?? ""}`,
    label: `${username ? `${username}@` : ""}${hostname}${port === 22 ? "" : `:${port}`}`
  };
}

function resolveAuth(auth, conn, expectedKeys) {
  void expectedKeys;
  const type = auth?.type ?? "key";
  if (type === "password") {
    if (auth?.password_env) {
      const value = process.env[auth.password_env];
      if (value === undefined || value === "") {
        throw new SshError(
          "SSH_PASS_ENV_MISSING",
          `переменная окружения ${auth.password_env} не задана или пуста; задайте её в .env или в окружении сервиса`
        );
      }
      passwordCache.set(conn.hostKey, value);
      return { password: value };
    }
    if (auth?.password) {
      passwordCache.set(conn.hostKey, auth.password);
      return { password: auth.password };
    }
    throw new SshError("SSH_PASS_REQUIRED", "для auth.type=password передайте password_env (предпочтительно) или password");
  }
  const keyFiles = [];
  if (auth?.key) {
    keyFiles.push(expandTilde(auth.key));
  } else {
    keyFiles.push(...(conn.resolved.identity_files || []));
  }
  if (keyFiles.length === 0) {
    for (const fallback of [path.join(os.homedir(), ".ssh", "id_ed25519"), path.join(os.homedir(), ".ssh", "id_rsa")]) {
      if (existsSync(fallback)) keyFiles.push(fallback);
    }
  }
  if (keyFiles.length > 0) {
    const result = { key_files: keyFiles };
    if (auth?.passphrase) result.passphrase = auth.passphrase;
    return result;
  }
  const cached = passwordCache.get(conn.hostKey);
  if (cached) return { password: cached };
  throw new SshError(
    "SSH_PASS_REQUIRED",
    "подходящий SSH-ключ не найден (~/.ssh/id_ed25519 и ~/.ssh/id_rsa отсутствуют); передайте auth с type=password или укажите путь к ключу в auth.key"
  );
}

async function ensureProbe(conn, authPayload, context) {
  const cached = probeCache.get(conn.hostKey);
  if (cached) return cached;
  const expected = await ensureHostKeys(conn.hostname, conn.port, context);
  const payload = unwrap(
    await runHelper(
      {
        action: "probe",
        resolved: { ...conn.resolved, hostname: conn.hostname, user: conn.user, port: conn.port, proxy: null },
        auth: authPayload,
        expected_keys: expected,
        timeout_ms: 30000
      },
      90000,
      context.signal
    )
  );
  probeCache.set(conn.hostKey, payload.probe);
  return payload.probe;
}

function headIndex(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    const lower = token.toLowerCase();
    if (WRAPPER_TOKENS.has(lower)) {
      i += 1;
      continue;
    }
    if (token.startsWith("-")) {
      i += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      i += 1;
      continue;
    }
    if (/^[\d.]+[a-z]*$/i.test(token)) {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

function isNestedReadonly(head, tokens, index) {
  const allowed = NESTED_READONLY[head];
  if (!allowed) return false;
  let j = index + 1;
  while (j < tokens.length && tokens[j].startsWith("-")) j += 1;
  const sub = (tokens[j] || "").toLowerCase();
  return allowed.has(sub);
}

function isReadonlySegment(segment) {
  if (/[<>`]/.test(segment) || /\$\(/.test(segment)) return false;
  const tokens = segment.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const index = headIndex(tokens);
  if (index >= tokens.length) return false;
  const head = path.basename(tokens[index]).toLowerCase();
  if (NESTED_READONLY[head]) return isNestedReadonly(head, tokens, index);
  return READONLY_COMMANDS.has(head);
}

function classifyRemoteCommand(command) {
  for (const pattern of CATASTROPHIC_PATTERNS) {
    if (pattern.test(command)) {
      return {
        decision: "deny",
        reason: "катастрофическая команда запрещена даже с подтверждением оператора (rm -rf /, mkfs, dd по блочным устройствам, форк-бомба)"
      };
    }
  }
  if (SHUTDOWN_PATTERN.test(command)) {
    return {
      decision: "confirm",
      reason: "перезагрузка или выключение удалённого хоста: SSH-соединение оборвётся — подтвердите выполнение, если это действительно нужно"
    };
  }
  const segments = command.split(/&&|\|\||;|\||\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (segments.length > 0 && segments.every((segment) => isReadonlySegment(segment))) {
    return { decision: "auto", reason: "команды только для чтения — выполняется без подтверждения" };
  }
  return {
    decision: "confirm",
    reason: "изменение состояния удалённого хоста — требуется ручное подтверждение (правило 10)"
  };
}

const authArgsSchema = z.object({
  type: z.enum(["key", "password"]).optional().describe("key (по умолчанию) или password"),
  key: z.string().trim().min(1).optional().describe("Путь к приватному ключу; по умолчанию — identity files из ~/.ssh/config, затем ~/.ssh/id_ed25519 или ~/.ssh/id_rsa"),
  password: z.string().min(1).optional().describe("Пароль напрямую (нежелательно — правило 12)"),
  password_env: z.string().trim().min(1).optional().describe("Имя переменной окружения с паролем (предпочтительно)"),
  passphrase: z.string().min(1).optional().describe("Фраза-пароль от ключа, если ключ защищён")
}).optional();

const sshHostArgs = {
  host: z.string().trim().min(1, "host не может быть пустым").describe("Alias из ~/.ssh/config или user@host"),
  port: z.coerce.number().int().min(1).max(65535).optional().describe("Порт SSH; по умолчанию из ~/.ssh/config или 22"),
  auth: authArgsSchema,
  timeout_ms: z.coerce.number().int().min(1000).max(36e5).optional()
};

var sshProbeArgsSchema = z.object({ ...sshHostArgs });
var sshExecArgsSchema = z.object({
  ...sshHostArgs,
  command: z.string().min(1, "command не может быть пустым"),
  cwd: z.string().trim().optional().describe("Рабочая директория на удалённом хосте; по умолчанию — домашний каталог")
});
var sshCopyArgsSchema = z.object({
  ...sshHostArgs,
  direction: z.enum(["up", "down"]).describe("up — локальный файл на хост, down — файла с хоста в workspace"),
  src: z.string().trim().min(1, "src не может быть пустым"),
  dst: z.string().trim().min(1, "dst не может быть пустым"),
  overwrite: z.boolean().optional().describe("Перезаписывать существующий файл; по умолчанию false"),
  create_dirs: z.boolean().optional().describe("Создавать каталоги на хосте при direction=up; по умолчанию true")
});

function describeProbe(probe) {
  return [
    `remote_os: ${probe?.remote_os || "unknown"}`,
    `kernel: ${probe?.kernel || "(нет)"}`,
    `user: ${probe?.user || "(нет)"}`,
    `hostname: ${probe?.hostname || "(нет)"}`,
    `cwd: ${probe?.cwd || "(нет)"}`,
    `identity: ${probe?.identity || "(нет)"}`
  ].join("\n");
}

var sshProbeTool = {
  name: "ssh_probe",
  summary: "Проверка SSH-подключения к хосту: аутентификация, доступность, ОС, пользователь, домашний каталог. Только чтение.",
  title: "Проверка SSH-подключения",
  promptGuidelines: [
    "```json",
    '{"host":"user@host","port":22,"auth":{"type":"password","password_env":"SSH_PASS_PROD"}}',
    "```",
    "- Первый вызов на хосте в сессии — всегда `ssh_probe`, затем `ssh_exec`/`ssh_copy`.",
    "- Первое подключение к новому хосту (нет записи в known_hosts) — перед probe будет ручное подтверждение.",
    "- Результат (remote_os, пользователь, каталог) кэшируется на сессию и переиспользуется."
  ].join("\n"),
  access: "execute",
  schema: sshProbeArgsSchema,
  async execute(args, context) {
    const conn = await prepareConnection(args, context);
    const authPayload = resolveAuth(args.auth, conn, null);
    const started = Date.now();
    const probe = await ensureProbe(conn, authPayload, context);
    const text = [
      `Хост: ${conn.label}`,
      `Время: ${Date.now() - started}ms`,
      "",
      describeProbe(probe)
    ].join("\n");
    return {
      text,
      meta: { truncateDirection: "tail" },
      structured: { host: conn.hostname, port: conn.port, user: conn.user, probe }
    };
  }
};

var sshExecTool = {
  name: "ssh_exec",
  summary: "Выполняет команду на удалённом SSH-хосте. Чтение — автоматически, мутации — с ручным подтверждением, катастрофические — отказ.",
  title: "Выполнение команды на SSH-хосте",
  promptGuidelines: [
    "```json",
    '{"host":"user@host","command":"uname -a","cwd":"/home/user","port":22,"auth":{"type":"key"},"timeout_ms":60000}',
    "```",
    "- Первый вызов на хосте в сессии — сначала `ssh_probe`; ssh_exec автоматически делает probe при первом подключении.",
    "- Read-only команды (cat, ls, ps, df, git status/log/diff и т.п.) выполняются без подтверждения.",
    "- Любая мутация (запись, удаление, chmod, установка, перезапуск сервиса и т.п.) требует ручного подтверждения (правило 10).",
    "- Катастрофические команды (rm -rf /, mkfs, dd по блочным устройствам) — отказ даже с подтверждением.",
    "- shutdown/reboot/poweroff — подтверждение с предупреждением об обрыве соединения.",
    "- Длинный вывод — сохраняется конец."
  ].join("\n"),
  access: "execute",
  schema: sshExecArgsSchema,
  async execute(args, context) {
    const assessment = classifyRemoteCommand(args.command);
    if (assessment.decision === "deny") {
      throw new SshError("COMMAND_DENIED", assessment.reason);
    }
    const conn = await prepareConnection(args, context);
    const authPayload = resolveAuth(args.auth, conn, null);
    context.log.info("Решение по SSH-команде", {
      "хост": conn.label,
      "команда": args.command,
      "решение": assessment.decision,
      Причина: assessment.reason
    });
    if (assessment.decision === "confirm") {
      const allowed = await context.confirm(`ssh ${conn.label}: ${args.command}`, assessment.reason);
      if (!allowed) {
        throw new SshError("COMMAND_DENIED", `Пользователь отклонил выполнение на ${conn.label}: ${args.command}`);
      }
    }
    const expected = await ensureHostKeys(conn.hostname, conn.port, context);
    const hasProbe = probeCache.has(conn.hostKey);
    const timeoutMs = args.timeout_ms ?? 6e4;
    const payload = unwrap(
      await runHelper(
        {
          action: "exec",
          resolved: { ...conn.resolved, hostname: conn.hostname, user: conn.user, port: conn.port, proxy: null },
          auth: authPayload,
          expected_keys: expected,
          command: args.command,
          cwd: args.cwd,
          timeout_ms: timeoutMs,
          probe_first: !hasProbe,
          remote_os: probeCache.get(conn.hostKey)?.remote_os
        },
        timeoutMs + 9e4,
        context.signal
      )
    );
    if (payload.probe) probeCache.set(conn.hostKey, payload.probe);
    const stdout = String(payload.stdout ?? "").trimEnd();
    const stderr = String(payload.stderr ?? "").trimEnd();
    const header = [
      `Хост: ${conn.label}`,
      `Команда: ${args.command}`,
      args.cwd ? `cwd: ${args.cwd}` : null,
      payload.remote_command && payload.remote_command !== args.command ? `Реальная команда: ${payload.remote_command}` : null,
      `Решение: ${assessment.decision} (${assessment.reason})`,
      payload.remote_os ? `remote_os: ${payload.remote_os}` : null,
      `exitCode: ${payload.exit_code === null || payload.exit_code === undefined ? "(нет)" : payload.exit_code}`,
      `Время: ${payload.duration_ms ?? 0}ms`
    ].filter((line) => line !== null);
    if (payload.timed_out) header.push(`⚠ Таймаут (${timeoutMs}ms) — соединение закрыто, вывод ниже неполный`);
    const bodyLines = ["--- stdout ---", stdout.length > 0 ? stdout : "(пусто)"];
    if (stderr.length > 0) bodyLines.push("", "--- stderr ---", stderr);
    return {
      text: `${header.join("\n")}\n\n${bodyLines.join("\n")}`,
      meta: {
        bytes: Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8"),
        truncateDirection: "tail",
        exitCode: payload.exit_code
      },
      structured: {
        host: conn.hostname,
        port: conn.port,
        user: conn.user,
        command: args.command,
        decision: assessment.decision,
        reason: assessment.reason,
        exitCode: payload.exit_code,
        timedOut: Boolean(payload.timed_out),
        remote_os: payload.remote_os
      }
    };
  }
};

var sshCopyTool = {
  name: "ssh_copy",
  summary: "Копирует файл между локальным workspace и удалённым SSH-хостом (SFTP). Загрузка на хост требует подтверждения.",
  title: "Копирование файла по SSH (SFTP)",
  promptGuidelines: [
    "```json",
    '{"host":"user@host","direction":"up","src":"dist/app.tar.gz","dst":"/srv/app/app.tar.gz","auth":{"type":"password","password_env":"SSH_PASS_PROD"},"overwrite":true}',
    "```",
    "- direction=up: src — существующий файл внутри workspace, dst — любой путь на хосте; мутация удалённой ФС => подтверждение (правило 10).",
    "- direction=down: src — путь на хосте, dst — путь внутри workspace; подтверждение не нужно.",
    "- Существующий файл не перезаписывается без overwrite:true (иначе NO_CHANGE).",
    "- up: отсутствующие каталоги на хосте создаются (create_dirs, по умолчанию true)."
  ].join("\n"),
  access: "execute",
  schema: sshCopyArgsSchema,
  async execute(args, context) {
    const conn = await prepareConnection(args, context);
    const authPayload = resolveAuth(args.auth, conn, null);
    const overwrite = args.overwrite === true;
    let localSrc = null;
    let localDst = null;
    if (args.direction === "up") {
      try {
        localSrc = context.guard.resolveFile(args.src);
      } catch (error) {
        throw new SshError(error?.code || "NOT_FOUND", error?.message || `файл не найден: ${args.src}`);
      }
      const allowed = await context.confirm(
        `ssh_copy ${conn.label}: ${args.src} -> ${args.dst}`,
        `загрузка файла на удалённый хост — изменение удалённой ФС, требуется подтверждение (правило 10)`
      );
      if (!allowed) {
        throw new SshError("COMMAND_DENIED", `Пользователь отклонил загрузку файла на ${conn.label}: ${args.dst}`);
      }
    } else {
      try {
        localDst = context.guard.resolve(args.dst);
      } catch (error) {
        throw new SshError(error?.code || "OUT_OF_WORKSPACE", error?.message || `путь вне рабочей директории: ${args.dst}`);
      }
      const parent = path.dirname(localDst);
      if (!existsSync(parent)) {
        throw new SshError("NOT_FOUND", `каталог назначения не существует: ${context.guard.relative(parent)}`);
      }
      if (existsSync(localDst) && !overwrite) {
        throw new SshError("NO_CHANGE", `файл уже существует: ${context.guard.relative(localDst)} — передайте overwrite:true, чтобы перезаписать`);
      }
    }
    const expected = await ensureHostKeys(conn.hostname, conn.port, context);
    const hasProbe = probeCache.has(conn.hostKey);
    const timeoutMs = args.timeout_ms ?? 3e5;
    const payload = unwrap(
      await runHelper(
        {
          action: "copy",
          resolved: { ...conn.resolved, hostname: conn.hostname, user: conn.user, port: conn.port, proxy: null },
          auth: authPayload,
          expected_keys: expected,
          direction: args.direction,
          local_src: localSrc,
          local_dst: localDst,
          src: args.direction === "down" ? args.src : void 0,
          dst: args.direction === "up" ? args.dst : void 0,
          overwrite,
          create_dirs: args.create_dirs !== false,
          timeout_ms: timeoutMs,
          probe_first: !hasProbe
        },
        timeoutMs + 9e4,
        context.signal
      )
    );
    if (payload.probe) probeCache.set(conn.hostKey, payload.probe);
    const bytes = Number(payload.bytes ?? 0);
    const text = [
      `Хост: ${conn.label}`,
      `Направление: ${args.direction === "up" ? "up (локальный -> удалённый)" : "down (удалённый -> локальный)"}`,
      args.direction === "up" ? `Источник: ${context.guard.relative(localSrc)} (${bytes} B)` : `Источник: ${args.src} (${bytes} B)`,
      args.direction === "up" ? `Назначение: ${args.dst}` : `Назначение: ${context.guard.relative(localDst)}`,
      `Перезапись: ${overwrite ? "да" : "нет"}`,
      `Время: ${payload.duration_ms ?? 0}ms`
    ].join("\n");
    return {
      text,
      meta: { bytes, truncateDirection: "tail" },
      structured: {
        host: conn.hostname,
        port: conn.port,
        direction: args.direction,
        bytes,
        overwrite
      }
    };
  }
};

export { sshCopyTool, sshExecTool, sshProbeTool };
