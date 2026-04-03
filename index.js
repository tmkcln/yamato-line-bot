/**
 * YAMATO AI Bot — Railway版 (Express) v2
 *
 * 構成: LINE Webhook → Railway → Google Sheets/Drive 収集 + Dify返信（メンション時）
 *
 * 環境変数（Railway Dashboard で設定）:
 *   LINE_ACCESS_TOKEN          : LINE Channel Access Token
 *   DIFY_API_KEY               : Dify の API キー
 *   BOT_MENTION_NAME           : グループ内メンションキーワード（デフォルト: @YAMATO）
 *   GOOGLE_SERVICE_ACCOUNT_JSON: Service Account の JSON 全文
 *   GOOGLE_SHEETS_ID           : スプレッドシート ID
 *   GOOGLE_DRIVE_FOLDER_ID     : Drive ルートフォルダ ID
 *   PORT                       : Railway が自動設定
 */

const express = require('express');
const { google } = require('googleapis');
const { Readable } = require('stream');

const app = express();
app.use(express.json());

// ── 環境変数 ──
const LINE_ACCESS_TOKEN   = process.env.LINE_ACCESS_TOKEN;
const DIFY_API_KEY        = process.env.DIFY_API_KEY;
const DIFY_BASE_URL       = 'https://api.dify.ai/v1';
const BOT_MENTION_NAME    = process.env.BOT_MENTION_NAME || '@YAMATO';
const SHEETS_ID           = process.env.GOOGLE_SHEETS_ID;
const DRIVE_ROOT_FOLDER   = process.env.GOOGLE_DRIVE_FOLDER_ID;
const SHEET_NAME          = 'メッセージログ';

// ── Google Auth ──
const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive',
  ],
});

// ── 名前キャッシュ（メモリ内、再起動でリセット） ──
const nameCache = {};

// ── ヘルスチェック ──
app.get('/', (req, res) => res.send('OK'));

// ── 起動時: Sheetsヘッダー初期化 ──
async function initSheetHeader() {
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEETS_ID,
      range: `${SHEET_NAME}!A1:I1`,
    });
    const row1 = res.data.values?.[0];
    if (!row1 || row1[0] !== '日時') {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEETS_ID,
        range: `${SHEET_NAME}!A1:I1`,
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [['日時', 'グループID', 'グループ名', 'ユーザーID', '表示名', '種別', 'テキスト', 'DriveURL', 'messageId']],
        },
      });
      console.log('[INIT] Sheets ヘッダーを書き込みました');
    } else {
      console.log('[INIT] Sheets ヘッダー確認済み');
    }
  } catch (err) {
    console.error('[INIT ERROR] Sheets ヘッダー初期化失敗:', err.message);
  }
}

// ── LINE Webhook受信 ──
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
      // 表示名・グループ名を取得
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

      // Sheetsに追記
      await appendToSheets([
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

      // メンション or DM のみ Dify で返信
      if (msg.type === 'text') {
        const isDM       = sourceType === 'user';
        const isMention  = text.includes(BOT_MENTION_NAME);
        if (isDM || isMention) {
          const clean = text.replace(new RegExp(BOT_MENTION_NAME + '\\s*', 'g'), '').trim();
          if (clean) {
            const reply = await callDify(clean, userId);
            await replyToLine(replyToken, reply);
          }
        }
      }
    } catch (err) {
      console.error(`[ERROR] ${err.message}`);
    }
  }
});

// ── Sheetsに1行追記 ──
async function appendToSheets(row) {
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEETS_ID,
    range: `${SHEET_NAME}!A:I`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [row] },
  });
}

// ── Driveにファイルアップロード ──
async function uploadToDrive(messageId, fileName, msgType, groupName) {
  // LINEからダウンロード
  const lineRes = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: 'Bearer ' + LINE_ACCESS_TOKEN },
  });
  if (!lineRes.ok) throw new Error(`LINE content API: ${lineRes.status}`);

  const contentType = lineRes.headers.get('content-type') || 'application/octet-stream';
  const buffer = Buffer.from(await lineRes.arrayBuffer());

  // 月別 > グループ名別フォルダを取得/作成
  const drive       = google.drive({ version: 'v3', auth });
  const monthFolder = await getOrCreateFolder(drive, getMonthStr(), DRIVE_ROOT_FOLDER);
  const groupFolder = await getOrCreateFolder(drive, groupName, monthFolder);

  // アップロード
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);

  const uploaded = await drive.files.create({
    requestBody: { name: fileName, parents: [groupFolder] },
    media: { mimeType: contentType, body: stream },
    fields: 'id, webViewLink',
  });

  // 閲覧権限付与（リンク共有）
  await drive.permissions.create({
    fileId: uploaded.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  return uploaded.data.webViewLink;
}

// ── Drive: フォルダを取得 or 作成 ──
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

// ── LINE Profile API ──
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

// ── Dify API ──
async function callDify(message, userId) {
  const res = await fetch(DIFY_BASE_URL + '/chat-messages', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + DIFY_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: {}, query: message, response_mode: 'blocking', user: userId || 'anonymous' }),
  });
  if (!res.ok) throw new Error(`Dify: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.answer || '応答を取得できませんでした';
}

// ── LINE 返信 ──
async function replyToLine(replyToken, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + LINE_ACCESS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: text.substring(0, 5000) }] }),
  });
  if (!res.ok) throw new Error(`LINE reply: ${res.status} ${await res.text()}`);
}

// ── ユーティリティ ──
function getJstTimestamp() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
}

function getMonthStr() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ── 起動 ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`YAMATO AI Bot v2 running on port ${PORT}`);
  await initSheetHeader();
});
