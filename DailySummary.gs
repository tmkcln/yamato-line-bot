/**
 * DailySummary.gs — YAMATO AI Bot 日次サマリー v3.0
 *
 * 設定方法:
 *   1. Google Apps Script エディタで新規スクリプトを作成
 *   2. このコードを貼り付け
 *   3. SPREADSHEET_ID, SLACK_WEBHOOK_URL を設定
 *   4. スクリプトプロパティに GEMINI_API_KEY を設定
 *   5. トリガー: sendDailySummary / 時間主導型 / 毎日 21:00
 *
 * 処理フロー（Pass 2+3）:
 *   1. メッセージログから当日テキストを取得
 *   2. NOISE除外 → 5分スレッドに分割
 *   3. スレッド単位でGeminiに一括分析（7カテゴリ / 要約 / アクション / 解決済みフラグ）
 *   4. THREAD_LOGシートに記録
 *   5. 全スレッド結果をGeminiに渡してストーリー形式サマリー生成
 *   6. Slackに送信
 */

// ── 設定（要変更） ──
const SPREADSHEET_ID    = 'YOUR_SPREADSHEET_ID';
const SLACK_WEBHOOK_URL = 'YOUR_SLACK_WEBHOOK_URL';
const GEMINI_MODEL      = 'gemini-2.5-flash';

function getGeminiApiKey() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '';
}

// シート名
const SHEET = {
  LOG:        'メッセージログ',
  THREAD_LOG: 'スレッドログ',
};

// NOISE正規表現（index.jsと同一）
// 「はい、」（読点付き）は削除: 読点は文が続く証拠。後続内容を見ずに除外すると重要情報を失う
// .{0,8} に短縮: 「でした！」「ます。」程度のみ許容
// [^、]{0,8}: suffix に読点(、)を含まず最大8文字。読点があれば文が続く→通過させる
const NOISE_REGEX_STR = '^(お疲れ様|おつかれ様|お疲れ様です|おつかれさまです|おつかれ|承知しました|承知いたしました|承知です|かしこまりました|かしこまりです|ありがとうございます|ありがとうございました|ご対応ありがとう|了解です|了解しました|了解いたしました|わかりました|はーい|よろしくお願いします)[^、]{0,8}$';

// スレッド分割の閾値（分）
const THREAD_GAP_MIN = 5;

// ── スレッド分析用 Gemini プロンプト ──
const THREAD_SYSTEM_PROMPT = `あなたは日本の宿泊施設（民泊・バケーションレンタル）の現場LINEグループを分析するAIです。

以下の会話スレッドを分析し、JSONのみで返してください。説明文・前置き・補足は一切不要です。

## 出力スキーマ（JSONのみ）
{"main_category":"カテゴリ","summary":"50字以内の要約","action_item":"対応が必要なタスク（なければnull）","is_resolved":true/false/null}

## カテゴリ定義（1つだけ選択）
- ISSUE_REPORT: 設備の故障・破損・不具合・ゲストクレーム（対応が必要な問題）
- OPERATION_REPORT: 清掃開始/完了・修繕完了・チェックリスト・設備調整完了報告
- GUEST_LOGISTICS: チェックイン/アウト・ゲスト対応・忘れ物・問い合わせ
- REVENUE_CHARGE: 有料ドリンク・BBQ・サウナ等の課金報告
- INVENTORY_ORDER: 備品在庫報告・発注依頼・納品確認
- INTERNAL_COORDINATION: スタッフ間の確認・依頼・シフト調整・質問
- ATTENDANCE: 業務開始/終了・シフト報告（出退勤のみ）

## is_resolved の判定
- true: 問題が提起され、この会話内で解決・完了が確認できる
- false: 問題が提起されたが未解決・未確認
- null: 問題提起がなく解決の概念が適用されない（単純な報告）`;

// ── ストーリーサマリー用プロンプト ──
const STORY_SYSTEM_PROMPT = `あなたは優秀な宿泊施設オペレーションマネージャーです。
以下の1日の業務報告ログを元に、Slackに送る日次サマリーを作成してください。

形式:
- Slack Markdown（*太字*, _斜体_, 絵文字OK）
- 必ず「今日のハイライト」「業務サマリー」「要対応事項」の3セクションで構成
- 200文字以内でコンパクトに。箇条書きを使うこと
- action_itemがあるものは「要対応事項」に必ず含める
- is_resolved=falseのものは未解決として強調する
- ATTENDANCE（出退勤）はサマリーに含めない`;

// ── メイン ──
function sendDailySummary() {
  const today = getTodayStr();
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);

  // Step 1: 当日のメッセージ取得
  const messages = getLogMessages(ss, today);
  if (messages.length === 0) {
    Logger.log(`[DailySummary] ${today} はメッセージなし。スキップ。`);
    return;
  }
  Logger.log(`[DailySummary] ${today} のメッセージ: ${messages.length}件`);

  // Step 2: スレッド分割
  const threads = buildThreads(messages);
  Logger.log(`[DailySummary] スレッド数: ${threads.length}`);

  // Step 3: 各スレッドをGeminiで分析
  const analyzedThreads = [];
  for (let i = 0; i < threads.length; i++) {
    const result = analyzeThread(threads[i], i + 1);
    analyzedThreads.push(result);
    Utilities.sleep(500); // レート制限対策
  }

  // Step 4: THREAD_LOGに記録
  writeThreadLog(ss, analyzedThreads, today);

  // Step 5: ストーリーサマリー生成
  const storyText = generateStorySummary(analyzedThreads, today);

  // Step 6: Slack送信
  const header = `📊 *日次レポート* | ${today}（${getDayOfWeek()}）\n施設: ${getFacilityName(messages)}\n━━━━━━━━━━━━━━━━━━\n`;
  const footer = `\n━━━━━━━━━━━━━━━━━━\n_集計時刻: ${getJstTimestamp()} | YAMATO AI Bot v4.0 | スレッド${analyzedThreads.length}件分析_`;

  const payload = header + storyText + footer;
  const res = UrlFetchApp.fetch(SLACK_WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: payload }),
    muteHttpExceptions: true,
  });
  Logger.log(`Slack送信: ${res.getResponseCode()}`);
}

// ── Step 1: メッセージログ取得 ──
function getLogMessages(ss, today) {
  const sheet = ss.getSheetByName(SHEET.LOG);
  if (!sheet) { Logger.log('メッセージログシートなし'); return []; }

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  // ヘッダー: 日時(0) グループID(1) グループ名(2) ユーザーID(3) 表示名(4) 種別(5) テキスト(6)
  const noiseRegex = new RegExp(NOISE_REGEX_STR, 'u');
  const rows = [];

  for (let i = 1; i < data.length; i++) {
    const dateStr = String(data[i][0] || '');
    if (!dateStr.startsWith(today)) continue;

    const type = String(data[i][5] || '');
    if (type !== 'text') continue;  // テキストのみ

    const text = String(data[i][6] || '').trim();
    if (!text) continue;
    if (noiseRegex.test(text)) continue;  // NOISE除外

    rows.push({
      time:     dateStr.substring(11, 16),  // "HH:MM"
      sender:   String(data[i][4] || ''),
      group:    String(data[i][2] || ''),
      text:     text,
    });
  }
  return rows;
}

// ── Step 2: スレッド分割（5分ウィンドウ） ──
function buildThreads(messages) {
  const threads = [];
  let current = null;

  for (const msg of messages) {
    const mins = timeToMinutes(msg.time);

    if (!current) {
      current = { startTime: msg.time, endTime: msg.time, messages: [msg] };
    } else {
      const prevMins = timeToMinutes(current.endTime);
      if (mins - prevMins > THREAD_GAP_MIN) {
        threads.push(current);
        current = { startTime: msg.time, endTime: msg.time, messages: [msg] };
      } else {
        current.endTime = msg.time;
        current.messages.push(msg);
      }
    }
  }
  if (current) threads.push(current);
  return threads;
}

// ── Step 3: Geminiでスレッド分析 ──
function analyzeThread(thread, idx) {
  const apiKey = getGeminiApiKey();
  const threadText = thread.messages.map(m => `[${m.time}] ${m.sender}: ${m.text}`).join('\n');

  const base = {
    thread_idx:  idx,
    start_time:  thread.startTime,
    end_time:    thread.endTime,
    msg_count:   thread.messages.length,
    raw_text:    threadText,
  };

  if (!apiKey) {
    return { ...base, main_category: 'UNKNOWN', summary: threadText.substring(0, 50), action_item: null, is_resolved: null };
  }

  try {
    const res = UrlFetchApp.fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          system_instruction: { parts: [{ text: THREAD_SYSTEM_PROMPT }] },
          contents: [{ parts: [{ text: `以下の会話スレッドを分析してください:\n\n${threadText}` }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 256,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
        muteHttpExceptions: true,
      }
    );

    const data = JSON.parse(res.getContentText());
    let raw = (data.candidates?.[0]?.content?.parts?.[0]?.text || '{}').trim();
    raw = raw.replace(/```json\n?|\n?```/g, '').trim();

    // JSONが不完全な場合は先頭の { から末尾の } を抽出
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) raw = m[0];

    const parsed = JSON.parse(raw);
    return { ...base, ...parsed };
  } catch (e) {
    Logger.log(`[analyzeThread] スレッド${idx} エラー: ${e.message}`);
    return { ...base, main_category: 'UNKNOWN', summary: '分析失敗', action_item: null, is_resolved: null };
  }
}

// ── Step 4: THREAD_LOGシートに記録 ──
function writeThreadLog(ss, threads, today) {
  let sheet = ss.getSheetByName(SHEET.THREAD_LOG);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET.THREAD_LOG);
    const headers = ['日付', '開始時刻', '終了時刻', 'メッセージ数', 'カテゴリ', '要約', 'アクション項目', '解決済み'];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    Logger.log('[INIT] スレッドログシート作成');
  }

  const rows = threads.map(t => [
    today,
    t.start_time   || '',
    t.end_time     || '',
    t.msg_count    || '',
    t.main_category || '',
    t.summary      || '',
    t.action_item  || '',
    t.is_resolved === true ? '解決済' : t.is_resolved === false ? '未解決' : '',
  ]);

  if (rows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    Logger.log(`[THREAD_LOG] ${rows.length}スレッド記録完了`);
  }
}

// ── Step 5: ストーリーサマリー生成 ──
function generateStorySummary(threads, today) {
  const apiKey = getGeminiApiKey();

  // ATTENDANCE以外のスレッドを対象（出退勤は省略）
  const relevant = threads.filter(t => t.main_category !== 'ATTENDANCE' && t.main_category !== 'UNKNOWN');

  if (relevant.length === 0) {
    return '本日の特記事項はありませんでした。';
  }

  const logData = relevant.map(t => ({
    time:         t.start_time,
    category:     t.main_category,
    summary:      t.summary,
    action_item:  t.action_item,
    is_resolved:  t.is_resolved,
  }));

  if (!apiKey) {
    // Gemini未設定時はシンプルなテキスト生成
    return relevant.map(t => `[${t.start_time}] ${t.main_category}: ${t.summary}`).join('\n');
  }

  try {
    const res = UrlFetchApp.fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          system_instruction: { parts: [{ text: STORY_SYSTEM_PROMPT }] },
          contents: [{ parts: [{ text: `${today}の業務ログ:\n${JSON.stringify(logData, null, 2)}` }] }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 600,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
        muteHttpExceptions: true,
      }
    );

    const data = JSON.parse(res.getContentText());
    return (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
  } catch (e) {
    Logger.log(`[generateStorySummary] エラー: ${e.message}`);
    return relevant.map(t => `[${t.start_time}] ${t.summary}`).join('\n');
  }
}

// ── ユーティリティ ──
function getTodayStr() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

function getDayOfWeek() {
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  return days[new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCDay()];
}

function getJstTimestamp() {
  return Utilities.formatDate(new Date(Date.now() + 9 * 60 * 60 * 1000), 'UTC', 'yyyy-MM-dd HH:mm');
}

function timeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function getFacilityName(messages) {
  // グループ名の最頻値を施設名とする
  const counts = {};
  for (const m of messages) {
    const g = m.group || '';
    if (g) counts[g] = (counts[g] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return entries.length > 0 ? entries[0][0] : '不明';
}

// ── 手動テスト用 ──
function testDailySummary() {
  sendDailySummary();
}
