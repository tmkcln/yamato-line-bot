"""
analyze_line_history.py — LINE 全履歴データ分析スクリプト

目的:
    4ヶ月分のLINEエクスポートから統計・会話パターン・サンプルを抽出し、
    AIがアーキテクチャ設計を行うための素材（JSON + Markdown）を生成する。

Usage:
    python scripts/line_bot/analyze_line_history.py
    python scripts/line_bot/analyze_line_history.py --input "path/to/line.txt"

出力:
    output/misc/line_history_stats.json  — 機械可読な集計データ
    output/misc/line_history_stats.md   — AI分析用Markdownサマリー（~5000文字）
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

# paths モジュール解決
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from paths import OUTPUT_DIR

# ── 定数 ──────────────────────────────────────────────
DEFAULT_INPUT = r"C:\Users\Otake_DELL\Downloads\[LINE]【富浦館山】スタートステイ様×KHR 現場連絡用.txt"
FACILITY_NAME = "富浦館山"

THREAD_GAP_MIN = 5        # 会話スレッドの区切り（分）
MAX_THREAD_SAMPLES = 8    # 出力するスレッドサンプル数
MAX_MSG_SAMPLES    = 30   # 各カテゴリのサンプルメッセージ数
MAX_MD_CHARS       = 6000 # Markdownサマリーの最大文字数

# index.js と同一 NOISE パターン
NOISE_PATTERN = re.compile(
    r"^(お疲れ様|おつかれ様|お疲れ様です|おつかれさまです|おつかれ|承知しました|承知いたしました|"
    r"承知です|かしこまりました|かしこまりです|ありがとうございます|ありがとうございました|"
    r"ご対応ありがとう|了解です|了解しました|了解いたしました|わかりました|はい、|はーい|"
    r"よろしくお願いします).{0,20}$",
    re.UNICODE,
)

SKIP_PATTERN = re.compile(
    r"^\[?画像\]?$|^\[?スタンプ\]?$|^\[?ビデオ\]?$|^\[?ファイル\]?$|^\[送信取消\]$|"
    r"^\[削除されたメッセージ\]$|^アルバム「|^「.+」の写真|^グループ通話|^\[不明\]$",
    re.UNICODE,
)

SYSTEM_KEYWORDS = [
    "のアルバム「", "をグループに追加しました", "がグループを退会しました",
    "のコンテンツを削除しました", "のアルバムを削除しました",
    "アルバムに", "件のコンテンツを追加",
]

# キーワードベースの簡易カテゴリ推定（Gemini未使用・統計用）
KEYWORD_CATEGORY = {
    "ATTENDANCE":      ["出勤", "退勤", "業務開始", "業務終了", "シフト", "休み", "遅刻", "早退"],
    "FACILITY_ISSUE":  ["故障", "壊れ", "不具合", "修理", "エアコン", "お風呂", "鍵", "ドア", "漏れ", "詰まり", "電源", "カメラ", "充電"],
    "CLEANING":        ["清掃", "掃除", "チェックアウト", "退室", "アルバム"],
    "BOOKING":         ["チェックイン", "到着", "予約", "様", "ゲスト", "入室", "連泊", "延泊"],
    "INVENTORY":       ["在庫", "残り", "補充", "発注", "足りない", "タオル", "スリッパ", "備品"],
    "LOST_FOUND":      ["忘れ物", "落とし物", "拾った", "置き忘れ"],
    "CHARGE":          ["課金", "料金", "追加", "BBQ", "焼肉", "サウナ"],
}


# ── データクラス ──────────────────────────────────────
@dataclass
class LineMessage:
    date: str           # "2026-01-15"
    time: str           # "09:30"
    sender: str
    text: str
    skipped: bool = False    # 画像・システムメッセージ
    is_noise: bool = False   # NOISEパターン
    est_category: str = "OTHER"  # キーワード推定カテゴリ

    @property
    def datetime_str(self) -> str:
        return f"{self.date} {self.time}"

    def to_minutes(self) -> int:
        h, m = map(int, self.time.split(":"))
        return h * 60 + m


@dataclass
class Thread:
    date: str
    messages: list[LineMessage] = field(default_factory=list)

    def summary(self) -> str:
        lines = [f"[{m.time}] {m.sender}: {m.text[:60]}" for m in self.messages]
        return "\n".join(lines)


# ── パーサー ──────────────────────────────────────────
def is_system_message(text: str) -> bool:
    return any(k in text for k in SYSTEM_KEYWORDS)


def estimate_category(text: str) -> str:
    for cat, keywords in KEYWORD_CATEGORY.items():
        if any(k in text for k in keywords):
            return cat
    return "OTHER"


def parse_all(filepath: str) -> list[LineMessage]:
    """全日付のメッセージを解析して返す。"""
    DATE_RE = re.compile(r"^(\d{4})\.(\d{2})\.(\d{2})")
    TIME_RE = re.compile(r"^(\d{1,2}:\d{2}) ")

    messages: list[LineMessage] = []
    current_date = ""

    with open(filepath, encoding="utf-8") as f:
        lines = f.readlines()

    for line in lines:
        line = line.rstrip("\n").rstrip("\r")

        dm = DATE_RE.match(line)
        if dm:
            current_date = f"{dm.group(1)}-{dm.group(2)}-{dm.group(3)}"
            continue

        if not current_date:
            continue

        tm = TIME_RE.match(line)
        if tm:
            rest = line[len(tm.group(0)):]
            sp = rest.find(" ")
            if sp == -1:
                continue
            time_str = tm.group(1)
            sender = rest[:sp]
            text = rest[sp + 1:].strip()
            if not text:
                continue

            skipped = bool(SKIP_PATTERN.match(text)) or is_system_message(text)
            is_noise = not skipped and bool(NOISE_PATTERN.match(text))
            est_cat = estimate_category(text) if not skipped and not is_noise else "SKIP"

            messages.append(LineMessage(
                date=current_date,
                time=time_str,
                sender=sender,
                text=text,
                skipped=skipped,
                is_noise=is_noise,
                est_category=est_cat,
            ))
        else:
            # 複数行メッセージの継続
            if messages and not messages[-1].skipped and line.strip():
                messages[-1].text += "\n" + line.strip()

    return messages


# ── スレッドグルーピング ──────────────────────────────
def extract_threads(messages: list[LineMessage], gap_min: int = THREAD_GAP_MIN) -> list[Thread]:
    """gap_min 分以上間隔があいたら新スレッドとみなす。"""
    threads: list[Thread] = []
    current: Optional[Thread] = None

    for msg in messages:
        if msg.skipped or msg.is_noise:
            continue
        if current is None or msg.date != current.date:
            current = Thread(date=msg.date, messages=[msg])
            threads.append(current)
        else:
            prev_min = current.messages[-1].to_minutes()
            if msg.to_minutes() - prev_min > gap_min:
                current = Thread(date=msg.date, messages=[msg])
                threads.append(current)
            else:
                current.messages.append(msg)

    return [t for t in threads if len(t.messages) >= 2]


# ── 統計集計 ──────────────────────────────────────────
def compute_stats(messages: list[LineMessage]) -> dict:
    total = len(messages)
    skipped = [m for m in messages if m.skipped]
    noise   = [m for m in messages if m.is_noise]
    texts   = [m for m in messages if not m.skipped and not m.is_noise]

    dates   = sorted({m.date for m in messages})
    senders = defaultdict(int)
    cat_counts = defaultdict(int)
    lengths = []

    for m in texts:
        senders[m.sender] += 1
        cat_counts[m.est_category] += 1
        lengths.append(len(m.text))

    # メッセージ長分布
    short  = sum(1 for l in lengths if l <= 20)
    medium = sum(1 for l in lengths if 20 < l <= 80)
    long_  = sum(1 for l in lengths if l > 80)

    # サンプルメッセージ（カテゴリ別）
    samples: dict[str, list[str]] = {}
    for cat in KEYWORD_CATEGORY:
        msgs = [m for m in texts if m.est_category == cat]
        samples[cat] = [f"[{m.date} {m.time}] {m.sender}: {m.text[:100]}" for m in msgs[:MAX_MSG_SAMPLES]]

    return {
        "date_range": {"start": dates[0] if dates else "", "end": dates[-1] if dates else ""},
        "total_days": len(dates),
        "total_messages": total,
        "skipped_media": len(skipped),
        "noise_filtered": len(noise),
        "text_messages": len(texts),
        "noise_rate_pct": round(len(noise) / max(total, 1) * 100, 1),
        "skip_rate_pct":  round(len(skipped) / max(total, 1) * 100, 1),
        "senders": dict(sorted(senders.items(), key=lambda x: -x[1])),
        "category_distribution": dict(sorted(cat_counts.items(), key=lambda x: -x[1])),
        "message_length": {
            "short_le20":   short,
            "medium_21_80": medium,
            "long_gt80":    long_,
            "avg_chars":    round(sum(lengths) / max(len(lengths), 1), 1),
        },
        "samples_by_category": samples,
    }


# ── Markdown生成 ──────────────────────────────────────
def build_markdown(stats: dict, threads: list[Thread]) -> str:
    s = stats
    lines = []

    lines.append("# LINE グループ メッセージ分析サマリー")
    lines.append(f"## 対象: 富浦館山 現場連絡用グループ\n")

    lines.append("## 1. 基本統計\n")
    lines.append(f"- 分析期間: {s['date_range']['start']} 〜 {s['date_range']['end']}（{s['total_days']}日間）")
    lines.append(f"- 総メッセージ数: {s['total_messages']}件")
    lines.append(f"- 内訳:")
    lines.append(f"  - 画像・システム行（スキップ）: {s['skipped_media']}件（{s['skip_rate_pct']}%）")
    lines.append(f"  - NOISEパターン（挨拶・返事のみ）: {s['noise_filtered']}件（{s['noise_rate_pct']}%）")
    lines.append(f"  - テキスト分析対象: {s['text_messages']}件\n")

    lines.append("## 2. 送信者別件数\n")
    for sender, cnt in list(s["senders"].items())[:10]:
        lines.append(f"- {sender}: {cnt}件")
    lines.append("")

    lines.append("## 3. キーワードベース カテゴリ分布（推定）\n")
    lines.append("※ Geminiによる正確な分類ではなくキーワードマッチング。傾向把握用。\n")
    for cat, cnt in s["category_distribution"].items():
        lines.append(f"- {cat}: {cnt}件")
    lines.append("")

    lines.append("## 4. メッセージ長分布\n")
    ml = s["message_length"]
    lines.append(f"- 短文（〜20文字）: {ml['short_le20']}件")
    lines.append(f"- 中文（21〜80文字）: {ml['medium_21_80']}件")
    lines.append(f"- 長文（81文字〜）: {ml['long_gt80']}件")
    lines.append(f"- 平均: {ml['avg_chars']}文字\n")

    lines.append("## 5. 会話スレッドサンプル（5分以内の連続発言をスレッドとみなす）\n")
    lines.append("※ 文脈が失われるケースの実例。システム設計の参考にしてください。\n")

    # 複数人が発言しているスレッドを優先してサンプリング
    multi_threads = [t for t in threads if len({m.sender for m in t.messages}) >= 2]
    sample_threads = multi_threads[:MAX_THREAD_SAMPLES]

    for i, thread in enumerate(sample_threads, 1):
        lines.append(f"### スレッド {i}（{thread.date}）")
        for m in thread.messages:
            lines.append(f"  [{m.time}] **{m.sender}**: {m.text[:80]}")
        lines.append("")

    lines.append("## 6. カテゴリ別サンプルメッセージ\n")
    for cat, msgs in s["samples_by_category"].items():
        if not msgs:
            continue
        lines.append(f"### {cat}")
        for msg in msgs[:8]:
            lines.append(f"- {msg}")
        lines.append("")

    md = "\n".join(lines)
    # 文字数制限
    if len(md) > MAX_MD_CHARS:
        md = md[:MAX_MD_CHARS] + "\n\n（...文字数制限により省略）"
    return md


# ── AI設計依頼プロンプト ──────────────────────────────
def build_ai_prompt(md_summary: str) -> str:
    return f"""あなたはシステム設計の専門家です。

以下は日本の宿泊施設（民泊・バケーションレンタル）の現場スタッフが
使っているLINEグループ 4ヶ月分のメッセージ統計と実例サンプルです。

=== LINE グループ分析データ ===
{md_summary}
=== ここまで ===

このLINEグループに自動分類・自動レポートBotを稼働させています。
現在の課題を解決する最適なアーキテクチャを設計してください。

## 現在の実装
- Node.js（Railway）がWebhookでメッセージを受信
- NOISEパターンを正規表現でフィルタリング
- 残りのメッセージをGeminiに1件ずつ送って分類（11カテゴリ）
- 分類結果をGoogle Sheetsに記録
- 重要案件はSlackにリアルタイム通知
- 毎日21:00にGASがSheets集計→Slack日次サマリー送信

## 解決したい課題
1. **文脈の喪失**: 1メッセージ単位の逐次分類では会話の流れが読めない
   - 例:「上と下逆になっています」→ 単体では意味不明、直前の「カメラの向き大丈夫ですか」があって初めて設備問題とわかる
   - 例:「はい、ありがとうございます」→ NOISE判定だが、設備問題の「解決済み」の意味を持つ場合がある
2. **日次サマリーの精度**: 現状は個別分類の集計に過ぎず、1日の運営の流れが見えない
3. **APIコスト制約**: Gemini無料枠（1,500 req/日）内に収めたい

## 設計に含めてほしいこと
1. メッセージ処理アーキテクチャ（リアルタイム処理 vs バッチ処理の最適な分担）
2. 文脈考慮の具体的な実装方法（スライディングウィンドウ・スレッド化・一括バッチ等）
3. 分類カテゴリの見直し提案（現行11カテゴリが適切か）
4. 日次サマリー生成フローの改善案
5. APIコスト試算と無料枠内での実現方法

具体的な実装イメージ（疑似コード・処理フロー図）を含めて回答してください。"""


# ── メイン ────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="LINE全履歴分析スクリプト")
    parser.add_argument("--input", default=DEFAULT_INPUT, help="LINE エクスポートファイルパス")
    args = parser.parse_args()

    out_dir = Path(OUTPUT_DIR) / "misc"
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[analyze] ファイル読み込み: {args.input}")
    messages = parse_all(args.input)
    print(f"[analyze] 総メッセージ数: {len(messages)}件")

    # 統計計算
    stats = compute_stats(messages)
    print(f"[analyze] 期間: {stats['date_range']['start']} 〜 {stats['date_range']['end']}（{stats['total_days']}日間）")
    print(f"[analyze] テキスト分析対象: {stats['text_messages']}件")

    # スレッド抽出
    threads = extract_threads(messages)
    print(f"[analyze] 抽出スレッド数: {len(threads)}件（複数人: {sum(1 for t in threads if len({m.sender for m in t.messages}) >= 2)}件）")

    # JSON出力
    json_path = out_dir / "line_history_stats.json"
    # samples_by_category は大きいのでJSONにも含める
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)
    print(f"[analyze] JSON → {json_path}")

    # Markdown出力
    md = build_markdown(stats, threads)
    md_path = out_dir / "line_history_stats.md"
    md_path.write_text(md, encoding="utf-8")
    print(f"[analyze] Markdown → {md_path}（{len(md)}文字）")

    # AI設計依頼プロンプト出力
    prompt = build_ai_prompt(md)
    prompt_path = out_dir / "ai_design_prompt.txt"
    prompt_path.write_text(prompt, encoding="utf-8")
    print(f"[analyze] AIプロンプト → {prompt_path}")

    # サマリー表示
    print("\n=== 統計サマリー ===")
    print(f"総メッセージ: {stats['total_messages']}件 / {stats['total_days']}日間")
    print(f"  スキップ（画像等）: {stats['skipped_media']}件 ({stats['skip_rate_pct']}%)")
    print(f"  NOISE（挨拶等）:   {stats['noise_filtered']}件 ({stats['noise_rate_pct']}%)")
    print(f"  分析対象テキスト:  {stats['text_messages']}件")
    print(f"\nカテゴリ分布（キーワード推定）:")
    for cat, cnt in stats["category_distribution"].items():
        print(f"  {cat}: {cnt}件")
    print(f"\n次のステップ:")
    print(f"  Grok: python scripts/orchestrator/grok_query.py --quality high \"$(cat {prompt_path})\"")
    print(f"  Gemini: python scripts/orchestrator/gemini_query.py \"$(cat {prompt_path})\"")


if __name__ == "__main__":
    main()
