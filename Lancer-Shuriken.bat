@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Shuriken Studio - Development launcher
pushd "%~dp0" || exit /b 1

set "BRANCH=feature/codex-integration"
set "NODE_MAJOR="
echo.
echo === Shuriken Studio - Development launcher ===
echo.

where git >nul 2>&1 || goto :missing_git
where node >nul 2>&1 || goto :missing_node
where npm >nul 2>&1 || goto :missing_npm
for /f "delims=" %%V in ('node -p "parseInt(process.versions.node,10)"') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR goto :missing_node
if %NODE_MAJOR% LSS 24 goto :old_node

git rev-parse --is-inside-work-tree >nul 2>&1 || goto :not_repo
node -e "const branch=require('node:child_process').execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(); process.exit(branch===process.env.BRANCH?0:1)" >nul 2>&1
if errorlevel 1 goto :wrong_branch
if /i "%~1"=="--self-test" goto :self_test
if /i "%~1"=="--update" call :update

if not exist "node_modules\.bin\electron-vite.cmd" goto :install
if not exist "node_modules\.bin\install-electron.cmd" goto :install
rem npm's hidden lockfile describes the installed tree. Optional packages may be platform-specific.
node -e "const expected=require('./package-lock.json').packages, installed=require('./node_modules/.package-lock.json').packages; const same=(a,b)=>a&&a.version===b.version&&a.resolved===b.resolved&&a.integrity===b.integrity; if(Object.entries(expected).some(([name,p])=>name&&!p.optional&&!same(installed[name],p))||Object.entries(installed).some(([name,p])=>name&&!same(expected[name],p))) process.exit(1)" >nul 2>&1
if errorlevel 1 goto :install
goto :launch

:install
echo Installing project dependencies...
call npm ci
if errorlevel 1 goto :npm_failed

:launch
echo Starting Shuriken Studio on %BRANCH%...
if /i "%~1"=="--update" (
    call npm run dev
) else (
    call npm run dev -- %*
)
if errorlevel 1 goto :failed
popd
exit /b 0

:update
node -e "const status=require('node:child_process').execFileSync('git',['status','--porcelain','--untracked-files=normal']); process.exit(status.length===0?0:1)" >nul 2>&1
if errorlevel 1 (
    echo [WARNING] Local changes detected or Git status unavailable. Starting the current checkout.
    exit /b 0
)
node -e "const url=require('node:child_process').execFileSync('git',['remote','get-url','origin'],{encoding:'utf8'}).trim(); process.exit(/^(https:\/\/github\.com\/|git@github\.com:)lightnew10\/shuriken-studio(?:\.git)?\/?$/i.test(url)?0:1)" >nul 2>&1
if errorlevel 1 (
    echo [WARNING] Origin does not point to the Shuriken fork. Starting the current checkout.
    exit /b 0
)
echo Checking for updates on origin/%BRANCH%...
git fetch --no-tags origin "refs/heads/%BRANCH%"
if errorlevel 1 (
    echo [WARNING] Could not fetch the development branch. Starting the current checkout.
    exit /b 0
)
git merge --ff-only FETCH_HEAD
if errorlevel 1 echo [WARNING] Could not fast-forward the development branch. Starting the current checkout.
exit /b 0

:self_test
echo [OK] Windows launcher preflight passed.
popd
exit /b 0

:missing_git
echo [ERROR] Git is not installed or not in PATH.
goto :failed
:missing_node
echo [ERROR] Node.js is not installed or not in PATH.
goto :failed
:missing_npm
echo [ERROR] npm is not installed or not in PATH.
goto :failed
:old_node
echo [ERROR] Shuriken Studio requires Node.js 24 or later.
goto :failed
:not_repo
echo [ERROR] Run this BAT inside the Shuriken Git checkout.
goto :failed
:wrong_branch
echo [ERROR] Switch to %BRANCH% before launching Shuriken Studio.
goto :failed
:npm_failed
echo [ERROR] npm ci failed. Check the npm output above.
:failed
echo.
echo Launch stopped. Press any key to close this window.
pause >nul
popd
exit /b 1
