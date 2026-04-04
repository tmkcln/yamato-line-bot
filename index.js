/**
 * YAMATO AI Bot — Railway版 (Express) v4.0
 *
 * 構成:
 *   Pass 1（リアルタイム）: LINE Webhook → 全量RAWログ + 緊急キーワード検知 → Slack即時アラート
 *   Pass 2+3（21:00バッチ）: GAS DailySummary.gs がスレッド化 + Gemini分析 + Slackサマリー
 *
 * 環境変数（Railway Dashboard で設定）:
 *   LINE_ACCESS_TOKEN          : LINE Channel Access Token
 *   SLACK_WEBHOOK_URL          : Slack Incoming Webhook URL
 *   GOOGLE_SERVICE_ACCOUNT_JSON: Service Account の JSON 全文
 *   GOOGLE_SHEETS_ID           : スプレッドシート ID
 *   GOOGLE_DRIVE_FOLDER_ID     : Drive ルートフォルダ ID
 *   PORT                       : Railway が自動設定
 *
 * v4.0 変更点:
 *   - リアルタイムGemini呼び出しを廃止（1件ずつ分類 → コスト削減・レイテンシ改善）
 *   - 緊急キーワード（漏電/水漏れ/火災等）のみ正規表現で即時Slack通知
 *   - AI分類・構造化ログ・日次サマリーは DailySummary.gs（21:00）が一括処理
 */

const express = require('express');
const { google } = require('googleapis');
const { Readable } = require('stream');

const app = express();
app.use(express.json());

// ── 1. 環境変数 ──
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SHEETS_ID         = process.env.GOOGLE_SHEETS_ID;
const DRIVE_ROOT_FOLDER = process.env.GOOGLE_DRIVE_FOLDER_ID;

// ── 1-a. 緊急キーワード検知（リアルタイムSlack即時アラート用）
// 生命・安全に関わるものだけを対象。AI不要で正規表現で確実に検知する。
const CRITICAL_REGEX = /漏電|水漏れ|ガス漏れ|火災|煙が出|燃えて|倒れ|骨折|怪我|救急|119番|意識|至急.{0,5}(危|緊急|危険)|緊急.{0,5}(来て|対応|助)/u;

// ── 1-b. 事前NOISEフィルタ ──
// 設計方針:
//   - 「はい、」（読点付き）は削除。読点は文が続く証拠なので後続内容を見ないと判断できない
//   - .{0,8} に短縮。「でした！」「ます。」程度のみ許容し、実質情報を含む文を誤除外しない
// [^、]{0,8}: suffix に読点(、)を含まず最大8文字。読点があれば文が続く→通過させる
const NOISE_REGEX = /^(お疲れ様|おつかれ様|お疲れ様です|おつかれさまです|おつかれ|承知しました|承知いたしました|承知です|かしこまりました|かしこまりです|ありがとうございます|ありがとうございました|ご対応ありがとう|了解です|了解しました|了解いたしました|わかりました|はーい|よろしくお願いします)[^、]{0,8}$/u;

// ── 1-c. グループ設定マスタ ──
// groupId をキーに施設名・用途・Botの振る舞いを定義する。
// 未登録グループは DEFAULT_GROUP_CONFIG にフォールバック。
//
// purpose の選択肢:
//   'facility_ops'    — 清掃/設備/課金ログ（デフォルト）
//   'staff_internal'  — 社内スタッフ連絡（将来: 出退勤のみ記録）
//   'guest_support'   — ゲスト向けFAQ Bot（将来: RAG連携）
//
// botMode の選択肢:
//   'passive' — グループ内で発言しない（デフォルト）
//   'active'  — Geminiが reply_text を返したとき LINE Reply API で返信
//
// 新施設・Slack Bot・新グループを追加するときはここに行を追加するだけでよい。
const GROUP_CONFIGS = {
  // 富浦館山の groupId が判明したら下のコメントを外して設定する:
  // 'C1234567890abcdef': {
  //   facilityName: '富浦館山',
  //   purpose: 'facility_ops',
  //   botMode: 'passive',
  // },
};

const DEFAULT_GROUP_CONFIG = {
  facilityName: null,   // null のとき LINE Profile API のグループ名をそのまま使用
  purpose: 'facility_ops',
  botMode: 'passive',
};

function getGroupConfig(groupId) {
  return GROUP_CONFIGS[groupId] || DEFAULT_GROUP_CONFIG;
}

// シート名定義
const SHEETS = {
  LOG: 'メッセージログ',  // index.jsが書き込む唯一のシート（全量RAWログ）
  // 構造化シート（THREAD_LOG含む）は DailySummary.gs が管理
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

// ── 5. 起動時: メッセージログシートのヘッダー初期化 ──
async function initAllSheetHeaders() {
  const sheets = google.sheets({ version: 'v4', auth });
  const headers = ['日時', 'グループID', 'グループ名', 'ユーザーID', '表示名', '種別', 'テキスト', 'DriveURL', 'messageId'];

  try {
    const range = `${SHEETS.LOG}!A1:I1`;
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEETS_ID, range });
    const row1 = res.data.values?.[0];
    if (!row1 || row1[0] !== headers[0]) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEETS_ID,
        range,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [headers] },
      });
      console.log(`[INIT] ${SHEETS.LOG} ヘッダー書き込み済み`);
    } else {
      console.log(`[INIT] ${SHEETS.LOG} ヘッダー確認済み`);
    }
  } catch (err) {
    console.warn(`[INIT] ${SHEETS.LOG} シートが見つかりません: ${err.message}`);
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

      // テキストメッセージのみ緊急キーワード検知（AI不使用・即時アラート）
      if (msg.type === 'text' && text) {
        await checkCriticalAlert(text, groupName, displayName);
      }
    } catch (err) {
      console.error(`[ERROR] ${err.message}`);
    }
  }
});

// ── 7. 緊急キーワード即時アラート（AI不使用）──
// 生命・安全に関わる緊急事態のみ正規表現で即時検知しSlack通知する。
// 通常の設備不具合・業務報告はDailySummary.gs（21:00バッチ）が処理する。
async function checkCriticalAlert(text, groupName, senderName) {
  if (!CRITICAL_REGEX.test(text)) return;

  console.log(`[CRITICAL] 緊急キーワード検知: "${text.substring(0, 60)}"`);

  if (!SLACK_WEBHOOK_URL) {
    console.warn('[Slack] SLACK_WEBHOOK_URL が未設定です');
    return;
  }

  const lines = [
    `🚨 *[緊急アラート]* | ${groupName}`,
    `*報告者:* ${senderName}`,
    `*内容:* ${text.substring(0, 200)}`,
    `_${getJstTimestamp()} — 自動キーワード検知_`,
  ];

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: lines.join('\n') }),
  });

  if (!res.ok) console.error('[Slack] 緊急通知失敗:', res.status);
  else console.log('[Slack] 緊急アラート送信済み');
}

// ── 8. (削除) ──
// notifySlack / writeStructuredLog / callGemini はv4.0で廃止。
// AI分類と構造化ログ書き込みは DailySummary.gs（21:00バッチ）に移管。

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

// ── 14. ユーティリティ ──
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
