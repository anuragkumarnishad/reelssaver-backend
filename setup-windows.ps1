$ErrorActionPreference = 'Stop'
Write-Host "Reelssaver local session setup" -ForegroundColor Cyan
Write-Host "Use only a test account and content you own or may download." -ForegroundColor Yellow
Write-Host "Values stay in the local .env file. Never upload that file to GitHub." -ForegroundColor Yellow
Write-Host ""

$sessionId = Read-Host "Paste ONLY the sessionid value"
$csrfToken = Read-Host "Paste the csrftoken value"
$userId = Read-Host "Paste the ds_user_id value"

if ([string]::IsNullOrWhiteSpace($sessionId) -or [string]::IsNullOrWhiteSpace($csrfToken) -or [string]::IsNullOrWhiteSpace($userId)) {
  Write-Host "All three values are required." -ForegroundColor Red
  exit 1
}

# Reject line breaks to keep the dotenv file well formed.
foreach ($value in @($sessionId, $csrfToken, $userId)) {
  if ($value.Contains("`r") -or $value.Contains("`n")) {
    Write-Host "A value contained a line break. Copy only the cookie value." -ForegroundColor Red
    exit 1
  }
}

$envText = @"
PORT=8080
NODE_ENV=development
ALLOWED_ORIGINS=*

META_API_VERSION=v23.0
META_ACCESS_TOKEN=
INSTAGRAM_USER_ID=

COBALT_API_URL=
COBALT_API_KEY=

IG_COOKIE="csrftoken=$csrfToken; ds_user_id=$userId; sessionid=$sessionId"
IG_CSRF_TOKEN=$csrfToken

RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=60
MAX_META_PAGES=10
"@

Set-Content -Path (Join-Path $PSScriptRoot '.env') -Value $envText -Encoding UTF8
Write-Host ""
Write-Host ".env created successfully." -ForegroundColor Green
Write-Host "Run: npm install" -ForegroundColor White
Write-Host "Then: npm start" -ForegroundColor White
