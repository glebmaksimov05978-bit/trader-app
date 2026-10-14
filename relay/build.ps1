# relay/build.ps1 - builds the zip archive of the relay (see relay/README.md).
#
# Run from the project root:   powershell -ExecutionPolicy Bypass -File relay\build.ps1
# Result:                      relay\dist\traderpro-relay.zip
#
# The archive holds the relay code, the three worker files it uses, package.json with
# "type": "module" and (if present) the Russian root certificate relay\certs\russian_trusted_root_ca.pem.
# Tokens and keys are NEVER put into the archive - they are environment variables of the function.
# (ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI.)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $env:TEMP 'traderpro-relay-stage'
$dist = Join-Path $PSScriptRoot 'dist'
$zip = Join-Path $dist 'traderpro-relay.zip'

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'relay') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'workers\telegram-webhook\src') | Out-Null
New-Item -ItemType Directory -Force -Path $dist | Out-Null

foreach ($f in 'handler.mjs', 'yandex.mjs', 'yandex.js', 'server.mjs') {
  Copy-Item (Join-Path $PSScriptRoot $f) (Join-Path $stage 'relay')
}
foreach ($f in 'orders.js', 'verifyFirebaseToken.js') {
  Copy-Item (Join-Path $root "workers\telegram-webhook\src\$f") (Join-Path $stage 'workers\telegram-webhook\src')
}
Set-Content -Path (Join-Path $stage 'package.json') -Value '{ "name": "traderpro-relay", "private": true, "type": "module" }' -Encoding ASCII

$cert = Join-Path $PSScriptRoot 'certs\russian_trusted_root_ca.pem'
if (Test-Path $cert) {
  New-Item -ItemType Directory -Force -Path (Join-Path $stage 'certs') | Out-Null
  Copy-Item $cert (Join-Path $stage 'certs')
  Write-Host 'Certificate found and added to the archive.'
} else {
  Write-Host 'WARNING: relay\certs\russian_trusted_root_ca.pem not found - the relay cannot talk to T-Bank without it.'
}

if (Test-Path $zip) { Remove-Item $zip -Force }
# Compress-Archive in Windows PowerShell 5.1 writes backslashes in entry names; Linux unzip tools
# (and Yandex Cloud) expect forward slashes - so the archive is written by hand.
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
Write-Host "Done: $zip"
