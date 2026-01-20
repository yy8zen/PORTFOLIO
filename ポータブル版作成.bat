@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ============================================================
echo Google Map Exporter ポータブル版作成
echo ============================================================
echo.
echo Node.jsを同梱した完全スタンドアロン版を作成します。
echo 「ポータブル版」フォルダに一式が格納されます。
echo 配布サイズ: 約200MB
echo.
pause

REM 作業ディレクトリ
set "WORK_DIR=%~dp0"
set "PORTABLE_DIR=%WORK_DIR%ポータブル版"
set "NODE_DIR=%PORTABLE_DIR%\node"
set "NODE_VERSION=20.11.0"
set "NODE_ZIP=node-v%NODE_VERSION%-win-x64.zip"
set "NODE_URL=https://nodejs.org/dist/v%NODE_VERSION%/%NODE_ZIP%"

REM ポータブル版フォルダを作成
echo [1/6] ポータブル版フォルダを準備中...
if not exist "%PORTABLE_DIR%" mkdir "%PORTABLE_DIR%"
if not exist "%PORTABLE_DIR%\public" mkdir "%PORTABLE_DIR%\public"

REM アプリケーションファイルをコピー
echo [2/6] アプリケーションファイルをコピー中...
copy /y "%WORK_DIR%server.js" "%PORTABLE_DIR%\" >nul
copy /y "%WORK_DIR%scraper.js" "%PORTABLE_DIR%\" >nul
copy /y "%WORK_DIR%csvExporter.js" "%PORTABLE_DIR%\" >nul
copy /y "%WORK_DIR%index.js" "%PORTABLE_DIR%\" >nul
copy /y "%WORK_DIR%package.json" "%PORTABLE_DIR%\" >nul
copy /y "%WORK_DIR%public\*.*" "%PORTABLE_DIR%\public\" >nul
copy /y "%WORK_DIR%ポータブル版README.md" "%PORTABLE_DIR%\README.md" >nul 2>&1

REM Node.jsがすでにあるか確認
if exist "%NODE_DIR%\node.exe" (
    echo [情報] Node.js は既にインストールされています。
    echo 再インストールする場合は ポータブル版\node フォルダを削除してください。
    goto :INSTALL_DEPS
)

echo [3/6] Node.js をダウンロード中...
echo URL: %NODE_URL%
echo.

REM PowerShellでダウンロード
powershell -Command "& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%PORTABLE_DIR%\%NODE_ZIP%'}"
if errorlevel 1 (
    echo [エラー] Node.js のダウンロードに失敗しました。
    echo インターネット接続を確認してください。
    pause
    exit /b 1
)

echo [4/6] Node.js を展開中...
powershell -Command "& {Expand-Archive -Path '%PORTABLE_DIR%\%NODE_ZIP%' -DestinationPath '%PORTABLE_DIR%' -Force}"
if errorlevel 1 (
    echo [エラー] 展開に失敗しました。
    pause
    exit /b 1
)

REM フォルダ名をnodeに変更
if exist "%NODE_DIR%" rmdir /s /q "%NODE_DIR%"
rename "%PORTABLE_DIR%\node-v%NODE_VERSION%-win-x64" node
if errorlevel 1 (
    echo [エラー] フォルダ名の変更に失敗しました。
    pause
    exit /b 1
)

REM ZIPファイルを削除
del "%PORTABLE_DIR%\%NODE_ZIP%"

echo [5/6] 依存パッケージをインストール中...
:INSTALL_DEPS
set "PATH=%NODE_DIR%;%NODE_DIR%\node_modules\.bin;%PATH%"

cd /d "%PORTABLE_DIR%"
call "%NODE_DIR%\npm.cmd" install
if errorlevel 1 (
    echo [エラー] npm install に失敗しました。
    pause
    exit /b 1
)

echo [6/6] Chromium をインストール中...
call "%NODE_DIR%\npx.cmd" playwright install chromium
if errorlevel 1 (
    echo [エラー] Chromium のインストールに失敗しました。
    pause
    exit /b 1
)

REM 起動用バッチファイルを作成
echo @echo off > "%PORTABLE_DIR%\起動.bat"
echo chcp 65001 ^>nul >> "%PORTABLE_DIR%\起動.bat"
echo. >> "%PORTABLE_DIR%\起動.bat"
echo set "WORK_DIR=%%~dp0" >> "%PORTABLE_DIR%\起動.bat"
echo set "NODE_DIR=%%WORK_DIR%%node" >> "%PORTABLE_DIR%\起動.bat"
echo. >> "%PORTABLE_DIR%\起動.bat"
echo if not exist "%%NODE_DIR%%\node.exe" ( >> "%PORTABLE_DIR%\起動.bat"
echo     echo [エラー] Node.js が見つかりません。 >> "%PORTABLE_DIR%\起動.bat"
echo     pause >> "%PORTABLE_DIR%\起動.bat"
echo     exit /b 1 >> "%PORTABLE_DIR%\起動.bat"
echo ) >> "%PORTABLE_DIR%\起動.bat"
echo. >> "%PORTABLE_DIR%\起動.bat"
echo set "PATH=%%NODE_DIR%%;%%NODE_DIR%%\node_modules\.bin;%%PATH%%" >> "%PORTABLE_DIR%\起動.bat"
echo. >> "%PORTABLE_DIR%\起動.bat"
echo echo ============================================================ >> "%PORTABLE_DIR%\起動.bat"
echo echo Google Map Exporter を起動しています... >> "%PORTABLE_DIR%\起動.bat"
echo echo ============================================================ >> "%PORTABLE_DIR%\起動.bat"
echo echo. >> "%PORTABLE_DIR%\起動.bat"
echo echo ブラウザが自動で開きます（http://localhost:3000） >> "%PORTABLE_DIR%\起動.bat"
echo echo 終了するには Ctrl+C を押してください >> "%PORTABLE_DIR%\起動.bat"
echo echo ============================================================ >> "%PORTABLE_DIR%\起動.bat"
echo echo. >> "%PORTABLE_DIR%\起動.bat"
echo. >> "%PORTABLE_DIR%\起動.bat"
echo cd /d "%%WORK_DIR%%" >> "%PORTABLE_DIR%\起動.bat"
echo "%%NODE_DIR%%\node.exe" server.js >> "%PORTABLE_DIR%\起動.bat"
echo pause >> "%PORTABLE_DIR%\起動.bat"

echo.
echo ============================================================
echo ポータブル版の作成が完了しました！
echo.
echo 場所: %PORTABLE_DIR%
echo.
echo 「ポータブル版」フォルダ内の「起動.bat」で起動できます。
echo このフォルダごとZIP圧縮して配布できます。
echo ============================================================
echo.
pause
