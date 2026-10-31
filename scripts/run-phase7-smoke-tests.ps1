# ==============================================================================
# OmniStock MVP: Phase 7 Automated Newman Smoke Test Runner
# ==============================================================================
$ErrorActionPreference = 'Stop'

Write-Host "1. Verifying database connection..." -ForegroundColor Cyan
$pgConn = Get-NetTCPConnection -LocalPort 5432 -ErrorAction SilentlyContinue
if (-not $pgConn) {
    Write-Error "PostgreSQL is not listening on port 5432. Please run: docker compose up -d"
    exit 1
}

Write-Host "2. Building application..." -ForegroundColor Cyan
npm run build

Write-Host "3. Starting NestJS application server on port 3000..." -ForegroundColor Cyan
$serverOutLog = "$PSScriptRoot\..\server-smoke-out.log"
$serverErrLog = "$PSScriptRoot\..\server-smoke-err.log"
if (Test-Path $serverOutLog) { Remove-Item $serverOutLog -Force }
if (Test-Path $serverErrLog) { Remove-Item $serverErrLog -Force }

$proc = Start-Process node -ArgumentList "dist/main.js" -RedirectStandardOutput $serverOutLog -RedirectStandardError $serverErrLog -PassThru

try {
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        $conn = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
        if ($conn) {
            $ready = $true
            break
        }
    }

    if (-not $ready) {
        Write-Host "Server stdout log:" -ForegroundColor Yellow
        if (Test-Path $serverOutLog) { Get-Content $serverOutLog }
        Write-Host "Server stderr log:" -ForegroundColor Red
        if (Test-Path $serverErrLog) { Get-Content $serverErrLog }
        throw "NestJS application server failed to listen on port 3000 within 15 seconds."
    }

    Write-Host "Server is running (PID: $($proc.Id)). Executing Phase 7 Newman test suite..." -ForegroundColor Green

    # Execute Phase 7 Newman Collection
    npx --yes newman run postman/OmniStock-Phase-7.postman_collection.json `
        -e postman/OmniStock-Local.postman_environment.json `
        --reporters cli `
        --color on

    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "Phase 7 Newman test suite completed with failures (exit code: $exitCode)."
    }

    Write-Host "All Phase 7 Postman tests passed successfully!" -ForegroundColor Green
}
finally {
    Write-Host "Shutting down application server (PID: $($proc.Id))..." -ForegroundColor Cyan
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
}

