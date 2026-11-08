import puppeteer, { Browser, Page } from "puppeteer-core";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

export function findChrome(): string {
  const candidates = [
    process.env.CHROME_PATH,
    process.platform === "win32" && "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    process.platform === "win32" && "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.platform === "darwin" && "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    process.platform === "linux" && "/usr/bin/google-chrome",
    process.platform === "linux" && "/usr/bin/chromium-browser",
    process.platform === "linux" && "/usr/bin/chromium",
  ].filter(Boolean) as string[];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error("Chrome/Chromium not found. Set CHROME_PATH env var.");
}

export async function launchBrowser(): Promise<{ browser: Browser; page: Page }> {
  const userDataDir = path.join(os.homedir(), ".dubridge", "chrome-profile");
  fs.mkdirSync(userDataDir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: false,
    userDataDir,
    defaultViewport: { width: 1280, height: 900 },
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());
  await page.goto("https://chat.deepseek.com/", { waitUntil: "networkidle2" });
  return { browser, page };
}

export async function sendPrompt(page: Page, text: string): Promise<void> {
  const sel = 'textarea, [contenteditable="true"]';
  await page.waitForSelector(sel, { timeout: 20000 });
  const el = await page.$(sel);
  if (!el) throw new Error("input element not found on chat.deepseek.com");
  await el.click();
  await page.keyboard.type(text, { delay: 3 });
  await page.keyboard.press("Enter");
}

export async function waitForResponse(page: Page): Promise<string> {
  await page.waitForSelector('[class*="ds-markdown"]', { timeout: 180000 });
  let prev = "";
  let stable = 0;
  for (let i = 0; i < 600; i++) {
    const text = await page.evaluate(() => {
      const els = document.querySelectorAll('[class*="ds-markdown"]');
      return els.length ? (els[els.length - 1] as HTMLElement).innerText : "";
    });
    if (text === prev && text.length > 0) {
      stable++;
      if (stable >= 3) return text;
    } else {
      stable = 0;
      prev = text;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return prev;
}
