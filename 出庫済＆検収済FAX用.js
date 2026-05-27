// ========== タイムドリブン監視用（表紙マージ） ==========
// 以下の定数が未定義の場合は定義（既存CONFIGに追記でも可）
const NO_NUMBERING_FOLDER_ID = '1c2dM1oLJAV-6bfItPxNOqfvmA_cI6RzA';
const NO_NUMBERING_FOLDER_URL = 'https://drive.google.com/drive/folders/1c2dM1oLJAV-6bfItPxNOqfvmA_cI6RzA';
const INSPECTION_FOLDER_ID = '16f5tmV_lNLxAnyBS3UaC7hvxCXnI5mSs';
const INSPECTION_FOLDER_URL = 'https://drive.google.com/drive/folders/16f5tmV_lNLxAnyBS3UaC7hvxCXnI5mSs';
const INSPECTION_COVER_TEMPLATE_ID = '1MQ9BGrprGNe2GqC7c9-Kwl5DCZZxf1lVD7TKLhKj1x8'; // 検収済み表紙テンプレート
const COVER_TEMPLATE_DOC_ID = '1Aspv5G2huyPp355-MiEc0fxraGFox3wc4LnBWAod6h4'; // 既に使っているものを設定

/**
 * 【タイムドリブン用メイン関数】
 * この関数を5分おきにトリガー実行してください。
 */
async function scanAndProcessCoverFolders() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    console.log("別の実行中のためスキップ");
    return;
  }

  try {
    const props = PropertiesService.getScriptProperties();
    const cache = CacheService.getScriptCache();

    // 処理対象フォルダのリスト
    const targets = [
      {
        folderId: NO_NUMBERING_FOLDER_ID,
        folderUrl: NO_NUMBERING_FOLDER_URL,
        type: 'no_numbering',
        handler: processNoNumberingFolderFile
      },
      {
        folderId: INSPECTION_FOLDER_ID,
        folderUrl: INSPECTION_FOLDER_URL,
        type: 'inspection',
        handler: processInspectionFolderFile
      }
    ];

    for (const target of targets) {
      const folder = DriveApp.getFolderById(target.folderId);
      const files = folder.getFiles();
      
      // 処理済みIDリストを取得
      const propKey = `PROCESSED_${target.type.toUpperCase()}_IDS`;
      let processedIds = JSON.parse(props.getProperty(propKey) || "[]");

      while (files.hasNext()) {
        const file = files.next();
        const fileId = file.getId();
        const fileName = file.getName();

        // PDF以外、ゴミ箱内、処理済み、キャッシュ有りの場合はスキップ
        if (file.getMimeType() !== MimeType.PDF) continue;
        if (file.isTrashed()) continue;
        if (processedIds.includes(fileId)) continue;
        if (cache.get("cover_" + fileId)) continue;

        // 処理開始
        console.log(`表紙マージ処理開始: ${fileName}`);
        cache.put("cover_" + fileId, "true", 600);
        
        try {
          await target.handler(fileId, fileName);
          processedIds.push(fileId);
          console.log(`✅ 処理完了: ${fileName}`);
        } catch (err) {
          console.error(`❌ 処理失敗 (${fileName}):`, err.message);
          sendToSlack({
            text: `⚠️ *表紙マージエラー*\nファイル: ${fileName}\nエラー: \`${err.message}\``
          });
        }
      }

      // 処理済みIDを保存（直近100件まで）
      if (processedIds.length > 0) {
        props.setProperty(propKey, JSON.stringify(processedIds.slice(-100)));
      }
    }
  } catch (e) {
    console.error("scanAndProcessCoverFolders 全体エラー:", e);
  } finally {
    lock.releaseLock();
  }
}

// ========== 以下、必要な内部関数（既存になければ追加） ==========

/**
 * ナンバリングなしフォルダ用：表紙（出庫入力済み）を生成・マージ
 */
async function processNoNumberingFolderFile(fileId, fileName) {
  const file = DriveApp.getFileById(fileId);
  const originalBlob = getBlobWithRetry(file);
  const originalBytes = new Uint8Array(originalBlob.getBytes());
  const originalPdf = await PDFLib.PDFDocument.load(originalBytes);
  const pageCount = originalPdf.getPages().length;

  const today = new Date();
  const month = Utilities.formatDate(today, "JST", "M");
  const day = Utilities.formatDate(today, "JST", "d");
  const dateStr = `${month}月${day}日`;

  const coverBlob = generateCoverPdf(dateStr, pageCount);
  const mergedBlob = await mergeCoverWithOriginal(coverBlob, originalBlob);
  updateFileWithRetry(fileId, mergedBlob);

  const todayStr = Utilities.formatDate(new Date(), "JST", "yyyy-MM-dd");
  const headerText = `✅ *出庫入力済み受注表 (${todayStr}-計${pageCount}枚)*`;
  sendToSlack({
    text: headerText,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: headerText } },
      { type: "section", text: { type: "mrkdwn", text: `*ファイル:*\n<https://drive.google.com/file/d/${fileId}/view|${fileName}>` } },
      { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "📂 フォルダを確認" }, url: NO_NUMBERING_FOLDER_URL }] }
    ]
  });

  sendEmailWithAttachment(fileId, fileName);
}

/**
 * 検収済みフォルダ用：表紙（検収済み）を生成・マージ
 */
async function processInspectionFolderFile(fileId, fileName) {
  const file = DriveApp.getFileById(fileId);
  const originalBlob = getBlobWithRetry(file);
  const originalBytes = new Uint8Array(originalBlob.getBytes());
  const originalPdf = await PDFLib.PDFDocument.load(originalBytes);
  const pageCount = originalPdf.getPages().length;

  const coverBlob = generateInspectionCoverPdf(pageCount);
  const mergedBlob = await mergeCoverWithOriginal(coverBlob, originalBlob);
  updateFileWithRetry(fileId, mergedBlob);

  const headerText = `✍️ *検収済み受注表 (計${pageCount}枚)*`;
  sendToSlack({
    text: headerText,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: headerText } },
      { type: "section", text: { type: "mrkdwn", text: `*ファイル:*\n<https://drive.google.com/file/d/${fileId}/view|${fileName}>` } },
      { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "📂 フォルダを確認" }, url: INSPECTION_FOLDER_URL }] }
    ]
  });

  sendEmailWithAttachment(fileId, fileName);
}

/**
 * 表紙PDF生成（出庫入力済み用）
 */
function generateCoverPdf(dateStr, pageCount) {
  const templateId = PropertiesService.getScriptProperties().getProperty('COVER_TEMPLATE_DOC_ID') || COVER_TEMPLATE_DOC_ID;
  if (!templateId) throw new Error('COVER_TEMPLATE_DOC_ID が設定されていません');

  const templateFile = DriveApp.getFileById(templateId);
  const copyFile = templateFile.makeCopy(`cover_temp_${Date.now()}`);
  const copyDoc = DocumentApp.openById(copyFile.getId());
  const body = copyDoc.getBody();

  body.replaceText('{{DATE}}', dateStr);
  body.replaceText('{{PAGES}}', pageCount.toString());

  copyDoc.saveAndClose();
  const pdfBlob = copyFile.getAs('application/pdf');
  pdfBlob.setName('cover.pdf');
  copyFile.setTrashed(true);
  return pdfBlob;
}

/**
 * 表紙PDF生成（検収済み用）
 */
function generateInspectionCoverPdf(pageCount) {
  const templateId = INSPECTION_COVER_TEMPLATE_ID;
  if (!templateId) throw new Error('INSPECTION_COVER_TEMPLATE_ID が設定されていません');

  const templateFile = DriveApp.getFileById(templateId);
  const copyFile = templateFile.makeCopy(`inspection_cover_temp_${Date.now()}`);
  const copyDoc = DocumentApp.openById(copyFile.getId());
  const body = copyDoc.getBody();

  body.replaceText('{{PAGES}}', pageCount.toString());

  copyDoc.saveAndClose();
  const pdfBlob = copyFile.getAs('application/pdf');
  pdfBlob.setName('inspection_cover.pdf');
  copyFile.setTrashed(true);
  return pdfBlob;
}

/**
 * PDF結合（表紙 + 元PDF）
 */
async function mergeCoverWithOriginal(coverBlob, originalBlob) {
  const coverBytes = new Uint8Array(coverBlob.getBytes());
  const mergedPdf = await PDFLib.PDFDocument.load(coverBytes);

  const originalBytes = new Uint8Array(originalBlob.getBytes());
  const originalPdf = await PDFLib.PDFDocument.load(originalBytes);

  const originalPages = await mergedPdf.copyPages(originalPdf, originalPdf.getPageIndices());
  originalPages.forEach(page => mergedPdf.addPage(page));

  const mergedBytes = await mergedPdf.save();
  return Utilities.newBlob(mergedBytes, 'application/pdf', originalBlob.getName());
}

/**
 * リトライ付きBlob取得
 */
function getBlobWithRetry(file, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return file.getBlob();
    } catch (e) {
      if (i === maxRetries - 1) throw e;
      Utilities.sleep(2000 * (i + 1));
    }
  }
}

/**
 * リトライ付きファイル更新
 */
function updateFileWithRetry(fileId, blob, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      Drive.Files.update({}, fileId, blob);
      return;
    } catch (e) {
      if (i === maxRetries - 1) throw e;
      Utilities.sleep(2000 * (i + 1));
    }
  }
}

/**
 * トリガー設定用関数
 */
function setupCoverFolderTrigger() {
  // 既存の同名トリガーを削除
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'scanAndProcessCoverFolders') {
      ScriptApp.deleteTrigger(t);
    }
  });
  
  // 1分おきに実行
  ScriptApp.newTrigger('scanAndProcessCoverFolders')
    .timeBased()
    .everyMinutes(1)
    .create();
  
  console.log("✅ 表紙マージ用トリガーを1分間隔で設定しました");
}

/**
 * 処理済みファイルIDの一覧をファイル名とフォルダ名付きでログに出力する
 */
function checkProcessedFiles() {
  const props = PropertiesService.getScriptProperties();
  
  // 確認したいプロパティキーのリスト
  const propKeys = [
    { key: 'PROCESSED_NO_NUMBERING_IDS', name: '📂 出庫入力済みフォルダ' },
    { key: 'PROCESSED_INSPECTION_IDS', name: '📂 検収済みフォルダ' },
    { key: 'NOTIFIED_FILE_IDS', name: '📂 ナンバリングフォルダ（旧）' },
    { key: 'NOTIFIED_NO_NUMBERING_IDS', name: '📂 ナンバリングなし（旧）' },
    { key: 'NOTIFIED_INSPECTION_IDS', name: '📂 検収済み（旧）' }
  ];

  for (const item of propKeys) {
    const idsJson = props.getProperty(item.key);
    const ids = idsJson ? JSON.parse(idsJson) : [];
    
    console.log(`\n========== ${item.name} (${item.key}) ==========`);
    console.log(`登録件数: ${ids.length}件`);
    
    if (ids.length === 0) {
      console.log("  → 登録なし");
      continue;
    }

    // 各IDについてファイル情報を取得
    ids.forEach((fileId, index) => {
      try {
        const file = DriveApp.getFileById(fileId);
        const fileName = file.getName();
        
        // 親フォルダ名を取得
        const parents = file.getParents();
        const parentNames = [];
        while (parents.hasNext()) {
          parentNames.push(parents.next().getName());
        }
        const parentStr = parentNames.length > 0 ? parentNames.join(' > ') : '（親フォルダ不明）';
        
        console.log(`  ${index + 1}. [${parentStr}] ${fileName} (ID: ${fileId})`);
      } catch (e) {
        console.log(`  ${index + 1}. ❌ ファイル取得エラー (ID: ${fileId}) - ${e.message}`);
      }
    });
  }
  
  console.log("\n✅ 確認完了");
}