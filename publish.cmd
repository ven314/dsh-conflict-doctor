@echo off
rem One-shot publish helper for dsh-conflict-doctor.
rem Anchors to THIS file's folder, so it works regardless of the caller's cwd.
rem npm will prompt for the 2FA one-time password when 2FA is enabled.

cd /d "%~dp0"

echo ============================================
echo  Publishing dsh-conflict-doctor@0.2.0
echo  Folder : %CD%
echo  npm will ask for your 2FA one-time password.
echo ============================================
echo.

call npm publish --access public
set RC=%ERRORLEVEL%

echo.
echo === npm publish exit code: %RC% ===
if "%RC%"=="0" (
  echo.
  echo SUCCESS - 0.2.0 should now be on npm.
  echo Tell the agent: it will run `node release.mjs --pr` next.
) else (
  echo.
  echo FAILED - see the error above.
)
echo.
pause
