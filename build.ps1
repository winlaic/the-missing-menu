# Build script for The Missing Menu VS Code Extension

param(
    [switch]$Package,
    [switch]$Publish
)

$ErrorActionPreference = "Stop"

# Add Node.js to PATH
Prepend-Path "$HOME/.nvm/versions/node/v24.13.1/bin"

Write-Host "Building The Missing Menu extension..." -ForegroundColor Cyan

# Clean
Write-Host "Cleaning output directory..." -ForegroundColor Yellow
if (Test-Path "out") {
    Remove-Item -Recurse -Force "out"
}

# Compile
Write-Host "Compiling TypeScript..." -ForegroundColor Yellow
npm run compile

if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed!" -ForegroundColor Red
    exit 1
}

Write-Host "Build successful!" -ForegroundColor Green

if ($Package) {
    Write-Host "Packaging VSIX..." -ForegroundColor Yellow
    npx @vscode/vsce package

    if ($LASTEXITCODE -eq 0) {
        Write-Host "VSIX package created!" -ForegroundColor Green
    }
}

if ($Publish) {
    Write-Host "Publishing to VS Code Marketplace..." -ForegroundColor Yellow
    npx @vscode/vsce publish

    if ($LASTEXITCODE -eq 0) {
        Write-Host "Published successfully!" -ForegroundColor Green
    }
}

Write-Host "Done!" -ForegroundColor Cyan