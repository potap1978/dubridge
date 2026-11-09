@echo off
chcp 65001 >nul
setlocal

REM ============================================================
REM dubridge standalone installer (no npm required)
REM Downloads all files to C:\DeepSeek and fetches the browser.
REM ============================================================

set "TARGET=C:\DeepSeek"
set "REPO=https://raw.githubusercontent.com/potap1978/dubridge/main"

echo [1/6] Creating %TARGET%...
if not exist "%TARGET%" mkdir "%TARGET%"
if not exist "%TARGET%\prompts" mkdir "%TARGET%\prompts"
if not exist "%TARGET%\ungooglium_ds" mkdir "%TARGET%\ungooglium_ds"
if not exist "%TARGET%\chrome-profile" mkdir "%TARGET%\chrome-profile"
if not exist "%TARGET%\Work-dir" mkdir "%TARGET%\Work-dir"

echo [2/6] Checking Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install from https://nodejs.org
  pause & exit /b 1
)

echo [3/6] Downloading dubridge.mjs...
powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -Uri '%REPO%/dubridge.mjs' -OutFile '%TARGET%\dubridge.mjs' -UseBasicParsing"
if errorlevel 1 (
  echo [ERROR] Failed to download dubridge.mjs
  pause & exit /b 1
)

echo [4/6] Downloading run scripts and prompt...
powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -Uri '%REPO%/run.bat' -OutFile '%TARGET%\run.bat' -UseBasicParsing; Invoke-WebRequest -Uri '%REPO%/run.ps1' -OutFile '%TARGET%\run.ps1' -UseBasicParsing; Invoke-WebRequest -Uri '%REPO%/prompts/deepseek-system-prompt.md' -OutFile '%TARGET%\prompts\deepseek-system-prompt.md' -UseBasicParsing"

if not exist "%TARGET%\.env" (
  echo [5/6] Creating .env...
  powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -Uri '%REPO%/.env.example' -OutFile '%TARGET%\.env' -UseBasicParsing"
) else (
  echo [5/6] .env already exists, skipping
)

echo [6/6] Downloading browser (~162 MB)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Continue'; $api='https://api.github.com/repos/portapps/ungoogled-chromium-portable/releases/latest'; $h=@{'User-Agent'='dubridge'}; $r=Invoke-RestMethod -Uri $api -Headers $h; $a=$r.assets | Where-Object {$_.name -like '*win64*.7z'} | Select-Object -First 1; $tmp=Join-Path $env:TEMP 'dubridge_browser.7z'; Invoke-WebRequest -Uri $a.browser_download_url -OutFile $tmp; $z=Get-Command 7z -ErrorAction SilentlyContinue; if (-not $z) { $z=Get-Command 'C:\Program Files\7-Zip\7z.exe' -ErrorAction SilentlyContinue }; if ($z) { & $z.Source x $tmp \"-o$env:TARGET\" -y } else { Write-Host '[WARN] 7-Zip not found. Download manually: https://github.com/portapps/ungoogled-chromium-portable/releases'; Write-Host \"Saved archive: $tmp\" }; Remove-Item $tmp -ErrorAction SilentlyContinue"

echo.
echo ============================================================
echo  Installation complete!
echo.
echo  Run: %TARGET%\run.bat
echo ============================================================
pause
