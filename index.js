const { program } = require('commander');
const { GoogleMapScraper } = require('./scraper');
const { CsvExporter } = require('./csvExporter');

program
    .requiredOption('-a, --address <string>', 'Searching center address')
    .requiredOption('-k, --keyword <string>', 'Search keyword (category)')
    .option('-r, --rating <number>', 'Minimum rating', parseFloat, 0)
    .option('--rating-max <number>', 'Maximum rating', parseFloat)
    .option('-c, --count <number>', 'Minimum review count', parseInt, 0)
    .option('--count-max <number>', 'Maximum review count', parseInt)
    .option('-o, --output <string>', 'Output CSV filename', 'output.csv')
    .option('--headless', 'Run in headless mode', false)
    .parse(process.argv);

const options = program.opts();

(async () => {
    console.log('='.repeat(60));
    console.log('Google Map Exporter を起動しています...');
    console.log('='.repeat(60));
    console.log(`検索条件:`);
    console.log(`  住所: ${options.address}`);
    console.log(`  キーワード: ${options.keyword}`);
    console.log(`  評価: ${options.rating}以上${options.ratingMax ? ` ～ ${options.ratingMax}以下` : ''}`);
    console.log(`  レビュー数: ${options.count}件以上${options.countMax ? ` ～ ${options.countMax}件以下` : ''}`);
    console.log(`  出力ファイル: ${options.output}`);
    console.log(`  ヘッドレスモード: ${options.headless ? '有効' : '無効'}`);
    console.log('='.repeat(60));

    const scraper = new GoogleMapScraper(options.headless);
    const exporter = new CsvExporter(options.output);
    let results = [];

    try {
        // ブラウザの初期化
        await scraper.initialize();

        // 検索実行
        console.log('\n検索を開始します...\n');
        results = await scraper.search(
            options.address,
            options.keyword,
            options.rating,
            options.ratingMax || null,
            options.count,
            options.countMax || null
        );

        console.log('\n' + '='.repeat(60));
        console.log(`検索完了: ${results.length}件の店舗が見つかりました`);
        console.log('='.repeat(60));

        // 結果の保存
        if (results.length > 0) {
            console.log(`\nCSVファイルに保存中: ${options.output}`);
            await exporter.writeRecords(results);
            console.log('✓ 保存完了!');
        } else {
            console.log('\n保存する結果がありません。');
            console.log('検索条件を変更してみてください。');
        }

    } catch (error) {
        console.error('\n' + '!'.repeat(60));
        console.error('エラーが発生しました:');
        console.error('!'.repeat(60));
        console.error(`エラー内容: ${error.message}`);

        if (error.stack) {
            console.error('\nスタックトレース:');
            console.error(error.stack);
        }

        // 部分的な結果がある場合は保存を試みる
        if (results.length > 0) {
            console.log(`\n部分的な結果(${results.length}件)を保存しています...`);
            try {
                await exporter.writeRecords(results);
                console.log('✓ 部分的な結果を保存しました');
            } catch (saveError) {
                console.error('✗ 結果の保存に失敗しました:', saveError.message);
            }
        }

        process.exit(1);

    } finally {
        console.log('\nクリーンアップ中...');
        await scraper.close();
        console.log('プログラムを終了します。');
    }
})();
