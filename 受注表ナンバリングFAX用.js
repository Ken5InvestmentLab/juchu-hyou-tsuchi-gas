// ========== PDFLib 用ポリフィル（setTimeout がない環境用）==========
if (typeof setTimeout === 'undefined') {
  (function(global) {
    global.setTimeout = function(callback, delay) {
      Utilities.sleep(delay || 0);
      return callback();
    };
    global.clearTimeout = function(timeoutId) {};
    global.setInterval = function(callback, delay) { return null; };
    global.clearInterval = function(intervalId) {};
  })(this);
}
// =============================================================

// 不要なグローバルオーバーライドを削除（コメントアウトまたは削除）
// const global = this;
// global.setTimeout = ... などは全部削除

const CONFIG = {
  SOURCE_FOLDER_ID: '111MS64IPLmANdx0u7ARzPZcfsSlrKXdI',  // 実際のフォルダIDに修正推奨
  SOURCE_FOLDER_URL: 'https://drive.google.com/drive/folders/1YGaWhpQd2A0wlsUu3Scw_cR-b_fqrLTm', // 上記IDと揃えること
  CHANNEL_ID: 'C0APR7PT0UC'
};

function setupDriveWatcher() {
  const webAppUrl = "https://script.google.com/macros/s/AKfycbwVY_OMK2PDh1SlBTJOdJZ4I6wpG-z2RV461Oftr-zZQlHAbeKSRyfwkfG-KWxrIR3n/exec";
  const url = webAppUrl + "?source=drive";
  const expiration = new Date().getTime() + (7 * 24 * 60 * 60 * 1000);
  const resource = {
    id: "fixed-watcher-id-v20",
    type: "web_hook",
    address: url,
    expiration: expiration.toString()
  };
  try {
    Drive.Changes.watch(resource, { supportsAllDrives: true, includeItemsFromAllDrives: true });
    console.log("✅ 監視を登録しました");
  } catch (e) {
    console.log("❌ エラー: " + e.message);
  }
}

function renewDriveWatcher() {
  const props = PropertiesService.getScriptProperties();
  const channelId = props.getProperty('WATCH_CHANNEL_ID');
  const resourceId = props.getProperty('WATCH_RESOURCE_ID');
  if (channelId && resourceId) {
    try {
      Drive.Channels.stop({ 'id': channelId, 'resourceId': resourceId });
      console.log('古い監視チャンネルを停止しました');
    } catch(e) {
      console.log('チャンネル停止エラー（すでに切れている可能性）: ' + e.message);
    }
  }

  const webAppUrl = "https://script.google.com/macros/s/AKfycbwVY_OMK2PDh1SlBTJOdJZ4I6wpG-z2RV461Oftr-zZQlHAbeKSRyfwkfG-KWxrIR3n/exec";
  const url = webAppUrl + "?source=drive";
  const expiration = new Date().getTime() + (7 * 24 * 60 * 60 * 1000);
  const resource = {
    id: "fixed-watcher-id-" + new Date().getTime(),
    type: "web_hook",
    address: url,
    expiration: expiration.toString()
  };
  try {
    const response = Drive.Changes.watch(resource, { "supportsAllDrives": true, "includeItemsFromAllDrives": true });
    props.setProperty('WATCH_CHANNEL_ID', response.id);
    props.setProperty('WATCH_RESOURCE_ID', response.resourceId);
    console.log("✅ 監視を再登録しました");
  } catch (e) {
    console.log("❌ 監視の再登録に失敗: " + e.message);
  }
}

// ========== 1分ごとのフォルダ監視でナンバリングを実行 ==========

/**
 * Google 側で発生する一過性のサーバーエラー（リトライで自然に解消する類のもの）かを判定する。
 * 該当する場合は Slack 通知をスキップし、未処理ファイルは次の1分後トリガーでの自動再試行に任せる。
 *   - "We're sorry, a server error occurred" : Apps Script / Drive の汎用一過性エラー
 *   - "Service error: Drive"                 : Drive API の一過性エラー
 *   - "Internal error" / "Backend Error"     : Google 内部エラー
 *   - HTTP 500/502/503/504                   : 5xx 系のサーバーエラー
 */
function isTransientGoogleError_(err) {
  const msg = String((err && err.message) || err);
  return (
    /Service error: Drive/i.test(msg) ||
    /server error occurred/i.test(msg) ||
    /Internal error/i.test(msg) ||
    /Backend Error/i.test(msg) ||
    /\b(500|502|503|504)\b/.test(msg)
  );
}

/**
 * 初回だけ手動実行してください。
 * 既存の同名トリガーを削除してから、1分ごとの監視トリガーを1つだけ作成します。
 */
function setupNumberingFolderPollingTrigger() {
  const handlerName = 'monitorSourceFolderEveryMinute';

  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === handlerName) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger(handlerName)
    .timeBased()
    .everyMinutes(1)
    .create();

  console.log('✅ 1分ごとのフォルダ監視トリガーを登録しました');
}

/**
 * 旧Drive Webhook更新用の時間主導トリガーが残っている場合に削除する補助関数です。
 * 必須ではありませんが、renewDriveWatcher / setupDriveWatcher のトリガーを設定していた場合は一度実行してください。
 */
function removeDriveWatcherTriggers() {
  const oldHandlers = ['setupDriveWatcher', 'renewDriveWatcher'];

  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (oldHandlers.includes(trigger.getHandlerFunction())) {
      ScriptApp.deleteTrigger(trigger);
      console.log('旧Drive監視トリガーを削除しました: ' + trigger.getHandlerFunction());
    }
  });
}

/**
 * 時間主導トリガーから1分ごとに呼ばれる関数です。
 * 成功時の成果物は、旧 doPost のDrive Webhook処理と同じです。
 */
async function monitorSourceFolderEveryMinute() {
  Utilities.sleep(Math.random() * 3000);

  try {
    await processNewFilesInSourceFolder_();
    return 'OK';
  } catch (err) {
    console.error('monitorSourceFolderEveryMinute 全体エラー: ' + err.message);
    console.error(err.stack);

    // 一過性のGoogle側サーバーエラーは Slack 通知しない。
    // この時点で例外が出たということは notifiedIds への追加・props保存もされていないため、
    // 未処理ファイルは次の1分後トリガーで自然に再試行される（番号も PENDING_NUMBERS_* で再利用）。
    if (!isTransientGoogleError_(err)) {
      sendToSlack({
        text: `?? *システム全体エラー (monitorSourceFolderEveryMinute)*\n発生時刻: ${new Date().toLocaleString('ja-JP')}\n\`\`\`${err.message}\n${err.stack}\`\`\``
      });
    } else {
      console.log('無害な一過性エラーのため Slack 通知をスキップ（次サイクルで自動再試行）: ' + err.message);
    }

    return 'Error: ' + err.message;
  }
}

/**
 * 旧 doPost のDrive Webhook側に入っていた新規ファイル処理です。
 * Slack通知・メール送信・PDFナンバリング・NOTIFIED_FILE_IDS の更新内容は変更していません。
 */
async function processNewFilesInSourceFolder_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    console.log('Locked');
    return;
  }

  try {
    const props = PropertiesService.getScriptProperties();
    const cache = CacheService.getScriptCache();
    const folder = DriveApp.getFolderById(CONFIG.SOURCE_FOLDER_ID);
    const allFiles = getFilesWithRetry(folder, 3, 2000);

    let notifiedIds = JSON.parse(props.getProperty('NOTIFIED_FILE_IDS') || '[]');
    let stateChanged = false;

    for (const file of allFiles) {
      const fileId = file.getId();

      if (cache.get('processing_' + fileId) || notifiedIds.includes(fileId)) {
        continue;
      }
      cache.put('processing_' + fileId, 'true', 600);

      const fileName = file.getName();
      if (fileName.startsWith('【印刷済】')) continue;

      let displayTitle = 'ナンバリングなし';
      let numberedFileName = fileName;
      // ナンバリングが失敗した場合に、成功通知・メール送信・notifiedIds 追加をすべてスキップするためのフラグ。
      // 失敗時は notifiedIds に積まず、processing_* cache が10分で期限切れになった次のサイクルで自動再試行される。
      let numberingFailed = false;

      if (file.getMimeType() === MimeType.PDF) {
        try {
          displayTitle = await applyNumberingToPdf(file);
          numberedFileName = `${displayTitle}_${fileName}`;
          console.log('ナンバリング完了: ' + numberedFileName);
        } catch (err) {
          console.error(`PDF編集エラー: ${err.message}`);
          console.error(err.stack);

          // 同じファイルが連続失敗した場合に Slack が荒れないよう、30分のスロットリングをかける。
          const alertCacheKey = 'alerted_numbering_' + fileId;
          if (!cache.get(alertCacheKey)) {
            sendToSlack({
              text: `⚠️ PDF編集エラー（10分後に自動再試行されます）\n*ファイル:* ${fileName}\n\`\`\`${err.message}\n${err.stack}\`\`\``,
              channel: CONFIG.CHANNEL_ID
            });
            cache.put(alertCacheKey, 'true', 1800); // 30分
          } else {
            console.log(`Slackアラートは30分以内に通知済みのためスキップ: ${fileName}`);
          }
          numberingFailed = true;
        }
      }

      // ナンバリング失敗時は通知・メール・notifiedIds 追加をすべてスキップして次ファイルへ。
      // 10分後に processing_* cache が切れた次サイクルで自動再試行される。
      // 番号は applyNumberingToPdf 内の PENDING_NUMBERS_* キャッシュで再利用されるため浪費しない。
      if (numberingFailed) {
        console.warn(`ナンバリング失敗のため通知・メール・notifiedIds をスキップ: ${fileName}（10分後に自動再試行・番号は再利用）`);
        continue;
      }

      sendToSlack({
        text: `📄 受注表: ${displayTitle}`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `📄 *新しい受注表 (${displayTitle})*` } },
          { type: 'section', text: { type: 'mrkdwn', text: `*ファイル:*\n<https://drive.google.com/file/d/${fileId}/view|${fileName}>` } },
          { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '📂 フォルダを確認' }, url: CONFIG.SOURCE_FOLDER_URL }] }
        ]
      });

      sendEmailWithAttachment(fileId, numberedFileName);

      notifiedIds.push(fileId);
      stateChanged = true;
    }

    if (stateChanged) {
      props.setProperty('NOTIFIED_FILE_IDS', JSON.stringify(notifiedIds.slice(-100)));
    }
  } finally {
    lock.releaseLock();
  }
}

// doPost はSlackボタン処理専用にします。
// Drive Webhookやその他POSTでは、ここでナンバリング処理を実行しません。
function doPost(e) {
  Utilities.sleep(Math.random() * 3000);

  try {
    const contents = (e && e.postData && e.postData.contents) || '';
    const isSlackAction = contents.includes('payload=') || contents.includes('"actions"') || contents.includes('"_meta"');

    if (isSlackAction) {
      try {
        let contentsStr = contents;
        if (contentsStr.startsWith('payload=')) {
          contentsStr = decodeURIComponent(contentsStr.substring(8));
        }
        const payload = JSON.parse(contentsStr);
        processSlackAction(payload.actions[0].value, payload, payload.user.real_name || payload.user.name);
      } catch (err) {
        console.log('Slack Action Error: ' + err.message);
      }
      return ContentService.createTextOutput('OK');
    }

    return ContentService.createTextOutput('OK');
  } catch (err) {
    console.error('doPost 全体エラー: ' + err.message);
    console.error(err.stack);

    // 一過性のGoogle側サーバーエラーは Slack 通知しない
    if (!isTransientGoogleError_(err)) {
      sendToSlack({
        text: `?? *システム全体エラー (doPost)*\n発生時刻: ${new Date().toLocaleString('ja-JP')}\n\`\`\`${err.message}\n${err.stack}\`\`\``
      });
    } else {
      console.log('無害な一過性エラーのため Slack 通知をスキップしました: ' + err.message);
    }

    return ContentService.createTextOutput('Error: ' + err.message);
  }
}

/**
 * ページ数分の連番を安全に一括取得する
 * @param {number} pageCount - PDFのページ数
 * @returns {string[]} 例: ["2026-04-08-No.01", "2026-04-08-No.02"]
 */
function allocateNumbers(pageCount) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('番号取得のロック失敗');

  try {
    const props = PropertiesService.getScriptProperties();
    const today = Utilities.formatDate(new Date(), "JST", "yyyy-MM-dd");
    let lastDate = props.getProperty('LAST_NUMBERING_DATE');
    let currentNo = (lastDate === today) ? parseInt(props.getProperty('CURRENT_NUMBERING_NO')) || 0 : 0;

    const numbers = [];
    for (let i = 0; i < pageCount; i++) {
      currentNo++;
      numbers.push(`${today}-No.${currentNo.toString().padStart(2, '0')}`);
    }

    props.setProperties({
      'LAST_NUMBERING_DATE': today,
      'CURRENT_NUMBERING_NO': currentNo.toString()
    });

    return numbers;
  } finally {
    lock.releaseLock();
  }
}

// 引数は file だけになります
async function applyNumberingToPdf(file) {
  const fileId = file.getId();
  const blob = file.getBlob();
  const bytes = new Uint8Array(blob.getBytes());
  const pdfDoc = await PDFLib.PDFDocument.load(bytes);
  const pages = pdfDoc.getPages();
  const pageCount = pages.length;

  // 番号再利用キャッシュ: 同じ fileId に対して既に番号を割り当てていれば再利用する。
  // 目的: アップロード失敗のたびに allocateNumbers でカウンタが進み、番号が虚しく飛ぶのを防ぐ。
  const props = PropertiesService.getScriptProperties();
  const pendingKey = 'PENDING_NUMBERS_' + fileId;
  const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7日より古い残骸は無視

  let numbers = null;
  const pendingJson = props.getProperty(pendingKey);
  if (pendingJson) {
    try {
      const pending = JSON.parse(pendingJson);
      const isFresh = pending.savedAt && (Date.now() - pending.savedAt) < PENDING_TTL_MS;
      if (isFresh && pending.pageCount === pageCount && Array.isArray(pending.numbers)) {
        numbers = pending.numbers;
        console.log(`[applyNumberingToPdf] 既存の番号割当を再利用: ${fileId} → ${numbers[0]} 〜 ${numbers[numbers.length - 1]}`);
      }
    } catch (parseErr) {
      console.warn(`[applyNumberingToPdf] PENDING_NUMBERS パース失敗（新規割当へ）: ${parseErr.message}`);
    }
  }
  if (!numbers) {
    numbers = allocateNumbers(pageCount);
    props.setProperty(pendingKey, JSON.stringify({
      pageCount: pageCount,
      numbers: numbers,
      savedAt: Date.now()
    }));
  }

  const standardFont = await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);
  const fontSize = 14;

  pages.forEach((page, index) => {
    const numberingText = numbers[index];
    const { width, height } = page.getSize();
    const textWidth = standardFont.widthOfTextAtSize(numberingText, fontSize);

    page.drawText(numberingText, {
      x: width - textWidth - 30, y: height - 30,
      size: fontSize, font: standardFont, color: PDFLib.rgb(0, 0, 0),
    });
  });

  const pdfBytes = await pdfDoc.save();
  const newBlob = Utilities.newBlob(pdfBytes, 'application/pdf', file.getName());
  // 大容量PDF（25MB+の高解像度スキャン）で発生する "Empty response" 対策として、
  // リトライ + 冪等チェック + resumable upload を内包したヘルパー経由で更新する。
  driveUpdateWithRetry_(fileId, newBlob, file.getName());

  // アップロードが本当に成功したときだけ番号割当キャッシュをクリアする。
  // 失敗で例外が投げられればここには到達せず、次回リトライで同じ番号が再利用される。
  props.deleteProperty(pendingKey);

  if (pageCount === 1) {
    return numbers[0];
  } else {
    const firstNo = numbers[0];
    const lastNoStr = numbers[pageCount - 1].split('-').pop();
    return `${firstNo}~${lastNoStr}`;
  }
}

/**
 * Drive.Files.update を Empty response 対策込みでラップする。
 *   ① 20MB以上なら resumable upload プロトコルへ自動切替
 *   ② リトライ可能エラーは最大5回まで指数バックオフ（1.5s→3s→6s→12s→24s + ±1s jitter）
 *   ③ Empty response 捕捉時のみ、Drive 側の lastUpdated を確認して
 *      実は成功している場合はリトライをスキップ（二重アップロード回避）
 *
 * @param {string} fileId  更新対象のファイルID
 * @param {GoogleAppsScript.Base.Blob} blob  新しい中身
 * @param {string} fileName  ログ用の表示名
 */
function driveUpdateWithRetry_(fileId, blob, fileName) {
  const sizeBytes = blob.getBytes().length;
  const RESUMABLE_THRESHOLD = 20 * 1024 * 1024; // 20MB を超えたら resumable へ切替
  const useResumable = sizeBytes >= RESUMABLE_THRESHOLD;
  const sizeMb = (sizeBytes / 1024 / 1024).toFixed(2);

  const MAX_ATTEMPTS = 5;
  const BASE_DELAY_MS = 1500;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // 更新前の lastUpdated をベースラインとして記録（Empty response の真贋判定に使う）。
    // スキャナが直前に書き込んだ直後でも、絶対時刻ではなく「進んだかどうか」で判定するため誤検知しない。
    let preUpdateMs = null;
    try {
      preUpdateMs = DriveApp.getFileById(fileId).getLastUpdated().getTime();
    } catch (preErr) {
      console.warn(`[driveUpdateWithRetry_] 更新前 lastUpdated 取得失敗（冪等チェックなしで続行）: ${preErr.message}`);
    }

    try {
      if (useResumable) {
        updatePdfResumable_(fileId, blob);
      } else {
        Drive.Files.update({}, fileId, blob);
      }
      if (attempt > 1) {
        console.log(`[driveUpdateWithRetry_] 試行${attempt}回目で成功 (${fileName}, ${sizeMb}MB)`);
      }
      return;
    } catch (e) {
      lastError = e;
      const msg = String((e && e.message) || e);
      const isEmpty = /Empty response/i.test(msg);

      // Empty response の真贋判定:
      // 更新前(preUpdateMs)と更新後(postUpdateMs)を比較して、確実に「進んでいる」ときだけ成功扱い。
      // スキャナが書き込んだだけで preUpdateMs が新しい状態でも、update が本当に失敗していれば
      // postUpdateMs は preUpdateMs と同じになる（≒変化なし）ので、確実に失敗と判定できる。
      if (isEmpty && preUpdateMs !== null) {
        Utilities.sleep(2000); // Drive のメタデータ反映待ち
        try {
          const postFile = DriveApp.getFileById(fileId);
          const postUpdateMs = postFile.getLastUpdated().getTime();
          if (postUpdateMs > preUpdateMs) {
            console.log(`[driveUpdateWithRetry_] Empty response だが lastUpdated が ${new Date(preUpdateMs).toISOString()} → ${new Date(postUpdateMs).toISOString()} に進んだので成功と判定 (${fileName}, ${sizeMb}MB)`);
            return;
          }
          console.log(`[driveUpdateWithRetry_] Empty response: lastUpdated 変化なし(${new Date(preUpdateMs).toISOString()}) → 本当に失敗と判定しリトライへ (${fileName}, ${sizeMb}MB)`);
        } catch (checkErr) {
          console.warn(`[driveUpdateWithRetry_] 更新後 lastUpdated 取得失敗（保守的にリトライへ）: ${checkErr.message}`);
        }
      }

      const isRetryable =
        isEmpty ||
        /timed?\s*out/i.test(msg) ||
        /timeout/i.test(msg) ||
        /Internal error/i.test(msg) ||
        /Backend Error/i.test(msg) ||
        /Rate Limit/i.test(msg) ||
        /User Rate Limit/i.test(msg) ||
        /Service error/i.test(msg) ||
        /\b(500|502|503|504)\b/.test(msg);

      if (!isRetryable || attempt === MAX_ATTEMPTS) {
        console.error(`[driveUpdateWithRetry_] 諦め (${fileName}, ${sizeMb}MB, attempt=${attempt}): ${msg}`);
        throw e;
      }

      const jitter = Math.floor(Math.random() * 1000);
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1) + jitter;
      console.log(`[driveUpdateWithRetry_] [Retry ${attempt}/${MAX_ATTEMPTS}] ${msg.substring(0, 200)} → ${delay}ms 待機 (${fileName}, ${sizeMb}MB, resumable=${useResumable})`);
      Utilities.sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Drive v3 の resumable upload でファイル本体を差し替える。
 * 単発 PATCH より接続切断に強く、25MB+ のスキャン PDF で Empty response が出にくい。
 * @param {string} fileId  更新対象のファイルID
 * @param {GoogleAppsScript.Base.Blob} blob  新しい中身
 */
function updatePdfResumable_(fileId, blob) {
  const token = ScriptApp.getOAuthToken();
  const mimeType = blob.getContentType() || 'application/pdf';
  const bytes = blob.getBytes();

  // ① セッション開始（メタデータは空でOK・本体は次のPUTで送る）
  const initResp = UrlFetchApp.fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=resumable&supportsAllDrives=true`,
    {
      method: 'patch',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(bytes.length)
      },
      payload: '{}',
      muteHttpExceptions: true
    }
  );

  const initCode = initResp.getResponseCode();
  if (initCode !== 200 && initCode !== 201) {
    throw new Error(`Resumable upload セッション開始失敗: HTTP ${initCode} body=${initResp.getContentText().substring(0, 300)}`);
  }

  const headers = initResp.getHeaders() || {};
  const sessionUri = headers['Location'] || headers['location'];
  if (!sessionUri) {
    throw new Error('Resumable upload: Location ヘッダーが見つかりませんでした');
  }

  // ② 本体を単発 PUT で送る（GAS は UrlFetchApp で最大50MB送れるため、PDFは1ショットで通る）
  const uploadResp = UrlFetchApp.fetch(sessionUri, {
    method: 'put',
    headers: { 'Content-Type': mimeType },
    payload: bytes,
    muteHttpExceptions: true
  });

  const uploadCode = uploadResp.getResponseCode();
  if (uploadCode !== 200 && uploadCode !== 201) {
    throw new Error(`Resumable upload PUT失敗: HTTP ${uploadCode} body=${uploadResp.getContentText().substring(0, 300)}`);
  }
}

function sendEmailWithAttachment(fileId, fileName) {
  try {
    const file = DriveApp.getFileById(fileId);
    const blob = file.getBlob();
    const recipient = "nikkenshoji5963@gmail.com";
    const subject = `新しい受注表: ${fileName}`;
    const body = "受注表PDFを添付します。";
    MailApp.sendEmail(recipient, subject, body, { attachments: [blob] });
    console.log(`✅ メール送信成功: ${fileName} → ${recipient}`);
  } catch (e) {
    console.error(`❌ メール送信エラー (${fileName}): ${e.message}`);
    sendToSlack({
      text: `⚠️ *メール送信に失敗しました*\n*ファイル:* ${fileName}\n*エラー内容:* \`${e.message}\``
    });
  }
}

function getFilesWithRetry(folder, maxRetries = 3, delayMs = 2000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      // searchFiles よりも getFiles の方が内部エラーが起きにくい
      const files = folder.getFiles(); 
      const list = [];
      while (files.hasNext()) {
        const file = files.next();
        // ゴミ箱に入っていないものだけ抽出
        if (!file.isTrashed()) {
          list.push(file);
        }
      }
      return list;
    } catch (e) {
      if (i === maxRetries - 1) throw e; // 最後までダメならエラーを投げる
      console.warn(`Drive API 一時エラー (試行 ${i + 1}回目): ${e.message}`);
      Utilities.sleep(delayMs * (i + 1)); // 指数関数的に待機時間を増やす
    }
  }
  return [];
}

function processSlackAction(fileId, payload, userName) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('SLACK_BOT_TOKEN');
  const quickDoneIds = JSON.parse(props.getProperty("DONE_IDS") || "[]");
  if (quickDoneIds.includes(fileId)) {
    updateSlackMessage(token, payload, `✅ *処理済みです*`);
    return;
  }
  const cache = CacheService.getScriptCache();
  const lockKey = "action_lock_" + fileId;
  if (cache.get(lockKey)) return;
  cache.put(lockKey, "true", 15);
  try {
    const printedFolderId = props.getProperty('PRINTED_FOLDER_ID');
    const doneIds = JSON.parse(props.getProperty("DONE_IDS") || "[]");
    if (doneIds.includes(fileId)) {
      updateSlackMessage(token, payload, `✅ *処理済みです*`);
      return;
    }
    const file = DriveApp.getFileById(fileId);
    const originalName = file.getName();
    file.moveTo(DriveApp.getFolderById(printedFolderId));
    if (!originalName.startsWith('【印刷済】')) file.setName('【印刷済】' + originalName);
    doneIds.push(fileId);
    props.setProperty("DONE_IDS", JSON.stringify(doneIds.slice(-100)));
    updateSlackMessage(token, payload, `✅ *印刷済みに移動しました*\n*担当:* ${userName}\n*ファイル:* ${originalName}`);
  } catch (err) {
    updateSlackMessage(token, payload, "⚠️ エラーが発生しました");
    cache.remove(lockKey);
  }
}

function updateSlackMessage(token, payload, messageText) {
  const channel = payload._meta.channel;
  const ts = payload._meta.ts;
  UrlFetchApp.fetch("https://slack.com/api/chat.update", {
    method: "post",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    payload: JSON.stringify({
      channel: channel, ts: ts, text: messageText,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: messageText } },
               { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "📂 フォルダを確認" }, url: CONFIG.SOURCE_FOLDER_URL }] }]
    })
  });
}

function sendToSlack(payload) {
  const token = PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
  UrlFetchApp.fetch("https://slack.com/api/chat.postMessage", {
    method: "post",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    payload: JSON.stringify({ channel: CONFIG.CHANNEL_ID, ...payload })
  });
}

function testMail() {
  sendEmailWithAttachment('1smFoyaQHpDisME8wJ2bXoIbl50xe4xGi', 'テスト');
}

function authTest() {
  MailApp.sendEmail("test@example.com", "test", "test");
}

function testNumbering() {
  const testFileId = '1PXc7BxoLWURIwu1HmYR7lp1o2cIEOC_V';
  const file = DriveApp.getFileById(testFileId);
  applyNumberingToPdf(file).then(title => {
    console.log('成功:', title);
  }).catch(err => {
    console.log('失敗:', err.message);
    console.log(err.stack);
  });
}