@echo off
chcp 65001 >nul
setlocal

REM ========== Settings ==========
set "TARGET_DIR=C:\DeepSeek"
REM ==============================

echo [..] Creating folder structure in %TARGET_DIR%...
if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"
if not exist "%TARGET_DIR%\ungooglium_ds" mkdir "%TARGET_DIR%\ungooglium_ds"
if not exist "%TARGET_DIR%\prompts" mkdir "%TARGET_DIR%\prompts"

echo [..] Copying files...
copy /y "%~dp0run.bat" "%TARGET_DIR%\run.bat" >nul
if not exist "%TARGET_DIR%\.env" (
    copy /y "%~dp0.env.example" "%TARGET_DIR%\.env" >nul
)
copy /y "%~dp0prompts\deepseek-system-prompt.md" "%TARGET_DIR%\prompts\deepseek-system-prompt.md" >nul

echo.
echo [OK] Done! Structure created in %TARGET_DIR%
echo.
echo IMPORTANT: Please place your ungoogled-chromium-portable.exe in:
echo %TARGET_DIR%\ungooglium_ds\
echo.
pause
