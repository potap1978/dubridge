@echo off
chcp 65001 >nul
setlocal

REM ========== Settings ==========
set "NODE_DIR=%~dp0node"
set "CLI_DIR=%~dp0"
REM ==============================

set "PATH=%NODE_DIR%;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
  echo [Error] node not found: %NODE_DIR%
  pause & exit /b 1
)

echo.
echo [..] checking dubridge environment...
cd /d "%~dp0"
node %CLI_DIR%\dist\cli.js --doctor

pause
exit /b 0
