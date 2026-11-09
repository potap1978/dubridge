# Ungoogled Chromium Portable — справочник по настройке

Файл для справки. Держи рядом с `ungoogled-chromium-portable.exe`.

---

## Что это

Портативная сборка Ungoogled Chromium для Windows на базе Portapps. Всё, включая профиль, хранится в одной папке. При переносе на другую машину ничего не «слетает» — при условии, что сборка запускается через `ungoogled-chromium-portable.exe` (а не через `chrome.exe` напрямую).

Источник: `https://portapps.io/app/ungoogled-chromium-portable/`

---

## Быстрый старт

1. Распаковать архив в любую папку (например, на флешку).
2. Запустить `ungoogled-chromium-portable.exe`.
3. При первом запуске рядом появится файл `ungoogled-chromium-portable.sample.yml`.
4. Переименовать его в `ungoogled-chromium-portable.yml`.
5. Редактировать этот файл для добавления своих флагов.

Без переименования YAML-файл не применяется — Portapps использует настройки по умолчанию.

---

## Структура конфигурации

Файл `ungoogled-chromium-portable.yml` состоит из двух основных секций.

### `common` — общие настройки Portapps

| Поле | Тип | Описание |
| :--- | :--- | :--- |
| `disable_log` | bool | Отключить логирование Portapps (не браузера) |
| `args` | list | Дополнительные аргументы, передаваемые в Chrome |
| `env` | map | Переменные окружения |
| `app_path` | string | Путь к бинарникам приложения (только для сетевых дисков) |

### `app` — специфичные настройки Ungoogled Chromium

| Поле | Тип | По умолчанию | Описание |
| :--- | :--- | :--- | :--- |
| `cleanup` | bool | `false` | Удалять ли временные папки при выходе |

---

## Пример конфигурации под задачу (CDP + изоляция домена)

~~~yaml
common:
  disable_log: false
  args:
    - --remote-debugging-port=9222
    - --host-resolver-rules=MAP * 127.0.0.1, EXCLUDE test-domain.com
  env: {}

app:
  cleanup: true
~~~

### Что здесь происходит

- `--remote-debugging-port=9222` — открывает CDP-порт для управления через Pi.
- `--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE test-domain.com` — все домены, кроме `test-domain.com`, разрешаются в `127.0.0.1`. Браузер физически не может достучаться до внешнего мира, кроме тестового стенда.
- `cleanup: true` — при выходе удаляются временные папки.

---

## Что Portapps добавляет автоматически (не нужно дублировать)

Сборка Portapps **сама** передаёт эти флаги при каждом запуске через `ungoogled-chromium-portable.exe`. Не добавляй их в `common.args` — будут дубли.

| Флаг | Назначение |
| :--- | :--- |
| `--user-data-dir=<data_path>` | Профиль внутри папки сборки |
| `--no-default-browser-check` | Не проверять браузер по умолчанию |
| `--disable-logging` | Отключить логирование браузера |
| `--disable-breakpad` | Отключить crash reporting |
| `--disable-machine-id` | Отключить генерацию machine ID |
| `--disable-encryption-win` | Отключить шифрование cookies/паролей/настроек |

Твои аргументы из `common.args` **добавляются** к этому списку, а не заменяют его.

---

## ⚠️ Безопасность: `--disable-encryption-win`

Portapps **сам** добавляет этот флаг. Это означает, что **пароли, cookies и настройки хранятся на диске в открытом виде**.

Официальное предупреждение Portapps: «passwords, cookies and other settings will not be encrypted on your hard drive. It is therefore advisable to have this data on an encrypted hard disk».

### Что делать

- **Не хранить пароли в браузере.** Использовать внешний менеджер (KeePassXC, Bitwarden) с зашифрованной базой.
- **Шифровать носитель.** BitLocker (Windows) или VeraCrypt — если сборка на флешке или внешнем диске.
- **Для тестового ExtJS-стенда** это не критично — там нет личных данных.

---

## Шпаргалка: плейсхолдеры в `env` и `app_path`

В значениях `env` и `app_path` можно использовать плейсхолдеры, которые Portapps заменяет на актуальные пути при запуске.

| Плейсхолдер | Что означает |
| :--- | :--- |
| `@ROOT_PATH@` | Корневая папка портативного приложения |
| `@APP_PATH@` | Папка с бинарниками (обычно `app/`) |
| `@DATA_PATH@` | Папка с данными (профиль, кэш) |
| `@DRIVE_LETTER@` | Буква текущего диска |

Пример:

~~~yaml
common:
  env:
    MY_CONFIG: "@DATA_PATH@/config"
    LOGS: "@ROOT_PATH@/logs"
~~~

---

## Полезные ссылки

- Страница Portapps: `https://portapps.io/app/ungoogled-chromium-portable/`
- Документация по конфигурации: `https://portapps.io/doc/configuration/`
- Флаги Ungoogled Chromium: `https://github.com/ungoogled-software/ungoogled-chromium/blob/master/docs/flags.md`

---

## Частые проблемы

**Расширения «слетают» при переносе на другую машину.**
Причина: профиль зашифрован с привязкой к machine ID. Решение: запускать **только** через `ungoogled-chromium-portable.exe` — он добавляет `--disable-machine-id` и `--disable-encryption-win`. Если запускать `chrome.exe` напрямую, флаги не применяются.

**YAML-файл не работает.**
Проверить имя: должно быть `ungoogled-chromium-portable.yml` (не `.sample.yml`, не `.yaml`).

**CDP не подключается.**
Проверить, что `--remote-debugging-port=9222` действительно передан. Открыть `http://127.0.0.1:9222/json/version` в браузере. Если не отвечает — возможно, порт занят или флаг не применился.