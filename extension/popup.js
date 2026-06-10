// popup: アクティブタブのボードを検出し、background にダウンロード指示を送る

const $ = (id) => document.getElementById(id);

const RESERVED_FIRST = new Set([
  "pin", "ideas", "search", "today", "settings", "business", "resource",
  "news_hub", "notifications", "messages",
]);
const RESERVED_THIRD = new Set([
  "more_ideas", "_tools", "_saved", "_created", "organize",
]);

function parseBoardUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)pinterest\.(com|jp)$/.test(u.hostname)) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 2 || RESERVED_FIRST.has(parts[0])) return null;
  if (parts[1].startsWith("_")) return null;
  let section = parts[2] || null;
  if (section && RESERVED_THIRD.has(section)) section = null;
  return {
    root: u.origin,
    username: decodeURIComponent(parts[0]),
    slug: decodeURIComponent(parts[1]),
    sectionSlug: section ? decodeURIComponent(section) : null,
  };
}

const send = (msg) =>
  new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));

let target = null; // {root, username, slug, sectionSlug}
let info = null; // {name, pinCount, sections[]}
let pollTimer = null;

function setError(text) {
  $("error").textContent = text || "";
}

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function updateSectionSelectState() {
  $("sectionSelect").disabled = selectedMode() !== "section";
}

function renderState(st) {
  if (!st) return;
  const running = st.running;
  $("startBtn").disabled = running;
  $("cancelBtn").hidden = !running;
  $("progressArea").hidden = !running && !st.finished && !st.done;
  const processed = st.done + st.failed;
  const pct = st.total ? Math.min((processed / st.total) * 100, 100) : 0;
  const phase = st.phase ? ` (${st.phase})` : "";
  const stage = st.stage || "保存中";
  let label;
  if (st.stage === "ピン列挙中") {
    $("bar").removeAttribute("value"); // 母数未確定なのでindeterminate表示
    label = `${stage}: ${st.done}件見つかりました${phase}`;
  } else {
    $("bar").value = pct;
    label = `${stage}: ${st.done} / ${st.total}件${phase}`;
  }
  if (st.failed) label += ` / 失敗 ${st.failed}`;
  if (!running && st.finished) {
    $("bar").value = 100;
    label = st.error
      ? `エラー: ${st.error}`
      : st.cancel
        ? `キャンセルしました`
        : `完了: ${st.done}件保存${st.failed ? ` / 失敗 ${st.failed}件` : ""} → ダウンロード/Pinterest/`;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }
  $("stats").textContent = label;
  if (st.error && !running) setError("");
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => renderState(await send({ type: "getState" })), 500);
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  target = tab?.url ? parseBoardUrl(tab.url) : null;
  if (!target) {
    $("notboard").hidden = false;
    return;
  }
  $("main").hidden = false;
  $("boardname").textContent = `${target.username}/${target.slug}`;

  // 進行中のダウンロードがあれば表示を復元
  const st = await send({ type: "getState" });
  if (st?.running) {
    renderState(st);
    startPolling();
  }

  info = await send({
    type: "boardInfo",
    root: target.root,
    username: target.username,
    slug: target.slug,
  });
  if (!info || info.error) {
    setError(
      `ボード情報を取得できません: ${info?.error || "不明なエラー"}` +
        "(非公開ボードはPinterestにログインした状態で開いてください)"
    );
    $("startBtn").disabled = true;
    return;
  }

  $("boardname").textContent = info.name;
  $("counts").textContent = `ピン ${info.pinCount}件 / セクション ${info.sections.length}件`;

  const sel = $("sectionSelect");
  sel.innerHTML = "";
  for (const s of info.sections) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = `${s.title} (${s.pinCount}件)`;
    opt.dataset.title = s.title;
    sel.appendChild(opt);
  }
  if (!info.sections.length) {
    for (const radio of document.querySelectorAll('input[name="mode"]')) {
      if (radio.value !== "all" && radio.value !== "board") radio.disabled = true;
    }
  }

  // セクションページを開いている場合はそのセクションを初期選択
  if (target.sectionSlug) {
    const match = info.sections.find((s) => s.slug === target.sectionSlug);
    if (match) {
      $("modeSection").checked = true;
      sel.value = match.id;
    }
  }
  updateSectionSelectState();
}

document.addEventListener("change", (e) => {
  if (e.target.name === "mode") updateSectionSelectState();
});

$("startBtn").addEventListener("click", async () => {
  if (!target || !info) return;
  setError("");
  const mode = selectedMode();
  const payload = {
    root: target.root,
    username: target.username,
    slug: target.slug,
    mode: mode === "section" ? "all" : mode,
    zip: $("zipMode").checked,
  };
  if (mode === "section") {
    const sel = $("sectionSelect");
    if (!sel.value) {
      setError("セクションを選択してください");
      return;
    }
    payload.sectionId = sel.value;
    payload.sectionTitle = sel.selectedOptions[0]?.dataset.title;
  }
  await send({ type: "start", payload });
  $("startBtn").disabled = true;
  $("progressArea").hidden = false;
  startPolling();
});

$("cancelBtn").addEventListener("click", async () => {
  await send({ type: "cancel" });
});

init();
