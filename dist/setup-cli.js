import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/setup.ts
import fs2 from "node:fs";
import path2 from "node:path";
import { fileURLToPath } from "node:url";

// src/download-browser.ts
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import os from "node:os";
import { execFileSync } from "node:child_process";
var API = "https://api.github.com/repos/portapps/ungoogled-chromium-portable/releases/latest";
var SEVEN_ZR_URL = "https://www.7-zip.org/a/7zr.exe";
function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "dubridge" } }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, { headers: { "User-Agent": "dubridge" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        try {
          fs.unlinkSync(dest);
        } catch {
        }
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try {
          fs.unlinkSync(dest);
        } catch {
        }
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    }).on("error", (err) => {
      file.close();
      try {
        fs.unlinkSync(dest);
      } catch {
      }
      reject(err);
    });
  });
}
async function extract7z(archive, targetDir) {
  const candidates = [
    "7z",
    "7za",
    "C:\\Program Files\\7-Zip\\7z.exe",
    "C:\\Program Files (x86)\\7-Zip\\7z.exe"
  ];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["x", archive, `-o${targetDir}`, "-y"], { stdio: "pipe" });
      return;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  const sevenZr = path.join(os.tmpdir(), "dubridge-7zr.exe");
  if (!fs.existsSync(sevenZr)) {
    console.log("[download-browser] System 7z not found. Downloading 7zr.exe fallback (~600KB)...");
    await download(SEVEN_ZR_URL, sevenZr);
  }
  try {
    execFileSync(sevenZr, ["x", archive, `-o${targetDir}`, "-y"], { stdio: "inherit" });
  } finally {
    try {
      fs.unlinkSync(sevenZr);
    } catch {
    }
  }
}
async function downloadBrowser(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const exePath = path.join(targetDir, "ungoogled-chromium-portable.exe");
  if (fs.existsSync(exePath)) return { skipped: true, path: exePath };
  console.log("[download-browser] Fetching latest release info...");
  const release = await getJson(API);
  const asset = release.assets.find((a) => a.name.endsWith(".7z") && a.name.includes("win64"));
  if (!asset) throw new Error("No suitable .7z asset in latest release");
  const tmpArchive = path.join(targetDir, "_browser.7z");
  console.log(`[download-browser] Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)...`);
  await download(asset.browser_download_url, tmpArchive);
  console.log("[download-browser] Extracting...");
  try {
    await extract7z(tmpArchive, targetDir);
  } finally {
    try {
      fs.unlinkSync(tmpArchive);
    } catch {
    }
  }
  if (!fs.existsSync(exePath)) {
    const found = fs.readdirSync(targetDir).find((f) => f.endsWith(".exe") && f.toLowerCase().includes("chromium"));
    if (found) fs.renameSync(path.join(targetDir, found), exePath);
    else throw new Error(`Extracted but no chromium .exe found in ${targetDir}`);
  }
  return { skipped: false, path: exePath };
}

// src/setup.ts
async function setup() {
  if (process.platform !== "win32") {
    console.log("[setup] On non-Windows, nothing to set up. Use dubridge run directly.");
    return;
  }
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path2.dirname(__filename);
  const pkgRoot = path2.resolve(__dirname, "..");
  const targetDir = "C:\\DeepSeek";
  console.log("[setup] Creating structure in", targetDir);
  const dirs = [
    targetDir,
    path2.join(targetDir, "ungooglium_ds"),
    path2.join(targetDir, "prompts"),
    path2.join(targetDir, "chrome-profile"),
    path2.join(targetDir, "Work-dir")
  ];
  for (const d of dirs) fs2.mkdirSync(d, { recursive: true });
  const copy = (src, dest) => {
    if (fs2.existsSync(src)) {
      fs2.copyFileSync(src, dest);
      console.log(`[setup] Copied ${path2.basename(src)} -> ${dest}`);
    } else {
      console.warn(`[setup] WARN: source not found: ${src}`);
    }
  };
  const runBatSrc = path2.join(pkgRoot, "run.bat");
  const runBatDst = path2.join(targetDir, "run.bat");
  if (fs2.existsSync(runBatSrc)) {
    const content = fs2.readFileSync(runBatSrc, "utf8").replace(/\r?\n/g, "\r\n");
    fs2.writeFileSync(runBatDst, content, "utf8");
    console.log(`[setup] Copied run.bat (CRLF) -> ${runBatDst}`);
  } else {
    console.warn(`[setup] WARN: source not found: ${runBatSrc}`);
  }
  copy(path2.join(pkgRoot, "run.ps1"), path2.join(targetDir, "run.ps1"));
  copy(path2.join(pkgRoot, "prompts", "deepseek-system-prompt.md"), path2.join(targetDir, "prompts", "deepseek-system-prompt.md"));
  const envExample = path2.join(pkgRoot, ".env.example");
  const envTarget = path2.join(targetDir, ".env");
  if (fs2.existsSync(envExample) && !fs2.existsSync(envTarget)) {
    fs2.copyFileSync(envExample, envTarget);
    console.log(`[setup] Created ${envTarget} from .env.example`);
  }
  if (process.env.DUB_SKIP_BROWSER_DOWNLOAD !== "true") {
    console.log("\n[setup] Checking browser...");
    try {
      const res = await downloadBrowser(path2.join(targetDir, "ungooglium_ds"));
      console.log(res.skipped ? `[setup] Browser already present: ${res.path}` : `[setup] Browser installed: ${res.path}`);
    } catch (err) {
      console.warn("\n[setup] WARNING: could not download browser:", err.message);
      console.warn("[setup] Download manually from https://github.com/portapps/ungoogled-chromium-portable/releases");
      console.warn("[setup] and place ungoogled-chromium-portable.exe in C:\\DeepSeek\\ungooglium_ds\\");
    }
  } else {
    console.log("\n[setup] Browser download skipped (DUB_SKIP_BROWSER_DOWNLOAD=true).");
  }
  console.log("\n[setup] Done. Run: C:\\DeepSeek\\run.bat");
}

// src/setup-cli.ts
setup().catch((err) => {
  console.warn("[dubridge] setup warning:", err?.message || err);
  console.warn("[dubridge] You can retry later: dubridge setup");
  process.exit(0);
});
