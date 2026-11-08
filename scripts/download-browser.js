import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const API = 'https://api.github.com/repos/portapps/ungoogled-chromium-portable/releases/latest';
const SEVEN_ZR_URL = 'https://www.7-zip.org/a/7zr.exe';

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'dubridge' } }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, { headers: { 'User-Agent': 'dubridge' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => { file.close(); try { fs.unlinkSync(dest); } catch {} reject(err); });
  });
}

async function extract7z(archive, targetDir) {
  const candidates = [
    '7z', '7za',
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  ];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['x', archive, `-o${targetDir}`, '-y'], { stdio: 'pipe' });
      return;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  // Fallback: download 7zr.exe
  const sevenZr = path.join(os.tmpdir(), 'dubridge-7zr.exe');
  if (!fs.existsSync(sevenZr)) {
    console.log('[download-browser] System 7z not found. Downloading 7zr.exe fallback (~600KB)...');
    await download(SEVEN_ZR_URL, sevenZr);
  }
  try {
    execFileSync(sevenZr, ['x', archive, `-o${targetDir}`, '-y'], { stdio: 'inherit' });
  } finally {
    try { fs.unlinkSync(sevenZr); } catch {}
  }
}

export async function downloadBrowser(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const exePath = path.join(targetDir, 'ungoogled-chromium-portable.exe');
  if (fs.existsSync(exePath)) {
    return { skipped: true, path: exePath };
  }

  console.log('[download-browser] Fetching latest release info...');
  const release = await getJson(API);
  const asset = release.assets.find((a) => a.name.endsWith('.7z') && a.name.includes('win64'));
  if (!asset) throw new Error('No suitable .7z asset in latest release');

  const tmpArchive = path.join(targetDir, '_browser.7z');
  console.log(`[download-browser] Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)...`);
  await download(asset.browser_download_url, tmpArchive);

  console.log('[download-browser] Extracting...');
  try {
    await extract7z(tmpArchive, targetDir);
  } finally {
    try { fs.unlinkSync(tmpArchive); } catch {}
  }

  if (!fs.existsSync(exePath)) {
    const found = fs.readdirSync(targetDir).find((f) => f.endsWith('.exe') && f.toLowerCase().includes('chromium'));
    if (found) {
      fs.renameSync(path.join(targetDir, found), exePath);
    } else {
      throw new Error(`Extracted but no chromium .exe found in ${targetDir}`);
    }
  }
  return { skipped: false, path: exePath };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const target = process.argv[2]
    || (process.platform === 'win32' ? 'C:\\DeepSeek\\ungooglium_ds' : path.resolve(process.cwd(), 'ungooglium_ds'));
  downloadBrowser(target)
    .then((r) => {
      console.log(r.skipped ? `[download-browser] Already present: ${r.path}` : `[download-browser] Done: ${r.path}`);
    })
    .catch((e) => {
      console.error('[download-browser] Error:', e.message);
      console.error('[download-browser] Manual: https://github.com/portapps/ungoogled-chromium-portable/releases');
      process.exit(1);
    });
}
