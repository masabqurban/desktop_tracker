$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

Write-Host "[build-win] Closing running Electron processes..."
Get-Process "Employee Desktop Tracker", "electron" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

Write-Host "[build-win] Cleaning previous Windows artifacts..."
Remove-Item -Recurse -Force "dist\\win-unpacked" -ErrorAction SilentlyContinue
Remove-Item -Force "dist\\*.exe", "dist\\*.blockmap", "dist\\latest.yml" -ErrorAction SilentlyContinue

Write-Host "[build-win] Building renderer..."
npm run build
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Write-Host "[build-win] Packaging Windows installer..."
npx electron-builder --win nsis --x64
if ($LASTEXITCODE -eq 0) {
  exit 0
}

Write-Warning "[build-win] Primary packaging failed. Retrying with signAndEditExecutable=false (rcedit fallback)."
npx electron-builder --win nsis --x64 --config.win.signAndEditExecutable=false
exit $LASTEXITCODE
