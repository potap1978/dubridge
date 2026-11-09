@echo off
chcp 65001 >nul
setlocal

REM ========== Settings ==========
set "NODE_DIR=%~dp0node"
set "CLI_DIR=%~dp0"
set "CHROME_EXE=%~dp0ungooglium_ds\ungoogled-chromium-portable.exe"
set "PORT=9222"
REM ==============================

REM Auto-restore LFS binaries if missing (Chrome, Node)
if not exist "%CHROME_EXE%" (
  echo [..] Восстанавливаем LFS-бинарники (Chrome, Node)...  
  git lfs pull
  if not exist "%CHROME_EXE%" (
    echo [Error] не удалось восстановить %CHROME_EXE%
    echo Установите git-lfs: https://git-lfs.github.com/
    echo Затем выполните: git lfs install && git lfs pull
    pause & exit /b 1
  )
)

set "PATH=%NODE_DIR%;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
  echo [Error] node not found: %NODE_DIR%
  pause & exit /b 1
)

if not exist "%CHROME_EXE%" (
  echo [Error] not found: %CHROME_EXE%
  pause & exit /b 1
)

REM already running?
node -e "fetch('http://127.0.0.1:%PORT%/json/version').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>nul
if not errorlevel 1 (
  echo [OK] port %PORT% is already available
  goto :runcli
)

echo [..] starting browser...
start "" "%CHROME_EXE%"

echo [..] waiting for port %PORT%...
set /a tries=0
:waitloop
set /a tries+=1
if %tries% gtr 60 goto :timeout
node -e "fetch('http://127.0.0.1:%PORT%/json/version').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>nul
if errorlevel 1 (
  timeout /t 1 /nobreak >nul
  goto :waitloop
)
echo [OK] port is ready

:runcli
echo.
echo [..] starting dubridge...
cd /d "%~dp0"
node %CLI_DIR%\dist\cli.js --no-preflight

pause
exit /b 0

:timeout
echo [Error] port %PORT% did not come up in 60 seconds.
echo Check that ungoogled-chromium-portable allows port %PORT%.
pause
exit /b 1
