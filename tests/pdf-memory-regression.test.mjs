import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const SOURCE_PATH = new URL('../受注表ナンバリングFAX用.js', import.meta.url);
const SOURCE = readFileSync(SOURCE_PATH, 'utf8');

function createHarness({ pageCount, savedSize, pendingNumbers = null }) {
  const properties = new Map();
  const drawCalls = [];
  const fetchCalls = [];
  let sourceGetBytesCalls = 0;
  let outputGetBytesCalls = 0;
  let driveUpdateBlob = null;
  let outputBlob = null;

  if (pendingNumbers) {
    properties.set('PENDING_NUMBERS_file-1', JSON.stringify({
      pageCount,
      numbers: pendingNumbers,
      savedAt: Date.now()
    }));
  }

  const scriptProperties = {
    getProperty(key) {
      return properties.has(key) ? properties.get(key) : null;
    },
    setProperty(key, value) {
      properties.set(key, value);
    },
    setProperties(values) {
      Object.entries(values).forEach(([key, value]) => properties.set(key, value));
    },
    deleteProperty(key) {
      properties.delete(key);
    }
  };

  const pages = Array.from({ length: pageCount }, () => ({
    getSize: () => ({ width: 600, height: 800 }),
    drawText: (text, options) => drawCalls.push({ text, options })
  }));

  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => scriptProperties },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock() {} })
    },
    Utilities: {
      sleep() {},
      formatDate: () => '2026-08-04',
      newBlob(data, contentType, name) {
        outputBlob = {
          data,
          name,
          getContentType: () => contentType,
          getBytes() {
            outputGetBytesCalls++;
            throw new Error('出力BlobをByte[]へ再展開してはいけません');
          }
        };
        return outputBlob;
      }
    },
    PDFLib: {
      StandardFonts: { Helvetica: 'Helvetica' },
      rgb: (r, g, b) => ({ r, g, b }),
      PDFDocument: {
        async load(bytes) {
          assert.deepEqual(Array.from(bytes), [1, 2, 3]);
          return {
            getPages: () => pages,
            embedFont: async () => ({ widthOfTextAtSize: text => text.length * 7 }),
            save: async () => ({ length: savedSize, marker: 'saved-pdf' })
          };
        }
      }
    },
    ScriptApp: { getOAuthToken: () => 'token' },
    DriveApp: {
      getFileById: () => ({ getLastUpdated: () => new Date('2026-08-04T03:00:00Z') })
    },
    Drive: {
      Files: {
        update(metadata, fileId, blob) {
          driveUpdateBlob = blob;
        }
      }
    },
    UrlFetchApp: {
      fetch(url, options) {
        fetchCalls.push({ url, options });
        if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files/')) {
          return {
            getResponseCode: () => 200,
            getHeaders: () => ({ Location: 'https://upload.example/session' })
          };
        }
        if (url === 'https://upload.example/session') {
          return { getResponseCode: () => 200 };
        }
        throw new Error(`Unexpected URL: ${url}`);
      }
    }
  });

  vm.runInContext(SOURCE, context, { filename: '受注表ナンバリングFAX用.js' });

  const file = {
    getId: () => 'file-1',
    getName: () => 'scan.pdf',
    getBlob: () => ({
      getBytes() {
        sourceGetBytesCalls++;
        return [1, 2, 3];
      }
    })
  };

  return {
    context,
    file,
    properties,
    drawCalls,
    fetchCalls,
    get sourceGetBytesCalls() { return sourceGetBytesCalls; },
    get outputGetBytesCalls() { return outputGetBytesCalls; },
    get driveUpdateBlob() { return driveUpdateBlob; },
    get outputBlob() { return outputBlob; }
  };
}

test('大容量PDFは同じ番号・描画結果のままBlobを直接resumable uploadする', async () => {
  const numbers = ['2026-08-04-No.01', '2026-08-04-No.02'];
  const harness = createHarness({
    pageCount: 2,
    savedSize: 21 * 1024 * 1024,
    pendingNumbers: numbers
  });

  const title = await harness.context.applyNumberingToPdf(harness.file);

  assert.equal(title, '2026-08-04-No.01~No.02');
  assert.deepEqual(harness.drawCalls.map(call => call.text), numbers);
  assert.equal(harness.sourceGetBytesCalls, 1);
  assert.equal(harness.outputGetBytesCalls, 0);
  assert.equal(harness.fetchCalls.length, 2);
  assert.equal(harness.fetchCalls[0].options.headers['X-Upload-Content-Length'], String(21 * 1024 * 1024));
  assert.equal(harness.fetchCalls[1].options.payload, harness.outputBlob);
  assert.equal(harness.properties.has('PENDING_NUMBERS_file-1'), false);
});

test('小容量PDFも従来どおり番号を割り当てて同じDriveファイルを更新する', async () => {
  const harness = createHarness({ pageCount: 1, savedSize: 1024 });

  const title = await harness.context.applyNumberingToPdf(harness.file);

  assert.equal(title, '2026-08-04-No.01');
  assert.deepEqual(harness.drawCalls.map(call => call.text), ['2026-08-04-No.01']);
  assert.equal(harness.driveUpdateBlob, harness.outputBlob);
  assert.equal(harness.outputGetBytesCalls, 0);
  assert.equal(harness.properties.get('CURRENT_NUMBERING_NO'), '1');
  assert.equal(harness.properties.has('PENDING_NUMBERS_file-1'), false);
});
