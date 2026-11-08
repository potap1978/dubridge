import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const targetDir = path.resolve(__dirname, '..', 'ungooglium_ds');
const exePath = path.join(targetDir, 'ungoogled-chromium-portable.exe');

if (fs.existsSync(exePath)) {
  console.log('[download-browser] Browser already exists:', exePath);
  process.exit(0);
}

fs.mkdirSync(targetDir, { recursive: true });

const API = 'https://api.github.com/repos/portapps/ungoogled-chromium-portable/releases/latest';

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'dubridge' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, { headers: { 'User-Agent': 'dubridge' } }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => { file.close(); fs.unlinkSync(dest); reject(err); });
  });
}

(async () => {
  try {
    console.log('[download-browser] Fetching latest release info...');
    const release = await getJson(API);
    const asset = release.assets.find(a => a.name.endsWith('.7z') && a.name.includes('win64'));
    if (!asset) throw new Error('No suitable .7z asset found in latest release');

    const tmpArchive = path.join(targetDir, '_browser.7z');
    console.log('[download-browser] Downloading', asset.name, `(${(asset.size / 1024 / 1024).toFixed(1)} MB)...`);
    await download(asset.browser_download_url, tmpArchive);

    console.log('[download-browser] Download complete. Extracting...');
    const { execFileSync } = await import('node:child_process');
    try {
      execFileSync('7z', ['x', tmpArchive, `-o${targetDir}`, '-y'], { stdio: 'inherit' });
    } catch (e) {
      console.error('[download-browser] 7z not found. Please install 7-Zip (https://7-zip.org) and run again.');
      console.error('[download-browser] Or manually extract', tmpArchive, 'to', targetDir);
      process.exit(1);
    }
    fs.unlinkSync(tmpArchive);

    const extractedExe = path.join(targetDir, 'ungoogled-chromium-portable.exe');
    if (fs.existsSync(extractedExe)) {
      console.log('[download-browser] Done:', extractedExe);
    } else {
      console.log('[download-browser] Extracted. Check', targetDir, 'for the .exe');
    }
  } catch (err) {
    console.error('[download-browser] Error:', err.message);
    process.exit(1);
  }
})();
