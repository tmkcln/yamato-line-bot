/**
 * DailySummary.gs — YAMATO AI Bot 日次サマリー v4.1
 *
 * v4.1 変更点:
 *   - 全施設横断サマリー（親投稿）+ 施設別詳細（スレッド返信）
 *   - Slack Web API（chat.postMessage）に移行
 *   - メッセージを施設（グループ名）別にグループ化
 *
 * スクリプトプロパティ:
 *   GEMINI_API_KEY   — Gemini API キー
 *   SLACK_BOT_TOKEN  — Slack Bot User OAuth Token (xoxb-...)
 *   SLACK_CHANNEL_ID — 投稿先チャンネルID (C...)
 *
 * トリガー: sendDailySummary / 時間主導型 / 毎日 指定時刻
 */

// ── 設定 ──
const SPREADSHEET_ID = '1gK1xAgEp4jdwt3Q0fDMOlFOLw3US_s249vGIr2q1GOg';
const GEMINI_MODEL   = 'gemini-2.5-flash';

function getGeminiApiKey() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '';
}
function getSlackBotToken() {
  return PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN') || '';
}
function getSlackChannelId() {
  return PropertiesService.getScriptProperties().getProperty('SLACK_CHANNEL_ID') || '';
}

const SHEET = {
  LOG:        'メッセージログ',
  THREAD_LOG: 'スレッドログ',
  STAFF:      '本部スタッフ',
};

const THREAD_GAP_MIN = 5;

// ── Gemini プロンプト ──
const THREAD_SYSTEM_PROMPT = `あなたは日本の宿泊施設（民泊・バケーションレンタル）の現場LINEグループを分析するAIです。

以下の会話スレッドを分析し、JSONのみで返してください。説明文・前置き・補足は一切不要です。

## 出力スキーマ（JSONのみ）
{"main_category":"カテゴリ","direction":"HQ_TO_FIELD/FIELD_TO_HQ/FIELD_INTERNAL/OTHER","summary":"50字以内の要約","action_item":"対応が必要なタスク（なければnull）","is_resolved":true/false/null}

## direction の判定（本部スタッフリストが提供されている場合）
- HQ_TO_FIELD: 本部スタッフが現場に指示・連絡している
- FIELD_TO_HQ: 現場スタッフが本部に報告・相談している
- FIELD_INTERNAL: 現場スタッフ同士のやりとり
- OTHER: 判定不能

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

const CROSS_FACILITY_PROMPT = `あなたは複数の宿泊施設を統括するオペレーションマネージャーです。
以下の全施設の業務ログから、経営者が最優先で把握すべき情報だけを抽出してください。

形式:
- Slack Markdown（*太字*, _斜体_, 絵文字OK）
- 「🔴 要対応」「💬 本部への確認待ち」「📋 本日の動き」の3セクション
- 🔴 要対応: 未解決の問題・対応が必要なアクションのみ。なければ「なし」
- 💬 本部への確認待ち: direction=FIELD_TO_HQ かつ is_resolved=false のもの。なければ省略
- 📋 本日の動き: 施設名付きで主要な出来事を3-5件。出退勤は含めない
- 全体で250文字以内。箇条書き。施設名は【】で囲む`;

const FACILITY_SUMMARY_PROMPT = `あなたは宿泊施設のオペレーションマネージャーです。
以下の1施設の業務ログから、施設別の日次サマリーを作成してください。

## 絶対ルール
- Slack投稿です。#や##は使用禁止。見出しは *太字* のみ使用
- カテゴリ名は必ず日本語で表記（英語禁止）
- 絵文字は ⚠️（未解決）のみ使用。他の絵文字は不要
- 150文字以内

## フォーマット
*設備・清掃*
• 内容1
• ⚠️ 未解決の内容

*売上・課金*
• 内容

*ゲスト対応*
• 内容

## カテゴリの日本語名
- ISSUE_REPORT → 設備・不具合
- OPERATION_REPORT → 清掃・作業完了
- GUEST_LOGISTICS → ゲスト対応
- REVENUE_CHARGE → 売上・課金
- INVENTORY_ORDER → 在庫・発注
- INTERNAL_COORDINATION → 内部連携

## 注意
- 関連するカテゴリはまとめてよい（設備＋清掃 など）
- 該当ゼロのカテゴリは省略
- 出退勤は含めない`;

// ── メイン ──
function sendDailySummary() {
  const today = getTodayStr();
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);

  // Step 1: 当日の全メッセージ取得
  const messages = getLogMessages(ss, today);
  if (messages.length === 0) {
    Logger.log(`[DailySummary] ${today} はメッセージなし。スキップ。`);
    return;
  }
  Logger.log(`[DailySummary] ${today} のメッセージ: ${messages.length}件`);

  // Step 2: 施設別にグループ化
  const facilityGroups = groupByFacility(messages);
  const facilityNames = Object.keys(facilityGroups);
  Logger.log(`[DailySummary] 施設数: ${facilityNames.length} (${facilityNames.join(', ')})`);

  // Step 2b: 本部スタッフリスト取得（ユーザーID → 名前のMap）
  const hqStaff = getHqStaffList(ss);
  const hqStaffMap = new Map(hqStaff.map(s => [s.userId, s.name]));
  Logger.log(`[DailySummary] 本部スタッフ: ${hqStaff.length}名`);

  // Step 3: 施設ごとにスレッド分割 + Gemini分析
  const facilityResults = {};
  const allAnalyzed = [];

  for (const name of facilityNames) {
    const threads = buildThreads(facilityGroups[name]);
    const analyzed = [];
    for (let i = 0; i < threads.length; i++) {
      const result = analyzeThread(threads[i], allAnalyzed.length + i + 1, hqStaffMap);
      result.facility = name;
      analyzed.push(result);
      Utilities.sleep(500);
    }
    facilityResults[name] = analyzed;
    allAnalyzed.push(...analyzed);
  }

  // Step 4: THREAD_LOGに記録
  writeThreadLog(ss, allAnalyzed, today);

  // Step 5: 全施設横断サマリー生成（親投稿用）
  const crossSummary = generateCrossFacilitySummary(facilityResults, today);

  // Step 6: Slack送信
  const activeCount = facilityNames.length;
  const header = `📊 *日次レポート* | ${today}（${getDayOfWeek()}）\n稼働施設: ${activeCount}施設\n━━━━━━━━━━━━━━━━━━\n`;
  const footer = `\n━━━━━━━━━━━━━━━━━━\n_${getJstTimestamp()} | YAMATO AI Bot v4.1 | ${allAnalyzed.length}スレッド・${activeCount}施設_`;

  const parentText = header + crossSummary + footer;
  const parentTs = postSlackMessage(parentText);

  if (!parentTs) {
    Logger.log('[DailySummary] 親投稿の送信に失敗。スレッド返信をスキップ。');
    return;
  }

  // Step 7: 施設別の詳細をスレッド返信
  for (const name of facilityNames) {
    const threads = facilityResults[name];
    const relevant = threads.filter(t => t.main_category !== 'ATTENDANCE');
    if (relevant.length === 0) continue;

    const facilitySummary = generateFacilitySummary(relevant, name, today);
    const replyText = `🏠 *${name}*\n${facilitySummary}`;
    postSlackReply(replyText, parentTs);
    Utilities.sleep(300);
  }

  Logger.log(`[DailySummary] 完了: 親投稿 + ${facilityNames.length}施設の返信`);
}

// ── Step 1: メッセージログ取得 ──
function getLogMessages(ss, today) {
  const sheet = ss.getSheetByName(SHEET.LOG);
  if (!sheet) { Logger.log('メッセージログシートなし'); return []; }

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const raw = data[i][0];
    const dateStr = raw instanceof Date
      ? Utilities.formatDate(raw, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss')
      : String(raw || '');
    if (!dateStr.startsWith(today)) continue;

    const type = String(data[i][5] || '');
    if (type !== 'text') continue;

    const text = String(data[i][6] || '').trim();
    if (!text) continue;

    rows.push({
      time:   dateStr.substring(11, 16),
      sender: String(data[i][4] || ''),
      userId: String(data[i][3] || ''),
      group:  String(data[i][2] || ''),
      text:   text,
    });
  }
  return rows;
}

// ── Step 2: 施設別グループ化 ──
function groupByFacility(messages) {
  const groups = {};
  for (const msg of messages) {
    const name = msg.group || '不明';
    if (!groups[name]) groups[name] = [];
    groups[name].push(msg);
  }
  return groups;
}

// ── Step 2b: スレッド分割（5分ウィンドウ） ──
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
function analyzeThread(thread, idx, hqStaffMap) {
  const apiKey = getGeminiApiKey();
  // 本部スタッフにはタグを付与してGeminiに渡す
  const threadText = thread.messages.map(m => {
    const isHq = hqStaffMap && hqStaffMap.has(m.userId);
    const tag = isHq ? '[本部]' : '';
    return `[${m.time}] ${tag}${m.sender}: ${m.text}`;
  }).join('\n');

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

  // 本部スタッフ情報をプロンプトに追加
  let staffContext = '';
  if (hqStaffMap && hqStaffMap.size > 0) {
    staffContext = `\n\n## 送信者の識別\n- [本部] タグ付きの送信者は本部メンバーです\n- タグなしの送信者は現場スタッフです\n- directionの判定にこの情報を使ってください`;
  }

  try {
    const res = UrlFetchApp.fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          system_instruction: { parts: [{ text: THREAD_SYSTEM_PROMPT + staffContext }] },
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
    const parts = data.candidates?.[0]?.content?.parts || [];
    const textPart = parts.filter(p => !p.thought).pop();
    let raw = (textPart?.text || '{}').trim();
    raw = raw.replace(/```json\n?|\n?```/g, '').trim();

    const m = raw.match(/\{[\s\S]*\}/);
    if (m) raw = m[0];

    const parsed = JSON.parse(raw);
    return { ...base, ...parsed };
  } catch (e) {
    Logger.log(`[analyzeThread] スレッド${idx} エラー: ${e.message}`);
    Logger.log(`[analyzeThread] スレッド${idx} 入力: ${threadText.substring(0, 100)}`);
    return { ...base, main_category: 'UNKNOWN', summary: threadText.substring(0, 50), action_item: null, is_resolved: null };
  }
}

// ── Step 4: THREAD_LOGシートに記録 ──
function writeThreadLog(ss, threads, today) {
  let sheet = ss.getSheetByName(SHEET.THREAD_LOG);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET.THREAD_LOG);
    const headers = ['日付', '施設', '開始時刻', '終了時刻', 'メッセージ数', 'カテゴリ', '要約', 'アクション項目', '解決済み', '方向性'];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    Logger.log('[INIT] スレッドログシート作成');
  }

  const rows = threads.map(t => [
    today,
    t.facility     || '',
    t.start_time   || '',
    t.end_time     || '',
    t.msg_count    || '',
    t.main_category || '',
    t.summary      || '',
    t.action_item  || '',
    t.is_resolved === true ? '解決済' : t.is_resolved === false ? '未解決' : '',
    t.direction    || '',
  ]);

  if (rows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    Logger.log(`[THREAD_LOG] ${rows.length}スレッド記録完了`);
  }
}

// ── Step 5: 全施設横断サマリー ──
function generateCrossFacilitySummary(facilityResults, today) {
  const apiKey = getGeminiApiKey();

  // 全施設のATTENDANCE以外のスレッドを集約
  const allRelevant = [];
  for (const [name, threads] of Object.entries(facilityResults)) {
    for (const t of threads) {
      if (t.main_category !== 'ATTENDANCE' && t.main_category !== 'UNKNOWN') {
        allRelevant.push({ facility: name, ...t });
      }
    }
  }

  if (allRelevant.length === 0) {
    return '本日の特記事項はありませんでした。';
  }

  if (!apiKey) {
    return allRelevant.map(t => `• 【${t.facility}】${t.summary}`).join('\n');
  }

  const logData = allRelevant.map(t => ({
    facility:     t.facility,
    time:         t.start_time,
    category:     t.main_category,
    summary:      t.summary,
    action_item:  t.action_item,
    is_resolved:  t.is_resolved,
  }));

  try {
    const res = callGemini(CROSS_FACILITY_PROMPT, `${today}の全施設業務ログ:\n${JSON.stringify(logData, null, 2)}`, 600);
    return res || allRelevant.map(t => `• 【${t.facility}】${t.summary}`).join('\n');
  } catch (e) {
    Logger.log(`[crossFacilitySummary] エラー: ${e.message}`);
    return allRelevant.map(t => `• 【${t.facility}】${t.summary}`).join('\n');
  }
}

// ── Step 6: 施設別サマリー ──
function generateFacilitySummary(threads, facilityName, today) {
  const apiKey = getGeminiApiKey();

  const forGemini = threads.filter(t => t.main_category !== 'UNKNOWN');
  if (forGemini.length === 0) {
    return threads.map(t => `• ${t.raw_text ? t.raw_text.substring(0, 60) : '(内容なし)'}`).join('\n');
  }

  if (!apiKey) {
    return forGemini.map(t => `• [${t.start_time}] ${t.summary}`).join('\n');
  }

  const logData = forGemini.map(t => ({
    time:        t.start_time,
    category:    t.main_category,
    summary:     t.summary,
    action_item: t.action_item,
    is_resolved: t.is_resolved,
  }));

  try {
    const res = callGemini(FACILITY_SUMMARY_PROMPT, `${today} ${facilityName}の業務ログ:\n${JSON.stringify(logData, null, 2)}`, 400);
    return res || forGemini.map(t => `• [${t.start_time}] ${t.summary}`).join('\n');
  } catch (e) {
    Logger.log(`[facilitySummary] ${facilityName} エラー: ${e.message}`);
    return forGemini.map(t => `• [${t.start_time}] ${t.summary}`).join('\n');
  }
}

// ── Gemini 共通呼び出し ──
function callGemini(systemPrompt, userContent, maxTokens) {
  const apiKey = getGeminiApiKey();
  const res = UrlFetchApp.fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userContent }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: maxTokens || 600,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
      muteHttpExceptions: true,
    }
  );

  const data = JSON.parse(res.getContentText());
  if (data.error) {
    Logger.log(`[callGemini] APIエラー: ${data.error.message}`);
    return null;
  }
  const parts = data.candidates?.[0]?.content?.parts || [];
  const textPart = parts.filter(p => !p.thought).pop();
  const text = (textPart?.text || '').trim();
  if (!text) {
    Logger.log(`[callGemini] 空レスポンス: ${res.getContentText().substring(0, 200)}`);
  }
  return text || null;
}

// ── Slack Web API ──
function postSlackMessage(text) {
  const token = getSlackBotToken();
  const channel = getSlackChannelId();
  if (!token || !channel) {
    Logger.log('[Slack] BOT_TOKEN or CHANNEL_ID が未設定');
    return null;
  }

  const res = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': `Bearer ${token}` },
    payload: JSON.stringify({ channel: channel, text: text }),
    muteHttpExceptions: true,
  });

  const data = JSON.parse(res.getContentText());
  if (!data.ok) {
    Logger.log(`[Slack] 親投稿エラー: ${data.error}`);
    return null;
  }
  Logger.log(`[Slack] 親投稿成功: ts=${data.ts}`);
  return data.ts;
}

function postSlackReply(text, threadTs) {
  const token = getSlackBotToken();
  const channel = getSlackChannelId();
  if (!token || !channel) return;

  const res = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': `Bearer ${token}` },
    payload: JSON.stringify({
      channel: channel,
      text: text,
      thread_ts: threadTs,
    }),
    muteHttpExceptions: true,
  });

  const data = JSON.parse(res.getContentText());
  if (!data.ok) {
    Logger.log(`[Slack] スレッド返信エラー: ${data.error}`);
  }
}

// ── 本部スタッフ参照 ──
function getHqStaffList(ss) {
  const sheet = ss.getSheetByName(SHEET.STAFF);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  // ヘッダー: ユーザーID(0), 名前(1), 役割(2)
  const staff = [];
  for (let i = 1; i < data.length; i++) {
    const userId = String(data[i][0] || '').trim();
    const name = String(data[i][1] || '').trim();
    const role = String(data[i][2] || '').trim();
    if (userId) staff.push({ userId, name, role });
  }
  return staff;
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

// ── セットアップ・テスト用 ──
function setupStaffSheet() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(SHEET.STAFF);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET.STAFF);
  }
  // ヘッダー設定（既存シートも上書き更新）
  sheet.getRange(1, 1, 1, 3).setValues([['ユーザーID', '名前', '役割']]);
  sheet.setColumnWidth(1, 250);
  sheet.setColumnWidth(2, 120);
  sheet.setColumnWidth(3, 200);
  const header = sheet.getRange(1, 1, 1, 3);
  header.setFontWeight('bold');
  header.setBackground('#f3f3f3');
  Logger.log('本部スタッフシートを更新しました。ユーザーID・名前・役割を入力してください。');
}

function testDailySummary() {
  sendDailySummary();
}
