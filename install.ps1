#Requires -Version 5.1
<#
  MoritApp — Windows install (PowerShell)

  One-liner (copy-paste):
    irm https://raw.githubusercontent.com/kgs142c/MoritApp/main/install.ps1 | iex

  Or from latest release asset (after each tag upload):
    irm https://github.com/kgs142c/MoritApp/releases/latest/download/install.ps1 | iex

  Options:
    irm ... | iex   # interactive Setup UI
    & ([scriptblock]::Create((irm ...))) -Silent
#>

[CmdletBinding()]
param(
  [switch]$Silent,
  [string]$Repo = "kgs142c/MoritApp",
  [string]$Tag = "latest"
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$msg) {
  Write-Host ""
  Write-Host "> $msg" -ForegroundColor Green
}

function Get-LatestWinSetup {
  param([string]$Repository, [string]$ReleaseTag)

  $headers = @{
    "User-Agent" = "MoritApp-Installer"
    "Accept"     = "application/vnd.github+json"
  }

  if ($ReleaseTag -eq "latest") {
    $api = "https://api.github.com/repos/$Repository/releases/latest"
  } else {
    $api = "https://api.github.com/repos/$Repository/releases/tags/$ReleaseTag"
  }

  Write-Step "Checking GitHub release ($ReleaseTag)…"
  $release = Invoke-RestMethod -Uri $api -Headers $headers -Method Get

  $asset = $release.assets |
    Where-Object { $_.name -match '^MoritApp-Setup-.*\.exe$' } |
    Select-Object -First 1

  if (-not $asset) {
    throw "No MoritApp-Setup-*.exe found on release $($release.tag_name)."
  }

  [pscustomobject]@{
    Tag      = $release.tag_name
    Name     = $asset.name
    Url      = $asset.browser_download_url
    Size     = [int64]$asset.size
    HtmlUrl  = $release.html_url
  }
}

try {
  Write-Host ""
  Write-Host "  MoritApp Windows installer" -ForegroundColor Cyan
  Write-Host "  Repo: $Repo" -ForegroundColor DarkGray

  $info = Get-LatestWinSetup -Repository $Repo -ReleaseTag $Tag
  Write-Host "  Release: $($info.Tag)" -ForegroundColor White
  Write-Host "  File:    $($info.Name)" -ForegroundColor White
  $mb = [math]::Round($info.Size / 1MB, 1)
  Write-Host "  Size:    $mb MB" -ForegroundColor DarkGray

  $tmpDir = Join-Path $env:TEMP "MoritApp-install"
  if (-not (Test-Path $tmpDir)) {
    New-Item -ItemType Directory -Path $tmpDir | Out-Null
  }
  $outFile = Join-Path $tmpDir $info.Name

  Write-Step "Downloading…"
  # TLS 1.2+ for older PowerShell
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  } catch {}

  Invoke-WebRequest -Uri $info.Url -OutFile $outFile -UseBasicParsing

  if (-not (Test-Path $outFile)) {
    throw "Download failed: $outFile missing."
  }
  $got = (Get-Item $outFile).Length
  if ($info.Size -gt 0 -and $got -lt [math]::Max(1MB, $info.Size * 0.5)) {
    throw "Download looks incomplete ($got bytes)."
  }

  Write-Step "Launching installer…"
  if ($Silent) {
    # NSIS silent (if supported by package)
    $p = Start-Process -FilePath $outFile -ArgumentList "/S" -PassThru -Wait
    Write-Host "  Installer exit code: $($p.ExitCode)" -ForegroundColor DarkGray
  } else {
    Start-Process -FilePath $outFile
    Write-Host "  Setup UI opened. Finish the wizard there." -ForegroundColor DarkGray
  }

  Write-Host ""
  Write-Host "> Done. After install, open MoritApp from Start Menu / desktop." -ForegroundColor Green
  Write-Host "  Release page: $($info.HtmlUrl)" -ForegroundColor DarkGray
  Write-Host ""
} catch {
  Write-Host ""
  Write-Host "> Install failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "  Manual download: https://github.com/$Repo/releases/latest" -ForegroundColor Yellow
  Write-Host ""
  exit 1
}
