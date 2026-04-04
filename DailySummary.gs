/**
 * DailySummary.gs — YAMATO AI Bot 日次サマリー
 *
 * 設定方法:
 *   1. Google Apps Script エディタで新規スクリプトを作成
 *   2. このコードを貼り付け
 *   3. 定数（SPREADSHEET_ID, SLACK_WEBHOOK_URL）を設定
 *   4. トリガーを設定: 実行関数=sendDailySummary, 時間主導型=毎日21:00
 *
 * 概要:
 *   - 毎日21:00 JST に各Sheetsシートから当日データを集計
 *   - Slack の #yamato-ops（または任意のチャンネル）に日次レポートを投稿
 */

// ── 設定（要変更） ──
const SPREADSHEET_ID   = 'YOUR_SPREADSHEET_ID'; // Google SheetsのID
const SLACK_WEBHOOK_URL = 'YOUR_SLACK_WEBHOOK_URL'; // Slack Incoming Webhook URL

// Gemini APIキー: GASエディタ > プロジェクト設定 > スクリプトプロパティ に
// キー名 "GEMINI_API_KEY" で設定することを推奨（コードに直書きしない）
function getGeminiApiKey() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '';
}

// シート名（index.js と合わせること）
const SHEET = {
  ATTEND:   '出退勤',
  FACILITY: '設備不具合',
  CHARGE:   '課金',
  LOST:     '忘れ物',
  INVENTORY:'在庫',
};

// ── メイン: 日次サマリー送信 ──
function sendDailySummary() {
  const today = getTodayStr();
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);

  // 各シートからデータ取得
  const attendance  = getTodayRows(ss, SHEET.ATTEND,   '日付', today);
  const facilities  = getTodayRows(ss, SHEET.FACILITY,  '報告日時', today);
  const charges     = getTodayRows(ss, SHEET.CHARGE,    '報告日時', today);
  const lostItems   = getTodayRows(ss, SHEET.LOST,      '報告日時', today);
  const inventories = getTodayRows(ss, SHEET.INVENTORY, '報告日時', today);

  // サマリーテキスト構築
  const lines = [];
  lines.push(`📊 *日次レポート* | ${today}（${getDayOfWeek()}）`);
  lines.push('━━━━━━━━━━━━━━━━━━');

  // 出退勤
  lines.push('\n👥 *出勤スタッフ*');
  if (attendance.length === 0) {
    lines.push('  記録なし');
  } else {
    const clockIns  = attendance.filter(r => r['種別'] === 'clock_in');
    const clockOuts = attendance.filter(r => r['種別'] === 'clock_out');
    const names     = [...new Set(clockIns.map(r => r['スタッフ名']))];
    if (names.length > 0) {
      lines.push(`  ${names.join('、')} (${names.length}名)`);
    }
    // 退勤済チェック
    const notOut = names.filter(n => !clockOuts.some(r => r['スタッフ名'] === n));
    if (notOut.length > 0) {
      lines.push(`  ⚠️ 退勤記録なし: ${notOut.join('、')}`);
    }
  }

  // 設備不具合
  lines.push('\n🔧 *設備不具合*');
  if (facilities.length === 0) {
    lines.push('  本日の報告なし ✅');
  } else {
    facilities.forEach(r => {
      const urgEmoji = r['緊急度'] === 'critical' ? '🔴' :
                       r['緊急度'] === 'high'     ? '🟠' : '🟡';
      lines.push(`  ${urgEmoji} ${r['対象設備']} — ${r['症状'] || '詳細不明'} (${r['ステータス']})`);
    });
    // 未解決件数
    const openCount = facilities.filter(r => r['ステータス'] === 'open').length;
    if (openCount > 0) lines.push(`  📌 未解決: ${openCount}件`);
  }

  // 課金
  lines.push('\n💰 *課金集計*');
  if (charges.length === 0) {
    lines.push('  本日の課金なし');
  } else {
    // 品目別に集計
    const summary = {};
    charges.forEach(r => {
      const item = r['品目'] || '不明';
      const qty  = Number(r['数量']) || 0;
      const isCorrection = r['修正フラグ'] === 'TRUE';
      if (!summary[item]) summary[item] = 0;
      summary[item] += isCorrection ? -qty : qty;
    });
    Object.entries(summary).forEach(([item, qty]) => {
      if (qty > 0) lines.push(`  • ${item}: ${qty}個`);
    });
  }

  // 忘れ物
  lines.push('\n🔍 *忘れ物*');
  if (lostItems.length === 0) {
    lines.push('  本日の報告なし ✅');
  } else {
    lostItems.forEach(r => {
      lines.push(`  • ${r['品目']} (${r['ステータス']}) — ${r['報告者']}`);
    });
  }

  // 在庫アラート
  lines.push('\n📦 *在庫アラート*');
  if (inventories.length === 0) {
    lines.push('  本日のアラートなし ✅');
  } else {
    inventories.forEach(r => {
      const exp = r['賞味期限'] ? ` ⚠️ 期限: ${r['賞味期限']}` : '';
      lines.push(`  • ${r['品目']}: 残${r['残数']}${r['単位']}${exp}`);
    });
  }

  lines.push('\n━━━━━━━━━━━━━━━━━━');

  // AI総評（Gemini）
  const rawData = { attendance, facilities, charges, lostItems, inventories, date: today };
  const aiSummary = generateAiSummary(rawData, today);
  if (aiSummary) {
    lines.push('\n🤖 *AI総評*');
    lines.push(aiSummary);
    lines.push('━━━━━━━━━━━━━━━━━━');
  }

  lines.push(`_集計時刻: ${getJstTimestamp()} | YAMATO AI Bot v3.1_`);

  const text = lines.join('\n');

  // Slack 送信
  const response = UrlFetchApp.fetch(SLACK_WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text }),
  });

  Logger.log(`Slack 送信結果: ${response.getResponseCode()}`);
}

// ── ヘルパー: 当日の行を取得 ──
function getTodayRows(ss, sheetName, dateColumn, today) {
  try {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      Logger.log(`シートが見つかりません: ${sheetName}`);
      return [];
    }

    const data    = sheet.getDataRange().getValues();
    if (data.length < 2) return [];

    const headers = data[0];
    const dateIdx = headers.indexOf(dateColumn);
    if (dateIdx === -1) return [];

    const rows = [];
    for (let i = 1; i < data.length; i++) {
      const row     = data[i];
      const cellVal = String(row[dateIdx] || '');
      // 日付部分だけ一致確認（datetime列は "YYYY-MM-DD HH:MM:SS" なのでstartsWith）
      if (cellVal.startsWith(today)) {
        const obj = {};
        headers.forEach((h, idx) => { obj[h] = row[idx]; });
        rows.push(obj);
      }
    }
    return rows;
  } catch (e) {
    Logger.log(`getTodayRows エラー (${sheetName}): ${e.message}`);
    return [];
  }
}

// ── ヘルパー: 今日の日付文字列 (YYYY-MM-DD, JST) ──
function getTodayStr() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

// ── ヘルパー: 曜日 ──
function getDayOfWeek() {
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return days[d.getUTCDay()];
}

// ── ヘルパー: JSTタイムスタンプ ──
function getJstTimestamp() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd HH:mm');
}

// ── AI総評: Gemini で自然言語サマリー生成 ──
function generateAiSummary(rawData, today) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    Logger.log('GEMINI_API_KEY が未設定のためAI総評をスキップ');
    return '';
  }

  // 集計データを要約してプロンプト作成
  const attendance  = rawData.attendance  || [];
  const facilities  = rawData.facilities  || [];
  const charges     = rawData.charges     || [];
  const lostItems   = rawData.lostItems   || [];
  const inventories = rawData.inventories || [];

  const summary = {
    date: today,
    staff_count: new Set(attendance.filter(r => r['種別'] === 'clock_in').map(r => r['スタッフ名'])).size,
    no_clockout: attendance
      .filter(r => r['種別'] === 'clock_in')
      .map(r => r['スタッフ名'])
      .filter(n => !attendance.some(r => r['種別'] === 'clock_out' && r['スタッフ名'] === n)),
    facility_issues: facilities.map(r => ({
      equipment: r['対象設備'], urgency: r['緊急度'], status: r['ステータス']
    })),
    open_facility_count: facilities.filter(r => r['ステータス'] === 'open').length,
    charges: charges.map(r => ({ item: r['品目'], qty: r['数量'] })),
    lost_items: lostItems.map(r => ({ item: r['品目'], status: r['ステータス'] })),
    inventory_alerts: inventories.map(r => ({ item: r['品目'], remaining: r['残数'], unit: r['単位'] })),
  };

  const prompt = `あなたは宿泊施設運営の日次レポートアシスタントです。\n以下の${today}の運営データをもとに、日本語で自然な日次総評を150字以内で作成してください。\n特に重要な問題・未対応リスク・翌日への申し送り事項を優先して強調してください。データ:\n${JSON.stringify(summary, null, 0)}`;

  try {
    const res = UrlFetchApp.fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 300 },
        }),
        muteHttpExceptions: true,
      }
    );
    const data = JSON.parse(res.getContentText());
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (e) {
    Logger.log(`generateAiSummary エラー: ${e.message}`);
    return '';
  }
}

// ── 手動テスト用（GASエディタから直接実行してSlack通知をテスト） ──
function testDailySummary() {
  sendDailySummary();
}
