/**
 * YAMATO AI Bot — Railway版 (Express) v3.1
 *
 * 構成: LINE Webhook → Railway → Google Sheets/Drive 収集 + Gemini AI分類 + Slack通知
 *
 * 環境変数（Railway Dashboard で設定）:
 *   LINE_ACCESS_TOKEN          : LINE Channel Access Token
 *   GEMINI_API_KEY             : Google Gemini API キー（aistudio.google.com で取得）
 *   SLACK_WEBHOOK_URL          : Slack Incoming Webhook URL（1チャンネル）
 *   GOOGLE_SERVICE_ACCOUNT_JSON: Service Account の JSON 全文
 *   GOOGLE_SHEETS_ID           : スプレッドシート ID
 *   GOOGLE_DRIVE_FOLDER_ID     : Drive ルートフォルダ ID
 *   PORT                       : Railway が自動設定
 *
 * v3.1 変更点 (Dify → Gemini Direct):
 *   - Dify Cloud（200回/月無料）→ Gemini 2.0 Flash（1,500回/日無料）に移行
 *   - 事前NOISEフィルタ（挨拶・返事）でAPI呼び出しを約30%削減
 *   - コスト: 月~$64 → 月~$5（Railway のみ）
 *
 * 構造化ログシート:
 *   - 出退勤   : ATTENDANCE
 *   - 設備不具合: FACILITY_ISSUE
 *   - 課金     : CHARGE
 *   - 忘れ物   : LOST_FOUND
 *   - 在庫     : INVENTORY
 */

const express = require('express');
const { google } = require('googleapis');
const { Readable } = require('stream');

const app = express();
app.use(express.json());

// ── 1. 環境変数 ──
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY;
const GEMINI_URL        = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SHEETS_ID         = process.env.GOOGLE_SHEETS_ID;
const DRIVE_ROOT_FOLDER = process.env.GOOGLE_DRIVE_FOLDER_ID;

// ── 1-a. Gemini システムプロンプト（メッセージ分類用） ──
const GEMINI_SYSTEM_PROMPT = `あなたは宿泊施設運営のLINEグループメッセージを自動分類するAIです。

## 役割
入力されたメッセージを分析し、カテゴリ・緊急度・アクション・構造化データをJSON形式のみで出力してください。
説明文・前置き・補足は一切不要です。JSONのみを返してください。

## 入力形式
[グループ: グループ名] [送信者: 表示名]
メッセージ本文

## 出力スキーマ
{"category":"カテゴリ名","subcategory":"サブカテゴリ名","urgency":"critical|high|medium|low|none","action":"ignore|notify_slack|log_structured|notify_and_log","summary":"日本語で1〜2行の要約","structured_data":{}}

## カテゴリ一覧と判定ルール（優先度順）

### 1. NOISE（最優先で除外）→ action: ignore
以下のいずれかに該当するメッセージ:
- 実質的な情報を含まない挨拶・返事のみ（「お疲れ様です」「承知しました」「ありがとうございます」「かしこまりました」「了解です」「ご対応ありがとうございます」などのみで構成されるメッセージ）
- スタンプ
- 「〇〇が退勤します」に対する「お疲れ様でした！」だけの返信
subcategory: greeting | acknowledgment | sticker
structured_data: {}

### 2. FACILITY_ISSUE（設備不具合） → action: notify_and_log
キーワード: 故障、壊れ、動かない、電源入らない、詰まり、漏電、水漏れ、破損、折れ、割れ、異音、異臭、稼働しない、使えない、ブレーカー、ポンプ
subcategory: urgent | safety_risk | malfunction | degradation
緊急度: critical=漏電/水漏れ/ガス/火災リスク/「至急」含む, high=機器の完全停止, medium=部分損傷, low=軽微
structured_data: {"equipment":"対象設備名","location":"場所","symptom":"症状","has_image":true|false}

### 3. ATTENDANCE（出退勤） → action: log_structured
パターン: 「XX:XX業務開始します」「退勤します」「待機しています」「施錠確認し帰ります」
subcategory: clock_in | clock_out | standby
urgency: low
structured_data: {"type":"clock_in|clock_out|standby","time":"11:00","note":""}

### 4. CHARGE（課金報告） → action: log_structured / 修正時は notify_and_log
キーワード: 「課金」を含む
subcategory: charge_report | charge_correction
urgency: medium
structured_data: {"items":[{"name":"コーラ","quantity":3}],"is_correction":false,"correction_detail":null}

### 5. INVENTORY（在庫・備品） → action: notify_and_log
キーワード: 残り〇〇、在庫、発注、注文依頼、納品、賞味期限
subcategory: stock_alert | order_request | delivery_update
urgency: high（在庫アラート）/ medium（発注・納品）
structured_data: {"item":"品目名","remaining":206,"unit":"足","expiry_date":"2026-01-13"}

### 6. BOOKING（予約・ゲスト情報） → action: notify_and_log
キーワード: アウトイン、チェックイン、宿泊、〇名、〇泊、アウト清掃
structured_data: {"check_in_date":"2026-04-04","nights":2,"guests":6,"special_requests":[]}

### 7. LOST_FOUND（忘れ物） → action: notify_and_log
キーワード: 忘れ物、落とし物、置き忘れ
structured_data: {"item":"品目","status":"found|searching|shipped|returned"}

### 8. CLEANING（清掃作業） → action: log_structured / 問題あり時はnotify_and_log
subcategory: start_report | end_report | issue_report
structured_data: {}

### 9. SHIFT（シフト） → action: log_structured / スタッフ不足時はnotify_and_log
subcategory: schedule_share | schedule_request | shortage
structured_data: {}

### 10. PENDING_LIST（懸案事項） → action: notify_and_log
パターン: 番号付きリスト（①②③）/ 「懸案事項」「設備点検」
subcategory: issue_list | inspection_report
urgency: high
structured_data: {}

### 11. QUESTION（確認・質問） → action: log_structured / エスカレ時はnotify_and_log
subcategory: operational | escalation_request
structured_data: {}

## 絶対に守るルール
1. 出力はJSONのみ。他のテキストは一切含めない
2. 画像のみのメッセージ → category: NOISE, action: ignore
3. 「課金」を含む場合は必ず品目・数量を分解してitemsに格納する
4. ATTENDANCEの時刻は必ずHH:MM形式で抽出する
5. summaryは必ず日本語で記述する
6. urgencyはcritical/high/medium/low/noneのいずれかのみ`;

// ── 1-b. 事前NOISEフィルタ（Gemini呼び出し削減、約30%効果） ──
const NOISE_REGEX = /^(お疲れ様|おつかれ様|お疲れ様です|おつかれさまです|おつかれ|承知しました|承知いたしました|承知です|かしこまりました|かしこまりです|ありがとうございます|ありがとうございました|ご対応ありがとう|了解です|了解しました|了解いたしました|わかりました|はい、|はーい|よろしくお願いします).{0,20}$/u;

// シート名定義
const SHEETS = {
  LOG:      'メッセージログ',
  ATTEND:   '出退勤',
  FACILITY: '設備不具合',
  CHARGE:   '課金',
  LOST:     '忘れ物',
  INVENTORY:'在庫',
};

// ── 2. Google Auth ──
const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive',
  ],
});

// ── 3. 名前キャッシュ（メモリ内、再起動でリセット） ──
const nameCache = {};

// ── 4. ヘルスチェック ──
app.get('/', (req, res) => res.send('YAMATO AI Bot v3 OK'));

// ── 5. 起動時: 全シートヘッダー初期化 ──
async function initAllSheetHeaders() {
  const sheets = google.sheets({ version: 'v4', auth });

  const defs = [
    {
      name: SHEETS.LOG,
      headers: ['日時', 'グループID', 'グループ名', 'ユーザーID', '表示名', '種別', 'テキスト', 'DriveURL', 'messageId'],
    },
    {
      name: SHEETS.ATTEND,
      headers: ['日付', 'スタッフ名', '種別', '時刻', '備考', 'messageId'],
    },
    {
      name: SHEETS.FACILITY,
      headers: ['報告日時', '報告者', '対象設備', '場所', '症状', '緊急度', 'ステータス', '画像URL', 'messageId'],
    },
    {
      name: SHEETS.CHARGE,
      headers: ['報告日時', '報告者', '品目', '数量', '修正フラグ', '修正内容', 'messageId'],
    },
    {
      name: SHEETS.LOST,
      headers: ['報告日時', '報告者', '品目', 'ステータス', '画像URL', 'messageId'],
    },
    {
      name: SHEETS.INVENTORY,
      headers: ['報告日時', '報告者', '品目', '残数', '単位', '賞味期限', '発注ステータス', 'messageId'],
    },
  ];

  for (const def of defs) {
    try {
      const range = `${def.name}!A1:${String.fromCharCode(64 + def.headers.length)}1`;
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEETS_ID, range });
      const row1 = res.data.values?.[0];
      if (!row1 || row1[0] !== def.headers[0]) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEETS_ID,
          range,
          valueInputOption: 'USER_ENTERED',
          resource: { values: [def.headers] },
        });
        console.log(`[INIT] ${def.name} ヘッダー書き込み済み`);
      } else {
        console.log(`[INIT] ${def.name} ヘッダー確認済み`);
      }
    } catch (err) {
      // シートが存在しない場合はエラーになるが、appendToStructuredSheet が初回書き込み時に対応
      console.warn(`[INIT] ${def.name} シートが見つかりません（要手動作成）: ${err.message}`);
    }
  }
}

// ── 6. LINE Webhook受信（メインハンドラ） ──
app.post('/', async (req, res) => {
  res.status(200).send('OK');

  const events = req.body.events || [];

  for (const event of events) {
    if (event.type !== 'message') continue;

    const msg        = event.message;
    const sourceType = event.source.type;
    const userId     = event.source.userId;
    const groupId    = event.source.groupId || event.source.roomId || null;
    const replyToken = event.replyToken;

    try {
      // 送信者・グループ名取得
      const displayName = groupId
        ? await getGroupMemberName(groupId, userId)
        : await getUserName(userId);
      const groupName = groupId ? await getGroupName(groupId, sourceType) : '個人チャット';

      // メッセージ種別ごとに処理
      let text     = '';
      let driveUrl = '';

      if (msg.type === 'text') {
        text = msg.text;
      } else if (['image', 'video', 'audio', 'file'].includes(msg.type)) {
        const fileName = msg.fileName || `${msg.type}_${msg.id}`;
        try {
          driveUrl = await uploadToDrive(msg.id, fileName, msg.type, groupName);
          text = fileName;
        } catch (e) {
          console.error('[Drive] アップロード失敗:', e.message);
          text = `[${msg.type} - アップロード失敗]`;
        }
      } else if (msg.type === 'sticker') {
        text = `スタンプ (${msg.stickerId})`;
      } else if (msg.type === 'location') {
        text = `📍 ${msg.title || ''} ${msg.address || ''}`.trim();
      } else {
        text = `[${msg.type}]`;
      }

      // メッセージログに全量記録（既存動作を維持）
      await appendToSheet(SHEETS.LOG, [
        getJstTimestamp(),
        groupId || userId,
        groupName,
        userId,
        displayName,
        msg.type,
        text,
        driveUrl,
        msg.id,
      ]);

      console.log(`[LOG] ${displayName}(${groupName}): ${text.substring(0, 60)}`);

      // テキストメッセージのみ AI 判断（Phase 3）
      if (msg.type === 'text' && text) {
        await handleAiDecision(text, replyToken, groupName, displayName, userId, msg.id, driveUrl);
      }
    } catch (err) {
      console.error(`[ERROR] ${err.message}`);
    }
  }
});

// ── 7. AI判断 + アクション分岐（Phase 3 v2） ──
async function handleAiDecision(text, replyToken, groupName, displayName, userId, messageId, driveUrl) {
  // 事前NOISEフィルタ: 挨拶・返事のみのメッセージはGemini呼び出しをスキップ
  if (NOISE_REGEX.test(text.trim())) {
    console.log(`[AI] 事前フィルタでNOISE判定: "${text.substring(0, 40)}"`);
    return;
  }

  // Gemini にコンテキスト付きで送信
  const contextText = `[グループ: ${groupName}] [送信者: ${displayName}]\n${text}`;
  const rawResponse = await callGemini(contextText);

  let decision;
  try {
    decision = JSON.parse(rawResponse);
  } catch {
    console.warn('[AI] JSON parse 失敗。フォールバック（ignore）:', rawResponse.substring(0, 80));
    decision = { action: 'ignore' };
  }

  const action   = decision.action   || 'ignore';
  const category = decision.category || 'UNKNOWN';
  const urgency  = decision.urgency  || 'low';

  console.log(`[AI] action=${action} category=${category} urgency=${urgency}`);

  // 画像URLをstructured_dataに付与（直前の画像メッセージと紐付けは将来課題）
  if (decision.structured_data && driveUrl) {
    decision.structured_data.image_url = driveUrl;
  }

  // アクション分岐
  switch (action) {
    case 'notify_slack':
      await notifySlack(decision, displayName, groupName);
      break;

    case 'log_structured':
      await writeStructuredLog(decision, displayName, messageId);
      break;

    case 'notify_and_log':
      await notifySlack(decision, displayName, groupName);
      await writeStructuredLog(decision, displayName, messageId);
      break;

    case 'reply':
      // グループ返信は原則使わないが、将来の拡張のために残す
      if (decision.reply_text && replyToken) {
        await replyToLine(replyToken, decision.reply_text);
      }
      break;

    case 'ignore':
    default:
      // 何もしない
      break;
  }
}

// ── 8. Slack 通知（カテゴリ別リッチフォーマット） ──
async function notifySlack(decision, senderName, groupName) {
  if (!SLACK_WEBHOOK_URL) {
    console.warn('[Slack] SLACK_WEBHOOK_URL が未設定です');
    return;
  }

  const category = decision.category || 'UNKNOWN';
  const urgency  = decision.urgency  || 'low';
  const summary  = decision.summary  || '';
  const sd       = decision.structured_data || {};

  // 緊急度ごとのアイコン
  const urgencyEmoji = {
    critical: '🚨',
    high:     '⚠️',
    medium:   '📋',
    low:      'ℹ️',
    none:     '📌',
  }[urgency] || '📌';

  // カテゴリごとにヘッダーラベルを設定
  const categoryLabel = {
    FACILITY_ISSUE: '設備不具合',
    ATTENDANCE:     '出退勤',
    CHARGE:         '課金報告',
    CLEANING:       '清掃報告',
    BOOKING:        '予約・ゲスト情報',
    LOST_FOUND:     '忘れ物',
    INVENTORY:      '在庫アラート',
    SHIFT:          'シフト',
    PENDING_LIST:   '懸案事項',
    QUESTION:       '確認・質問',
    NOISE:          'その他',
  }[category] || category;

  // メッセージ本文を構築
  let lines = [
    `${urgencyEmoji} *[${categoryLabel}]* | ${groupName}`,
    `*報告者:* ${senderName}`,
    `*内容:* ${summary}`,
  ];

  // カテゴリ固有の追加情報
  if (category === 'FACILITY_ISSUE' && sd.equipment) {
    lines.push(`*対象設備:* ${sd.equipment}${sd.location ? ' (' + sd.location + ')' : ''}`);
    lines.push(`*緊急度:* ${urgency.toUpperCase()}`);
  }
  if (category === 'INVENTORY' && sd.item) {
    lines.push(`*品目:* ${sd.item} 残${sd.remaining || '?'}${sd.unit || ''}`);
    if (sd.expiry_date) lines.push(`*賞味期限:* ${sd.expiry_date}`);
  }
  if (category === 'BOOKING' && sd.guests) {
    lines.push(`*人数:* ${sd.guests}名 / ${sd.nights || '?'}泊`);
    if (sd.special_requests?.length) lines.push(`*特記:* ${sd.special_requests.join('・')}`);
  }
  if (category === 'LOST_FOUND' && sd.item) {
    lines.push(`*品目:* ${sd.item} (${sd.status || '不明'})`);
  }
  if (category === 'CHARGE' && sd.items?.length) {
    const itemList = sd.items.map(i => `${i.name} x${i.quantity}`).join('、');
    lines.push(`*品目:* ${itemList}`);
    if (sd.is_correction) lines.push('*⚠️ 修正あり*');
  }

  lines.push(`_${getJstTimestamp()}_`);

  const slackText = lines.join('\n');

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: slackText }),
  });

  if (!res.ok) console.error('[Slack] 通知失敗:', res.status);
  else console.log(`[Slack] 通知送信: ${category}/${urgency}`);
}

// ── 9. 構造化ログ書き込み ──
async function writeStructuredLog(decision, senderName, messageId) {
  const category = decision.category;
  const sd       = decision.structured_data || {};
  const ts       = getJstTimestamp();
  const date     = ts.substring(0, 10);

  switch (category) {
    case 'ATTENDANCE': {
      // 出退勤シート: 日付 | スタッフ名 | 種別 | 時刻 | 備考 | messageId
      await appendToSheet(SHEETS.ATTEND, [
        date,
        senderName,
        sd.type || '',
        sd.time || '',
        sd.note || '',
        messageId,
      ]);
      console.log(`[LOG] 出退勤記録: ${senderName} ${sd.type} ${sd.time}`);
      break;
    }

    case 'FACILITY_ISSUE': {
      // 設備不具合シート: 報告日時 | 報告者 | 対象設備 | 場所 | 症状 | 緊急度 | ステータス | 画像URL | messageId
      await appendToSheet(SHEETS.FACILITY, [
        ts,
        senderName,
        sd.equipment || '',
        sd.location  || '',
        sd.symptom   || decision.summary || '',
        decision.urgency || '',
        'open',
        sd.image_url || '',
        messageId,
      ]);
      console.log(`[LOG] 設備不具合記録: ${sd.equipment}`);
      break;
    }

    case 'CHARGE': {
      // 課金シート: 報告日時 | 報告者 | 品目 | 数量 | 修正フラグ | 修正内容 | messageId
      // 品目が複数ある場合は1品目1行に分割
      const items = sd.items || [{ name: decision.summary || '不明', quantity: '' }];
      for (const item of items) {
        await appendToSheet(SHEETS.CHARGE, [
          ts,
          senderName,
          item.name || '',
          item.quantity !== undefined ? item.quantity : '',
          sd.is_correction ? 'TRUE' : 'FALSE',
          sd.correction_detail || '',
          messageId,
        ]);
      }
      console.log(`[LOG] 課金記録: ${items.map(i => i.name + ' x' + i.quantity).join(', ')}`);
      break;
    }

    case 'LOST_FOUND': {
      // 忘れ物シート: 報告日時 | 報告者 | 品目 | ステータス | 画像URL | messageId
      await appendToSheet(SHEETS.LOST, [
        ts,
        senderName,
        sd.item   || decision.summary || '',
        sd.status || 'found',
        sd.image_url || '',
        messageId,
      ]);
      console.log(`[LOG] 忘れ物記録: ${sd.item}`);
      break;
    }

    case 'INVENTORY': {
      // 在庫シート: 報告日時 | 報告者 | 品目 | 残数 | 単位 | 賞味期限 | 発注ステータス | messageId
      await appendToSheet(SHEETS.INVENTORY, [
        ts,
        senderName,
        sd.item        || '',
        sd.remaining   !== undefined ? sd.remaining : '',
        sd.unit        || '',
        sd.expiry_date || '',
        'alert',
        messageId,
      ]);
      console.log(`[LOG] 在庫記録: ${sd.item} 残${sd.remaining}${sd.unit}`);
      break;
    }

    default:
      // CLEANING, SHIFT, BOOKING, QUESTION, PENDING_LIST はメッセージログのみ（追加シートなし）
      console.log(`[LOG] 構造化シートなし（${category}）: メッセージログのみ`);
      break;
  }
}

// ── 10. Sheets汎用追記 ──
async function appendToSheet(sheetName, row) {
  const sheets = google.sheets({ version: 'v4', auth });
  const colEnd = String.fromCharCode(64 + row.length);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEETS_ID,
    range: `${sheetName}!A:${colEnd}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [row] },
  });
}

// ── 11. Drive: ファイルアップロード ──
async function uploadToDrive(messageId, fileName, msgType, groupName) {
  const lineRes = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: 'Bearer ' + LINE_ACCESS_TOKEN },
  });
  if (!lineRes.ok) throw new Error(`LINE content API: ${lineRes.status}`);

  const contentType = lineRes.headers.get('content-type') || 'application/octet-stream';
  const buffer = Buffer.from(await lineRes.arrayBuffer());

  const drive       = google.drive({ version: 'v3', auth });
  const monthFolder = await getOrCreateFolder(drive, getMonthStr(), DRIVE_ROOT_FOLDER);
  const groupFolder = await getOrCreateFolder(drive, groupName, monthFolder);

  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);

  const uploaded = await drive.files.create({
    requestBody: { name: fileName, parents: [groupFolder] },
    media: { mimeType: contentType, body: stream },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });

  await drive.permissions.create({
    fileId: uploaded.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
    supportsAllDrives: true,
  });

  return uploaded.data.webViewLink;
}

// ── 12. Drive: フォルダを取得 or 作成 ──
async function getOrCreateFolder(drive, name, parentId) {
  const key = `folder_${parentId}_${name}`;
  if (nameCache[key]) return nameCache[key];

  const res = await drive.files.list({
    q: `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  });

  let folderId;
  if (res.data.files.length > 0) {
    folderId = res.data.files[0].id;
  } else {
    const created = await drive.files.create({
      requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
      fields: 'id',
      supportsAllDrives: true,
    });
    folderId = created.data.id;
  }

  nameCache[key] = folderId;
  return folderId;
}

// ── 13. LINE Profile API ──
async function getUserName(userId) {
  if (nameCache[userId]) return nameCache[userId];
  try {
    const res  = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { Authorization: 'Bearer ' + LINE_ACCESS_TOKEN },
    });
    const data = await res.json();
    nameCache[userId] = data.displayName || userId;
  } catch {
    nameCache[userId] = userId;
  }
  return nameCache[userId];
}

async function getGroupMemberName(groupId, userId) {
  const key = `${groupId}_${userId}`;
  if (nameCache[key]) return nameCache[key];
  try {
    const res  = await fetch(`https://api.line.me/v2/bot/group/${groupId}/member/${userId}`, {
      headers: { Authorization: 'Bearer ' + LINE_ACCESS_TOKEN },
    });
    const data = await res.json();
    nameCache[key] = data.displayName || userId;
  } catch {
    nameCache[key] = await getUserName(userId);
  }
  return nameCache[key];
}

async function getGroupName(groupId, sourceType) {
  if (nameCache[groupId]) return nameCache[groupId];
  try {
    const endpoint = sourceType === 'room'
      ? `https://api.line.me/v2/bot/room/${groupId}/summary`
      : `https://api.line.me/v2/bot/group/${groupId}/summary`;
    const res  = await fetch(endpoint, {
      headers: { Authorization: 'Bearer ' + LINE_ACCESS_TOKEN },
    });
    const data = await res.json();
    nameCache[groupId] = data.groupName || data.roomName || groupId;
  } catch {
    nameCache[groupId] = groupId;
  }
  return nameCache[groupId];
}

// ── 14. Gemini API（Dify の代替、無料枠: 1,500 req/日） ──
async function callGemini(message) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY が未設定です');
  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: GEMINI_SYSTEM_PROMPT }] },
      contents: [{ parts: [{ text: message }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  // マークダウンコードブロックを除去
  return raw.replace(/```json\n?|\n?```/g, '').trim();
}

// ── 15. LINE 返信（グループ返信は原則使わない・将来の拡張用） ──
async function replyToLine(replyToken, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + LINE_ACCESS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: text.substring(0, 5000) }] }),
  });
  if (!res.ok) throw new Error(`LINE reply: ${res.status} ${await res.text()}`);
}

// ── 16. ユーティリティ ──
function getJstTimestamp() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
}

function getMonthStr() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ── 17. 起動 ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`YAMATO AI Bot v3 running on port ${PORT}`);
  await initAllSheetHeaders();
});
