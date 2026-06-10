// offscreen document: 画像をfetchしてZIP(無圧縮store)を組み立て、
// blob URLをservice workerへ返す。
// MV3のservice workerではURL.createObjectURLが使えないためここで行う。

const FETCH_CONCURRENCY = 4;
const PART_LIMIT = 3.5 * 1024 ** 3; // zip64非対応なので4GB手前で分割
const MAX_ENTRIES_PER_PART = 65000; // 同じく65535エントリ手前で分割

let cancelled = false;
let active = false; // run()の二重起動ガード
const abortControllers = new Set();
let createdUrls = [];

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "zip:start") {
    if (active) {
      send({ type: "zip:error", message: "別のZIP処理が実行中です" });
      return;
    }
    active = true;
    cancelled = false;
    run(msg.jobs, msg.zipName)
      .catch((e) => send({ type: "zip:error", message: String(e?.message || e) }))
      .finally(() => {
        active = false;
      });
  } else if (msg.type === "zip:cancel") {
    cancelled = true;
    for (const ac of abortControllers) ac.abort();
  } else if (msg.type === "zip:cleanup") {
    for (const u of createdUrls) URL.revokeObjectURL(u);
    createdUrls = [];
  }
});

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

async function run(jobs, zipName) {
  const entries = [];
  let done = 0;
  let failed = 0;
  let idx = 0;

  async function worker() {
    while (idx < jobs.length && !cancelled) {
      const job = jobs[idx++];
      try {
        const buf = await fetchImage(job.url);
        const bytes = new Uint8Array(buf);
        entries.push({
          path: job.path,
          crc: crc32(bytes),
          size: bytes.length,
          blob: new Blob([buf]),
        });
        done++;
      } catch (e) {
        if (cancelled) break;
        failed++;
      }
    }
  }

  // 進捗は件数トリガーではなく定期送信にする。SW側はこのメッセージが
  // アイドルタイマーをリセットする生存信号を兼ねるため、ストール中でも
  // 送り続ける必要がある(30秒空くとSWがkillされる)。
  const heartbeat = setInterval(
    () => send({ type: "zip:progress", done, failed }),
    2500
  );
  try {
    await Promise.all(
      Array.from({ length: Math.min(FETCH_CONCURRENCY, jobs.length) }, worker)
    );
  } finally {
    clearInterval(heartbeat);
  }
  send({ type: "zip:progress", done, failed });

  if (cancelled) {
    send({ type: "zip:cancelled" });
    return;
  }
  if (!entries.length) {
    send({ type: "zip:error", message: "画像を1枚も取得できませんでした" });
    return;
  }

  send({ type: "zip:building" });
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  const partBlobs = buildZipParts(entries);
  const parts = partBlobs.map((blob, i) => {
    const url = URL.createObjectURL(blob);
    createdUrls.push(url);
    const suffix = partBlobs.length > 1 ? `.part${i + 1}` : "";
    return { url, filename: `Pinterest/${zipName}${suffix}.zip` };
  });
  send({ type: "zip:done", parts, done, failed });
}

const FETCH_TIMEOUT_MS = 60000;

async function fetchImage(url) {
  const ac = new AbortController();
  abortControllers.add(ac);
  // 無応答ストールで永久に待たないようタイムアウトを張る
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    let res = await fetch(url, { signal: ac.signal });
    if (!res.ok && url.includes("/originals/")) {
      // originalsが無いピンは736xにフォールバック
      res = await fetch(url.replace("/originals/", "/736x/"), {
        signal: ac.signal,
      });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.arrayBuffer();
  } finally {
    clearTimeout(timer);
    abortControllers.delete(ac);
  }
}

// --- ZIP (store / 無圧縮) -----------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date:
      (((d.getFullYear() - 1980) & 0x7f) << 9) |
      ((d.getMonth() + 1) << 5) |
      d.getDate(),
  };
}

function localHeader(e) {
  const b = new DataView(new ArrayBuffer(30));
  b.setUint32(0, 0x04034b50, true);
  b.setUint16(4, 20, true); // version needed
  b.setUint16(6, 0x0800, true); // UTF-8ファイル名フラグ
  b.setUint16(8, 0, true); // method: store
  b.setUint16(10, e.time, true);
  b.setUint16(12, e.date, true);
  b.setUint32(14, e.crc, true);
  b.setUint32(18, e.size, true); // compressed
  b.setUint32(22, e.size, true); // uncompressed
  b.setUint16(26, e.nameBytes.length, true);
  b.setUint16(28, 0, true); // extra len
  return b.buffer;
}

function centralEntry(e) {
  const b = new DataView(new ArrayBuffer(46));
  b.setUint32(0, 0x02014b50, true);
  b.setUint16(4, 20, true); // version made by
  b.setUint16(6, 20, true); // version needed
  b.setUint16(8, 0x0800, true);
  b.setUint16(10, 0, true);
  b.setUint16(12, e.time, true);
  b.setUint16(14, e.date, true);
  b.setUint32(16, e.crc, true);
  b.setUint32(20, e.size, true);
  b.setUint32(24, e.size, true);
  b.setUint16(28, e.nameBytes.length, true);
  // 30:extra 32:comment 34:diskStart 36:internalAttr は0のまま
  b.setUint32(38, 0, true); // external attrs
  b.setUint32(42, e.offset, true);
  return b.buffer;
}

function endOfCentral(count, cdSize, cdOffset) {
  const b = new DataView(new ArrayBuffer(22));
  b.setUint32(0, 0x06054b50, true);
  b.setUint16(8, count, true);
  b.setUint16(10, count, true);
  b.setUint32(12, cdSize, true);
  b.setUint32(16, cdOffset, true);
  return b.buffer;
}

function buildZipParts(entries) {
  const encoder = new TextEncoder();
  const now = dosDateTime(new Date());
  const partBlobs = [];
  let cur = [];
  let curSize = 0;

  const flush = () => {
    if (cur.length) {
      partBlobs.push(assemblePart(cur, now));
      cur = [];
      curSize = 0;
    }
  };

  for (const e of entries) {
    e.nameBytes = encoder.encode(e.path);
    const entrySize = 30 + 46 + e.nameBytes.length * 2 + e.size;
    if (
      cur.length &&
      (curSize + entrySize > PART_LIMIT || cur.length >= MAX_ENTRIES_PER_PART)
    ) {
      flush();
    }
    cur.push(e);
    curSize += entrySize;
  }
  flush();
  return partBlobs;
}

function assemblePart(entries, now) {
  const parts = [];
  let offset = 0;
  for (const e of entries) {
    e.offset = offset;
    e.time = now.time;
    e.date = now.date;
    parts.push(localHeader(e), e.nameBytes, e.blob);
    offset += 30 + e.nameBytes.length + e.size;
  }
  const cdStart = offset;
  for (const e of entries) {
    parts.push(centralEntry(e), e.nameBytes);
    offset += 46 + e.nameBytes.length;
  }
  parts.push(endOfCentral(entries.length, offset - cdStart, cdStart));
  return new Blob(parts, { type: "application/zip" });
}
