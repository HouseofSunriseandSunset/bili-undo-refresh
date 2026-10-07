@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ==========================================
echo   哔哩哔哩「撤回刷新」插件  安装
echo ==========================================
echo.

set "ASAR_ARG=%~1"
set "CLIENT_DIR="

rem ---------- 1) 定位客户端 ----------
if not "%ASAR_ARG%"=="" (
  echo 使用指定的客户端路径: %ASAR_ARG%
  goto :have_path
)
echo 正在查找客户端...
for /f "tokens=2,*" %%A in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\BiliBili" /v UninstallString 2^>nul ^| findstr /i "REG_"') do (
  for %%I in ("%%B") do set "CLIENT_DIR=%%~dpI"
)
if defined CLIENT_DIR if exist "!CLIENT_DIR!resources\app.asar" (
  echo 注册表定位到: !CLIENT_DIR!
  set "ASAR_ARG=!CLIENT_DIR!"
  goto :have_path
)
for %%D in ("C:\bilibili" "D:\bilibili" "E:\bilibili" "F:\bilibili" "C:\Program Files\bilibili" "C:\Program Files (x86)\bilibili") do (
  if exist "%%~D\resources\app.asar" (
    echo 找到客户端: %%~D
    set "ASAR_ARG=%%~D"
    goto :have_path
  )
)
echo [错误] 没有自动找到客户端，请把安装目录作为参数传进来，例如：
echo        install.cmd "D:\bilibili"
echo.
pause
exit /b 2

:have_path
echo.

rem ---------- 2) 找到可用的 JS 运行时 ----------
set "RUNTIME="
set "RUNTIME_KIND="
if exist "%~dp0node\node.exe" (
  set "RUNTIME=%~dp0node\node.exe"
  set "RUNTIME_KIND=node"
)
if not defined RUNTIME (
  where node >nul 2>nul && (
    set "RUNTIME=node"
    set "RUNTIME_KIND=node"
  )
)
if not defined RUNTIME (
  rem 没有 Node.js：直接借用客户端自带的 Electron 运行时（ELECTRON_RUN_AS_NODE）
  if defined CLIENT_DIR (
    for /f "delims=" %%E in ('dir /b /o-s "!CLIENT_DIR!*.exe" 2^>nul') do (
      if not defined RUNTIME (
        echo %%E | findstr /i /b "卸载 uninstall" >nul || (
          set "RUNTIME=!CLIENT_DIR!%%E"
          set "RUNTIME_KIND=electron"
        )
      )
    )
  )
)
if not defined RUNTIME (
  echo [错误] 既没有 Node.js，也没能找到客户端主程序。
  echo        请安装 Node.js 后重试，或把客户端目录作为参数传入。
  pause
  exit /b 1
)

if "%RUNTIME_KIND%"=="electron" (
  echo 未检测到 Node.js，改用客户端自带运行时执行。
  set "ELECTRON_RUN_AS_NODE=1"
) else (
  echo 使用 JS 运行时: %RUNTIME%
)
echo.
echo 请确认哔哩哔哩客户端已经完全退出（含托盘图标）。
pause

rem ---------- 3) 安装 ----------
"%RUNTIME%" "%~dp0install.js" --asar "%ASAR_ARG%"
set "RC=%ERRORLEVEL%"

if "%RUNTIME_KIND%"=="electron" set "ELECTRON_RUN_AS_NODE="

if not "%RC%"=="0" (
  echo.
  echo 安装失败，请查看上面的错误信息。
  pause
  exit /b %RC%
)

echo.
echo 安装完成。启动客户端后，首页「推荐」右下角会出现面板。
pause
