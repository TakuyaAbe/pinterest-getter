#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.10"
# dependencies = ["requests"]
# ///
"""pinget - Pinterest board image downloader (original resolution).

Usage:
  uv run pinget.py <board-url> [options]      # URLを指定して取得
  uv run pinget.py --current [options]        # 今ブラウザで開いているボードを取得

Examples:
  uv run pinget.py https://www.pinterest.jp/user/board/            # ボード全体(サブボード込み)
  uv run pinget.py https://www.pinterest.jp/user/board/ --mode board     # ボード直下のピンのみ
  uv run pinget.py https://www.pinterest.jp/user/board/ --mode sections  # サブボード(セクション)のみ
  uv run pinget.py https://www.pinterest.jp/user/board/ --section "名前"  # 特定セクションのみ
  uv run pinget.py https://www.pinterest.jp/user/board/section/    # セクションURL直指定
  uv run pinget.py --current --list                                # セクション一覧だけ表示
"""

import argparse
import http.cookiejar
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote, urlsplit

import requests

API = "https://www.pinterest.com/resource/{name}/get/"
PAGE_SIZE = 250


def log(msg: str) -> None:
    print(msg, flush=True)


def sanitize(name: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", name).strip(" .")
    return name or "untitled"


class Pinterest:
    def __init__(self, cookies_file: str | None = None):
        self.s = requests.Session()
        self.s.headers.update(
            {
                "User-Agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0.0.0 Safari/537.36"
                ),
                "Accept": "application/json, text/javascript, */*, q=0.01",
                "Referer": "https://www.pinterest.com/",
                "X-Requested-With": "XMLHttpRequest",
                "X-Pinterest-AppState": "active",
                "X-Pinterest-PWS-Handler": "www/index.js",
            }
        )
        if cookies_file:
            jar = http.cookiejar.MozillaCookieJar(cookies_file)
            jar.load(ignore_discard=True, ignore_expires=True)
            self.s.cookies.update(jar)
        else:
            # APIはゲストCookie(csrftoken等)がないと403を返すため先に取得する
            self.s.get("https://www.pinterest.com/", timeout=30)

    def _get(self, name: str, options: dict, source_url: str = "/") -> dict:
        params = {
            "source_url": source_url,
            "data": json.dumps({"options": options, "context": {}}),
        }
        r = self.s.get(API.format(name=name), params=params, timeout=30)
        r.raise_for_status()
        return r.json()["resource_response"]

    def resource(self, name: str, options: dict, source_url: str = "/") -> dict:
        return self._get(name, options, source_url)["data"]

    def paged(self, name: str, options: dict, source_url: str = "/"):
        bookmark = None
        while True:
            opts = dict(options)
            if bookmark:
                opts["bookmarks"] = [bookmark]
            resp = self._get(name, opts, source_url)
            data = resp.get("data") or []
            yield from data
            bookmark = resp.get("bookmark")
            if not bookmark or bookmark == "-end-":
                break
            time.sleep(0.5)

    # --- Pinterest objects -------------------------------------------------

    def board(self, username: str, slug: str) -> dict:
        return self.resource(
            "BoardResource",
            {"username": username, "slug": slug, "field_set_key": "detailed"},
            source_url=f"/{quote(username)}/{quote(slug)}/",
        )

    def sections(self, board_id: str) -> list[dict]:
        return list(
            self.paged("BoardSectionsResource", {"board_id": board_id})
        )

    def board_pins(self, board: dict):
        return self.paged(
            "BoardFeedResource",
            {
                "board_id": board["id"],
                "board_url": board["url"],
                "page_size": PAGE_SIZE,
            },
            source_url=board["url"],
        )

    def section_pins(self, section_id: str):
        # このエンドポイントはpage_size上限が低い(100以上で400になる)
        return self.paged(
            "BoardSectionPinsResource",
            {"section_id": section_id, "page_size": 50},
        )


# --- image extraction -------------------------------------------------------


def best_image(images: dict) -> str | None:
    if not images:
        return None
    if "orig" in images:
        return images["orig"]["url"]
    # fall back to the largest variant available
    def size(item):
        return (item[1].get("width") or 0) * (item[1].get("height") or 0)

    return max(images.items(), key=size)[1]["url"]


def pin_image_urls(pin: dict) -> list[str]:
    """Return original-resolution image URLs for a pin (carousel/story aware)."""
    urls: list[str] = []

    carousel = (pin.get("carousel_data") or {}).get("carousel_slots") or []
    for slot in carousel:
        u = best_image(slot.get("images") or {})
        if u:
            urls.append(u)

    pages = (pin.get("story_pin_data") or {}).get("pages") or []
    for page in pages:
        for block in page.get("blocks") or []:
            images = (block.get("image") or {}).get("images") or {}
            u = best_image(images)
            if u:
                urls.append(u)

    if not urls:
        u = best_image(pin.get("images") or {})
        if u:
            urls.append(u)

    # dedupe, keep order
    seen = set()
    return [u for u in urls if not (u in seen or seen.add(u))]


def download_pins(
    pt: Pinterest, pins, out_dir: Path, limit: int | None = None
) -> tuple[int, int, int]:
    """Download all pin images into out_dir. Returns (saved, skipped, failed)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    saved = skipped = failed = count = 0
    for pin in pins:
        if pin.get("type") and pin["type"] != "pin":
            continue
        count += 1
        if limit and count > limit:
            break
        urls = pin_image_urls(pin)
        if not urls:
            continue
        for i, url in enumerate(urls):
            ext = Path(urlsplit(url).path).suffix or ".jpg"
            suffix = f"_{i + 1}" if len(urls) > 1 else ""
            dest = out_dir / f"{pin['id']}{suffix}{ext}"
            if dest.exists() and dest.stat().st_size > 0:
                skipped += 1
                continue
            try:
                r = pt.s.get(url, timeout=60)
                if r.status_code == 403 and "/originals/" in url:
                    #一部のピンはoriginalsが403になるので736xへフォールバック
                    r = pt.s.get(
                        re.sub(r"/originals/", "/736x/", url), timeout=60
                    )
                r.raise_for_status()
                dest.write_bytes(r.content)
                saved += 1
                log(f"  [{saved + skipped:>4}] {dest.name}")
            except requests.RequestException as e:
                failed += 1
                log(f"  !! failed: pin {pin['id']} ({e})")
        time.sleep(0.1)
    return saved, skipped, failed


# --- URL handling -----------------------------------------------------------


def get_browser_url() -> str | None:
    """Get the active tab URL from Chrome / Arc / Safari via AppleScript."""
    candidates = [
        ("Google Chrome", 'tell application "Google Chrome" to get URL of active tab of front window'),
        ("Arc", 'tell application "Arc" to get URL of active tab of front window'),
        ("Brave Browser", 'tell application "Brave Browser" to get URL of active tab of front window'),
        ("Microsoft Edge", 'tell application "Microsoft Edge" to get URL of active tab of front window'),
        ("Safari", 'tell application "Safari" to get URL of front document'),
    ]
    for app, script in candidates:
        running = subprocess.run(
            ["osascript", "-e", f'application "{app}" is running'],
            capture_output=True,
            text=True,
        )
        if running.stdout.strip() != "true":
            continue
        result = subprocess.run(
            ["osascript", "-e", script], capture_output=True, text=True
        )
        url = result.stdout.strip()
        if url and "pinterest." in url:
            log(f"ブラウザ({app})のURLを使用: {url}")
            return url
    return None


def parse_board_url(url: str) -> tuple[str, str, str | None]:
    """Return (username, board_slug, section_slug|None) from a Pinterest URL."""
    parts = [p for p in urlsplit(url).path.split("/") if p]
    reserved = {"pin", "ideas", "search", "today", "settings", "business"}
    if len(parts) < 2 or parts[0] in reserved:
        raise SystemExit(
            f"ボードURLとして解釈できません: {url}\n"
            "例: https://www.pinterest.jp/<user>/<board>/"
        )
    username, board = parts[0], parts[1]
    section = parts[2] if len(parts) >= 3 else None
    if section in {"more_ideas", "_tools", "_saved", "_created", "organize"}:
        section = None
    return username, board, section


# --- main -------------------------------------------------------------------


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Pinterestボードの画像をオリジナル解像度で一括ダウンロード",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("Usage:")[1],
    )
    ap.add_argument("url", nargs="?", help="ボードURL (省略時は --current が必要)")
    ap.add_argument(
        "-c", "--current", action="store_true",
        help="今ブラウザで開いているタブのURLを使う (Chrome/Arc/Brave/Edge/Safari)",
    )
    ap.add_argument(
        "-m", "--mode", choices=["all", "board", "sections"], default="all",
        help="all=ボード全体(既定) / board=ボード直下のみ / sections=サブボードのみ",
    )
    ap.add_argument("-s", "--section", help="特定のサブボード(セクション)名またはslugのみ取得")
    ap.add_argument("-o", "--out", help="保存先ディレクトリ (既定: ./downloads/<ボード名>)")
    ap.add_argument("--cookies", help="Netscape形式のcookieファイル (非公開ボード用)")
    ap.add_argument("--list", action="store_true", help="セクション一覧を表示して終了")
    ap.add_argument("--limit", type=int, help="各フィードごとの最大取得ピン数 (お試し用)")
    args = ap.parse_args()

    url = args.url
    if not url and args.current:
        url = get_browser_url()
        if not url:
            raise SystemExit("ブラウザでPinterestのボードを開いた状態で実行してください。")
    if not url:
        ap.print_help()
        raise SystemExit(1)

    username, slug, url_section = parse_board_url(url)
    pt = Pinterest(cookies_file=args.cookies)

    log(f"ボード情報を取得中: {username}/{slug}")
    try:
        board = pt.board(username, slug)
    except requests.HTTPError as e:
        raise SystemExit(
            f"ボードを取得できませんでした ({e}). "
            "非公開ボードの場合は --cookies を指定してください。"
        )
    if not board or not board.get("id"):
        raise SystemExit("ボードが見つかりません(非公開の可能性)。--cookies を試してください。")

    board_name = sanitize(board.get("name") or slug)
    section_count = board.get("section_count") or 0
    log(f"ボード: {board['name']}  (ピン {board.get('pin_count', '?')}件 / セクション {section_count}件)")

    sections = pt.sections(board["id"]) if (section_count or args.list) else []

    if args.list:
        log("\nセクション一覧:")
        if not sections:
            log("  (セクションなし)")
        for s in sections:
            log(f"  - {s['title']}  ({s.get('pin_count', '?')}件)  slug={s.get('slug')}")
        return

    out_root = Path(args.out) if args.out else Path("downloads") / board_name

    # 取得対象を決める
    target_section = args.section or url_section
    total_saved = total_skipped = total_failed = 0

    if target_section:
        match = next(
            (
                s for s in sections
                if s.get("slug") == target_section
                or s.get("title", "").lower() == target_section.lower()
            ),
            None,
        )
        if not match:
            names = ", ".join(s["title"] for s in sections) or "(なし)"
            raise SystemExit(f"セクション '{target_section}' が見つかりません。候補: {names}")
        log(f"\n== セクション: {match['title']} ==")
        r = download_pins(
            pt, pt.section_pins(match["id"]), out_root / sanitize(match["title"]),
            limit=args.limit,
        )
        total_saved, total_skipped, total_failed = r
    else:
        if args.mode in ("all", "board"):
            log("\n== ボード直下のピン ==")
            s, k, f = download_pins(pt, pt.board_pins(board), out_root, limit=args.limit)
            total_saved += s; total_skipped += k; total_failed += f
        if args.mode in ("all", "sections"):
            for sec in sections:
                log(f"\n== セクション: {sec['title']} ==")
                s, k, f = download_pins(
                    pt, pt.section_pins(sec["id"]), out_root / sanitize(sec["title"]),
                    limit=args.limit,
                )
                total_saved += s; total_skipped += k; total_failed += f

    log(
        f"\n完了: 保存 {total_saved}件 / スキップ(取得済) {total_skipped}件 / 失敗 {total_failed}件"
        f"\n保存先: {out_root.resolve()}"
    )


if __name__ == "__main__":
    main()
