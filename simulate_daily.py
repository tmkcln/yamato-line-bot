"""
simulate_daily.py — LINE Bot エミュレーション
実際の LINE エクスポートファイルから指定日のメッセージを処理し、
Bot が本番稼働していた場合の動作を再現して HTML レポートを出力する。

Usage:
    python scripts/line_bot/simulate_daily.py
    python scripts/line_bot/simulate_daily.py --date 2026-04-04 --input "path/to/line.txt"
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

# paths モジュール解決
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from paths import ENV_FILE, OUTPUT_DIR

# ── 定数 ──────────────────────────────────────────────
DEFAULT_INPUT  = r"C:\Users\Otake_DELL\Downloads\[LINE]【富浦館山】スタートステイ様×KHR 現場連絡用0404.txt"
DEFAULT_DATE   = "2026-04-04"
FACILITY_NAME  = "富浦館山"
GEMINI_MODEL   = "gemini-2.5-flash"
API_SLEEP_SEC  = 0.5   # レート制限対策

# index.js の NOISE_REGEX と同一
NOISE_PATTERN = re.compile(
    r"^(お疲れ様|おつかれ様|お疲れ様です|おつかれさまです|おつかれ|承知しました|承知いたしました|"
    r"承知です|かしこまりました|かしこまりです|ありがとうございます|ありがとうございました|"
    r"ご対応ありがとう|了解です|了解しました|了解いたしました|わかりました|はい、|はーい|"
    r"よろしくお願いします).{0,20}$",
    re.UNICODE,
)

# 除外対象の行パターン（画像・スタンプ・アルバム操作等）
SKIP_PATTERN = re.compile(
    r"^\[?画像\]?$|^\[?スタンプ\]?$|^\[?ビデオ\]?$|^\[?ファイル\]?$|^\[送信取消\]$|"
    r"^\[削除されたメッセージ\]$|^アルバム「|^「.+」の写真|^グループ通話|^\[不明\]$",
    re.UNICODE,
)

def is_system_message(text: str) -> bool:
    """LINEシステムメッセージ（アルバム操作等）を判定する。"""
    keywords = ["のアルバム「", "をグループに追加しました", "がグループを退会しました",
                "のコンテンツを削除しました", "のアルバムを削除しました",
                "アルバムに", "件のコンテンツを追加"]
    return any(k in text for k in keywords)

# index.js から移植したシステムプロンプト
GEMINI_SYSTEM_PROMPT = """あなたは宿泊施設運営のLINEグループメッセージを自動分類するAIです。

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
2. JSONは必ず1行で出力すること（改行・インデント・コードブロック不要）
3. 画像のみのメッセージ → category: NOISE, action: ignore
4. 「課金」を含む場合は必ず品目・数量を分解してitemsに格納する
5. ATTENDANCEの時刻は必ずHH:MM形式で抽出する
6. summaryは必ず日本語で記述する
7. urgencyはcritical/high/medium/low/noneのいずれかのみ"""


# ── データクラス ──────────────────────────────────────
@dataclass
class LineMessage:
    time: str
    sender: str
    text: str
    noise_filtered: bool = False
    skipped: bool = False
    result: dict = field(default_factory=dict)
    error: str = ""


# ── LINE ファイルパース ──────────────────────────────
def parse_line_export(filepath: str, target_date: str) -> list[LineMessage]:
    """LINE エクスポートファイルから指定日のメッセージを抽出する。

    LINE エクスポート形式:
      - 日付行: "YYYY.MM.DD 曜日" (例: 2026.04.04 土曜日)
      - メッセージ行: "HH:MM 送信者名 メッセージ本文" (スペース区切り)
      - 複数行メッセージ: 時刻なしの行は直前のメッセージの続き
    """
    date_dot = target_date.replace("-", ".")  # "2026.04.04"
    TIME_RE  = re.compile(r"^(\d{1,2}:\d{2}) (.+?) (.+)$")
    DATE_RE  = re.compile(r"^\d{4}\.\d{2}\.\d{2}")

    in_target = False
    messages: list[LineMessage] = []

    with open(filepath, encoding="utf-8") as f:
        lines = f.readlines()

    for line in lines:
        line = line.rstrip("\n").rstrip("\r")

        # 日付セパレータ検出
        if DATE_RE.match(line):
            in_target = line.startswith(date_dot)
            continue

        if not in_target:
            continue

        # メッセージ行: "HH:MM 送信者 メッセージ"（スペース2個区切り）
        # 送信者名は通常スペースを含まないが、最初の2スペースで分割
        m = re.match(r"^(\d{1,2}:\d{2}) ", line)
        if m:
            rest = line[len(m.group(0)):]
            # 送信者名は最初のスペースまで
            sp = rest.find(" ")
            if sp == -1:
                continue  # 送信者のみで本文なし（通常発生しない）
            time_str = m.group(1)
            sender   = rest[:sp]
            text     = rest[sp+1:].strip()

            if not text:
                continue

            # スキップ対象（画像・スタンプ・アルバム操作・システムメッセージ等）
            if SKIP_PATTERN.match(text) or is_system_message(text):
                messages.append(LineMessage(time=time_str, sender=sender, text=text, skipped=True))
            else:
                messages.append(LineMessage(time=time_str, sender=sender, text=text))
        else:
            # 時刻なし行 → 直前メッセージへの継続（複数行メッセージ）
            if messages and not messages[-1].skipped and line.strip():
                messages[-1].text += "\n" + line.strip()

    return messages


# ── Gemini 呼び出し ──────────────────────────────────
def load_api_key() -> str:
    try:
        from dotenv import load_dotenv
        load_dotenv(ENV_FILE)
    except ImportError:
        pass
    key = os.environ.get("GEMINI_API_KEY", "")
    if not key:
        print("ERROR: GEMINI_API_KEY が未設定です", file=sys.stderr)
        sys.exit(1)
    return key


def classify_message(client, model: str, facility: str, sender: str, text: str) -> dict:
    """Gemini でメッセージを分類し、JSONを返す。"""
    from google.genai import types  # type: ignore[import-untyped]

    # 複数行メッセージの改行を空白に変換（Gemini JSON出力の改行混入を防ぐ）
    text_normalized = text.replace("\n", " ").replace("\r", " ")
    context = f"[グループ: {facility}] [送信者: {sender}]\n{text_normalized}"

    response = client.models.generate_content(
        model=model,
        contents=context,
        config=types.GenerateContentConfig(
            system_instruction=GEMINI_SYSTEM_PROMPT,
            temperature=0.1,
            max_output_tokens=1024,
            thinking_config=types.ThinkingConfig(thinking_budget=0),  # thinking無効化
        ),
    )
    raw = response.text.strip()
    # DEBUG: 最初の3回だけ生レスポンスを表示
    if not hasattr(classify_message, '_debug_count'):
        classify_message._debug_count = 0
    classify_message._debug_count += 1
    if classify_message._debug_count <= 3:
        safe = repr(raw[:200]).encode("cp932", errors="replace").decode("cp932")
        print(f"  [RAW] {safe}")
    # コードブロック除去
    raw = re.sub(r"```json\n?|\n?```", "", raw).strip()
    # 先頭の { から末尾の } までを抽出（余分なテキストがある場合の対策）
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if m:
        raw = m.group(0)
    return json.loads(raw)


# ── 分類処理 ──────────────────────────────────────────
def process_messages(messages: list[LineMessage], facility: str) -> list[LineMessage]:
    """NOISEフィルタ → Gemini分類を実行する。"""
    from google import genai  # type: ignore[import-untyped]

    api_key = load_api_key()
    client  = genai.Client(api_key=api_key)

    ai_targets = [m for m in messages if not m.skipped]
    total_ai   = sum(1 for m in ai_targets if not NOISE_PATTERN.match(m.text))

    print(f"[simulate] 対象メッセージ: {len(ai_targets)}件 / スキップ(画像等): {len(messages) - len(ai_targets)}件")
    print(f"[simulate] NOISEフィルタ後 AI送信予定: {total_ai}件")

    ai_count = 0
    for msg in messages:
        if msg.skipped:
            msg.result = {"category": "SKIP", "action": "skip", "summary": "画像・スタンプ・アルバム操作"}
            continue

        # NOISE 事前フィルタ
        if NOISE_PATTERN.match(msg.text):
            msg.noise_filtered = True
            msg.result = {"category": "NOISE", "subcategory": "acknowledgment", "urgency": "none",
                          "action": "ignore", "summary": "NOISEフィルタで除外（定型文）", "structured_data": {}}
            continue

        # Gemini 分類
        ai_count += 1
        preview = msg.text[:40].encode("cp932", errors="replace").decode("cp932")
        print(f"[simulate] Gemini {ai_count}/{total_ai}: {msg.time} {msg.sender} / {preview}")
        try:
            msg.result = classify_message(client, GEMINI_MODEL, facility, msg.sender, msg.text)
        except Exception as e:
            msg.error = str(e)
            err_short = str(e)[:120].encode("cp932", errors="replace").decode("cp932")
            print(f"  [ERROR] {err_short}")
            msg.result = {"category": "ERROR", "action": "ignore", "summary": f"分類エラー: {e}"}
        time.sleep(API_SLEEP_SEC)

    return messages


# ── Sheets シミュレート ───────────────────────────────
def build_sheet_data(messages: list[LineMessage], date: str) -> dict[str, list[dict]]:
    """各シートに入るはずのデータを構築する。"""
    sheets: dict[str, list[dict]] = {
        "設備不具合": [], "課金": [], "忘れ物": [], "在庫": [], "出退勤": [],
    }

    for msg in messages:
        if msg.skipped or not msg.result:
            continue
        cat = msg.result.get("category", "")
        sd  = msg.result.get("structured_data", {}) or {}
        ts  = f"{date} {msg.time}"

        if cat == "FACILITY_ISSUE":
            sheets["設備不具合"].append({
                "報告日時": ts, "施設名": FACILITY_NAME, "報告者": msg.sender,
                "対象設備": sd.get("equipment", ""),
                "場所": sd.get("location", ""),
                "症状": sd.get("symptom", msg.result.get("summary", "")),
                "緊急度": msg.result.get("urgency", ""),
                "ステータス": "open",
            })
        elif cat == "CHARGE":
            items = sd.get("items") or [{"name": msg.result.get("summary", ""), "quantity": ""}]
            for item in items:
                sheets["課金"].append({
                    "報告日時": ts, "施設名": FACILITY_NAME, "報告者": msg.sender,
                    "品目": item.get("name", ""),
                    "数量": item.get("quantity", ""),
                    "修正フラグ": "TRUE" if sd.get("is_correction") else "FALSE",
                })
        elif cat == "LOST_FOUND":
            sheets["忘れ物"].append({
                "報告日時": ts, "施設名": FACILITY_NAME, "報告者": msg.sender,
                "品目": sd.get("item", msg.result.get("summary", "")),
                "ステータス": sd.get("status", "found"),
            })
        elif cat == "INVENTORY":
            sheets["在庫"].append({
                "報告日時": ts, "施設名": FACILITY_NAME, "報告者": msg.sender,
                "品目": sd.get("item", ""),
                "残数": sd.get("remaining", ""),
                "単位": sd.get("unit", ""),
                "賞味期限": sd.get("expiry_date", ""),
            })
        elif cat == "ATTENDANCE":
            sheets["出退勤"].append({
                "日付": date, "施設名": FACILITY_NAME, "スタッフ名": msg.sender,
                "種別": sd.get("type", ""),
                "時刻": sd.get("time", msg.time),
                "備考": sd.get("note", ""),
            })

    return sheets


# ── DailySummary Slack メッセージ構築 ─────────────────
def build_slack_preview(sheets: dict[str, list[dict]], date: str) -> str:
    lines = []
    lines.append(f"📊 *日次レポート* | {date}（{get_day_of_week(date)}）")
    lines.append(f"稼働施設: 1施設（{FACILITY_NAME}）")
    lines.append("━━━━━━━━━━━━━━━━━━")
    lines.append(f"\n*【{FACILITY_NAME}】*")

    # 設備不具合
    fac = sheets["設備不具合"]
    if fac:
        for r in fac:
            urg = r["緊急度"]
            emoji = "🔴" if urg == "critical" else "🟠" if urg == "high" else "🟡" if urg == "medium" else "⚪"
            loc = f"（{r['場所']}）" if r.get("場所") else ""
            lines.append(f"  🔧 {emoji} {r['対象設備']}{loc} — {r['症状']} [未解決]")
        open_cnt = len(fac)
        if open_cnt:
            lines.append(f"    📌 未解決 {open_cnt}件")
    # 課金
    chg = sheets["課金"]
    if chg:
        summary: dict[str, int] = defaultdict(int)
        for r in chg:
            qty = int(r["数量"]) if str(r["数量"]).isdigit() else 0
            summary[r["品目"]] += -qty if r["修正フラグ"] == "TRUE" else qty
        items_str = "、".join(f"{k}×{v}" for k, v in summary.items() if v > 0)
        if items_str:
            lines.append(f"  💰 課金: {items_str}")
    # 忘れ物
    lost = sheets["忘れ物"]
    if lost:
        for r in lost:
            lines.append(f"  🔍 忘れ物: {r['品目']}（{r['ステータス']}）")
    # 在庫
    inv = sheets["在庫"]
    if inv:
        for r in inv:
            exp = f" ⚠️期限:{r['賞味期限']}" if r.get("賞味期限") else ""
            lines.append(f"  📦 在庫: {r['品目']} 残{r['残数']}{r['単位']}{exp}")

    if not any([fac, chg, lost, inv]):
        lines.append("  特記事項なし ✅")

    lines.append("\n━━━━━━━━━━━━━━━━━━")
    lines.append("\n🤖 *AI総評*")
    lines.append("（実際の運用時はここに Gemini が生成した150字の総評が入ります）")
    lines.append("━━━━━━━━━━━━━━━━━━")
    lines.append(f"_集計時刻: {date} 21:00 | YAMATO AI Bot v3.1_")
    return "\n".join(lines)


def get_day_of_week(date_str: str) -> str:
    days = ["月", "火", "水", "木", "金", "土", "日"]
    return days[datetime.strptime(date_str, "%Y-%m-%d").weekday()]


# ── カテゴリ別集計 ────────────────────────────────────
def count_categories(messages: list[LineMessage]) -> dict[str, int]:
    counts: dict[str, int] = defaultdict(int)
    for m in messages:
        cat = m.result.get("category", "SKIP") if m.result else "SKIP"
        counts[cat] += 1
    return dict(sorted(counts.items(), key=lambda x: -x[1]))


# ── HTML 生成 ─────────────────────────────────────────
CATEGORY_COLORS = {
    "NOISE":         ("#6B7280", "#F3F4F6"),
    "ATTENDANCE":    ("#2E5C8A", "#EEF2F7"),
    "FACILITY_ISSUE":("#DC2626", "#FEF2F2"),
    "CHARGE":        ("#D97706", "#FFFBEB"),
    "CLEANING":      ("#059669", "#ECFDF5"),
    "BOOKING":       ("#7C3AED", "#F5F3FF"),
    "INVENTORY":     ("#EA580C", "#FFF7ED"),
    "LOST_FOUND":    ("#0891B2", "#ECFEFF"),
    "SHIFT":         ("#0D9488", "#F0FDFA"),
    "PENDING_LIST":  ("#DC2626", "#FEF2F2"),
    "QUESTION":      ("#4F46E5", "#EEF2FF"),
    "SKIP":          ("#9CA3AF", "#F9FAFB"),
    "ERROR":         ("#EF4444", "#FEF2F2"),
}

ACTION_LABELS = {
    "ignore":         ("ignore",         "#6B7280"),
    "log_structured": ("log",            "#2E5C8A"),
    "notify_slack":   ("notify",         "#D97706"),
    "notify_and_log": ("notify+log",     "#DC2626"),
    "skip":           ("skip",           "#9CA3AF"),
}

URGENCY_EMOJI = {
    "critical": "🔴", "high": "🟠", "medium": "🟡", "low": "⚪", "none": "",
}


def render_html(messages: list[LineMessage], sheets: dict[str, list[dict]],
                slack_preview: str, cat_counts: dict[str, int],
                date: str, facility: str) -> str:

    total   = len(messages)
    skipped = sum(1 for m in messages if m.skipped)
    noise   = sum(1 for m in messages if m.noise_filtered)
    ai_sent = total - skipped - noise

    # ── サマリーカード ──
    summary_cards = f"""
<div class="stats-row">
  <div class="stat-card"><div class="stat-num">{total}</div><div class="stat-label">総行数</div></div>
  <div class="stat-card skip"><div class="stat-num">{skipped}</div><div class="stat-label">画像・スタンプ除外</div></div>
  <div class="stat-card noise"><div class="stat-num">{noise}</div><div class="stat-label">NOISEフィルタ</div></div>
  <div class="stat-card ai"><div class="stat-num">{ai_sent}</div><div class="stat-label">AI判定</div></div>
</div>
"""

    # カテゴリ集計バー
    cat_rows = ""
    for cat, cnt in cat_counts.items():
        color, bg = CATEGORY_COLORS.get(cat, ("#6B7280", "#F9FAFB"))
        pct = round(cnt / total * 100) if total else 0
        cat_rows += f"""
<div class="cat-row">
  <span class="cat-badge" style="background:{bg};color:{color};border:1px solid {color}20">{cat}</span>
  <div class="cat-bar-wrap"><div class="cat-bar" style="width:{pct}%;background:{color}40;border-right:3px solid {color}"></div></div>
  <span class="cat-cnt">{cnt}件</span>
</div>"""

    # ── メッセージ分類テーブル ──
    msg_rows = ""
    for m in messages:
        cat    = m.result.get("category", "SKIP") if m.result else "SKIP"
        action = m.result.get("action", "skip")    if m.result else "skip"
        summary = m.result.get("summary", "")      if m.result else ""
        urgency = m.result.get("urgency", "")      if m.result else ""

        color, bg = CATEGORY_COLORS.get(cat, ("#6B7280", "#F9FAFB"))
        act_label, act_color = ACTION_LABELS.get(action, (action, "#6B7280"))
        urg_emoji = URGENCY_EMOJI.get(urgency, "")

        text_escaped = m.text.replace("<", "&lt;").replace(">", "&gt;")
        summary_escaped = summary.replace("<", "&lt;").replace(">", "&gt;")

        row_bg = "#FEF2F2" if m.error else ("#F9FAFB" if m.skipped or m.noise_filtered else "#FFFFFF")

        msg_rows += f"""
<tr style="background:{row_bg}">
  <td class="td-time">{m.time}</td>
  <td class="td-sender">{m.sender}</td>
  <td class="td-text">{text_escaped}</td>
  <td><span class="badge" style="background:{bg};color:{color};border:1px solid {color}30">{cat}</span></td>
  <td><span class="badge-action" style="color:{act_color}">{act_label}</span></td>
  <td class="td-summary">{urg_emoji} {summary_escaped}</td>
</tr>"""

    # ── Sheets テーブル ──
    sheet_sections = ""
    sheet_icons = {"設備不具合": "🔧", "課金": "💰", "忘れ物": "🔍", "在庫": "📦", "出退勤": "👥"}
    for sheet_name, rows in sheets.items():
        if not rows:
            sheet_sections += f"""
<div class="sheet-empty">
  <span>{sheet_icons.get(sheet_name,'')} {sheet_name}</span>
  <span style="color:#9CA3AF;margin-left:12px">本日の記録なし</span>
</div>"""
            continue

        headers = list(rows[0].keys())
        header_cells = "".join(f"<th>{h}</th>" for h in headers)
        data_rows = ""
        for i, row in enumerate(rows):
            bg = "#EEF2F7" if i % 2 == 0 else "#FFFFFF"
            cells = "".join(f"<td>{str(row.get(h,'')).replace('<','&lt;')}</td>" for h in headers)
            data_rows += f"<tr style='background:{bg}'>{cells}</tr>"

        sheet_sections += f"""
<div class="subsection">
  <div class="subsection-header">{sheet_icons.get(sheet_name,'')} {sheet_name} <span class="cnt-badge">{len(rows)}件</span></div>
  <table class="data-table"><thead><tr>{header_cells}</tr></thead><tbody>{data_rows}</tbody></table>
</div>"""

    # ── Slack プレビュー ──
    slack_lines_html = slack_preview.replace("<", "&lt;").replace(">", "&gt;").replace("\n", "<br>")
    slack_lines_html = re.sub(r"\*(.+?)\*", r"<strong>\1</strong>", slack_lines_html)

    # ── HTML 組み立て ──
    return f"""<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LINE Bot シミュレーション — {facility} {date}</title>
<style>
*, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
body {{
  font-family: '游ゴシック', 'Yu Gothic', 'Noto Sans JP', sans-serif;
  background: #FFFFFF; color: #1A1A2E; font-size: 13px; line-height: 1.6;
}}
.page {{ max-width: 1100px; margin: 0 auto; padding: 0 28px 80px; }}
.page-header {{
  background: #1E3A5F; color: #fff;
  padding: 24px 28px 20px; margin: 0 -28px 40px;
}}
.page-header .label {{ font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: #93b4d4; margin-bottom: 4px; }}
.page-header h1 {{ font-size: 20px; font-weight: 700; }}
.page-header .meta {{ font-size: 11px; color: #93b4d4; margin-top: 4px; display:flex; gap:16px; flex-wrap:wrap; }}
.section {{ margin-bottom: 40px; }}
.section-header {{
  background: #1E3A5F; color: #fff; padding: 9px 18px;
  border-radius: 4px 4px 0 0; display:flex; align-items:baseline; gap:10px;
}}
.section-header .en {{ font-size: 9px; letter-spacing: .12em; text-transform: uppercase; color: #93b4d4; }}
.section-header .ja {{ font-size: 14px; font-weight: 700; }}
.section-body {{
  border: 1px solid #dce6f0; border-top: none;
  border-radius: 0 0 4px 4px; padding: 20px; background: #fff;
}}
/* サマリーカード */
.stats-row {{ display:flex; gap:12px; flex-wrap:wrap; }}
.stat-card {{
  flex:1; min-width:110px; background:#EEF2F7; border-radius:8px;
  padding:16px; text-align:center; border-top:3px solid #2E5C8A;
}}
.stat-card.skip {{ border-top-color:#9CA3AF; }}
.stat-card.noise {{ border-top-color:#6B7280; }}
.stat-card.ai {{ border-top-color:#0891B2; background:#ECFEFF; }}
.stat-num {{ font-size:28px; font-weight:700; color:#1E3A5F; }}
.stat-label {{ font-size:11px; color:#64748B; margin-top:4px; }}
/* カテゴリバー */
.cat-row {{ display:flex; align-items:center; gap:10px; margin-bottom:6px; }}
.cat-badge {{ font-size:10px; font-weight:700; padding:2px 8px; border-radius:4px; min-width:120px; text-align:center; }}
.cat-bar-wrap {{ flex:1; height:12px; background:#F1F5F9; border-radius:6px; overflow:hidden; }}
.cat-bar {{ height:100%; border-radius:6px; }}
.cat-cnt {{ font-size:11px; color:#64748B; min-width:30px; text-align:right; }}
/* テーブル */
.data-table {{ width:100%; border-collapse:collapse; font-size:12px; }}
.data-table th {{ background:#2E5C8A; color:#fff; padding:7px 10px; text-align:left; white-space:nowrap; }}
.data-table td {{ padding:6px 10px; border-bottom:1px solid #EEF2F7; vertical-align:top; }}
.td-time {{ white-space:nowrap; color:#64748B; width:48px; }}
.td-sender {{ white-space:nowrap; font-weight:600; width:100px; }}
.td-text {{ max-width:260px; word-break:break-all; }}
.td-summary {{ max-width:220px; word-break:break-all; color:#374151; }}
.badge {{ font-size:9px; font-weight:700; padding:2px 7px; border-radius:4px; white-space:nowrap; }}
.badge-action {{ font-size:10px; font-weight:700; }}
/* サブセクション */
.subsection {{ margin-bottom:20px; }}
.subsection-header {{
  background:#EEF2F7; color:#1E3A5F; font-weight:700; font-size:13px;
  padding:7px 14px; border-left:4px solid #2E5C8A; border-radius:0 4px 4px 0;
  margin-bottom:8px; display:flex; align-items:center; gap:8px;
}}
.cnt-badge {{ background:#2E5C8A; color:#fff; font-size:10px; padding:1px 7px; border-radius:10px; }}
.sheet-empty {{ padding:8px 14px; color:#9CA3AF; font-size:12px; border-left:3px solid #E5E7EB; margin-bottom:12px; }}
/* Slack プレビュー */
.slack-preview {{
  background:#1a1d21; color:#d1d2d3; padding:20px 24px;
  border-radius:8px; font-family:'Courier New', monospace; font-size:12px;
  line-height:1.8; border:1px solid #3f4349;
}}
.slack-preview strong {{ color:#ffffff; }}
</style>
</head>
<body>
<div class="page">

<div class="page-header">
  <div class="label">LINE Bot Simulation</div>
  <h1>シミュレーション結果 — {facility} / {date}</h1>
  <div class="meta">
    <span>対象グループ: {facility}</span>
    <span>対象日: {date}（{get_day_of_week(date)}）</span>
    <span>モデル: {GEMINI_MODEL}</span>
    <span>生成: {datetime.now().strftime("%Y-%m-%d %H:%M")}</span>
  </div>
</div>

<!-- 1. サマリー -->
<div class="section">
  <div class="section-header"><span class="ja">処理サマリー</span><span class="en">Message Statistics</span></div>
  <div class="section-body">
    {summary_cards}
    <div style="margin-top:20px">
      <div style="font-weight:700;margin-bottom:10px;color:#1E3A5F">カテゴリ分布</div>
      {cat_rows}
    </div>
  </div>
</div>

<!-- 2. 全メッセージ分類 -->
<div class="section">
  <div class="section-header"><span class="ja">全メッセージ分類テーブル</span><span class="en">Message Classification</span></div>
  <div class="section-body" style="padding:0;overflow-x:auto">
    <table class="data-table">
      <thead><tr><th>時刻</th><th>送信者</th><th>本文</th><th>カテゴリ</th><th>アクション</th><th>要約</th></tr></thead>
      <tbody>{msg_rows}</tbody>
    </table>
  </div>
</div>

<!-- 3. シミュレート Sheets データ -->
<div class="section">
  <div class="section-header"><span class="ja">シミュレート Google Sheets データ</span><span class="en">Simulated Sheets Records</span></div>
  <div class="section-body">
    {sheet_sections}
  </div>
</div>

<!-- 4. Slack サマリープレビュー -->
<div class="section">
  <div class="section-header"><span class="ja">21:00 Slack サマリー プレビュー</span><span class="en">DailySummary Preview</span></div>
  <div class="section-body">
    <p style="font-size:11px;color:#64748B;margin-bottom:12px">DailySummary.gs が毎日21:00に送信するSlackメッセージのプレビューです。</p>
    <div class="slack-preview">{slack_lines_html}</div>
  </div>
</div>

</div>
</body>
</html>"""


# ── エントリーポイント ────────────────────────────────
def main() -> None:
    parser = argparse.ArgumentParser(description="LINE Bot エミュレーション")
    parser.add_argument("--input",  default=DEFAULT_INPUT,  help="LINE エクスポートファイルパス")
    parser.add_argument("--date",   default=DEFAULT_DATE,   help="対象日 (YYYY-MM-DD)")
    parser.add_argument("--facility", default=FACILITY_NAME, help="施設名")
    args = parser.parse_args()

    out_path = Path(OUTPUT_DIR) / "misc" / f"simulate_{args.date.replace('-', '')}.html"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"[simulate] ファイル読み込み: {args.input}")
    messages = parse_line_export(args.input, args.date)
    print(f"[simulate] {args.date} のメッセージ: {len(messages)}行")

    print("[simulate] Gemini 分類開始...")
    messages = process_messages(messages, args.facility)

    cat_counts   = count_categories(messages)
    sheets       = build_sheet_data(messages, args.date)
    slack_preview = build_slack_preview(sheets, args.date)

    print("[simulate] HTML 生成...")
    html = render_html(messages, sheets, slack_preview, cat_counts, args.date, args.facility)
    out_path.write_text(html, encoding="utf-8")

    print(f"[simulate] 完了 → {out_path}")
    import subprocess
    subprocess.Popen(["start", "", str(out_path)], shell=True)


if __name__ == "__main__":
    main()
