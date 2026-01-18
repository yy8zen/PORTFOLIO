const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { GoogleMapScraper } = require('./scraper');
const { CsvExporter } = require('./csvExporter');

// ブラウザを開く関数
function openBrowser(url) {
    const platform = process.platform;
    let command;

    if (platform === 'win32') {
        command = `start "" "${url}"`;
    } else if (platform === 'darwin') {
        command = `open "${url}"`;
    } else {
        command = `xdg-open "${url}"`;
    }

    exec(command, (err) => {
        if (err) {
            console.log('ブラウザの自動起動に失敗しました。手動で開いてください。');
        }
    });
}

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// 静的ファイルの提供
app.use(express.static('public'));
app.use(express.json());

// ルートページ
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// スクレイピング実行エンドポイント
app.post('/api/scrape', async (req, res) => {
    const {
        address, prefecture, city, keyword, ratingMin, ratingMax, reviewCountMin, reviewCountMax, headless,
        addressFilter, categoryFilter, budgetMin, budgetMax, dayFilter, hoursFilter, maxItems
    } = req.body;

    // 入力検証（キーワードは必須、住所は任意）
    if (!keyword) {
        return res.status(400).json({ error: 'キーワードは必須です' });
    }

    // フィルター設定をまとめる
    const filters = {
        address: addressFilter || '',
        category: categoryFilter || '',
        budgetMin: budgetMin || null,
        budgetMax: budgetMax || null,
        days: dayFilter || [],  // 配列（選択された曜日）
        hours: hoursFilter || '',  // hh:mm形式
        maxItems: parseInt(maxItems) || 0  // 0は無制限
    };

    const sessionId = Date.now().toString();
    const outputFile = `output_${sessionId}.csv`;

    // すぐにレスポンスを返す（非同期処理）
    res.json({ sessionId, message: 'スクレイピングを開始しました' });

    // バックグラウンドで実行
    (async () => {
        // クライアントがSocket.IOルームに参加するのを待つ（レース条件対策）
        await new Promise(resolve => setTimeout(resolve, 500));

        const socket = io.to(sessionId);

        try {
            socket.emit('log', { type: 'info', message: 'ブラウザを起動中...' });

            // 進捗コールバック
            const progressCallback = (progress) => {
                socket.emit('progress', progress);
            };

            const scraper = new GoogleMapScraper(headless !== false, progressCallback);
            const exporter = new CsvExporter(outputFile);

            // スクレイパーのログをキャプチャしてSocketで送信
            const originalLog = console.log;
            const originalError = console.error;
            const originalWarn = console.warn;

            console.log = (...args) => {
                const message = args.join(' ');
                socket.emit('log', { type: 'info', message });
                originalLog.apply(console, args);
            };

            console.error = (...args) => {
                const message = args.join(' ');
                socket.emit('log', { type: 'error', message });
                originalError.apply(console, args);
            };

            console.warn = (...args) => {
                const message = args.join(' ');
                socket.emit('log', { type: 'warning', message });
                originalWarn.apply(console, args);
            };

            try {
                await scraper.initialize();

                socket.emit('log', { type: 'info', message: '検索を開始します...' });
                const results = await scraper.search(
                    address,
                    keyword,
                    parseFloat(ratingMin) || 0,
                    parseFloat(ratingMax) || null,
                    parseInt(reviewCountMin) || 0,
                    parseInt(reviewCountMax) || null,
                    filters
                );

                if (results.length > 0) {
                    socket.emit('log', { type: 'info', message: `${results.length}件のデータをCSVに保存中...` });
                    socket.emit('progress', { stage: 'saving', message: 'CSVファイルを保存中...' });
                    await exporter.writeRecords(results);

                    socket.emit('complete', {
                        success: true,
                        count: results.length,
                        results: results,  // 結果データを送信
                        filename: outputFile,
                        downloadUrl: `/download/${outputFile}`
                    });
                } else {
                    socket.emit('complete', {
                        success: false,
                        message: '結果が見つかりませんでした。検索条件を変更してください。'
                    });
                }
            } finally {
                await scraper.close();

                // ログを元に戻す
                console.log = originalLog;
                console.error = originalError;
                console.warn = originalWarn;
            }
        } catch (error) {
            socket.emit('log', { type: 'error', message: `エラー: ${error.message}` });
            socket.emit('complete', {
                success: false,
                message: error.message
            });
        }
    })();
});

// CSV ダウンロードエンドポイント
app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filepath = path.join(__dirname, filename);

    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ error: 'ファイルが見つかりません' });
    }

    res.download(filepath, filename, (err) => {
        if (err) {
            console.error('ダウンロードエラー:', err);
        }

        // ダウンロード後、ファイルを削除
        setTimeout(() => {
            try {
                fs.unlinkSync(filepath);
            } catch (e) {
                console.error('ファイル削除エラー:', e);
            }
        }, 5000);
    });
});

// Socket.IO接続
io.on('connection', (socket) => {
    console.log('クライアント接続:', socket.id);

    socket.on('join', (sessionId) => {
        socket.join(sessionId);
        console.log(`セッション ${sessionId} に参加しました`);
    });

    socket.on('disconnect', () => {
        console.log('クライアント切断:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log('='.repeat(60));
    console.log(`Google Map Exporter Webサーバーが起動しました`);
    console.log(`URL: ${url}`);
    console.log('='.repeat(60));

    // ブラウザを自動で開く
    openBrowser(url);
});
