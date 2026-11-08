@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

REM ========== Settings ==========
set "NODE_DIR=%~dp0node"
set "CLI_DIR=%~dp0dubridge"
set "CHROME_EXE=%~dp0ungooglium_ds\ungoogled-chromium-portable.exe"
set "PROFILE_DIR=%~dp0chrome-profile"
set "ENV_FILE=%~dp0.env"
if not exist "%ENV_FILE%" set "ENV_FILE=%~dp0dubridge\.env"
set "PORT=9222"
REM ==============================

REM --- Read DUB_CDP_PORT from .env if exists ---
if exist "%ENV_FILE%" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    if /i "%%A"=="DUB_CDP_PORT" (
      if not "%%B"=="" set "PORT=%%B"
    )
  )
)
echo [..] using CDP port: %PORT%

set "PATH=%NODE_DIR%;%PATH%"
set "DUB_CDP_PORT=%PORT%"

where node >nul 2>nul
if errorlevel 1 (
  echo [Error] node not found: %NODE_DIR%
  pause & exit /b 1
)

if not exist "%CHROME_EXE%" (
  echo [Error] not found: %CHROME_EXE%
  echo Please place the ungoogled-chromium-portable.exe in the ungooglium_ds folder.
  pause & exit /b 1
)

REM already running?
node -e "fetch('http://127.0.0.1:%PORT%/json/version').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>nul
if not errorlevel 1 (
  echo [OK] port %PORT% is already available
  goto :runcli
)

echo [..] starting browser on port %PORT%...
start "" "%CHROME_EXE%" --remote-debugging-port=%PORT% --user-data-dir="%PROFILE_DIR%" "https://chat.deepseek.com/"

echo [..] waiting for port %PORT%...
set /a tries=0
:waitloop
set /a tries+=1
if !tries! gtr 60 goto :timeout
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

node "%CLI_DIR%\dist\index.js" run --no-launch -w . -p "Начинай работу, отправь системный промпт и жди моей команды."

pause
exit /b 0

:timeout
echo [Error] port %PORT% did not come up in 60 seconds.
echo Check if ungoogled-chromium-portable allows port %PORT%.
pause
exit /b 1
