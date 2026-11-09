import puppeteer from "puppeteer-core";
import fs from "node:fs";
import { config } from "./config.js";
export function findChrome() {
    const candidates = [
        config.chromePath,
        process.platform === "win32" && "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        process.platform === "win32" && "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        process.platform === "darwin" && "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        process.platform === "linux" && "/usr/bin/google-chrome",
        process.platform === "linux" && "/usr/bin/chromium-browser",
        process.platform === "linux" && "/usr/bin/chromium",
    ].filter(Boolean);
    for (const c of candidates)
        if (c && fs.existsSync(c))
            return c;
    throw new Error("Chrome/Chromium not found. Set CHROME_PATH or DUB_CHROME_PATH env var.");
}
export async function launchOrConnect() {
    let browser;
    if (config.launchChrome) {
        browser = await puppeteer.launch({
            executablePath: findChrome(),
            headless: false,
            userDataDir: config.chromeProfileDir,
            defaultViewport: { width: 1280, height: 900 },
            args: ["--no-first-run", "--no-default-browser-check"],
        });
    }
    else {
        browser = await puppeteer.connect({
            browserURL: `http://${config.cdpHost}:${config.cdpPort}`,
            defaultViewport: { width: 1280, height: 900 },
        });
    }
    const pages = await browser.pages();
    let page = pages.find(p => p.url().startsWith(config.targetUrl));
    if (!page) {
        page = await browser.newPage();
        await page.goto(config.targetUrl, { waitUntil: "networkidle2" });
    }
    return { browser, page };
}
export async function sendPrompt(page, text) {
    const sel = 'textarea, [contenteditable="true"]';
    await page.waitForSelector(sel, { timeout: 20000 });
    const el = await page.$(sel);
    if (!el)
        throw new Error("input element not found on chat.deepseek.com");
    await el.click();
    await page.keyboard.type(text, { delay: 3 });
    await page.keyboard.press("Enter");
}
export async function waitForResponse(page) {
    await page.waitForSelector('[class*="ds-markdown"]', { timeout: 180000 });
    let prev = "";
    let stable = 0;
    for (let i = 0; i < 600; i++) {
        const text = await page.evaluate(() => {
            const els = document.querySelectorAll('[class*="ds-markdown"]');
            return els.length ? els[els.length - 1].innerText : "";
        });
        if (text === prev && text.length > 0) {
            stable++;
            if (stable >= 3)
                return text;
        }
        else {
            stable = 0;
            prev = text;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    return prev;
}
//# sourceMappingURL=cdp.js.map