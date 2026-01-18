# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Google Map Exporter is a Node.js tool that scrapes Google Maps search results and exports them to CSV. It provides both a Web UI (primary) and CLI interface. The tool searches for places matching a keyword near a specified address, with extensive filtering options for rating, review count, category, budget, business hours, and more.

**Important**: This tool uses web scraping via Playwright. Google Maps UI changes frequently, so selectors may break. Excessive usage may trigger IP blocks or CAPTCHA. Use responsibly for personal purposes only.

## Running the Tool

### Web UI (Recommended)
```bash
npm start
```
This starts a web server at http://localhost:3000 and automatically opens the browser.

### CLI Version
```bash
node index.js --address "新宿駅" --keyword "ラーメン" --rating 4.0 --rating-op gte --count 100 --count-op gte --output results.csv --headless
```

### Command Line Options
- `-a, --address <string>` (required): Center point address for search
- `-k, --keyword <string>` (required): Search keyword/category (e.g., "レストラン", "居酒屋", "ホテル")
- `-r, --rating <number>`: Rating filter value
- `--rating-op <op>`: Rating filter operator: `gte` (>=, 以上) or `lte` (<=, 以下). Default: `gte`
- `-c, --count <number>`: Review count filter value
- `--count-op <op>`: Review count filter operator: `gte` (>=) or `lte` (<=). Default: `gte`
- `-o, --output <string>`: Output CSV filename (default: "output.csv")
- `--headless`: Run browser in headless mode (default: false, shows browser window)

### Installation
```bash
npm install
```
Chromium is automatically installed via Playwright during npm install.

## Architecture

### Module Structure

1. **server.js** - Web server (Express + Socket.IO)
   - Serves the Web UI from `public/` directory
   - Handles `/api/scrape` endpoint for search requests
   - Real-time progress updates via Socket.IO
   - Auto-opens browser on startup

2. **index.js** - CLI controller
   - Parses CLI arguments using `commander`
   - Orchestrates scraping and export flow for command-line usage
   - Handles error logging and cleanup

3. **scraper.js** - Web scraping engine
   - `GoogleMapScraper` class manages Playwright browser automation
   - Configured with Japanese locale (`ja-JP`)
   - Search flow:
     1. Navigate to Google Maps (Japanese version)
     2. Search for "[address] [keyword]" combined query
     3. Auto-scroll the feed to load more results (with network idle detection)
     4. Extract basic info (name, rating, reviews, category, budget, URL) from list items
     5. **Pre-filter** by rating, review count, category, and budget
     6. Visit each qualifying place's detail page to extract address, business hours, and reviews
     7. **Post-filter** by rating (re-check), review count (re-check), address, business days, and business hours

4. **csvExporter.js** - CSV output handler
   - `CsvExporter` class wraps `csv-writer` library
   - Output columns (all in Japanese):
     - 店名 (name)
     - カテゴリ (category)
     - 評価 (rating)
     - 評価件数 (review count)
     - 予算 (budget)
     - 営業時間 (business hours)
     - 住所 (address)
     - 口コミ (review with star rating)
     - URL

5. **public/** - Web UI
   - `index.html` - Form with search and filter options
   - `app.js` - Client-side logic, Socket.IO communication
   - `style.css` - Styling

### Key Implementation Details

**Two-Phase Filtering**:
- **Pre-filtering** (fast, at list extraction stage):
  - Rating (gte/lte), review count (gte/lte), category, budget
  - Applied before visiting detail pages, saves time
- **Post-filtering** (after detail fetch, in `checkFilters()`):
  - Rating (re-check with detail page data)
  - Review count (re-check with detail page data)
  - Address (contains), business days, business hours
  - Re-checking rating/reviews is important because list extraction may fail to get accurate values

**Rating/Review Filter Operators**:
- Both rating and review count support `gte` (>=, 以上) and `lte` (<=, 以下) operators
- Example: `rating=3, ratingOp=lte` means "3 or less" (評価3以下)
- Example: `reviewCount=100, reviewCountOp=gte` means "100 or more reviews" (100件以上)

**Business Hours Filtering**:
- Supports midnight-spanning times (e.g., 18:00～5:00)
- Logic: if close < open, treats as spanning midnight and uses OR condition

**Scraping Strategy**:
- The scraper uses Playwright's locator API with role-based selectors where possible
- Main extraction happens in two phases:
  1. `extractBasicList()`: Parse the search results feed using `a[href*="/maps/place/"]` links, extract name, rating, reviews, category, budget, review text
  2. `getDetailsWithPage()`: Navigate to individual place URLs to scrape address, business hours (parallel processing with multiple tabs)
- Scrolling uses `evaluate()` to scroll the feed element directly
- Deduplication by URL to avoid duplicate entries
- Store name extracted from aria-label attribute for accuracy

**Error Handling and Retry Logic**:
- Automatic retry with exponential backoff for transient failures
- Configurable retry settings in `GoogleMapScraper`:
  - `maxRetries`: 3 attempts by default
  - `retryDelay`: 2000ms base delay (multiplied by attempt number)
  - `navigationTimeout`: 60 seconds for page navigation
  - `elementTimeout`: 20 seconds for element waiting
- Retry wrapper (`retryOperation()`) handles:
  - Google Maps navigation
  - Address search operations
  - Fallback search queries
  - Detail page navigation (limited to 2 retries)
- Graceful degradation: Partial failures don't halt execution
  - Individual detail extraction errors are logged but allow the process to continue
  - Missing data fields (address, AI summary, category) default to empty strings
  - Failed detail fetches save partial data with basic info
- Progress tracking with success/fail counters during detail extraction
- Partial results are saved even if errors occur mid-scraping

**Locale-Specific Elements**:
- All Google Maps interactions expect Japanese UI (buttons like "付近を検索", "AI による概要")
- If modifying selectors, test with Japanese Google Maps interface
- Address extraction looks for `button[data-item-id="address"]` with aria-label containing "住所: "

**Fragile Selectors**:
- Google Maps UI changes frequently - the following are most likely to break:
  - "付近を検索" button selector
  - AI summary extraction (searches for "AI による概要" text)
  - Category button selector (`button[jsaction*="category"]`)
  - Feed scrolling and list item structure

**Auto-Scroll Behavior**:
- Scrolls until "リストの最後に到達しました" (end of list) is detected
- Uses network idle detection: waits for 2 seconds of no network requests after each scroll
- Additional 5-second wait after network idle before next scroll
- Maximum 100 scroll attempts as a safety limit
- Early termination if item count doesn't change for 2 consecutive attempts
- Supports `maxItems` parameter to limit the number of items to fetch

**Performance Considerations**:
- Parallel detail page processing using multiple browser tabs (up to 5 tabs)
- 300ms delay between batch processing to avoid rate limiting
- Headless mode runs faster but non-headless is better for debugging

**Hidden Debug Mode (Web UI)**:
- Press `Ctrl+Shift+D` to toggle debug mode
- Shows a "DEV" checkbox that enables browser window display during scraping

## Common Issues

**"Nearby" button not found**: The scraper has a fallback that searches "[keyword] [address]" directly. This happens when the address search doesn't show a single exact result. The retry logic will attempt this fallback automatically.

**Empty results**: Likely causes:
- Google Maps UI has changed (check browser console if running non-headless)
- Feed didn't load within timeout (increase timeout in `feed.waitFor()`)
- All results filtered out by rating/review thresholds
- Network connectivity issues (retry logic will attempt to recover)

**Partial data in results**: Some fields (address, AI summary, category) may be empty if:
- Elements not found on detail page (e.g., no AI summary available for that place)
- Detail page failed to load after retries
- Selectors have changed due to Google Maps UI updates
This is expected behavior - the scraper saves what it can extract

**CSV encoding issues**: Output uses UTF-8. If opening in Excel, ensure proper import settings or the file may need UTF-8 BOM.

**Scraper hangs**: Usually waiting for an element that never appears due to UI changes. The built-in timeouts will eventually fail the operation and retry. Run with `--headless` flag removed to observe browser behavior.

**Rate limiting or IP blocks**: If you see repeated failures:
- Increase delays between requests by modifying `waitForTimeout()` values in scraper.js
- Run with `--headless` flag removed to see if CAPTCHA is appearing
- Reduce the number of places being scraped in a single run
- Wait before running again

## Development Notes

- No test suite currently - verification is manual
- Dependencies: `playwright`, `csv-writer`, `commander`, `express`, `socket.io`
- The `仕様/` directory contains Japanese specification and planning documents
- Browser automation uses Chromium (installed via Playwright)
