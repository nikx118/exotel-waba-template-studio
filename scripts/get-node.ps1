# Downloads a private copy of Node.js into ..\.runtime\node (used by "Start (Windows).bat").
# Verifies the SHA-256 checksum published by nodejs.org before using it.
param([string]$Version = 'v22.12.0')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar on
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$pkg  = "node-$Version-win-$arch"
$base = "https://nodejs.org/dist/$Version"
$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root '.runtime'
$tmp  = Join-Path $env:TEMP ('waba-node-' + [guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
try {
  $zip = Join-Path $tmp 'node.zip'
  Invoke-WebRequest "$base/$pkg.zip" -OutFile $zip -UseBasicParsing
  $sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content -split "`n"
  $line = $sums | Where-Object { $_.Trim().EndsWith("  $pkg.zip") } | Select-Object -First 1
  $expected = if ($line) { $line.Trim().Split(' ')[0].ToLower() } else { '' }
  $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if (-not $expected -or $expected -ne $actual) { throw 'The Node.js download did not match its checksum, so it was not used.' }
  Expand-Archive $zip -DestinationPath $tmp -Force
  New-Item -ItemType Directory $dest -Force | Out-Null
  $target = Join-Path $dest 'node'
  if (Test-Path $target) { Remove-Item $target -Recurse -Force }
  Move-Item (Join-Path $tmp $pkg) $target
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
