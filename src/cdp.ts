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

  constructor(ws: WebSocket) {
    this.ws = ws;
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
      this.ws.send(JSON.stringify({ id, method, params }));
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
    const ok = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      if (typeof el.click === 'function') el.click();
      return true;
    })()`);
    if (!ok) throw new Error(`selector not found: ${selector}`);
  }

  async waitForSelector(selector: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const found = await this.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
        })()`);
        if (found) return;
      } catch { /* ignore navigation errors */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`timeout waiting for selector: ${selector}`);
  }

  async getAiMessageCount(): Promise<number> {
    try {
      return await this.evaluate(`document.querySelectorAll('[class*="ds-markdown"]').length`);
    } catch { return 0; }
  }

  async getLastAiMessage(): Promise<string> {
    try {
      return await this.evaluate(`(() => {
        const els = document.querySelectorAll('[class*="ds-markdown"]');
        return els.length ? els[els.length - 1].innerText : '';
      })()`);
    } catch { return ''; }
  }

  async isInputEmpty(): Promise<boolean> {
    try {
      return await this.evaluate(`(() => {
        const sel = '#chat-input, textarea[placeholder], textarea, [contenteditable="true"]';
        const el = document.querySelector(sel);
        if (!el) return true;
        if (el.tagName === 'TEXTAREA') return el.value.length === 0;
        return el.innerText.trim().length === 0;
      })()`);
    } catch { return true; }
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

  const page = new CDPPage(ws);
  try {
    await page.evaluate(`(async () => { await document.readyState; })()`, true);
  } catch {}
  return { browser: new CDPBrowser(proc), page };
}

const INPUT_SELECTORS = [
  '#chat-input',
  'textarea[placeholder]',
  'textarea',
  '[contenteditable="true"]',
  'div[role="textbox"]',
];

async function findInput(page: CDPPage): Promise<string | null> {
  for (const sel of INPUT_SELECTORS) {
    try {
      const visible = await page.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })()`);
      if (visible) return sel;
    } catch {}
  }
  return null;
}

export async function waitForInput(page: CDPPage, timeoutMs = 10 * 60 * 1000): Promise<string> {
  const start = Date.now();
  let lastLog = 0;
  while (Date.now() - start < timeoutMs) {
    const sel = await findInput(page);
    if (sel) return sel;
    const elapsed = Math.round((Date.now() - start) / 1000);
    if (elapsed - lastLog >= 10) {
      console.log(`[dubridge] Waiting for chat input... (${elapsed}s)`);
      lastLog = elapsed;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout waiting for input field. Tried: ${INPUT_SELECTORS.join(', ')}`);
}

export async function sendPrompt(page: CDPPage, text: string): Promise<void> {
  const sel = await waitForInput(page);
  
  // Wait for input to become empty (up to 30s) — avoid appending to user's draft
  const emptyStart = Date.now();
  while (Date.now() - emptyStart < 30000) {
    if (await page.isInputEmpty()) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  await page.click(sel);
  await page.insertText(text);
  await page.pressEnter();
}

export async function waitForResponse(page: CDPPage): Promise<string> {
  const initialCount = await page.getAiMessageCount();
  const start = Date.now();
  const timeout = 10 * 60 * 1000;

  while (Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const count = await page.getAiMessageCount();
      if (count <= initialCount) continue;
      const text = await page.getLastAiMessage();
      if (!text) continue;

      // Wait for text stability
      let stable = 0;
      let last = text;
      while (stable < 3) {
        await new Promise((r) => setTimeout(r, 500));
        const t = await page.getLastAiMessage();
        if (t === last && t.length > 0) stable++;
        else { stable = 0; last = t; }
      }
      return last;
    } catch {}
  }
  return '';
}

/**
 * Wait until AI message count changes from baseline.
 * Returns { count, text } when new AI message appears, or null on timeout.
 */
export async function waitForNewAiMessage(page: CDPPage, baselineCount: number, timeoutMs = 3600 * 1000): Promise<{ count: number; text: string } | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const count = await page.getAiMessageCount();
      if (count > baselineCount) {
        const text = await page.getLastAiMessage();
        if (!text) continue;
        // Wait for stability
        let stable = 0;
        let last = text;
        while (stable < 3) {
          await new Promise((r) => setTimeout(r, 500));
          const t = await page.getLastAiMessage();
          if (t === last && t.length > 0) stable++;
          else { stable = 0; last = t; }
        }
        const finalCount = await page.getAiMessageCount();
        return { count: finalCount, text: last };
      }
    } catch {}
  }
  return null;
}
