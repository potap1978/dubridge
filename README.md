# dubridge

## 1. Требования

```powershell
node --version   # >= 20
git --version
```

Node.js: https://nodejs.org
Git: https://git-scm.com
Chrome/Chromium: установить в системе

## 2. Установка

```powershell
npm i -g github:potap1978/dubridge
```

Автоматически создаётся:

```
C:\DeepSeek\
  run.bat
  .env
  prompts\deepseek-system-prompt.md
  ungooglium_ds\
  chrome-profile\
```

## 3. Браузер

```powershell
copy C:\path\ungoogled-chromium-portable.exe C:\DeepSeek\ungooglium_ds\
dir C:\DeepSeek\ungooglium_ds\ungoogled-chromium-portable.exe
```

## 4. .env

```powershell
notepad C:\DeepSeek\.env
```

```
DUB_CDP_PORT=9222
DUB_WORKSPACE_ROOT=C:\path\to\repo
```

## 5. Запуск

```powershell
C:\DeepSeek\run.bat
```

## 6. Остановка

```powershell
Ctrl+C в окне run.bat, затем закрыть браузер
```

## 7. Обновление

```powershell
npm uninstall -g dubridge
npm i -g github:potap1978/dubridge
```

## 8. Удаление

```powershell
npm uninstall -g dubridge
rmdir /s /q C:\DeepSeek
```

## 9. Диагностика

```powershell
dubridge --version
netstat -ano | findstr 9222
dubridge run -w C:\DeepSeek -p "start" --no-launch
```
