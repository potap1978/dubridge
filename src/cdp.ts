import { spawn, ChildProcess } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import WebSocket from "ws";
import { config } from "./config.js";

export function findChrome(): string {
  const candidates = [
    config.chromePath,
    process.platform === "win32" && "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    process.platform === "win32" && "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.platform === "darwin" && "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    process.platform === "linux" && "/usr/bin/google-chrome",
    process.platform === "linux" && "/usr/bin/chromium-browser",
    process.platform === "linux" && "/usr/bin/chromium",
  ].filter(Boolean) as string[];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  throw new Error("Chrome/Chromium not found. Set CHROME_PATH or DUB_CHROME_PATH env var.");
}

interface CDPMessage {
  id?: number;
  method?: string;
  result?: any;
  error?: { message: string };
  params?: any;
}

export class CDPPage {
  private ws: WebSocket;
  private msgId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private sessionId: string;

  constructor(ws: WebSocket, sessionId: string) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.ws.on("message", (data: Buffer) => this.onMessage(data.toString()));
  }

  private onMessage(raw: string) {
    let msg: CDPMessage;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  }

  private send(method: string, params: any = {}): Promise<any> {
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId: this.sessionId }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60000);
    });
  }

  async evaluate(expression: string, awaitPromise = false): Promise<any> {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "eval error");
    return r.result?.value;
  }

  async insertText(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  async pressEnter(): Promise<void> {
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: "Enter", code: "Enter" });
    await this.send("Input.dispatchKeyEvent", { type: "char", text: "\r", unmodifiedText: "\r", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: "Enter", code: "Enter" });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: "Enter", code: "Enter" });
  }

  async click(selector: string): Promise<void> {
    const coords = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!coords) throw new Error(`selector not found: ${selector}`);
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: coords.x, y: coords.y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: coords.x, y: coords.y, button: "left", clickCount: 1 });
  }

  async waitForSelector(selector: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = await this.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
      if (found) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`timeout waiting for selector: ${selector}`);
  }

  close() { this.ws.close(); }
}

export class CDPBrowser {
  constructor(private proc?: ChildProcess) {}
  async close(): Promise<void> {
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill(); } catch {}
    }
  }
}

function httpJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

async function waitForCdpPort(port: number, timeoutMs = 60000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await httpJson(`http://127.0.0.1:${port}/json/version`);
      return;
    } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error(`CDP port ${port} did not open in ${timeoutMs}ms`);
}

async function getPageTarget(port: number, urlPrefix: string): Promise<{ id: string; wsUrl: string }> {
  const list = await httpJson(`http://127.0.0.1:${port}/json/list`);
  const target = list.find((t: any) => t.type === "page" && t.url.startsWith(urlPrefix)) || list.find((t: any) => t.type === "page");
  if (!target) throw new Error("No page target found in Chrome");
  return { id: target.id, wsUrl: target.webSocketDebuggerUrl };
}

export async function launchOrConnect(): Promise<{ browser: CDPBrowser; page: CDPPage }> {
  let proc: ChildProcess | undefined;
  const port = config.cdpPort;

  if (config.launchChrome) {
    const exe = findChrome();
    proc = spawn(exe, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${config.chromeProfileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      config.targetUrl,
    ], { detached: true, stdio: "ignore" });
    proc.unref();
    await waitForCdpPort(port);
  } else {
    await waitForCdpPort(port, 10000);
  }

  const target = await getPageTarget(port, config.targetUrl);
  const ws = new WebSocket(target.wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (e) => reject(e));
  });

  const page = new CDPPage(ws, target.id);
  try {
    await page.evaluate(`(async () => { await document.readyState; })()`, true);
  } catch {}
  return { browser: new CDPBrowser(proc), page };
}

export async function sendPrompt(page: CDPPage, text: string): Promise<void> {
  const sel = 'textarea, [contenteditable="true"]';
  await page.waitForSelector(sel, 20000);
  await page.click(sel);
  await page.insertText(text);
  await page.pressEnter();
}

export async function waitForResponse(page: CDPPage): Promise<string> {
  await page.waitForSelector('[class*="ds-markdown"]', 180000);
  let prev = "";
  let stable = 0;
  for (let i = 0; i < 600; i++) {
    const text = await page.evaluate(`(() => {
      const els = document.querySelectorAll('[class*="ds-markdown"]');
      return els.length ? els[els.length - 1].innerText : '';
    })()`);
    if (text === prev && text && text.length > 0) {
      stable++;
      if (stable >= 3) return text;
    } else {
      stable = 0;
      prev = text || "";
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return prev;
}
