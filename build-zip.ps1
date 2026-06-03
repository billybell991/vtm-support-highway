# build-zip.ps1
# Packages the VTM Support Highway extension into vtm-support-highway.zip
# alongside the landing page in web\. Optionally deploys both to the Sherlock
# install host (10.10.51.43:8765) with -Deploy.

[CmdletBinding()]
param(
  [string]$OutDir = (Join-Path $PSScriptRoot 'web'),
  [switch]$Deploy,
  [ValidateSet('patch','minor','major','none')]
  [string]$Bump = 'none',
  [string]$Notes = ''
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$manifestPath = Join-Path $PSScriptRoot 'manifest.json'
$changelogPath = Join-Path $PSScriptRoot 'CHANGELOG.md'

# ── Optional version bump (manifest + CHANGELOG) ───────────────────────────────
if ($Bump -ne 'none') {
  $manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
  $parts = $manifest.version -split '\.'
  if ($parts.Count -lt 3) { $parts = @($parts + @('0','0','0'))[0..2] }
  $maj = [int]$parts[0]; $min = [int]$parts[1]; $pat = [int]$parts[2]
  switch ($Bump) {
    'major' { $maj++; $min = 0; $pat = 0 }
    'minor' { $min++; $pat = 0 }
    'patch' { $pat++ }
  }
  $newVersion = "$maj.$min.$pat"
  Write-Host "Bumping version: $($manifest.version) -> $newVersion"
  # Rewrite manifest preserving formatting (in-place line edit on the version key)
  $mfText = Get-Content -Raw -Path $manifestPath
  $mfText = [regex]::Replace($mfText, '("version"\s*:\s*")[^"]+(")', "`${1}$newVersion`${2}")
  Set-Content -Path $manifestPath -Value $mfText -Encoding UTF8 -NoNewline

  # Prepend a CHANGELOG entry
  $today = Get-Date -Format 'yyyy-MM-dd'
  $body = if ([string]::IsNullOrWhiteSpace($Notes)) { '- _Release notes pending._' } else {
    ($Notes -split "(?:`r`n|`n)") | ForEach-Object { if ($_ -match '^\s*-') { $_ } else { "- $_" } } | Out-String
  }
  $emdash = [char]0x2014
  $entry = "## v$newVersion $emdash $today`r`n`r`n$body`r`n`r`n"
  if (Test-Path $changelogPath) {
    $existing = Get-Content -Raw -Path $changelogPath
    if ($existing -match '(?ms)^(#[^\r\n]*\r?\n(?:>[^\r\n]*\r?\n|[^#\r\n][^\r\n]*\r?\n|\r?\n)*)') {
      $header = $Matches[1]
      $rest = $existing.Substring($header.Length)
      Set-Content -Path $changelogPath -Value ($header + $entry + $rest) -Encoding UTF8 -NoNewline
    } else {
      Set-Content -Path $changelogPath -Value ($entry + $existing) -Encoding UTF8 -NoNewline
    }
  } else {
    Set-Content -Path $changelogPath -Value ("# VTM Support Highway $emdash Changelog`r`n`r`n" + $entry) -Encoding UTF8 -NoNewline
  }
  Write-Host "  -> $manifestPath (v$newVersion)"
  Write-Host "  -> $changelogPath (entry prepended)"
}

# Read (possibly bumped) version
$manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
$version  = $manifest.version
Write-Host "Packaging VTM Support Highway v$version"

# Files & folders to ship inside the zip
$include = @(
  'manifest.json',
  'background.js',
  'api.js',
  'popup.html',
  'popup.js',
  'settings.js',
  'styles.css',
  'content-jira.js',
  'content-jira.css',
  'content-zendesk.js',
  'content-zendesk.css',
  'content-zendesk-autoonline.js',
  'icons'
)

# ── Syntax gate: node --check every JS file before packaging ─────────────────────
$jsFiles = $include | Where-Object { $_ -like '*.js' } | ForEach-Object { Join-Path $PSScriptRoot $_ }
$syntaxErrors = @()
foreach ($jsFile in $jsFiles) {
  if (-not (Test-Path $jsFile)) { continue }
  $result = & node --check $jsFile 2>&1
  if ($LASTEXITCODE -ne 0) {
    $syntaxErrors += "SYNTAX ERROR in ${jsFile}:`n${result}"
  }
}
if ($syntaxErrors.Count -gt 0) {
  Write-Error "Build aborted -- JS syntax errors found:`n$($syntaxErrors -join [char]10)"
  exit 1
}
Write-Host "Syntax check: all JS files OK."

# Stage into a clean temp folder so the zip root is the extension itself
$stage = Join-Path $PSScriptRoot ("_stage-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  foreach ($item in $include) {
    $src = Join-Path $PSScriptRoot $item
    if (-not (Test-Path $src)) {
      Write-Warning "Skipping missing item: $item"
      continue
    }
    Copy-Item -Path $src -Destination $stage -Recurse -Force
  }

  if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
  $zipPath = Join-Path $OutDir 'vtm-support-highway.zip'
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zipPath -CompressionLevel Optimal
  $size = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
  Write-Host "  -> $zipPath  ($size KB)"
} finally {
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}

# Stamp the landing page with the current version so the displayed version
# always matches the zip.
$indexPath = Join-Path $OutDir 'index.html'
if (Test-Path $indexPath) {
  $html = Get-Content -Raw -Path $indexPath
  $html = [regex]::Replace($html, '(id="ver-pill[0-9]*">)v[0-9]+\.[0-9]+\.[0-9]+', '${1}v' + $version)

  # Inject the latest changelog entries into the landing page between the
  # <!-- CHANGELOG:START --> and <!-- CHANGELOG:END --> markers.
  if (Test-Path $changelogPath) {
    $cl = [IO.File]::ReadAllText($changelogPath, [Text.Encoding]::UTF8)
    $emdash2 = [char]0x2014
    # Match each release section. Use a named pattern to avoid clobbering $Matches.
    $rePattern = '(?ms)^## (v[\d.]+) ' + $emdash2 + ' (\d{4}-\d{2}-\d{2})\s*\r?\n(.*?)(?=^## |\z)'
    $relMatches = [regex]::Matches($cl, $rePattern)
    $items = New-Object System.Collections.Generic.List[string]
    $take = [Math]::Min(3, $relMatches.Count)
    for ($i = 0; $i -lt $take; $i++) {
      $m = $relMatches[$i]
      $ver = $m.Groups[1].Value
      $date = $m.Groups[2].Value
      $bodyMd = $m.Groups[3].Value.Trim()
      # Parse list items: any line starting with "- " (continuation lines indented by 2+ spaces fold in)
      $bodyLines = $bodyMd -split "(?:`r`n|`n)"
      $listItems = New-Object System.Collections.Generic.List[string]
      $current = $null
      foreach ($ln in $bodyLines) {
        if ($ln -match '^\s*-\s+(.*)$') {
          if ($current -ne $null) { $listItems.Add($current) }
          $current = $Matches[1]
        } elseif ($ln.Trim() -ne '' -and $current -ne $null) {
          $current = $current + ' ' + $ln.Trim()
        }
      }
      if ($current -ne $null) { $listItems.Add($current) }
      $liHtml = ($listItems | ForEach-Object {
        $t = $_
        $t = $t -replace '\*\*([^*]+)\*\*', '<strong>$1</strong>'
        $t = $t -replace '`([^`]+)`', '<code>$1</code>'
        '<li>' + $t + '</li>'
      }) -join "`r`n"
      $items.Add("<article class=`"release`"><h3>$ver <span class=`"date`">$emdash2 $date</span></h3><ul>$liHtml</ul></article>")
    }
    $injected = ($items -join "`r`n")
    $html = [regex]::Replace($html, '(?s)(<!-- CHANGELOG:START -->).*?(<!-- CHANGELOG:END -->)', "`$1`r`n$injected`r`n`$2")
  }

  Set-Content -Path $indexPath -Value $html -Encoding UTF8 -NoNewline
  Write-Host "  -> stamped $indexPath with v$version + changelog"
}

Write-Host ""
Write-Host "Deploy URLs (once published):"
Write-Host "  http://10.10.51.43:8765/vtm-support-highway.html"
Write-Host "  http://10.10.51.43:8765/vtm-support-highway.zip"

if ($Deploy) {
  Write-Host ""
  Write-Host "Deploying to vdxiii@10.10.51.43 ..."
  $stage = '/Users/vdxiii/vtm-stage/'
  & scp -o BatchMode=yes (Join-Path $OutDir 'index.html') (Join-Path $OutDir 'vtm-support-highway.zip') "vdxiii@10.10.51.43:$stage"
  if ($LASTEXITCODE -ne 0) { throw "scp failed (exit $LASTEXITCODE)" }
  $cmd = 'wsl -e bash -c "cp /mnt/c/Users/vdxiii/vtm-stage/index.html /home/vdxiii/dev/sherlock-tool/scripts/vtm-support-highway.html && cp /mnt/c/Users/vdxiii/vtm-stage/vtm-support-highway.zip /home/vdxiii/dev/sherlock-tool/scripts/vtm-support-highway.zip && ls -la /home/vdxiii/dev/sherlock-tool/scripts/vtm-support-highway*"'
  $cmd | & ssh -o BatchMode=yes vdxiii@10.10.51.43 'powershell -NoProfile -Command -'
  if ($LASTEXITCODE -ne 0) { throw "remote copy failed (exit $LASTEXITCODE)" }
  Write-Host "Deployed."
}
