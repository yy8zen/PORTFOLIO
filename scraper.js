const { chromium } = require('playwright');

class GoogleMapScraper {
    constructor(headless = false, progressCallback = null) {
        this.headless = headless;
        this.browser = null;
        this.page = null;
        // リトライ設定
        this.maxRetries = 3;
        this.retryDelay = 2000; // ミリ秒
        this.navigationTimeout = 60000; // ナビゲーションタイムアウト（60秒）
        this.elementTimeout = 20000; // 要素待機タイムアウト（20秒）
        // 進捗コールバック
        this.progressCallback = progressCallback;
    }

    /**
     * 進捗を報告
     * @param {string} stage 現在のステージ
     * @param {Object} data 追加データ（current, total, message など）
     */
    reportProgress(stage, data = {}) {
        if (this.progressCallback) {
            this.progressCallback({ stage, ...data });
        }
    }

    /**
     * リトライロジック付きで関数を実行
     * @param {Function} fn 実行する関数
     * @param {string} operationName 操作名（ログ用）
     * @param {number} maxRetries 最大リトライ回数
     * @returns {Promise<any>} 関数の実行結果
     */
    async retryOperation(fn, operationName, maxRetries = this.maxRetries) {
        let lastError;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`${operationName}を実行中... (試行 ${attempt}/${maxRetries})`);
                const result = await fn();
                if (attempt > 1) {
                    console.log(`${operationName}が成功しました (試行 ${attempt}回目)`);
                }
                return result;
            } catch (error) {
                lastError = error;
                console.warn(`${operationName}が失敗しました (試行 ${attempt}/${maxRetries}): ${error.message}`);

                if (attempt < maxRetries) {
                    const delay = this.retryDelay * attempt; // 指数バックオフ
                    console.log(`${delay}ms後にリトライします...`);
                    await this.page?.waitForTimeout(delay).catch(() => {});
                } else {
                    console.error(`${operationName}が最大リトライ回数に達しました`);
                }
            }
        }
        throw lastError;
    }

    async initialize() {
        try {
            console.log('ブラウザを起動中...');
            this.browser = await chromium.launch({
                headless: this.headless,
                timeout: 60000,
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage'
                ]
            });

            // UserAgentとビューポートを設定（bot検出回避）
            this.context = await this.browser.newContext({
                locale: 'ja-JP',
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                viewport: { width: 1920, height: 1080 },
                deviceScaleFactor: 1,
            });
            this.page = await this.context.newPage();

            // webdriver検出を回避
            await this.page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined,
                });
            });

            // タイムアウト設定
            this.page.setDefaultTimeout(this.elementTimeout);
            this.page.setDefaultNavigationTimeout(this.navigationTimeout);

            console.log('ブラウザの起動が完了しました');
        } catch (error) {
            console.error('ブラウザの起動に失敗しました:', error.message);
            throw new Error(`ブラウザ初期化エラー: ${error.message}`);
        }
    }

    async close() {
        try {
            if (this.browser) {
                console.log('ブラウザを終了中...');
                await this.browser.close();
                console.log('ブラウザを終了しました');
            }
        } catch (error) {
            console.warn('ブラウザの終了時にエラーが発生しました:', error.message);
        }
    }

    async search(address, keyword, minRating = 0, minReviews = 0, filters = {}) {
        try {
            // Google Mapsへのナビゲーション（リトライ付き）
            this.reportProgress('opening', { message: 'Google Mapsを開いています...' });
            await this.retryOperation(
                async () => {
                    await this.page.goto('https://www.google.co.jp/maps?hl=ja', {
                        waitUntil: 'load',
                        timeout: this.navigationTimeout
                    });
                    // ページが完全に読み込まれるまで待機
                    await this.page.waitForTimeout(5000);
                },
                'Google Mapsへのアクセス'
            );

            // 1. 「住所 キーワード」で一括検索（住所が空の場合はキーワードのみ）
            const query = [address, keyword].filter(s => s && s.trim()).join(' ');
            console.log(`検索クエリ: ${query}`);
            this.reportProgress('searching', { message: `「${query}」を検索中...` });

            await this.retryOperation(
                async () => {
                    // 複数のセレクタを試す
                    let searchInput = null;

                    const selectors = [
                        '#searchboxinput',
                        'input[name="q"]',
                        'input[aria-label*="検索"]',
                        'input[placeholder*="検索"]',
                        'input[type="text"]'
                    ];

                    for (const selector of selectors) {
                        try {
                            searchInput = this.page.locator(selector).first();
                            await searchInput.waitFor({ timeout: 3000, state: 'visible' });
                            break;
                        } catch (e) {
                            searchInput = null;
                        }
                    }

                    if (!searchInput) {
                        throw new Error('検索ボックスが見つかりませんでした');
                    }

                    await searchInput.click();
                    await this.page.waitForTimeout(500);
                    await searchInput.fill(query);
                    await this.page.waitForTimeout(500);
                    await searchInput.press('Enter');
                    await this.page.waitForTimeout(5000); // 検索結果の読み込み待機
                },
                '検索'
            );

            // 2. 検索結果リストの待機
            console.log('検索結果を待機中...');
            this.reportProgress('waiting', { message: '検索結果を読み込み中...' });
            const feed = this.page.getByRole('feed');
            try {
                await feed.waitFor({ timeout: this.elementTimeout });
            } catch (e) {
                console.error('検索結果のフィードが見つかりませんでした。');
                console.log('単一の結果が表示されている可能性があります。');
                return [];
            }

            // 3. スクロールして追加の結果を読み込み
            this.reportProgress('scrolling', { message: 'リストをスクロールして候補を取得中...' });
            await this.autoScroll(feed);

            // 4. 基本リストの抽出
            this.reportProgress('extracting', { message: '候補店リストを抽出中...' });
            const candidates = await this.extractBasicList(feed);
            console.log(`${candidates.length}件の候補を抽出しました`);
            this.reportProgress('extracted', { message: `候補店リストアップ完了: ${candidates.length}件`, total: candidates.length });

            if (candidates.length === 0) {
                console.warn('候補が見つかりませんでした。検索条件を確認してください。');
                return [];
            }

            // 5. 事前フィルタリング（リストから取得できる情報でフィルタリング）
            console.log('\n--- 事前フィルタリング ---');
            this.reportProgress('prefiltering', { message: '事前フィルタリング中...', total: candidates.length });
            const targets = [];
            let preFilteredOut = { rating: 0, reviews: 0, category: 0, budget: 0 };

            for (const c of candidates) {
                const r = parseFloat(c.rating) || 0;
                const rev = parseInt(c.reviews) || 0;

                // 評価フィルター
                if (minRating > 0 && r < minRating) {
                    preFilteredOut.rating++;
                    continue;
                }

                // レビュー数フィルター（リストで取得できた場合のみ）
                if (minReviews > 0 && rev > 0 && rev < minReviews) {
                    preFilteredOut.reviews++;
                    continue;
                }

                // カテゴリフィルター（カテゴリ or リストテキストから検索）
                if (filters.category) {
                    const categoryKeywords = filters.category.split(',').map(s => s.trim().toLowerCase()).filter(s => s);
                    if (categoryKeywords.length > 0) {
                        // まず抽出したカテゴリをチェック
                        const cat = (c.category || '').toLowerCase();
                        const listText = (c.listText || '').toLowerCase();

                        // カテゴリまたはリストテキストにキーワードが含まれているかチェック
                        const matchesCategory = categoryKeywords.some(keyword => cat.includes(keyword));
                        const matchesListText = categoryKeywords.some(keyword => listText.includes(keyword));

                        if (!matchesCategory && !matchesListText) {
                            preFilteredOut.category++;
                            continue;
                        }
                    }
                }

                // 予算フィルター（リストから取得できた場合）
                if ((filters.budgetMin !== null || filters.budgetMax !== null) && c.budget) {
                    const priceMatch = c.budget.match(/[￥¥]([0-9,]+)/);
                    if (priceMatch) {
                        const price = parseInt(priceMatch[1].replace(/,/g, ''));
                        if (filters.budgetMin !== null && price < filters.budgetMin) {
                            preFilteredOut.budget++;
                            continue;
                        }
                        if (filters.budgetMax !== null && price > filters.budgetMax) {
                            preFilteredOut.budget++;
                            continue;
                        }
                    }
                }

                targets.push(c);
            }

            console.log(`事前フィルタリング結果: ${targets.length}件が条件を満たしています`);
            this.reportProgress('prefiltered', {
                message: `事前フィルタリング完了: ${candidates.length}件 → ${targets.length}件`,
                total: targets.length,
                original: candidates.length
            });
            if (preFilteredOut.rating > 0) {
                console.log(`  - 評価で除外: ${preFilteredOut.rating}件 (${minRating}未満)`);
            }
            if (preFilteredOut.reviews > 0) {
                console.log(`  - レビュー数で除外: ${preFilteredOut.reviews}件 (${minReviews}件未満)`);
            }
            if (preFilteredOut.category > 0) {
                console.log(`  - カテゴリで除外: ${preFilteredOut.category}件 (${filters.category}を含まない)`);
            }
            if (preFilteredOut.budget > 0) {
                console.log(`  - 予算で除外: ${preFilteredOut.budget}件 (範囲外)`);
            }
            if (minReviews > 0) {
                const unknownReviews = targets.filter(t => !t.reviews || t.reviews === 0).length;
                if (unknownReviews > 0) {
                    console.log(`  - レビュー数不明: ${unknownReviews}件 (詳細取得後に確認)`);
                }
            }

            if (targets.length === 0) {
                console.warn('フィルタリング後の結果が0件です。条件を緩和してください。');
                return [];
            }
            console.log('--- 事前フィルタリング完了 ---\n');

            // 6. 各店舗の詳細情報を並列取得（フィルター適用しながら）
            const finalResults = [];
            let successCount = 0;
            let failCount = 0;
            let filteredOutCount = 0;
            let processedCount = 0;

            // 並列処理の設定
            const maxItemsPerTab = 3;  // 1タブあたり最大3件
            const numTabs = Math.min(Math.ceil(targets.length / maxItemsPerTab), 5);  // 最大5タブ
            console.log(`\n並列処理: ${numTabs}タブで${targets.length}件を処理します`);

            // 追加のページを作成
            const pages = [this.page];
            for (let i = 1; i < numTabs; i++) {
                const newPage = await this.context.newPage();
                newPage.setDefaultTimeout(this.elementTimeout);
                newPage.setDefaultNavigationTimeout(this.navigationTimeout);
                pages.push(newPage);
            }

            // ターゲットをタブごとに分割
            const chunks = [];
            for (let i = 0; i < targets.length; i += maxItemsPerTab) {
                chunks.push(targets.slice(i, i + maxItemsPerTab));
            }

            // チャンクをタブに割り当てて並列処理
            const processChunk = async (chunk, pageIndex, chunkIndex) => {
                const page = pages[pageIndex % pages.length];
                const results = [];

                for (const target of chunk) {
                    try {
                        const details = await this.getDetailsWithPage(page, target.url);
                        const mergedResult = {
                            ...target,
                            ...details,
                            rating: details.detailRating > 0 ? details.detailRating : target.rating,
                            reviews: details.detailReviews > 0 ? details.detailReviews : target.reviews,
                            category: (target.category && target.category !== 'Unknown') ? target.category : (details.category || 'Unknown'),
                            budget: target.budget || details.budget || '',
                            review: target.review || ''
                        };
                        delete mergedResult.detailRating;
                        delete mergedResult.detailReviews;
                        delete mergedResult.listText;

                        const filterResult = this.checkFilters(mergedResult, minReviews, filters);
                        results.push({
                            result: mergedResult,
                            passed: filterResult.passed,
                            reason: filterResult.reason,
                            name: target.name
                        });
                    } catch (error) {
                        results.push({
                            result: null,
                            passed: false,
                            error: error.message,
                            name: target.name
                        });
                    }
                }
                return results;
            };

            // 並列でチャンクを処理（タブ数分ずつ）
            for (let i = 0; i < chunks.length; i += numTabs) {
                const batch = chunks.slice(i, i + numTabs);
                const promises = batch.map((chunk, idx) => processChunk(chunk, idx, i + idx));

                const batchResults = await Promise.all(promises);

                // 結果を集計
                for (const chunkResults of batchResults) {
                    for (const item of chunkResults) {
                        processedCount++;
                        if (item.error) {
                            failCount++;
                            console.log(`✗ ${item.name}: 取得失敗`);
                        } else if (item.passed) {
                            finalResults.push(item.result);
                            successCount++;
                            console.log(`✓ ${item.name}: 条件適合`);
                        } else {
                            filteredOutCount++;
                            console.log(`✗ ${item.name}: ${item.reason}`);
                        }
                    }
                }

                // 進捗報告
                const percent = Math.round((processedCount / targets.length) * 100);
                this.reportProgress('details', {
                    message: `詳細情報を取得中...`,
                    current: processedCount,
                    total: targets.length,
                    percent: percent,
                    matched: successCount,
                    filtered: filteredOutCount
                });

                // バッチ間の待機（レート制限回避）
                if (i + numTabs < chunks.length) {
                    await this.page.waitForTimeout(300);
                }
            }

            // 追加で作成したページを閉じる
            for (let i = 1; i < pages.length; i++) {
                await pages[i].close().catch(() => {});
            }

            console.log(`\n処理完了: 適合${finalResults.length}件, 除外${filteredOutCount}件, 失敗${failCount}件`);
            this.reportProgress('completed', {
                message: `処理完了: ${finalResults.length}件取得`,
                total: finalResults.length,
                filtered: filteredOutCount,
                failed: failCount
            });

            // 評価順 → 評価件数順でソート（降順）
            finalResults.sort((a, b) => {
                const ratingA = parseFloat(a.rating) || 0;
                const ratingB = parseFloat(b.rating) || 0;
                if (ratingB !== ratingA) {
                    return ratingB - ratingA;  // 評価が高い順
                }
                const reviewsA = parseInt(a.reviews) || 0;
                const reviewsB = parseInt(b.reviews) || 0;
                return reviewsB - reviewsA;  // 評価件数が多い順
            });
            console.log('結果を評価順・評価件数順でソートしました');

            return finalResults;

        } catch (error) {
            console.error('検索処理中に致命的なエラーが発生しました:', error.message);
            console.error('スタックトレース:', error.stack);
            throw new Error(`検索エラー: ${error.message}`);
        }
    }

    /**
     * 単一アイテムに対してすべてのフィルターをチェック
     * @param {Object} item 検索結果アイテム
     * @param {number} minReviews 最小レビュー数
     * @param {Object} filters 詳細フィルター設定
     * @returns {{passed: boolean, reason: string}} チェック結果
     */
    checkFilters(item, minReviews, filters) {
        // レビュー数チェック
        if (minReviews > 0) {
            const rev = parseInt(item.reviews) || 0;
            if (rev < minReviews) {
                return { passed: false, reason: `レビュー数不足 (${rev}件 < ${minReviews}件)` };
            }
        }

        // 住所フィルター
        if (filters.address) {
            const addressKeywords = filters.address.split(',').map(s => s.trim()).filter(s => s);
            if (addressKeywords.length > 0) {
                const addr = item.address || '';
                if (!addressKeywords.some(keyword => addr.includes(keyword))) {
                    return { passed: false, reason: `住所不一致 (${addr.substring(0, 20) || '不明'}...)` };
                }
            }
        }

        // カテゴリフィルター
        if (filters.category) {
            const categoryKeywords = filters.category.split(',').map(s => s.trim().toLowerCase()).filter(s => s);
            if (categoryKeywords.length > 0) {
                const cat = (item.category || '').toLowerCase();
                if (!categoryKeywords.some(keyword => cat.includes(keyword))) {
                    return { passed: false, reason: `カテゴリ不一致 (${item.category || '不明'})` };
                }
            }
        }

        // 予算フィルター（数値範囲）
        if (filters.budgetMin !== null || filters.budgetMax !== null) {
            const budget = item.budget || '';
            if (budget) {  // 予算情報がある場合のみチェック
                // 「￥1,000～2,000」のパターンから最初の数値を抽出
                const priceMatch = budget.match(/[￥¥]([0-9,]+)/);
                if (priceMatch) {
                    const price = parseInt(priceMatch[1].replace(/,/g, ''));
                    if (filters.budgetMin !== null && price < filters.budgetMin) {
                        return { passed: false, reason: `予算が下限未満 (${budget} < ￥${filters.budgetMin.toLocaleString()})` };
                    }
                    if (filters.budgetMax !== null && price > filters.budgetMax) {
                        return { passed: false, reason: `予算が上限超過 (${budget} > ￥${filters.budgetMax.toLocaleString()})` };
                    }
                }
            }
        }

        // 営業曜日フィルター（複数選択）
        if (filters.days && filters.days.length > 0) {
            const hours = item.businessHours || '';
            if (hours) {  // 営業時間情報がある場合のみチェック
                const lowerHours = hours.toLowerCase();
                let foundOpenDay = false;

                for (const day of filters.days) {
                    const dayShort = day.replace('曜日', '');
                    // 定休日チェック
                    if ((lowerHours.includes('定休') || lowerHours.includes('休み')) && hours.includes(dayShort)) {
                        continue;  // この曜日は定休日
                    }
                    // 営業日として含まれているかチェック
                    if (hours.includes(dayShort)) {
                        foundOpenDay = true;
                        break;
                    }
                }

                if (!foundOpenDay) {
                    const dayNames = filters.days.map(d => d.replace('曜日', '')).join('・');
                    return { passed: false, reason: `指定曜日(${dayNames})に営業していない` };
                }
            }
        }

        // 営業時間フィルター（単一時間）
        if (filters.hours) {
            const hours = item.businessHours || '';
            if (hours) {  // 営業時間情報がある場合のみチェック
                const timeResult = this.checkOpenAtTime(hours, filters.hours, filters.days);
                if (!timeResult.passed) {
                    return { passed: false, reason: timeResult.reason };
                }
            }
        }

        return { passed: true, reason: '' };
    }

    /**
     * 指定時間に営業しているかチェック
     * @param {string} businessHours 営業時間文字列（例: "月火水木金: 9時00分～21時00分 / 土日: 10時00分～18時00分"）
     * @param {string} targetTime チェックする時間（hh:mm形式）
     * @param {Array} targetDays チェック対象の曜日（空の場合は全曜日）
     * @returns {{passed: boolean, reason: string}}
     */
    checkOpenAtTime(businessHours, targetTime, targetDays = []) {
        // 時間をパース（hh:mm形式を分に変換）
        const parseTime = (timeStr) => {
            if (!timeStr) return null;
            const match = timeStr.match(/(\d{1,2}):(\d{2})/);
            if (match) {
                return parseInt(match[1]) * 60 + parseInt(match[2]);
            }
            return null;
        };

        // 営業時間文字列から時間を抽出（「9時00分～21時00分」のようなパターン）
        const parseBusinessTime = (timeStr) => {
            const match = timeStr.match(/(\d{1,2})時(\d{2})分/g);
            if (match && match.length >= 2) {
                const open = match[0].match(/(\d{1,2})時(\d{2})分/);
                const close = match[1].match(/(\d{1,2})時(\d{2})分/);
                if (open && close) {
                    return {
                        open: parseInt(open[1]) * 60 + parseInt(open[2]),
                        close: parseInt(close[1]) * 60 + parseInt(close[2])
                    };
                }
            }
            return null;
        };

        const targetMinutes = parseTime(targetTime);
        if (targetMinutes === null) {
            return { passed: true, reason: '' };
        }

        // 営業時間をセグメントに分解
        // フォーマット: "月火水木金: 9時00分～21時00分 / 土日: 10時00分～18時00分"
        const segments = businessHours.split('/').map(s => s.trim());
        let foundMatch = false;

        for (const segment of segments) {
            // 曜日部分と時間部分を分離
            const colonIndex = segment.indexOf(':');
            if (colonIndex === -1) continue;

            const dayPart = segment.substring(0, colonIndex);
            const timePart = segment.substring(colonIndex + 1);

            // 対象曜日が指定されている場合、その曜日のセグメントかチェック
            if (targetDays && targetDays.length > 0) {
                const dayShorts = targetDays.map(d => d.replace('曜日', ''));
                const matchesDay = dayShorts.some(d => dayPart.includes(d));
                if (!matchesDay) continue;
            }

            const bizTime = parseBusinessTime(timePart);
            if (!bizTime) continue;

            // 指定時間が営業時間内かチェック
            // 深夜またぎ（例: 18:00～5:00）の場合は close < open になる
            let isOpen = false;
            if (bizTime.close > bizTime.open) {
                // 通常ケース（例: 9:00～21:00）
                isOpen = targetMinutes >= bizTime.open && targetMinutes < bizTime.close;
            } else {
                // 深夜またぎケース（例: 18:00～5:00）
                // open以降 OR close未満 なら営業中
                isOpen = targetMinutes >= bizTime.open || targetMinutes < bizTime.close;
            }

            if (isOpen) {
                foundMatch = true;
                break;
            }
        }

        if (!foundMatch) {
            return { passed: false, reason: `${targetTime}に営業していない` };
        }

        return { passed: true, reason: '' };
    }

    async autoScroll(feedLocator) {
        console.log('リストをスクロール中（最後まで）...');
        const maxScrollAttempts = 100;  // 十分大きな上限
        let scrollAttempt = 0;
        let previousHeight = 0;
        let noChangeCount = 0;

        try {
            for (let i = 0; i < maxScrollAttempts; i++) {
                scrollAttempt = i + 1;

                // 現在のスクロール位置を取得
                const currentHeight = await feedLocator.evaluate(el => el.scrollHeight);

                if (scrollAttempt % 5 === 1 || scrollAttempt <= 3) {
                    console.log(`スクロール ${scrollAttempt}回目... (高さ: ${currentHeight})`);
                }

                try {
                    await feedLocator.evaluate(el => el.scrollBy(0, 5000));
                    await this.page.waitForTimeout(1500);

                    // 「すべて表示しました」テキストをチェック
                    try {
                        const endText = await this.page.getByText('すべて表示しました').isVisible({ timeout: 500 });
                        if (endText) {
                            console.log('リストの最後に到達しました');
                            break;
                        }
                    } catch (e) {
                        // テキストが見つからない場合は続行
                    }

                    // スクロール後の高さをチェック
                    const newHeight = await feedLocator.evaluate(el => el.scrollHeight);
                    if (newHeight === previousHeight) {
                        noChangeCount++;
                        if (noChangeCount >= 3) {
                            console.log('これ以上読み込めるコンテンツがありません');
                            break;
                        }
                    } else {
                        noChangeCount = 0;
                    }
                    previousHeight = newHeight;

                } catch (error) {
                    console.warn(`スクロール ${scrollAttempt} でエラーが発生: ${error.message}`);
                    // スクロールエラーは致命的ではないので続行
                }
            }
            console.log(`スクロール完了 (${scrollAttempt}回実行)`);
        } catch (error) {
            console.error('スクロール中にエラーが発生しました:', error.message);
            // スクロールに失敗しても、取得できた分だけ処理を続行
        }
    }

    async extractBasicList(feedLocator) {
        console.log('リストから基本情報を抽出中...');
        const results = [];
        let errorCount = 0;

        try {
            // リンクの親要素を取得する
            const linkElements = await feedLocator.locator('a[href*="/maps/place/"]').all();
            console.log(`${linkElements.length}個のリンクを検出しました`);

            for (let i = 0; i < linkElements.length; i++) {
                try {
                    const linkEl = linkElements[i];
                    const url = await linkEl.getAttribute('href');

                    if (!url) {
                        errorCount++;
                        continue;
                    }

                    // 親要素を取得（複数レベル試す）
                    let containerEl = linkEl;
                    try {
                        // 親要素を数レベル上がってみる
                        containerEl = linkEl.locator('xpath=ancestor::div[@role="article" or contains(@class, "Nv2PK")]').first();
                        const count = await containerEl.count();
                        if (count === 0) {
                            // article要素が見つからない場合、単純に親を取得
                            containerEl = linkEl.locator('..').locator('..').locator('..');
                        }
                    } catch (e) {
                        // 親要素の取得に失敗した場合はリンク要素自体を使用
                        containerEl = linkEl;
                    }

                    // aria-labelを試す（リンク要素から）
                    let ariaLabel = '';
                    try {
                        ariaLabel = await linkEl.getAttribute('aria-label', { timeout: 500 });
                    } catch (e) {
                        // aria-labelがない場合もある
                    }

                    // コンテナからテキストを取得
                    let text = '';
                    try {
                        // textContentを使用
                        text = await containerEl.evaluate(el => el.textContent || '', { timeout: 2000 });
                    } catch (e) {
                        // 失敗した場合はリンク要素から取得を試みる
                        try {
                            text = await linkEl.evaluate(el => {
                                // リンクとその親のテキストを結合
                                const parent = el.parentElement;
                                return (parent ? parent.textContent : '') || el.textContent || '';
                            }, { timeout: 2000 });
                        } catch (e2) {
                            if (i < 5) {  // 最初の5つだけ詳細ログ
                                console.warn(`アイテム ${i + 1} のテキスト取得に失敗: ${e2.message}`);
                                console.warn(`  URL: ${url}`);
                            }
                            errorCount++;
                            continue;
                        }
                    }

                    // aria-labelも使用
                    if (ariaLabel) {
                        text = text + '\n' + ariaLabel;
                    }

                    if (!text || text.trim() === '') {
                        errorCount++;
                        continue;
                    }

                    // テキストをパース
                    const lines = text.split('\n').map(l => l.trim()).filter(l => l);

                    if (lines.length === 0) {
                        errorCount++;
                        continue;
                    }

                    // 店名の抽出
                    // 優先順位: 1. aria-label, 2. テキストの先頭部分（評価・予算などを除外）
                    let name = 'Unknown';

                    if (ariaLabel && ariaLabel.trim()) {
                        // aria-labelは通常、店名だけを含む
                        name = ariaLabel.trim();
                    } else {
                        // テキストから店名を抽出
                        // 最初の行から評価(数字.数字)、予算(￥)、レビュー数((数字))などを除去
                        let rawName = lines[0] || '';

                        // 評価パターン「4.5」「4.5(100)」を探して、その前までを店名とする
                        const ratingPos = rawName.search(/[1-5]\.[0-9]/);
                        if (ratingPos > 0) {
                            rawName = rawName.substring(0, ratingPos);
                        }

                        // 「·」区切りがある場合、最初の部分を店名とする
                        const dotPos = rawName.indexOf('·');
                        if (dotPos > 0) {
                            rawName = rawName.substring(0, dotPos);
                        }

                        // 予算記号があればその前までを店名とする
                        const yenPos = rawName.search(/[￥¥]/);
                        if (yenPos > 0) {
                            rawName = rawName.substring(0, yenPos);
                        }

                        name = rawName.trim() || 'Unknown';
                    }

                    let rating = 0;
                    let reviews = 0;
                    let category = 'Unknown';

                    // 評価情報を含む行を検索
                    // パターン:
                    // - "4.5(100)" または "4.5 (100)"
                    // - "4.5" と "(100)" が別行
                    // - "★4.5"
                    // - "評価: 4.5"
                    // - Google Mapsの新しいフォーマット: 数字だけ
                    const fullText = text.toLowerCase();

                    // 全体のテキストから評価を検索（より柔軟なパターン）
                    if (rating === 0) {
                        // パターン1: "4.5" のような小数点数字
                        const ratingMatches = text.match(/([1-5]\.[0-9])/g);
                        if (ratingMatches && ratingMatches.length > 0) {
                            // 最初に見つかった評価らしき数値（1.0-5.0の範囲）
                            for (const match of ratingMatches) {
                                const val = parseFloat(match);
                                if (val >= 1.0 && val <= 5.0) {
                                    rating = val;
                                    break;
                                }
                            }
                        }
                    }

                    // レビュー数の検索
                    if (reviews === 0) {
                        // パターン1: "(100)" のような括弧内の数字
                        const reviewMatch1 = text.match(/\(([0-9,\.]+)\)/);
                        if (reviewMatch1) {
                            const num = reviewMatch1[1].replace(/[,\.]/g, '');
                            reviews = parseInt(num);
                        }

                        // パターン2: "100件" または "100 件"
                        if (reviews === 0) {
                            const reviewMatch2 = text.match(/([0-9,]+)\s*件/);
                            if (reviewMatch2) {
                                reviews = parseInt(reviewMatch2[1].replace(/,/g, ''));
                            }
                        }

                        // パターン3: "100 reviews" (英語表示の場合)
                        if (reviews === 0) {
                            const reviewMatch3 = text.match(/([0-9,]+)\s*reviews?/i);
                            if (reviewMatch3) {
                                reviews = parseInt(reviewMatch3[1].replace(/,/g, ''));
                            }
                        }

                        // パターン4: 評価の直後のカンマ区切り数字 "4.5(1,234)" または "4.5 (1.234)"
                        if (reviews === 0) {
                            const reviewMatch4 = text.match(/[1-5]\.[0-9]\s*\(([0-9,\.]+)\)/);
                            if (reviewMatch4) {
                                const num = reviewMatch4[1].replace(/[,\.]/g, '');
                                reviews = parseInt(num);
                            }
                        }
                    }

                    // 予算の抽出（リストから）
                    // パターン: "￥1,000～2,000" or "¥1,000～2,000"
                    let budget = '';
                    const budgetMatch = text.match(/[￥¥][0-9,]+(?:～[0-9,]+)?/);
                    if (budgetMatch) {
                        budget = budgetMatch[0];
                    }

                    // カテゴリの抽出（リストから）
                    // パターン: "ラーメン店", "カフェ", "居酒屋" など
                    // フォーマット例: "￥1,000～2,000ラーメン" や "· カフェ ·"
                    const categoryPatterns = [
                        // 価格の直後にカテゴリがある場合: "￥1,000～2,000ラーメン"
                        /[￥¥][0-9,]+(?:～[0-9,]+)?([ぁ-んァ-ヶー一-龠]+(?:店|屋|館|院)?)/,
                        // 「·」区切りの場合
                        /·\s*([ぁ-んァ-ヶー一-龠a-zA-Z]+(?:店|屋|館|院|室|所|場)?)\s*·/,
                        /·\s*([ぁ-んァ-ヶー一-龠]+)\s*$/m,
                    ];
                    for (const pattern of categoryPatterns) {
                        const catMatch = text.match(pattern);
                        if (catMatch && catMatch[1] && catMatch[1].length >= 2 && catMatch[1].length <= 20) {
                            // 数字や記号だけの場合は除外
                            if (!/^[\d\s·]+$/.test(catMatch[1])) {
                                category = catMatch[1].trim();
                                break;
                            }
                        }
                    }

                    // 口コミの抽出（リストから）
                    // パターン: "口コミテキスト" や ★5 "口コミテキスト"
                    let review = '';
                    // ダブルクォートで囲まれた口コミを検索
                    const reviewMatch = text.match(/"([^"]+)"/);
                    if (reviewMatch && reviewMatch[1]) {
                        let reviewText = reviewMatch[1].trim();
                        // 口コミの前に★評価があるか確認
                        const beforeQuote = text.substring(0, text.indexOf('"'));
                        const starMatch = beforeQuote.match(/★(\d)/);
                        if (starMatch) {
                            review = `★${starMatch[1]} ${reviewText}`;
                        } else {
                            review = reviewText;
                        }
                    }

                    // リストのテキスト全体を保存（フィルタリング用）
                    const listText = text.substring(0, 300);  // 最初の300文字を保存

                    // デバッグ: 最初の3件のテキスト内容を表示
                    if (i < 3) {
                        console.log(`  デバッグ[${i + 1}]: aria-label="${ariaLabel || 'なし'}"`);
                        console.log(`    テキスト先頭80文字: ${text.substring(0, 80).replace(/\n/g, ' ')}`);
                        console.log(`    → 店名: ${name} | カテゴリ: ${category} | 予算: ${budget || 'なし'}`);
                        if (review) console.log(`    → 口コミ: ${review.substring(0, 50)}...`);
                    }


                    results.push({
                        name,
                        rating,
                        reviews,
                        url,
                        category,
                        budget,
                        review,
                        listText  // フィルタリング用にテキストを保存
                    });

                } catch (error) {
                    if (i < 3) {  // 最初の3つだけ詳細ログ
                        console.warn(`アイテム ${i + 1} の処理中にエラー: ${error.message}`);
                    }
                    errorCount++;
                }
            }

            // URLベースで重複を削除
            const unique = [];
            const urlMap = new Map();
            for (const item of results) {
                if (!urlMap.has(item.url)) {
                    urlMap.set(item.url, true);
                    unique.push(item);
                }
            }

            console.log(`抽出完了: ${unique.length}件 (エラー: ${errorCount}件)`);

            // デバッグ: 最初の5件の抽出データを表示
            if (unique.length > 0) {
                console.log('--- 抽出データのサンプル (最初の5件) ---');
                for (let i = 0; i < Math.min(5, unique.length); i++) {
                    const item = unique[i];
                    console.log(`  [${i + 1}] ${item.name.substring(0, 20)} | 評価: ${item.rating} | カテゴリ: ${item.category} | 予算: ${item.budget || 'なし'}`);
                    if (item.review) {
                        console.log(`      口コミ: ${item.review.substring(0, 40)}...`);
                    }
                }
                console.log('--- サンプル終了 ---');
            }

            return unique;

        } catch (error) {
            console.error('基本リスト抽出中にエラーが発生:', error.message);
            throw new Error(`基本リスト抽出エラー: ${error.message}`);
        }
    }

    async getDetails(url) {
        // リトライ付きでページ遷移
        await this.retryOperation(
            async () => {
                await this.page.goto(url, {
                    waitUntil: 'load',
                    timeout: this.navigationTimeout
                });
            },
            '詳細ページへの遷移',
            2 // 詳細ページは2回までリトライ
        );

        // コンテンツが完全に読み込まれるのを待つ（ヘッドレスモードでは長めに）
        await this.page.waitForTimeout(3000);

        // 評価とレビュー数の抽出（詳細ページから）
        let rating = 0;
        let reviews = 0;
        try {
            // 方法1: 「XXX 件のクチコミ」ボタンからレビュー数を取得（最も確実）
            try {
                const reviewButton = this.page.locator('button').filter({ hasText: /[0-9,]+\s*件のクチコミ/ }).first();
                if (await reviewButton.count() > 0) {
                    const buttonText = await reviewButton.textContent({ timeout: 3000 });
                    const reviewMatch = buttonText?.match(/([0-9,]+)\s*件/);
                    if (reviewMatch) {
                        reviews = parseInt(reviewMatch[1].replace(/,/g, ''));
                    }
                }
            } catch (e) {
                // ボタンが見つからない場合は他の方法を試す
            }

            // 方法2: ボタンで見つからない場合、ページ全体のテキストから探す
            if (reviews === 0) {
                try {
                    const allText = await this.page.evaluate(() => document.body.innerText);
                    const lines = allText.split('\n');
                    for (const line of lines) {
                        // 「XXX 件のクチコミ」パターン（ローカルガイドの行は除外）
                        if (line.includes('件のクチコミ') && !line.includes('ローカルガイド')) {
                            const match = line.match(/([0-9,]+)\s*件のクチコミ/);
                            if (match) {
                                reviews = parseInt(match[1].replace(/,/g, ''));
                                break;
                            }
                        }
                    }
                } catch (e) {
                    // 失敗しても続行
                }
            }

            // 評価を取得
            try {
                const ratingContainer = this.page.locator('[role="img"][aria-label*="つ星"]').first();
                if (await ratingContainer.count() > 0) {
                    const ariaLabel = await ratingContainer.getAttribute('aria-label', { timeout: 3000 });
                    const ratingMatch = ariaLabel?.match(/([0-9]\.[0-9])/);
                    if (ratingMatch) {
                        rating = parseFloat(ratingMatch[1]);
                    }
                }
            } catch (e) {
                // 評価取得に失敗しても続行
            }

            // 評価がまだ取得できていない場合、ページテキストから探す
            if (rating === 0) {
                try {
                    const allText = await this.page.evaluate(() => document.body.innerText);
                    const ratingMatch = allText.match(/([1-5]\.[0-9])\s*(?:つ星|★)/);
                    if (ratingMatch) {
                        rating = parseFloat(ratingMatch[1]);
                    }
                } catch (e) {
                    // 失敗しても続行
                }
            }

            if (rating > 0 || reviews > 0) {
                console.log(`  評価/レビュー (詳細ページ): ${rating} / ${reviews}件`);
            }
        } catch (e) {
            // 評価/レビュー数の取得に失敗しても続行
        }

        // 住所の抽出
        let address = '';
        try {
            const addrBtn = this.page.locator('button[data-item-id="address"]');
            const count = await addrBtn.count();

            if (count > 0) {
                const ariaLabel = await addrBtn.first().getAttribute('aria-label', { timeout: 5000 });
                if (ariaLabel) {
                    address = ariaLabel.replace('住所: ', '').trim();
                    console.log(`  住所: ${address.substring(0, 50)}...`);
                }
            } else {
                console.log('  住所: 取得できませんでした');
            }
        } catch (e) {
            console.warn(`  住所の抽出でエラー: ${e.message}`);
        }

        // カテゴリの抽出
        let category = 'Unknown';
        try {
            // 複数の方法でカテゴリを取得
            const catBtn = this.page.locator('button[jsaction*="category"]').first();
            const count = await catBtn.count();

            if (count > 0) {
                const text = await catBtn.innerText({ timeout: 5000 });
                if (text) {
                    category = text.trim();
                    console.log(`  カテゴリ: ${category}`);
                }
            } else {
                // フォールバック: 他のセレクタを試す
                try {
                    const altCat = this.page.locator('[jsaction*="pane.rating.category"]').first();
                    if (await altCat.count() > 0) {
                        const text = await altCat.innerText({ timeout: 3000 });
                        if (text) category = text.trim();
                    }
                } catch (e2) {
                    console.log('  カテゴリ: 取得できませんでした');
                }
            }
        } catch (e) {
            console.warn(`  カテゴリの抽出でエラー: ${e.message}`);
        }

        // 予算の抽出
        let budget = '';
        try {
            const allText = await this.page.evaluate(() => document.body.innerText);
            const lines = allText.split('\n');
            for (const line of lines) {
                // 「1 人あたり ￥X～Y」または「￥X～Y,000」のようなパターン
                if (line.includes('￥') || line.includes('¥')) {
                    // 「1 人あたり」を含む行を優先
                    if (line.includes('1 人あたり')) {
                        const match = line.match(/￥[0-9,]+～[0-9,]+|¥[0-9,]+～[0-9,]+/);
                        if (match) {
                            budget = match[0];
                            break;
                        }
                    }
                    // フォールバック: ￥X～Yのパターン
                    if (!budget) {
                        const match = line.match(/￥[0-9,]+～[0-9,]+|¥[0-9,]+～[0-9,]+/);
                        if (match) {
                            budget = match[0];
                        }
                    }
                }
            }
            if (budget) {
                console.log(`  予算: ${budget}`);
            }
        } catch (e) {
            // 予算取得に失敗しても続行
        }

        // 営業時間の抽出
        let businessHours = '';
        try {
            // 方法1: 各曜日のaria-labelから取得
            const weekdays = ['月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日', '日曜日'];
            const hoursData = [];

            for (const day of weekdays) {
                try {
                    const dayElement = this.page.locator(`[aria-label*="${day}"]`).first();
                    if (await dayElement.count() > 0) {
                        const ariaLabel = await dayElement.getAttribute('aria-label', { timeout: 1000 });
                        if (ariaLabel && ariaLabel.includes('時')) {
                            // 「月曜日、8時00分～20時00分」のようなパターンから時間を抽出
                            const timeMatch = ariaLabel.match(/([0-9]+時[0-9]+分)～([0-9]+時[0-9]+分)/);
                            if (timeMatch) {
                                hoursData.push({ day: day.replace('曜日', ''), hours: `${timeMatch[1]}～${timeMatch[2]}` });
                            }
                        }
                    }
                } catch (e) {
                    // 特定の曜日で失敗しても続行
                }
            }

            if (hoursData.length > 0) {
                // 同じ時間帯をグループ化
                const hoursMap = new Map();
                for (const { day, hours } of hoursData) {
                    if (!hoursMap.has(hours)) {
                        hoursMap.set(hours, []);
                    }
                    hoursMap.get(hours).push(day);
                }

                // フォーマット: 「月-金: 8時00分～20時00分, 土日: 10時30分～18時00分」
                const parts = [];
                for (const [hours, days] of hoursMap) {
                    parts.push(`${days.join('')}: ${hours}`);
                }
                businessHours = parts.join(' / ');
            }

            // 方法2: 営業時間が取得できなかった場合、シンプルな表示を試す
            if (!businessHours) {
                const simpleHours = await this.page.evaluate(() => {
                    const text = document.body.innerText;
                    const lines = text.split('\n');
                    for (const line of lines) {
                        if (line.includes('営業') && (line.includes(':00') || line.includes('時'))) {
                            return line.substring(0, 100);
                        }
                    }
                    return '';
                });
                if (simpleHours) {
                    businessHours = simpleHours;
                }
            }

            if (businessHours) {
                console.log(`  営業時間: ${businessHours.substring(0, 50)}...`);
            }
        } catch (e) {
            // 営業時間取得に失敗しても続行
        }

        return {
            address: address || '',
            category: category || 'Unknown',
            budget: budget || '',
            businessHours: businessHours || '',
            detailRating: rating,
            detailReviews: reviews
        };
    }

    /**
     * 指定されたページで詳細情報を取得（並列処理用・高速版）
     */
    async getDetailsWithPage(page, url) {
        // ページ遷移
        try {
            await page.goto(url, {
                waitUntil: 'domcontentloaded',  // loadより高速
                timeout: this.navigationTimeout
            });
        } catch (e) {
            // リトライ1回
            await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: this.navigationTimeout
            });
        }

        // 待機時間を短縮（3000ms → 1500ms）
        await page.waitForTimeout(1500);

        let rating = 0;
        let reviews = 0;
        let address = '';
        let category = 'Unknown';
        let budget = '';
        let businessHours = '';

        try {
            // 一括でページテキストを取得（複数回のevaluate呼び出しを削減）
            const pageData = await page.evaluate(() => {
                const text = document.body.innerText;
                const lines = text.split('\n');

                // 住所ボタン
                const addrBtn = document.querySelector('button[data-item-id="address"]');
                const addressLabel = addrBtn ? addrBtn.getAttribute('aria-label') : '';

                // 評価
                const ratingEl = document.querySelector('[role="img"][aria-label*="つ星"]');
                const ratingLabel = ratingEl ? ratingEl.getAttribute('aria-label') : '';

                // カテゴリボタン
                const catBtn = document.querySelector('button[jsaction*="category"]');
                const categoryText = catBtn ? catBtn.innerText : '';

                return { text, lines, addressLabel, ratingLabel, categoryText };
            });

            // 住所
            if (pageData.addressLabel) {
                address = pageData.addressLabel.replace('住所: ', '').trim();
            }

            // 評価
            const ratingMatch = pageData.ratingLabel?.match(/([0-9]\.[0-9])/);
            if (ratingMatch) {
                rating = parseFloat(ratingMatch[1]);
            }

            // カテゴリ
            if (pageData.categoryText) {
                category = pageData.categoryText.trim();
            }

            // レビュー数
            for (const line of pageData.lines) {
                if (line.includes('件のクチコミ') && !line.includes('ローカルガイド')) {
                    const match = line.match(/([0-9,]+)\s*件のクチコミ/);
                    if (match) {
                        reviews = parseInt(match[1].replace(/,/g, ''));
                        break;
                    }
                }
            }

            // 予算
            for (const line of pageData.lines) {
                if (line.includes('￥') || line.includes('¥')) {
                    if (line.includes('1 人あたり')) {
                        const match = line.match(/￥[0-9,]+～[0-9,]+|¥[0-9,]+～[0-9,]+/);
                        if (match) {
                            budget = match[0];
                            break;
                        }
                    }
                    if (!budget) {
                        const match = line.match(/￥[0-9,]+～[0-9,]+|¥[0-9,]+～[0-9,]+/);
                        if (match) {
                            budget = match[0];
                        }
                    }
                }
            }

            // 営業時間（簡易版）
            for (const line of pageData.lines) {
                if (line.includes('営業') && (line.includes(':00') || line.includes('時'))) {
                    businessHours = line.substring(0, 100);
                    break;
                }
            }

        } catch (e) {
            // エラーでも部分的なデータを返す
        }

        return {
            address: address || '',
            category: category || 'Unknown',
            budget: budget || '',
            businessHours: businessHours || '',
            detailRating: rating,
            detailReviews: reviews
        };
    }
}

module.exports = { GoogleMapScraper };
