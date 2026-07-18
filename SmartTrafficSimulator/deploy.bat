@echo off
REM Script deploy nhanh cho Windows

echo === DEPLOY SMART TRAFFIC SIMULATOR ===
echo.

REM Kiem tra Railway CLI
where railway >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo WARNING: Railway CLI chua cai. Cai bang: npm install -g @railway/cli
    exit /b 1
)

REM Kiem tra Wrangler CLI
where wrangler >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo WARNING: Wrangler CLI chua cai. Cai bang: npm install -g wrangler
    exit /b 1
)

echo OK CLI tools found
echo.

REM Deploy backend len Railway
echo Deploying backend to Railway...
railway up

echo.
echo Lay backend URL tu Railway dashboard roi update frontend/.env.production
echo Sau do chay:
echo   cd frontend
echo   npm install
echo   npm run build
echo   npx wrangler pages deploy out --project-name=smart-traffic
echo.
echo Hoac xem CLOUDFLARE_DEPLOY.md de deploy thu cong.
