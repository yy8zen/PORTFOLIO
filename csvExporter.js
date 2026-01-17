const { createObjectCsvWriter } = require('csv-writer');

class CsvExporter {
  constructor(filename) {
    this.filename = filename;

    try {
      this.writer = createObjectCsvWriter({
        path: filename,
        header: [
          { id: 'name', title: '店名' },
          { id: 'category', title: 'カテゴリ' },
          { id: 'rating', title: '評価' },
          { id: 'reviews', title: '評価件数' },
          { id: 'budget', title: '予算' },
          { id: 'businessHours', title: '営業時間' },
          { id: 'address', title: '住所' },
          { id: 'review', title: '口コミ' },
          { id: 'url', title: 'URL' }
        ],
        encoding: 'utf8',
        append: false
      });
    } catch (error) {
      throw new Error(`CSVライター初期化エラー: ${error.message}`);
    }
  }

  async writeRecords(records) {
    if (!records || records.length === 0) {
      console.warn('警告: 保存するレコードがありません');
      return;
    }

    try {
      console.log(`${records.length}件のレコードをCSVに書き込み中...`);

      // データの検証とサニタイズ
      const sanitizedRecords = records.map((record, index) => {
        try {
          return {
            name: record.name || 'Unknown',
            category: record.category || 'Unknown',
            rating: record.rating || 0,
            reviews: record.reviews || 0,
            budget: record.budget || '',
            businessHours: record.businessHours || '',
            address: record.address || '',
            review: record.review || '',
            url: record.url || ''
          };
        } catch (error) {
          console.warn(`レコード ${index + 1} のサニタイズでエラー: ${error.message}`);
          return {
            name: 'Error',
            category: 'Error',
            rating: 0,
            reviews: 0,
            budget: '',
            businessHours: '',
            address: '',
            review: '',
            url: ''
          };
        }
      });

      await this.writer.writeRecords(sanitizedRecords);
      console.log(`CSVファイルを保存しました: ${this.filename}`);
      console.log(`保存されたレコード数: ${sanitizedRecords.length}件`);

    } catch (error) {
      console.error('CSV書き込みエラー:', error.message);
      throw new Error(`CSVファイルへの書き込みに失敗しました: ${error.message}`);
    }
  }
}

module.exports = { CsvExporter };
