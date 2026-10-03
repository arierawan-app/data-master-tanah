const APP_VERSION = "20261003-10";

const PAGE_SIZE = 50;
const ISSUE_COUNT = 5;
const ZERO_PATTERN = /^[+-]?0+(?:[.,]0+)?$/;
const LS_PREFS = "dmt.pivot.v1";

const state = {
  columns: [],
  rows: [],
  groupCol: 0,
  luasCol: -1,
  showCount: true,
  showLuas: false,
  missing: new Set(),
  quick: "",
  sort: null,
  page: 1,
};

const els = {
  search: document.getElementById("pivotSearch"),
  groupSelect: document.getElementById("groupSelect"),
  mCount: document.getElementById("mCount"),
  mLuas: document.getElementById("mLuas"),
  missingBoxes: document.getElementById("missingBoxes"),
  exportBtn: document.getElementById("pivotExport"),
  table: document.getElementById("pivotTable"),
  headRow: document.getElementById("pivotHead"),
  body: document.getElementById("pivotBody"),
  footRow: document.getElementById("pivotFoot"),
  empty: document.getElementById("pivotEmpty"),
  info: document.getElementById("pivotInfo"),
  pager: document.getElementById("pivotPager"),
  toasts: document.getElementById("toasts"),
};

const collator = new Intl.Collator("id", { numeric: true, sensitivity: "base" });
const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });

const value = (row, col) => row[col + 1];

// Hanya 5 kolom terakhir yang ditawarkan sebagai indikator kosong/0.
function issueColumns() {
  return state.columns.map((_, col) => col).slice(-ISSUE_COUNT);
}

function isMissingValue(text) {
  const v = text.trim();
  return v === "" || ZERO_PATTERN.test(v);
}

function toNumber(text) {
  if (!text) return 0;
  const n = Number(text.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function matchesQuick(row) {
  if (!state.quick) return true;
  for (let i = 1; i < row.length; i++) {
    if (row[i].toLowerCase().includes(state.quick)) return true;
  }
  return false;
}

/* ---------- preferences ---------- */

function savePrefs() {
  try {
    localStorage.setItem(LS_PREFS, JSON.stringify({
      group: state.columns[state.groupCol],
      count: state.showCount,
      luas: state.showLuas,
      missing: [...state.missing].map((col) => state.columns[col]),
    }));
  } catch {}
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem(LS_PREFS);
    if (!raw) return;
    const stored = JSON.parse(raw);
    const group = state.columns.indexOf(stored.group);
    if (group >= 0) state.groupCol = group;
    state.showCount = stored.count !== false;
    state.showLuas = stored.luas === true && state.luasCol >= 0;
    const missing = new Set();
    for (const name of stored.missing || []) {
      const col = state.columns.indexOf(name);
      if (col >= state.columns.length - ISSUE_COUNT) missing.add(col);
    }
    state.missing = missing;
  } catch {}
}

/* ---------- aggregation ---------- */

function computeGroups() {
  const map = new Map();
  for (const row of state.rows) {
    if (!matchesQuick(row)) continue;
    const key = value(row, state.groupCol);
    let group = map.get(key);
    if (!group) {
      group = { key, count: 0, luas: 0, missing: new Map() };
      map.set(key, group);
    }
    group.count++;
    if (state.showLuas && state.luasCol >= 0) group.luas += toNumber(value(row, state.luasCol));
    for (const col of state.missing) {
      if (isMissingValue(value(row, col))) group.missing.set(col, (group.missing.get(col) || 0) + 1);
    }
  }
  return [...map.values()];
}

function measures() {
  const list = [];
  if (state.showCount) {
    list.push({ key: "count", label: "Jumlah baris", get: (group) => group.count, total: (groups) => groups.reduce((sum, g) => sum + g.count, 0) });
  }
  if (state.showLuas && state.luasCol >= 0) {
    list.push({ key: "luas", label: "Σ luas", get: (group) => group.luas, total: (groups) => groups.reduce((sum, g) => sum + g.luas, 0) });
  }
  for (const col of [...state.missing].sort((a, b) => a - b)) {
    list.push({
      key: `m:${col}`,
      label: `${state.columns[col]} (kosong/0)`,
      get: (group) => group.missing.get(col) || 0,
      total: (groups) => groups.reduce((sum, g) => sum + (g.missing.get(col) || 0), 0),
    });
  }
  return list;
}

function sortGroups(groups, measureList) {
  if (!state.sort) return groups;
  const { key, dir } = state.sort;
  const measure = measureList.find((m) => m.key === key);
  return groups.sort((a, b) => {
    if (measure) return (measure.get(a) - measure.get(b)) * dir;
    return collator.compare(a.key, b.key) * dir;
  });
}

function displayGroup(key) {
  return key === "" ? "(kosong)" : key;
}

/* ---------- rendering ---------- */

function makeSortButton(label, key, extraClass) {
  const th = document.createElement("th");
  if (extraClass) th.className = extraClass;
  th.dataset.key = key;
  const wrap = document.createElement("div");
  wrap.className = "th-wrap pivot-head";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "th-sort";
  button.textContent = label;
  button.title = `Urutkan menurut ${label}`;
  button.addEventListener("click", () => toggleSort(key));
  wrap.append(button);
  th.append(wrap);
  return th;
}

function renderHead(measureList) {
  const frag = document.createDocumentFragment();
  frag.append(makeSortButton(state.columns[state.groupCol], "group", "pivot-first"));
  for (const measure of measureList) {
    frag.append(makeSortButton(measure.label, measure.key, "num"));
  }
  els.headRow.replaceChildren(frag);
}

function renderBody(groups, measureList, slice) {
  const colSpan = measureList.length + 1;
  if (!groups.length) {
    els.body.replaceChildren();
    els.footRow.replaceChildren();
    return;
  }
  const frag = document.createDocumentFragment();
  for (const group of slice) {
    const tr = document.createElement("tr");
    const tdGroup = document.createElement("td");
    tdGroup.className = "pivot-first";
    const label = displayGroup(group.key);
    tdGroup.textContent = label;
    if (label.length > 24) tdGroup.title = label;
    tr.append(tdGroup);
    for (const measure of measureList) {
      const td = document.createElement("td");
      td.className = "num";
      td.textContent = nf.format(measure.get(group));
      tr.append(td);
    }
    frag.append(tr);
  }
  els.body.replaceChildren(frag);

  const foot = document.createDocumentFragment();
  const tdTotal = document.createElement("td");
  tdTotal.className = "pivot-first";
  tdTotal.textContent = "TOTAL";
  foot.append(tdTotal);
  for (const measure of measureList) {
    const td = document.createElement("td");
    td.className = "num";
    td.textContent = nf.format(measure.total(groups));
    foot.append(td);
  }
  els.footRow.replaceChildren(foot);
  void colSpan;
}

function renderPager(pages) {
  const current = state.page;
  const frag = document.createDocumentFragment();
  const makeBtn = (label, page, options = {}) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    if (options.title) btn.title = options.title;
    if (options.current) btn.setAttribute("aria-current", "page");
    if (options.disabled) btn.disabled = true;
    else if (!options.current) btn.addEventListener("click", () => goToPage(page));
    return btn;
  };
  frag.append(makeBtn("‹", current - 1, { disabled: current <= 1, title: "Halaman sebelumnya" }));
  const windowSize = 2;
  let start = Math.max(1, current - windowSize);
  let end = Math.min(pages, start + windowSize * 2);
  start = Math.max(1, end - windowSize * 2);
  if (start > 1) {
    frag.append(makeBtn("1", 1, { current: current === 1 }));
    if (start > 2) {
      const gap = document.createElement("span");
      gap.className = "gap";
      gap.textContent = "…";
      frag.append(gap);
    }
  }
  for (let page = start; page <= end; page++) {
    frag.append(makeBtn(String(page), page, { current: page === current }));
  }
  if (end < pages) {
    if (end < pages - 1) {
      const gap = document.createElement("span");
      gap.className = "gap";
      gap.textContent = "…";
      frag.append(gap);
    }
    frag.append(makeBtn(String(pages), pages, { current: current === pages }));
  }
  frag.append(makeBtn("›", current + 1, { disabled: current >= pages, title: "Halaman berikutnya" }));
  els.pager.replaceChildren(frag);
}

function goToPage(page) {
  state.page = page;
  render();
  document.getElementById("tableWrap").scrollTop = 0;
}

function toggleSort(key) {
  if (state.sort && state.sort.key === key) {
    state.sort = state.sort.dir === 1 ? { key, dir: -1 } : null;
  } else {
    state.sort = { key, dir: 1 };
  }
  state.page = 1;
  render();
}

function updateHeadIndicators() {
  for (const th of els.headRow.children) {
    th.dataset.sorted = state.sort && state.sort.key === th.dataset.key ? (state.sort.dir === 1 ? "asc" : "desc") : "";
  }
}

function render() {
  const measureList = measures();
  const groups = sortGroups(computeGroups(), measureList);
  const pages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  if (state.page > pages) state.page = pages;
  const start = (state.page - 1) * PAGE_SIZE;
  const slice = groups.slice(start, start + PAGE_SIZE);
  renderHead(measureList);
  renderBody(groups, measureList, slice);
  renderPager(pages);
  updateHeadIndicators();
  if (groups.length) {
    els.info.textContent = `Menampilkan ${start + 1}–${start + slice.length} dari ${nf.format(groups.length)} grup` +
      (state.quick ? ` (pencarian aktif)` : "");
  } else {
    els.info.textContent = "0 grup";
  }
  els.empty.hidden = groups.length !== 0;
}

/* ---------- export ---------- */

function csvCell(input) {
  const text = input == null ? "" : String(input);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function downloadBlob(text, filename, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportPivot() {
  const measureList = measures();
  if (!measureList.length) {
    toast("Pilih minimal satu ukuran untuk diekspor.", "warn");
    return;
  }
  const groups = sortGroups(computeGroups(), measureList);
  if (!groups.length) {
    toast("Tidak ada grup untuk diekspor.", "warn");
    return;
  }
  const aoa = [
    [state.columns[state.groupCol], ...measureList.map((m) => m.label)],
    ...groups.map((group) => [displayGroup(group.key), ...measureList.map((m) => m.get(group))]),
    ["TOTAL", ...measureList.map((m) => m.total(groups))],
  ];
  const name = `pivot-${state.columns[state.groupCol]}-${timestamp()}`;
  if (window.XLSX) {
    const sheet = window.XLSX.utils.aoa_to_sheet(aoa);
    sheet["!cols"] = aoa[0].map((_, i) => ({
      wch: Math.min(60, Math.max(10, ...aoa.slice(0, 40).map((r) => String(r[i] ?? "").length + 2))),
    }));
    const book = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(book, sheet, "Pivot");
    window.XLSX.writeFile(book, `${name}.xlsx`);
    toast(`${nf.format(groups.length)} grup diekspor ke Excel.`);
  } else {
    const csv = "\uFEFF" + aoa.map((row) => row.map(csvCell).join(",")).join("\r\n");
    downloadBlob(csv, `${name}.csv`, "text/csv;charset=utf-8");
    toast(`${nf.format(groups.length)} grup diekspor ke CSV.`);
  }
}

/* ---------- toasts / version ---------- */

function toast(message, kind = "info") {
  const el = document.createElement("p");
  el.className = `toast${kind === "warn" ? " warn" : ""}`;
  el.textContent = message;
  els.toasts.append(el);
  setTimeout(() => el.remove(), 4500);
}

async function checkVersion() {
  try {
    const response = await fetch(`version.json?_=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    if (!data.v || data.v === APP_VERSION) return;
    if (sessionStorage.getItem("dmt.reloadFor") === data.v) return;
    sessionStorage.setItem("dmt.reloadFor", data.v);
    location.reload();
  } catch {}
}

function watchVersion() {
  checkVersion();
  setInterval(checkVersion, 120000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkVersion();
  });
}

/* ---------- controls ---------- */

function buildMissingBoxes() {
  const frag = document.createDocumentFragment();
  for (const col of issueColumns()) {
    const name = state.columns[col];
    const label = document.createElement("label");
    label.className = "check-inline";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset.col = String(col);
    box.checked = state.missing.has(col);
    box.addEventListener("change", () => {
      if (box.checked) state.missing.add(col);
      else state.missing.delete(col);
      state.page = 1;
      savePrefs();
      render();
    });
    const text = document.createElement("span");
    text.textContent = name;
    label.append(box, text);
    frag.append(label);
  }
  els.missingBoxes.replaceChildren(frag);
}

function buildGroupSelect() {
  const frag = document.createDocumentFragment();
  state.columns.forEach((name, col) => {
    const option = document.createElement("option");
    option.value = String(col);
    option.textContent = name;
    frag.append(option);
  });
  els.groupSelect.replaceChildren(frag);
  els.groupSelect.value = String(state.groupCol);
}

let searchTimer = null;
els.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.quick = els.search.value.trim().toLowerCase();
    state.page = 1;
    render();
  }, 150);
});

els.groupSelect.addEventListener("change", () => {
  state.groupCol = Number(els.groupSelect.value);
  state.page = 1;
  savePrefs();
  render();
});

els.mCount.addEventListener("change", () => {
  state.showCount = els.mCount.checked;
  savePrefs();
  render();
});

els.mLuas.addEventListener("change", () => {
  state.showLuas = els.mLuas.checked;
  savePrefs();
  render();
});

els.exportBtn.addEventListener("click", exportPivot);

/* ---------- boot ---------- */

async function boot() {
  try {
    const response = await fetch("data.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.columns = data.columns;
    state.rows = data.rows;
    state.luasCol = data.columns.indexOf("luas");
    state.groupCol = Math.max(0, data.columns.indexOf("nama_satker"));
    state.missing = new Set(issueColumns());
    loadPrefs();
  } catch (error) {
    els.empty.hidden = false;
    els.empty.textContent = "Data tidak dapat dimuat. Muat ulang halaman untuk mencoba lagi.";
    toast("Data gagal dimuat. Periksa koneksi lalu muat ulang.", "warn");
    return;
  }
  buildGroupSelect();
  buildMissingBoxes();
  els.mCount.checked = state.showCount;
  els.mLuas.checked = state.showLuas;
  els.mLuas.disabled = state.luasCol < 0;
  watchVersion();
  render();
}

boot();
