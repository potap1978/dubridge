import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadBrowser } from './download-browser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (process.platform === 'win32') {
  const targetDir = 'C:\\DeepSeek';
  const pkgRoot = path.resolve(__dirname, '..');

  console.log('\n[dubridge] Настройка структуры папок в', targetDir);

  const dirs = [
    targetDir,
    path.join(targetDir, 'ungooglium_ds'),
    path.join(targetDir, 'prompts'),
    path.join(targetDir, 'chrome-profile'),
    path.join(targetDir, 'Work-dir')
  ];
  dirs.forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

  const copy = (src, dest) => {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      console.log(`[dubridge] Скопирован ${path.basename(src)} -> ${dest}`);
    }
  };

  copy(path.join(pkgRoot, 'run.bat'), path.join(targetDir, 'run.bat'));
  copy(path.join(pkgRoot, 'prompts', 'deepseek-system-prompt.md'), path.join(targetDir, 'prompts', 'deepseek-system-prompt.md'));

  const envExample = path.join(pkgRoot, '.env.example');
  const envTarget = path.join(targetDir, '.env');
  if (fs.existsSync(envExample) && !fs.existsSync(envTarget)) {
    fs.copyFileSync(envExample, envTarget);
    console.log(`[dubridge] Создан ${envTarget} из шаблона .env.example`);
  }

  if (process.env.DUB_SKIP_BROWSER_DOWNLOAD !== 'true') {
    console.log('\n[dubridge] Проверка наличия браузера...');
    try {
      const res = await downloadBrowser(path.join(targetDir, 'ungooglium_ds'));
      if (!res.skipped) console.log('[dubridge] Браузер успешно установлен:', res.path);
      else console.log('[dubridge] Браузер уже установлен:', res.path);
    } catch (err) {
      console.warn('\n[dubridge] ВНИМАНИЕ: Не удалось автоматически скачать браузер.');
      console.warn(`[dubridge] Причина: ${err.message}`);
      console.warn('[dubridge] Скачайте вручную с https://github.com/portapps/ungoogled-chromium-portable/releases');
      console.warn('[dubridge] И положите ungoogled-chromium-portable.exe в C:\\DeepSeek\\ungooglium_ds\\');
      console.warn('[dubridge] (Чтобы отключить авто-загрузку при установке: DUB_SKIP_BROWSER_DOWNLOAD=true)\n');
    }
  } else {
    console.log('\n[dubridge] Авто-загрузка браузера отключена (DUB_SKIP_BROWSER_DOWNLOAD=true).');
  }

  console.log('\n[dubridge] Готово!');
  console.log('[dubridge] Запуск: C:\\DeepSeek\\run.bat\n');
}
