@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

REM ========== Settings ==========
set "TARGET_DIR=%~dp0"
set "CHROME_EXE=%TARGET_DIR%ungooglium_ds\ungoogled-chromium-portable.exe"
set "PROFILE_DIR=%TARGET_DIR%chrome-profile"
set "ENV_FILE=%TARGET_DIR%.env"
set "PORT=9222"
REM ==============================

REM Add AppData\npm and local node to PATH
set "PATH=%AppData%\npm;%TARGET_DIR%node;%PATH%"

REM --- Read DUB_CDP_PORT from .env if exists ---
if exist "%ENV_FILE%" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    if /i "%%A"=="DUB_CDP_PORT" (
      if not "%%B"=="" set "PORT=%%B"
    )
  )
)
echo [..] using CDP port: %PORT%

set "DUB_CDP_PORT=%PORT%"
set "DUB_PROMPT_FILE=%TARGET_DIR%prompts\deepseek-system-prompt.md"
set "WORKSPACE=%TARGET_DIR%Work-dir"

REM --- Read DUB_WORKSPACE_ROOT from .env if exists ---
if exist "%ENV_FILE%" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    if /i "%%A"=="DUB_WORKSPACE_ROOT" (
      if not "%%B"=="" set "WORKSPACE=%%B"
    )
  )
)
echo [..] using workspace: %WORKSPACE%

REM Check if dubridge is installed
where dubridge >nul 2>nul
if errorlevel 1 (
  echo [Error] dubridge command not found.
  echo Please install it first: npm i -g github:potap1978/dubridge
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
cd /d "%TARGET_DIR%"

call dubridge run --no-launch -w "%WORKSPACE%" -p "Начинай работу, отправь системный промпт и жди моей команды."

pause
exit /b 0

:timeout
echo [Error] port %PORT% did not come up in 60 seconds.
echo Check if ungoogled-chromium-portable allows port %PORT%.
pause
exit /b 1
