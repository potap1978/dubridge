import { ChildProcess } from "node:child_process";
import WebSocket from "ws";
export declare function findChrome(): string;
export declare class CDPPage {
    private ws;
    private msgId;
    private pending;
    private sessionId;
    constructor(ws: WebSocket, sessionId: string);
    private onMessage;
    private send;
    evaluate(expression: string, awaitPromise?: boolean): Promise<any>;
    insertText(text: string): Promise<void>;
    pressEnter(): Promise<void>;
    click(selector: string): Promise<void>;
    waitForSelector(selector: string, timeoutMs: number): Promise<void>;
    close(): void;
}
export declare class CDPBrowser {
    private proc?;
    constructor(proc?: ChildProcess | undefined);
    close(): Promise<void>;
}
export declare function launchOrConnect(): Promise<{
    browser: CDPBrowser;
    page: CDPPage;
}>;
export declare function sendPrompt(page: CDPPage, text: string): Promise<void>;
export declare function waitForResponse(page: CDPPage): Promise<string>;
