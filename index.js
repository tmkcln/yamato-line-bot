/**
 * YAMATO AI Bot — Railway版 (Express)
 *
 * 構成: LINE Webhook → Railway (Express) → Dify API → LINE返信
 *
 * 環境変数（Railway Dashboard で設定）:
 *   LINE_ACCESS_TOKEN  : LINE Channel Access Token
 *   DIFY_API_KEY       : Dify の API キー
 *   BOT_MENTION_NAME   : グループ内で呼びかけるキーワード（デフォルト: @YAMATO）
 *   PORT               : Railwayが自動設定
 */

const express = require('express');
const app = express();
app.use(express.json());

const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const DIFY_API_KEY = process.env.DIFY_API_KEY;
const DIFY_BASE_URL = 'https://api.dify.ai/v1';
const BOT_MENTION_NAME = process.env.BOT_MENTION_NAME || '@YAMATO';

// ── ヘルスチェック ──
app.get('/', (req, res) => res.send('OK'));

// ── LINE Webhook受信 ──
app.post('/', async (req, res) => {
  // LINEに即座に200を返す
  res.status(200).send('OK');

  const events = req.body.events || [];

  for (const event of events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const text = event.message.text;
    const sourceType = event.source.type;
    const userId = event.source.userId;
    const replyToken = event.replyToken;

    // グループ/ルームではメンション必須
    if (sourceType !== 'user' && !text.includes(BOT_MENTION_NAME)) continue;

    // メンションキーワードを除去
    const cleanText = text.replace(new RegExp(BOT_MENTION_NAME + '\\s*', 'g'), '').trim();
    if (!cleanText) continue;

    try {
      const aiReply = await callDify(cleanText, userId);
      await replyToLine(replyToken, aiReply);
      console.log(`[OK] user=${userId} msg="${cleanText.substring(0, 30)}" reply="${aiReply.substring(0, 50)}"`);
    } catch (err) {
      console.error(`[ERROR] ${err.message}`);
    }
  }
});

// ── Dify API 呼び出し ──
async function callDify(message, userId) {
  const res = await fetch(DIFY_BASE_URL + '/chat-messages', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + DIFY_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      inputs: {},
      query: message,
      response_mode: 'blocking',
      user: userId || 'anonymous'
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Dify API error: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.answer || '応答を取得できませんでした';
}

// ── LINE 返信 ──
async function replyToLine(replyToken, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + LINE_ACCESS_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text: text.substring(0, 5000) }]
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LINE reply error: ${res.status} ${body}`);
  }
}

// ── サーバー起動 ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`YAMATO AI Bot running on port ${PORT}`);
});
