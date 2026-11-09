$ErrorActionPreference = "Continue"

$TargetDir = $PSScriptRoot
$ChromeExe = Join-Path $TargetDir "ungooglium_ds\ungoogled-chromium-portable.exe"
$ProfileDir = Join-Path $TargetDir "chrome-profile"
$EnvFile = Join-Path $TargetDir ".env"
$PromptsFile = Join-Path $TargetDir "prompts\deepseek-system-prompt.md"
$Port = 9222

# Read DUB_CDP_PORT and DUB_WORKSPACE_ROOT from .env
$Workspace = Join-Path $TargetDir "Work-dir"
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        if ($_ -match '^\s*DUB_CDP_PORT\s*=\s*(\d+)') { $Port = [int]$Matches[1] }
        if ($_ -match '^\s*DUB_WORKSPACE_ROOT\s*=\s*(.+)$') { $Workspace = $Matches[1].Trim() }
    }
}

Write-Host "[..] using CDP port: $Port"
Write-Host "[..] using workspace: $Workspace"

$env:DUB_CDP_PORT = $Port
$env:DUB_PROMPT_FILE = $PromptsFile
$env:DUB_WORKSPACE_ROOT = $Workspace

# Check dubridge is installed
if (-not (Get-Command dubridge -ErrorAction SilentlyContinue)) {
    Write-Host "[Error] dubridge command not found." -ForegroundColor Red
    Write-Host "Please install: npm i -g github:potap1978/dubridge"
    Read-Host "Press Enter to exit"
    exit 1
}

if (-not (Test-Path $ChromeExe)) {
    Write-Host "[Error] not found: $ChromeExe" -ForegroundColor Red
    Write-Host "Run 'dubridge setup' to download the browser."
    Read-Host "Press Enter to exit"
    exit 1
}

# Check if port already open
$portOpen = $false
try {
    $null = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    $portOpen = $true
} catch {}

if ($portOpen) {
    Write-Host "[OK] port $Port is already available"
} else {
    Write-Host "[..] starting browser on port $Port..."
    if (-not (Test-Path $ProfileDir)) { New-Item -ItemType Directory -Path $ProfileDir | Out-Null }
    Start-Process -FilePath $ChromeExe -ArgumentList "--remote-debugging-port=$Port", "--user-data-dir=$ProfileDir", "--no-first-run", "--no-default-browser-check", "https://chat.deepseek.com/"

    Write-Host "[..] waiting for port $Port..."
    $tries = 0
    while ($tries -lt 60) {
        $tries++
        Start-Sleep -Seconds 1
        try {
            $null = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            $portOpen = $true
            break
        } catch {}
    }
    if (-not $portOpen) {
        Write-Host "[Error] port $Port did not come up in 60 seconds." -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-Host "[OK] port is ready"
}

Write-Host ""
Write-Host "[..] starting dubridge..."
Set-Location $TargetDir

& dubridge run --no-launch -w $Workspace -p "Начинай работу, отправь системный промпт и жди моей команды."

Write-Host ""
Read-Host "Press Enter to exit"
