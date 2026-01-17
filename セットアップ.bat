@echo off
chcp 65001 >nul
echo ============================================================
echo Google Map Exporter セットアップ
echo ============================================================
echo.

REM Node.jsがインストールされているか確認
node --version >nul 2>&1
if errorlevel 1 (
    echo [エラー] Node.js がインストールされていません。
    echo https://nodejs.org/ からダウンロードしてインストールしてください。
    echo.
    pause
    exit /b 1
)

echo [1/2] 依存パッケージをインストール中...
call npm install
if errorlevel 1 (
    echo [エラー] npm install に失敗しました。
    pause
    exit /b 1
)
echo.

echo [2/2] Chromiumブラウザをインストール中...
call npx playwright install chromium
if errorlevel 1 (
    echo [エラー] Playwright Chromium のインストールに失敗しました。
    pause
    exit /b 1
)
echo.

echo ============================================================
echo セットアップ完了！
echo.
echo 「起動.bat」をダブルクリックして起動してください。
echo ブラウザで http://localhost:3000 を開いて使用できます。
echo ============================================================
echo.
pause
