# dubridge

## Что нужно установить заранее

1. **Node.js (версия 20 или выше)** — https://nodejs.org
   Проверка: `node --version`
2. **Git** — https://git-scm.com
   Проверка: `git --version`
3. **Google Chrome или Chromium** — библиотека использует уже установленный в системе браузер.
   Если Chrome установлен в нестандартное место, задайте переменную окружения `CHROME_PATH`.

## Установка

```bash
npm i -g github:potap1978/dubridge
```

На Windows во время установки автоматически создаётся структура в `C:\DeepSeek` (папки `ungooglium_ds`, `prompts`, `chrome-profile`, файлы `run.bat` и `.env`).

## Использование

```bash
dubridge run -w /path/to/repo -p "твой запрос"
```

На Windows удобнее запускать через `C:\DeepSeek\run.bat` — скрипт сам поднимет браузер с CDP и передаст агенту системный промпт.

## Настройка (опционально)

Скопируйте `.env.example` в `.env` и настройте под себя. Все переменные опциональны.

Основные:
- `DUB_WORKSPACE_ROOT` — рабочий каталог (по умолчанию текущий)
- `DUB_LAUNCH_CHROME=false` — подключиться к уже запущенному Chrome (порт 9222)
- `DUB_AUTO_APPROVE_COMMANDS=true` — выполнять все команды без whitelist (ОПАСНО)
- `DUB_COMMAND_WHITELIST_EXTRA` — дополнительные разрешённые команды
- `DUB_MAX_ITERATIONS` — лимит итераций агента (по умолчанию 50)
- `DUB_SSH_ALLOW_NON_TTY_MUTATIONS` — разрешить мутации по SSH без TTY-подтверждения (по умолчанию `false`, ОПАСНО)

## SSH-инструменты

Агент умеет работать с удалёнными хостами:

- `ssh_probe` — read-only разведка (`whoami`, `hostname`, `pwd`, `uname -a`, `id`)
- `ssh_exec` — выполнение команд (с защитой, см. таблицу ниже)
- `ssh_copy` — загрузка/скачивание файлов через SFTP

Аутентификация: ключи из `~/.ssh` (`id_ed25519`, `id_rsa`) или пароль через env-переменную (`password_env`). Пароль в открытом виде не рекомендуется.

### Защита SSH (3 слоя)

| Команда | TTY (run.bat) | Non-TTY (CI, cron) |
|---|---|---|
| `cat`, `ls`, `ps`, `df`, `journalctl`, `systemctl status`, `git status`, `docker ps` | ✅ сразу | ✅ сразу |
| `systemctl restart/stop`, `apt install/remove`, `rm`, `chmod`, `sed -i` | ⚠️ `y/N` | ❌ `COMMAND_DENIED` |
| `rm -rf /`, `mkfs`, `dd of=/dev/sd*`, fork bomb, `> /etc/passwd`, `chmod -R 777 /`, `shutdown`/`reboot`/`poweroff`/`halt` | ❌ `COMMAND_BLOCKED` | ❌ `COMMAND_BLOCKED` |
| `ssh_copy` с `dst` в `/etc`, `/boot`, `/usr`, `/var/lib`, `/root`, `/bin`, `/sbin`, `/lib`, `/dev`, `/proc`, `/sys`, `/var/log`, `/var/run` | ❌ `COMMAND_BLOCKED` | ❌ `COMMAND_BLOCKED` |

Чтобы разрешить мутации без TTY (не рекомендуется), установите `DUB_SSH_ALLOW_NON_TTY_MUTATIONS=true` в `.env`.

## Системный промпт

Файл `prompts/deepseek-system-prompt.md` содержит промпт для DeepSeek. Он автоматически отправляется в чат при старте (если не задан `DUB_SKIP_SYSTEM_PROMPT=true`).
