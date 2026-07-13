# healsio-line-dify-bot

LINE公式アカウントに届いたメッセージを Dify（クラウド版）のチャットボットAPIに中継し、
その回答をLINEに返す Google Apps Script（GAS）製のWebhookサーバー。

Difyボットは「Healsio（シャープ調理家電）の取扱説明書に基づいて答える」RAGチャットフロー。

## ファイル構成

```
.
├── .clasp.json        # clasp設定（GASプロジェクトのID等。秘密情報ではない）
├── .claspignore        # clasp push時に除外するファイル
├── .gitignore          # Gitにコミットしないファイル（認証情報など）
├── README.md           # このファイル
└── src/
    ├── appsscript.json # GASマニフェスト（タイムゾーン・Webアプリ設定）
    └── Code.gs          # 本体：LINE Webhook受信 → Dify呼び出し → LINE返信
```

## 前提条件

- Node.js（`node -v` で確認）
- clasp（Google公式CLI。`npm install -g @google/clasp` で導入）
- Googleアカウント（GASプロジェクトを作るアカウント）
- LINE Developersでの Messaging API チャネル（作成済み）
- Dify（クラウド版）で公開済みのチャットフロー

### clasp導入で "Premature close" エラーが出た場合

`clasp login` 実行時に `Invalid response body while trying to fetch
https://oauth2.googleapis.com/token: Premature close` が出ることがある。
これは非常に新しいNode.jsバージョン（本プロジェクトではv24）とclaspが使う通信ライブラリの
相性問題。Homebrewで少し前のLTS版Node（v22）を追加インストールし、そちらでclaspを実行すると解決する。

```bash
brew install node@22
NODE22_BIN="$(brew --prefix node@22)/bin"
export PATH="$NODE22_BIN:$PATH"
clasp login
```

## セットアップ（初回のみ）

```bash
# 1. リポジトリをclone
git clone <このリポジトリのURL>
cd healsio-line-dify-bot

# 2. clasp導入（未導入の場合）
npm install -g @google/clasp

# 3. Googleアカウントでログイン（ブラウザが開く）
clasp login

# 4. コードをGASに反映
clasp push
```

`clasp login` の前に、Googleアカウントで一度だけ以下を有効化しておく必要がある：
`https://script.google.com/home/usersettings` を開き「Google Apps Script API」をオンにする
（無料。単なる許可設定で課金は発生しない）。

## デプロイ（Webアプリとして公開）

初回デプロイ：

```bash
clasp deploy --description "v1"
```

実行後、`clasp deployments` でデプロイIDとURLを確認できる。
GASのエディタ画面（`clasp open`で開ける）からでも操作可能：

1. 右上の「デプロイ」→「新しいデプロイ」
2. 種類の選択で歯車アイコン→「ウェブアプリ」を選択
3. 説明を入力
4. **実行するユーザー：自分**
5. **アクセスできるユーザー：全員**
6. 「デプロイ」をクリックすると **ウェブアプリURL** が発行される（`https://script.google.com/macros/s/xxxxx/exec` の形式）

コードを更新したときは：

```bash
clasp push
clasp deploy --deploymentId <既存のデプロイID>
```
（`--deploymentId` を省略すると新しいデプロイが作られ、URLが変わってしまうので注意）

## スクリプトプロパティの設定（GAS画面での操作）

キーは絶対にコードに書かず、GASの「スクリプト プロパティ」に保存する。

1. `clasp open` でGASエディタを開く（またはブラウザで直接開く）
2. 左メニューの歯車アイコン「プロジェクトの設定」をクリック
3. 一番下の「スクリプト プロパティ」→「スクリプト プロパティを追加」
4. 以下を1つずつ登録する：

| プロパティ名 | 値 |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Developers「Messaging API設定」タブで発行した長期チャネルアクセストークン |
| `DIFY_API_KEY` | Difyの対象アプリ「APIアクセス」ページで発行したAPIキー（`app-` から始まる文字列） |
| `DIFY_API_BASE` | DifyのAPIベースURL。クラウド版は通常 `https://api.dify.ai/v1` |
| `WEBHOOK_VERIFY_TOKEN` | （任意・推奨）自分で決めた合言葉。ランダムな英数字文字列を推奨 |
| `MANUAL_PDF_URL` | （任意）取扱説明書PDFの公開URL。設定すると回答に「📖 説明書◯ページに記載があります」＋該当ページを開くリンク（`#page=◯`付き）を添えて返信する |
| `PAGES_INDEX_URL` | （任意・`MANUAL_PDF_URL`とセットで設定）`data/pages.json` を公開したURL。例: `https://raw.githubusercontent.com/niwasaya0501-cyber/healsio-line-dify-bot/main/data/pages.json` |

5. 保存する

### ページ番号付きリンク機能について

`MANUAL_PDF_URL` と `PAGES_INDEX_URL` の両方を設定すると、Difyの回答に添えられた引用元チャンク（`retriever_resources`）の内容を、あらかじめ抽出しておいたページ本文一覧（`data/pages.json`）と突き合わせて、参照元のページ番号を推定する。

- `data/pages.json` は、`brew install poppler` の `pdftotext` で取扱説明書PDFを1ページずつテキスト化して作成したもの（`[{ "page": 1, "text": "..." }, ...]`）。PDFの内容が改訂された場合は作り直して再コミットする必要がある。
- ページ番号の特定は「ページ本文とのn-gram（8文字単位）一致率」による推定のため、一致率が低い場合はページ案内を付けずに回答本文のみを返す（誤ったページ番号を案内しないための安全策）。
- Difyの回答に「記載がない」「お答えできません」等の文言が含まれる場合も、ページ案内は付けない。

## LINE Developers側の設定

1. [LINE Developers](https://developers.line.biz/) にログインし、対象チャネルを開く
2. 「Messaging API設定」タブを開く
3. 「Webhook URL」に、デプロイで取得したウェブアプリURLを設定する
   - `WEBHOOK_VERIFY_TOKEN` を設定した場合は、URLの末尾に `?token=xxxxx` を付与する
     （例：`https://script.google.com/macros/s/xxxxx/exec?token=xxxxx`）
4. 「Webhookの利用」を **オン** にする
5. 「応答メッセージ」は **オフ** にする（LINE公式の自動応答とDifyの回答が二重に返らないようにするため）
6. 「検証」ボタンを押して成功することを確認する

## 動作確認

1. LINE公式アカウントを友だち追加する（まだの場合）
2. トークで質問を送る（例：「使い方を教えて」）
3. Difyの回答がLINEに返ってくれば成功

うまく返信が来ない場合は、GASエディタの「実行数」（左メニューの時計アイコン）でエラーログを確認する。

## セキュリティ上の注意

- GASの `doPost(e)` はHTTPヘッダーを取得できない仕様のため、LINE公式の署名検証（`X-Line-Signature`）は行っていない
- 代わりに `WEBHOOK_VERIFY_TOKEN` をURLのクエリパラメータとして使う簡易的な方式で保護している
- この方式でも、有効な `replyToken`（LINEが発行する使い捨てトークン）を持たない偽の呼び出しはLINEへの返信に失敗するため、なりすまし返信は行われない。ただし無関係な第三者がWebhook URLを知ってしまうと、Dify APIの呼び出し（＝利用量・コスト）を消費させることは可能なので、`WEBHOOK_VERIFY_TOKEN` の設定を推奨する
