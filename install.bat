@echo off
chcp 65001 >nul
setlocal

REM ============================================================
REM dubridge standalone installer
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

where curl >nul 2>nul
if errorlevel 1 (
  echo [ERROR] curl not found. Windows 10/11 should have it.
  pause & exit /b 1
)

echo [3/6] Downloading dubridge.mjs...
curl -fsSL "%REPO%/dubridge.mjs" -o "%TARGET%\dubridge.mjs"
if errorlevel 1 (
  echo [ERROR] Failed to download dubridge.mjs
  pause & exit /b 1
)

echo [4/6] Downloading run scripts and prompt...
curl -fsSL "%REPO%/run.bat" -o "%TARGET%\run.bat"
curl -fsSL "%REPO%/run.ps1" -o "%TARGET%\run.ps1"
curl -fsSL "%REPO%/prompts/deepseek-system-prompt.md" -o "%TARGET%\prompts\deepseek-system-prompt.md"

if not exist "%TARGET%\.env" (
  echo [5/6] Creating .env...
  curl -fsSL "%REPO%/.env.example" -o "%TARGET%\.env"
) else (
  echo [5/6] .env already exists, skipping
)

echo [6/6] Downloading browser (~162 MB)...
call :download_browser

echo.
echo ============================================================
echo  Installation complete!
echo.
echo  Run: %TARGET%\run.bat
echo ============================================================
pause
endlocal
exit /b 0

:download_browser
set "BROWSER_URL=https://api.github.com/repos/portapps/ungoogled-chromium-portable/releases/latest"
set "API_TMP=%TEMP%\dubridge_api.json"
set "ARCHIVE=%TEMP%\dubridge_browser.7z"
set "DST=%TARGET%\ungooglium_ds"

curl -fsSL "%BROWSER_URL%" -o "%API_TMP%"
if errorlevel 1 (
  echo [WARN] Could not fetch browser release info.
  exit /b 1
)

for /f "delims=" %%U in ('powershell -NoProfile -Command "(Get-Content '%API_TMP%' | ConvertFrom-Json).assets | Where-Object { $_.name -like '*win64*.7z' } | Select-Object -First 1 -ExpandProperty browser_download_url"') do set "DOWNLOAD_URL=%%U"

if not defined DOWNLOAD_URL (
  echo [WARN] Browser asset not found in release.
  exit /b 1
)

echo Downloading %DOWNLOAD_URL%...
curl -fL "%DOWNLOAD_URL%" -o "%ARCHIVE%"
if errorlevel 1 (
  echo [WARN] Download failed. Get manually: https://github.com/portapps/ungoogled-chromium-portable/releases
  exit /b 1
)

set "SEVENZIP="
if exist "C:\Program Files\7-Zip\7z.exe" set "SEVENZIP=C:\Program Files\7-Zip\7z.exe"
if exist "C:\Program Files (x86)\7-Zip\7z.exe" set "SEVENZIP=C:\Program Files (x86)\7-Zip\7z.exe"
if not defined SEVENZIP (
  echo [WARN] 7-Zip not found. Install with: winget install 7zip.7zip
  echo [WARN] Or extract %ARCHIVE% manually to %DST%
  exit /b 1
)

"%SEVENZIP%" x "%ARCHIVE%" "-o%DST%" -y >nul
if errorlevel 1 (
  echo [WARN] Extraction failed.
  exit /b 1
)

REM Find chromium exe in extracted files and move to expected name
for /r "%DST%" %%F in (*chromium*.exe) do (
  if /i not "%%~nxF"=="ungoogled-chromium-portable.exe" (
    copy /y "%%F" "%DST%\ungoogled-chromium-portable.exe" >nul
  )
)

if exist "%DST%\ungoogled-chromium-portable.exe" (
  echo [OK] Browser installed: %DST%\ungoogled-chromium-portable.exe
) else (
  echo [WARN] Browser exe not found after extraction.
)

del /f /q "%ARCHIVE%" 2>nul
del /f /q "%API_TMP%" 2>nul
exit /b 0
