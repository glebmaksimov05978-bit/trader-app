# yandex/robots/build.ps1 - builds the zip archive of the robots function (see yandex/robots/README.md).
#
# Run from the project root:   powershell -ExecutionPolicy Bypass -File yandex\robots\build.ps1
# Result:                      yandex\robots\dist\traderpro-robots.zip
#
# The archive holds: the function entry (robots/index.js), the robot scripts that the GitHub workflow
# runs, the parts of src/ and workers/ they import, and firebase-admin installed for production.
# Keys and tokens are NEVER put into the archive - they are environment variables of the function.
# (ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI.)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$stage = Join-Path $env:TEMP 'traderpro-robots-stage'
$dist = Join-Path $PSScriptRoot 'dist'
$zip = Join-Path $dist 'traderpro-robots.zip'

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null
New-Item -ItemType Directory -Force -Path $dist | Out-Null

function CopyDir($rel) {
  $from = Join-Path $root $rel
  $to = Join-Path $stage $rel
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
  Copy-Item $from $to -Recurse -Force
}

New-Item -ItemType Directory -Force -Path (Join-Path $stage 'robots') | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'index.js') (Join-Path $stage 'robots')

foreach ($d in 'scripts\alerts', 'scripts\paper', 'scripts\telegram', 'scripts\radar', 'src\services', 'src\utils', 'src\constants') { CopyDir $d }
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'workers\telegram-webhook\src') | Out-Null
foreach ($f in 'orders.js', 'tgTrade.js', 'verifyFirebaseToken.js', 'index.js', 'menu.js') {
  Copy-Item (Join-Path $root "workers\telegram-webhook\src\$f") (Join-Path $stage 'workers\telegram-webhook\src')
}
# tests and big research files are not needed by the function
Get-ChildItem -Path $stage -Recurse -File -Include '*Test*.mjs','*Tests.mjs','*.test.js','*.md' | Remove-Item -Force

Set-Content -Path (Join-Path $stage 'package.json') -Value '{ "name": "traderpro-robots", "private": true, "type": "module", "dependencies": { "firebase-admin": "12" } }' -Encoding ASCII
Push-Location $stage
try {
  npm install --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
} finally { Pop-Location }

if (Test-Path $zip) { Remove-Item $zip -Force }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($zip, 'Create')
try {
  Get-ChildItem -Path $stage -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($stage.Length + 1).Replace([string][char]92, '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $rel) | Out-Null
  }
} finally { $archive.Dispose() }
Remove-Item $stage -Recurse -Force
$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "Done: $zip ($mb MB)"
if ($mb -gt 3) { Write-Host 'The archive is larger than 3.5 MB: upload it through Object Storage (see README, step 3).' }
