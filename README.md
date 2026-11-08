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

## Использование

```bash
dubridge run -w /path/to/repo -p "твой запрос"
```

## Настройка (опционально)

Скопируйте `.env.example` в `.env` и настройте под себя. Все переменные опциональны.

Основные:
- `DUB_WORKSPACE_ROOT` — рабочий каталог (по умолчанию текущий)
- `DUB_LAUNCH_CHROME=false` — подключиться к уже запущенному Chrome (порт 9222)
- `DUB_AUTO_APPROVE_COMMANDS=true` — выполнять все команды без whitelist (ОПАСНО)
- `DUB_COMMAND_WHITELIST_EXTRA` — дополнительные разрешённые команды
- `DUB_MAX_ITERATIONS` — лимит итераций агента (по умолчанию 50)

## Системный промпт

Файл `prompts/deepseek-system-prompt.md` содержит промпт для DeepSeek. Он автоматически отправляется в чат при старте (если не задан `DUB_SKIP_SYSTEM_PROMPT=true`).
