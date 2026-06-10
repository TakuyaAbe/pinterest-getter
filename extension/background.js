// Pinterest Board Downloader - service worker
// PinterestのリソースAPI(同一オリジン+ログインCookie)でピンを列挙し、
// chrome.downloads で originals 解像度の画像を保存する。

const SECTION_PAGE_SIZE = 50; // BoardSectionPinsResourceは100以上で400を返す
const FEED_PAGE_SIZE = 250;
const DOWNLOAD_CONCURRENCY = 4;

const state = {
  running: false,
  cancel: false,
  boardName: "",
  phase: "", // 今処理中のフィード名
  stage: "", // ピン列挙中 / 画像取得中 / ZIP作成中 / 保存中
  total: 0, // 推定ピン数(ZIPモードでは画像数の確定値)
  done: 0,
  failed: 0,
  finished: false,
  error: "",
};

function resetState() {
  Object.assign(state, {
    running: false,
    cancel: false,
    boardName: "",
    phase: "",
    stage: "",
    total: 0,
    done: 0,
    failed: 0,
    finished: false,
    error: "",
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// MV3のSWは「拡張API呼び出し/イベント受信」が30秒ないと強制終了される。
// fetchやsetTimeoutはアイドルタイマーをリセットしないため、実行中は
// 定期的に軽いAPIを呼んで生存させる。
let keepaliveTimer = null;
function startKeepalive() {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20000);
}
function stopKeepalive() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

function sanitize(name) {
  return (
    String(name)
      .replace(/[\\/:*?"<>|~\x00-\x1f]/g, "_")
      .replace(/^[\s.]+|[\s.]+$/g, "") || "untitled"
  );
}

// --- Pinterest API ----------------------------------------------------------

async function api(root, name, options, sourceUrl = "/") {
  const params = new URLSearchParams({
    source_url: sourceUrl,
    data: JSON.stringify({ options, context: {} }),
  });
  const res = await fetch(`${root}/resource/${name}/get/?${params}`, {
    credentials: "include",
    headers: {
      Accept: "application/json, text/javascript, */*, q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      "X-Pinterest-AppState": "active",
      "X-Pinterest-PWS-Handler": "www/index.js",
    },
  });
  if (!res.ok) throw new Error(`${name} ${res.status}`);
  const json = await res.json();
  return json.resource_response;
}

async function* paged(root, name, options, sourceUrl = "/") {
  let bookmark = null;
  while (true) {
    const opts = bookmark ? { ...options, bookmarks: [bookmark] } : options;
    const rr = await api(root, name, opts, sourceUrl);
    for (const item of rr.data || []) yield item;
    bookmark = rr.bookmark;
    if (!bookmark || bookmark === "-end-") break;
    await sleep(400);
  }
}

async function collect(gen) {
  const out = [];
  for await (const item of gen) out.push(item);
  return out;
}

const getBoard = (root, username, slug) =>
  api(root, "BoardResource", {
    username,
    slug,
    field_set_key: "detailed",
  }, `/${encodeURIComponent(username)}/${encodeURIComponent(slug)}/`).then(
    (rr) => rr.data
  );

const getSections = (root, boardId) =>
  collect(paged(root, "BoardSectionsResource", { board_id: boardId }));

const boardPins = (root, board) =>
  paged(
    root,
    "BoardFeedResource",
    { board_id: board.id, board_url: board.url, page_size: FEED_PAGE_SIZE },
    board.url
  );

const sectionPins = (root, sectionId) =>
  paged(root, "BoardSectionPinsResource", {
    section_id: sectionId,
    page_size: SECTION_PAGE_SIZE,
  });

// --- image extraction --------------------------------------------------------

function bestImage(images) {
  if (!images) return null;
  if (images.orig) return images.orig.url;
  let best = null;
  let bestSize = -1;
  for (const v of Object.values(images)) {
    const size = (v.width || 0) * (v.height || 0);
    if (size > bestSize) {
      bestSize = size;
      best = v.url;
    }
  }
  return best;
}

function pinImageUrls(pin) {
  const urls = [];
  const slots = pin.carousel_data?.carousel_slots || [];
  for (const slot of slots) {
    const u = bestImage(slot.images);
    if (u) urls.push(u);
  }
  for (const page of pin.story_pin_data?.pages || []) {
    for (const block of page.blocks || []) {
      const u = bestImage(block.image?.images);
      if (u) urls.push(u);
    }
  }
  if (!urls.length) {
    const u = bestImage(pin.images);
    if (u) urls.push(u);
  }
  return [...new Set(urls)];
}

// --- downloads ----------------------------------------------------------------

const pendingDownloads = new Map(); // downloadId -> {resolve, url, filename, retried}

chrome.downloads.onChanged.addListener((delta) => {
  const p = pendingDownloads.get(delta.id);
  if (!p) return;
  const st = delta.state?.current;
  if (st === "complete") {
    pendingDownloads.delete(delta.id);
    p.resolve({ ok: true });
  } else if (st === "interrupted") {
    pendingDownloads.delete(delta.id);
    // originalsが403等で落ちるピンがあるので736xにフォールバック
    if (!p.retried && p.url.includes("/originals/")) {
      startDownloadItem(
        p.url.replace("/originals/", "/736x/"),
        p.filename,
        p.resolve,
        true
      );
    } else {
      p.resolve({ ok: false, error: delta.error?.current || "interrupted" });
    }
  }
});

function startDownloadItem(url, filename, resolve, retried) {
  chrome.downloads.download(
    { url, filename, conflictAction: "overwrite", saveAs: false },
    (id) => {
      if (id === undefined) {
        resolve({
          ok: false,
          error: chrome.runtime.lastError?.message || "download failed",
        });
        return;
      }
      pendingDownloads.set(id, { resolve, url, filename, retried });
    }
  );
}

const downloadFile = (url, filename) =>
  new Promise((resolve) => startDownloadItem(url, filename, resolve, false));

// 同時実行数を抑えるための簡易プール
const inflight = new Set();
async function schedule(fn) {
  while (inflight.size >= DOWNLOAD_CONCURRENCY) {
    await Promise.race(inflight);
  }
  let p;
  p = fn().finally(() => inflight.delete(p));
  inflight.add(p);
  return p;
}

// --- offscreen (ZIPモード) --------------------------------------------------------

let zipWaiter = null; // {resolve}

async function ensureOffscreen() {
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "画像をZIPにまとめてobject URLを生成する",
    });
  } catch (e) {
    // 既に存在する場合のエラーは無視
    if (!/single offscreen|Only a single/i.test(String(e?.message))) throw e;
  }
}

async function closeOffscreen() {
  try {
    await chrome.offscreen.closeDocument();
  } catch {}
}

const sendToOffscreen = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

function zipViaOffscreen(jobs, zipName) {
  return new Promise((resolve) => {
    zipWaiter = { resolve };
    // 前回の異常終了でストール中のoffscreenが残っている可能性があるので
    // 必ず破棄してから作り直す(孤児Blobの解放と二重run防止)
    closeOffscreen()
      .then(() => ensureOffscreen())
      .then(() => sendToOffscreen({ type: "zip:start", jobs, zipName }))
      .catch((e) => {
        state.error = String(e?.message || e);
        zipWaiter = null;
        resolve();
      });
  });
}

async function handleZipMessage(msg) {
  if (msg.type === "zip:progress") {
    state.done = msg.done;
    state.failed = msg.failed;
    return;
  }
  if (msg.type === "zip:building") {
    state.stage = "ZIP作成中";
    return;
  }
  if (msg.type === "zip:done") {
    state.stage = "保存中";
    state.done = msg.done;
    state.failed = msg.failed;
    for (const part of msg.parts) {
      const r = await downloadFile(part.url, part.filename);
      if (!r.ok) state.error = `ZIPの保存に失敗: ${r.error || "不明なエラー"}`;
    }
    await closeOffscreen(); // blob URLはダウンロード完了後に破棄
    finishZip();
    return;
  }
  if (msg.type === "zip:cancelled" || msg.type === "zip:error") {
    if (msg.type === "zip:error") state.error = msg.message;
    await closeOffscreen();
    finishZip();
  }
}

function finishZip() {
  if (zipWaiter) {
    zipWaiter.resolve();
    zipWaiter = null;
  } else {
    // SWが途中で再起動してrunDownloadのコンテキストが消えた場合でも完了扱いにする
    state.running = false;
    state.finished = true;
    state.stage = "";
    state.phase = "";
  }
}

// --- main download flow ---------------------------------------------------------

function imageJobsForPin(pin, dir) {
  const urls = pinImageUrls(pin);
  return urls.map((url, i) => {
    const extMatch = new URL(url).pathname.match(/\.[a-zA-Z0-9]+$/);
    const ext = extMatch ? extMatch[0] : ".jpg";
    const suffix = urls.length > 1 ? `_${i + 1}` : "";
    return { url, path: `${dir}/${pin.id}${suffix}${ext}` };
  });
}

async function downloadFeed(root, gen, dir) {
  for await (const pin of gen) {
    if (state.cancel) return;
    if (pin.type && pin.type !== "pin") continue;
    for (const job of imageJobsForPin(pin, dir)) {
      schedule(async () => {
        const r = await downloadFile(job.url, job.path);
        if (r.ok) state.done += 1;
        else state.failed += 1;
      });
    }
    await sleep(60);
  }
}

async function collectJobs(gen, dir, jobs) {
  for await (const pin of gen) {
    if (state.cancel) return;
    if (pin.type && pin.type !== "pin") continue;
    jobs.push(...imageJobsForPin(pin, dir));
    state.done = jobs.length; // 列挙中は見つけた画像数を表示
  }
}

async function runDownload({ root, username, slug, mode, sectionId, sectionTitle, zip }) {
  if (state.running) return;
  resetState();
  state.running = true;
  startKeepalive();
  try {
    const board = await getBoard(root, username, slug);
    if (!board?.id) throw new Error("ボードを取得できませんでした");
    const boardName = sanitize(board.name || slug);
    state.boardName = board.name || slug;

    let sections = [];
    if ((board.section_count || 0) > 0 && mode !== "board") {
      sections = await getSections(root, board.id);
    }
    const sectionPinSum = sections.reduce((a, s) => a + (s.pin_count || 0), 0);

    // dir: ZIP内 or ダウンロードフォルダ内の相対パス(ZIPモードでは
    // ZIP自体がPinterest/に入るため、エントリにはプレフィックスを付けない)
    const prefix = zip ? boardName : `Pinterest/${boardName}`;
    let zipName = boardName;

    const jobs = [];
    if (sectionId) {
      const sec = sections.find((s) => String(s.id) === String(sectionId));
      const title = sec?.title || sectionTitle || "section";
      state.total = sec?.pin_count || 0;
      zipName = `${boardName} - ${sanitize(title)}`;
      jobs.push({
        label: title,
        gen: sectionPins(root, sectionId),
        dir: `${prefix}/${sanitize(title)}`,
      });
    } else {
      if (mode === "all") state.total = board.pin_count || 0;
      else if (mode === "board")
        state.total = Math.max((board.pin_count || 0) - sectionPinSum, 0);
      else state.total = sectionPinSum;

      if (mode === "all" || mode === "board") {
        jobs.push({ label: "ボード直下", gen: boardPins(root, board), dir: prefix });
      }
      if (mode === "all" || mode === "sections") {
        for (const sec of sections) {
          jobs.push({
            label: sec.title,
            gen: sectionPins(root, sec.id),
            dir: `${prefix}/${sanitize(sec.title)}`,
          });
        }
      }
    }

    if (zip) {
      state.stage = "ピン列挙中";
      const imageJobs = [];
      for (const job of jobs) {
        if (state.cancel) break;
        state.phase = job.label;
        await collectJobs(job.gen, job.dir, imageJobs);
      }
      state.phase = "";
      state.done = 0;
      state.total = imageJobs.length; // ここからは確定値
      if (!state.cancel && imageJobs.length) {
        state.stage = "画像取得中";
        await zipViaOffscreen(imageJobs, zipName);
      } else if (!imageJobs.length) {
        state.error = "対象の画像がありません";
      }
    } else {
      state.stage = "保存中";
      for (const job of jobs) {
        if (state.cancel) break;
        state.phase = job.label;
        await downloadFeed(root, job.gen, job.dir);
      }
      await Promise.all([...inflight]);
    }
  } catch (e) {
    state.error = String(e?.message || e);
  } finally {
    stopKeepalive();
    state.running = false;
    state.finished = true;
    state.phase = "";
    state.stage = "";
  }
}

// --- messaging -------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (typeof msg?.type === "string" && msg.type.startsWith("zip:")) {
    handleZipMessage(msg);
    return false;
  }
  if (msg.type === "getState") {
    sendResponse(state);
    return false;
  }
  if (msg.type === "boardInfo") {
    (async () => {
      const board = await getBoard(msg.root, msg.username, msg.slug);
      if (!board?.id) throw new Error("not found");
      const sections =
        (board.section_count || 0) > 0
          ? await getSections(msg.root, board.id)
          : [];
      return {
        name: board.name,
        pinCount: board.pin_count,
        sections: sections.map((s) => ({
          id: s.id,
          title: s.title,
          slug: s.slug,
          pinCount: s.pin_count,
        })),
      };
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e?.message || e) }));
    return true; // async response
  }
  if (msg.type === "start") {
    runDownload(msg.payload);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "cancel") {
    state.cancel = true;
    sendToOffscreen({ type: "zip:cancel" });
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
