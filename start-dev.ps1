# LocalShare — One-Command Local Platform Launcher (Windows PowerShell)
$ErrorActionPreference = "Stop"
$env:Path = "$env:APPDATA\npm;$env:Path"

Write-Host "1. Ensuring PostgreSQL container (localshare-postgres) is running on port 55432..." -ForegroundColor Cyan
docker start localshare-postgres 2>$null | Out-Null

$env:DATABASE_URL = "postgresql://localshare:localshare@localhost:55432/localshare?schema=public"
$env:JWT_SECRET = "localshare-dev-jwt-secret-minimum-32-characters-2026"
$env:PROVIDER_ENCRYPTION_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
$env:PORT = "3100"
$env:CORS_ORIGINS = "http://localhost:5180"

Write-Host "2. Starting NestJS Cloud API on http://localhost:3100 ..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$env:DATABASE_URL='$env:DATABASE_URL'; `$env:JWT_SECRET='$env:JWT_SECRET'; `$env:PROVIDER_ENCRYPTION_KEY='$env:PROVIDER_ENCRYPTION_KEY'; `$env:PORT='3100'; `$env:CORS_ORIGINS='http://localhost:5180'; node '$PSScriptRoot\apps\api\dist\main.js'"

Write-Host "3. Starting React Web Dashboard on http://localhost:5180 ..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$env:Path='$env:APPDATA\npm;' + `$env:Path; Set-Location '$PSScriptRoot'; pnpm --filter @localshare/web-dashboard dev"

Write-Host "LocalShare is running! Open http://localhost:5180 in your browser." -ForegroundColor Green

