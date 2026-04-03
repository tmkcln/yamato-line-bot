/**
 * YAMATO AI Bot — Railway版 (Express) v3
 *
 * 構成: LINE Webhook → Railway → Google Sheets/Drive 収集 + Dify AI分類 + Slack通知
 *
 * 環境変数（Railway Dashboard で設定）:
 *   LINE_ACCESS_TOKEN          : LINE Channel Access Token
 *   DIFY_API_KEY               : Dify の API キー
 *   SLACK_WEBHOOK_URL          : Slack Incoming Webhook URL（1チャンネル）
 *   GOOGLE_SERVICE_ACCOUNT_JSON: Service Account の JSON 全文
 *   GOOGLE_SHEETS_ID           : スプレッドシート ID
 *   GOOGLE_DRIVE_FOLDER_ID     : Drive ルートフォルダ ID
 *   PORT                       : Railway が自動設定
 *
 * Phase 3 変更点:
 *   - 全テキストメッセージを Dify に送り、11カテゴリに自動分類
 *   - action: ignore / notify_slack / log_structured / notify_and_log で分岐
 *   - カテゴリ別に専用 Sheets シートへ構造化ログを書き込む
 *   - Slack 通知はカテゴリ・緊急度に応じたリッチフォーマット
 *   - グループへの返信は原則なし（情報収集・ホウレンソウ自動化に徹する）
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
const DIFY_API_KEY      = process.env.DIFY_API_KEY;
const DIFY_BASE_URL     = 'https://api.dify.ai/v1';
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SHEETS_ID         = process.env.GOOGLE_SHEETS_ID;
const DRIVE_ROOT_FOLDER = process.env.GOOGLE_DRIVE_FOLDER_ID;

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
  // Dify にコンテキスト付きで送信
  const contextText = `[グループ: ${groupName}] [送信者: ${displayName}]\n${text}`;
  const rawResponse = await callDify(contextText, userId);

  let decision;
  try {
    const cleaned = rawResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    decision = JSON.parse(cleaned);
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
  });

  await drive.permissions.create({
    fileId: uploaded.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
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
  });

  let folderId;
  if (res.data.files.length > 0) {
    folderId = res.data.files[0].id;
  } else {
    const created = await drive.files.create({
      requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
      fields: 'id',
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

// ── 14. Dify API ──
async function callDify(message, userId) {
  const res = await fetch(DIFY_BASE_URL + '/chat-messages', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + DIFY_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputs: {},
      query: message,
      response_mode: 'blocking',
      user: userId || 'anonymous',
    }),
  });
  if (!res.ok) throw new Error(`Dify: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.answer || '{}';
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
