// Socket.IO接続
const socket = io();

// 隠しデバッグモード（Ctrl+Shift+D で表示切替）
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') {
        e.preventDefault();
        const debugOption = document.getElementById('debugOption');
        if (debugOption.style.display === 'none') {
            debugOption.style.display = 'block';
            console.log('Debug mode enabled');
        } else {
            debugOption.style.display = 'none';
            document.getElementById('debugMode').checked = false;
            console.log('Debug mode disabled');
        }
    }
});

// DOM要素
const form = document.getElementById('scrapeForm');

// Enterキーでのフォーム送信を無効化（ボタンクリックのみ許可）
form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
    }
});
const startButton = document.getElementById('startButton');
const progressSection = document.getElementById('progressSection');
const progressFill = document.getElementById('progressFill');
const resultSection = document.getElementById('resultSection');
const resultMessage = document.getElementById('resultMessage');
const downloadButton = document.getElementById('downloadButton');
const newSearchButton = document.getElementById('newSearchButton');
const resultTableContainer = document.getElementById('resultTableContainer');
const resultTableBody = document.getElementById('resultTableBody');
const initialMessage = document.getElementById('initialMessage');
const progressStage = document.getElementById('progressStage');

let currentSessionId = null;
let downloadUrl = null;

// フォーム送信
form.addEventListener('submit', async (e) => {
    e.preventDefault();

    // 曜日チェックボックスの値を取得
    const dayCheckboxes = document.querySelectorAll('input[name="dayFilter"]:checked');
    const selectedDays = Array.from(dayCheckboxes).map(cb => cb.value);

    // フォームデータの取得（キーワードに場所も含める）
    const keyword = document.getElementById('keyword').value.trim();
    // デバッグモードのチェック（チェックされていたらブラウザ表示）
    const isDebugMode = document.getElementById('debugMode').checked;

    const formData = {
        address: '',  // キーワードに含まれる
        keyword: keyword,
        ratingMin: parseFloat(document.getElementById('ratingMin').value) || 0,
        ratingMax: parseFloat(document.getElementById('ratingMax').value) || null,
        reviewCountMin: parseInt(document.getElementById('reviewCountMin').value) || 0,
        reviewCountMax: parseInt(document.getElementById('reviewCountMax').value) || null,
        headless: !isDebugMode,  // デバッグモードならブラウザ表示
        // 絞り込み条件
        addressFilter: document.getElementById('addressFilter').value.trim(),
        categoryFilter: document.getElementById('categoryFilter').value.trim(),
        budgetMin: parseInt(document.getElementById('budgetMin').value) || null,
        budgetMax: parseInt(document.getElementById('budgetMax').value) || null,
        dayFilter: selectedDays,
        hoursFilter: document.getElementById('hoursFilter').value,
        maxItems: parseInt(document.getElementById('maxItems').value) || 0  // 0は無制限
    };

    // UIの初期化
    startButton.disabled = true;
    startButton.textContent = '処理中...';
    initialMessage.style.display = 'none';
    progressSection.style.display = 'block';
    resultSection.style.display = 'none';
    progressFill.style.width = '0%';
    progressFill.textContent = '';
    progressStage.textContent = '準備中...';

    try {
        // APIリクエスト
        const response = await fetch('/api/scrape', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(formData)
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'エラーが発生しました');
        }

        currentSessionId = data.sessionId;

        // セッションに参加
        socket.emit('join', currentSessionId);

    } catch (error) {
        alert('エラー: ' + error.message);
        startButton.disabled = false;
        startButton.textContent = '検索開始';
    }
});

// Socket.IOイベントリスナー

socket.on('progress', (data) => {
    // ステージに応じた表示を更新
    const stage = data.stage;
    let label = '';

    if (stage === 'details' && data.current && data.total) {
        // 絞り込み中は件数を表示
        label = `絞り込み中 ${data.current}件目 / ${data.total}件`;
    } else {
        const stageLabels = {
            'opening': 'Google Mapsを開いています...',
            'searching': '検索中...',
            'waiting': '検索結果を読み込み中...',
            'scrolling': 'リストをスクロール中...',
            'extracting': '候補店リストを抽出中...',
            'extracted': '候補店リストアップ完了',
            'prefiltering': '事前フィルタリング中...',
            'prefiltered': '事前フィルタリング完了',
            'details': '絞り込み中...',
            'saving': 'CSVファイルを保存中...',
            'completed': '処理完了'
        };
        // メッセージがあればそれを使う（取得件数情報などを含む）
        label = data.message || stageLabels[stage] || '処理中...';
    }
    progressStage.textContent = label;

    // プログレスバーの更新
    if (stage === 'opening') {
        progressFill.style.width = '5%';
        progressFill.textContent = '5%';
    } else if (stage === 'searching') {
        progressFill.style.width = '10%';
        progressFill.textContent = '10%';
    } else if (stage === 'waiting' || stage === 'scrolling') {
        progressFill.style.width = '15%';
        progressFill.textContent = '15%';
    } else if (stage === 'extracted') {
        progressFill.style.width = '20%';
        progressFill.textContent = '20%';
    } else if (stage === 'prefiltered') {
        progressFill.style.width = '30%';
        progressFill.textContent = '30%';
    } else if (stage === 'details') {
        // 絞り込み中は30%〜95%の範囲で進捗
        const percent = data.percent || 0;
        const barPercent = Math.round(30 + (percent * 0.65));
        progressFill.style.width = `${barPercent}%`;
        progressFill.textContent = `${barPercent}%`;
    } else if (stage === 'saving' || stage === 'completed') {
        progressFill.style.width = '100%';
        progressFill.textContent = '100%';
    }
});

socket.on('complete', (data) => {
    resultSection.style.display = 'block';

    if (data.success) {
        resultMessage.textContent = `✓ 完了！${data.count}件のデータを取得しました。`;
        resultMessage.style.color = '#10b981';

        downloadUrl = data.downloadUrl;
        downloadButton.style.display = 'inline-block';
        downloadButton.onclick = () => {
            window.location.href = downloadUrl;
        };

        // 結果テーブルを表示
        if (data.results && data.results.length > 0) {
            renderResultTable(data.results);
            resultTableContainer.style.display = 'block';
        }

    } else {
        resultMessage.textContent = `✗ ${data.message}`;
        resultMessage.style.color = '#ef4444';
        downloadButton.style.display = 'none';
        resultTableContainer.style.display = 'none';
    }

    startButton.disabled = false;
    startButton.textContent = '検索開始';
    progressFill.style.width = '100%';
});

// 結果テーブルを描画
function renderResultTable(results) {
    resultTableBody.innerHTML = '';

    results.forEach((item) => {
        const row = document.createElement('tr');

        // 店名
        const nameCell = document.createElement('td');
        nameCell.textContent = item.name || '';
        nameCell.className = 'cell-name';
        row.appendChild(nameCell);

        // カテゴリ
        const categoryCell = document.createElement('td');
        categoryCell.textContent = item.category || '';
        row.appendChild(categoryCell);

        // 評価
        const ratingCell = document.createElement('td');
        ratingCell.textContent = item.rating || '';
        ratingCell.className = 'cell-rating';
        row.appendChild(ratingCell);

        // 件数
        const reviewsCell = document.createElement('td');
        reviewsCell.textContent = item.reviews || '';
        reviewsCell.className = 'cell-reviews';
        row.appendChild(reviewsCell);

        // 予算
        const budgetCell = document.createElement('td');
        budgetCell.textContent = item.budget || '';
        row.appendChild(budgetCell);

        // 住所
        const addressCell = document.createElement('td');
        addressCell.textContent = item.address || '';
        addressCell.className = 'cell-address';
        row.appendChild(addressCell);

        // 営業時間
        const hoursCell = document.createElement('td');
        hoursCell.textContent = item.businessHours || '';
        hoursCell.className = 'cell-hours';
        row.appendChild(hoursCell);

        // 口コミ
        const reviewCell = document.createElement('td');
        reviewCell.textContent = item.review || '';
        reviewCell.className = 'cell-review';
        row.appendChild(reviewCell);

        // MAP リンク
        const urlCell = document.createElement('td');
        if (item.url) {
            const link = document.createElement('a');
            link.href = item.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = '開く';
            link.className = 'map-link';
            urlCell.appendChild(link);
        }
        row.appendChild(urlCell);

        resultTableBody.appendChild(row);
    });
}


// 新しい検索ボタン
newSearchButton.addEventListener('click', () => {
    // フォームをリセット
    form.reset();
    document.getElementById('keyword').value = '';
    document.getElementById('ratingMin').value = '';
    document.getElementById('ratingMax').value = '';
    document.getElementById('reviewCountMin').value = '';
    document.getElementById('reviewCountMax').value = '';
    // 詳細フィルターもリセット
    document.getElementById('addressFilter').value = '';
    document.getElementById('categoryFilter').value = '';
    document.getElementById('budgetMin').value = '';
    document.getElementById('budgetMax').value = '';
    // 曜日チェックボックスをリセット
    document.querySelectorAll('input[name="dayFilter"]').forEach(cb => cb.checked = false);
    document.getElementById('hoursFilter').value = '';
    document.getElementById('maxItems').value = '';
    // デバッグモードはリセットしない（開発者は継続して使用するため）

    // UIをリセット
    progressSection.style.display = 'none';
    resultSection.style.display = 'none';
    resultTableContainer.style.display = 'none';
    resultTableBody.innerHTML = '';
    progressFill.style.width = '0%';
    progressFill.textContent = '';
    startButton.disabled = false;
    startButton.textContent = '検索開始';
    initialMessage.style.display = 'flex';

    // ページトップにスクロール
    window.scrollTo({ top: 0, behavior: 'smooth' });
});

// 接続状態の監視
socket.on('connect', () => {
    console.log('Socket.IO接続成功');
});

socket.on('disconnect', () => {
    console.log('Socket.IO切断');
});

socket.on('connect_error', (error) => {
    console.error('Socket.IO接続エラー:', error);
});
