# pinterest-getter

Pinterestボードの画像をオリジナル(最高)解像度で一括ダウンロードするツール。
**CLI版**(`pinget.py`)と**Chrome拡張版**(`extension/`)の2つが入っている。

| | CLI版 | Chrome拡張版 |
| --- | --- | --- |
| 公開ボード | ○ | ○ |
| 非公開ボード | cookieファイルのエクスポートが必要 | ログイン済みならそのまま使える |
| 保存先 | 任意のディレクトリ | `ダウンロード/Pinterest/<ボード名>/` |
| 今開いてるボードの取得 | `--current`(AppleScript経由) | ポップアップを開くだけ |

## Chrome拡張版

### インストール

1. Chromeで `chrome://extensions` を開く
2. 右上の「デベロッパーモード」をON
3. 「パッケージ化されていない拡張機能を読み込む」→ この `extension/` フォルダを選択

### 使い方

1. Pinterestのボードページ(またはセクションページ)を開く
2. ツールバーの拡張アイコンをクリック
3. 範囲を選ぶ — ボード全体 / ボード直下のみ / 全セクションのみ / 特定のセクション
4. 「ダウンロード開始」

### 保存形式

- **ZIPにまとめて保存(既定)**: 全画像を1つのZIPにまとめて
  `ダウンロード/Pinterest/<ボード名>.zip` に保存。ZIP内はセクションごとのフォルダ構造。
  保存ダイアログが出る設定でも**ダイアログは1回だけ**。
- **個別ファイルで保存**(チェックを外す): `ダウンロード/Pinterest/<ボード名>/<セクション名>/` に
  1枚ずつ保存。Chromeの「ダウンロード前に各ファイルの保存場所を確認する」
  (`chrome://settings/downloads`)がONだと**毎回ダイアログが出る**ので、
  このモードを使う場合はOFF推奨。

### その他

- セクションページを開いた状態でポップアップを開くと、そのセクションが自動選択される
- 非公開(シークレット)ボードも、Pinterestにログインしていればそのまま取得できる
- オリジナル画像が取得できないピンは736pxに自動フォールバック
- ZIPは無圧縮(画像は再圧縮しても縮まないため)。4GB超 or 65000ファイル超は自動で複数ZIPに分割
- 対応ドメイン: pinterest.com / pinterest.jp

## CLI版

### 必要なもの

- [uv](https://docs.astral.sh/uv/) (依存パッケージは初回実行時に自動解決)

### 使い方

```sh
# ボード全体(サブボード=セクション込み)をダウンロード
uv run pinget.py https://www.pinterest.jp/<user>/<board>/

# 今ブラウザ(Chrome/Arc/Brave/Edge/Safari)で開いているボードをダウンロード
uv run pinget.py --current

# ボード直下のピンのみ(セクションを除く)
uv run pinget.py <board-url> --mode board

# サブボード(セクション)のみ
uv run pinget.py <board-url> --mode sections

# 特定のセクションのみ(名前またはslugで指定)
uv run pinget.py <board-url> --section "Rainbow nails"

# セクションURLを直接渡してもOK
uv run pinget.py https://www.pinterest.jp/<user>/<board>/<section>/

# セクション一覧を確認するだけ
uv run pinget.py --current --list
```

### オプション

| オプション | 説明 |
| --- | --- |
| `-c, --current` | ブラウザのアクティブタブのURLを使う |
| `-m, --mode {all,board,sections}` | 取得範囲。既定は `all`(ボード全体) |
| `-s, --section NAME` | 特定セクションのみ取得(名前 or slug) |
| `-o, --out DIR` | 保存先。既定は `./downloads/<ボード名>/` |
| `--cookies FILE` | Netscape形式のcookieファイル(非公開ボード用) |
| `--list` | セクション一覧を表示して終了 |
| `--limit N` | 各フィードの最大取得数(お試し用) |

### 保存先の構造

```
downloads/
└── <ボード名>/
    ├── <ピンID>.jpg          # ボード直下のピン
    └── <セクション名>/
        └── <ピンID>.jpg      # セクション内のピン
```

- 画像は `i.pinimg.com/originals/` のオリジナル解像度。orig が無いピンは入手可能な最大サイズにフォールバック
- カルーセルピンは全スライドを `<ピンID>_1.jpg, _2.jpg, ...` として保存
- 既にダウンロード済みのファイルはスキップされるので、中断しても再実行すれば続きから取得できる

### 非公開(シークレット)ボード

ログインCookieが必要。ブラウザ拡張(Get cookies.txt LOCALLY など)で
pinterest.com のCookieをNetscape形式でエクスポートして渡す:

```sh
uv run pinget.py <board-url> --cookies cookies.txt
```

## 注意

- Pinterestの内部API(非公式)を使用しているため、仕様変更で動かなくなる可能性あり
- 個人利用の範囲で。大量取得時はレート制限に注意(リクエスト間に小さなウェイトを入れている)
