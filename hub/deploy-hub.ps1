# deploy-hub.ps1 — push hub/index.html to the install server as the root landing page.
#
# Routing today:
#   /                     -> hub landing page (this file)
#   /sherlock.html        -> SHERLOCK install page (was at / before)
#   /vtm-support-highway.html -> Highway install page
#
# On first run this script also renames the server's existing index.html (Sherlock's
# install page) to sherlock.html so links from the hub work.

[CmdletBinding()]
param(
  [string]$RemoteHost = 'vdxiii@10.10.51.43',
  [string]$WinStaging = 'C:\Users\vdxiii\vtm-stage\',
  [string]$WslDest    = '/home/vdxiii/dev/sherlock-tool/scripts/'
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Join-Path $here 'index.html'
if (-not (Test-Path $src)) { throw "Missing $src" }

Write-Host "Hub deploy" -ForegroundColor Cyan
Write-Host "  src: $src"
Write-Host "  dst: $RemoteHost`:$WslDest (via $WinStaging)"
Write-Host ""

# Step 1: one-time rename of existing /index.html -> /sherlock.html (if not already done)
ssh $RemoteHost "wsl test -f $WslDest/sherlock.html" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "sherlock.html missing on server - copying current index.html ..." -ForegroundColor Yellow
  ssh $RemoteHost "wsl cp $WslDest/index.html $WslDest/sherlock.html"
  if ($LASTEXITCODE -ne 0) { throw "rename step failed" }
  Write-Host "  -> $WslDest/sherlock.html created"
} else {
  Write-Host "sherlock.html already present - skipping rename"
}

# Step 2: scp to Windows staging dir
$tmpName = "hub-index-$(Get-Random).html"
$winTmp  = "$WinStaging$tmpName"
Write-Host "Uploading to $winTmp ..."
scp -q $src "$RemoteHost`:$winTmp"
if ($LASTEXITCODE -ne 0) { throw "scp failed" }

# Step 3: wsl cp into the scripts dir, overwriting index.html
ssh $RemoteHost "wsl cp /mnt/c/Users/vdxiii/vtm-stage/$tmpName $WslDest/index.html"
if ($LASTEXITCODE -ne 0) { throw "wsl cp failed" }
ssh $RemoteHost "wsl chmod 755 $WslDest/index.html"
ssh $RemoteHost "wsl rm /mnt/c/Users/vdxiii/vtm-stage/$tmpName"
Write-Host ""
Write-Host "Deployed files:" -ForegroundColor Cyan
ssh $RemoteHost "wsl ls -la $WslDest/index.html $WslDest/sherlock.html $WslDest/vtm-support-highway.html"

Write-Host ""
Write-Host "Deployed." -ForegroundColor Green
Write-Host "  http://10.10.51.43:8765/                          -> hub"
Write-Host "  http://10.10.51.43:8765/sherlock.html             -> SHERLOCK"
Write-Host "  http://10.10.51.43:8765/vtm-support-highway.html  -> Highway"
