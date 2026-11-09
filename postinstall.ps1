$ErrorActionPreference = "Continue"

$PkgDir = $PSScriptRoot
if (-not $PkgDir) { $PkgDir = (Get-Location).Path }

if ($env:OS -ne "Windows_NT") {
    Write-Host "[dubridge] postinstall: not Windows, skip"
    exit 0
}

$TargetDir = "C:\DeepSeek"
Write-Host "[dubridge] creating structure in $TargetDir"

$dirs = @(
    $TargetDir,
    (Join-Path $TargetDir "ungooglium_ds"),
    (Join-Path $TargetDir "prompts"),
    (Join-Path $TargetDir "chrome-profile"),
    (Join-Path $TargetDir "Work-dir")
)
foreach ($d in $dirs) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null } }

function Copy-File($src, $dst, $forceCRLF) {
    if (-not (Test-Path $src)) { Write-Host "[dubridge] WARN missing: $src"; return }
    if ($forceCRLF) {
        $content = (Get-Content $src -Raw) -replace "`r`n", "`n" -replace "`n", "`r`n"
        [System.IO.File]::WriteAllText($dst, $content, [System.Text.UTF8Encoding]::new($false))
    } else {
        Copy-Item -Path $src -Destination $dst -Force
    }
    Write-Host "[dubridge] copied $(Split-Path $src -Leaf) -> $dst"
}

Copy-File (Join-Path $PkgDir "run.bat")   (Join-Path $TargetDir "run.bat")   $true
Copy-File (Join-Path $PkgDir "run.ps1")   (Join-Path $TargetDir "run.ps1")   $false
Copy-File (Join-Path $PkgDir "prompts\deepseek-system-prompt.md") (Join-Path $TargetDir "prompts\deepseek-system-prompt.md") $false

$envExample = Join-Path $PkgDir ".env.example"
$envTarget  = Join-Path $TargetDir ".env"
if ((Test-Path $envExample) -and -not (Test-Path $envTarget)) {
    Copy-File $envExample $envTarget $false
}

# Download browser if not present
$exePath = Join-Path $TargetDir "ungooglium_ds\ungoogled-chromium-portable.exe"
if (Test-Path $exePath) {
    Write-Host "[dubridge] browser already present"
    exit 0
}

if ($env:DUB_SKIP_BROWSER_DOWNLOAD -eq "true") {
    Write-Host "[dubridge] browser download skipped (DUB_SKIP_BROWSER_DOWNLOAD=true)"
    exit 0
}

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Write-Host "[dubridge] fetching latest browser release info..."
    $api = "https://api.github.com/repos/portapps/ungoogled-chromium-portable/releases/latest"
    $headers = @{ "User-Agent" = "dubridge" }
    $release = Invoke-RestMethod -Uri $api -Headers $headers -TimeoutSec 30
    $asset = $release.assets | Where-Object { $_.name -like "*win64*.7z" } | Select-Object -First 1
    if (-not $asset) { throw "no suitable .7z asset in latest release" }

    $tmpArchive = Join-Path $TargetDir "ungooglium_ds\_browser.7z"
    Write-Host "[dubridge] downloading $($asset.name) ($([math]::Round($asset.size / 1MB, 1)) MB)..."
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tmpArchive -Headers $headers -TimeoutSec 600

    Write-Host "[dubridge] extracting..."
    $sevenZipCandidates = @(
        "7z",
        "7za",
        "$env:ProgramFiles\7-Zip\7z.exe",
        "${env:ProgramFiles(x86)}\7-Zip\7z.exe"
    )
    $extracted = $false
    foreach ($z in $sevenZipCandidates) {
        $cmd = Get-Command $z -ErrorAction SilentlyContinue
        if ($cmd) {
            & $cmd.Source x $tmpArchive "-o$(Join-Path $TargetDir 'ungooglium_ds')" -y | Out-Null
            $extracted = $true
            break
        }
    }
    if (-not $extracted) {
        # Download 7zr.exe fallback (~600KB)
        $sevenZr = Join-Path $env:TEMP "dubridge-7zr.exe"
        if (-not (Test-Path $sevenZr)) {
            Write-Host "[dubridge] system 7z not found, downloading 7zr.exe fallback..."
            Invoke-WebRequest -Uri "https://www.7-zip.org/a/7zr.exe" -OutFile $sevenZr -TimeoutSec 60
        }
        & $sevenZr x $tmpArchive "-o$(Join-Path $TargetDir 'ungooglium_ds')" -y | Out-Null
        Remove-Item $sevenZr -Force -ErrorAction SilentlyContinue
    }
    Remove-Item $tmpArchive -Force -ErrorAction SilentlyContinue

    if (-not (Test-Path $exePath)) {
        $found = Get-ChildItem (Join-Path $TargetDir "ungooglium_ds") -Filter "*chromium*.exe" | Select-Object -First 1
        if ($found) { Rename-Item $found.FullName $exePath }
        else { throw "extracted but no chromium .exe found" }
    }
    Write-Host "[dubridge] browser installed: $exePath"
} catch {
    Write-Host "[dubridge] WARNING: could not download browser: $($_.Exception.Message)"
    Write-Host "[dubridge] Download manually: https://github.com/portapps/ungoogled-chromium-portable/releases"
    Write-Host "[dubridge] Place ungoogled-chromium-portable.exe in C:\DeepSeek\ungooglium_ds\"
}

Write-Host "[dubridge] Done. Run: C:\DeepSeek\run.bat"
exit 0
