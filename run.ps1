$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$TargetDir = $PSScriptRoot
$ProfileDir = Join-Path $TargetDir "chrome-profile"

$ChromeExe = $null
$candidates = @(
    (Join-Path $TargetDir "ungooglium_ds\ungoogled-chromium-portable.exe"),
    (Join-Path $TargetDir "ungoogled-chromium-portable.exe")
)
foreach ($c in $candidates) { if (Test-Path $c) { $ChromeExe = $c; break } }

if (-not $ChromeExe) {
    $found = Get-ChildItem -Path $TargetDir -Filter "*chromium*.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) {
        $dst = Join-Path $TargetDir "ungooglium_ds\ungoogled-chromium-portable.exe"
        if (-not (Test-Path (Split-Path $dst))) { New-Item -ItemType Directory -Path (Split-Path $dst) -Force | Out-Null }
        Copy-Item $found.FullName $dst -Force
        $ChromeExe = $dst
    }
}

if (-not $ChromeExe) {
    Write-Host "[Error] ungoogled-chromium-portable.exe not found." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

$EnvFile = Join-Path $TargetDir ".env"
$Port = 9222
$Workspace = Join-Path $TargetDir "Work-dir"
$PromptFile = Join-Path $TargetDir "prompts\deepseek-system-prompt.md"

if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        if ($_ -match '^\s*DUB_CDP_PORT\s*=\s*(\d+)') { $Port = [int]$Matches[1] }
        if ($_ -match '^\s*DUB_WORKSPACE_ROOT\s*=\s*(.+)$') { $Workspace = $Matches[1].Trim() }
        if ($_ -match '^\s*DUB_PROMPT_FILE\s*=\s*(.+)$') { $PromptFile = $Matches[1].Trim() }
    }
}

$env:DUB_CDP_PORT = $Port
$env:DUB_PROMPT_FILE = $PromptFile
$env:DUB_WORKSPACE_ROOT = $Workspace

$portOpen = $false
try {
    $null = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    $portOpen = $true
} catch {}

if ($portOpen) {
    Write-Host "[OK] port $Port is already available"
} else {
    Write-Host "[..] starting browser..."
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
    $NeedDownload = $true
} else {
    $content = Get-Content $LocalMjs -Raw -ErrorAction SilentlyContinue
    if ($content -notmatch "DUBRIDGE_BUILD=12") {
        $NeedDownload = $true
    }
}

if ($NeedDownload) {
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri "https://raw.githubusercontent.com/potap1978/dubridge/main/dubridge.mjs" -OutFile $LocalMjs -UseBasicParsing -TimeoutSec 60
    } catch {
        Write-Host "[Error] Failed to download dubridge.mjs: $($_.Exception.Message)" -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
}

& node $LocalMjs run --no-launch -w $Workspace

Write-Host ""
Read-Host "Press Enter to exit"
