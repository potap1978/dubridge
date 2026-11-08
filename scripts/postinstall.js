import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    path.join(targetDir, 'chrome-profile')
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
  
  console.log('\n[dubridge] Готово! Не забудьте положить ваш браузер в C:\\DeepSeek\\ungooglium_ds\\');
  console.log('Запускайте агента через C:\\DeepSeek\\run.bat\n');
}
