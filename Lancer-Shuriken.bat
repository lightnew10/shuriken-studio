@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Shuriken Studio - Update and launch
pushd "%~dp0" || goto :failed

set "BRANCH=feature/codex-integration"
set "DIRTY="
set "PREVIOUS_HEAD="
set "NEED_INSTALL=0"

echo.
echo =============================================
echo     SHURIKEN STUDIO - UPDATE + START
echo =============================================
echo.

where git >nul 2>&1 || goto :missing_git
where node >nul 2>&1 || goto :missing_node
where npm >nul 2>&1 || goto :missing_npm

for /f "delims=" %%V in ('node -p "parseInt(process.versions.node,10)"') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR goto :missing_node
if %NODE_MAJOR% LSS 24 goto :old_node

git rev-parse --is-inside-work-tree >nul 2>&1 || goto :not_repo
git remote get-url origin 2>nul | findstr /i /c:"lightnew10/shuriken-studio" >nul
if errorlevel 1 goto :wrong_origin

rem Non-destructive preflight for CI: never fetch, merge or launch.
if /i "%~1"=="--self-test" (
    echo [OK] Windows launcher preflight passed.
    popd
    exit /b 0
)

rem Never overwrite local edits or untracked files.
for /f "delims=" %%S in ('git status --porcelain --untracked-files=normal') do set "DIRTY=1"
if defined DIRTY goto :dirty

echo [1/6] Updating your fork branch...
git fetch --prune origin
if errorlevel 1 goto :failed
git show-ref --verify --quiet "refs/remotes/origin/%BRANCH%"
if errorlevel 1 goto :missing_branch

git show-ref --verify --quiet "refs/heads/%BRANCH%"
if errorlevel 1 (
    git switch --track -c "%BRANCH%" "origin/%BRANCH%"
) else (
    git switch "%BRANCH%"
)
if errorlevel 1 goto :failed

for /f "delims=" %%H in ('git rev-parse HEAD') do set "PREVIOUS_HEAD=%%H"

echo.
echo [2/6] Fetching official Shuriken updates...
git remote get-url upstream >nul 2>&1
if errorlevel 1 (
    git remote add upstream "https://github.com/makofisch/shuriken-studio.git"
    if errorlevel 1 goto :failed
)
git remote get-url upstream 2>nul | findstr /i /c:"makofisch/shuriken-studio" >nul
if errorlevel 1 goto :wrong_upstream

git fetch --prune upstream main
if errorlevel 1 goto :failed

echo.
echo [3/6] Merging fork changes and official changes...
git merge --no-edit "origin/%BRANCH%"
if errorlevel 1 goto :merge_failed
git merge --no-edit "upstream/main"
if errorlevel 1 goto :merge_failed

echo.
echo [4/6] Checking dependencies...
if not exist "node_modules\.package-lock.json" set "NEED_INSTALL=1"
git diff --quiet "%PREVIOUS_HEAD%" HEAD -- package.json package-lock.json
if errorlevel 1 set "NEED_INSTALL=1"

if "%NEED_INSTALL%"=="1" (
    echo Installing project packages...
    call npm ci
    if errorlevel 1 goto :npm_failed
) else (
    echo Dependencies are already installed.
)

echo.
echo [5/6] Checking Codex CLI...
where codex >nul 2>&1
if errorlevel 1 (
    echo Codex may already be provided by the desktop app. Check Settings - AI accounts.
    echo If needed, install npm install -g @openai/codex@0.166.0 and sign in manually.
)

echo.
echo [6/6] Starting Shuriken Studio...
echo Close this window or press Ctrl+C to stop the dev server.
echo.
call npm run dev
if errorlevel 1 goto :failed

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
echo [ERROR] Run this BAT inside a Git clone, not a downloaded ZIP.
goto :failed
:wrong_origin
echo [ERROR] Origin is not your lightnew10/shuriken-studio fork.
goto :failed
:wrong_upstream
echo [ERROR] The upstream remote does not point to makofisch/shuriken-studio.
echo Check it manually: git remote -v
goto :failed
:missing_branch
echo [ERROR] The feature/codex-integration branch was not found on origin.
goto :failed
:dirty
echo [ERROR] Uncommitted or untracked files were found.
echo Commit, move or back up these files, then retry.
git status --short
goto :failed
:merge_failed
echo [ERROR] A merge could not be completed safely.
git merge --abort >nul 2>&1
echo Your local commits are preserved. Resolve the upstream changes manually.
goto :failed
:npm_failed
echo [ERROR] npm ci failed. Check npm output above.
goto :failed
:failed
echo.
echo Update or launch stopped. Nothing was force-reset or auto-pushed.
echo Press any key to close this window.
pause >nul
popd
exit /b 1
