import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadBrowser } from "./download-browser.js";
export async function setup() {
    if (process.platform !== "win32") {
        console.log("[setup] On non-Windows, nothing to set up. Use dubridge run directly.");
        return;
    }
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const pkgRoot = path.resolve(__dirname, "..");
    const targetDir = "C:\\DeepSeek";
    console.log("[setup] Creating structure in", targetDir);
    const dirs = [
        targetDir,
        path.join(targetDir, "ungooglium_ds"),
        path.join(targetDir, "prompts"),
        path.join(targetDir, "chrome-profile"),
        path.join(targetDir, "Work-dir"),
    ];
    for (const d of dirs)
        fs.mkdirSync(d, { recursive: true });
    const copy = (src, dest) => {
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, dest);
            console.log(`[setup] Copied ${path.basename(src)} -> ${dest}`);
        }
        else {
            console.warn(`[setup] WARN: source not found: ${src}`);
        }
    };
    // Copy run.bat with forced CRLF line endings (cmd.exe requires CRLF)
    const runBatSrc = path.join(pkgRoot, "run.bat");
    const runBatDst = path.join(targetDir, "run.bat");
    if (fs.existsSync(runBatSrc)) {
        const content = fs.readFileSync(runBatSrc, "utf8").replace(/\r?\n/g, "\r\n");
        fs.writeFileSync(runBatDst, content, "utf8");
        console.log(`[setup] Copied run.bat (CRLF) -> ${runBatDst}`);
    }
    else {
        console.warn(`[setup] WARN: source not found: ${runBatSrc}`);
    }
    copy(path.join(pkgRoot, "prompts", "deepseek-system-prompt.md"), path.join(targetDir, "prompts", "deepseek-system-prompt.md"));
    const envExample = path.join(pkgRoot, ".env.example");
    const envTarget = path.join(targetDir, ".env");
    if (fs.existsSync(envExample) && !fs.existsSync(envTarget)) {
        fs.copyFileSync(envExample, envTarget);
        console.log(`[setup] Created ${envTarget} from .env.example`);
    }
    if (process.env.DUB_SKIP_BROWSER_DOWNLOAD !== "true") {
        console.log("\n[setup] Checking browser...");
        try {
            const res = await downloadBrowser(path.join(targetDir, "ungooglium_ds"));
            console.log(res.skipped ? `[setup] Browser already present: ${res.path}` : `[setup] Browser installed: ${res.path}`);
        }
        catch (err) {
            console.warn("\n[setup] WARNING: could not download browser:", err.message);
            console.warn("[setup] Download manually from https://github.com/portapps/ungoogled-chromium-portable/releases");
            console.warn("[setup] and place ungoogled-chromium-portable.exe in C:\\DeepSeek\\ungooglium_ds\\");
        }
    }
    else {
        console.log("\n[setup] Browser download skipped (DUB_SKIP_BROWSER_DOWNLOAD=true).");
    }
    console.log("\n[setup] Done. Run: C:\\DeepSeek\\run.bat");
}
//# sourceMappingURL=setup.js.map