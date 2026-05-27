# 受注表通知GAS

受注表PDFをDriveで監視し、ナンバリング付与・Slack通知・メール添付送信を自動化するGoogle Apps Script。

- **GASプロジェクト**: [`1a6p3b59-9hyQmvksBJcFYZlq94TArFg3E7RBYfFBzzR2YTnqRE0O87nF`](https://script.google.com/home/projects/1a6p3b59-9hyQmvksBJcFYZlq94TArFg3E7RBYfFBzzR2YTnqRE0O87nF/edit)
- **ローカル**: `C:\Users\ken5\OneDrive\Desktop\Product\受注表通知GAS\`
- **GitHub**: [`Ken5InvestmentLab/juchu-hyou-tsuchi-gas`](https://github.com/Ken5InvestmentLab/juchu-hyou-tsuchi-gas)（Private）

## ファイル

| ファイル | 役割 |
|----------|------|
| `受注表ナンバリングFAX用.js` | メイン処理：Drive監視 → PDFナンバリング → Slack/メール通知 |
| `出庫済＆検収済FAX用.js` | 出庫済・検収済の別処理 |
| `pdf-lib-min.js` | [pdf-lib](https://pdf-lib.js.org/) のミニファイ版（GAS埋め込み用） |
| `pdf-lib-loader.html` | pdf-lib ローダー（GASの `HtmlService` 経由） |
| `appsscript.json` | マニフェスト（Drive v3 Advanced Service / Gmail / 各種スコープ） |

## トリガー（GAS側）

- **時間主導: 毎分 1 回** → `monitorSourceFolderEveryMinute`
  - 初回は GAS エディタで `setupNumberingFolderPollingTrigger` を手動実行して登録
- 旧 Drive Webhook（`setupDriveWatcher` / `renewDriveWatcher`）は **廃止**
  - 残っている場合は `removeDriveWatcherTriggers` を手動実行で削除

## セットアップ

```powershell
cd "C:\Users\ken5\OneDrive\Desktop\Product\受注表通知GAS"
clasp clone 1a6p3b59-9hyQmvksBJcFYZlq94TArFg3E7RBYfFBzzR2YTnqRE0O87nF
```

## ローカル → GAS 反映

```powershell
clasp push
```

## ローカル → GitHub 反映

```powershell
git add -A
git commit -m "your message"
git push origin main
```

## 修正履歴

### 2026-05-27 — Empty response エラーの恒久対策

**事象**: 29ページ分の高解像度カラースキャン PDF（25MB+）を処理中に `applyNumberingToPdf` 内の `Drive.Files.update` が `Empty response` を返して失敗。

**対策**: `applyNumberingToPdf` の `Drive.Files.update(...)` を `driveUpdateWithRetry_(...)` 経由に置換。同関数で以下を実施：

1. **指数バックオフリトライ**（最大5回 / 1.5s → 3s → 6s → 12s → 24s + ±1s jitter）
   - 対象: `Empty response` / `timeout` / `Internal error` / `Backend Error` / `Rate Limit` / 5xx
2. **冪等チェック**: `Empty response` のときだけ、Drive 側の `lastUpdated` が60秒以内なら **実は成功している** とみなしてリトライをスキップ
3. **Resumable upload**: 20MB 以上のファイルは `Drive.Files.update` を使わず、`UrlFetchApp` で v3 resumable upload プロトコル（セッション開始 → 単発 PUT）を実行
4. 既存の **per-file try/catch**（`processNewFilesInSourceFolder_`）と **ScriptLock** はそのまま活用

## エラー対応メモ

| 症状 | 一次対応 |
|------|----------|
| ログに `[Retry n/5]` が出る | 正常動作。サーバー側の一過性エラーをリトライで吸収中 |
| ログに `Empty response でしたが lastUpdated=...前のため成功とみなします` | 正常動作。Drive 側は更新成功している |
| `諦め (...attempt=5)` が出る | 5回でも失敗した本物の障害。スキャナとDriveの両方を確認 |
| Slack に「PDF編集エラーが発生しました」が出る | リトライ枯渇後のみ通知される。元エラーを確認 |

## 重要な定数（CONFIG）

| キー | 値 | 補足 |
|------|-----|------|
| `SOURCE_FOLDER_ID` | `111MS64IPLmANdx0u7ARzPZcfsSlrKXdI` | スキャナ出力先 |
| `SOURCE_FOLDER_URL` | `https://drive.google.com/drive/folders/1YGaWhpQd2A0wlsUu3Scw_cR-b_fqrLTm` | Slack 案内用 |
| `CHANNEL_ID` | `C0APR7PT0UC` | 通知先 Slack チャンネル |

## Script Properties（GAS側）

| プロパティ | 用途 |
|------------|------|
| `SLACK_BOT_TOKEN` | Slack Bot OAuth トークン |
| `NOTIFIED_FILE_IDS` | 通知済みファイルID（最大100件・JSON配列） |
| `DONE_IDS` | 印刷済みボタン押下済みファイルID（最大100件・JSON配列） |
| `PRINTED_FOLDER_ID` | 印刷済み移動先フォルダ |
| `LAST_NUMBERING_DATE` | 最後にナンバリングした日付（YYYY-MM-DD） |
| `CURRENT_NUMBERING_NO` | その日の連番カウンタ |
