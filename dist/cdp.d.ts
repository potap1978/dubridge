import { Browser, Page } from "puppeteer-core";
export declare function findChrome(): string;
export declare function launchOrConnect(): Promise<{
    browser: Browser;
    page: Page;
}>;
export declare function sendPrompt(page: Page, text: string): Promise<void>;
export declare function waitForResponse(page: Page): Promise<string>;
