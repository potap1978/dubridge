#!/usr/bin/env node

// src/server/index.ts
import process7 from "process";

// src/cdp/client.ts
import WebSocket from "ws";
import { sshCopyTool, sshExecTool, sshProbeTool } from "./ssh-tools.mjs";
var CdpProtocolError = class extends Error {
  constructor(message, method, code) {
    super(message);
    this.method = method;
    this.code = code;
  }
  method;
  code;
  name = "CdpProtocolError";
};
var CdpClient = class {
  constructor(webSocketDebuggerUrl, log, options = {}) {
    this.webSocketDebuggerUrl = webSocketDebuggerUrl;
    this.log = log;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15e3;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15e3;
    this.maxPayloadBytes = options.maxPayloadBytes ?? 64 * 1024 * 1024;
  }
  webSocketDebuggerUrl;
  log;
  pending = /* @__PURE__ */ new Map();
  handlers = /* @__PURE__ */ new Map();
  closeHandlers = /* @__PURE__ */ new Set();
  requestTimeoutMs;
  heartbeatIntervalMs;
  maxPayloadBytes;
  socket = null;
  nextId = 1;
  heartbeatTimer = null;
  missedPongs = 0;
  userClosed = false;
  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }
  /** \u5efa\u7acb\u8fde\u63a5\uff1b\u5df2\u8fde\u63a5\u5219\u76f4\u63a5\u8fd4\u56de\u3002 */
  async connect() {
    if (this.connected) return;
    this.userClosed = false;
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.webSocketDebuggerUrl, {
        maxPayload: this.maxPayloadBytes,
        perMessageDeflate: false
      });
      this.socket = socket;
      const onOpenError = (error) => {
        socket.removeAllListeners();
        this.socket = null;
        reject(new Error(`подключение к ${this.webSocketDebuggerUrl} не удалось: ${error.message}`));
      };
      socket.once("error", onOpenError);
      socket.once("open", () => {
        socket.removeListener("error", onOpenError);
        socket.on("error", (error) => {
          this.log.warn("CDP ошибка соединения", { message: error.message });
        });
        socket.on("message", (data) => {
          this.handleMessage(data);
        });
        socket.on("close", (code) => {
          this.handleClose(`socket closed (code=${code})`);
        });
        socket.on("pong", () => {
          this.missedPongs = 0;
        });
        this.startHeartbeat();
        resolve();
      });
    });
  }
  /** \u53d1\u9001\u4e00\u6761 CDP \u547d\u4ee4\u5e76\u7b49\u5f85\u5e94\u7b54\u3002 */
  async send(method, params = {}, sessionId) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new CdpProtocolError("CDP соединение не готово", method);
    }
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpProtocolError(`CDP Таймаут запроса (${this.requestTimeoutMs}ms): ${method}`, method));
      }, this.requestTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
    });
    socket.send(JSON.stringify(payload), (error) => {
      if (!error) return;
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new CdpProtocolError(`отправка CDP-запроса не удалась: ${error.message}`, method));
      }
    });
    return await promise;
  }
  /** \u8ba2\u9605\u6240\u6709 CDP \u4e8b\u4ef6(\u7531\u8c03\u7528\u65b9\u6309\u65b9\u6cd5\u540d\u81ea\u884c\u5206\u53d1)\uff1b\u8fd4\u56de\u53d6\u6d88\u8ba2\u9605\u51fd\u6570\u3002 */
  onAny(handler) {
    return this.on("*", handler);
  }
  /** \u8ba2\u9605\u67d0\u4e2a CDP \u4e8b\u4ef6(\u5982 Runtime.bindingCalled)\uff1b\u8fd4\u56de\u53d6\u6d88\u8ba2\u9605\u51fd\u6570\u3002 */
  on(method, handler) {
    let set = this.handlers.get(method);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }
  /** \u8ba2\u9605\u8fde\u63a5\u5173\u95ed\u4e8b\u4ef6(\u542b\u975e\u7528\u6237\u4e3b\u52a8\u5173\u95ed)\u3002 */
  onClose(handler) {
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }
  close(reason = "client closed") {
    this.userClosed = true;
    this.stopHeartbeat();
    this.socket?.close();
    this.handleClose(reason);
  }
  startHeartbeat() {
    this.stopHeartbeat();
    if (this.heartbeatIntervalMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (this.missedPongs >= 2) {
        this.log.warn("Пульс не отвечает несколько раз \u2014 соединение полуоткрыто, принудительное переподключение");
        socket.terminate();
        return;
      }
      this.missedPongs += 1;
      try {
        socket.ping();
      } catch {
      }
    }, this.heartbeatIntervalMs);
    this.missedPongs = 0;
  }
  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
  handleMessage(data) {
    let parsed;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      this.log.warn("Получено неразбираемое CDP -сообщение, проигнорировано", { bytes: data.toString().length });
      return;
    }
    const id = typeof parsed.id === "number" ? parsed.id : null;
    if (id !== null) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (parsed.error) {
        const err = parsed.error;
        const message = typeof err.message === "string" ? err.message : "неизвестная ошибка";
        pending.reject(
          new CdpProtocolError(
            `${pending.method} не удался: ${message}`,
            pending.method,
            typeof err.code === "number" ? err.code : void 0
          )
        );
      } else {
        pending.resolve(parsed.result ?? {});
      }
      return;
    }
    const method = typeof parsed.method === "string" ? parsed.method : null;
    if (!method) return;
    const event = {
      method,
      params: parsed.params ?? {}
    };
    if (typeof parsed.sessionId === "string") event.sessionId = parsed.sessionId;
    const listeners = [...this.handlers.get(method) ?? [], ...this.handlers.get("*") ?? []];
    for (const handler of listeners) {
      try {
        handler(event);
      } catch (error) {
        this.log.warn(`Исключение в обработчике события: ${method}`, {
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
  handleClose(reason) {
    const wasConnected = this.socket !== null;
    this.stopHeartbeat();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket = null;
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new CdpProtocolError(`Соединение закрыто (${reason}): ${pending.method}`, pending.method));
      this.pending.delete(id);
    }
    if (!wasConnected || this.userClosed) return;
    for (const handler of this.closeHandlers) {
      try {
        handler(reason);
      } catch (error) {
        this.log.warn("Ошибка в обработчике закрытия", {
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
};

// src/cdp/discover.ts
var CdpUnavailableError = class extends Error {
  name = "CdpUnavailableError";
};
function cdpBaseUrl(config) {
  return `http://${config.cdpHost}:${config.cdpPort}`;
}
function launchHint(config) {
  return [
    `Не удалось найти отладочный порт Chrome по адресу ${cdpBaseUrl(config)}.`,
    `Сначала запустите Chrome в режиме отладки Chrome(в проекте можно запустить напрямую): `,
    `  npm run launch-chrome -- --port ${config.cdpPort}`,
    `и убедитесь, что в этом браузере открыт и выполнен вход в ${"https://chat.deepseek.com"}.`
  ].join("\n");
}
async function fetchJson(url, timeoutMs) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new CdpUnavailableError(`Запрос ${url} не удался: ${cause}`);
  }
  if (!response.ok) {
    throw new CdpUnavailableError(`Запрос ${url} вернул HTTP ${response.status}`);
  }
  return response.json();
}
async function getBrowserWebSocketUrl(config, timeoutMs = 3e3) {
  const raw = await fetchJson(`${cdpBaseUrl(config)}/json/version`, timeoutMs);
  const url = typeof raw === "object" && raw !== null ? raw.webSocketDebuggerUrl : void 0;
  if (typeof url !== "string" || url.length === 0) {
    throw new CdpUnavailableError(`${cdpBaseUrl(config)}/json/version не вернул webSocketDebuggerUrl`);
  }
  return url;
}
async function listTargets(config, timeoutMs = 3e3) {
  const raw = await fetchJson(`${cdpBaseUrl(config)}/json/list`, timeoutMs);
  if (!Array.isArray(raw)) {
    throw new CdpUnavailableError(`Отладочный порт вернул неожиданный список целей: ${typeof raw}`);
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
function matchTarget(targets, targetUrlPrefix) {
  const pages = targets.filter((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string");
  return pages.find((t) => t.url.startsWith(targetUrlPrefix)) ?? null;
}
async function findTarget(config, timeoutMs = 3e3) {
  const targets = await listTargets(config, timeoutMs);
  return matchTarget(targets, config.targetUrlPrefix);
}
async function waitForTarget(config, options) {
  const intervalMs = options.intervalMs ?? 1e3;
  const deadline = Date.now() + options.timeoutMs;
  let attempt = 0;
  for (; ; ) {
    options.signal?.throwIfAborted();
    attempt += 1;
    try {
      const target = await findTarget(config);
      if (target) return target;
    } catch (error) {
      if (error instanceof CdpUnavailableError) {
        if (attempt === 1) options.onWait?.(attempt);
      } else {
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      throw new CdpUnavailableError(
        `${launchHint(config)}
Ожидание ${Math.round(options.timeoutMs / 1e3)} секунд \u2014 целевая вкладка не найдена.`
      );
    }
    options.onWait?.(attempt);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// src/cdp/evaluate.ts
var PageEvaluationError = class extends Error {
  constructor(message, pageStack) {
    super(message);
    this.pageStack = pageStack;
  }
  pageStack;
  name = "PageEvaluationError";
};
var UNERIALIZABLE = {
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
  "-Infinity": Number.NEGATIVE_INFINITY,
  "-0": -0
};
function toPlainValue(remote) {
  if (!remote) return void 0;
  if (remote.unserializableValue !== void 0) {
    return UNERIALIZABLE[remote.unserializableValue] ?? remote.unserializableValue;
  }
  if ("value" in remote) return remote.value;
  if (remote.subtype === "null") return null;
  return void 0;
}
function formatException(details) {
  const base = details.exception?.description ?? details.text ?? "Ошибка вычисления на странице";
  const frames = details.stackTrace?.callFrames?.slice(0, 3).map((frame) => `  at ${frame.functionName || "<anonymous>"}:${(frame.lineNumber ?? -1) + 1}`).join("\n");
  return frames ? `${base}
${frames}` : base;
}
async function evaluate(client, sessionId, expression, options = {}) {
  const response = await client.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: options.awaitPromise ?? true,
      returnByValue: options.returnByValue ?? true,
      userGesture: false,
      includeCommandLineAPI: false,
      silent: false
    },
    sessionId
  );
  if (response.exceptionDetails) {
    const stack = response.exceptionDetails.stackTrace?.callFrames?.map((frame) => `${frame.functionName || "<anonymous>"}:${(frame.lineNumber ?? -1) + 1}`).join(" <- ");
    throw new PageEvaluationError(formatException(response.exceptionDetails), stack);
  }
  return toPlainValue(response.result);
}

// src/cdp/session.ts
var CdpPageSession = class {
  constructor(config, log) {
    this.config = config;
    this.log = log;
  }
  config;
  log;
  client = null;
  target = null;
  attachedSessionId = null;
  attachHandlers = /* @__PURE__ */ new Set();
  detachHandlers = /* @__PURE__ */ new Set();
  eventHandlers = /* @__PURE__ */ new Map();
  unsubscribers = [];
  get status() {
    return {
      browserConnected: this.client?.connected ?? false,
      targetId: this.target?.id ?? null,
      sessionId: this.attachedSessionId,
      targetUrl: this.target?.url ?? null
    };
  }
  get attached() {
    return this.attachedSessionId !== null && (this.client?.connected ?? false);
  }
  /** \u9644\u7740\u540e\u7684 CDP \u4f1a\u8bdd id, \u672a\u9644\u7740\u65f6\u629b\u9519\u3002 */
  requireSessionId() {
    if (!this.attachedSessionId || !this.client?.connected) {
      throw new Error("Ещё не подключено к DeepSeek вкладке; сначала вызовите attach()");
    }
    return this.attachedSessionId;
  }
  /** \u6ce8\u518c\u300c\u6bcf\u6b21\u9644\u7740\u6210\u529f\u540e\u90fd\u8981\u6267\u884c\u300d\u7684\u56de\u8c03, \u4f8b\u5982\u91cd\u65b0\u6ce8\u5165\u94a9\u5b50\u3002 */
  onAttached(handler) {
    this.attachHandlers.add(handler);
    return () => {
      this.attachHandlers.delete(handler);
    };
  }
  /** \u8ba2\u9605\u8fde\u63a5\u6216\u9644\u7740\u65ad\u5f00\u4e8b\u4ef6\u3002 */
  onDetach(handler) {
    this.detachHandlers.add(handler);
    return () => {
      this.detachHandlers.delete(handler);
    };
  }
  /** \u8ba2\u9605 CDP \u4e8b\u4ef6\uff1b\u4e8b\u4ef6\u540d\u53ef\u7528 '*' \u8868\u793a\u5168\u90e8\u3002 */
  on(method, handler) {
    let set = this.eventHandlers.get(method);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      this.eventHandlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }
  /**
   * \u9644\u7740\u5230targetUrl\u3002\u5df2\u9644\u7740\u5219\u76f4\u63a5\u8fd4\u56de\u3002
   * waitForTargetMs > 0 \u65f6\u4f1a\u5728targetUrl\u51fa\u73b0\u524d\u4e00\u76f4\u8f6e\u8be2\u3002
   */
  async attach(waitForTargetMs = 0) {
    if (this.attached) return this.requireSessionId();
    await this.teardown("Готовимся переподключиться");
    const target = waitForTargetMs > 0 ? await waitForTarget(this.config, {
      timeoutMs: waitForTargetMs,
      onWait: (attempt) => {
        if (attempt === 1 || attempt % 5 === 0) {
          this.log.info("Ожидание целевой вкладки\u2026\u2026", { attempt: attempt });
        }
      }
    }) : await findTarget(this.config);
    if (!target) {
      throw new Error(launchHint(this.config));
    }
    const browserUrl = await getBrowserWebSocketUrl(this.config);
    const client = new CdpClient(browserUrl, this.log.child("cdp"));
    await client.connect();
    this.client = client;
    this.target = target;
    this.unsubscribers.push(
      client.onClose((reason) => {
        this.attachedSessionId = null;
        this.emitDetach(`CDP Соединение закрыто: ${reason}`);
      })
    );
    this.unsubscribers.push(
      client.onAny((event) => {
        this.dispatchEvent(event);
      })
    );
    const attached = await client.send("Target.attachToTarget", {
      targetId: target.id,
      flatten: true
    });
    this.attachedSessionId = attached.sessionId;
    await client.send("Runtime.enable", {}, this.attachedSessionId);
    await client.send("Page.enable", {}, this.attachedSessionId);
    this.log.info("подключено к вкладке", { "заголовок": target.title, "адрес": target.url });
    for (const handler of this.attachHandlers) {
      try {
        await handler(this);
      } catch (error) {
        this.log.error("Ошибка инициализации после подключения", {
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return this.attachedSessionId;
  }
  /** \u5728\u5f53\u524d\u9644\u7740\u7684\u4f1a\u8bdd\u4e0a\u53d1\u9001 CDP \u547d\u4ee4\u3002 */
  async send(method, params = {}, sessionId) {
    const client = this.client;
    if (!client) throw new Error("CDP соединение разорвано");
    return client.send(method, params, sessionId ?? this.requireSessionId());
  }
  async evaluate(expression, options = {}) {
    const sessionId = this.requireSessionId();
    const client = this.client;
    if (!client) throw new Error("CDP соединение разорвано");
    return evaluate(client, sessionId, expression, options);
  }
  /** \u4e3b\u52a8\u65ad\u5f00\u5e76\u6e05\u7406\u6240\u6709\u8ba2\u9605\u3002 */
  async detach(reason = "Локальный сервис закрыт") {
    if (!this.client) return;
    const client = this.client;
    const sessionId = this.attachedSessionId;
    if (sessionId) {
      try {
        await client.send("Target.detachFromTarget", { sessionId });
      } catch {
      }
    }
    await this.teardown(reason);
  }
  async teardown(reason) {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    this.attachedSessionId = null;
    const client = this.client;
    this.client = null;
    this.target = null;
    client?.close(reason);
  }
  dispatchEvent(event) {
    if (event.sessionId && event.sessionId !== this.attachedSessionId) return;
    if (event.method === "Target.detachedFromTarget") {
      const detached = event.params.sessionId;
      if (typeof detached === "string" && detached === this.attachedSessionId) {
        this.attachedSessionId = null;
        this.emitDetach("Подключение к вкладке разорвано");
      }
      return;
    }
    const listeners = [...this.eventHandlers.get(event.method) ?? [], ...this.eventHandlers.get("*") ?? []];
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        this.log.warn(`Исключение в обработчике события: ${event.method}`, {
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
  emitDetach(reason) {
    this.log.warn("Сессия страницы разорвана", { reason });
    for (const handler of this.detachHandlers) {
      try {
        handler(reason);
      } catch {
      }
    }
  }
};

// src/cdp/agent-source.ts
import { createHash } from "crypto";
var AGENT_BINDING_NAME = "__dubridgeReport";
var AGENT_GLOBAL_NAME = "__dubridgeAgent";
var AGENT_FILL_NAME = "__dubridgeFill";
var AGENT_CONFIRM_NAME = "__dubridgeConfirm";
var AGENT_STATS_NAME = "__dubridgeStats";
var AGENT_NOTICE_NAME = "__dubridgeNotice";
var AGENT_BUSY_NAME = "__dubridgeBusy";
var VERSION_TAG = "__DUBRIDGE_AGENT_VERSION__";
function agentVersion(options = {}) {
  return createHash("sha1").update(renderAgentSource(options, VERSION_TAG)).digest("hex").slice(0, 10);
}
function buildAgentSource(options = {}) {
  return renderAgentSource(options, agentVersion(options));
}
function renderAgentSource(options, version) {
  const apiPathPattern = options.apiPathPattern ?? "/api/v0/chat/completion";
  return String.raw`(() => {
  'use strict';

  const VERSION = ${JSON.stringify(version)};
  const BINDING = ${JSON.stringify(AGENT_BINDING_NAME)};
  const API_PATH = ${JSON.stringify(apiPathPattern)};

  // VERSION \u2014 это хеш исходника скрипта: одинаковый исходник означает одинаковые возможности, можно безопасно переиспользовать уже установленный на странице хук.
  // Ни в коем случае не заменяйте её вручную поддерживаемой константой\u2014\u2014Если при добавлении новой возможности забыть синхронизировать, новый код будет заблокирован этим ранним возвратом,
  // \u8868\u73b0\u4e3a\u300c\u67d0\u4e2a\u65b0\u529f\u80fd\u5728\u6ca1\u5237\u65b0\u7684\u9875\u9762\u4e0a\u9759\u9ed8\u5931\u6548\u300d\u3002
  const existing = window.${AGENT_GLOBAL_NAME};
  if (existing && existing.version === VERSION) {
    if (existing.hooks) existing.hooks.reinstalled = (existing.hooks.reinstalled || 0) + 1;
    return;
  }
  if (existing && typeof existing.flush === 'function') {
    // В очереди предыдущего поколения могут остаться неотправленные фрагменты \u2014 сначала опустошаем её, потом заменяем, чтобы не потерять данные
    try {
      existing.flush();
    } catch (error) {
      /* Ошибка опустошения очереди не мешает установке нового хука */
    }
  }

  const state = {
    version: VERSION,
    installedAt: Date.now(),
    href: location.href,
    hooks: { fetch: false, xhr: false, reinstalled: 0 },
    stats: { streams: 0, messages: 0, dropped: 0, lastError: null },
    errors: [],
  };

  let queue = [];
  let flushTimer = null;
  let streamSeq = 0;
  // Содержимое и время последней попытки отправки: используется для распознавания \u00abв поле ввода на самом деле остаток от прошлого раунда\u00bb
  let lastAttemptText = '';
  let lastAttemptAt = 0;

  function rememberError(message) {
    state.stats.lastError = String(message);
    state.errors.push({ at: Date.now(), message: String(message) });
    if (state.errors.length > 20) state.errors.shift();
  }

  function send(message) {
    queue.push(message);
    if (flushTimer !== null) return;
    flushTimer = setTimeout(flush, 16);
  }

  function flush() {
    flushTimer = null;
    if (queue.length === 0) return;
    const reporter = window[BINDING];
    if (typeof reporter !== 'function') {
      state.stats.dropped += queue.length;
      queue = [];
      return;
    }
    const batch = queue;
    queue = [];
    try {
      state.stats.messages += 1;
      reporter(JSON.stringify({ t: 'batch', items: batch }));
    } catch (error) {
      state.stats.dropped += batch.length;
      rememberError('Ошибка передачи: ' + ((error && error.message) || error));
    }
  }

  function reportLog(level, message) {
    send({ t: 'log', level: level, message: String(message) });
  }

  // ---------- Разделение потока ответа ----------

  function pump(stream, streamId) {
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8');
    function step() {
      return reader.read().then(function (chunk) {
        if (chunk.done) {
          const tail = decoder.decode();
          if (tail) send({ t: 'stream-chunk', streamId: streamId, data: tail });
          send({ t: 'stream-end', streamId: streamId });
          return undefined;
        }
        if (chunk.value) {
          const text = decoder.decode(chunk.value, { stream: true });
          if (text) send({ t: 'stream-chunk', streamId: streamId, data: text });
        }
        return step();
      }, function (error) {
        send({ t: 'stream-error', streamId: streamId, message: String((error && error.message) || error) });
      });
    }
    step();
  }

  function newStreamId(prefix) {
    streamSeq += 1;
    return prefix + streamSeq + '-' + Date.now();
  }

  // \u4e00\u65e6 tee : исходное тело ответа сразу блокируется, нужно вернуть обёрнутый ответ, иначе чтение потока на странице упадёт.
  function wrapResponse(response, url) {
    const body = response.body;
    if (!body || typeof body.getReader !== 'function') return null;
    if (response.status === 204 || response.status === 205 || response.status === 304) return null;

    let branches;
    try {
      branches = body.tee();
    } catch (error) {
      rememberError('Не удалось разделить поток ответа: ' + ((error && error.message) || error));
      return null;
    }

    const streamId = newStreamId('s');
    pump(branches[1], streamId);
    send({ t: 'stream-start', streamId: streamId, url: url, at: Date.now() });
    state.stats.streams += 1;

    let wrapped;
    try {
      wrapped = new Response(branches[0], {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      rememberError('Не удалось сконструировать обёрнутый ответ: ' + ((error && error.message) || error));
      return null;
    }
    try {
      Object.defineProperty(wrapped, 'url', { value: response.url, configurable: true });
      Object.defineProperty(wrapped, 'redirected', { value: response.redirected, configurable: true });
    } catch (error) {
      /* \u5143\u4fe1\u606f\u8865\u5168\u5931\u8d25\u4e0d\u5f71\u54cd\u4e3b\u4f53 */
    }
    return wrapped;
  }

  function matches(url) {
    return typeof url === 'string' && url.indexOf(API_PATH) !== -1;
  }

  // ---------- fetch \u94a9\u5b50 ----------

  try {
    const currentFetch = window.fetch;
    // window.fetch \u53ef\u80fd\u5df2\u7ecf\u88ab\u4e0a\u4e00\u4ee3\u94a9\u5b50\u5305\u8fc7\u3002\u53d6\u51fa\u5b83\u5305\u4f4f\u7684\u539f\u59cb\u5b9e\u73b0\u518d\u5305\u4e00\u5c42, 
    // \u907f\u514d\u5c42\u5c42\u53e0\u52a0\u5bfc\u81f4\u540c\u4e00\u4efd\u5206\u7247\u88ab\u4e0a\u62a5\u591a\u6b21\u3002
    const baseFetch = currentFetch && currentFetch.__dubridgeBase ? currentFetch.__dubridgeBase : currentFetch;
    if (typeof baseFetch === 'function') {
      const hookedFetch = function (input, init) {
        let url = '';
        try {
          if (typeof input === 'string') url = input;
          else if (input && typeof input.url === 'string') url = input.url;
        } catch (error) {
          url = '';
        }

        const promise = baseFetch.apply(this, arguments);
        if (!matches(url)) return promise;

        return promise.then(function (response) {
          try {
            const wrapped = wrapResponse(response, url);
            return wrapped || response;
          } catch (error) {
            rememberError('Не удалось обернуть ответ: ' + ((error && error.message) || error));
            return response;
          }
        });
      };
      try {
        Object.defineProperty(hookedFetch, 'name', { value: baseFetch.name || 'fetch', configurable: true });
      } catch (error) {
        /* \u540d\u79f0\u4fdd\u6301\u5931\u8d25\u53ef\u5ffd\u7565 */
      }
      try {
        Object.defineProperty(hookedFetch, '__dubridgeBase', { value: baseFetch, configurable: true });
      } catch (error) {
        /* \u65e0\u6cd5\u6807\u8bb0\u65f6\u6700\u591a\u591a\u5305\u4e00\u5c42, \u4e0d\u5f71\u54cd\u6b63\u786e\u6027 */
      }
      window.fetch = hookedFetch;
      state.hooks.fetch = true;
    }
  } catch (error) {
    rememberError('Ошибка установки fetch-хука: ' + ((error && error.message) || error));
  }

  // ---------- XHR \u94a9\u5b50(\u515c\u5e95, \u4ec5\u5728\u7ad9\u70b9\u6539\u7528 XHR \u65f6\u751f\u6548)----------

  try {
    const XHR = window.XMLHttpRequest;
    // XHR \u8865\u4e01\u300c\u88c5\u4e00\u6b21\u5c31\u591f\u300d: \u5b83\u53ea\u8bb0\u5f55 URL\u3001\u5728 load \u65f6\u56de\u4f20\u5168\u6587, \u4e0e\u7ad9\u70b9\u534f\u8bae\u65e0\u5173, 
    // \u4e0a\u4e00\u4ee3\u88c5\u7684\u8865\u4e01\u7ee7\u7eed\u6709\u6548, \u91cd\u590d\u5305\u88c5\u53cd\u800c\u4f1a\u8ba9\u540c\u4e00\u4efd\u54cd\u5e94\u88ab\u4e0a\u62a5\u591a\u6b21\u3002
    if (XHR && XHR.prototype && typeof XHR.prototype.open === 'function' && !XHR.prototype.__dubridgeHooked) {
      const originalOpen = XHR.prototype.open;
      const originalSend = XHR.prototype.send;
      const urls = new WeakMap();

      XHR.prototype.open = function (method, url) {
        try {
          urls.set(this, typeof url === 'string' ? url : String(url));
        } catch (error) {
          /* ошибка записи URL не влияет на запрос */
        }
        return originalOpen.apply(this, arguments);
      };

      XHR.prototype.__dubridgeHooked = true;

      XHR.prototype.send = function () {
        let url = '';
        try {
          url = urls.get(this) || '';
        } catch (error) {
          url = '';
        }
        if (matches(url)) {
          const streamId = newStreamId('x');
          const xhr = this;
          send({ t: 'stream-start', streamId: streamId, url: url, at: Date.now() });
          state.stats.streams += 1;
          try {
            xhr.addEventListener('load', function () {
              try {
                const type = xhr.responseType;
                const text = type === '' || type === 'text' ? xhr.responseText : '';
                if (text) send({ t: 'stream-chunk', streamId: streamId, data: text });
                send({ t: 'stream-end', streamId: streamId });
              } catch (error) {
                send({ t: 'stream-error', streamId: streamId, message: String((error && error.message) || error) });
              }
            });
            xhr.addEventListener('error', function () {
              send({ t: 'stream-error', streamId: streamId, message: 'XHR-запрос не удался' });
            });
          } catch (error) {
            rememberError('перехват ошибки XHR: ' + ((error && error.message) || error));
          }
        }
        return originalSend.apply(this, arguments);
      };
      state.hooks.xhr = true;
    } else if (XHR && XHR.prototype && XHR.prototype.__dubridgeHooked) {
      // \u4e0a\u4e00\u4ee3\u5df2\u7ecf\u6253\u8fc7\u8865\u4e01: \u5982\u5b9e\u62a5\u544a\u4e3a\u5df2\u6302\u8f7d, \u5426\u5219\u8bca\u65ad\u4f1a\u8bef\u62a5\u300c\u4f20\u8f93\u5c42\u6ca1\u63a5\u4e0a\u300d
      state.hooks.xhr = true;
    }
  } catch (error) {
    rememberError('ошибка установки XHR-хука: ' + ((error && error.message) || error));
  }

  // ---------- \u8f93\u5165\u6846\u5b9a\u4f4d\u4e0e\u5199\u5165 ----------

  const COMPOSER_SELECTORS = [
    'textarea#chat-input',
    'textarea[placeholder]',
    'div[contenteditable="true"]',
    'textarea',
  ];

  const SEND_SELECTORS = [
    'button[type="submit"]',
    'button[aria-label*="\u53d1\u9001"]',
    'div[role="button"][aria-label*="\u53d1\u9001"]',
    'button[aria-label*="Send"]',
    'div[role="button"][aria-label*="Send"]',
    '[data-testid*="send"]',
  ];

  function isVisible(element) {
    if (!element) return false;
    try {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(element);
      return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
    } catch (error) {
      return false;
    }
  }

  function findComposer() {
    for (let i = 0; i < COMPOSER_SELECTORS.length; i += 1) {
      const selector = COMPOSER_SELECTORS[i];
      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch (error) {
        continue;
      }
      for (let j = 0; j < nodes.length; j += 1) {
        if (isVisible(nodes[j])) return nodes[j];
      }
    }
    return null;
  }

  function findSendButton(composer) {
    for (let i = 0; i < SEND_SELECTORS.length; i += 1) {
      const selector = SEND_SELECTORS[i];
      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch (error) {
        continue;
      }
      const usable = [];
      for (let j = 0; j < nodes.length; j += 1) {
        const node = nodes[j];
        if (!isVisible(node)) continue;
        if (node.disabled === true) continue;
        if (node.getAttribute && node.getAttribute('aria-disabled') === 'true') continue;
        usable.push(node);
      }
      if (usable.length > 0) return usable[usable.length - 1];
    }
    try {
      const form = composer && composer.closest ? composer.closest('form') : null;
      if (form) {
        const buttons = form.querySelectorAll('button:not([disabled])');
        for (let i = buttons.length - 1; i >= 0; i -= 1) {
          if (isVisible(buttons[i])) return buttons[i];
        }
      }
    } catch (error) {
      /* Резервный поиск по форме не удался; это можно игнорировать */
    }
    return null;
  }

  function readComposerText(element) {
    if (!element) return '';
    if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') return String(element.value || '');
    return String(element.textContent || '');
  }

  /**
   * \u8282\u70b9\u662f\u5426\u4ecd\u5728\u6587\u6863\u91cc\u3002
   *
   * \u9875\u9762\u91cd\u65b0\u6e32\u67d3\u65f6, \u65e7\u5f15\u7528\u4f1a\u53d8\u6210\u6e38\u79bb\u8282\u70b9: \u5f80\u91cc\u5199\u5185\u5bb9\u3001\u6d3e\u53d1\u56de\u8f66\u90fd\u4e0d\u4f1a\u5f71\u54cd\u9875\u9762, 
   * \u4f46\u8bfb\u56de\u6821\u9a8c\u7167\u6837\u901a\u8fc7\u2014\u2014\u4e8e\u662f\u300c\u5df2\u53d1\u9001\u300d\u662f\u5047\u7684, \u804a\u5929\u91cc\u5176\u5b9e\u4ec0\u4e48\u90fd\u6ca1\u6709\u3002
   */
  function isAttached(element) {
    try {
      return !!(element && element.isConnected);
    } catch (error) {
      return false;
    }
  }

  /**
   * \u8f93\u5165\u6846\u91cc\u7684\u5185\u5bb9\u662f\u5426\u6b63\u662f\u6211\u4eec\u81ea\u5df1\u521a\u5199\u8fdb\u53bb\u7684\u90a3\u4e00\u4efd\u3002
   *
   * \u573a\u666f: \u4e0a\u4e00\u6b21\u5199\u5165\u6210\u529f\u4f46\u63d0\u4ea4\u6ca1\u88ab\u7ad9\u70b9\u63a5\u53d7, \u5185\u5bb9\u7559\u5728\u6846\u91cc\u3002\u4e0b\u4e00\u8f6e\u56de\u586b\u770b\u5230\u7684\u300c\u975e\u7a7a\u8f93\u5165\u6846\u300d
   * \u5176\u5b9e\u662f\u81ea\u5df1\u7684\u6b8b\u7559, \u4e0d\u662f\u7528\u6237\u7684\u8349\u7a3f\u2014\u2014\u76f4\u63a5\u8865\u53d1\u5373\u53ef, \u4e0d\u5fc5\u5f39\u63d0\u793a\u8ba9\u4eba\u5de5\u70b9\u4e00\u6b21\u3002
   * \u5224\u636e\u523b\u610f\u6536\u5f97\u5f88\u7d27: \u9010\u5b57\u76f8\u540c\u4e14\u65f6\u95f4\u63a5\u8fd1\u3002\u7528\u6237\u6539\u8fc7\u4efb\u4f55\u4e00\u4e2a\u5b57\u7b26\u5c31\u5f53\u4f5c\u8349\u7a3f, \u7edd\u4e0d\u8986\u76d6\u3002
   */
  function isOwnResidue(text) {
    if (!text || !lastAttemptText) return false;
    if (text !== lastAttemptText) return false;
    return Date.now() - lastAttemptAt < 10 * 60 * 1000;
  }

  /**
   * \u5199\u5165\u540e\u8bfb\u56de\u4e0d\u4e00\u81f4\u65f6, \u628a\u300c\u54ea\u91cc\u4e0d\u4e00\u6837\u300d\u8bf4\u6e05\u695a\u3002
   *
   * \u53ea\u56de\u4e00\u53e5\u300c\u5199\u5165\u540e\u8bfb\u56de\u4e0d\u4e00\u81f4\u300d\u7b49\u4e8e\u4ec0\u4e48\u90fd\u6ca1\u8bf4: \u53ef\u80fd\u662f\u5b8c\u5168\u6ca1\u5199\u8fdb\u53bb\u3001\u53ef\u80fd\u662f\u88ab\u7ad9\u70b9\u622a\u65ad, 
   * \u4e5f\u53ef\u80fd\u53ea\u662f\u7f16\u8f91\u5668\u628a\u6362\u884c\u89c4\u8303\u5316\u6389\u4e86\u3002\u4e0a\u5c42\u62ff\u5230\u90a3\u79cd\u8be6\u60c5\u53ea\u80fd\u778e\u731c(\u5b9e\u6d4b\u4e3a\u6b64\u767d\u4e22\u8fc7\u4e00\u6574\u8f6e\u5de5\u5177\u7ed3\u679c), 
   * \u6240\u4ee5\u8fd9\u91cc\u7ed9\u51fa\u957f\u5ea6\u3001\u9996\u4e2a\u5dee\u5f02\u4f4d\u7f6e\u3001\u5dee\u5f02\u9644\u8fd1\u7247\u6bb5, \u4ee5\u53ca\u300c\u662f\u5426\u53ea\u5dee\u7a7a\u767d\u6216\u6362\u884c\u300d\u3002
   */
  function describeComposerMismatch(expected, actual) {
    const exp = String(expected);
    const act = String(actual);
    const limit = Math.min(exp.length, act.length);
    let at = -1;
    for (let i = 0; i < limit; i += 1) {
      if (exp.charAt(i) !== act.charAt(i)) {
        at = i;
        break;
      }
    }
    if (at === -1 && exp.length !== act.length) at = limit;

    const parts = ['ожидалось ' + exp.length + ' символов, фактически ' + act.length + ' символов'];
    if (at >= 0) parts.push('первое различие на позиции ' + (at + 1));

    let whitespaceOnly = false;
    try {
      whitespaceOnly = exp.replace(/\s+/g, '') === act.replace(/\s+/g, '');
    } catch (error) {
      whitespaceOnly = false;
    }
    parts.push(whitespaceOnly ? 'Различие только в пробелах или переводах строк' : 'Содержимое действительно различается');

    const focus = at >= 0 ? at : limit;
    const from = Math.max(0, focus - 20);
    parts.push(
      'ожидаемый фрагмент ' + JSON.stringify(exp.slice(from, focus + 20)) +
        ', фактический фрагмент ' + JSON.stringify(act.slice(from, focus + 20)),
    );
    return parts.join('; ');
  }

  // \u5199 contenteditable / textarea должны проходить через встроенный setter или встроенную команду ввода,
  // \u5426\u5219 React -компонент не получит изменение.
  function writeComposer(element, text) {
    const tag = element.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      const proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (!descriptor || typeof descriptor.set !== 'function') {
        return { ok: false, detail: 'Не найден встроенный value setter' };
      }
      try {
        element.focus();
      } catch (error) {
        /* \u805a\u7126\u5931\u8d25\u7ee7\u7eed\u5c1d\u8bd5\u5199\u5165 */
      }
      descriptor.set.call(element, text);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      const actual = String(element.value || '');
      return actual === text
        ? { ok: true, detail: '' }
        : { ok: false, detail: 'После записи прочитано не то же самое: ' + describeComposerMismatch(text, actual) };
    }

    try {
      element.focus();
    } catch (error) {
      /* \u805a\u7126\u5931\u8d25\u7ee7\u7eed\u5c1d\u8bd5\u5199\u5165 */
    }
    let inserted = false;
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
      inserted = document.execCommand('insertText', false, text);
    } catch (error) {
      inserted = false;
    }
    if (!inserted) {
      element.textContent = text;
      try {
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      } catch (error) {
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    // \u5bcc\u6587\u672c\u7f16\u8f91\u5668\u4f1a\u91cd\u6392\u7a7a\u767d\u4e0e\u6362\u884c, \u6bd4\u8f83\u524d\u7edf\u4e00\u53bb\u6389\u9996\u5c3e\u7a7a\u767d\uff1b
    // \u5dee\u5f02\u7ec6\u8282\u6309\u540c\u4e00\u53e3\u5f84\u7ed9\u51fa, \u907f\u514d\u628a\u300c\u9996\u5c3e\u591a\u4e00\u4e2a\u6362\u884c\u300d\u6e32\u67d3\u6210\u4e00\u6574\u6bb5\u5185\u5bb9\u4e0d\u7b26\u3002
    const expected = String(text).trim();
    const actual = readComposerText(element).trim();
    return actual === expected
      ? { ok: true, detail: '' }
      : { ok: false, detail: 'После записи прочитано не то же самое: ' + describeComposerMismatch(expected, actual) };
  }

  function pressEnter(element) {
    const options = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    try {
      element.dispatchEvent(new KeyboardEvent('keydown', options));
      element.dispatchEvent(new KeyboardEvent('keypress', options));
      element.dispatchEvent(new KeyboardEvent('keyup', options));
    } catch (error) {
      rememberError('Не удалось отправить Enter: ' + ((error && error.message) || error));
    }
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  /**
   * \u89e6\u53d1\u53d1\u9001\u5e76\u7b49\u8f93\u5165\u6846\u88ab\u6e05\u7a7a\u3002
   *
   * \u4f18\u5148\u70b9\u53d1\u9001\u6309\u94ae, \u627e\u4e0d\u5230\u6309\u94ae\u624d\u6a21\u62df\u56de\u8f66\uff1b\u4e24\u8005\u90fd\u6ca1\u80fd\u8ba9\u8f93\u5165\u6846\u6e05\u7a7a\u65f6, 
   * \u53ea\u5728\u6846\u91cc\u4ecd\u662f\u672c\u6b21\u8981\u53d1\u7684\u5185\u5bb9\u65f6\u8865\u4e00\u6b21\u56de\u8f66\u2014\u2014\u7edd\u4e0d\u9759\u9ed8\u91cd\u8bd5превышает\u4e00\u6b21, \u907f\u514d\u91cd\u590d\u53d1\u9001\u3002
   * \u8f93\u5165\u6846\u6574\u4e2a\u6d88\u5931(\u9875\u9762\u5728\u5bfc\u822a)\u540c\u6837\u7b97\u300c\u6ca1\u80fd\u786e\u8ba4\u53d1\u9001\u300d, \u5982\u5b9e\u56de\u62a5\u800c\u4e0d\u662f\u731c\u6210\u529f\u3002
   */
  async function submitAndWait(target, expectedText) {
    const button = findSendButton(target);
    if (button) {
      try {
        button.click();
      } catch (error) {
        rememberError('Не удалось нажать кнопку отправки: ' + ((error && error.message) || error));
      }
    } else {
      pressEnter(target);
    }

    for (let i = 0; i < 40; i += 1) {
      await delay(200);
      const current = findComposer();
      if (!current) break;
      if (readComposerText(current).trim().length === 0) {
        return { cleared: true, method: button ? 'click' : 'enter' };
      }
    }

    const retryTarget = findComposer();
    if (retryTarget && readComposerText(retryTarget).trim() === String(expectedText).trim()) {
      pressEnter(retryTarget);
      for (let i = 0; i < 15; i += 1) {
        await delay(200);
        const current = findComposer();
        if (!current) break;
        if (readComposerText(current).trim().length === 0) {
          return { cleared: true, method: 'enter-retry' };
        }
      }
    }

    return { cleared: false, method: button ? 'click' : 'enter' };
  }

  async function fillAndSend(payload) {
    const fillId = payload && payload.fillId ? String(payload.fillId) : 'unknown';
    const text = payload && typeof payload.text === 'string' ? payload.text : '';
    const shouldSubmit = !payload || payload.submit !== false;
    const waitMs = payload && typeof payload.waitMs === 'number' && payload.waitMs > 0 ? payload.waitMs : 0;
    const result = { t: 'fill-result', fillId: fillId, ok: false, stage: '', detail: '' };

    if (text.length === 0) {
      result.stage = 'empty';
      result.detail = 'текст для отправки пуст';
      return result;
    }

    let composer = findComposer();
    if (!composer) {
      result.stage = 'locate';
      result.detail = 'Не найдено видимое поле ввода чата';
      return result;
    }

    // \u8f93\u5165\u6846\u91cc\u53ef\u80fd\u6b63\u6709\u7528\u6237\u624b\u6253\u7684\u5185\u5bb9: \u975e\u7a7a\u65f6\u5148\u7b49\u5b83\u53d8\u7a7a, \u8d85\u65f6\u5219\u653e\u5f03\u672c\u6b21\u56de\u586b\u3002
    // \u8fd9\u6837\u65e2\u4e0d\u9759\u9ed8\u8986\u76d6\u7528\u6237\u8349\u7a3f, \u4e5f\u907f\u514d\u628a\u5de5\u5177\u7ed3\u679c\u548c\u7528\u6237\u6587\u5b57\u6df7\u5728\u4e00\u8d77\u53d1\u51fa\u53bb\u3002
    if (waitMs > 0) {
      const deadline = Date.now() + waitMs;
      while (composer && readComposerText(composer).trim().length > 0 && Date.now() < deadline) {
        await delay(100);
        composer = findComposer() || composer;
      }
      if (composer && readComposerText(composer).trim().length > 0) {
        const currentText = readComposerText(composer).trim();
        // \u6846\u91cc\u5982\u679c\u6b63\u662f\u81ea\u5df1\u4e0a\u4e00\u6b21\u8981\u53d1\u7684\u90a3\u4e00\u4efd(\u63d0\u4ea4\u6ca1\u88ab\u7ad9\u70b9\u63a5\u53d7\u7559\u4e0b\u7684\u6b8b\u7559), 
        // \u90a3\u4e0d\u662f\u7528\u6237\u8349\u7a3f: \u76f4\u63a5\u8865\u4e00\u6b21\u53d1\u9001, \u800c\u4e0d\u662f\u8ba9\u4eba\u5de5\u53bb\u70b9\u9875\u9762\u63d0\u793a\u3002
        if (isOwnResidue(currentText)) {
          reportLog('info', 'В поле ввода \u2014 то же самое, что не удалось отправить в прошлый раз; отправляем автоматически, без уведомления');
          const resent = await submitAndWait(composer, currentText);
          if (resent.cleared) {
            lastAttemptText = '';
            lastAttemptAt = 0;
            result.ok = true;
            result.stage = 'sent';
            result.detail = 'resend-residue';
            return result;
          }
          result.stage = 'occupied';
          result.detail = 'В поле ввода остался прошлый неотправленный текст; автоматическая повторная отправка не сработала, во избежание перезаписи возврат пропущен';
          return result;
        }
        result.stage = 'occupied';
        result.detail = 'В поле ввода уже есть текст (возможно, вы печатаете); во избежание перезаписи возврат пропущен';
        return result;
      }
    }

    // \u5199\u5165\u7684\u6bcf\u4e00\u6b65\u90fd\u91cd\u65b0\u786e\u8ba4\u8282\u70b9\u8fd8\u5728\u6587\u6863\u91cc: \u9875\u9762\u91cd\u65b0\u6e32\u67d3\u4f1a\u628a\u8f93\u5165\u6846\u6362\u6210\u65b0\u8282\u70b9, 
    // \u5bf9\u7740\u65e7\u8282\u70b9\u5199\u5165\u4e0d\u4f1a\u4f53\u73b0\u5728\u9875\u9762\u4e0a, \u8bfb\u56de\u6821\u9a8c\u5374\u4f1a\u901a\u8fc7\u3002
    let write = { ok: false, detail: '' };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!isAttached(composer)) composer = findComposer();
      if (!composer) {
        result.stage = 'locate';
        result.detail = 'Поле ввода исчезло со страницы во время записи (возможно, идёт перерисовка)';
        return result;
      }
      write = writeComposer(composer, text);
      if (write.ok && isAttached(composer)) break;
      if (write.ok) {
        write = { ok: false, detail: 'поле ввода было заменено страницей (узел открепился от документа); текст не появится в поле ввода' };
      }
      await delay(150);
      composer = findComposer() || composer;
    }
    if (!write.ok) {
      result.stage = 'write';
      result.detail = write.detail || 'Не удалось записать в поле ввода';
      return result;
    }

    if (!shouldSubmit) {
      result.ok = true;
      result.stage = 'written';
      return result;
    }

    // \u63d0\u4ea4\u524d\u518d\u786e\u8ba4\u4e00\u6b21: \u5f53\u524d\u53ef\u89c1\u7684\u8f93\u5165\u6846\u91cc\u786e\u5b9e\u662f\u6211\u4eec\u521a\u5199\u8fdb\u53bb\u7684\u5185\u5bb9\u3002
    // \u5c11\u4e86\u8fd9\u4e00\u6b65, \u300c\u56de\u8f66 \u2192 \u6846\u7a7a\u4e86\u300d\u4f1a\u628a\u300c\u6587\u672c\u843d\u5728\u88ab\u66ff\u6362\u7684\u65e7\u8282\u70b9\u4e0a\u300d\u8bef\u62a5\u6210\u53d1\u9001\u6210\u529f\u3002
    const visible = findComposer();
    if (!visible) {
      result.stage = 'locate';
      result.detail = 'Перед отправкой поле ввода исчезло со страницы (возможно, идёт перерисовка)';
      return result;
    }
    const expected = String(text).trim();
    const visibleText = readComposerText(visible).trim();
    if (visibleText !== expected) {
      result.stage = 'write';
      result.detail =
        'Содержимое видимого поля ввода перед отправкой не совпадает с только что записанным (возможно, страница перерисовалась); не отправлено: ' +
        describeComposerMismatch(expected, visibleText);
      return result;
    }
    composer = visible;

    // \u8bb0\u4e0b\u672c\u6b21\u8981\u53d1\u7684\u5185\u5bb9: \u4e0b\u4e00\u8f6e\u82e5\u53d1\u73b0\u8f93\u5165\u6846\u91cc\u6b63\u662f\u8fd9\u4e00\u4efd, \u8bf4\u660e\u4e0a\u6b21\u63d0\u4ea4\u6ca1\u88ab\u63a5\u53d7, 
    // \u90a3\u662f\u81ea\u5df1\u7684\u6b8b\u7559\u800c\u4e0d\u662f\u7528\u6237\u8349\u7a3f(\u89c1 isOwnResidue)\u3002
    lastAttemptText = expected;
    lastAttemptAt = Date.now();

    const outcome = await submitAndWait(composer, expected);
    if (outcome.cleared) {
      lastAttemptText = '';
      lastAttemptAt = 0;
      result.ok = true;
      result.stage = 'sent';
      result.detail = outcome.method;
      return result;
    }

    result.stage = 'submit';
    result.detail =
      outcome.method === 'click'
        ? 'После нажатия кнопки отправки поле ввода не очистилось \u2014 возможно, отправка не прошла'
        : 'После Enter поле ввода не очистилось \u2014 возможно, отправка не прошла';
    return result;
  }

  window.${AGENT_FILL_NAME} = function (payload) {
    fillAndSend(payload)
      .then(function (result) {
        send(result);
      })
      .catch(function (error) {
        send({
          t: 'fill-result',
          fillId: payload && payload.fillId ? String(payload.fillId) : 'unknown',
          ok: false,
          stage: 'exception',
          detail: String((error && error.message) || error),
        });
      });
    return true;
  };

  // ---------- \u7f51\u9875\u786e\u8ba4\u6846 ----------

  // \u547d\u4ee4\u6267\u884c\u7684\u786e\u8ba4\u5165\u53e3\u4ece\u300c\u670d\u52a1\u7ec8\u7aef\u300d\u6269\u5c55\u5230\u300c\u7f51\u9875\u5f39\u7a97\u300d: 
  // \u7f51\u9875\u4e0d\u53ef\u7528\u65f6\u7531 Node \u4fa7\u56de\u9000\u5230\u7ec8\u7aef\u786e\u8ba4, \u56e0\u6b64\u8fd9\u91cc\u53ea\u8d1f\u8d23\u663e\u793a\u4e0e\u56de\u62a5, \u4e0d\u505a\u4efb\u4f55\u88c1\u51b3\u3002
  const CONFIRM_WAITERS = {};
  let confirmSeq = 0;

  function dismissConfirm(id, allowed) {
    const waiter = CONFIRM_WAITERS[id];
    if (!waiter) return;
    delete CONFIRM_WAITERS[id];
    if (waiter.timer !== null) clearTimeout(waiter.timer);
    try {
      if (waiter.node && waiter.node.parentNode) waiter.node.parentNode.removeChild(waiter.node);
    } catch (error) {
      /* \u79fb\u9664\u5931\u8d25\u4e0d\u5f71\u54cd\u7ed3\u679c\u56de\u4f20 */
    }
    send({ t: 'confirm-result', confirmId: id, allowed: allowed === true });
  }

  function buildConfirmButton(label, primary, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.style.cssText =
      'cursor:pointer;border:0;border-radius:6px;padding:8px 18px;font-size:14px;' +
      (primary ? 'background:#4d6bfe;color:#fff;' : 'background:#eceff5;color:#333;');
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  function showConfirm(payload) {
    const id = payload && payload.confirmId ? String(payload.confirmId) : 'c' + (++confirmSeq);
    const command = payload && typeof payload.command === 'string' ? payload.command : '';
    const reason = payload && typeof payload.reason === 'string' ? payload.reason : '';
    const timeoutMs =
      payload && typeof payload.timeoutMs === 'number' && payload.timeoutMs > 0 ? payload.timeoutMs : 120000;

    // \u540c\u4e00 id Повторный запрос с тем же id: старый диалог закрывается отказом, чтобы не завис
    if (CONFIRM_WAITERS[id]) dismissConfirm(id, false);

    const overlay = document.createElement('div');
    overlay.setAttribute('data-dubridge-confirm', id);
    overlay.style.cssText =
      'position:fixed;z-index:2147483647;left:0;top:0;right:0;bottom:0;' +
      'background:rgba(15,20,35,0.45);display:flex;align-items:center;justify-content:center;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

    const card = document.createElement('div');
    card.style.cssText =
      'width:min(560px,92vw);max-height:80vh;overflow:auto;background:#fff;border-radius:10px;' +
      'padding:20px 22px;box-shadow:0 18px 50px rgba(0,0,0,0.28);color:#1a1a1a;';

    const title = document.createElement('div');
    title.textContent = 'dubridge Запрос на выполнение команды';
    title.style.cssText = 'font-size:16px;font-weight:600;margin-bottom:6px;';

    const hint = document.createElement('div');
    hint.textContent = 'Эта команда будет выполнена на вашем компьютере. Подтвердите, разрешено ли это.';
    hint.style.cssText = 'font-size:13px;color:#666;margin-bottom:12px;';

    const commandBox = document.createElement('pre');
    commandBox.textContent = command;
    commandBox.style.cssText =
      'margin:0 0 12px;padding:10px 12px;background:#f5f6fa;border-radius:6px;' +
      'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;white-space:pre-wrap;word-break:break-all;';

    const reasonBox = document.createElement('div');
    reasonBox.textContent = 'Причина: ' + reason;
    reasonBox.style.cssText = 'font-size:12px;color:#888;margin-bottom:16px;';

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;';
    actions.appendChild(buildConfirmButton('Отклонить', false, function () { dismissConfirm(id, false); }));
    actions.appendChild(buildConfirmButton('Разрешить', true, function () { dismissConfirm(id, true); }));

    card.appendChild(title);
    card.appendChild(hint);
    card.appendChild(commandBox);
    card.appendChild(reasonBox);
    card.appendChild(actions);
    overlay.appendChild(card);

    try {
      document.body.appendChild(overlay);
    } catch (error) {
      rememberError('Не удалось показать диалог подтверждения: ' + ((error && error.message) || error));
      send({ t: 'confirm-result', confirmId: id, allowed: false });
      return;
    }

    const timer = setTimeout(function () { dismissConfirm(id, false); }, timeoutMs);
    CONFIRM_WAITERS[id] = { node: overlay, timer: timer };
  }

  window.${AGENT_CONFIRM_NAME} = function (payload) {
    showConfirm(payload);
    return true;
  };

  // ---------- \u7edf\u8ba1\u9762\u677f ----------

  // \u53f3\u4e0a\u89d2\u5e38\u9a7b\u7684\u5c0f\u9762\u677f: \u663e\u793aСуммарный оборотcharCount\u3001\u5df2\u53d1\u6d88\u606f\u8f6e\u6570\u3001\u5de5\u5177\u8c03\u7528\u8f6e\u6570\u3002
  // \u523b\u610f\u6807\u6210\u300cСуммарный оборот\u300d\u800c\u975e\u300c\u4e0a\u4e0b\u6587\u300d: \u5b83\u53ea\u589e\u4e0d\u51cf, \u662f\u5386\u53f2\u7d2f\u8ba1\u91cf, 
  // \u4e0d\u53cd\u6620\u7ad9\u70b9\u5f53\u524d\u7a97\u53e3\u91cc\u8fd8\u5269\u591a\u5c11, \u6807\u6210\u300c\u4e0a\u4e0b\u6587\u300d\u4f1a\u88ab\u8bef\u8bfb\u6210\u7a97\u53e3\u5360\u7528\u3002
  // \u6570\u636e\u7531 Node \u4fa7\u7edf\u8ba1\u540e\u63a8\u9001, \u9875\u9762\u53ea\u8d1f\u8d23\u6e32\u67d3, \u4e0d\u81ea\u884c\u63a8\u65ad, \u907f\u514d\u4e24\u8fb9\u53e3\u5f84\u4e0d\u4e00\u81f4\u3002
  const STATS_ID = 'dubridge-stats-panel';

  function formatSize(chars) {
    const n = typeof chars === 'number' && chars > 0 ? chars : 0;
    if (n < 1000) return n + ' симв.';
    if (n < 1000000) return (n / 1000).toFixed(1) + 'K симв.';
    return (n / 1000000).toFixed(2) + 'M симв.';
  }

  function ensureStatsPanel() {
    let panel = document.getElementById(STATS_ID);
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = STATS_ID;
    panel.style.cssText =
      'position:fixed;z-index:2147483646;right:14px;top:14px;min-width:180px;' +
      'background:rgba(28,34,52,0.92);color:#e8ecf5;border-radius:10px;padding:10px 12px;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:12px;' +
      'line-height:1.7;box-shadow:0 8px 26px rgba(0,0,0,0.3);cursor:move;user-select:none;';

    const header = document.createElement('div');
    header.textContent = 'dubridge';
    header.style.cssText = 'font-weight:600;margin-bottom:4px;color:#8fa8ff;';

    const body = document.createElement('div');
    body.setAttribute('data-dubridge-stats-body', '1');

    // \u5de5\u5177\u6267\u884c\u72b6\u6001\u884c: \u9ed8\u8ba4\u9690\u85cf, \u5de5\u5177\u6267\u884c\u671f\u95f4\u663e\u793a\u65cb\u8f6c\u6273\u624b, \u7ed3\u675f\u540e\u9690\u85cf\u3002
    const busyRow = document.createElement('div');
    busyRow.setAttribute('data-dubridge-busy-row', '1');
    busyRow.style.cssText =
      'display:none;align-items:center;gap:6px;margin-top:6px;padding-top:6px;' +
      'border-top:1px solid rgba(255,255,255,0.14);color:#8fa8ff;';
    const busyIcon = document.createElement('span');
    busyIcon.textContent = '\u1f527';
    busyIcon.style.cssText =
      'display:inline-block;font-size:13px;animation:dubridge-wrench-spin 1.2s linear infinite;';
    const busyText = document.createElement('span');
    busyText.setAttribute('data-dubridge-busy-text', '1');
    busyRow.appendChild(busyIcon);
    busyRow.appendChild(busyText);

    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(busyRow);
    document.body.appendChild(panel);
    return panel;
  }

  function renderStatsPanel(stats) {
    const panel = ensureStatsPanel();
    const body = panel.querySelector('[data-dubridge-stats-body]');
    if (!body) return;
    const rows = [
      'Суммарный оборот \u2248 ' + formatSize(stats.contextChars),
      'Сообщений отправлено ' + (stats.sendRounds || 0) + ' раунд(ов)',
      'Вызовов инструментов ' + (stats.toolRounds || 0) + ' раунд(ов)',
    ];
    if (stats.toolCalls > stats.toolRounds) rows.push('Вызовов инструмента ' + stats.toolCalls + ' раз');
    if (stats.thinkingChars > 0) rows.push('из них размышления ' + formatSize(stats.thinkingChars));
    body.innerHTML = '';
    for (const row of rows) {
      const line = document.createElement('div');
      line.textContent = row;
      body.appendChild(line);
    }
  }

  window.${AGENT_STATS_NAME} = function (stats) {
    try {
      renderStatsPanel(stats || {});
      return true;
    } catch (error) {
      rememberError('Не удалось отрисовать панель статистики: ' + ((error && error.message) || error));
      return false;
    }
  };

  // ---------- \u5de5\u5177\u8c03\u7528\u72b6\u6001\u6307\u793a ----------

  // \u5de5\u5177\u6267\u884c\u671f\u95f4\u5728\u53f3\u4e0a\u89d2\u7edf\u8ba1\u9762\u677f\u91cc\u663e\u793a\u4e00\u884c\u65cb\u8f6c\u6273\u624b, \u6267\u884c\u7ed3\u675f\u5373\u9690\u85cf\u8be5\u884c\u3002
  // \u72b6\u6001\u884c\u968f\u9762\u677f\u521b\u5efa, \u9ed8\u8ba4\u9690\u85cf\uff1b\u53ea\u505a\u53ef\u89c6\u5316, \u4e0d\u5360\u4f4d\u3001\u4e0d\u5f71\u54cd\u7ad9\u70b9\u4ea4\u4e92\u3002
  const BUSY_STYLE_ID = 'dubridge-busy-style';

  function ensureBusyStyle() {
    if (document.getElementById(BUSY_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = BUSY_STYLE_ID;
    style.textContent =
      '@keyframes dubridge-wrench-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}';
    document.head.appendChild(style);
  }

  function hideBusy() {
    const row = document.querySelector('[data-dubridge-busy-row]');
    if (row) row.style.display = 'none';
  }

  function showBusy(label) {
    ensureBusyStyle();
    // \u9762\u677f\u662f\u61d2\u521b\u5efa\u7684: \u5de5\u5177\u53ef\u80fd\u5728\u9996\u6761\u7edf\u8ba1\u63a8\u9001\u4e4b\u524d\u5c31\u5f00\u59cb\u6267\u884c, \u8fd9\u91cc\u786e\u4fdd\u9762\u677f\u5df2\u5b58\u5728\u3002
    ensureStatsPanel();
    const row = document.querySelector('[data-dubridge-busy-row]');
    if (!row) return;
    row.style.display = 'flex';
    const text = row.querySelector('[data-dubridge-busy-text]');
    if (text) text.textContent = label || 'Выполняется инструмент\u2026';
  }

  window.${AGENT_BUSY_NAME} = function (payload) {
    try {
      const data = payload || {};
      if (data.busy === true) {
        showBusy(typeof data.label === 'string' ? data.label : '');
      } else {
        hideBusy();
      }
      return true;
    } catch (error) {
      rememberError('не удалось обновить состояние инструмента: ' + ((error && error.message) || error));
      return false;
    }
  };

  // ---------- \u975e\u906e\u6321\u63d0\u793a ----------

  // \u7528\u4e8e\u300c\u8f93\u5165\u6846\u88ab\u5360\u7528\u5bfc\u81f4\u56de\u586b\u88ab\u8df3\u8fc7\u300d\u8fd9\u7c7b\u9700\u8981\u7528\u6237\u5904\u7406\u7684\u60c5\u51b5: 
  // \u53ea\u5728\u89d2\u843d\u663e\u793a\u4e00\u6761\u5c0f\u63d0\u793a, \u4e0d\u94fa\u6ee1\u5c4f\u5e55\u3001\u4e0d\u963b\u65ad\u64cd\u4f5c\uff1b\u70b9\u51fb\u6309\u94ae\u628a\u52a8\u4f5c\u56de\u4f20\u7ed9 Node \u91cd\u8bd5\u3002
  const NOTICE_ID = 'dubridge-notice';
  let noticeSeq = 0;

  function ensureNotice() {
    let node = document.getElementById(NOTICE_ID);
    if (node) return node;
    node = document.createElement('div');
    node.id = NOTICE_ID;
    node.style.cssText =
      'position:fixed;z-index:2147483645;right:14px;bottom:14px;max-width:300px;' +
      'background:rgba(28,34,52,0.96);color:#e8ecf5;border-radius:10px;padding:12px 14px;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:12px;' +
      'line-height:1.6;box-shadow:0 8px 26px rgba(0,0,0,0.3);';
    document.body.appendChild(node);
    return node;
  }

  function buildNoticeButton(label, primary, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.style.cssText =
      'cursor:pointer;border:0;border-radius:6px;padding:6px 12px;font-size:12px;' +
      (primary ? 'background:#4d6bfe;color:#fff;' : 'background:#3a4258;color:#cfd6e6;');
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  function showNotice(payload) {
    const id = payload && payload.noticeId ? String(payload.noticeId) : 'n' + (++noticeSeq);
    const message = payload && typeof payload.message === 'string' ? payload.message : '';

    // \u6309\u94ae\u7ec4\u53ef\u7531\u8c03\u7528\u65b9\u81ea\u5b9a\u4e49(\u4f8b\u5982\u300cПерезаписать и отправить / \u53d6\u6d88\u300d\u7684\u4e8c\u6b21\u786e\u8ba4)\uff1b
    // \u4e0d\u4f20\u65f6\u9000\u56de\u9ed8\u8ba4\u7684\u300c\u5ffd\u7565 / \u91cd\u65b0\u53d1\u9001\u300d\u3002
    const specs =
      payload && Array.isArray(payload.actions) && payload.actions.length > 0
        ? payload.actions
        : [
            { id: 'dismiss', label: 'Пропустить', primary: false },
            { id: 'retry', label: 'Отправить снова', primary: true },
          ];

    const node = ensureNotice();
    node.setAttribute('data-dubridge-notice', id);
    node.innerHTML = '';

    const text = document.createElement('div');
    text.textContent = message;
    text.style.cssText = 'margin-bottom:10px;';

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';

    function removeNotice() {
      try {
        if (node.parentNode) node.parentNode.removeChild(node);
      } catch (error) {
        /* \u79fb\u9664\u5931\u8d25\u4e0d\u5f71\u54cd\u56de\u4f20 */
      }
    }

    for (let i = 0; i < specs.length; i += 1) {
      const spec = specs[i] || {};
      const actionId = String(spec.id || 'dismiss');
      const label = typeof spec.label === 'string' ? spec.label : actionId;
      actions.appendChild(
        buildNoticeButton(label, spec.primary === true, function () {
          removeNotice();
          send({ t: 'notice-action', noticeId: id, action: actionId });
        }),
      );
    }

    node.appendChild(text);
    node.appendChild(actions);
  }

  window.${AGENT_NOTICE_NAME} = function (payload) {
    try {
      showNotice(payload || {});
      return true;
    } catch (error) {
      rememberError('не удалось показать уведомление: ' + ((error && error.message) || error));
      return false;
    }
  };

  // ---------- \u8bca\u65ad ----------

  /**
   * \u5224\u65ad\u5f53\u524d\u662f\u5426\u8fd8\u5728\u300c\u7a7a\u5bf9\u8bdd\u300d\u91cc\u3002
   *
   * \u7ad9\u70b9\u5728\u4f1a\u8bdd\u5f00\u59cb\u540e\u4f1a\u628a URL \u53d8\u6210 /a/chat/s/<id>, \u9996\u9875\u5219\u662f /\u3002
   * \u7528\u300c\u5df2\u6e32\u67d3\u6d88\u606f\u8282\u70b9\u300d+\u300cURL \u5f62\u6001\u300d\u53cc\u91cd\u5224\u65ad, \u4efb\u4e00\u6307\u5411\u5df2\u6709\u4f1a\u8bdd\u5c31\u4e0d\u7b97\u7a7a\u3002
   * \u8fd9\u4e2a\u5224\u65ad\u51b3\u5b9a\u63d0\u793a\u8bcd\u80fd\u4e0d\u80fd\u88ab\u81ea\u52a8\u53d1\u9001\u2014\u2014\u5b81\u53ef\u6f0f\u53d1, \u4e5f\u4e0d\u80fd\u628a\u957f\u63d0\u793a\u8bcd\u63d2\u8fdb\u4f60\u6b63\u5728\u8fdb\u884c\u7684\u5bf9\u8bdd\u3002
   */
  function isFreshConversation() {
    try {
      const rendered = document.querySelectorAll('[data-message-id]');
      if (rendered.length > 0) {
        return { fresh: false, reason: 'на странице отрисовано сообщений: ' + rendered.length };
      }
    } catch (error) {
      /* \u9009\u62e9\u5668\u4e0d\u88ab\u652f\u6301\u65f6\u9000\u56de URL \u5224\u65ad */
    }

    const path = location.pathname.replace(/\/+$/, '');
    if (path === '' || path === '/') {
      return { fresh: true, reason: 'сейчас на главной, беседа ещё не начата' };
    }
    return { fresh: false, reason: 'текущий URL указывает на существующий диалог (' + location.pathname + ')' };
  }

  function describeCandidates() {
    const out = [];
    for (let i = 0; i < COMPOSER_SELECTORS.length; i += 1) {
      const selector = COMPOSER_SELECTORS[i];
      const entry = { selector: selector, total: 0, visible: 0, id: '', tag: '' };
      try {
        const nodes = document.querySelectorAll(selector);
        entry.total = nodes.length;
        for (let j = 0; j < nodes.length; j += 1) {
          if (isVisible(nodes[j])) entry.visible += 1;
        }
        if (nodes.length > 0) {
          entry.id = String(nodes[0].id || '');
          entry.tag = String(nodes[0].tagName || '');
        }
      } catch (error) {
        entry.total = -1;
      }
      out.push(entry);
    }
    return out;
  }

  function diagnose() {
    const composer = findComposer();
    return {
      version: VERSION,
      href: location.href,
      bindingAvailable: typeof window[BINDING] === 'function',
      hooks: { fetch: state.hooks.fetch, xhr: state.hooks.xhr, reinstalled: state.hooks.reinstalled },
      stats: {
        streams: state.stats.streams,
        messages: state.stats.messages,
        dropped: state.stats.dropped,
        queued: queue.length,
        lastError: state.stats.lastError,
      },
      errors: state.errors.slice(-5),
      composer: composer
        ? { found: true, tag: composer.tagName, id: composer.id || '', readonly: composer.readOnly === true }
        : { found: false, candidates: describeCandidates() },
      sendButton: findSendButton(composer) ? 'found' : 'missing',
      conversation: isFreshConversation(),
      apiPath: API_PATH,
    };
  }

  window.${AGENT_GLOBAL_NAME} = {
    version: VERSION,
    installedAt: state.installedAt,
    hooks: state.hooks,
    stats: function () {
      return {
        streams: state.stats.streams,
        messages: state.stats.messages,
        dropped: state.stats.dropped,
        queued: queue.length,
        lastError: state.stats.lastError,
      };
    },
    diagnose: diagnose,
    candidates: describeCandidates,
    isFreshConversation: isFreshConversation,
    flush: flush,
    readComposerText: function () {
      const composer = findComposer();
      return composer ? readComposerText(composer) : null;
    },
    notices: function () {
      const node = document.getElementById(NOTICE_ID);
      return node ? String(node.getAttribute('data-dubridge-notice') || '') : null;
    },
  };

  reportLog('info', 'dubridge Хук установлен (fetch=' + state.hooks.fetch + ', xhr=' + state.hooks.xhr + ')');
})();
`;
}

// src/cdp/inject.ts
var AGENT_MESSAGE_KINDS = /* @__PURE__ */ new Set([
  "stream-start",
  "stream-chunk",
  "stream-end",
  "stream-error",
  "fill-result",
  "confirm-result",
  "notice-action",
  "log"
]);
function isAgentMessage(value) {
  if (typeof value !== "object" || value === null) return false;
  const kind = value.t;
  return typeof kind === "string" && AGENT_MESSAGE_KINDS.has(kind);
}
function parseAgentPayload(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const record = parsed;
  if (record.t === "batch") {
    return Array.isArray(record.items) ? record.items.filter(isAgentMessage) : [];
  }
  return isAgentMessage(parsed) ? [parsed] : [];
}
async function installAgent(session, options, log) {
  const sessionId = session.requireSessionId();
  const source = buildAgentSource(options);
  const disposers = [];
  await session.send("Runtime.addBinding", { name: AGENT_BINDING_NAME });
  const onBinding = session.on("Runtime.bindingCalled", (event) => {
    const params = event.params;
    if (params.name !== AGENT_BINDING_NAME) return;
    const payload = params.payload;
    if (typeof payload !== "string") return;
    const messages = parseAgentPayload(payload);
    if (messages.length > 0) options.onMessages(messages);
  });
  disposers.push(onBinding);
  const registered = await session.send("Page.addScriptToEvaluateOnNewDocument", {
    source,
    runImmediately: true
  });
  log.debug("Регистрация межстраничного внедрения", { identifier: registered.identifier });
  disposers.push(() => {
    void session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: registered.identifier }, sessionId).catch(() => void 0);
  });
  try {
    await session.evaluate(source, { awaitPromise: false });
  } catch (error) {
    log.warn("Немедленное внедрение в текущий документ не удалось; хук активируется после следующего обновления", {
      message: error instanceof Error ? error.message : String(error)
    });
  }
  const version = await readAgentVersion(session).catch(() => null);
  if (version === null) {
    log.warn("Хук не сработал: объект внедрения не читается со страницы. Если страница только что обновлялась \u2014 повторите позже; если не помогает \u2014 запустите doctor и посмотрите кандидаты селекторов и структуру кадров");
  } else {
    log.info("Хук активен", { "версия": version });
  }
  return {
    dispose: () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
        }
      }
    }
  };
}
async function readAgentDiagnostics(session) {
  const value = await session.evaluate(
    `(function(){ var a = window[${JSON.stringify(AGENT_GLOBAL_NAME)}]; return a && typeof a.diagnose === 'function' ? a.diagnose() : null; })()`,
    { awaitPromise: false }
  );
  return typeof value === "object" && value !== null ? value : null;
}
async function readChatState(session) {
  const value = await session.evaluate(
    `(function(){ var a = window[${JSON.stringify(AGENT_GLOBAL_NAME)}]; if (!a || typeof a.isFreshConversation !== 'function') return null; return a.isFreshConversation(); })()`,
    { awaitPromise: false }
  );
  if (typeof value !== "object" || value === null) return null;
  const record = value;
  return {
    fresh: record.fresh === true,
    reason: typeof record.reason === "string" ? record.reason : "неизвестная причина"
  };
}
async function readAgentVersion(session) {
  const value = await session.evaluate(
    `(function(){ var a = window[${JSON.stringify(AGENT_GLOBAL_NAME)}]; return a ? a.version : null; })()`,
    { awaitPromise: false }
  );
  return typeof value === "string" ? value : null;
}

// src/loop/bootstrap.ts
import { existsSync, readFileSync, statSync } from "fs";
import path from "path";
import process2 from "process";
import { fileURLToPath } from "url";

// src/cdp/ready.ts
var DEFAULT_POLL_INTERVAL_MS = 500;
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
async function pollUntil(options) {
  const intervalMs = Math.max(1, options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, options.timeoutMs);
  let attempts = 0;
  let value = null;
  let lastError;
  for (; ; ) {
    attempts += 1;
    try {
      const probed = await options.probe();
      value = probed;
      lastError = void 0;
      if (options.done(probed)) {
        return { ok: true, value: probed, attempts, waitedMs: Date.now() - startedAt };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const result = { ok: false, value, attempts, waitedMs: Date.now() - startedAt };
      if (lastError !== void 0) result.lastError = lastError;
      return result;
    }
    options.onWait?.(attempts, value);
    await sleep(Math.min(intervalMs, remaining));
  }
}
async function probeHref(host) {
  const value = await host.evaluate("location.href", { awaitPromise: false });
  return typeof value === "string" && value.length > 0 ? value : null;
}
function isCommittedHref(href, targetPrefix) {
  if (typeof href !== "string" || href.length === 0) return false;
  if (href.startsWith("about:")) return false;
  return href.startsWith(targetPrefix);
}
function waitForDocument(host, targetPrefix, options) {
  return pollUntil({
    probe: () => probeHref(host),
    done: (href) => isCommittedHref(href, targetPrefix),
    timeoutMs: options.timeoutMs,
    ...options.intervalMs !== void 0 ? { intervalMs: options.intervalMs } : {},
    ...options.onWait !== void 0 ? { onWait: (attempt, value) => options.onWait?.(attempt, value) } : {}
  });
}
var READ_COMPOSER_EXPRESSION = "(function(){ var a = window[" + JSON.stringify(AGENT_GLOBAL_NAME) + "]; if (!a || typeof a.readComposerText !== 'function') return null; return a.readComposerText(); })()";
async function probeComposerText(host) {
  const value = await host.evaluate(READ_COMPOSER_EXPRESSION, { awaitPromise: false });
  return typeof value === "string" ? value : null;
}
function waitForComposer(host, options) {
  return pollUntil({
    probe: () => probeComposerText(host),
    done: (text) => text !== null,
    timeoutMs: options.timeoutMs,
    ...options.intervalMs !== void 0 ? { intervalMs: options.intervalMs } : {},
    ...options.onWait !== void 0 ? { onWait: (attempt, value) => options.onWait?.(attempt, value) } : {}
  });
}

// src/loop/bootstrap.ts
var DEFAULT_PAGE_READY_WAIT_MS = 2e4;
var BOOTSTRAP_POLL_INTERVAL_MS = 500;
var MAX_PROMPT_CHARS = 1e5;
var WARN_PROMPT_CHARS = 2e4;
var MAX_CONVENTIONS_CHARS = 2e4;
function extractPromptBody(text) {
  const lines = text.split("\n");
  const delimiters = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s*---\s*$/.test(line)) {
      delimiters.push(i);
      if (delimiters.length === 2) break;
    }
  }
  if (delimiters.length === 2) {
    const start = delimiters[0] + 1;
    const end = delimiters[1];
    const body = lines.slice(start, end).join("\n").trim();
    if (body.length > 0) return { body, strategy: "delimiters" };
  }
  return { body: text.trim(), strategy: "whole-file" };
}
function findPackageRoot() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(dir, "prompts"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
function resolvePromptPath(promptFilePath, cwd = process2.cwd()) {
  const local = path.resolve(cwd, promptFilePath);
  if (existsSync(local)) return local;
  const packageRoot = findPackageRoot();
  if (packageRoot !== null) {
    const bundled = path.resolve(packageRoot, promptFilePath);
    if (existsSync(bundled)) return bundled;
  }
  return local;
}
function loadPromptBody(promptFilePath, cwd = process2.cwd()) {
  const filePath = resolvePromptPath(promptFilePath, cwd);
  if (!existsSync(filePath)) {
    throw new Error(`Файл промпта не найден: ${filePath} (можно задать через DUB_PROMPT_FILE)`);
  }
  if (statSync(filePath).isDirectory()) {
    throw new Error(`Путь промпта — каталог, а не файл: ${filePath}`);
  }
  const raw = readFileSync(filePath, "utf8");
  const extracted = extractPromptBody(raw);
  if (extracted.body.length === 0) {
    throw new Error(`Содержимое файла промпта пусто: ${filePath}`);
  }
  if (extracted.body.length > MAX_PROMPT_CHARS) {
    throw new Error(
      `промпт превышает ${MAX_PROMPT_CHARS} символов (сейчас ${extracted.body.length}); проверьте, что файл выбран верно: ${filePath}`
    );
  }
  return { body: extracted.body, filePath, strategy: extracted.strategy };
}
function loadAgentConventions(agentFilePath, cwd = process2.cwd()) {
  if (agentFilePath.trim().length === 0) return null;
  const filePath = path.resolve(cwd, agentFilePath);
  if (!existsSync(filePath)) return null;
  if (statSync(filePath).isDirectory()) return null;
  const body = readFileSync(filePath, "utf8").trim();
  return body.length > 0 ? { body, filePath } : null;
}
function composePrompt(promptBody, conventions, label = "agent.md") {
  const trimmed = (conventions ?? "").trim();
  if (trimmed.length === 0) {
    return {
      body: promptBody,
      promptChars: promptBody.length,
      conventionsChars: 0,
      conventionsTruncated: false
    };
  }
  const conventionsTruncated = trimmed.length > MAX_CONVENTIONS_CHARS;
  const section = conventionsTruncated ? `${trimmed.slice(0, MAX_CONVENTIONS_CHARS)}

(... файл проектных соглашений превышает ${MAX_CONVENTIONS_CHARS} символов; обрезано здесь)` : trimmed;
  const body = [
    promptBody,
    "",
    "---",
    "",
    `## Проектные соглашения текущего workspace (из ${label})`,
    "",
    "Ниже — описание, которое ведёт сам проект: его структура, доступные команды и жёсткие ограничения. При конфликте с общими соглашениями выше приоритет у этого раздела.",
    "",
    section
  ].join("\n");
  return {
    body,
    promptChars: promptBody.length,
    conventionsChars: section.length,
    conventionsTruncated
  };
}
async function runBootstrap(options) {
  const { config, session, log, send, force } = options;
  const logger = log.child("bootstrap");
  let prompt;
  try {
    prompt = loadPromptBody(config.promptFilePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error("Ошибка загрузки промпта, автоотправка пропущена", { detail });
    return { status: "failed", detail };
  }
  logger.info("Промпт загружен", {
    "файл": config.promptFilePath,
    extractMethod: prompt.strategy === "delimiters" ? "взять текст между разделителями" : "весь файл",
    charCount: prompt.body.length
  });
  const conventions = loadAgentConventions(config.agentFilePath);
  const composed = composePrompt(
    prompt.body,
    conventions?.body ?? null,
    path.basename(config.agentFilePath) || "agent.md"
  );
  if (conventions) {
    logger.info("Проектные соглашения прикреплены", {
      "файл": config.agentFilePath,
      charCount: composed.conventionsChars,
      "обрезано": composed.conventionsTruncated
    });
  } else {
    logger.info("Файл проектных соглашений не найден, отправляется только общий промпт", { "ожидаемый путь": config.agentFilePath });
  }
  if (composed.body.length > WARN_PROMPT_CHARS) {
    logger.warn(`отправляемый текст длинный (${composed.body.length} символов); поле ввода сайта может обрезать или отклонить его`);
  }
  const payload = composed.body;
  const deps = { waitForComposer, readChatState, ...options.deps };
  const readyWaitMs = options.pageReadyWaitMs ?? DEFAULT_PAGE_READY_WAIT_MS;
  const ready = await deps.waitForComposer(session, {
    timeoutMs: readyWaitMs,
    intervalMs: options.pollIntervalMs ?? BOOTSTRAP_POLL_INTERVAL_MS,
    onWait: (attempt) => {
      if (attempt === 1 || attempt % 10 === 0) {
        logger.info("Ожидание готовности страницы\u2026\u2026", {
          attempt: attempt,
          "подсказка": "При холодном старте странице нужно несколько секунд, чтобы отрисовать поле ввода"
        });
      }
    }
  });
  if (!ready.ok) {
    const lastError = ready.lastError !== void 0 ? `(последняя проба не удалась: ${ready.lastError})` : "";
    const detail = `после ${Math.round(readyWaitMs / 1e3)} с не удалось найти поле ввода чата на странице${lastError}; автоотправка промпта пропущена. Убедитесь, что страница загружена и вход выполнен, либо перезапустите npm start позже`;
    logger.warn(detail);
    return { status: "unavailable", detail };
  }
  if (!force) {
    const state = await deps.readChatState(session).catch(() => null);
    if (state === null) {
      const detail = "Не удаётся прочитать состояние диалога (возможно, хук не активен); во избежание ошибочной отправки в существующий диалог \u2014 пропущено";
      logger.warn(detail);
      return { status: "unavailable", detail };
    }
    if (state.fresh !== true) {
      const detail = `${state.reason}. Для принудительной отправки используйте npm start -- --send-prompt`;
      logger.info("Диалог не пустой, автоотправка промпта пропущена", { Причина: state.reason });
      return { status: "not-fresh", detail };
    }
    logger.info("Обнаружен пустой диалог, готовим отправку промпта", { "основание": state.reason });
  } else {
    logger.info("--send-prompt указан: проверка пустого диалога пропущена, отправляем сразу");
  }
  options.beforeSend?.();
  const outcome = await send(payload);
  if (!outcome.ok) {
    const detail = `отправка не удалась (этап ${outcome.stage}): ${outcome.detail}`;
    logger.error(detail);
    return { status: "failed", detail, chars: payload.length };
  }
  logger.info("Промпт отправлен; следующий раунд пропустит выполнение инструментов (чтобы модель не скопировала из примера tool_call)", {
    charCount: payload.length,
    "способ отправки": outcome.detail
  });
  return { status: "sent", detail: "Промпт отправлен", chars: payload.length };
}

// src/protocol/schema.ts
import { z } from "zod";
var TOOL_NAMES = [
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "search",
  "run_command",
  "ssh_probe",
  "ssh_exec",
  "ssh_copy"
];
var TOOL_NAME_SET = new Set(TOOL_NAMES);
var relativePath = z.string().trim().min(1, "Путь не может быть пустым").describe("Путь относительно рабочей директории; принимаются и абсолютные пути, но они обязаны быть внутри рабочей директории");
var readFileArgsSchema = z.object({
  path: relativePath,
  offset: z.coerce.number().int().min(0).optional().describe("Начальный номер строки (с 1)"),
  limit: z.coerce.number().int().min(1).max(5e3).optional().describe("Максимум строк для чтения")
});
var writeFileArgsSchema = z.object({
  path: relativePath,
  content: z.string().describe("Полное содержимое файла"),
  create_dirs: z.boolean().optional().describe("Создавать родительскую директорию, если её нет; по умолчанию true")
});
var editChunkSchema = z.object({
  old_text: z.string().optional().describe("Заменяемый оригинал; должно совпадать посимвольно"),
  new_text: z.string().optional().describe("Содержимое замены"),
  oldText: z.string().optional().describe("old_text  \u2014 алиас"),
  newText: z.string().optional().describe("new_text  \u2014 алиас"),
  replace_all: z.boolean().optional().describe("Заменять все совпадения в этом блоке (по умолчанию \u2014 только первое)"),
  replaceAll: z.boolean().optional().describe("replace_all  \u2014 алиас")
});
var editFileArgsSchema = z.object({
  path: relativePath,
  old_text: z.string().optional().describe("Заменяемый оригинал (одиночный блок); альтернатива \u2014  edits , взаимоисключающе"),
  new_text: z.string().optional().describe("Содержимое замены (одиночный блок)"),
  replace_all: z.boolean().optional().describe("Заменять все совпадения (по умолчанию \u2014 только первое)"),
  edits: z.array(editChunkSchema).min(1, "edits не может быть пустым").optional().describe("Многочастная замена (альтернатива одиночной форме); все блоки сопоставляются с исходным файлом, блоки не должны пересекаться")
}).superRefine((value, ctx) => {
  const hasSingle = value.old_text !== void 0 || value.new_text !== void 0;
  if (hasSingle && value.edits !== void 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Одиночная форма (old_text/new_text) и многочастная (edits) не могут использоваться вместе"
    });
    return;
  }
  if (!hasSingle && value.edits === void 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "нужен old_text/new_text или edits" });
    return;
  }
  if (hasSingle) {
    if (value.old_text === void 0 || value.new_text === void 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "old_text и new_text должны быть заданы одновременно" });
    } else if (value.old_text.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "old_text не может быть пустым" });
    }
  }
});
function normalizeEditChunks(args) {
  if (args.edits !== void 0 && args.edits.length > 0) {
    return args.edits.map((chunk) => ({
      oldText: chunk.old_text ?? chunk.oldText ?? "",
      newText: chunk.new_text ?? chunk.newText ?? "",
      replaceAll: chunk.replace_all === true || chunk.replaceAll === true
    }));
  }
  return [
    {
      oldText: args.old_text ?? "",
      newText: args.new_text ?? "",
      replaceAll: args.replace_all === true
    }
  ];
}
var listDirArgsSchema = z.object({
  path: z.string().trim().default(".").describe("Путь к директории; по умолчанию \u2014 рабочая директория"),
  depth: z.coerce.number().int().min(1).max(4).optional().describe("Глубина рекурсии; по умолчанию 1")
});
var searchArgsSchema = z.object({
  query: z.string().min(1, "query не может быть пустым"),
  path: z.string().trim().optional().describe("Область поиска; по умолчанию \u2014 вся рабочая директория"),
  mode: z.enum(["content", "filename"]).optional().describe("content=по содержимому, filename=по имени файла"),
  glob: z.string().trim().optional().describe("Искать только файлы, чей путь совпадает с glob, например *.ts, src/**/*.ts (* не пересекает каталоги, ** пересекает)"),
  context: z.coerce.number().int().min(0).max(10).optional().describe("Сколько строк контекста до и после каждого совпадения; по умолчанию 0(только совпадение)"),
  max_results: z.coerce.number().int().min(1).max(200).optional().describe("Максимум совпадений"),
  case_sensitive: z.boolean().optional()
});
var runCommandArgsSchema = z.object({
  command: z.string().min(1, "command не может быть пустым"),
  cwd: z.string().trim().optional().describe("Рабочая директория команд; по умолчанию \u2014 рабочая директория"),
  timeout_ms: z.coerce.number().int().min(1e3).max(6e5).optional()
});
var rawCallSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  tool: z.string().optional(),
  tool_name: z.string().optional(),
  name: z.string().optional(),
  args: z.unknown().optional(),
  arguments: z.unknown().optional(),
  parameters: z.unknown().optional(),
  input: z.unknown().optional()
}).passthrough();
function coerceArgs(value) {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return {};
    }
    return {};
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value;
  }
  return {};
}
var toolCallEnvelopeSchema = z.union([
  z.object({ calls: z.array(rawCallSchema) }),
  z.array(rawCallSchema),
  rawCallSchema
]);
function normalizeToolCall(raw, index) {
  const name = raw.tool ?? raw.tool_name ?? raw.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    return { error: `в вызове №${index + 1} отсутствует имя инструмента (tool)` };
  }
  const tool = name.trim();
  if (!TOOL_NAME_SET.has(tool)) {
    return { error: `в вызове №${index + 1} использован неизвестный инструмент "${tool}"; доступные инструменты: ${TOOL_NAMES.join(", ")}` };
  }
  const merged = { ...raw.args ? coerceArgs(raw.args) : {} };
  const extra = raw.arguments ?? raw.parameters ?? raw.input;
  Object.assign(merged, coerceArgs(extra));
  const rawId = raw.id;
  const id = typeof rawId === "string" && rawId.trim().length > 0 ? rawId.trim() : typeof rawId === "number" ? String(rawId) : `call_${index + 1}`;
  return { call: { id, tool, args: merged } };
}

// src/protocol/toolCall.ts
var FENCE_RE = /```([^\n`]*)\r?\n([\s\S]*?)```/g;
var TAG_RE = /<tool_calls?>([\s\S]*?)<\/tool_calls?>/gi;
var ACCEPTED_INFO = /^(tool[_-]?calls?|dubridge|dubridge[_-]?calls?|function[_-]?calls?)$/i;
function repairJson(text) {
  const repaired = text.replace(/,(\s*[}\]])/g, "$1");
  return { text: repaired, repaired: repaired !== text };
}
function looksLikeToolCallShape(value, strict) {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) {
    return value.length > 0 && value.every((item) => looksLikeToolCallShape(item, strict));
  }
  const record = value;
  if (Array.isArray(record.calls)) return true;
  if (typeof record.tool === "string" || typeof record.tool_name === "string") return true;
  if (!strict && typeof record.name === "string") return true;
  return false;
}
function parseCandidate(raw, index, errors, skippedRef, strict) {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    errors.push(`блок candidateBlock №${index + 1} пуст`);
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (firstError) {
    const repaired = repairJson(trimmed);
    if (repaired.repaired) {
      try {
        parsed = JSON.parse(repaired.text);
        errors.push(`блок candidateBlock №${index + 1}: в JSON была лишняя запятая; исправлено автоматически`);
      } catch {
        errors.push(
          `блок candidateBlock №${index + 1}: не является корректным JSON: ${firstError instanceof Error ? firstError.message : String(firstError)}`
        );
        return [];
      }
    } else {
      errors.push(
        `блок candidateBlock №${index + 1}: не является корректным JSON: ${firstError instanceof Error ? firstError.message : String(firstError)}`
      );
      return [];
    }
  }
  if (!looksLikeToolCallShape(parsed, strict)) {
    skippedRef.count += 1;
    return [];
  }
  const envelope = toolCallEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    errors.push(`блок candidateBlock №${index + 1}: структура не соответствует формату вызова инструмента`);
    return [];
  }
  const data = envelope.data;
  let rawCalls;
  if (Array.isArray(data)) {
    rawCalls = data;
  } else if (typeof data === "object" && data !== null && Array.isArray(data.calls)) {
    rawCalls = data.calls;
  } else if (typeof data === "object" && data !== null) {
    rawCalls = [data];
  } else {
    errors.push(`блок candidateBlock №${index + 1}: не объект и не массив`);
    return [];
  }
  const calls = [];
  for (const [callIndex, item] of rawCalls.entries()) {
    const normalized = normalizeToolCall(item, callIndex);
    if (normalized.error) errors.push(normalized.error);
    if (normalized.call) calls.push(normalized.call);
  }
  return calls;
}
function stripSingleFence(text) {
  const match = /^```[^\n]*\r?\n([\s\S]*?)```$/.exec(text.trim());
  return match ? (match[1] ?? "").trim() : null;
}
function parseBareToolCall(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { calls: [], usedFallback: false };
  const candidate = stripSingleFence(trimmed) ?? trimmed;
  if (candidate.length === 0) return { calls: [], usedFallback: false };
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const repaired = repairJson(candidate);
    if (!repaired.repaired) return { calls: [], usedFallback: false };
    try {
      parsed = JSON.parse(repaired.text);
    } catch {
      return { calls: [], usedFallback: false };
    }
  }
  if (!looksLikeToolCallShape(parsed, true)) return { calls: [], usedFallback: false };
  const envelope = toolCallEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) return { calls: [], usedFallback: false };
  const record = parsed;
  let rawCalls;
  if (Array.isArray(parsed)) rawCalls = parsed;
  else if (Array.isArray(record.calls)) rawCalls = record.calls;
  else rawCalls = [parsed];
  const calls = [];
  for (const [index, item] of rawCalls.entries()) {
    const normalized = normalizeToolCall(item, index);
    if (normalized.error || !normalized.call) return { calls: [], usedFallback: false };
    calls.push(normalized.call);
  }
  return { calls, usedFallback: calls.length > 0 };
}
function looksLikeToolCallText(text) {
  const patterns = [
    { re: /"calls"\s*:/, reason: "найдено поле \"calls\"" },
    { re: /<tool_calls?>/, reason: "найден тег tool_call" },
    { re: /"tool_name"\s*:/, reason: "найдено поле \"tool_name\"" },
    { re: /"tool"\s*:/, reason: "найдено поле \"tool\"" },
    { re: /tool_call/, reason: "найдено слово \"tool_call\"" }
  ];
  for (const { re, reason } of patterns) {
    const match = re.exec(text);
    if (match) return { reason, index: match.index };
  }
  return null;
}
function parseToolCalls(text) {
  const errors = [];
  const calls = [];
  const skippedRef = { count: 0 };
  let blocks = 0;
  for (const match of text.matchAll(FENCE_RE)) {
    const info = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    const acceptedByInfo = ACCEPTED_INFO.test(info);
    const acceptedByShape = info.length === 0 || /^json$/i.test(info);
    if (!acceptedByInfo && !acceptedByShape) continue;
    const strict = !acceptedByInfo;
    if (strict) {
      const probe = body.trim();
      if (probe.length === 0) continue;
      let shapeOk = false;
      try {
        shapeOk = looksLikeToolCallShape(JSON.parse(repairJson(probe).text), true);
      } catch {
        shapeOk = false;
      }
      if (!shapeOk) continue;
    }
    blocks += 1;
    calls.push(...parseCandidate(body, blocks - 1, errors, skippedRef, strict));
  }
  for (const match of text.matchAll(TAG_RE)) {
    blocks += 1;
    calls.push(...parseCandidate(match[1] ?? "", blocks - 1, errors, skippedRef, false));
  }
  let bareFallback = false;
  if (calls.length === 0 && blocks === 0) {
    const bare = parseBareToolCall(text);
    if (bare.usedFallback) {
      calls.push(...bare.calls);
      bareFallback = true;
    }
  }
  return {
    calls,
    diagnostics: { blocks, errors, skipped: skippedRef.count, bareFallback }
  };
}
function callSignature(call) {
  return `${call.tool}:${stableStringify(call.args)}`;
}
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(",")}}`;
}

// src/protocol/toolResult.ts
function okResult(id, tool, data, meta = {}, structured) {
  const result = { id, tool, ok: true, data };
  if (Object.keys(meta).length > 0) result.meta = meta;
  if (structured && Object.keys(structured).length > 0) result.structured = structured;
  return result;
}
function failResult(id, tool, code, message, meta = {}) {
  const result = { id, tool, ok: false, error: { code, message } };
  if (Object.keys(meta).length > 0) result.meta = meta;
  return result;
}
function describeStatus(result) {
  if (!result.ok) return "Ошибка";
  const exitCode = result.meta?.exitCode;
  if (exitCode === void 0 || exitCode === 0) return "Успех";
  if (exitCode === null) return "Команда завершилась ненормально (прервана сигналом или не запустилась)";
  return `Команда завершилась с ошибкой (код возврата ${exitCode})`;
}
function describeMeta(result) {
  const parts = [];
  if (typeof result.meta?.durationMs === "number") parts.push(`${result.meta.durationMs}ms`);
  if (result.meta?.truncated) {
    parts.push(result.meta.truncateDirection === "tail" ? "обрезано (сохранён конец)" : "обрезано");
  }
  if (typeof result.meta?.bytes === "number" && result.meta.bytes > 0) {
    parts.push(result.meta.bytes >= 1024 ? `${(result.meta.bytes / 1024).toFixed(1)}KB` : `${result.meta.bytes}B`);
  }
  return parts.length > 0 ? `(${parts.join(", ")})` : "";
}
var TOOL_RESULT_HEADER = "[Результат локального инструмента · dubridge]";
var BACKFILL_FOOTER = "Эти результаты получены реальным выполнением локальной программы. Продолжайте на их основе; если нужны ещё операции \u2014 выводите блок tool_call, иначе дайте итоговый ответ.";
function formatToolResults(results, options = {}) {
  const maxChars = options.maxCharsPerResult ?? 16e3;
  const lines = [TOOL_RESULT_HEADER, ""];
  results.forEach((result, index) => {
    const status = describeStatus(result);
    const head = result.ok ? `[${index + 1}] ${result.tool} \u2014 ${status}${describeMeta(result)}` : `[${index + 1}] ${result.tool} \u2014 ${status}(${result.error?.code ?? "ERROR"})${describeMeta(result)}`;
    if (result.ok) {
      lines.push(head);
      const data = result.data ?? "";
      const body = data.length <= maxChars ? data : result.meta?.truncateDirection === "tail" ? `\u2026(содержимое слишком длинное, оставлен только конец — ${maxChars} символов)
${data.slice(data.length - maxChars)}` : `${data.slice(0, maxChars)}
\u2026(содержимое слишком длинное, обрезано)`;
      lines.push("```text");
      lines.push(body);
      lines.push("```", "");
    } else {
      lines.push(`${head}: ${result.error?.message ?? "неизвестная ошибка"}`, "");
    }
  });
  if (options.includeFooter !== false) {
    lines.push(BACKFILL_FOOTER);
  }
  return lines.join("\n");
}
function formatParseFailures(errors) {
  return [
    TOOL_RESULT_HEADER,
    "",
    "В этот раз не удалось разобрать ни одного исполнимого вызова инструмента. Причины:",
    ...errors.map((message) => `- ${message}`),
    "",
    "Проверьте JSON блока tool_call и имя инструмента и выведите заново. Доступные инструменты и форматы параметров \u2014 в системном промпте."
  ].join("\n");
}

// src/safety/paths.ts
import { closeSync, existsSync as existsSync2, openSync, readSync, realpathSync, statSync as statSync2 } from "fs";
import path2 from "path";

// src/safety/encoding.ts
var UTF8_BOM = Buffer.from([239, 187, 191]);
var UTF16LE_BOM = Buffer.from([255, 254]);
var UTF16BE_BOM = Buffer.from([254, 255]);
var UTF8_REPLACEMENT = "\ufffd";
var gb18030Support;
function supportsGb18030() {
  if (gb18030Support === void 0) {
    try {
      void new TextDecoder("gb18030");
      gb18030Support = true;
    } catch {
      gb18030Support = false;
    }
  }
  return gb18030Support;
}
function startsWith(buffer, prefix) {
  return buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix);
}
function hasUtf16Bom(buffer) {
  return startsWith(buffer, UTF16LE_BOM) || startsWith(buffer, UTF16BE_BOM);
}
function stripLeadingBom(text) {
  return text.startsWith("\ufeff") ? text.slice(1) : text;
}
function strictDecode(buffer, label, truncated) {
  const attempts = truncated ? [0, 1, 2, 3] : [0];
  for (const drop of attempts) {
    const slice = drop === 0 ? buffer : buffer.subarray(0, Math.max(0, buffer.length - drop));
    if (slice.length === 0) return "";
    try {
      return new TextDecoder(label, { fatal: true }).decode(slice);
    } catch {
    }
  }
  return null;
}
function looksLikeChineseText(text) {
  if (text.length === 0) return true;
  if (text.includes(UTF8_REPLACEMENT)) return false;
  if (/[ --]/.test(text)) return false;
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(text);
}
function decodeText(buffer, truncated = false) {
  if (startsWith(buffer, UTF16LE_BOM)) {
    const text = stripLeadingBom(new TextDecoder("utf-16le").decode(buffer.subarray(UTF16LE_BOM.length)));
    return { text, encoding: "utf16le", label: "UTF-16 LE", utf8Family: false };
  }
  if (startsWith(buffer, UTF16BE_BOM)) {
    const text = stripLeadingBom(new TextDecoder("utf-16be").decode(buffer.subarray(UTF16BE_BOM.length)));
    return { text, encoding: "utf16be", label: "UTF-16 BE", utf8Family: false };
  }
  if (startsWith(buffer, UTF8_BOM)) {
    return { text: buffer.toString("utf8"), encoding: "utf8-bom", label: "UTF-8(содержит BOM)", utf8Family: true };
  }
  const utf8 = strictDecode(buffer, "utf-8", truncated);
  if (utf8 !== null) return { text: utf8, encoding: "utf8", label: "UTF-8", utf8Family: true };
  if (supportsGb18030()) {
    const gb = strictDecode(buffer, "gb18030", truncated);
    if (gb !== null && looksLikeChineseText(gb)) {
      return { text: gb, encoding: "gb18030", label: "GB18030", utf8Family: false };
    }
  }
  return null;
}

// src/safety/paths.ts
var SandboxViolationError = class extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
  code;
  name = "SandboxViolationError";
};
var IS_WINDOWS = process.platform === "win32";
function normalizeForCompare(value) {
  const normalized = path2.normalize(value);
  return IS_WINDOWS ? normalized.toLowerCase() : normalized;
}
function isInside(root, target) {
  const normalizedRoot = normalizeForCompare(root);
  const normalizedTarget = normalizeForCompare(target);
  if (normalizedTarget === normalizedRoot) return true;
  const relative = path2.relative(normalizedRoot, normalizedTarget);
  if (relative.length === 0) return true;
  if (path2.isAbsolute(relative)) return false;
  return !relative.startsWith("..");
}
function nearestExistingAncestor(target) {
  let current = target;
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync2(current)) return current;
    const parent = path2.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}
function hasWindowsStreamSyntax(target) {
  if (!IS_WINDOWS) return false;
  const withoutDrive = target.replace(/^[a-zA-Z]:/, "");
  return withoutDrive.includes(":");
}
function normalizeInputPath(input) {
  const withoutInvisible = input.replace(/[\u200b-\u200d\u2060\ufeff]/g, "");
  const trimmed = withoutInvisible.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if (first === last && (first === "`" || first === '"' || first === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}
function stripMentionPrefix(input) {
  const normalized = normalizeInputPath(input);
  if (!normalized.startsWith("@")) return null;
  const stripped = normalized.slice(1).trim();
  return stripped.length > 0 ? stripped : null;
}
var PathGuard = class {
  constructor(root, options = {}) {
    this.options = options;
    this.root = path2.resolve(root);
  }
  options;
  root;
  cachedRealRoot;
  /**
   * \u628a\u7528\u6237/AI \u7ed9\u51fa\u7684\u8def\u5f84\u89e3\u6790\u6210workspace\u5185\u7684\u7edd\u5bf9\u8def\u5f84\uff1b\u8d8a\u6743\u76f4\u63a5\u629b\u9519\u3002
   */
  resolve(input) {
    const raw = normalizeInputPath(input);
    if (raw.length === 0) {
      throw new SandboxViolationError("Путь пуст", "NOT_FOUND");
    }
    if (hasWindowsStreamSyntax(path2.resolve(this.root, raw))) {
      throw new SandboxViolationError(`Отказано в доступе NTFS Alternate Data Stream: ${raw}`, "STREAM_PATH_DENIED");
    }
    if (path2.isAbsolute(raw) && this.options.allowAbsolute === false) {
      throw new SandboxViolationError(`Абсолютные пути не разрешены: ${raw}`, "ABSOLUTE_PATH_DENIED");
    }
    const resolved = path2.resolve(this.root, raw);
    if (!isInside(this.root, resolved)) {
      throw new SandboxViolationError(
        `Нарушение границ пути: ${raw} вне рабочей директории ${this.root}`,
        "OUT_OF_WORKSPACE"
      );
    }
    const ancestor = nearestExistingAncestor(resolved);
    let realAncestor;
    try {
      realAncestor = realpathSync(ancestor);
    } catch {
      realAncestor = ancestor;
    }
    const realRoot = this.realRoot();
    if (!isInside(realRoot, realAncestor)) {
      throw new SandboxViolationError(
        `Нарушение границ пути: ${raw} указывает через симлинк за пределы рабочей директории (${realAncestor})`,
        "OUT_OF_WORKSPACE"
      );
    }
    return resolved;
  }
  /** workspace\u7684 realpath(\u7528\u4e8e\u6bd4\u5bf9\u7b26\u53f7\u94fe\u63a5)\u3002 */
  realRoot() {
    if (this.cachedRealRoot) return this.cachedRealRoot;
    try {
      this.cachedRealRoot = realpathSync(this.root);
    } catch {
      this.cachedRealRoot = this.root;
    }
    return this.cachedRealRoot;
  }
  /** \u89e3\u6790\u5e76\u8981\u6c42\u76ee\u6807\u662f\u4e00\u4e2a\u5df2\u5b58\u5728\u7684\u6587\u4ef6\u3002 */
  resolveFile(input) {
    return this.resolveExisting(input, "file");
  }
  /** \u89e3\u6790\u5e76\u8981\u6c42\u76ee\u6807\u662f\u4e00\u4e2a\u5df2\u5b58\u5728\u7684\u76ee\u5f55\u3002 */
  resolveDirectory(input) {
    return this.resolveExisting(input, "directory");
  }
  /**
   * \u89e3\u6790\u5e76\u8981\u6c42\u76ee\u6807\u5df2\u5b58\u5728\u3002
   *
   * \u5b57\u9762\u8def\u5f84\u4e0d\u5b58\u5728\u65f6, \u989d\u5916\u5c1d\u8bd5\u4e00\u6b21\u300c\u53bb\u6389 IDE \u63d0\u53ca\u5199\u6cd5 `@` \u524d\u7f00\u300d\u7684\u8def\u5f84\u3002
   * \u53ea\u5728\u5b57\u9762\u4e0d\u5b58\u5728\u65f6\u624d\u56de\u9000, \u56e0\u6b64\u771f\u6b63\u7684 `@scope` \u76ee\u5f55(\u5982 `@types/node`)\u4e0d\u4f1a\u88ab\u8bef\u5265: 
   * \u5b83\u5b57\u9762\u5c31\u5b58\u5728, \u7b2c\u4e00\u8f6e\u5c31\u547d\u4e2d\u4e86\u3002
   */
  resolveExisting(input, expected) {
    const candidates = [input];
    const stripped = stripMentionPrefix(input);
    if (stripped !== null) candidates.push(stripped);
    const label = expected === "file" ? "файл" : "каталог";
    for (const candidate of candidates) {
      const resolved = this.resolve(candidate);
      let stat;
      try {
        stat = statSync2(resolved);
      } catch {
        continue;
      }
      if (expected === "directory") {
        if (!stat.isDirectory()) {
          throw new SandboxViolationError(`Цель не является директорией: ${candidate}`, "NOT_A_DIRECTORY");
        }
      } else if (stat.isDirectory()) {
        throw new SandboxViolationError(`Цель \u2014 директория, а не файл: ${candidate}`, "NOT_A_FILE");
      } else if (!stat.isFile()) {
        throw new SandboxViolationError(`Цель не является обычным файлом: ${candidate}`, "NOT_A_FILE");
      }
      return resolved;
    }
    throw new SandboxViolationError(`${label}не существует: ${input}`, "NOT_FOUND");
  }
  /** \u76f8\u5bf9workspace\u7684\u53ef\u8bfb\u8def\u5f84(\u7528\u4e8e\u56de\u62a5\u7ed9 AI)\u3002 */
  relative(absolutePath) {
    const relative = path2.relative(this.root, absolutePath);
    if (relative.length === 0) return ".";
    return relative.split(path2.sep).join("/");
  }
};
var BINARY_SNIFF_BYTES = 8e3;
function looksBinary(buffer) {
  if (buffer.length === 0) return false;
  const starts = [0];
  if (buffer.length > BINARY_SNIFF_BYTES * 2) {
    starts.push(Math.floor((buffer.length - BINARY_SNIFF_BYTES) / 2));
  }
  if (buffer.length > BINARY_SNIFF_BYTES) {
    starts.push(buffer.length - BINARY_SNIFF_BYTES);
  }
  for (const start of starts) {
    const end = Math.min(buffer.length, start + BINARY_SNIFF_BYTES);
    for (let i = start; i < end; i += 1) {
      if (buffer[i] === 0) return true;
    }
  }
  return false;
}
function readPrefix(absolutePath, fileBytes, maxBytes) {
  const readSize = Math.max(0, Math.min(fileBytes, maxBytes));
  const buffer = Buffer.alloc(readSize);
  if (readSize === 0) return buffer;
  const fd = openSync(absolutePath, "r");
  try {
    let offset = 0;
    while (offset < readSize) {
      const read = readSync(fd, buffer, offset, readSize - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
  } finally {
    closeSync(fd);
  }
  return buffer;
}
function readTextFileLimited(absolutePath, maxBytes) {
  const stat = statSync2(absolutePath);
  const bytes = stat.size;
  const truncated = bytes > maxBytes;
  const buffer = readPrefix(absolutePath, bytes, maxBytes);
  if (!hasUtf16Bom(buffer) && looksBinary(buffer)) {
    throw new SandboxViolationError(`файл похож на двоичный (содержит NUL-байт); чтение как текста отклонено: ${absolutePath}`, "BINARY_FILE");
  }
  const decoded = decodeText(buffer, truncated);
  if (!decoded) {
    throw new SandboxViolationError(
      `Файл не является ни валидным UTF-8, ни распознаваемым GB18030 -текст (возможно, другая кодировка или бинарный): ${absolutePath}`,
      "BINARY_FILE"
    );
  }
  let text = decoded.text;
  if (truncated && text.endsWith("\ufffd")) text = text.slice(0, -1);
  return {
    text,
    bytes,
    truncated,
    encoding: decoded.encoding,
    encodingLabel: decoded.label,
    utf8Family: decoded.utf8Family
  };
}
var ENCODING_PROBE_BYTES = 64 * 1024;
function probeFileEncoding(absolutePath, maxBytes = ENCODING_PROBE_BYTES) {
  const stat = statSync2(absolutePath);
  if (stat.size === 0) return { encoding: "utf8", label: "UTF-8", utf8Family: true };
  const buffer = readPrefix(absolutePath, stat.size, maxBytes);
  if (!hasUtf16Bom(buffer) && looksBinary(buffer)) return null;
  const decoded = decodeText(buffer, stat.size > buffer.length);
  if (!decoded) return null;
  return { encoding: decoded.encoding, label: decoded.label, utf8Family: decoded.utf8Family };
}

// src/stream/jsonPatch.ts
var SUPPORTED_OPS = /* @__PURE__ */ new Set(["SET", "APPEND", "DELETE", "INSERT", "BATCH"]);
var RESERVED_KEYS = /* @__PURE__ */ new Set(["p", "o", "v", "path", "op", "operation", "value"]);
var SCALAR_KEY_PATTERNS = [
  /status$/i,
  // status / quasi_status / message_status / MessageStatus
  /(^|_)id$/i,
  // id / message_id / parent_id / chat_session_id
  /_at$/i,
  // created_at / updated_at
  /_enabled$/i,
  // thinking_enabled / search_enabled
  /^type$/i,
  /^role$/i,
  /^action$/i,
  /^state$/i
];
function isScalarKey(key) {
  return SCALAR_KEY_PATTERNS.some((pattern) => pattern.test(key));
}
function unescapeToken(token) {
  let value = token.replace(/~1/g, "/").replace(/~0/g, "~");
  if (value.includes("%")) {
    try {
      value = decodeURIComponent(value);
    } catch {
    }
  }
  return value;
}
function parsePointer(pointer) {
  const trimmed = pointer.startsWith("/") ? pointer.slice(1) : pointer;
  if (trimmed.length === 0) return [];
  return trimmed.split("/").map(unescapeToken);
}
function isIndexToken(token) {
  return token === "-" || /^-?\d+$/.test(token);
}
function toIndex(token, length) {
  if (token === "-") return length;
  if (!/^-?\d+$/.test(token)) return null;
  const raw = Number.parseInt(token, 10);
  if (raw < 0) {
    const resolved = length + raw;
    return resolved >= 0 ? resolved : null;
  }
  return raw;
}
function isContainer(value) {
  return typeof value === "object" && value !== null;
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function locate(root, tokens) {
  if (tokens.length === 0) return null;
  let current = root;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (!isContainer(current)) return null;
    const token = tokens[i];
    if (Array.isArray(current)) {
      const index = toIndex(token, current.length);
      if (index === null) return null;
      current = current[index];
    } else {
      if (!(token in current)) return null;
      current = current[token];
    }
  }
  if (!isContainer(current)) return null;
  const key = tokens[tokens.length - 1];
  if (Array.isArray(current)) {
    const index = toIndex(key, current.length);
    if (index === null) return null;
    return { container: current, key, index };
  }
  return { container: current, key, index: null };
}
function buildPath(tokens, value, hasValue) {
  const [head, ...rest] = tokens;
  const leaf = rest.length === 0 ? hasValue ? value : null : buildPath(rest, value, hasValue);
  if (isIndexToken(head)) {
    return [leaf];
  }
  const record = {};
  record[head] = leaf;
  return record;
}
function readAt(location) {
  if (location.index === null) {
    return location.container[location.key];
  }
  return location.container[location.index];
}
function writeAt(location, value) {
  if (location.index === null) {
    location.container[location.key] = value;
    return;
  }
  const array = location.container;
  if (location.index >= array.length) array.push(value);
  else array[location.index] = value;
}
function deleteAt(location) {
  if (location.index === null) {
    const record = location.container;
    if (!(location.key in record)) return false;
    return delete record[location.key];
  }
  const array = location.container;
  if (location.index >= array.length) return false;
  array.splice(location.index, 1);
  return true;
}
function readFrameFields(frame) {
  const record = frame;
  const pointerRaw = record.p ?? record.path;
  const opRaw = record.o ?? record.op ?? record.operation;
  const hasValue = "v" in record || "value" in record;
  const value = "v" in record ? record.v : record.value;
  const extraKeys = Object.keys(record).filter((key) => !RESERVED_KEYS.has(key));
  const fields = { hasValue, value, extraKeys };
  if (typeof pointerRaw === "string" && pointerRaw.length > 0) fields.pointer = pointerRaw;
  if (typeof opRaw === "string" && opRaw.trim().length > 0) fields.op = opRaw.trim().toUpperCase();
  return fields;
}
var DEFAULT_CONTENT_PATH = "response/fragments/-1/content";
var PROTECTED_MERGE_KEYS = /* @__PURE__ */ new Set(["response", "fragments"]);
var JsonPatchDocument = class {
  root = void 0;
  warnings = [];
  warningSet = /* @__PURE__ */ new Set();
  appliedCount = 0;
  skippedCount = 0;
  inferredCount = 0;
  mergedCount = 0;
  contentPath;
  /** \u5168\u91cf\u72b6\u6001\u5e27\u5230\u8fbe\u4e4b\u524d\u6536\u5230\u7684\u5b57\u6bb5\u5408\u5e76\u5e27, \u5148\u5b58\u8fd9\u91cc\u3002 */
  pendingMerge = null;
  constructor(options = {}) {
    this.contentPath = options.contentPath ?? DEFAULT_CONTENT_PATH;
  }
  get value() {
    return this.root;
  }
  get warningsList() {
    return this.warnings;
  }
  get initialized() {
    return this.root !== void 0;
  }
  stats() {
    const stats = {
      applied: this.appliedCount,
      skipped: this.skippedCount,
      inferred: this.inferredCount,
      merged: this.mergedCount
    };
    const last = this.warnings[this.warnings.length - 1];
    if (last !== void 0) stats.lastWarning = last;
    return stats;
  }
  reset() {
    this.root = void 0;
    this.warnings.length = 0;
    this.warningSet.clear();
    this.appliedCount = 0;
    this.skippedCount = 0;
    this.inferredCount = 0;
    this.mergedCount = 0;
    this.pendingMerge = null;
  }
  warn(message) {
    this.note(message);
    this.skippedCount += 1;
    return { applied: false, warning: message };
  }
  /** \u8bb0\u5f55\u4e00\u6761\u544a\u8b66(\u53bb\u91cd), \u4e0d\u8ba1\u5165 skip\u3002 */
  note(message) {
    if (this.warningSet.has(message)) return;
    this.warningSet.add(message);
    this.warnings.push(message);
  }
  applied() {
    this.appliedCount += 1;
    return { applied: true };
  }
  apply(frame) {
    const fields = readFrameFields(frame);
    if (fields.pointer !== void 0 || fields.op !== void 0) {
      return this.applyPatch(fields);
    }
    if (fields.hasValue) {
      return this.applyDelta(fields.value);
    }
    if (fields.extraKeys.length > 0) {
      return this.applyMerge(fields);
    }
    return this.warn("Получен пустой кадр без полей, пропущен");
  }
  // ---------- \u2460\uff0f\u2461 \u5168\u91cf\u72b6\u6001\u4e0e\u8def\u5f84\u8865\u4e01 ----------
  applyPatch(fields) {
    const { pointer, op, hasValue, value } = fields;
    const tokens = pointer !== void 0 ? parsePointer(pointer) : [];
    const pointerText = pointer ?? `/${tokens.join("/")}`;
    if (op !== void 0 && !SUPPORTED_OPS.has(op)) {
      return this.warn(`Неизвестный оператор патча ${op}(путь ${pointerText}), пропущено`);
    }
    if (op === "BATCH") {
      if (!Array.isArray(value)) return this.warn("v кадра BATCH — не массив, пропущено");
      let allApplied = true;
      for (const item of value) {
        if (typeof item !== "object" || item === null) {
          this.note("BATCH -подкадр не объект, пропущен");
          allApplied = false;
          continue;
        }
        const outcome = this.apply(tokens.length > 0 ? prefixFrame(item, tokens) : item);
        if (!outcome.applied) allApplied = false;
      }
      return { applied: allApplied };
    }
    if (tokens.length === 0) {
      if (op === void 0 || op === "SET") {
        if (!hasValue) return this.warn("Получен кадр без пути и без значения, пропущен");
        this.root = value;
        return this.applied();
      }
      if (op === "DELETE") {
        this.root = void 0;
        return this.applied();
      }
      return this.warn(`оператор ${op}: нет доступного пути, пропущено`);
    }
    if (op === void 0) {
      return this.applyInferred(tokens, pointerText, hasValue, value);
    }
    const location = this.ensureLocation(tokens);
    if (!location) {
      return this.warn(`Путь недостижим: ${pointerText}(операция ${op}), пропущено`);
    }
    switch (op) {
      case "SET":
        writeAt(location, value);
        return this.applied();
      case "INSERT":
        if (Array.isArray(location.container) && location.index !== null) {
          location.container.splice(location.index, 0, value);
          return this.applied();
        }
        return this.warn(`INSERT: цель не массив: ${pointerText}, пропущено`);
      case "APPEND": {
        const existing = readAt(location);
        if (typeof existing === "string" && typeof value === "string") {
          writeAt(location, existing + value);
        } else if (Array.isArray(existing) && Array.isArray(value)) {
          existing.push(...value);
        } else {
          writeAt(location, value);
        }
        return this.applied();
      }
      case "DELETE":
        if (deleteAt(location)) return this.applied();
        return this.warn(`DELETE: цели не существует: ${pointerText}, пропущено`);
      default:
        return this.warn(`нереализованный оператор ${op}, пропущено`);
    }
  }
  // ---------- \u2462 \u503c\u589e\u91cf\u5e27 ----------
  /**
   * \u53ea\u6709 v \u7684\u5e27\u3002
   *
   * \u5224\u636e\u662f**\u503c\u672c\u8eab\u7684\u5f62\u6001**, \u4e0d\u662f\u300c\u6587\u6863\u6709\u6ca1\u6709\u521d\u59cb\u5316\u300d: 
   *   \u503c\u662f\u5bf9\u8c61 \u2192 \u5168\u91cf\u72b6\u6001\u5e27(\u53ea\u5728\u6d41\u7684\u5f00\u5934\u51fa\u73b0)
   *   \u503c\u662f\u5176\u5b83 \u2192 \u6d41\u5f0f\u6b63\u6587\u589e\u91cf, \u843d\u5230 contentPath \u4e0a
   *
   * \u4e3a\u4ec0\u4e48\u4e0d\u80fd\u770b\u6587\u6863\u72b6\u6001: \u7ad9\u70b9\u4f1a\u5728\u5168\u91cf\u72b6\u6001\u5e27**\u4e4b\u524d**\u5148\u53d1\u51e0\u6761\u5b57\u6bb5\u5408\u5e76\u5e27
   * ({"request_message_id":3} \u4e4b\u7c7b), \u90a3\u4f1a\u628a\u300c\u5df2\u521d\u59cb\u5316\u300d\u63d0\u524d\u7f6e\u4f4d, 
   * \u5bfc\u81f4\u771f\u6b63\u7684\u5168\u91cf\u72b6\u6001\u5e27\u88ab\u8bef\u5224\u6210\u6b63\u6587\u589e\u91cf\u800c\u4e22\u5f03\u2014\u2014fragments \u5168\u4e22\u3001\u6b63\u6587\u6c38\u8fdc\u662f\u7a7a\u3002
   *
   * \u53cd\u8fc7\u6765, \u5b57\u7b26\u4e32\u503c\u7684\u5e27\u7edd\u4e0d\u4f1a\u88ab\u5f53\u6210\u5168\u91cf\u72b6\u6001: \u5168\u91cf\u72b6\u6001\u4e0d\u53ef\u80fd\u662f\u88f8\u5b57\u7b26\u4e32, 
   * \u800c\u628a\u5b83\u5f53\u5168\u91cf\u72b6\u6001\u6b63\u662f\u300c\u6839\u5bf9\u8c61\u88ab\u66ff\u6362\u6210 "1"\u300d\u7684\u53e6\u4e00\u4e2a\u6839\u56e0\u3002
   */
  applyDelta(value) {
    if (isPlainObject(value)) {
      if (this.root !== void 0) {
        this.note("Получен второй полный кадр состояния; им заменён весь документ (в потоке была повторная инициализация)");
      }
      this.root = value;
      const outcome = this.applied();
      this.flushPendingMerge();
      return outcome;
    }
    this.inferredCount += 1;
    const tokens = parsePointer(this.contentPath);
    const location = this.ensureLocation(tokens);
    if (!location) {
      return this.warn(
        `не удалось найти путь тела ответа для кадра-приращения ${this.contentPath}, пропущено (можно настроить через DUB_CONTENT_PATH)`
      );
    }
    const existing = readAt(location);
    if (typeof existing === "string" && typeof value === "string") {
      writeAt(location, existing + value);
    } else if (Array.isArray(existing) && Array.isArray(value)) {
      existing.push(...value);
    } else {
      if (existing !== void 0 && typeof existing !== typeof value) {
        this.note(
          `тип текущего значения на пути тела ответа ${this.contentPath} (${typeof existing}) и тип кадра (${typeof value}) не совпадают; обработано как перезапись`
        );
      }
      writeAt(location, value);
    }
    return this.applied();
  }
  // ---------- \u2463 \u5b57\u6bb5\u5408\u5e76\u5e27 ----------
  /**
   * \u5e27\u81ea\u8eab\u7684\u952e\u5c31\u662f\u6839\u5bf9\u8c61\u4e0a\u7684\u5b57\u6bb5\u3002
   *
   * \u6839\u8fd8\u6ca1\u5efa\u7acb\u65f6**\u7edd\u4e0d\u5728\u8fd9\u91cc\u521d\u59cb\u5316\u6587\u6863**: \u7ad9\u70b9\u4f1a\u5728\u5168\u91cf\u72b6\u6001\u5e27\u4e4b\u524d\u5148\u53d1\u8fd9\u7c7b\u5e27, 
   * \u4e00\u65e6\u5728\u8fd9\u91cc\u628a\u6839\u5efa\u6210 {}, \u7d27\u968f\u5176\u540e\u7684\u5168\u91cf\u72b6\u6001\u5e27\u5c31\u4f1a\u88ab\u8bef\u5224\u6210\u6b63\u6587\u589e\u91cf\u3002
   * \u6b63\u786e\u505a\u6cd5\u662f\u5148\u6682\u5b58, \u7b49\u771f\u6b63\u7684\u6587\u6863\u5230\u4e86\u518d\u5e76\u8fdb\u53bb, \u6570\u636e\u4e0d\u4e22\u3001\u5224\u65ad\u4e5f\u4e0d\u88ab\u6c61\u67d3\u3002
   */
  applyMerge(fields) {
    if (!isPlainObject(this.root)) {
      this.pendingMerge = this.pendingMerge ?? {};
      let stashed = 0;
      for (const key of fields.extraKeys) {
        if (PROTECTED_MERGE_KEYS.has(key)) continue;
        this.pendingMerge[key] = fields[key];
        stashed += 1;
      }
      if (stashed === 0) return this.warn("кадр слияния полей не содержит полей для слияния, пропущен");
      this.note("до полного кадра состояния получен кадр слияния полей; отложен и будет присоединён после создания документа");
      return this.applied();
    }
    const record = fields;
    let merged = 0;
    for (const key of fields.extraKeys) {
      if (PROTECTED_MERGE_KEYS.has(key)) {
        this.note(`кадр слияния полей попытался перезаписать структурный ключ ${key}; ключ пропущен`);
        continue;
      }
      this.root[key] = record[key];
      merged += 1;
    }
    if (merged === 0) return this.warn("кадр слияния полей не содержит полей для слияния, пропущен");
    this.mergedCount += merged;
    return this.applied();
  }
  /** \u628a\u6682\u5b58\u7684\u5b57\u6bb5\u5408\u5e76\u5e27\u5e76\u8fdb\u5df2\u7ecf\u5efa\u7acb\u7684\u6587\u6863\u3002 */
  flushPendingMerge() {
    const pending = this.pendingMerge;
    if (!pending || !isPlainObject(this.root)) return;
    let merged = 0;
    for (const [key, value] of Object.entries(pending)) {
      if (PROTECTED_MERGE_KEYS.has(key)) continue;
      this.root[key] = value;
      merged += 1;
    }
    this.mergedCount += merged;
    this.pendingMerge = null;
  }
  // ---------- \u63a8\u65ad ----------
  /** \u7f3a\u64cd\u4f5c\u7b26\u65f6\u7684\u63a8\u65ad\u8def\u5f84\u3002 */
  applyInferred(tokens, pointerText, hasValue, value) {
    if (!hasValue) {
      return this.warn(`кадр патча без значения и без оператора (путь ${pointerText}), пропущено`);
    }
    const location = this.ensureLocation(tokens);
    if (!location) {
      return this.warn(`путь недостижим: ${pointerText}, а в документе уже другая структура; во избежание построения неверного каркаса \u2014 пропущено`);
    }
    const existing = readAt(location);
    const key = location.key.toLowerCase();
    this.inferredCount += 1;
    if (isScalarKey(key)) {
      writeAt(location, value);
      return this.applied();
    }
    if (typeof existing === "string" && typeof value === "string") {
      writeAt(location, existing + value);
      return this.applied();
    }
    if (Array.isArray(existing) && Array.isArray(value)) {
      existing.push(...value);
      return this.applied();
    }
    if (existing !== void 0 && typeof existing !== typeof value) {
      this.note(
        `тип текущего значения на пути ${pointerText} (${typeof existing}) и тип патча (${typeof value}) не совпадают; обработано как перезапись`
      );
    }
    writeAt(location, value);
    return this.applied();
  }
  /**
   * \u5b9a\u4f4d\u8def\u5f84\uff1b\u6587\u6863\u5c1a\u672a\u521d\u59cb\u5316\u65f6\u6309\u8def\u5f84\u5efa\u9aa8\u67b6\u5e76\u8bb0\u4e00\u6761\u8bf4\u660e\u3002
   * \u6587\u6863\u5df2\u6709\u7ed3\u6784\u5374\u5b9a\u4f4d\u4e0d\u5230, \u8bf4\u660e\u662f\u771f\u7684\u7ed3\u6784\u4e0d\u5339\u914d, \u6b64\u65f6\u4e0d\u731c(\u8fd4\u56de null)\u3002
   */
  ensureLocation(tokens) {
    const existing = locate(this.root, tokens);
    if (existing) return existing;
    if (this.root !== void 0) return null;
    const pointer = `/${tokens.join("/")}`;
    this.note(`Документ ещё не инициализирован; по пути ${pointer} создан каркас (возможно, хук установлен в середине потока или отсутствует полный кадр состояния)`);
    this.root = buildPath(tokens, void 0, false);
    return locate(this.root, tokens);
  }
};
function prefixFrame(frame, prefix) {
  const { pointer } = readFrameFields(frame);
  const own = pointer ? parsePointer(pointer) : [];
  return { ...frame, p: `/${[...prefix, ...own].join("/")}` };
}

// src/stream/sse.ts
var SseDecoder = class {
  buffer = "";
  dataLines = [];
  eventName = null;
  frameId = null;
  /** \u5582\u5165\u4e00\u6bb5\u539f\u59cb\u6587\u672c, \u8fd4\u56de\u672c\u6b21\u65b0\u89e3\u6790\u51fa\u7684\u5b8c\u6574\u5e27\u3002 */
  push(text) {
    this.buffer += text;
    const frames = [];
    for (; ; ) {
      const newlineAt = this.buffer.indexOf("\n");
      if (newlineAt === -1) break;
      const rawLine = this.buffer.slice(0, newlineAt);
      this.buffer = this.buffer.slice(newlineAt + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.length === 0) {
        const frame = this.dispatch();
        if (frame) frames.push(frame);
        continue;
      }
      if (line.startsWith(":")) continue;
      const colonAt = line.indexOf(":");
      const field = colonAt === -1 ? line : line.slice(0, colonAt);
      let value = colonAt === -1 ? "" : line.slice(colonAt + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      switch (field) {
        case "data":
          this.dataLines.push(value);
          break;
        case "event":
          this.eventName = value;
          break;
        case "id":
          this.frameId = value;
          break;
        default:
          break;
      }
    }
    return frames;
  }
  /** \u6d41\u7ed3\u675f\u65f6\u8c03\u7528: \u628a\u4e0d\u5b8c\u6574\u884c\u4e0e\u672a\u6d3e\u53d1\u7684\u4e8b\u4ef6\u4e00\u5e76\u5410\u51fa\u3002 */
  flush() {
    const frames = [];
    if (this.buffer.length > 0) {
      const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = "";
      if (line.startsWith("data:")) {
        let value = line.slice(5);
        if (value.startsWith(" ")) value = value.slice(1);
        this.dataLines.push(value);
      }
    }
    const frame = this.dispatch();
    if (frame) frames.push(frame);
    return frames;
  }
  dispatch() {
    if (this.dataLines.length === 0) {
      this.eventName = null;
      this.frameId = null;
      return null;
    }
    const frame = {
      event: this.eventName,
      data: this.dataLines.join("\n"),
      id: this.frameId
    };
    this.dataLines = [];
    this.eventName = null;
    this.frameId = null;
    return frame;
  }
};
function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}
function classifyPayload(data) {
  const trimmed = data.trim();
  if (trimmed.length === 0) return { kind: "text", raw: data };
  if (trimmed === "[DONE]" || trimmed === "[done]") return { kind: "done", raw: data };
  const first = trimmed[0];
  if (first === "{" || first === "[" || first === '"') {
    const parsed = tryParseJson(trimmed);
    if (parsed.ok) {
      const value = parsed.value;
      if (typeof value === "string") {
        const inner = tryParseJson(value.trim());
        if (inner.ok && typeof inner.value === "object" && inner.value !== null) {
          return { kind: "json-string", value: inner.value, raw: data };
        }
        return { kind: "json-string", value, raw: data };
      }
      if (typeof value === "object" && value !== null) {
        return { kind: "json", value, raw: data };
      }
    }
  }
  return { kind: "text", raw: data };
}
var TERMINAL_EVENTS = /* @__PURE__ */ new Set([
  "complete",
  "completed",
  "finish",
  "finished",
  "done",
  "end"
]);
var ABNORMAL_EVENTS = /* @__PURE__ */ new Set(["error", "audit", "security", "abort", "cancelled", "canceled"]);
function isTerminalEvent(name) {
  return name !== null && TERMINAL_EVENTS.has(name.toLowerCase());
}
function isAbnormalEvent(name) {
  return name !== null && ABNORMAL_EVENTS.has(name.toLowerCase());
}

// src/stream/status.ts
var STATUS_ALIASES = {
  finished: "FINISHED",
  finish: "FINISHED",
  complete: "FINISHED",
  completed: "FINISHED",
  success: "FINISHED",
  wip: "WIP",
  pending: "WIP",
  streaming: "WIP",
  generating: "WIP",
  in_progress: "WIP",
  incomplete: "INCOMPLETE",
  aborted: "INCOMPLETE",
  interrupted: "INCOMPLETE",
  content_filter: "CONTENT_FILTER",
  contentfilter: "CONTENT_FILTER",
  context_length_exceeded: "CONTEXT_LENGTH_EXCEEDED",
  contextlengthexceeded: "CONTEXT_LENGTH_EXCEEDED",
  timeout: "TIMEOUT",
  error: "ERROR",
  failed: "ERROR"
};
function normalizeStatus(value) {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if (key.length === 0) return null;
  return STATUS_ALIASES[key] ?? null;
}
function isSuccessfulStatus(status) {
  return status === "FINISHED";
}
function describeStatus2(status) {
  switch (status) {
    case "FINISHED":
      return "нормальное завершение";
    case "WIP":
      return "ещё генерируется";
    case "INCOMPLETE":
      return "сайт помечен как незавершённый (генерация прервана)";
    case "CONTENT_FILTER":
      return "сайт помечен как содержимое перехвачено (политика безопасности)";
    case "CONTEXT_LENGTH_EXCEEDED":
      return "сайт помечен как превышение лимита длины контекста";
    case "TIMEOUT":
      return "сайт помечен как таймаут генерации";
    case "ERROR":
      return "сайт помечен как ошибка генерации";
    default:
      return "не получено поле состояния от сайта";
  }
}
function extractStatusFromDocument(root) {
  let found = null;
  let visited = 0;
  const walk = (node, depth) => {
    if (depth > 8 || visited > 5e3) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      visited += 1;
      const normalizedKey = key.toLowerCase();
      if (normalizedKey.endsWith("status")) {
        const status = normalizeStatus(value);
        if (status !== null && status !== "WIP") found = status;
        else if (status === "WIP" && found === null) found = "WIP";
        continue;
      }
      walk(value, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

// src/stream/assembler.ts
var THINK_TYPES = /* @__PURE__ */ new Set(["THINK", "THINKING", "REASONING"]);
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function findFragments(root) {
  let queue = [root];
  let depth = 0;
  while (queue.length > 0 && depth < 5) {
    const next = [];
    for (const node of queue) {
      if (Array.isArray(node)) {
        next.push(...node);
        continue;
      }
      if (!isRecord(node)) continue;
      for (const [key, value] of Object.entries(node)) {
        if (key.toLowerCase() === "fragments" && Array.isArray(value)) return value;
        next.push(value);
      }
    }
    queue = next;
    depth += 1;
  }
  return null;
}
function extractContent(root) {
  const fragments = findFragments(root);
  if (!fragments) {
    return { text: "", thinking: "", fragmentTypes: [], foundFragments: false };
  }
  const textParts = [];
  const thinkingParts = [];
  const fragmentTypes = [];
  for (const fragment of fragments) {
    if (!isRecord(fragment)) continue;
    const type = typeof fragment.type === "string" ? fragment.type.toUpperCase() : "";
    const content = fragment.content;
    if (type) fragmentTypes.push(type);
    if (typeof content !== "string" || content.length === 0) continue;
    if (THINK_TYPES.has(type)) thinkingParts.push(content);
    else textParts.push(content);
  }
  return {
    text: textParts.join(""),
    thinking: thinkingParts.join(""),
    fragmentTypes,
    foundFragments: true
  };
}
var RAW_SAMPLE_CHARS = 600;
var ReplyAssembler = class {
  decoder = new SseDecoder();
  document;
  namedEvents = [];
  textSamples = [];
  rawHead = [];
  rawTail = [];
  maxChars;
  maxTextSamples;
  maxHeadSamples;
  maxTailSamples;
  frames = 0;
  jsonFrames = 0;
  jsonStringFrames = 0;
  doneFrames = 0;
  streamClosed = false;
  abnormalReason;
  /** \u53ea\u8bb0\u5f55\u300cfinalStatus\u300d\u72b6\u6001\uff1bWIP \u4e0d\u7b97finalStatus, \u5426\u5219\u4f1a\u63a9\u76d6\u300c\u6d41\u5df2\u5173\u95ed\u4f46\u7ad9\u70b9\u6ca1\u7ed9\u7ed3\u8bba\u300d\u3002 */
  terminalStatus = null;
  sawStatusField = false;
  constructor(options = {}) {
    this.maxChars = options.maxChars ?? 2e5;
    this.maxTextSamples = options.maxTextSamples ?? 5;
    this.maxHeadSamples = options.maxHeadSamples ?? 15;
    this.maxTailSamples = options.maxTailSamples ?? 15;
    this.document = new JsonPatchDocument(
      options.contentPath !== void 0 ? { contentPath: options.contentPath } : {}
    );
  }
  /** \u5582\u5165\u9875\u9762\u56de\u4f20\u7684\u539f\u59cb\u6587\u672c\u5206\u7247\u3002 */
  push(rawText) {
    if (rawText.length === 0) return;
    const frames = this.decoder.push(rawText);
    for (const frame of frames) this.consumeFrame(frame.event, frame.data);
  }
  /** \u9875\u9762\u4fa7\u62a5\u544a\u54cd\u5e94\u6d41\u5df2\u7ed3\u675f(\u670d\u52a1\u7aef\u5173\u95ed\u6d41, \u786c\u4fe1\u53f7)\u3002 */
  endStream() {
    for (const frame of this.decoder.flush()) this.consumeFrame(frame.event, frame.data);
    this.streamClosed = true;
  }
  /** \u9875\u9762\u4fa7\u62a5\u544a\u6d41\u8bfb\u53d6\u51fa\u9519\u3002 */
  failStream(message) {
    this.abnormalReason = message;
    this.streamClosed = true;
  }
  consumeFrame(event, data) {
    this.frames += 1;
    const sample = data.length > RAW_SAMPLE_CHARS ? `${data.slice(0, RAW_SAMPLE_CHARS)}\u2026` : data;
    if (this.rawHead.length < this.maxHeadSamples) {
      this.rawHead.push(sample);
    } else {
      this.rawTail.push(sample);
      if (this.rawTail.length > this.maxTailSamples) this.rawTail.shift();
    }
    if (event) {
      this.namedEvents.push(event);
      if (isTerminalEvent(event)) this.terminalStatus = "FINISHED";
      if (isAbnormalEvent(event)) {
        this.abnormalReason = `Событие потока сайта ${event}`;
      }
    }
    const payload = classifyPayload(data);
    switch (payload.kind) {
      case "json":
      case "json-string": {
        if (payload.kind === "json") this.jsonFrames += 1;
        else this.jsonStringFrames += 1;
        if (isRecord(payload.value)) {
          this.document.apply(payload.value);
        }
        const status = extractStatusFromDocument(this.document.value);
        if (status !== null) {
          this.sawStatusField = true;
          if (status !== "WIP") this.terminalStatus = status;
        }
        break;
      }
      case "done":
        this.doneFrames += 1;
        this.streamClosed = true;
        break;
      default:
        if (payload.raw.trim().length > 0 && this.textSamples.length < this.maxTextSamples) {
          this.textSamples.push(payload.raw.slice(0, 200));
        }
        break;
    }
  }
  /** \u5f53\u524d\u6b63\u6587(\u672a\u622a\u65ad), \u4f9b\u8fdb\u5ea6\u63d0\u793a\u4f7f\u7528\u3002 */
  peekText() {
    return extractContent(this.document.value).text;
  }
  snapshot() {
    const extracted = extractContent(this.document.value);
    const truncated = extracted.text.length > this.maxChars;
    const text = truncated ? extracted.text.slice(0, this.maxChars) : extracted.text;
    let status;
    let statusSource;
    if (this.terminalStatus !== null) {
      status = this.terminalStatus;
      statusSource = "site";
    } else if (this.streamClosed) {
      status = "UNKNOWN";
      statusSource = "stream-closed";
    } else {
      status = "WIP";
      statusSource = this.sawStatusField ? "site" : "unknown";
    }
    const messages = [];
    if (this.abnormalReason) messages.push(this.abnormalReason);
    if (status !== "FINISHED" && status !== "WIP" && status !== "UNKNOWN") {
      messages.push(`Терминальное состояние сайта: ${describeStatus2(status)}`);
    }
    if (status === "UNKNOWN" && this.streamClosed) {
      messages.push("Поток ответа завершён, но поле статуса от сайта не получено; тело ответа может быть неполным");
    }
    if (truncated) {
      messages.push(`тело превышает ${this.maxChars} символов \u2014 обрезано`);
    }
    if (!extracted.foundFragments) {
      messages.push("В документе не найдена fragments -структура (возможно, протокол сайта изменился)");
    }
    const patchStats = this.document.stats();
    if (patchStats.skipped > 0) {
      messages.push(
        `пропущено кадров патчей: ${patchStats.skipped} (последний: ${patchStats.lastWarning ?? "неизвестно"}); тело ответа может быть неполным`
      );
    }
    const topLevelKeys = isRecord(this.document.value) ? Object.keys(this.document.value).slice(0, 20) : [];
    const diagnostics = {
      frames: this.frames,
      jsonFrames: this.jsonFrames,
      jsonStringFrames: this.jsonStringFrames,
      doneFrames: this.doneFrames,
      namedEvents: [...new Set(this.namedEvents)].slice(0, 10),
      textSamples: [...this.textSamples],
      rawHead: [...this.rawHead],
      rawTail: [...this.rawTail],
      patch: patchStats,
      fragmentTypes: [...new Set(extracted.fragmentTypes)].slice(0, 10),
      topLevelKeys,
      streamClosed: this.streamClosed
    };
    if (this.abnormalReason) diagnostics.abnormalReason = this.abnormalReason;
    const snapshot = {
      text,
      thinking: extracted.thinking,
      status,
      statusSource,
      truncated,
      abnormal: messages.length > 0,
      warnings: [...this.document.warningsList],
      diagnostics
    };
    if (messages.length > 0) snapshot.abnormalMessage = messages.join("; ");
    return snapshot;
  }
};

// src/tools/registry.ts
import "zod";

// src/safety/commands.ts
import { createInterface } from "readline/promises";
import process3 from "process";
var CATASTROPHIC_PATTERNS = [
  { pattern: /\brm\s+(-[a-z]*\s+)*-?[a-z]*f[a-z]*\s+(-[a-z]+\s+)*\/(\s|$)/i, reason: "Рекурсивное удаление корня" },
  { pattern: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME)(\s|$)/i, reason: "Рекурсивное удаление корня или домашней директории" },
  { pattern: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+\*(\s|$)/i, reason: "Рекурсивное удаление содержимого текущей директории по маске" },
  { pattern: /:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;?\s*:/, reason: "fork -бомба" },
  { pattern: /\bmkfs(\.\w+)?\b/i, reason: "Форматирование файловой системы" },
  { pattern: /\bdd\b.*\bof=\/dev\//i, reason: "Прямая запись в \u00abсырое\u00bb устройство" },
  { pattern: /\bformat\s+[a-z]:/i, reason: "Форматирование дискового раздела" },
  { pattern: /\bdiskpart\b/i, reason: "Инструмент разметки диска" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "Выключение или перезагрузка системы" },
  { pattern: /\breg\s+delete\b/i, reason: "Удаление ключа реестра" },
  { pattern: /remove-item\b.*-recurse\b.*\s[a-z]:\\?(\s|$)/i, reason: "Рекурсивное удаление корня диска" },
  { pattern: /\bdel\s+\/[a-z]\s+.*\/[a-z]\s+[a-z]:\\?(\s|$)/i, reason: "Принудительное рекурсивное удаление корня диска" }
];
var COMPOSITION_PATTERN = /(&&|\|\||[;&|`]|\$\(|>|<|\r|\n)/;
var RISKY_PATTERNS = [
  { pattern: /(^|[\s;&|])npx([\s;&|]|$)/i, reason: "Содержит npx: скачает и выполнит произвольный пакет \u2014 эквивалент произвольного исполнения кода" },
  { pattern: /\brm\b/i, reason: "Содержит удаление rm" },
  { pattern: /\brmdir\b|\brd\b/i, reason: "Содержит удаление директории" },
  { pattern: /\bdel\b/i, reason: "Содержит удаление файла" },
  { pattern: /\bremove-item\b/i, reason: "Содержит PowerShell-удаление" },
  { pattern: /\bgit\s+push\b/i, reason: "Отправит изменения в удалённый репозиторий" },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "Отбросит локальные незакоммиченные изменения" },
  { pattern: /\bgit\s+clean\b/i, reason: "Удалит неотслеживаемые файлы" },
  { pattern: /\bgit\s+checkout\s+--\s/i, reason: "Перезапишет файлы рабочей директории" },
  { pattern: /\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b/i, reason: "Опубликует пакет в реестр" },
  { pattern: /\bcurl\b.*\|\s*(ba)?sh\b/i, reason: "Выполняет скрипт напрямую из сети" },
  { pattern: /\biwr\b.*\|\s*iex\b/i, reason: "Прямое выполнение PowerShell-скрипта из сети" },
  { pattern: /\bchmod\b|\bchown\b/i, reason: "Изменит права/владельца файла" },
  { pattern: /\btaskkill\b|\bkill\b/i, reason: "Завершит процесс" },
  { pattern: /\bsudo\b|\brunas\b/i, reason: "Запрос повышения привилегий" }
];
var LONG_RUNNING_PATTERNS = [
  { pattern: /^(npm|pnpm|yarn)\s+(run\s+)?(dev|develop|start|serve|watch|preview)\b/i, reason: "Похоже на длительно живущий процесс (dev/start/serve/watch), сам не завершится" },
  { pattern: /^(npx\s+)?(nodemon|concurrently|pm2)\b/i, reason: "Похоже на процесс-надзиратель / или параллельный раннер \u2014 будет висеть постоянно" },
  { pattern: /^(tsx|ts-node|node)\b.*\bwatch\b/i, reason: "Похоже на режим наблюдения (watch), сам не завершится" },
  { pattern: /^tail\s+-[a-z]*f/i, reason: "tail -f постоянно следит за файлом и сам не завершится" },
  { pattern: /^(ping|tracert|traceroute|top|htop|watch|sleep)\b/i, reason: "Похоже на длительный или блокирующий процесс" }
];
function normalizeCommand(command) {
  return command.trim().replace(/\s+/g, " ");
}
function matchWhitelist(command, whitelist) {
  const normalized = normalizeCommand(command).toLowerCase();
  for (const entry of whitelist) {
    const pattern = normalizeCommand(entry).toLowerCase();
    if (pattern.length === 0) continue;
    if (normalized === pattern) return { matched: true, pattern: entry };
    if (normalized.startsWith(`${pattern} `)) return { matched: true, pattern: entry };
  }
  return { matched: false };
}
function assessCommand(command, options) {
  const normalized = normalizeCommand(command);
  if (normalized.length === 0) {
    return { decision: "deny", reason: "Команда пуста" };
  }
  for (const { pattern, reason } of CATASTROPHIC_PATTERNS) {
    if (pattern.test(normalized)) {
      return { decision: "deny", reason: `Отказано в выполнении: ${reason}` };
    }
  }
  if (options.autoApprove) {
    return { decision: "auto", reason: "Включено автоисполнение всех команд (DUB_AUTO_APPROVE_COMMANDS=true)" };
  }
  if (COMPOSITION_PATTERN.test(normalized)) {
    return {
      decision: "confirm",
      reason: "Команда содержит склейки (&&, |, ;, > и т.п.); белый список не покрывает семантику всей строки"
    };
  }
  for (const { pattern, reason } of RISKY_PATTERNS) {
    if (pattern.test(normalized)) {
      return { decision: "confirm", reason: `требуется ручное подтверждение: ${reason}` };
    }
  }
  for (const { pattern, reason } of LONG_RUNNING_PATTERNS) {
    if (pattern.test(normalized)) {
      return { decision: "confirm", reason: `требуется ручное подтверждение: ${reason}` };
    }
  }
  const whitelisted = matchWhitelist(normalized, options.whitelist);
  if (whitelisted.matched) {
    return {
      decision: "auto",
      reason: `попадание в белый список: ${whitelisted.pattern}`,
      ...whitelisted.pattern ? { matchedPattern: whitelisted.pattern } : {}
    };
  }
  return { decision: "confirm", reason: "Не попало в белый список, требуется ручное подтверждение" };
}
function isInteractiveTerminal(input) {
  if (input !== void 0) return true;
  return process3.stdin.isTTY === true;
}
var CommandDeniedError = class extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
  code;
  name = "CommandDeniedError";
};
async function confirmCommand(command, reason, options = {}) {
  const interactive = options.input !== void 0 || process3.stdin.isTTY === true;
  if (!interactive) {
    return options.defaultOnInteractiveFail ?? false;
  }
  const rl = createInterface({
    input: options.input ?? process3.stdin,
    output: options.output ?? process3.stdout
  });
  try {
    const answer = await rl.question(
      `
[Подтверждение выполнения] ${command}
[Причина] ${reason}
Разрешить выполнение?(y/N) `
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// src/tools/fs.ts
import { mkdirSync, renameSync, statSync as statSync5, unlinkSync, writeFileSync } from "fs";
import path5 from "path";
import process4 from "process";

// src/tools/gitignore.ts
import { readFileSync as readFileSync2, statSync as statSync3 } from "fs";
import path3 from "path";

// src/tools/glob.ts
function escapeRegExpChar(char) {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}
function globToRegExp(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "\\" && i + 1 < pattern.length) {
      source += escapeRegExpChar(pattern[i + 1]);
      i += 1;
      continue;
    }
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "[") {
      const end = pattern.indexOf("]", i + 1);
      const body = end === -1 ? null : pattern.slice(i + 1, end);
      if (body === null || body.length === 0) {
        source += "\\[";
      } else {
        source += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
        i = end;
      }
      continue;
    }
    source += escapeRegExpChar(char);
  }
  return new RegExp(`^${source}$`);
}
function matchesGlob(relativePath2, pattern) {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return true;
  let normalized = trimmed.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.endsWith("/")) normalized = `${normalized}**`;
  const target = relativePath2.replace(/\\/g, "/");
  if (!normalized.includes("/")) return globToRegExp(`**/${normalized}`).test(target);
  return globToRegExp(normalized).test(target);
}

// src/tools/gitignore.ts
var GITIGNORE_SIZE_LIMIT = 256 * 1024;
function parseIgnoreRule(baseDir, rawLine) {
  let line = rawLine.replace(/\r$/, "");
  if (line.trim().length === 0) return null;
  if (line.startsWith("#")) return null;
  line = line.replace(/(?<!\\)\s+$/, "");
  if (line.length === 0) return null;
  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
  } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
    line = line.slice(1);
  }
  let dirOnly = false;
  if (line.endsWith("/") && !line.endsWith("\\/")) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (line.length === 0) return null;
  const anchored = line.startsWith("/");
  if (anchored) line = line.slice(1);
  const body = anchored || line.includes("/") ? line : `**/${line}`;
  return { base: baseDir, dirOnly, negated, regex: globToRegExp(body) };
}
var IgnoreMatcher = class {
  rules = [];
  /** \u89e3\u6790\u4e00\u4efd .gitignore \u5185\u5bb9\uff1b\u89c4\u5219\u76f8\u5bf9 baseDir(\u7edd\u5bf9\u8def\u5f84)\u3002\u540e\u52a0\u5165\u7684\u89c4\u5219\u4f18\u5148\u7ea7\u66f4\u9ad8\u3002 */
  addFile(baseDir, content) {
    for (const line of content.split("\n")) {
      const rule = parseIgnoreRule(baseDir, line);
      if (rule) this.rules.push(rule);
    }
  }
  get ruleCount() {
    return this.rules.length;
  }
  /** Должен ли путь игнорироваться.isDirectory \u5f71\u54cd\u300c\u53ea\u5339\u914d\u76ee\u5f55\u300d\u7684\u89c4\u5219\u3002 */
  ignores(absolutePath, isDirectory) {
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDirectory) continue;
      const relative = path3.relative(rule.base, absolutePath);
      if (relative.length === 0 || relative.startsWith("..") || path3.isAbsolute(relative)) continue;
      if (rule.regex.test(relative.split(path3.sep).join("/"))) ignored = !rule.negated;
    }
    return ignored;
  }
};
function addGitignoreInDir(matcher, dir) {
  const file = path3.join(dir, ".gitignore");
  try {
    const stat = statSync3(file);
    if (!stat.isFile() || stat.size > GITIGNORE_SIZE_LIMIT) return;
    matcher.addFile(dir, readFileSync2(file, "utf8"));
  } catch {
  }
}
function loadAncestorIgnoreRules(root, dir) {
  const matcher = new IgnoreMatcher();
  const relative = path3.relative(root, dir);
  const segments = relative.length === 0 || relative.startsWith("..") ? [] : relative.split(path3.sep).filter((item) => item.length > 0);
  addGitignoreInDir(matcher, root);
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path3.join(current, segment);
    addGitignoreInDir(matcher, current);
  }
  return matcher;
}

// src/tools/walk.ts
import { readdirSync, statSync as statSync4 } from "fs";
import path4 from "path";
var DEFAULT_IGNORED_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".parcel-cache",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
  ".turbo",
  ".output",
  ".gradle"
]);
function walkDirectory(root, guard, options) {
  const ignored = options.ignoredDirs ?? DEFAULT_IGNORED_DIRS;
  const entries = [];
  let truncated = false;
  let skipped = 0;
  let ignoredByRules = 0;
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (options.ignore) addGitignoreInDir(options.ignore, current.dir);
    let dirents;
    try {
      dirents = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      skipped += 1;
      continue;
    }
    for (const dirent of dirents) {
      if (entries.length >= options.maxEntries) {
        truncated = true;
        break;
      }
      const absolutePath = path4.join(current.dir, dirent.name);
      const isDirectory = dirent.isDirectory();
      if (isDirectory && ignored.has(dirent.name)) continue;
      if (!isDirectory && dirent.name.startsWith(".dubridge-tmp-")) continue;
      if (dirent.isSymbolicLink()) {
        try {
          if (statSync4(absolutePath).isDirectory()) continue;
        } catch {
          skipped += 1;
          continue;
        }
      }
      if (options.ignore?.ignores(absolutePath, isDirectory)) {
        ignoredByRules += 1;
        continue;
      }
      let size = 0;
      if (!isDirectory && options.statFiles) {
        try {
          size = statSync4(absolutePath).size;
        } catch {
          size = 0;
        }
      }
      entries.push({
        absolutePath,
        relativePath: guard.relative(absolutePath),
        depth: current.depth + 1,
        isDirectory,
        size
      });
      if (isDirectory && current.depth + 1 < options.maxDepth) {
        queue.push({ dir: absolutePath, depth: current.depth + 1 });
      }
    }
    if (truncated) break;
  }
  return { entries, truncated, maxEntries: options.maxEntries, skipped, ignoredByRules };
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// src/tools/fs.ts
function writeFileAtomic(absolute, content) {
  const dir = path5.dirname(absolute);
  const temp = path5.join(
    dir,
    `.dubridge-tmp-${process4.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  try {
    writeFileSync(temp, content, { encoding: "utf8" });
    renameSync(temp, absolute);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
    }
    throw error;
  }
}
function splitFileLines(text) {
  if (text.length === 0) return { lines: [], endsWithNewline: false };
  const endsWithNewline = text.endsWith("\n");
  const body = endsWithNewline ? text.slice(0, -1) : text;
  return { lines: body.split("\n"), endsWithNewline };
}
function analyzeLineEndings(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const rest = text.replace(/\r\n/g, "");
  const lf = (rest.match(/\n/g) ?? []).length;
  const cr = (rest.match(/\r/g) ?? []).length;
  if (crlf > 0 && lf === 0 && cr === 0) return { eol: "\r\n", mixed: false, crlf, lf, cr };
  if (lf > 0 && crlf === 0 && cr === 0) return { eol: "\n", mixed: false, crlf, lf, cr };
  if (crlf === 0 && lf === 0 && cr === 0) return { eol: "\n", mixed: false, crlf, lf, cr };
  return { eol: crlf >= lf ? "\r\n" : "\n", mixed: true, crlf, lf, cr };
}
function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, "\n");
}
var LEGACY_LINE_PREFIX_RE = /^[ \t]*\d+\| ?/;
function stripLegacyLinePrefixes(text) {
  let lines = 0;
  const stripped = text.split("\n").map((line) => {
    const next = line.replace(LEGACY_LINE_PREFIX_RE, "");
    if (next !== line) lines += 1;
    return next;
  });
  return { text: stripped.join("\n"), lines };
}
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function buildTrailingWhitespaceTolerantPattern(oldText) {
  if (!/\S/.test(oldText)) return null;
  const body = oldText.split("\n").map((line) => `${escapeRegExp(line.replace(/[ \t]+$/, ""))}[ \\t]*`).join("\n");
  return new RegExp(body, "g");
}
function countPatternMatches(text, pattern) {
  let count = 0;
  for (const _ of text.matchAll(new RegExp(pattern.source, "g"))) count += 1;
  return count;
}
function countNewlines(text) {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1;
  }
  return count;
}
function findExactMatches(text, needle, all) {
  const matches = [];
  let index = text.indexOf(needle);
  while (index !== -1) {
    matches.push({ start: index, length: needle.length });
    if (!all) break;
    index = text.indexOf(needle, index + needle.length);
  }
  return matches;
}
function findPatternMatches(text, pattern, all) {
  const matches = [];
  for (const match of text.matchAll(new RegExp(pattern.source, "g"))) {
    matches.push({ start: match.index ?? 0, length: match[0].length });
    if (!all) break;
  }
  return matches;
}
function describeEditLineEndings(profile) {
  const label = profile.eol === "\r\n" ? "CRLF" : "LF";
  if (profile.mixed) {
    return `; внимание: исходно в файле смешаны переводы строк (CRLF ${profile.crlf} шт. / LF ${profile.lf} шт.); после этой правки всё приведено к ${label}`;
  }
  return profile.eol === "\r\n" ? "; в файле переводы строк \u2014  CRLF, различия переводов строк при сопоставлении игнорировались" : "";
}
var readFileTool = {
  name: "read_file",
  summary: "Читает текстовый файл из рабочей директории; тело возвращается как есть (без номеров строк); поддерживается диапазон строк и продолжение.",
  title: "Чтение текстового файла",
  promptGuidelines: [
    "```json",
    '{"path":"src/a.ts", "offset":1, "limit":200}',
    "```",
    "- `path` обязателен; `offset` — начальная строка (с 1); `limit` — максимум строк.",
    "- **тело \u2014 содержимое файла как есть, без номеров строк**: прочитанное можно сразу использовать как `old_text` для `edit_file`, без преобразований.",
    "- Абсолютный диапазон строк показан в шапке как «в этот раз показаны строки A\u2013B»; если содержимое обрезано, в шапке будет «для продолжения используйте offset=N» \u2014 читайте по нему.",
    "- Не-UTF-8 кодировка (например, GB18030, UTF-16) декодируется по распознанной кодировке, в шапке пишется «кодировка:». Такие файлы **можно читать, но нельзя изменять**: `edit_file` откажет в записи, чтобы не подменить всю кодировку файла."
  ].join("\n"),
  access: "read",
  schema: readFileArgsSchema,
  async execute(args, context) {
    const absolute = context.guard.resolveFile(args.path);
    const limited = readTextFileLimited(absolute, context.config.maxFileBytes);
    const { lines, endsWithNewline } = splitFileLines(limited.text);
    const totalLines = lines.length;
    if (args.offset !== void 0 && args.offset > totalLines) {
      throw new SandboxViolationError(
        `offset=${args.offset} выходит за конец файла (всего строк: ${totalLines}): ${args.path}`,
        "NOT_FOUND"
      );
    }
    const startLine = Math.max(1, args.offset ?? 1);
    const limit = args.limit ?? Math.max(1, totalLines - startLine + 1);
    const selected = lines.slice(startLine - 1, startLine - 1 + limit);
    const endLine = startLine + selected.length - 1;
    const notes = [];
    if (limited.encoding !== "utf8") {
      notes.push(
        `Кодировка: ${limited.encodingLabel}${limited.utf8Family ? "" : " (не UTF-8: можно читать, но edit_file откажет в записи)"}`
      );
    }
    let continueOffset;
    if (limited.truncated) {
      continueOffset = Math.max(1, endLine);
      notes.push(
        `обрезано по лимиту ${formatBytes(context.config.maxFileBytes)}; последняя строка может быть неполной. Продолжить: offset=${continueOffset}`
      );
    } else if (endLine < totalLines) {
      continueOffset = endLine + 1;
      notes.push(`ещё не показано строк: ${totalLines - endLine}. Продолжить: offset=${continueOffset}`);
    }
    const range = totalLines === 0 ? "Файл пуст" : `показаны строки ${startLine}\u2013${endLine}${endsWithNewline ? ", файл заканчивается переводом строки" : ""}`;
    const header = [
      `Файл: ${context.guard.relative(absolute)}`,
      `Всего строк: ${totalLines}, ${range}`,
      `Размер файла: ${formatBytes(limited.bytes)}`,
      ...notes,
      ""
    ].join("\n");
    const structured = {
      path: context.guard.relative(absolute),
      bytes: limited.bytes,
      encoding: limited.encoding,
      totalLines,
      startLine,
      endLine,
      shownLines: selected.length,
      truncated: limited.truncated
    };
    if (continueOffset !== void 0) structured.continueOffset = continueOffset;
    return { text: header + selected.join("\n"), structured };
  }
};
var writeFileTool = {
  name: "write_file",
  summary: "Запись (перезапись) файла в рабочей директории; родительская директория создаётся при необходимости.",
  title: "Запись (перезапись) файла",
  promptGuidelines: [
    "```json",
    '{"path":"src/new.ts", "content":"полное содержимое файла", "create_dirs":true}',
    "```",
    "- **Перезапись всего файла**. Для правки существующего файла предпочитайте `edit_file`; используйте write_file только для нового файла или полной перезаписи.",
    "- Новые файлы всегда пишутся как UTF-8. При перезаписи существующего файла, если он не UTF-8-текст (например, GB18030, UTF-16 или бинарный), запись будет отклонена с объяснением причины \u2014 чтобы одна запись не сменила кодировку всего файла."
  ].join("\n"),
  access: "write",
  schema: writeFileArgsSchema,
  async execute(args, context) {
    const absolute = context.guard.resolve(args.path);
    let existed = false;
    try {
      const stat = statSync5(absolute);
      existed = true;
      if (stat.isDirectory()) {
        throw new SandboxViolationError(`цель — каталог, запись невозможна: ${args.path}`, "NOT_A_DIRECTORY");
      }
    } catch (error) {
      if (error instanceof SandboxViolationError) throw error;
    }
    if (existed) {
      const probe = probeFileEncoding(absolute);
      if (probe === null) {
        throw new SandboxViolationError(
          `цель уже существует и не является распознаваемым текстовым файлом (двоичный или неизвестная кодировка); перезапись отклонена: ${args.path}. Для полной перезаписи сначала проверьте его тип или удалите его.`,
          "UNSUPPORTED_ENCODING"
        );
      }
      if (!probe.utf8Family) {
        throw new SandboxViolationError(
          `кодировка целевого файла ${probe.label}; write_file пишет только UTF-8: перезапись сменит кодировку всего файла (git diff станет полностью красным, внешние инструменты могут не прочитать). Отклонено: ${args.path}. Сохраните его как UTF-8 в редакторе или удалите и создайте заново.`,
          "UNSUPPORTED_ENCODING"
        );
      }
    }
    if (args.create_dirs !== false) {
      mkdirSync(path5.dirname(absolute), { recursive: true });
    }
    writeFileAtomic(absolute, args.content);
    const bytes = Buffer.byteLength(args.content, "utf8");
    const lines = args.content.length === 0 ? 0 : args.content.split("\n").length;
    return {
      text: `Записано ${context.guard.relative(absolute)}: ${lines} строк, ${formatBytes(bytes)}`,
      meta: { bytes },
      structured: {
        path: context.guard.relative(absolute),
        bytes,
        lines,
        created: !existed,
        encoding: "utf8"
      }
    };
  }
};
function locateEditSpans(text, chunk, label, path9) {
  const oldText = normalizeNewlines(chunk.oldText);
  const newText = normalizeNewlines(chunk.newText);
  if (oldText.length === 0) {
    throw new SandboxViolationError(`${label} не может быть пустым: ${path9}`, "NOT_FOUND");
  }
  const attempts = [{ kind: "exact", oldText }];
  const stripped = stripLegacyLinePrefixes(oldText);
  const strippable = stripped.lines >= 2 ? stripped.text : null;
  if (strippable !== null) {
    attempts.push({ kind: "exact", oldText: strippable, note: "old_text проигнорирован \u2014 префикс с номером строки (для остатков старых диалогов)" });
  }
  for (const candidate of [oldText, strippable]) {
    if (candidate === null) continue;
    const pattern = buildTrailingWhitespaceTolerantPattern(candidate);
    if (!pattern) continue;
    attempts.push({
      kind: "pattern",
      pattern,
      note: candidate === oldText ? "При сопоставлении различия хвостовых пробелов игнорировались" : "old_text проигнорирован \u2014 префикс с номером строки и различия хвостовых пробелов"
    });
  }
  for (const attempt of attempts) {
    const found = attempt.kind === "exact" ? findExactMatches(text, attempt.oldText, chunk.replaceAll) : findPatternMatches(text, attempt.pattern, chunk.replaceAll);
    if (found.length === 0) continue;
    const total = attempt.kind === "exact" ? countOccurrences(text, attempt.oldText) : countPatternMatches(text, attempt.pattern);
    if (total > 1 && !chunk.replaceAll) {
      throw new SandboxViolationError(
        `${label} совпал в ${path9} ${total} раз(а) \u2014 неоднозначно. Добавьте контекст для уникальности или явно задайте replace_all: true.`,
        "NOT_FOUND"
      );
    }
    const spans = found.map((item) => ({
      start: item.start,
      length: item.length,
      original: text.slice(item.start, item.start + item.length),
      newText
    }));
    const located = { spans };
    if (attempt.note !== void 0) located.note = attempt.note;
    return located;
  }
  throw new SandboxViolationError(
    [
      `в ${path9} не найден указанный ${label} (пробовали по очереди: посимвольно, без исторического префикса строки, без различий хвостовых пробелов).`,
      "Частые причины: разные отступы, изменённые пробелы или знаки препинания (например, полноширинные/полуширинные, \u00abумные\u00bb кавычки), либо оригинал действительно изменён.",
      "Совет: сначала заново read_file получите текущее содержимое и затем редактируйте."
    ].join(""),
    "NOT_FOUND"
  );
}
var editFileTool = {
  name: "edit_file",
  summary: "Заменяет содержимое файла по фрагменту оригинала; можно править несколько мест за раз (массив edits); old_text сопоставляется посимвольно; различия в переводах строк, хвостовых пробелах и исторических префиксах с номерами строк игнорируются; при нескольких совпадениях нужно явно задать replace_all.",
  title: "Замена по фрагменту оригинала",
  promptGuidelines: [
    "```json",
    '{"path":"src/a.ts", "old_text":"заменяемый оригинал", "new_text":"содержимое замены", "replace_all":false}',
    "```",
    "Чтобы изменить несколько мест за раз, используйте массив `edits` (взаимоисключающе с `old_text`/`new_text`): ",
    "",
    "```json",
    '{"path":"src/a.ts", "edits":[{"old_text":"a","new_text":"b"},{"old_text":"c","new_text":"d"}]}',
    "```",
    "",
    "- `old_text` должен посимвольно совпадать с содержимым файла (отступы тоже); различия переводов строк (CRLF/LF) и хвостовых пробелов можно не учитывать; при записи сохранятся исходные переводы строк и BOM.",
    "- Поддерживаются только UTF-8-файлы (с BOM или без). Файл в GB18030, UTF-16 и т.п. будет отклонён с указанием причины в ошибке \u2014 запись в исходной кодировке сменит кодировку всего файла; проект таких тихих преобразований не делает.",
    "- **за один раунд старайтесь выдать всё сразу**: каждый блок сопоставляется с исходным файлом (а не с результатом предыдущего блока), блоки не должны пересекаться; при пересечении будет отказ \u2014 тогда объедините их в один блок. Каждый лишний раунд \u2014 это дорогой обмен.",
    "- В результате указывается «первая изменённая строка» (номер в новом файле): чтобы проверить правку, используйте `offset` у `read_file`, чтобы сразу перейти к этой строке, не перечитывая весь файл.",
    '- При нескольких совпадениях будет ошибка: добавьте контекст для уникальности либо явно задайте `"replace_all": true`.',
    "- Если оригинал не найден \u2014 будет ошибка (инструмент уже ослабил условия до \u00abигнорировать хвостовые пробелы\u00bb; если всё равно не нашёл \u2014 содержимое действительно другое); сделайте `read_file`  и повторите.",
    "- Если `old_text` совпадает с `new_text`, вернётся `NO_CHANGE`: ничего не изменилось; так вызывать не нужно."
  ].join("\n"),
  access: "write",
  schema: editFileArgsSchema,
  async execute(args, context) {
    const chunks = normalizeEditChunks(args);
    const absolute = context.guard.resolveFile(args.path);
    const limited = readTextFileLimited(absolute, context.config.maxFileBytes);
    if (limited.truncated) {
      throw new SandboxViolationError(
        `Файл превышает лимит одной правки (${context.config.maxFileBytes} байт); во избежание записи неполного содержимого правка отклонена. Используйте полную перезапись через write_file или увеличьте DUB_MAX_FILE_BYTES.`,
        "FILE_TOO_LARGE"
      );
    }
    if (!limited.utf8Family) {
      throw new SandboxViolationError(
        `Кодировка файла ${limited.encodingLabel}; edit_file пишет только UTF-8: запись в исходной кодировке сменит кодировку всего файла (git diff станет полностью красным, внешние инструменты могут не прочитать). Правка отклонена: ${args.path}. Сохраните файл как UTF-8 и правьте.`,
        "UNSUPPORTED_ENCODING"
      );
    }
    const bom = limited.text.startsWith("\ufeff") ? "\ufeff" : "";
    const original = bom.length > 0 ? limited.text.slice(1) : limited.text;
    const profile = analyzeLineEndings(original);
    const normalizedOriginal = normalizeNewlines(original);
    const notes = [];
    if (bom.length > 0) notes.push("Сохранён исходный BOM");
    const spans = [];
    for (const [index, chunk] of chunks.entries()) {
      const label = chunks.length > 1 ? `edits[${index}].old_text` : "old_text";
      const located = locateEditSpans(normalizedOriginal, chunk, label, args.path);
      if (located.note !== void 0 && !notes.includes(located.note)) notes.push(located.note);
      spans.push(...located.spans);
    }
    const ordered = [...spans].sort((a, b) => a.start - b.start);
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1];
      const current = ordered[i];
      if (previous.start + previous.length > current.start) {
        throw new SandboxViolationError(
          `Два участка замены перекрываются в ${args.path}; намерение неоднозначно. Объедините их в один блок или сделайте непересекающимися.`,
          "NOT_FOUND"
        );
      }
    }
    let updatedNormalized = normalizedOriginal;
    for (let i = ordered.length - 1; i >= 0; i -= 1) {
      const span = ordered[i];
      updatedNormalized = updatedNormalized.slice(0, span.start) + span.newText + updatedNormalized.slice(span.start + span.length);
    }
    for (const span of ordered) {
      if (normalizedOriginal.slice(span.start, span.start + span.length) !== span.original) {
        throw new SandboxViolationError(
          `Проверка записи не удалась: координаты замены не совпали с исходным текстом; правка отменена (${args.path} не изменён).`,
          "WRITE_VERIFY_FAILED"
        );
      }
      if (span.newText.length > 0 && !updatedNormalized.includes(span.newText)) {
        throw new SandboxViolationError(
          `Проверка записи не удалась: new_text записан не дословно; правка отменена (${args.path} не изменён).`,
          "WRITE_VERIFY_FAILED"
        );
      }
    }
    if (updatedNormalized === normalizedOriginal) {
      throw new SandboxViolationError(
        `Содержимое после замены полностью совпадает с исходным: old_text равен new_text (или совпавший фрагмент и есть new_text); изменений нет, запись в ${args.path} отменена.`,
        "NO_CHANGE"
      );
    }
    const body = profile.eol === "\r\n" ? updatedNormalized.replace(/\n/g, "\r\n") : updatedNormalized;
    const updated = bom.length > 0 ? `${bom}${body}` : body;
    writeFileAtomic(absolute, updated);
    const bytes = Buffer.byteLength(updated, "utf8");
    const delta = bytes - Buffer.byteLength(original, "utf8");
    const firstChangedLine = countNewlines(normalizedOriginal.slice(0, ordered[0].start)) + 1;
    const suffix = [describeEditLineEndings(profile), ...notes.map((note) => `; ${note}`)].join("");
    return {
      text: `Изменено ${context.guard.relative(absolute)}: замен ${ordered.length} (первая изменённая строка: ${firstChangedLine}), размер файла ${formatBytes(
        bytes
      )}(${delta >= 0 ? "+" : ""}${delta} байт)${suffix}`,
      meta: { bytes },
      structured: {
        path: context.guard.relative(absolute),
        replacements: ordered.length,
        firstChangedLine,
        bytes,
        deltaBytes: delta,
        encoding: limited.encoding,
        eol: profile.eol === "\r\n" ? "crlf" : "lf",
        mixedLineEndings: profile.mixed,
        bom: bom.length > 0,
        notes
      }
    };
  }
};
var listDirTool = {
  name: "list_dir",
  summary: "Выводит файлы и подкаталоги рабочей директории; по умолчанию один уровень, можно задать глубину рекурсии; автоматически пропускает тяжёлые директории и содержимое, игнорируемое по .gitignore.",
  title: "Листинг директории",
  promptGuidelines: [
    "```json",
    '{"path":".", "depth":1}',
    "```",
    "- `depth` по умолчанию 1 (только один уровень). При рекурсии автоматически пропускаются `node_modules`, `.git`, `dist` и прочие тяжёлые директории, а также содержимое, игнорируемое по .gitignore (сколько пропущено \u2014 пишется в шапке результата)."
  ].join("\n"),
  access: "read",
  schema: listDirArgsSchema,
  async execute(args, context) {
    const absolute = context.guard.resolveDirectory(args.path);
    const depth = args.depth ?? 1;
    const ignore = context.config.respectGitignore ? loadAncestorIgnoreRules(context.guard.root, absolute) : null;
    const result = walkDirectory(absolute, context.guard, {
      maxDepth: depth,
      maxEntries: 800,
      statFiles: true,
      ...ignore ? { ignore } : {}
    });
    const dirCount = result.entries.filter((entry) => entry.isDirectory).length;
    const fileCount = result.entries.length - dirCount;
    const lines = [
      `Каталог: ${context.guard.relative(absolute)}`,
      `Всего ${result.entries.length} (каталогов ${dirCount}, файлов ${fileCount})${result.truncated ? `, достигнут лимит ${result.maxEntries}, остальное не показано` : ""}${result.skipped > 0 ? `, пропущено ${result.skipped} (нет прав или ошибка чтения)` : ""}${result.ignoredByRules > 0 ? `, по .gitignore пропущено ${result.ignoredByRules}` : ""}`,
      ""
    ];
    for (const entry of result.entries) {
      const indent = "  ".repeat(entry.depth - 1);
      const name = entry.relativePath.split("/").pop() ?? entry.relativePath;
      lines.push(
        entry.isDirectory ? `${indent}${name}/` : `${indent}${name}  (${formatBytes(entry.size)})`
      );
    }
    return {
      text: lines.join("\n"),
      structured: {
        path: context.guard.relative(absolute),
        depth,
        entries: result.entries.length,
        directories: dirCount,
        files: fileCount,
        truncated: result.truncated,
        maxEntries: result.maxEntries,
        skipped: result.skipped,
        ignoredByRules: result.ignoredByRules
      }
    };
  }
};
function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

// src/tools/truncate.ts
var TRUNCATE_MARKER_RESERVE = 80;
function clampText(text, maxChars, options = {}) {
  if (text.length <= maxChars) return { text, truncated: false };
  const label = options.label ?? "вывод";
  const keep = Math.max(0, maxChars - TRUNCATE_MARKER_RESERVE);
  const omitted = text.length - keep;
  if (options.direction === "tail") {
    const tail = text.slice(text.length - keep);
    return {
      text: `\u2026(${label} превышает лимит ${maxChars} символов; обрезано; первые ${omitted} символов не отправлены)
${tail}`,
      truncated: true
    };
  }
  return {
    text: `${text.slice(0, keep)}
\u2026(${label} превышает лимит ${maxChars} символов; обрезано; последние ${omitted} символов не отправлены)`,
    truncated: true
  };
}
function truncateLine(line, maxChars, focusIndex = 0) {
  if (line.length <= maxChars) return line;
  const focus = Math.max(0, Math.min(focusIndex, line.length - 1));
  const half = Math.floor(maxChars / 2);
  let start = Math.max(0, focus - half);
  const end = Math.min(line.length, start + maxChars);
  start = Math.max(0, end - maxChars);
  const head = start > 0 ? `\u2026(первые ${start} символов опущены)` : "";
  const tail = end < line.length ? `\u2026(последние ${line.length - end} символов опущены)` : "";
  return `${head}${line.slice(start, end)}${tail}`;
}
function createTailByteBuffer(limit) {
  const chunks = [];
  let kept = 0;
  let dropped = 0;
  return {
    push(chunk) {
      if (chunk.length === 0) return;
      chunks.push(chunk);
      kept += chunk.length;
      while (kept > limit && chunks.length > 0) {
        const head = chunks[0];
        const excess = kept - limit;
        if (head.length <= excess) {
          chunks.shift();
          kept -= head.length;
          dropped += head.length;
        } else {
          chunks[0] = head.subarray(excess);
          kept -= excess;
          dropped += excess;
        }
      }
    },
    text() {
      const buf = Buffer.concat(chunks, kept);
      let out = buf.toString("utf8");
      if (dropped > 0) out = out.replace(/^�+/, "");
      if (out.includes("�")) {
        try {
          const alt = new TextDecoder("ibm866").decode(buf).replace(/^�+/, "");
          if (!alt.includes("�")) out = alt;
        } catch {}
      }
      return out;
    },
    keptBytes: () => kept,
    droppedBytes: () => dropped
  };
}

// src/tools/search.ts
var SEARCH_FILE_SIZE_LIMIT = 2 * 1024 * 1024;
var SEARCH_LINE_MAX_CHARS = 300;
var SEARCH_MAX_ENTRIES = 2e4;
var SEARCH_CONTEXT_MAX = 10;
function findHitLines(lines, needle, caseSensitive, maxHits) {
  const hits = [];
  let limitReached = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const haystack = caseSensitive ? line : line.toLowerCase();
    const column = haystack.indexOf(needle);
    if (column < 0) continue;
    if (hits.length >= maxHits) {
      limitReached = true;
      break;
    }
    hits.push({ index: i, column: Math.min(column, Math.max(0, line.length - 1)) });
  }
  return { hits, limitReached };
}
function renderHits(relativePath2, lines, hits, contextLines) {
  const out = [];
  let printedUpTo = -1;
  hits.forEach((hit, position) => {
    const start = Math.max(0, hit.index - contextLines);
    const end = Math.min(lines.length - 1, hit.index + contextLines);
    if (position > 0 && start > printedUpTo + 1) out.push("--");
    for (let index = Math.max(start, printedUpTo + 1); index <= end; index += 1) {
      const line = lines[index] ?? "";
      const marker = index === hit.index ? ":" : "-";
      const focus = index === hit.index ? hit.column : 0;
      out.push(`${relativePath2}${marker}${index + 1}${marker} ${truncateLine(line, SEARCH_LINE_MAX_CHARS, focus).trim()}`);
    }
    printedUpTo = Math.max(printedUpTo, end);
  });
  return out;
}
var searchTool = {
  name: "search",
  summary: "Поиск в рабочей директории по содержимому (подстрока, можно без учёта регистра) или по имени файла; можно glob фильтровать пути, по context  показывать строки контекста и возвращать позиции совпадений и сами строки.",
  title: "Поиск",
  promptGuidelines: [
    "```json",
    '{"query":"createServer", "path":"src", "mode":"content", "glob":"*.ts", "context":2, "max_results":50}',
    "```",
    "- `mode`: `content` (по содержимому, по умолчанию) или `filename` (по имени файла); по умолчанию регистр не учитывается, `case_sensitive:true` отключает это.",
    "- `glob` — фильтр файлов по пути: `*.ts` \u2014 файлы .ts любого уровня, `src/**/*.ts` \u2014 только в этом поддереве (`**` пересекает каталоги, `*` \u2014 нет).",
    "- `context` выводит по N строк до и после совпадения. Строка-совпадение пишется как `путь:номер: содержимое`, строки контекста \u2014 как `путь-номер- содержимое` \u2014 **попаданием считается только формат с двоеточиями**; контекстные строки не правьте.",
    "- Если строка-совпадение слишком длинная, показывается фрагмент вокруг попадания с указанием числа опущенных символов; поэтому места рядом с многоточием проверяйте через `read_file`.",
    "- Не-UTF-8 текстовые файлы (например, GB18030) декодируются по распознанной кодировке и участвуют в поиске как обычно; пропускаются только бинарные и нераспознаваемые (число указано в статистике).",
    "- Поиск по умолчанию учитывает `.gitignore`; игнорируемые артефакты в результаты не попадают (в шапке результата пишется, сколько пропущено)."
  ].join("\n"),
  access: "read",
  schema: searchArgsSchema,
  async execute(args, context) {
    const mode = args.mode ?? "content";
    const scope = args.path && args.path.trim().length > 0 ? args.path : ".";
    const root = context.guard.resolveDirectory(scope);
    const maxResults = args.max_results ?? 60;
    const caseSensitive = args.case_sensitive === true;
    const glob = args.glob?.trim() ?? "";
    const contextLines = Math.min(Math.max(args.context ?? 0, 0), SEARCH_CONTEXT_MAX);
    const ignore = context.config.respectGitignore ? loadAncestorIgnoreRules(context.guard.root, root) : null;
    const walked = walkDirectory(root, context.guard, {
      maxDepth: 12,
      maxEntries: SEARCH_MAX_ENTRIES,
      statFiles: true,
      ...ignore ? { ignore } : {}
    });
    const matches = [];
    const files = walked.entries.filter((entry) => !entry.isDirectory);
    let hits = 0;
    let scannedFiles = 0;
    let skippedLarge = 0;
    let skippedBinary = 0;
    let skippedByGlob = 0;
    let decodedNonUtf8 = 0;
    let hitLimitReached = false;
    const needle = caseSensitive ? args.query : args.query.toLowerCase();
    const matchGlob = (relativePath2) => {
      if (glob.length === 0) return true;
      if (matchesGlob(relativePath2, glob)) return true;
      skippedByGlob += 1;
      return false;
    };
    if (mode === "filename") {
      for (const entry of files) {
        if (hits >= maxResults) {
          hitLimitReached = true;
          break;
        }
        if (!matchGlob(entry.relativePath)) continue;
        const haystack = caseSensitive ? entry.relativePath : entry.relativePath.toLowerCase();
        if (haystack.includes(needle)) {
          hits += 1;
          matches.push(`${entry.relativePath}  (${formatBytes(entry.size)})`);
        }
      }
    } else {
      for (const entry of files) {
        if (hits >= maxResults) {
          hitLimitReached = true;
          break;
        }
        if (!matchGlob(entry.relativePath)) continue;
        if (entry.size > SEARCH_FILE_SIZE_LIMIT) {
          skippedLarge += 1;
          continue;
        }
        let content;
        try {
          const read = readTextFileLimited(entry.absolutePath, SEARCH_FILE_SIZE_LIMIT);
          content = read.text;
          if (!read.utf8Family) decodedNonUtf8 += 1;
        } catch {
          skippedBinary += 1;
          continue;
        }
        scannedFiles += 1;
        const lines = content.split("\n");
        const found = findHitLines(lines, needle, caseSensitive, maxResults - hits);
        if (found.hits.length === 0) continue;
        hits += found.hits.length;
        if (found.limitReached) hitLimitReached = true;
        matches.push(...renderHits(entry.relativePath, lines, found.hits, contextLines));
      }
    }
    const stats = [
      mode === "content" ? `просканировано файлов: ${scannedFiles}` : `обойдено файлов: ${files.length}`,
      glob.length > 0 ? `по glob отфильтровано: ${skippedByGlob}` : "",
      mode === "content" ? `пропущено больших файлов: ${skippedLarge}` : "",
      mode === "content" ? `пропущено двоичных/недекодируемых файлов: ${skippedBinary}` : "",
      mode === "content" && decodedNonUtf8 > 0 ? `декодировано как не-UTF-8 (напр. GB18030): ${decodedNonUtf8}` : "",
      walked.ignoredByRules > 0 ? `.gitignore: пропущено ${walked.ignoredByRules}` : "",
      walked.truncated ? `достигнут лимит ${walked.maxEntries} записей каталога; просканирована только часть` : ""
    ].filter((item) => item.length > 0);
    const header = [
      `Поиск: query="${args.query}" режим=${mode === "content" ? "по содержимому" : "по имени файла"} область=${context.guard.relative(root)}${glob.length > 0 ? ` glob=${glob}` : ""}${contextLines > 0 ? ` контекст=±${contextLines} строк` : ""}`,
      hits === 0 ? "Совпадений нет." : `найдено ${hits}${hitLimitReached ? ` (уже достигнут лимит ${maxResults} записей; возможно, есть ещё)` : ""}.`,
      `${stats.join("; ")}.`,
      ""
    ].join("\n");
    return {
      text: `${header}
${matches.join("\n")}`,
      structured: {
        query: args.query,
        mode,
        scope: context.guard.relative(root),
        glob,
        contextLines,
        hits,
        limitReached: hitLimitReached,
        maxResults,
        scannedFiles,
        skippedLarge,
        skippedBinary,
        skippedByGlob,
        decodedNonUtf8,
        ignoredByRules: walked.ignoredByRules,
        walkTruncated: walked.truncated
      }
    };
  }
};

// src/tools/shell.ts
import { spawn } from "child_process";
import process5 from "process";
var OUTPUT_BUFFER_LIMIT = 4 * 1024 * 1024;
function killTree(pid, signal) {
  if (process5.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process5.kill(-pid, signal);
  } catch {
    try {
      process5.kill(pid, signal);
    } catch {
    }
  }
}
function runCommand(command, cwd, timeoutMs, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({
        code: null,
        signal: null,
        stdout: "",
        stderr: "Команда прервана до выполнения (получен сигнал остановки)",
        droppedStdout: 0,
        droppedStderr: 0,
        timedOut: false,
        aborted: true,
        durationMs: 0
      });
      return;
    }
    const isWindows = process5.platform === "win32";
    const file = isWindows ? process5.env.ComSpec ?? "cmd.exe" : process5.env.SHELL ?? "/bin/sh";
    const args = isWindows ? ["/d", "/s", "/c", `chcp 65001>nul & ${command}`] : ["-c", command];
    const child = spawn(file, args, {
      cwd,
      windowsHide: true,
      detached: !isWindows,
      env: { ...process5.env, NO_COLOR: "1", FORCE_COLOR: "0" }
    });
    const started = Date.now();
    const stdoutBuffer = createTailByteBuffer(OUTPUT_BUFFER_LIMIT);
    const stderrBuffer = createTailByteBuffer(OUTPUT_BUFFER_LIMIT);
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid ?? 0, "SIGKILL");
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      killTree(child.pid ?? 0, "SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk) => stdoutBuffer.push(chunk));
    child.stderr?.on("data", (chunk) => stderrBuffer.push(chunk));
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (code, signalName) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        code,
        signal: signalName,
        stdout: stdoutBuffer.text(),
        stderr: stderrBuffer.text(),
        droppedStdout: stdoutBuffer.droppedBytes(),
        droppedStderr: stderrBuffer.droppedBytes(),
        timedOut,
        aborted,
        durationMs: Date.now() - started
      });
    };
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        code: null,
        signal: null,
        stdout: "",
        stderr: `не удалось запустить команду: ${error.message}`,
        droppedStdout: 0,
        droppedStderr: 0,
        timedOut: false,
        aborted,
        durationMs: Date.now() - started
      });
    });
    child.on("close", (code, signalName) => finish(code, signalName));
  });
}
var runCommandTool = {
  name: "run_command",
  summary: "Выполняет в указанной рабочей директории команду shell ; команды из белого списка выполняются автоматически, остальные требуют ручного подтверждения в терминале сервиса.",
  title: "Выполнение команды терминала",
  promptGuidelines: [
    "```json",
    '{"command":"npm run build", "cwd":".", "timeout_ms":120000}',
    "```",
    "- Команда на Windows выполняется через `cmd.exe`, на Unix-подобных \u2014 через `sh`.",
    "- **Автоматически выполняются только команды из белого списка** (примерно `npm run`, `npm test`, `git status/log/diff`, `tsc`, `eslint`, перечисление каталогов и другие read-only или сборочные команды).",
    "- Другие команды (особенно удаление, push, установка, повышение прав) требуют моего ручного подтверждения в терминале; при отказе вы получите ошибку \u2014 **не повторяйте тот же запрос**, вместо этого скажите, что нужно сделать.",
    "- Команды со склейками (`&&`, `|`, `;`, `>` и т.п.) всегда требуют ручного подтверждения.",
    "- Катастрофические команды (`rm -rf /`, форматирование диска, выключение и т.п.) отклоняются сразу.",
    "- При слишком длинном выводе **сохраняется только конец** (ошибки и итоги тестов \u2014 в последних строках), сколько символов опущено \u2014 пишется в начале вывода; чтобы увидеть начало, сузьте диапазон через `findstr` / `rg`."
  ].join("\n"),
  access: "execute",
  schema: runCommandArgsSchema,
  async execute(args, context) {
    const assessment = assessCommand(args.command, {
      whitelist: context.config.commandWhitelist,
      autoApprove: context.config.autoApproveCommands
    });
    context.log.info("Решение по команде", {
      "команда": args.command,
      "решение": assessment.decision,
      Причина: assessment.reason
    });
    if (assessment.decision === "deny") {
      throw new CommandDeniedError(assessment.reason, "COMMAND_BLOCKED");
    }
    if (assessment.decision === "confirm") {
      if (!isInteractiveTerminal()) {
        throw new CommandDeniedError(
          `Команда требует ручного подтверждения, но у текущего процесса нет интерактивного терминала; выполнение отклонено: ${args.command} (причина: ${assessment.reason})`,
          "COMMAND_DISABLED_NON_INTERACTIVE"
        );
      }
      const allowed = await context.confirm(args.command, assessment.reason);
      if (!allowed) {
        throw new CommandDeniedError(`Пользователь отклонил выполнение: ${args.command}`, "COMMAND_DENIED");
      }
    }
    const cwd = args.cwd && args.cwd.trim().length > 0 ? context.guard.resolveDirectory(args.cwd) : context.config.commandCwd;
    const timeoutMs = args.timeout_ms ?? context.config.commandTimeoutMs;
    const outcome = await runCommand(args.command, cwd, timeoutMs, context.signal);
    const stdoutBytes = Buffer.byteLength(outcome.stdout, "utf8");
    const stderrBytes = Buffer.byteLength(outcome.stderr, "utf8");
    const stdout = outcome.stdout.trimEnd();
    const stderr = outcome.stderr.trimEnd();
    const header = [
      `Команда: ${args.command}`,
      `workspace: ${cwd}`,
      `Решение: ${assessment.decision} (${assessment.reason})`,
      `exitCode: ${outcome.code === null ? "(нет)" : outcome.code}${outcome.signal ? ` сигнал: ${outcome.signal}` : ""}`,
      `Время: ${outcome.durationMs}ms`
    ];
    if (outcome.timedOut) header.push(`\u26a0 Таймаут (${timeoutMs}ms) — дерево процессов принудительно завершено`);
    if (outcome.aborted) {
      header.push("\u26a0 Прервано: получен сигнал остановки (сервис завершается); дерево процессов принудительно завершено. Ниже \u2014 вывод, полученный до прерывания");
    }
    const droppedTotal = outcome.droppedStdout + outcome.droppedStderr;
    if (droppedTotal > 0) {
      header.push(
        `\u26a0 Вывод превысил лимит буфера ${formatBytes(OUTPUT_BUFFER_LIMIT)}; сохранён только последний вывод (отброшено: stdout ${formatBytes(
          outcome.droppedStdout
        )}, stderr ${formatBytes(outcome.droppedStderr)})`
      );
    }
    const headerText = header.join("\n");
    const bodyLines = ["--- stdout ---", stdout.length > 0 ? stdout : "(пусто)"];
    if (stderr.length > 0) bodyLines.push("", "--- stderr ---", stderr);
    const bodyRaw = bodyLines.join("\n");
    const bodyBudget = Math.max(
      256,
      Math.min(context.config.maxCommandOutputChars, context.config.maxResultChars) - headerText.length - TRUNCATE_MARKER_RESERVE
    );
    const body = clampText(bodyRaw, bodyBudget, { direction: "tail", label: "Вывод команды" });
    return {
      text: `${headerText}

${body.text}`,
      meta: {
        bytes: stdoutBytes + stderrBytes,
        truncated: body.truncated || droppedTotal > 0,
        // \u7ed3\u8bba\u5728\u672b\u5c3e: \u56de\u586b\u5c42\u82e5\u8fd8\u8981\u515c\u5e95\u622a\u65ad, \u4e5f\u53ea\u80fd\u52a8\u524d\u9762
        truncateDirection: "tail",
        // \u5982\u5b9e\u5e26\u4e0aКод возврата: \u7ed3\u679c\u6807\u7b7e\u636e\u6b64\u628a\u300c\u547d\u4ee4\u672c\u8eab\u5931\u8d25\u300d\u548c\u300c\u5de5\u5177завершился ошибкой\u300d\u533a\u5206\u5f00
        exitCode: outcome.code
      },
      structured: {
        command: args.command,
        cwd,
        decision: assessment.decision,
        reason: assessment.reason,
        exitCode: outcome.code,
        signal: outcome.signal,
        durationMs: outcome.durationMs,
        timedOut: outcome.timedOut,
        aborted: outcome.aborted,
        stdoutBytes,
        stderrBytes,
        droppedBytes: droppedTotal,
        outputChars: body.text.length
      }
    };
  }
};

// src/tools/registry.ts
var ALL_TOOLS = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  searchTool,
  runCommandTool,
  sshProbeTool,
  sshExecTool,
  sshCopyTool
];
function formatZodIssues(error) {
  return error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(корень)"}: ${issue.message}`).join("; ");
}
var ToolRegistry = class {
  constructor(context, definitions = ALL_TOOLS) {
    this.context = context;
    for (const definition of definitions) {
      this.allByName.set(definition.name, definition);
    }
    const available = context.config.readOnly ? definitions.filter((definition) => definition.access === "read") : definitions;
    for (const definition of available) {
      this.byName.set(definition.name, definition);
    }
  }
  context;
  byName = /* @__PURE__ */ new Map();
  /** \u5168\u90e8\u5de5\u5177\u7684\u7d22\u5f15: readOnly\u4e0b\u7528\u6765\u533a\u5206\u300c\u5de5\u5177\u4e0d\u5b58\u5728\u300d\u4e0e\u300c\u5de5\u5177\u88ab\u6a21\u5f0f\u7981\u7528\u300d\u3002 */
  allByName = /* @__PURE__ */ new Map();
  /** \u5f53\u524d\u53ef\u7528\u7684\u5de5\u5177\u6e05\u5355, \u4f9b\u7cfb\u7edf\u63d0\u793a\u8bcd\u4e0e doctor \u4f7f\u7528\u3002 */
  list() {
    return TOOL_NAMES.filter((name) => this.byName.has(name)).map((name) => {
      const definition = this.byName.get(name);
      return { name, summary: definition.summary, access: definition.access };
    });
  }
  async execute(call) {
    const definition = this.byName.get(call.tool);
    if (!definition) {
      const disabled = this.allByName.get(call.tool);
      if (disabled) {
        return failResult(
          call.id,
          call.tool,
          "TOOL_DISABLED",
          `инструмент "${call.tool}" недоступен в readOnly (DUB_READ_ONLY=true, разрешены только чтения). Доступные инструменты: ${this.list().map((item) => item.name).join(", ")}`
        );
      }
      return failResult(
        call.id,
        call.tool,
        "UNKNOWN_TOOL",
        `неизвестный инструмент "${call.tool}". Доступные инструменты: ${this.list().map((item) => item.name).join(", ")}`
      );
    }
    const parsed = definition.schema.safeParse(call.args ?? {});
    if (!parsed.success) {
      return failResult(
        call.id,
        call.tool,
        "INVALID_ARGS",
        `некорректные аргументы: ${formatZodIssues(parsed.error)}`
      );
    }
    const started = Date.now();
    try {
      const output = await definition.execute(parsed.data, this.context);
      const direction = output.meta?.truncateDirection === "tail" ? "tail" : "head";
      const clamped = clampText(output.text, this.context.config.maxResultChars, { direction });
      const meta = {
        durationMs: Date.now() - started
      };
      if (clamped.truncated || output.meta?.truncated) meta.truncated = true;
      if (direction === "tail") meta.truncateDirection = "tail";
      if (typeof output.meta?.bytes === "number") meta.bytes = output.meta.bytes;
      if (output.meta?.exitCode !== void 0) meta.exitCode = output.meta.exitCode;
      return okResult(call.id, call.tool, clamped.text, meta, output.structured);
    } catch (error) {
      const durationMs = Date.now() - started;
      if (error instanceof SandboxViolationError) {
        return failResult(call.id, call.tool, error.code, error.message, { durationMs });
      }
      if (error instanceof CommandDeniedError) {
        return failResult(call.id, call.tool, error.code, error.message, { durationMs });
      }
      if (error && error.name === "SshError" && typeof error.code === "string") {
        return failResult(call.id, call.tool, error.code, error.message, { durationMs });
      }
      return failResult(
        call.id,
        call.tool,
        "TOOL_ERROR",
        error instanceof Error ? error.message : String(error),
        { durationMs }
      );
    }
  }
};

// src/loop/composer.ts
var FILL_STAGE_LABEL = {
  sent: "отправлено",
  written: "Записано, но не отправлено",
  locate: "Поле ввода чата не найдено",
  write: "Не удалось записать в поле ввода",
  submit: "После инициирования отправки ничего не произошло",
  empty: "Содержимое для отправки пустое",
  occupied: "В поле ввода уже есть текст (возможно, вы печатаете)",
  exception: "Исключение при выполнении на странице"
};
function describeFillStage(stage) {
  return FILL_STAGE_LABEL[stage] ?? stage;
}
function normalizeComposerText(text) {
  return text.replace(/\r\n?/g, "\n");
}
var Composer = class {
  constructor(options) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? 2e4;
    this.minIntervalMs = options.minIntervalMs ?? 0;
    this.waitMs = options.waitMs ?? 0;
  }
  options;
  pending = /* @__PURE__ */ new Map();
  timeoutMs;
  minIntervalMs;
  waitMs;
  sequence = 0;
  /** \u4e0a\u4e00\u6b21\u300c\u9875\u9762\u786e\u8ba4\u5df2\u53d1\u9001\u300d\u7684\u65f6\u523b\uff1b\u5931\u8d25\u6216\u672a\u771f\u6b63\u63d0\u4ea4\u7684\u5199\u5165\u4e0d\u63a8\u8fdb\u5b83\u3002 */
  lastSentAt = 0;
  /**
   * \u5728\u9875\u9762\u53f3\u4e0b\u89d2\u663e\u793a\u4e00\u6761\u975e\u906e\u6321\u63d0\u793a(\u4e0d\u94fa\u6ee1\u5c4f\u5e55\u3001\u4e0d\u963b\u65ad\u64cd\u4f5c)\u3002
   * \u9875\u9762\u4e0d\u53ef\u7528\u65f6\u9759\u9ed8\u5931\u8d25, \u7531\u8c03\u7528\u65b9\u51b3\u5b9a\u5982\u4f55\u8bb0\u5f55\u3002
   */
  async showNotice(payload) {
    const expression = "(function(){ var f = window[" + JSON.stringify(AGENT_NOTICE_NAME) + "]; if (typeof f !== 'function') return 'missing'; return f(" + JSON.stringify(payload) + ") === true ? 'ok' : 'failed'; })()";
    try {
      const probe = await this.options.session.evaluate(expression, { awaitPromise: false });
      return probe === "ok";
    } catch (error) {
      this.options.log.debug("Не удалось показать уведомление на странице", {
        Причина: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }
  /**
   * \u5207\u6362\u9875\u9762\u4e0a\u7684\u300c\u5de5\u5177\u8c03\u7528\u4e2d\u300d\u72b6\u6001\u6307\u793a(\u65cb\u8f6c\u6273\u624b)\u3002
   * \u7eaf\u53ef\u89c6\u5316, \u5931\u8d25\u53ea\u8bb0 debug, \u7edd\u4e0d\u5f71\u54cd\u5de5\u5177\u6267\u884c\u672c\u8eab\u3002
   */
  async setBusy(busy, label = "") {
    const expression = "(function(){ var f = window[" + JSON.stringify(AGENT_BUSY_NAME) + "]; if (typeof f !== 'function') return 'missing'; return f(" + JSON.stringify({ busy, label }) + ") === true ? 'ok' : 'failed'; })()";
    try {
      await this.options.session.evaluate(expression, { awaitPromise: false });
    } catch (error) {
      this.options.log.debug("Не удалось обновить индикатор состояния инструмента", {
        Причина: error instanceof Error ? error.message : String(error)
      });
    }
  }
  /** \u8bfb\u53d6\u9875\u9762\u804a\u5929\u8f93\u5165\u6846\u5f53\u524d\u7684\u6587\u672c\uff1b\u4e0d\u53ef\u7528\u65f6\u8fd4\u56de null\u3002 */
  async readComposerText() {
    const expression = READ_COMPOSER_EXPRESSION;
    try {
      const value = await this.options.session.evaluate(expression, { awaitPromise: false });
      return typeof value === "string" ? value : null;
    } catch (error) {
      this.options.log.debug("Не удалось прочитать текст поля ввода", {
        Причина: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }
  /** \u5904\u7406\u9875\u9762\u56de\u62a5\u7684 fill-result\u3002 */
  handleMessage(message) {
    const pending = this.pending.get(message.fillId);
    if (!pending) return;
    this.pending.delete(message.fillId);
    clearTimeout(pending.timer);
    const outcome = {
      ok: message.ok === true,
      stage: message.stage,
      detail: message.detail ?? ""
    };
    if (outcome.ok && outcome.stage === "sent") {
      this.lastSentAt = Date.now();
    }
    pending.resolve(outcome);
  }
  /** \u8ddd\u79bb\u4e0a\u6b21\u300c\u6210\u529f\u63d0\u4ea4\u300d\u4e0d\u8db3\u6700\u5c0f\u95f4\u9694\u65f6\u5148\u7b49\u5f85\u3002 */
  async waitForSendSlot() {
    if (this.minIntervalMs <= 0) return;
    const elapsed = Date.now() - this.lastSentAt;
    const wait = this.minIntervalMs - elapsed;
    if (this.lastSentAt > 0 && wait > 0) {
      this.options.log.debug("Ожидание минимального интервала отправки", { waitMs: wait });
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  /** \u5199\u5165\u5e76\u53d1\u9001\u6587\u672c\u3002 */
  async send(text, options = {}) {
    const outgoing = normalizeComposerText(text);
    if (outgoing.length === 0) {
      return { ok: false, stage: "empty", detail: "Содержимое для отправки пустое" };
    }
    const fillId = `f${++this.sequence}-${Date.now()}`;
    const waitMs = options.waitMs === void 0 ? this.waitMs : options.waitMs;
    const payload = JSON.stringify({ fillId, text: outgoing, submit: options.submit !== false, waitMs });
    const outcomePromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(fillId);
        resolve({
          ok: false,
          stage: "timeout",
          detail: `таймаут ожидания ответа страницы (${this.timeoutMs}ms)`
        });
      }, this.timeoutMs);
      this.pending.set(fillId, { resolve, timer });
    });
    const expression = `(function(){ var f = window[${JSON.stringify(AGENT_FILL_NAME)}]; if (typeof f !== 'function') return 'missing'; return f(${payload}) === true ? 'ok' : 'failed'; })()`;
    try {
      const probe = await this.options.session.evaluate(expression, { awaitPromise: false });
      if (probe !== "ok") {
        const pending = this.pending.get(fillId);
        if (pending) {
          this.pending.delete(fillId);
          clearTimeout(pending.timer);
        }
        return {
          ok: false,
          stage: "missing",
          detail: "Функция возврата на странице недоступна (хук не внедрён или страница обновлялась); перезапустите doctor для проверки"
        };
      }
      return await outcomePromise;
    } catch (error) {
      const pending = this.pending.get(fillId);
      if (pending) {
        this.pending.delete(fillId);
        clearTimeout(pending.timer);
      }
      return {
        ok: false,
        stage: "error",
        detail: error instanceof Error ? error.message : String(error)
      };
    }
  }
};

// src/loop/confirmer.ts
var DEFAULT_TIMEOUT_MS = 12e4;
var WebConfirmer = class {
  constructor(options) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }
  options;
  pending = /* @__PURE__ */ new Map();
  timeoutMs;
  sequence = 0;
  /** \u5904\u7406\u9875\u9762\u56de\u62a5\u7684 confirm-result\u3002 */
  handleMessage(message) {
    const pending = this.pending.get(message.confirmId);
    if (!pending) return;
    this.pending.delete(message.confirmId);
    clearTimeout(pending.timer);
    pending.resolve(message.allowed === true);
  }
  /**
   * Запрашивает подтверждение. Возвращает true  означает разрешение на выполнение.
   *
   * \u987a\u5e8f: \u5148\u8bd5\u7f51\u9875\u786e\u8ba4\u6846\uff1b\u82e5\u94a9\u5b50\u4e0d\u53ef\u7528(\u9875\u9762\u672a\u6ce8\u5165 / CDP \u65ad\u5f00)\u5219\u56de\u9000\u7ec8\u7aef\u786e\u8ba4\u3002
   */
  async confirm(command, reason) {
    const viaPage = await this.tryConfirmViaPage(command, reason);
    if (viaPage !== null) return viaPage;
    this.options.log.warn("Подтверждение через страницу недоступно, откат к терминалу сервиса", { "команда": command });
    return confirmCommand(command, reason);
  }
  /**
   * \u5c1d\u8bd5\u7f51\u9875\u786e\u8ba4\u3002
   * - \u8fd4\u56de true/false: \u7f51\u9875\u786e\u8ba4\u6846\u7ed9\u51fa\u4e86\u7ed3\u8bba\uff1b
   * - \u8fd4\u56de null: \u7f51\u9875\u8def\u5f84\u4e0d\u53ef\u7528(\u672a\u6ce8\u5165 / \u629b\u9519), \u8c03\u7528\u65b9\u5e94\u56de\u9000\u7ec8\u7aef\u3002
   */
  async tryConfirmViaPage(command, reason) {
    const confirmId = `c${++this.sequence}-${Date.now()}`;
    const payload = JSON.stringify({ confirmId, command, reason, timeoutMs: this.timeoutMs });
    const expression = "(function(){ var f = window[" + JSON.stringify(AGENT_CONFIRM_NAME) + "]; if (typeof f !== 'function') return 'missing'; return f(" + payload + ") === true ? 'ok' : 'failed'; })()";
    const outcomePromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(confirmId);
        resolve(false);
      }, this.timeoutMs);
      this.pending.set(confirmId, { resolve, timer });
    });
    try {
      const probe = await this.options.session.evaluate(expression, { awaitPromise: false });
      if (probe !== "ok") {
        const pending = this.pending.get(confirmId);
        if (pending) {
          this.pending.delete(confirmId);
          clearTimeout(pending.timer);
        }
        return null;
      }
      return await outcomePromise;
    } catch (error) {
      const pending = this.pending.get(confirmId);
      if (pending) {
        this.pending.delete(confirmId);
        clearTimeout(pending.timer);
      }
      this.options.log.warn("Ошибка вызова подтверждения на странице, откат к терминалу", {
        Причина: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }
};

// src/loop/repeatGuard.ts
var MUTATING_TOOLS = /* @__PURE__ */ new Set(["write_file", "edit_file", "ssh_exec", "ssh_copy"]);
var RepeatGuard = class {
  constructor(maxConsecutiveRounds) {
    this.maxConsecutiveRounds = maxConsecutiveRounds;
  }
  maxConsecutiveRounds;
  streaks = /* @__PURE__ */ new Map();
  /**
   * \u767b\u8bb0\u4e00\u8f6e\u8c03\u7528\u3002
   * @param signatures \u672c\u8f6e\u6240\u6709\u8c03\u7528\u7684\u7a33\u5b9a\u6307\u7eb9
   */
  register(signatures) {
    const current = new Set(signatures);
    for (const known of [...this.streaks.keys()]) {
      if (!current.has(known)) this.streaks.delete(known);
    }
    let worst = { abort: false, streak: 0 };
    for (const signature of current) {
      const streak = (this.streaks.get(signature) ?? 0) + 1;
      this.streaks.set(signature, streak);
      if (streak > worst.streak) {
        worst = { abort: streak > this.maxConsecutiveRounds, signature, streak };
      }
    }
    return worst.abort ? worst : { abort: false, streak: worst.streak };
  }
  /** \u5de5\u4f5c\u533a\u53d1\u751f\u53d8\u5316(\u6709\u5199\u6587\u4ef6\u7c7b\u5de5\u5177\u6210\u529f\u6267\u884c)\u540e\u6e05\u7a7a\u5386\u53f2\u3002 */
  reset() {
    this.streaks.clear();
  }
  /** \u662f\u5426\u9700\u8981\u56e0\u672c\u8f6e\u7ed3\u679c\u5f52\u96f6(\u4f9b\u8c03\u7528\u65b9\u6309\u6267\u884c\u7ed3\u679c\u51b3\u5b9a)\u3002 */
  static isMutating(tool) {
    return MUTATING_TOOLS.has(tool);
  }
  /** \u5f53\u524d\u5404\u7b7e\u540d\u7684\u8fde\u7eed\u8f6e\u6570, \u4f9b\u8bca\u65ad\u8f93\u51fa\u3002 */
  snapshot() {
    return Object.fromEntries(this.streaks);
  }
};

// src/loop/stats.ts
var StatsTracker = class {
  contextChars = 0;
  sendRounds = 0;
  toolRounds = 0;
  toolCalls = 0;
  thinkingChars = 0;
  /** \u8bb0\u5f55\u53d1\u51fa\u53bb\u7684\u4e00сообщений\u3002 */
  recordOutgoing(text) {
    this.contextChars += text.length;
    this.sendRounds += 1;
  }
  /**
   * \u8bb0\u5f55\u6536\u56de\u6765\u7684\u4e00\u6761\u56de\u590d\u3002
   *
   * \u6b63\u6587\u4e0e\u601d\u8003\u5185\u5bb9\u90fd\u8981\u8ba1\u5165: \u601d\u8003\u5185\u5bb9(THINK \u7247\u6bb5)\u867d\u7136\u4e0d\u6267\u884c\u3001\u4e5f\u4e0d\u663e\u793a\u7ed9\u7528\u6237, 
   * \u4f46\u5b83\u540c\u6837\u4f1a\u8fdb\u5165\u7ad9\u70b9\u4fa7\u7684\u5bf9\u8bdd\u4e0a\u4e0b\u6587, \u6f0f\u7b97\u4f1a\u8ba9\u9762\u677f\u660e\u663e\u504f\u5c0f\u3002
   */
  recordIncoming(text, thinking = "") {
    this.contextChars += text.length + thinking.length;
    this.thinkingChars += thinking.length;
  }
  /** \u8bb0\u5f55\u4e00\u8f6e\u5de5\u5177\u6267\u884c\u3002 */
  recordToolRound(callCount) {
    this.toolRounds += 1;
    this.toolCalls += Math.max(0, callCount);
  }
  snapshot() {
    return {
      contextChars: this.contextChars,
      sendRounds: this.sendRounds,
      toolRounds: this.toolRounds,
      toolCalls: this.toolCalls,
      thinkingChars: this.thinkingChars
    };
  }
};

// src/loop/orchestrator.ts
var MAX_ROUNDS_PER_BURST = 30;
var MAX_CONSECUTIVE_PARSE_FAILURES = 2;
var Orchestrator = class {
  constructor(options) {
    this.options = options;
    this.log = options.log.child("loop");
    this.guard = new PathGuard(options.config.workspaceRoot);
    this.repeatGuard = new RepeatGuard(options.config.maxRepeatCalls);
    this.composer = new Composer({
      session: options.session,
      log: this.log,
      minIntervalMs: options.config.sendMinIntervalMs,
      waitMs: options.config.fillWaitMs
    });
    this.confirmer = new WebConfirmer({ session: options.session, log: this.log.child("confirm") });
    this.registry = new ToolRegistry({
      config: options.config,
      guard: this.guard,
      log: this.log.child("tools"),
      confirm: (command, reason) => this.confirmer.confirm(command, reason),
      signal: this.abort.signal
    });
  }
  options;
  log;
  composer;
  confirmer;
  registry;
  guard;
  assembler = null;
  streamId = null;
  streamTimer = null;
  /** \u6536\u5230\u7684\u56de\u590d\u6d41\u8ba1\u6570: \u56de\u586b\u540e\u636e\u6b64\u786e\u8ba4\u7ad9\u70b9\u662f\u5426\u771f\u7684\u5f00\u59cb\u751f\u6210\u3002 */
  streamStarts = 0;
  queue = [];
  draining = false;
  stopped = false;
  paused = false;
  /** \u6700\u8fd1\u4e00\u6b21\u300c\u5b8c\u6574\u56de\u590d\u5230\u8fbe\u300d\u7684\u65f6\u523b, \u7528\u4e8e\u4fdd\u8bc1\u56de\u590d\u5230\u56de\u586b\u4e4b\u95f4\u81f3\u5c11\u7559\u4e00\u6bb5\u95f4\u9694\u3002 */
  lastReplyAt = 0;
  /** \u56e0\u8f93\u5165\u6846\u88ab\u5360\u7528\u800c\u6682\u7f13\u56de\u586b\u7684\u5185\u5bb9: \u7b49\u7528\u6237\u5728\u9875\u9762\u63d0\u793a\u4e0a\u70b9\u300c\u91cd\u65b0\u53d1\u9001\u300d\u518d\u8865\u53d1\u3002 */
  pendingNotices = /* @__PURE__ */ new Map();
  noticeSeq = 0;
  rounds = 0;
  consecutiveParseFailures = 0;
  suppressedReplies = 0;
  repeatGuard;
  stats = new StatsTracker();
  /** \u505c\u6b62\u4fe1\u53f7: stop() \u65f6\u89e6\u53d1, \u5de5\u5177\u636e\u6b64\u7ed3\u675f\u6b63\u5728\u8dd1\u7684\u547d\u4ee4(\u957f\u6784\u5efa\u4e0d\u5fc5\u7b49\u5b83\u81ea\u5df1\u8d85\u65f6)\u3002 */
  abort = new AbortController();
  /** \u505c\u6b62\u4fe1\u53f7(\u6d4b\u8bd5\u4e0e\u8bca\u65ad\u7528): aborted \u4e3a\u771f\u65f6, \u6b63\u5728\u6267\u884c\u4e0e\u540e\u7eed\u7684\u547d\u4ee4\u90fd\u4f1a\u88ab\u7ed3\u675f\u3002 */
  get abortSignal() {
    return this.abort.signal;
  }
  start() {
    this.stopped = false;
    this.log.info("Оркестратор запущен, ждём ответ DeepSeek");
    this.log.info("Доступные инструменты", { "инструменты": this.registry.list().map((item) => item.name) });
  }
  stop() {
    this.stopped = true;
    this.abort.abort();
    this.clearStreamTimer();
    this.assembler = null;
  }
  /** \u8fde\u63a5\u65ad\u5f00\u65f6\u6682\u505c\u56de\u586b: \u6b64\u65f6\u5199\u8f93\u5165\u6846\u5fc5\u7136\u5931\u8d25, \u7ee7\u7eed\u8dd1\u53ea\u4f1a\u4ea7\u751f\u4e00\u5806\u65e0\u6548\u9519\u8bef\u3002 */
  pause(reason) {
    if (this.paused) return;
    this.paused = true;
    this.clearStreamTimer();
    this.assembler = null;
    this.queue.length = 0;
    this.log.warn("Цикл приостановлен", { reason });
  }
  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.log.info("Цикл возобновлён");
  }
  /**
   * \u4e3b\u52a8\u628a\u5f53\u524d\u7edf\u8ba1\u63a8\u9001\u5230\u9875\u9762\u9762\u677f\u3002
   *
   * \u9762\u677f\u662f\u61d2\u521b\u5efa\u7684(\u53ea\u5728\u6536\u5230\u63a8\u9001\u65f6\u624d\u5efa DOM), \u6240\u4ee5\u5237\u65b0\u9875\u9762\u540e\u4e0d\u4f1a\u81ea\u5df1\u51fa\u73b0, 
   * \u8981\u7b49\u4e0b\u4e00\u8f6e\u300c\u53d1\u9001\u6216\u6536\u5230\u56de\u590d\u300d\u624d\u6e32\u67d3\u3002\u9644\u7740/\u6ce8\u5165\u5b8c\u6210\u540e\u8c03\u4e00\u6b21\u8fd9\u4e2a\u65b9\u6cd5, 
   * \u8ba9\u9762\u677f\u5237\u65b0\u5373\u53ef\u89c1\u3002\u5931\u8d25\u53ea\u8bb0 debug, \u4e0d\u5f71\u54cd\u4e3b\u6d41\u7a0b\u3002
   */
  refreshStats() {
    void this.pushStats();
  }
  /**
   * \u8df3\u8fc7\u4e0b\u4e00\u8f6e\u56de\u590d\u7684\u5de5\u5177\u6267\u884c\u3002
   *
   * \u7528\u9014: \u81ea\u52a8\u53d1\u9001\u7cfb\u7edf\u63d0\u793a\u8bcd\u540e, \u6a21\u578b\u5bf9\u63d0\u793a\u8bcd\u672c\u8eab\u7684\u56de\u590d\u53ef\u80fd\u7167\u6284\u793a\u4f8b\u91cc\u7684 tool_call \u4ee3\u7801\u5757, 
   * \u90a3\u4e0d\u662f\u771f\u6b63\u7684\u6307\u4ee4, \u6267\u884c\u5b83\u5c5e\u4e8e\u8bef\u4f24\u3002
   */
  suppressNextReply(reason) {
    this.suppressedReplies += 1;
    this.log.info("Установлено: следующий раунд пропустит выполнение инструментов", { reason });
  }
  /** \u53d1\u9001\u4e00сообщений(\u590d\u7528\u56de\u586b\u5668\u7684\u95f4\u9694\u63a7\u5236\u4e0e\u53d1\u9001\u6821\u9a8c)\u3002 */
  async sendUserMessage(text) {
    await this.composer.waitForSendSlot();
    const outcome = await this.composer.send(text);
    if (outcome.ok) {
      this.stats.recordOutgoing(text);
      void this.pushStats();
    }
    return outcome;
  }
  /** \u628a\u7edf\u8ba1\u63a8\u9001\u5230\u9875\u9762\u53f3\u4e0a\u89d2\u9762\u677f\u3002\u5931\u8d25\u53ea\u8bb0 debug, \u4e0d\u5f71\u54cd\u4e3b\u6d41\u7a0b\u3002 */
  async pushStats() {
    if (this.paused || this.stopped) return;
    const payload = JSON.stringify(this.stats.snapshot());
    const expression = "(function(){ var f = window[" + JSON.stringify(AGENT_STATS_NAME) + "]; if (typeof f !== 'function') return 'missing'; return f(" + payload + ") === true ? 'ok' : 'failed'; })()";
    try {
      await this.options.session.evaluate(expression, { awaitPromise: false });
    } catch (error) {
      this.log.debug("Ошибка отправки статистики в панель", {
        Причина: error instanceof Error ? error.message : String(error)
      });
    }
  }
  /** \u5904\u7406\u9875\u9762\u56de\u4f20\u7684\u6d88\u606f(\u5df2\u7531\u5165\u53e3\u505a\u8fc7 16ms \u6279\u91cf\u5408\u5e76)\u3002 */
  handleAgentMessages(messages) {
    for (const message of messages) {
      switch (message.t) {
        case "stream-start":
          this.beginStream(message.streamId, message.url);
          break;
        case "stream-chunk":
          this.assembler?.push(message.data);
          break;
        case "stream-end":
          this.finishStream();
          break;
        case "stream-error":
          this.assembler?.failStream(message.message);
          this.finishStream();
          break;
        case "fill-result":
          this.composer.handleMessage(message);
          break;
        case "confirm-result":
          this.confirmer.handleMessage(message);
          break;
        case "notice-action":
          void this.handleNoticeAction(message.noticeId, message.action);
          break;
        case "log":
          this.logPageMessage(message.level, message.message);
          break;
        default:
          break;
      }
    }
  }
  logPageMessage(level, message) {
    if (level === "error") this.log.error(`[страница] ${message}`);
    else if (level === "warn") this.log.warn(`[страница] ${message}`);
    else this.log.debug(`[страница] ${message}`);
  }
  beginStream(streamId, url) {
    if (this.stopped) return;
    this.streamStarts += 1;
    if (this.assembler) {
      this.log.warn("Предыдущий ответ не успел завершиться и был вытеснен новым запросом", { oldStream: this.streamId, newStream: streamId });
      this.finishStream({ executable: false });
    }
    this.streamId = streamId;
    this.assembler = new ReplyAssembler({
      maxChars: this.options.config.maxResponseChars,
      contentPath: this.options.config.contentPath
    });
    this.log.debug("Получен поток ответа", { streamId, url });
    this.clearStreamTimer();
    this.streamTimer = setTimeout(() => {
      this.log.warn("Таймаут ожидания ответа; завершаем по полученному", {
        "таймаут, мс": this.options.config.responseTimeoutMs
      });
      this.assembler?.failStream("Таймаут ожидания ответа");
      this.finishStream();
    }, this.options.config.responseTimeoutMs);
  }
  finishStream(options = {}) {
    this.clearStreamTimer();
    const assembler = this.assembler;
    this.assembler = null;
    this.streamId = null;
    if (!assembler) return;
    assembler.endStream();
    const snapshot = assembler.snapshot();
    this.queue.push({ snapshot, executable: options.executable !== false });
    void this.drain();
  }
  clearStreamTimer() {
    if (this.streamTimer) {
      clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }
  }
  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.stopped && this.queue.length > 0) {
        const entry = this.queue.shift();
        if (!entry) break;
        if (this.paused) {
          this.queue.unshift(entry);
          break;
        }
        await this.processReply(entry);
      }
    } finally {
      this.draining = false;
    }
  }
  async processReply(entry) {
    const { snapshot, executable } = entry;
    this.lastReplyAt = Date.now();
    this.stats.recordIncoming(snapshot.text, snapshot.thinking);
    void this.pushStats();
    const preview = snapshot.text.replace(/\s+/g, " ").slice(0, 120);
    this.log.info("Получен полный ответ", {
      charCount: snapshot.text.length,
      finalStatus: snapshot.status,
      frameCount: snapshot.diagnostics.frames,
      "патчи": `${snapshot.diagnostics.patch.applied} прим. / ${snapshot.diagnostics.patch.inferred} вывед. / ${snapshot.diagnostics.patch.skipped} проп.`,
      snippetType: snapshot.diagnostics.fragmentTypes,
      "аномалия": snapshot.abnormal ? snapshot.abnormalMessage : void 0
    });
    this.log.debug("Начало ответа", { preview });
    if (snapshot.text.length > 0 && snapshot.diagnostics.patch.skipped > 0) {
      this.log.warn("Предупреждения по патчам", { "детали": snapshot.warnings.slice(-3) });
    }
    if (snapshot.text.length === 0 && snapshot.thinking.length > 0) {
      this.log.warn("В этом раунде только размышления (THINK -фрагменты); тела ответа нет; вызовы из размышлений не выполняются", {
        "thinkingCharCount": snapshot.thinking.length,
        snippetType: snapshot.diagnostics.fragmentTypes
      });
    }
    if (snapshot.text.length === 0 && snapshot.thinking.length === 0 && snapshot.diagnostics.frames > 0) {
      this.log.warn("Тело ответа пустое; ниже \u2014 полученные сырые кадры (для диагностики изменения протокола)", {
        topLevelKeys: snapshot.diagnostics.topLevelKeys,
        snippetType: snapshot.diagnostics.fragmentTypes
      });
      for (const raw of snapshot.diagnostics.rawHead) {
        this.log.warn(`  первый кадр: ${raw}`);
      }
      for (const raw of snapshot.diagnostics.rawTail) {
        this.log.warn(`  последний кадр: ${raw}`);
      }
      if (snapshot.warnings.length > 0) {
        this.log.warn("Предупреждения слоя патчей", { "предупреждения": snapshot.warnings.slice(0, 6) });
      }
    }
    if (snapshot.status !== "WIP" && !isSuccessfulStatus(snapshot.status)) {
      this.log.warn(`finalStatus этого ответа — не нормальное завершение: ${describeStatus2(snapshot.status)}`);
    } else if (snapshot.abnormal) {
      this.log.warn(`ответ может быть неполным: ${snapshot.abnormalMessage ?? "неизвестная причина"}`);
    }
    if (!executable) {
      this.resetRoundTracking();
      this.log.warn("Ответ этого раунда завершился ненормально (заменён новым запросом); выполнение инструментов и возврат пропущены", {
        charCount: snapshot.text.length
      });
      return;
    }
    if (this.suppressedReplies > 0) {
      this.suppressedReplies -= 1;
      this.resetRoundTracking();
      this.log.info("Ответ пришёл от самопроверки промпта, выполнение инструментов пропущено");
      return;
    }
    const parsed = parseToolCalls(snapshot.text);
    if (parsed.diagnostics.bareFallback) {
      this.log.warn("Модель не использовала tool_call блок, но весь ответ \u2014 один JSON-вызов инструмента JSON, обработано как вызов");
    }
    if (parsed.diagnostics.blocks === 0 && !parsed.diagnostics.bareFallback) {
      const suspicion = looksLikeToolCallText(snapshot.text);
      if (suspicion) {
        const start = Math.max(0, suspicion.index - 100);
        const end = Math.min(snapshot.text.length, suspicion.index + 300);
        this.log.warn(`в тексте ${suspicion.reason}, но не помещено в блок \`\`\`tool_call, поэтому не выполнено`, {
          "фрагмент": snapshot.text.slice(start, end).replace(/\s+/g, " ")
        });
        this.log.warn(
          "Можно попросить: «помести только что сделанный вызов в блок tool_call и отправь снова»; резервное распознавание сработает, только когда весь ответ целиком является тем одним JSON-объектом; в окружении пояснений \u2014 не выполняется никогда"
        );
      }
      this.resetRoundTracking();
      this.log.info("В ответе нет вызова инструментов, цикл завершён, ждём следующего ввода");
      return;
    }
    if (parsed.calls.length === 0) {
      this.consecutiveParseFailures += 1;
      this.log.warn("Не удалось разобрать вызовы инструментов", {
        "ошибки": parsed.diagnostics.errors,
        candidateBlock: parsed.diagnostics.blocks,
        "пропущено": parsed.diagnostics.skipped,
        bareFallback: parsed.diagnostics.bareFallback
      });
      if (this.consecutiveParseFailures > MAX_CONSECUTIVE_PARSE_FAILURES) {
        this.log.error("Несколько раундов подряд не удаётся разобрать вызовы; автовозврат остановлен, нужно вмешательство");
        return;
      }
      await this.backfill(formatParseFailures(parsed.diagnostics.errors), "пояснение об ошибке разбора");
      return;
    }
    this.consecutiveParseFailures = 0;
    const verdict = this.repeatGuard.register(parsed.calls.map((call) => callSignature(call)));
    if (verdict.abort) {
      this.log.error("Одна и та же группа вызовов повторяется несколько раундов \u2014 считаем топтанием на месте; в этом раунде не выполняем", {
        "вызов": verdict.signature?.slice(0, 200),
        "серия": verdict.streak,
        "порог": this.options.config.maxRepeatCalls,
        "текущие серии вызовов": this.repeatGuard.snapshot()
      });
      this.log.error("Это не ошибка: после правки кода повторить ту же команду \u2014 нормально; счётчик срабатывает только при \u00abподряд и без единой правки между ними\u00bb");
      this.log.error("Если нужно продолжение \u2014 напишите в чате уточнение и дайте продолжить; или увеличьте DUB_MAX_REPEAT_CALLS");
      return;
    }
    if (this.rounds >= MAX_ROUNDS_PER_BURST) {
      this.log.error(
        `За одну сессию подряд выполнено ${this.rounds} раундов вызовов инструментов; во избежание разбега автовозврат остановлен. Чтобы продолжить, напишите сообщение в чате.`
      );
      return;
    }
    try {
      const results = await this.executeCalls(parsed.calls, parsed.diagnostics.errors);
      this.stats.recordToolRound(results.length);
      if (results.some((result) => result.ok && RepeatGuard.isMutating(result.tool))) {
        this.repeatGuard.reset();
        this.log.debug("Обнаружена операция записи файла; счётчик повторных вызовов сброшен");
      }
      this.rounds += 1;
      await this.composer.setBusy(true, "Отправка результата\u2026");
      await this.backfill(formatToolResults(results), `${results.length} результат(ов) инструментов`);
    } finally {
      await this.composer.setBusy(false);
    }
  }
  resetRoundTracking() {
    this.rounds = 0;
    this.consecutiveParseFailures = 0;
    this.repeatGuard.reset();
  }
  async executeCalls(calls, parseErrors) {
    const results = [];
    if (parseErrors.length > 0) {
      this.log.warn("Часть вызовов не удалось разобрать, пропущено", { ошибка: parseErrors });
    }
    for (const call of calls) {
      if (this.stopped) break;
      this.log.info(`Выполняется инструмент ${call.tool}`, { args: call.args });
      await this.composer.setBusy(true, `Выполняется ${call.tool}\u2026`);
      const result = await this.registry.execute(call);
      if (!result.ok) {
        this.log.warn(`Инструмент ${call.tool} завершился ошибкой`, {
          errorCode: result.error?.code,
          Причина: result.error?.message
        });
      } else if (result.meta?.exitCode !== void 0 && result.meta.exitCode !== 0) {
        this.log.warn(`Команда завершилась с ненулевым кодом: ${call.tool}`, {
          exitCode: result.meta.exitCode,
          durationMs: result.meta.durationMs ?? 0,
          ...result.structured ? { сводка: result.structured } : {}
        });
      } else {
        this.log.info(`Инструмент ${call.tool} выполнен успешно`, {
          durationMs: result.meta?.durationMs ?? 0,
          ...result.structured ? { сводка: result.structured } : {}
        });
      }
      results.push(result);
    }
    return results;
  }
  /**
   * \u4fdd\u8bc1\u300c\u56de\u590d\u5230\u8fbe \u2192 \u56de\u586b\u53d1\u9001\u300d\u4e4b\u95f4\u81f3\u5c11\u95f4\u9694 replyMinGapMs\u3002
   *
   * \u5de5\u5177\u6267\u884c\u7d27\u8ddf\u5728\u56de\u590d\u4e4b\u540e, \u6240\u4ee5\u5de5\u5177\u8017\u65f6\u672c\u8eab\u5c31\u5360\u7528\u8fd9\u6bb5\u95f4\u9694: 
   * \u5de5\u5177\u8017\u65f6\u4e0d\u8db3\u65f6\u5728\u6b64\u8865\u8db3, \u5df2\u8d85\u8fc7\u5219\u7acb\u5373\u8fd4\u56de\u3002\u76ee\u7684\u662f\u6d88\u9664\u300cAI \u4e00\u56de\u590d\u5b8c\u5c31\u7d27\u8ddf\u53d1\u9001\u300d\u7684\u79d2\u56de\u8282\u594f\u3002
   */
  async waitForReplyGap() {
    const gap = this.options.config.replyMinGapMs;
    if (gap <= 0 || this.lastReplyAt <= 0) return;
    const wait = this.lastReplyAt + gap - Date.now();
    if (wait > 0) {
      this.log.debug("Ожидание минимального интервала после ответа", { waitMs: wait });
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  async backfill(text, label) {
    if (this.paused || this.stopped) {
      this.log.warn("Сейчас возврат невозможен, пропущено", { label });
      return;
    }
    await this.waitForReplyGap();
    await this.composer.waitForSendSlot();
    const streamBaseline = this.streamStarts;
    const outcome = await this.composer.send(text);
    if (outcome.ok) {
      this.stats.recordOutgoing(text);
      void this.pushStats();
      this.log.info(`Отправлено обратно (${label})`, { charCount: text.length, "способ": outcome.detail });
      void this.confirmStreamStarted(streamBaseline, label, text.length);
      return;
    }
    if (outcome.stage === "occupied") {
      await this.promptOccupied(text, label, outcome.detail);
      return;
    }
    this.log.error(`Ошибка возврата (${label}): ${describeFillStage(outcome.stage)}`, {
      "детали": outcome.detail
    });
    this.log.error("Убедитесь, что страница DeepSeek доступна для ввода; если она обновлялась \u2014 перезапустите doctor");
  }
  /**
   * \u56de\u586b\u540e\u7684\u7aef\u5230\u7aef\u786e\u8ba4: \u7ad9\u70b9\u662f\u5426\u771f\u7684\u5f00\u59cb\u751f\u6210\u3002
   *
   * \u9875\u9762\u4fa7\u56de\u62a5\u7684\u300c\u5df2\u53d1\u9001\u300d\u53ea\u770b DOM(\u5199\u5165\u6210\u529f + \u8f93\u5165\u6846\u88ab\u6e05\u7a7a)\u3002\u9875\u9762\u91cd\u65b0\u6e32\u67d3\u3001\u7ad9\u70b9\u541e\u6389\u5408\u6210\u4e8b\u4ef6
   * \u8fd9\u4e9b\u60c5\u51b5\u4e0b, \u8f93\u5165\u6846\u4f1a\u53d8\u7a7a\u4f46\u6d88\u606f\u6839\u672c\u6ca1\u8fdb\u4f1a\u8bdd, \u65e5\u5fd7\u5374\u5199\u7740\u300c\u5df2\u56de\u586b\u5e76\u53d1\u9001\u300d\u2014\u2014\u95ed\u73af\u5c31\u6b64\u505c\u4f4f, 
   * \u800c\u73b0\u573a\u770b\u4e0d\u51fa\u4efb\u4f55\u5f02\u5e38\u3002\u7ad9\u70b9\u63a5\u53d7\u6d88\u606f\u540e\u5fc5\u7136\u4f1a\u5f00\u4e00\u4e2a\u65b0\u7684\u56de\u590d\u6d41, \u8fd9\u662f\u76ee\u524d\u6700\u53ef\u9760\u7684\u786e\u8ba4\u4fe1\u53f7\u3002
   *
   * \u523b\u610f\u4e0d\u963b\u585e\u95ed\u73af\u3001\u4e5f\u4e0d\u91cd\u53d1: \u53ea\u5982\u5b9e\u8865\u4e00\u6761\u544a\u8b66, \u7531\u4eba\u51b3\u5b9a\u4e0b\u4e00\u6b65(\u91cd\u53d1\u5c5e\u4e8e\u6709\u526f\u4f5c\u7528\u7684\u52a8\u4f5c)\u3002
   */
  async confirmStreamStarted(baseline, label, chars) {
    const windowMs = this.options.config.streamConfirmMs;
    if (windowMs <= 0) return;
    const deadline = Date.now() + windowMs;
    while (Date.now() < deadline) {
      if (this.stopped) return;
      if (this.streamStarts > baseline) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (this.streamStarts > baseline) return;
    const windowText = windowMs >= 1e3 ? `${Math.round(windowMs / 1e3)} с` : `${windowMs} мс`;
    this.log.warn(`Отправлено обратно (${label}), но в течение ${windowText} не замечено начала генерации на сайте; возможно, отправка не прошла`, {
      charCount: chars,
      "что проверить": "Посмотрите в чат: если текст ещё в поле ввода \u2014 нажмите Enter; если поле пустое и сообщения в чате нет \u2014 сайт не принял отправку"
    });
  }
  /** \u8f93\u5165\u6846\u88ab\u5360\u7528\u65f6: \u6682\u5b58\u5f85\u53d1\u5185\u5bb9\u5e76\u5f39\u975e\u906e\u6321\u63d0\u793a, \u7b49\u7528\u6237\u51b3\u5b9a\u91cd\u53d1\u8fd8\u662f\u5ffd\u7565\u3002 */
  async promptOccupied(text, label, detail) {
    this.log.warn("Поле ввода занято, возврат отложен до подтверждения повторной отправки", { label, Причина: detail });
    await this.showRetryNotice(text, label, detail);
  }
  /** \u5f39\u51fa\u300c\u91cd\u65b0\u53d1\u9001 / \u5ffd\u7565\u300d\u63d0\u793a, \u5e76\u628a\u5f85\u53d1\u5185\u5bb9\u767b\u8bb0\u5230\u6682\u5b58\u8868\u3002 */
  async showRetryNotice(text, label, detail) {
    const noticeId = `n${++this.noticeSeq}-${Date.now()}`;
    this.pendingNotices.set(noticeId, { text, label });
    const shown = await this.composer.showNotice({
      noticeId,
      message: "Результат не отправлен: поле ввода редактируется. Он сохранён. Нажмите \u00abОтправить повторно\u00bb \u2014 или \u00abИгнорировать\u00bb.",
      actions: [
        { id: "dismiss", label: "Пропустить", primary: false },
        { id: "retry", label: "Отправить снова", primary: true }
      ]
    });
    if (!shown) {
      this.pendingNotices.delete(noticeId);
      this.log.error(`Возврат отклонён: поле ввода занято, уведомление на странице недоступно (${label}); результат этого раунда не отправлен`, {
        "детали": detail
      });
    }
  }
  /** \u5b9e\u9645\u8865\u53d1\u6682\u7f13\u5185\u5bb9\u3002 */
  async deliverPending(text, label) {
    await this.composer.waitForSendSlot();
    const outcome = await this.composer.send(text, { waitMs: 0 });
    if (outcome.ok) {
      this.stats.recordOutgoing(text);
      void this.pushStats();
      this.log.info(`Отправлен отложенный результат инструмента (${label})`, { charCount: text.length });
      return;
    }
    if (outcome.stage === "occupied") {
      await this.promptOccupied(text, label, outcome.detail);
      return;
    }
    this.log.error(`Не удалось отправить отложенный результат инструмента (${label}): ${describeFillStage(outcome.stage)}`, {
      "детали": outcome.detail
    });
  }
  /** \u5904\u7406\u9875\u9762\u63d0\u793a\u4e0a\u7684\u6309\u94ae\u52a8\u4f5c\u3002 */
  async handleNoticeAction(noticeId, action) {
    const pending = this.pendingNotices.get(noticeId);
    if (!pending) return;
    if (action === "dismiss") {
      this.pendingNotices.delete(noticeId);
      this.log.info("Пользователь выбрал \u00abИгнорировать\u00bb отложенный результат", { label: pending.label });
      return;
    }
    if (action === "retry-cancel") {
      this.pendingNotices.delete(noticeId);
      await this.showRetryNotice(pending.text, pending.label, "Пользователь отменил перезапись");
      return;
    }
    if (action === "retry-confirm") {
      this.pendingNotices.delete(noticeId);
      this.log.info("Пользователь подтвердил перезапись поля ввода и повторную отправку", { label: pending.label });
      await this.deliverPending(pending.text, pending.label);
      return;
    }
    if (action !== "retry") {
      this.log.warn("Получено неизвестное действие диалога, проигнорировано", { action, label: pending.label });
      return;
    }
    this.log.info("Пользователь запросил повторную отправку отложенного результата инструмента", { label: pending.label });
    const current = await this.composer.readComposerText();
    if (current !== null && current.trim().length > 0) {
      this.pendingNotices.delete(noticeId);
      const confirmId = `n${++this.noticeSeq}-${Date.now()}`;
      this.pendingNotices.set(confirmId, pending);
      await this.composer.showNotice({
        noticeId: confirmId,
        message: "В поле ввода уже есть текст; повторная отправка перезапишет его. Перезаписать и отправить результат?",
        actions: [
          { id: "retry-cancel", label: "Отмена", primary: false },
          { id: "retry-confirm", label: "Перезаписать и отправить", primary: true }
        ]
      });
      return;
    }
    this.pendingNotices.delete(noticeId);
    await this.deliverPending(pending.text, pending.label);
  }
};

// src/server/config.ts
import { existsSync as existsSync3, statSync as statSync6 } from "fs";
import path6 from "path";
import process6 from "process";
import { z as z3 } from "zod";
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
var envSchema = z3.object({
  DUB_CDP_HOST: z3.string().trim().min(1).default("127.0.0.1"),
  DUB_CDP_PORT: z3.coerce.number().int().min(1).max(65535).default(9222),
  DUB_TARGET_URL_PREFIX: z3.string().trim().min(1).default("https://chat.deepseek.com"),
  DUB_API_PATH_PATTERN: z3.string().trim().min(1).default("/api/v0/chat/completion"),
  DUB_CONTENT_PATH: z3.string().trim().min(1).default("response/fragments/-1/content"),
  DUB_WORKSPACE_ROOT: z3.string().trim().default(""),
  DUB_AUTO_APPROVE_COMMANDS: z3.string().trim().default("false").transform((v) => v.toLowerCase() === "true" || v === "1"),
  DUB_COMMAND_WHITELIST: z3.string().trim().default(""),
  DUB_COMMAND_WHITELIST_EXTRA: z3.string().trim().default(""),
  DUB_MAX_FILE_BYTES: z3.coerce.number().int().min(1024).default(256 * 1024),
  DUB_MAX_RESULT_CHARS: z3.coerce.number().int().min(256).default(16 * 1024),
  DUB_RESPECT_GITIGNORE: z3.string().trim().default("true").transform((v) => v.toLowerCase() === "true" || v === "1"),
  DUB_READ_ONLY: z3.string().trim().default("false").transform((v) => v.toLowerCase() === "true" || v === "1"),
  DUB_MAX_RESPONSE_CHARS: z3.coerce.number().int().min(4096).default(200 * 1024),
  DUB_SEND_MIN_INTERVAL_MS: z3.coerce.number().int().min(0).default(3e3),
  DUB_REPLY_MIN_GAP_MS: z3.coerce.number().int().min(0).default(2e3),
  DUB_FILL_WAIT_MS: z3.coerce.number().int().min(0).default(5e3),
  DUB_STREAM_CONFIRM_MS: z3.coerce.number().int().min(0).default(8e3),
  DUB_RESPONSE_TIMEOUT_MS: z3.coerce.number().int().min(5e3).default(18e4),
  DUB_MAX_REPEAT_CALLS: z3.coerce.number().int().min(1).max(50).default(3),
  DUB_COMMAND_TIMEOUT_MS: z3.coerce.number().int().min(1e3).default(12e4),
  DUB_MAX_COMMAND_OUTPUT_CHARS: z3.coerce.number().int().min(256).default(16 * 1024),
  DUB_COMMAND_CWD: z3.string().trim().default(""),
  DUB_LOG_LEVEL: z3.enum(["debug", "info", "warn", "error"]).default("info"),
  DUB_CHROME_PATH: z3.string().trim().default(""),
  DUB_CHROME_PROFILE_DIR: z3.string().trim().default(""),
  DUB_AUTO_SEND_PROMPT: z3.string().trim().default("true").transform((v) => v.toLowerCase() === "true" || v === "1"),
  DUB_PROMPT_FILE: z3.string().trim().min(1).default("prompts/deepseek-system-prompt.md"),
  DUB_AGENT_FILE: z3.string().trim().default("agent.md")
});
function loadDotEnv(cwd = process6.cwd()) {
  const envPath = path6.resolve(cwd, ".env");
  if (!existsSync3(envPath)) return null;
  try {
    process6.loadEnvFile(envPath);
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
    stat = statSync6(dir);
  } catch {
    throw new Error(`${label} не существует или недоступна: ${dir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} не является директорией: ${dir}`);
  }
}
function loadConfig(options = {}) {
  const cwd = options.cwd ?? process6.cwd();
  if (options.loadEnv !== false) {
    loadDotEnv(cwd);
  }
  const parsed = envSchema.safeParse(process6.env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    throw new Error(`Ошибка валидации конфигурации: ${details}`);
  }
  const env = parsed.data;
  const workspaceRoot = path6.resolve(cwd, env.DUB_WORKSPACE_ROOT || ".");
  assertDirectory(workspaceRoot, "workspace DUB_WORKSPACE_ROOT");
  const commandCwd = env.DUB_COMMAND_CWD ? path6.resolve(cwd, env.DUB_COMMAND_CWD) : workspaceRoot;
  assertDirectory(commandCwd, "commandCwd DUB_COMMAND_CWD");
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
function describeConfig(config) {
  return {
    targetUrl: config.targetUrlPrefix,
    cdpPort: `${config.cdpHost}:${config.cdpPort}`,
    workspace: config.workspaceRoot,
    commandCwd: config.commandCwd,
    autoApprove: config.autoApproveCommands,
    whitelistSize: config.commandWhitelist.length,
    respectGitignore: config.respectGitignore,
    readOnly: config.readOnly,
    sendMinIntervalMs: config.sendMinIntervalMs,
    replyMinGapMs: config.replyMinGapMs,
    fillWaitMs: config.fillWaitMs,
    logLevel: config.logLevel
  };
}

// src/server/doctor.ts
var DEFAULT_DOCUMENT_WAIT_MS = 2e4;
var DEFAULT_COMPOSER_WAIT_MS = 15e3;
var DOCTOR_POLL_INTERVAL_MS = 500;
function step(name, status, detail, data) {
  const result = { name, status };
  if (detail !== void 0) result.detail = detail;
  if (data !== void 0) result.data = data;
  return result;
}
var STATUS_LABEL = {
  ok: "Пройдено",
  warn: "Внимание",
  fail: "Ошибка",
  skip: "Пропущено"
};
function formatDoctorReport(report) {
  const lines = [];
  for (const item of report.steps) {
    const mark = item.status === "ok" ? "\u2714" : item.status === "warn" ? "!" : item.status === "skip" ? "-" : "\u2718";
    lines.push(`${mark} [${STATUS_LABEL[item.status]}] ${item.name}${item.detail ? `: ${item.detail}` : ""}`);
    if (item.data !== void 0) {
      lines.push(`    ${JSON.stringify(item.data)}`);
    }
  }
  return lines.join("\n");
}
async function runDoctor(config, log, options = {}) {
  const steps = [];
  const logger = log.child("doctor");
  const deps = {
    listTargets,
    createSession: (sessionConfig, sessionLog) => new CdpPageSession(sessionConfig, sessionLog),
    installAgent,
    ...options.deps
  };
  const documentWaitMs = options.documentWaitMs ?? DEFAULT_DOCUMENT_WAIT_MS;
  const composerWaitMs = options.composerWaitMs ?? DEFAULT_COMPOSER_WAIT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DOCTOR_POLL_INTERVAL_MS;
  steps.push(step("Загрузка конфигурации", "ok", "Конфигурация прошла валидацию", describeConfig(config)));
  logger.info("Начинается самопроверка", describeConfig(config));
  const conventions = loadAgentConventions(config.agentFilePath);
  if (config.agentFilePath.trim().length === 0) {
    steps.push(step("Файл проектных соглашений", "skip", "DUB_AGENT_FILE  пуст, соглашения не прикрепляются"));
  } else if (conventions) {
    steps.push(
      step(
        "Файл проектных соглашений",
        "ok",
        `Найден ${config.agentFilePath} (${conventions.body.length} символов); отправится вместе с промптом`
      )
    );
  } else {
    steps.push(
      step("Файл проектных соглашений", "skip", `не найден ${config.agentFilePath}, отправляется только общий промпт (опционально, не ошибка)`)
    );
  }
  let targets;
  try {
    targets = await deps.listTargets(config);
    steps.push(
      step("Отладочный порт доступен", "ok", `${config.cdpHost}:${config.cdpPort}`, {
        "число отладочных целей": targets.length
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    steps.push(step("Отладочный порт доступен", "fail", message));
    steps.push(
      step("Дальнейшие проверки", "skip", "Продолжить нельзя: отладочный порт недоступен. Сначала выполните npm run launch-chrome")
    );
    return { ok: false, steps };
  }
  const pages = targets.filter((t) => t.type === "page");
  const matched = pages.find((t) => t.url.startsWith(config.targetUrlPrefix));
  if (!matched) {
    steps.push(
      step("Целевая вкладка существует", "fail", `Не обнаружена вкладка, начинающаяся с ${config.targetUrlPrefix}`, {
        "открытые вкладки": pages.map((t) => t.url).slice(0, 10)
      })
    );
    steps.push(step("Дальнейшие проверки", "skip", "Откройте в отладочном браузере DeepSeek  и повторите"));
    return { ok: false, steps };
  }
  steps.push(step("Целевая вкладка существует", "ok", matched.title || matched.url));
  const session = deps.createSession(config, log);
  try {
    await session.attach();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    steps.push(step("Подключение к вкладке", "fail", message));
    return { ok: false, steps };
  }
  steps.push(step("Подключение к вкладке", "ok", "CDP сессия установлена"));
  const committed = await waitForDocument(session, config.targetUrlPrefix, {
    timeoutMs: documentWaitMs,
    intervalMs: pollIntervalMs,
    onWait: (attempt) => {
      if (attempt === 1 || attempt % 10 === 0) {
        logger.info("Ожидание загрузки страницы\u2026\u2026", {
          attempt: attempt,
          "подсказка": "При холодном старте вкладка появляется раньше; странице нужно несколько секунд на отрисовку"
        });
      }
    }
  });
  if (committed.ok) {
    steps.push(step("Страница загружена", "ok", committed.value ?? ""));
  } else {
    const lastError = committed.lastError !== void 0 ? `; последняя ошибка пробы: ${committed.lastError}` : "";
    steps.push(
      step(
        "Страница загружена",
        "warn",
        `ожидание ${Math.round(documentWaitMs / 1e3)} секунд: документ так и не перешёл к ${config.targetUrlPrefix} (текущий адрес: ${committed.value ?? "не читается"})${lastError}`
      )
    );
  }
  const collected = [];
  try {
    await deps.installAgent(
      session,
      {
        apiPathPattern: config.apiPathPattern,
        onMessages: (messages) => collected.push(...messages)
      },
      logger
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    steps.push(step("Внедрение хука", "fail", message));
    await session.detach("doctor завершён");
    return { ok: false, steps };
  }
  const probe = await pollUntil({
    probe: () => readAgentDiagnostics(session).catch(() => null),
    done: (value) => {
      const composer2 = value?.composer;
      return composer2?.found === true;
    },
    timeoutMs: composerWaitMs,
    intervalMs: pollIntervalMs,
    onWait: (attempt) => {
      if (attempt === 1 || attempt % 10 === 0) {
        logger.info("Ожидание отрисовки поля ввода\u2026\u2026", { attempt: attempt });
      }
    }
  });
  const diagnostics = probe.value;
  if (!diagnostics) {
    steps.push(step("Внедрение хука", "fail", "Объект хука не читается со страницы \u2014 возможно, мешает CSP или скрипты страницы"));
    await session.detach("doctor завершён");
    return { ok: false, steps };
  }
  const hooks = diagnostics.hooks ?? {};
  const hookOk = hooks.fetch === true || hooks.xhr === true;
  steps.push(
    step(
      "Внедрение хука",
      hookOk ? "ok" : "fail",
      hookOk ? "Сетевые точки входа страницы обёрнуты" : "fetch и XHR перехватить не удалось \u2014 возможно, сайт использует другой транспорт",
      { hooks, apiPath: diagnostics.apiPath }
    )
  );
  const composer = diagnostics.composer ?? {};
  if (composer.found === true) {
    steps.push(step("Поле ввода чата доступно", "ok", `тег ${String(composer.tag)}`, composer));
  } else {
    const suffix = committed.ok ? "" : "; страница ещё не загружена \u2014 подождите несколько секунд и перезапустите doctor, а не как изменение сайта";
    steps.push(
      step(
        "Поле ввода чата доступно",
        "fail",
        `Не найдено видимое поле ввода \u2014 отправка результата не сработает${suffix}`,
        composer.candidates ?? composer
      )
    );
  }
  steps.push(
    step(
      "Позиционирование кнопки отправки",
      diagnostics.sendButton === "found" ? "ok" : "warn",
      diagnostics.sendButton === "found" ? void 0 : "Кнопка отправки не найдена, будет имитация Enter"
    )
  );
  const conversation = diagnostics.conversation ?? {};
  if (!committed.ok) {
    steps.push(step("Состояние диалога", "skip", "Страница ещё не загружена \u2014 нельзя определить, пустой ли диалог"));
  } else {
    steps.push(
      step(
        "Состояние диалога",
        conversation.fresh === true ? "ok" : "warn",
        conversation.fresh === true ? "Диалог пустой: при запуске сервиса промпт отправится автоматически" : `${String(conversation.reason ?? "Диалог не пустой")}; промпт не отправится автоматически; если нужно:  npm start -- --send-prompt`
      )
    );
  }
  const stats = diagnostics.stats ?? {};
  if (typeof stats.dropped === "number" && stats.dropped > 0) {
    steps.push(step("Канал передачи", "warn", `потеряно сообщений из-за отсутствия binding: ${stats.dropped}`, stats));
  } else {
    steps.push(step("Канал передачи", "ok", "Binding-функция доступна", stats));
  }
  if (typeof stats.lastError === "string") {
    steps.push(step("Ошибка на стороне страницы", "warn", stats.lastError));
  }
  const errors = diagnostics.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    steps.push(step("Записи об исключениях на странице", "warn", `${errors.length} шт.`, errors.slice(-3)));
  }
  await session.detach("doctor завершён");
  const ok = !steps.some((item) => item.status === "fail");
  return { ok, steps };
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
    text = `${text.slice(0, MAX_LOG_CHARS)}\u2026[+${text.length - MAX_LOG_CHARS} символов]`;
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

// src/server/preflight.ts
import os2 from "os";
import path8 from "path";

// src/server/launch-chrome.ts
import { spawn as spawn2 } from "child_process";
import { existsSync as existsSync4, mkdirSync as mkdirSync2 } from "fs";
import os from "os";
import path7 from "path";
var CHROME_CANDIDATES_WIN = [
  path7.join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
  path7.join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Google",
    "Chrome",
    "Application",
    "chrome.exe"
  ),
  path7.join(process.env["LocalAppData"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  path7.join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Google", "Chrome Beta", "Application", "chrome.exe"),
  path7.join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft",
    "Edge",
    "Application",
    "msedge.exe"
  ),
  path7.join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe")
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
    if (candidate && existsSync4(candidate)) return candidate;
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
    logger.info("Отладочный порт готов, повторный запуск не нужен", { "порт": options.port, targetCount: existing.length });
    return {
      status: "already-running",
      detail: `cdpPort ${options.port} готов`,
      command: "",
      targets: existing
    };
  }
  const chromePath = options.chromePath ?? detectChrome();
  const args = buildChromeArgs(options);
  const command = chromePath ? `"${chromePath}" ${args.join(" ")}` : `chrome ${args.join(" ")}`;
  if (!chromePath) {
    logger.error("Не удалось автоматически найти Chrome. Укажите путь через --chrome <путь> или выполните вручную:");
    logger.info(command);
    return { status: "no-browser", detail: "не найден Chrome / Edge executable", command };
  }
  if (!existsSync4(options.profileDir)) {
    mkdirSync2(options.profileDir, { recursive: true });
  }
  logger.info("Запускаем браузер в режиме отладки", {
    executable: chromePath,
    profileDir: options.profileDir,
    "порт": options.port
  });
  logger.info("Подсказка: этот экземпляр изолирован от вашего обычного браузера. При первом запуске нужно войти в DeepSeek.");
  if (options.dryRun) {
    logger.info("--dry-run указан: реальный запуск пропущен");
    return { status: "dry-run", detail: "Реальный запуск пропущен", command };
  }
  const child = spawn2(chromePath, args, { detached: true, stdio: "ignore" });
  child.unref();
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    const targets = await listTargets(probe).catch(() => null);
    if (targets && targets.length > 0) {
      logger.info("Отладочный порт готов", { targetCount: targets.length });
      return {
        status: "started",
        detail: `cdpPort ${options.port} готов`,
        command,
        targets
      };
    }
  }
  const seconds = Math.round(readyTimeoutMs / 1e3);
  logger.warn(
    `Браузер запущен, но отладочный порт за ${seconds} секунд так и не стал готов. Убедитесь, что другой Chrome не занял ту же директорию профиля.`
  );
  return { status: "timeout", detail: `отладочный порт не готов за ${seconds} секунд`, command };
}

// src/server/preflight.ts
var DEFAULT_PREFLIGHT_TARGET_WAIT_MS = 3e4;
function buildLaunchOptions(config) {
  const profileDir = config.chromeProfileDir ?? path8.join(os2.tmpdir(), "dubridge-chrome-profile");
  const options = {
    port: config.cdpPort,
    url: config.targetUrlPrefix,
    profileDir,
    dryRun: false
  };
  if (config.chromePath) options.chromePath = config.chromePath;
  return options;
}
async function runPreflight(options) {
  const { config, log } = options;
  const logger = log.child("preflight");
  const deps = {
    launchChrome,
    waitForTarget,
    runDoctor,
    ...options.deps
  };
  let launch;
  if (options.skipLaunch) {
    logger.info("автозапуск браузера пропущен, проверяем cdpPort напрямую");
  } else {
    launch = await deps.launchChrome(buildLaunchOptions(config), log);
    if (launch.status === "no-browser") {
      return {
        status: "no-browser",
        detail: `не найден Chrome / Edge. Запустите отладочный браузер вручную: 
  ${launch.command}`,
        launch
      };
    }
    if (launch.status === "timeout") {
      return {
        status: "launch-timeout",
        detail: `${launch.detail}. Если другой Chrome занял ту же директорию профиля \u2014 закройте его; либо запустите вручную:
  ${launch.command}`,
        launch
      };
    }
  }
  const waitMs = options.waitForTargetMs ?? DEFAULT_PREFLIGHT_TARGET_WAIT_MS;
  try {
    await deps.waitForTarget(config, {
      timeoutMs: waitMs,
      onWait: (attempt) => {
        if (attempt === 1 || attempt % 5 === 0) {
          logger.info("ожидание вкладки DeepSeek\u2026\u2026", {
            attempt: attempt,
            "подсказка": "Откройте и войдите в chat.deepseek.com"
          });
        }
      }
    });
  } catch (error) {
    if (error instanceof CdpUnavailableError) {
      const result2 = {
        status: "no-target",
        detail: `ожидание ${Math.round(waitMs / 1e3)} секунд \u2014 вкладка ${config.targetUrlPrefix} не найдена. Откройте её и войдите в отладочном браузере, затем повторите.`
      };
      if (launch) result2.launch = launch;
      return result2;
    }
    throw error;
  }
  const report = await deps.runDoctor(config, log);
  if (!report.ok) {
    const result2 = {
      status: "doctor-failed",
      detail: formatDoctorReport(report),
      report
    };
    if (launch) result2.launch = launch;
    return result2;
  }
  logger.info("Предполётная проверка пройдена, готовим запуск сервиса");
  const result = { status: "ok", detail: "предпроверка пройдена", report };
  if (launch) result.launch = launch;
  return result;
}

// src/server/index.ts
function hasFlag(flag) {
  return process7.argv.slice(2).includes(flag);
}
async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    createLogger({ level: "error" }).error("Ошибка загрузки конфигурации", {
      message: error instanceof Error ? error.message : String(error)
    });
    process7.exitCode = 1;
    return;
  }
  const log = createLogger({ level: config.logLevel });
  if (hasFlag("--doctor")) {
    const report = await runDoctor(config, log);
    process7.stdout.write(`${formatDoctorReport(report)}
`);
    process7.exitCode = report.ok ? 0 : 1;
    return;
  }
  log.info("dubridge запускается", describeConfig(config));
  if (!hasFlag("--no-preflight")) {
    const preflight = await runPreflight({ config, log });
    if (preflight.status !== "ok") {
      log.error("Предполётная проверка не пройдена, запуск прерван", { Причина: preflight.status });
      process7.stderr.write(`
${preflight.detail}

`);
      log.error("Чтобы пропустить предполётную проверку: npm start -- --no-preflight");
      process7.exitCode = 1;
      return;
    }
  } else {
    log.info("--no-preflight указан: предполётная проверка пропущена");
  }
  const session = new CdpPageSession(config, log);
  const orchestrator = new Orchestrator({ config, session, log });
  const messages = [];
  let flushTimer = null;
  const flush = () => {
    flushTimer = null;
    if (messages.length === 0) return;
    const batch = messages.splice(0, messages.length);
    orchestrator.handleAgentMessages(batch);
  };
  const enqueue = (incoming) => {
    messages.push(...incoming);
    if (flushTimer === null) flushTimer = setTimeout(flush, 16);
  };
  session.onDetach((reason) => {
    log.warn("Соединение разорвано, повторное подключение через 3 с", { reason });
    orchestrator.pause(reason);
    setTimeout(() => {
      void session.attach(config.responseTimeoutMs).catch((error) => {
        log.error("Повторное подключение не удалось", {
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }, 3e3);
  });
  let agentHandle = null;
  session.onAttached(async (attached) => {
    agentHandle?.dispose();
    agentHandle = await installAgent(
      attached,
      { apiPathPattern: config.apiPathPattern, onMessages: enqueue },
      log
    );
    orchestrator.resume();
    orchestrator.refreshStats();
  });
  const shutdown = (signal) => {
    log.info("Получен сигнал завершения, очищаем", { signal });
    orchestrator.stop();
    void session.detach(`Процесс завершается (${signal})`).finally(() => {
      process7.exit(0);
    });
  };
  process7.on("SIGINT", () => shutdown("SIGINT"));
  process7.on("SIGTERM", () => shutdown("SIGTERM"));
  try {
    await session.attach(config.responseTimeoutMs);
  } catch (error) {
    log.error("Ошибка запуска", { message: error instanceof Error ? error.message : String(error) });
    process7.exitCode = 1;
    return;
  }
  orchestrator.start();
  const promptDisabled = hasFlag("--no-prompt");
  const promptForced = hasFlag("--send-prompt");
  if (promptDisabled) {
    log.info("--no-prompt указан: автоотправка промпта пропущена");
  } else if (config.autoSendPrompt || promptForced) {
    void runBootstrap({
      config,
      session,
      log,
      send: (text) => orchestrator.sendUserMessage(text),
      force: promptForced,
      beforeSend: () => orchestrator.suppressNextReply("системный промпт отправлен автоматически")
    }).then((outcome) => {
      if (outcome.status === "sent") {
        log.info("Можно давать команды");
      } else if (outcome.status === "not-fresh" || outcome.status === "unavailable") {
        log.warn(`промпт не отправлен автоматически: ${outcome.detail}`);
        log.warn("Если хотите отправить промпт в текущий диалог, используйте: npm start -- --send-prompt");
      }
    }).catch((error) => {
      log.error("Исключение при автоотправке промпта", {
        message: error instanceof Error ? error.message : String(error)
      });
    });
  } else {
    log.info("Автоотправка промпта отключена (DUB_AUTO_SEND_PROMPT=false)");
  }
  log.info("Сервис готов: отдавайте команды прямо в DeepSeek");
}
main().catch((error) => {
  createLogger({ level: "error" }).error("Неперехваченный exception", {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : void 0
  });
  process7.exitCode = 1;
});
