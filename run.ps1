$ErrorActionPreference = "Continue"

$TargetDir = $PSScriptRoot
$ProfileDir = Join-Path $TargetDir "chrome-profile"

# Find browser exe (may have been extracted to different location)
$ChromeExe = $null
$candidates = @(
    (Join-Path $TargetDir "ungooglium_ds\ungoogled-chromium-portable.exe"),
    (Join-Path $TargetDir "ungoogled-chromium-portable.exe"),
    (Join-Path $TargetDir "ungoogled-chromium-portable\ungoogled-chromium-portable.exe")
)
foreach ($c in $candidates) { if (Test-Path $c) { $ChromeExe = $c; break } }
if (-not $ChromeExe) {
    $found = Get-ChildItem -Path $TargetDir -Filter "*chromium*.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) {
        $dst = Join-Path $TargetDir "ungooglium_ds\ungoogled-chromium-portable.exe"
        if (-not (Test-Path (Split-Path $dst))) { New-Item -ItemType Directory -Path (Split-Path $dst) -Force | Out-Null }
        Copy-Item $found.FullName $dst -Force
        $ChromeExe = $dst
        Write-Host "[..] found browser at $($found.FullName), copied to $dst"
    }
}
if (-not $ChromeExe) {
    Write-Host "[Error] ungoogled-chromium-portable.exe not found in $TargetDir" -ForegroundColor Red
    Write-Host "Re-run install.bat or download from https://github.com/portapps/ungoogled-chromium-portable/releases"
    Read-Host "Press Enter to exit"
    exit 1
}
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

$LocalMjs = Join-Path $TargetDir "dubridge.mjs"
$NeedDownload = $false

if (-not (Test-Path $LocalMjs)) {
    Write-Host "[..] dubridge.mjs not found, downloading..."
    $NeedDownload = $true
} else {
    # Check if this is a stale build (missing marker)
    $content = Get-Content $LocalMjs -Raw -ErrorAction SilentlyContinue
    if ($content -notmatch "DUBRIDGE_BUILD_OK") {
        Write-Host "[..] dubridge.mjs is stale, updating..."
        $NeedDownload = $true
    }
}

if ($NeedDownload) {
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri "https://raw.githubusercontent.com/potap1978/dubridge/main/dubridge.mjs" -OutFile $LocalMjs -UseBasicParsing -TimeoutSec 60
        Write-Host "[OK] dubridge.mjs updated"
    } catch {
        Write-Host "[Error] Failed to download dubridge.mjs: $($_.Exception.Message)" -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
}

& node $LocalMjs run --no-launch -w $Workspace -p "Начинай работу, отправь системный промпт и жди моей команды."

Write-Host ""
Read-Host "Press Enter to exit"
