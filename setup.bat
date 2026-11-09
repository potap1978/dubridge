@echo off
chcp 65001 >nul
setlocal

echo [..] Проверяем git-lfs...
where git-lfs >nul 2>&1
if errorlevel 1 (
  echo [Error] git-lfs не установлен.
  echo Скачайте и установите: https://git-lfs.github.com/
  echo Затем выполните: git lfs install
  pause
  exit /b 1
)

echo [..] Настраиваем git-lfs...
git lfs install

echo [..] Загружаем LFS-бинарники (Chrome, Node)...
git lfs pull

if not exist "ungooglium_ds\ungoogled-chromium-portable.exe" (
  echo [Error] не удалось загрузить ungoogled-chromium-portable.exe
  echo Проверьте подключение к GitHub и права доступа к репозиторию.
  pause
  exit /b 1
)

if not exist "node\node.exe" (
  echo [Error] не удалось загрузить node.exe
  pause
  exit /b 1
)

echo [OK] Все бинарники на месте.
echo Запустите run.bat для старта dubridge.
pause
