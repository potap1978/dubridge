# dubridge

## 1. Установка Node.js и Git

Открыть PowerShell от имени Администратора:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

Перезапустить терминал и проверить:

```powershell
node --version   # >= 20
git --version
```

## 2. Установка dubridge

```powershell
npm i -g github:potap1978/dubridge
```

Автоматически создаётся структура (включая браузер):

```
C:\DeepSeek\
  run.bat
  .env
  prompts\deepseek-system-prompt.md
  ungooglium_ds\ungoogled-chromium-portable.exe
  chrome-profile\
  Work-dir\              <- сюда кладите свой проект
```

## 3. Рабочая папка

По умолчанию агент работает в `C:\DeepSeek\Work-dir`. Положите туда ваш проект или клонируйте репозиторий:

```powershell
cd C:\DeepSeek\Work-dir
git clone https://github.com/your/repo .
```

Если нужно работать в другой папке — измените `DUB_WORKSPACE_ROOT` в `.env`.

## 4. Настройка .env (опционально)

```powershell
notepad C:\DeepSeek\.env
```

```
DUB_CDP_PORT=9222
DUB_WORKSPACE_ROOT=C:\DeepSeek\Work-dir
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
dubridge run -w C:\DeepSeek\Work-dir -p "start" --no-launch
```
