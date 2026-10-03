import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const APP_VERSION = "20261003-8";

const PAGE_SIZE = 50;
const LIST_RENDER_LIMIT = 500;
const ISSUE_COUNT = 5;
const ZERO_PATTERN = /^[+-]?0+(?:[.,]0+)?$/;
const LS_TICKS = "dmt.ticks.v1";
const LS_PENDING = "dmt.pending.v1";

// Kolom yang disembunyikan dari tabel (tidak dihapus dari data/export).
const HIDDEN_COLUMNS = [];

// Kolom beku (sticky) sampai kolom "luas" (kolom J) dan lebar awalnya. Lebar
// bisa diubah pengguna dengan menarik tepi kanan judul kolom; hasilnya
// disimpan di localStorage.
const FROZEN_COLUMNS = new Set([
  "kode_satker",
  "nama_satker",
  "kode_sub_satker",
  "nama_sub_satker",
  "id_aset",
  "id_aset_bidang",
  "kd_brg",
  "nup",
  "jml_bid",
  "luas",
]);

const DEFAULT_WIDTHS = new Map([
  ["kode_satker", 150],
  ["nama_satker", 120],
  ["kode_sub_satker", 150],
  ["nama_sub_satker", 120],
  ["id_aset", 74],
  ["id_aset_bidang", 98],
  ["kd_brg", 96],
  ["nup", 52],
  ["jml_bid", 60],
  ["luas", 64],
  ["Koordinat Aset", 180],
  ["Koordinat Bidang", 180],
  ["alamat_bidang", 200],
  ["alamat aset new", 200],
  ["jumlah foto new", 104],
]);

const MIN_COLUMN_WIDTH = 56;
const LS_WIDTHS = "dmt.widths.v1";

const state = {
  columns: [],
  rows: [],
  visible: [],
  widths: new Map(),
  tickWidth: 0,
  filters: new Map(),
  missing: new Set(),
  quick: "",
  sort: null,
  page: 1,
  ticks: new Map(),
  tickedOnly: false,
};

const pending = new Map();
const localWrites = new Map();
const uniqueCache = new Map();
const LOCAL_WRITE_TTL = 10000;
let filteredCache = null;
let supabase = null;
let syncState = "loading";
let panelCol = null;
let flushing = false;

const collator = new Intl.Collator("id", { numeric: true, sensitivity: "base" });
const nf = new Intl.NumberFormat("id-ID");
const nf1 = new Intl.NumberFormat("id-ID", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const datePattern = /^(\d{2})\/(\d{2})\/(\d{4})$/;

const els = {
  syncBadge: document.getElementById("syncBadge"),
  syncText: document.getElementById("syncText"),
  refreshBtn: document.getElementById("refreshBtn"),
  statTotal: document.getElementById("statTotal"),
  statFiltered: document.getElementById("statFiltered"),
  statTicked: document.getElementById("statTicked"),
  statTickedHint: document.getElementById("statTickedHint"),
  statPct: document.getElementById("statPct"),
  statBar: document.getElementById("statBar"),
  statBarWrap: document.getElementById("statBarWrap"),
  quickSearch: document.getElementById("quickSearch"),
  resetFilters: document.getElementById("resetFilters"),
  exportBtn: document.getElementById("exportBtn"),
  tickedFilterBtn: document.getElementById("tickedFilterBtn"),
  issues: document.getElementById("issues"),
  issueStrip: document.getElementById("issueStrip"),
  tableWrap: document.getElementById("tableWrap"),
  grid: document.getElementById("grid"),
  headRow: document.getElementById("headRow"),
  tbody: document.getElementById("tbody"),
  tableEmpty: document.getElementById("tableEmpty"),
  emptyMsg: document.getElementById("emptyMsg"),
  emptyReset: document.getElementById("emptyReset"),
  pageInfo: document.getElementById("pageInfo"),
  pageBtns: document.getElementById("pageBtns"),
  panel: document.getElementById("filterPanel"),
  panelTitle: document.getElementById("panelTitle"),
  panelClose: document.getElementById("panelClose"),
  panelSearch: document.getElementById("panelSearch"),
  panelContains: document.getElementById("panelContains"),
  panelList: document.getElementById("panelList"),
  panelNote: document.getElementById("panelNote"),
  panelAll: document.getElementById("panelAll"),
  panelNone: document.getElementById("panelNone"),
  panelInvert: document.getElementById("panelInvert"),
  toasts: document.getElementById("toasts"),
};

const value = (row, col) => row[col + 1];

function isFrozen(col) {
  return FROZEN_COLUMNS.has(state.columns[col]);
}

function isFrozenEdge(col) {
  const position = state.visible.indexOf(col);
  const next = state.visible[position + 1];
  return next === undefined || !isFrozen(next);
}

function columnWidth(col) {
  const width = state.widths.get(col);
  if (width) return width;
  const fallback = DEFAULT_WIDTHS.get(state.columns[col]);
  if (fallback) return fallback;
  const header = els.headRow.querySelector(`th[data-col="${col}"]`);
  return header ? Math.round(header.getBoundingClientRect().width) : 120;
}

function applyColumnStyle(node, col) {
  const width = state.widths.get(col) ?? DEFAULT_WIDTHS.get(state.columns[col]);
  if (width) {
    node.style.width = `${width}px`;
    node.style.minWidth = `${width}px`;
    node.style.maxWidth = `${width}px`;
  } else {
    node.style.width = "";
    node.style.minWidth = "";
    node.style.maxWidth = "";
  }
}

function applyColumnWidth(col) {
  const header = els.headRow.querySelector(`th[data-col="${col}"]`);
  if (header) applyColumnStyle(header, col);
  for (const cell of els.tbody.querySelectorAll(`td[data-col="${col}"]`)) applyColumnStyle(cell, col);
}

// Saat tabel melebar mengisi layar, lebar tiap kolom dibagi ulang oleh browser.
// Bekukan lebar tampilan saat ini dulu agar ubah lebar berikutnya tepat 1:1.
function captureActualWidths() {
  const snapshot = [];
  for (const col of state.visible) {
    if (state.widths.has(col)) continue;
    const header = els.headRow.querySelector(`th[data-col="${col}"]`);
    if (!header) continue;
    const width = header.getBoundingClientRect().width;
    if (width > 0) snapshot.push([col, width]);
  }
  const tickHead = els.headRow.querySelector("th.tickhead");
  if (tickHead && !state.tickWidth) state.tickWidth = tickHead.getBoundingClientRect().width;
  for (const [col, width] of snapshot) {
    state.widths.set(col, width);
    applyColumnWidth(col);
  }
  if (snapshot.length || state.tickWidth) applyTickWidth();
}

function applyTickWidth() {
  const width = state.tickWidth ? `${state.tickWidth}px` : "";
  const head = els.headRow.querySelector("th.tickhead");
  if (head) {
    head.style.width = width;
    head.style.minWidth = width;
    head.style.maxWidth = width;
  }
  for (const cell of els.tbody.querySelectorAll("td.tickcell")) {
    cell.style.width = width;
    cell.style.minWidth = width;
    cell.style.maxWidth = width;
  }
}

// Setelah ada lebar khusus, tabel memakai jumlah lebar kolom (bukan melebar
// mengisi layar) supaya hasil tarikan sesuai kursor.
function syncTableWidth() {
  if (state.widths.size === 0) {
    els.grid.style.minWidth = "";
    return;
  }
  let total = state.tickWidth;
  if (!total) {
    const head = els.headRow.querySelector("th.tickhead");
    total = head ? head.getBoundingClientRect().width : 52;
  }
  for (const col of state.visible) {
    const stored = state.widths.get(col);
    if (stored) {
      total += stored;
      continue;
    }
    const header = els.headRow.querySelector(`th[data-col="${col}"]`);
    total += header ? header.getBoundingClientRect().width : DEFAULT_WIDTHS.get(state.columns[col]) || 120;
  }
  els.grid.style.minWidth = `${Math.ceil(total)}px`;
}

function refreshFrozenOffsets() {
  const offsets = new Map();
  let left = 0;
  for (const col of state.visible) {
    if (!isFrozen(col)) break;
    offsets.set(col, left);
    const header = els.headRow.querySelector(`th[data-col="${col}"]`);
    left += header ? header.getBoundingClientRect().width : columnWidth(col);
  }
  for (const node of els.headRow.querySelectorAll("th.frozen")) {
    const col = Number(node.dataset.col);
    node.style.left = `${offsets.get(col) ?? 0}px`;
  }
  for (const node of els.tbody.querySelectorAll("td.frozen")) {
    const col = Number(node.dataset.col);
    node.style.left = `${offsets.get(col) ?? 0}px`;
  }
}

let resizeFrame = null;
function setColumnWidth(col, width, persist = true) {
  captureActualWidths();
  state.widths.set(col, Math.max(MIN_COLUMN_WIDTH, Math.round(width)));
  applyColumnWidth(col);
  syncTableWidth();
  if (resizeFrame) cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null;
    refreshFrozenOffsets();
  });
  if (persist) persistWidths();
}

function resetColumnWidth(col) {
  captureActualWidths();
  state.widths.delete(col);
  applyColumnWidth(col);
  syncTableWidth();
  refreshFrozenOffsets();
  persistWidths();
}

function persistWidths() {
  const stored = {};
  for (const [col, width] of state.widths) stored[state.columns[col]] = width;
  try {
    localStorage.setItem(LS_WIDTHS, JSON.stringify(stored));
  } catch {}
}

function loadWidths() {
  try {
    const raw = localStorage.getItem(LS_WIDTHS);
    if (!raw) return;
    const stored = JSON.parse(raw);
    state.columns.forEach((name, col) => {
      const width = Number(stored[name]);
      if (Number.isFinite(width) && width >= MIN_COLUMN_WIDTH) state.widths.set(col, width);
    });
  } catch {}
}

function beginResize(event, col) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const handle = event.currentTarget;
  const header = handle.closest("th");
  captureActualWidths();
  syncTableWidth();
  const startX = event.clientX;
  const startWidth = header.getBoundingClientRect().width;
  handle.setPointerCapture(event.pointerId);
  document.body.classList.add("resizing");
  handle.classList.add("active");
  const move = (moveEvent) => setColumnWidth(col, startWidth + (moveEvent.clientX - startX), false);
  const finish = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", finish);
    handle.removeEventListener("pointercancel", finish);
    document.body.classList.remove("resizing");
    handle.classList.remove("active");
    persistWidths();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
}

function isFiltering() {
  return state.quick !== "" || state.filters.size > 0 || state.tickedOnly || state.missing.size > 0;
}

function isMissingValue(text) {
  const v = text.trim();
  return v === "" || ZERO_PATTERN.test(v);
}

function toggleSort(col) {
  if (state.sort && state.sort.col === col) {
    state.sort = state.sort.dir === 1 ? { col, dir: -1 } : null;
  } else {
    state.sort = { col, dir: 1 };
  }
  filteredCache = null;
  state.page = 1;
  render();
  updateHeadIndicators();
}

function compareValues(a, b) {
  if (a === "" && b === "") return 0;
  if (a === "") return 1;
  if (b === "") return -1;
  const da = datePattern.exec(a);
  const db = datePattern.exec(b);
  if (da && db) {
    return Number(`${da[3]}${da[2]}${da[1]}`) - Number(`${db[3]}${db[2]}${db[1]}`);
  }
  const na = Number(a.replace(",", "."));
  const nb = Number(b.replace(",", "."));
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return collator.compare(a, b);
}

function matchesQuick(row) {
  if (!state.quick) return true;
  for (let i = 1; i < row.length; i++) {
    if (row[i].toLowerCase().includes(state.quick)) return true;
  }
  return false;
}

function matchesFilters(row) {
  for (const [col, filter] of state.filters) {
    const v = value(row, col);
    if (filter.none) return false;
    if (filter.values && filter.values.size && !filter.values.has(v)) return false;
    if (filter.contains && !v.toLowerCase().includes(filter.contains)) return false;
  }
  return true;
}

// Saringan kartu kolom kosong: semua kolom terpilih harus kosong/0 (AND).
function matchesMissing(row) {
  for (const col of state.missing) {
    if (!isMissingValue(value(row, col))) return false;
  }
  return true;
}

// Baris yang cocok dengan filter kolom/pencarian/tanda, tanpa saringan kartu.
function getIssueBase() {
  const out = [];
  state.rows.forEach((row, index) => {
    if (state.tickedOnly && state.ticks.get(row[0]) !== true) return;
    if (matchesQuick(row) && matchesFilters(row)) out.push(index);
  });
  return out;
}

function getFiltered() {
  if (filteredCache) return filteredCache;
  const out = [];
  state.rows.forEach((row, index) => {
    if (state.tickedOnly && state.ticks.get(row[0]) !== true) return;
    if (matchesQuick(row) && matchesFilters(row) && matchesMissing(row)) out.push(index);
  });
  if (state.sort) {
    const { col, dir } = state.sort;
    out.sort((ia, ib) => compareValues(value(state.rows[ia], col), value(state.rows[ib], col)) * dir);
  }
  filteredCache = out;
  return out;
}

function getUnique(col) {
  if (!uniqueCache.has(col)) {
    const set = new Set();
    for (const row of state.rows) set.add(value(row, col));
    uniqueCache.set(col, [...set].sort((a, b) => collator.compare(a, b)));
  }
  return uniqueCache.get(col);
}

function effectiveSelected(col) {
  const filter = state.filters.get(col);
  if (filter && filter.none) return new Set();
  if (filter && filter.values && filter.values.size) return new Set(filter.values);
  return new Set(getUnique(col));
}

function ensureFilter(col) {
  let filter = state.filters.get(col);
  if (!filter) {
    filter = { values: null, none: false, contains: "" };
    state.filters.set(col, filter);
  }
  return filter;
}

function cleanupFilter(col) {
  const filter = state.filters.get(col);
  if (!filter) return;
  const hasValues = filter.none || (filter.values && filter.values.size);
  if (!hasValues && !filter.contains) state.filters.delete(col);
}

function setValueSelected(col, val, checked) {
  const selected = effectiveSelected(col);
  if (checked) selected.add(val);
  else selected.delete(val);
  const filter = ensureFilter(col);
  const all = getUnique(col);
  if (selected.size === all.length) filter.none = false;
  else filter.none = selected.size === 0;
  filter.values = selected;
  cleanupFilter(col);
  afterFilterChange(col, false);
}

function setContains(col, text) {
  if (col === null) return;
  const filter = ensureFilter(col);
  filter.contains = text.trim().toLowerCase();
  cleanupFilter(col);
  afterFilterChange(col, false);
}

function afterFilterChange(col, refreshList) {
  filteredCache = null;
  state.page = 1;
  render();
  updateHeadIndicators();
  updateResetState();
  if (refreshList) renderPanelList();
  else updatePanelNote();
}

function clearAllFilters() {
  state.filters.clear();
  state.missing.clear();
  state.tickedOnly = false;
  state.quick = "";
  els.quickSearch.value = "";
  closePanel();
  filteredCache = null;
  state.page = 1;
  render();
  updateHeadIndicators();
  updateResetState();
}

function updateResetState() {
  els.resetFilters.disabled = !isFiltering();
}

function makeResizer(col, name) {
  const handle = document.createElement("span");
  handle.className = "resizer";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", `Ubah lebar kolom ${name}`);
  handle.tabIndex = 0;
  handle.title = "Tarik untuk ubah lebar kolom · klik dua kali untuk lebar awal";
  handle.addEventListener("pointerdown", (event) => beginResize(event, col));
  handle.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    resetColumnWidth(col);
  });
  handle.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") {
      captureActualWidths();
      setColumnWidth(col, columnWidth(col) - 16);
      event.preventDefault();
    } else if (event.key === "ArrowRight") {
      captureActualWidths();
      setColumnWidth(col, columnWidth(col) + 16);
      event.preventDefault();
    } else if (event.key === "Enter" || event.key === "Backspace") {
      resetColumnWidth(col);
      event.preventDefault();
    }
  });
  return handle;
}

function renderHead() {
  const frag = document.createDocumentFragment();
  state.visible.forEach((col) => {
    const name = state.columns[col];
    const th = document.createElement("th");
    th.dataset.col = String(col);
    if (isFrozen(col)) {
      th.classList.add("frozen");
      if (isFrozenEdge(col)) th.classList.add("frozen-edge");
    }
    applyColumnStyle(th, col);
    const wrap = document.createElement("div");
    wrap.className = "th-wrap";
    const sortBtn = document.createElement("button");
    sortBtn.type = "button";
    sortBtn.className = "th-sort";
    sortBtn.textContent = name;
    sortBtn.title = `Urutkan menurut ${name}`;
    sortBtn.addEventListener("click", () => toggleSort(col));
    const funnel = document.createElement("button");
    funnel.type = "button";
    funnel.className = "funnel";
    funnel.title = `Filter ${name}`;
    funnel.setAttribute("aria-label", `Filter kolom ${name}`);
    funnel.setAttribute("aria-expanded", "false");
    funnel.addEventListener("click", (event) => {
      event.stopPropagation();
      if (panelCol === col && !els.panel.hidden) closePanel();
      else openPanel(col, funnel);
    });
    wrap.append(sortBtn, funnel);
    th.append(wrap, makeResizer(col, name));
    frag.append(th);
  });
  const thTick = document.createElement("th");
  thTick.className = "tickhead";
  const headTick = document.createElement("input");
  headTick.type = "checkbox";
  headTick.id = "headTick";
  headTick.title = "Tandai semua baris yang tampil di halaman ini";
  headTick.setAttribute("aria-label", "Tandai semua baris yang tampil di halaman ini");
  headTick.addEventListener("change", () => {
    const entries = [...els.tbody.querySelectorAll("tr")].map((tr) => [tr.dataset.id, headTick.checked]);
    if (entries.length) setTicks(entries);
  });
  thTick.append(headTick);
  frag.append(thTick);
  els.headRow.replaceChildren(frag);
  updateTickControls();
  applyTickWidth();
  syncTableWidth();
  refreshFrozenOffsets();
}

function setTickedOnly(value) {
  state.tickedOnly = value;
  filteredCache = null;
  state.page = 1;
  render();
  updateHeadIndicators();
  updateResetState();
}

function updateHeadIndicators() {
  for (const th of els.headRow.children) {
    const col = Number(th.dataset.col);
    const funnel = th.querySelector(".funnel");
    if (Number.isNaN(col) || !funnel) continue;
    const filter = state.filters.get(col);
    th.classList.toggle("has-filter", Boolean(filter));
    th.dataset.sorted = state.sort && state.sort.col === col ? (state.sort.dir === 1 ? "asc" : "desc") : "";
    funnel.setAttribute("aria-expanded", String(panelCol === col && !els.panel.hidden));
    funnel.title = filter
      ? `Filter aktif pada ${state.columns[col]} — klik untuk ubah`
      : `Filter ${state.columns[col]}`;
  }
}

function updateTickControls() {
  const headTick = document.getElementById("headTick");
  if (headTick) {
    const rows = [...els.tbody.querySelectorAll("tr")];
    if (!rows.length) {
      headTick.checked = false;
      headTick.indeterminate = false;
      headTick.disabled = true;
    } else {
      headTick.disabled = false;
      let count = 0;
      for (const tr of rows) if (state.ticks.get(tr.dataset.id) === true) count++;
      headTick.checked = count === rows.length;
      headTick.indeterminate = count > 0 && count < rows.length;
    }
  }
  const button = els.tickedFilterBtn;
  if (!button) return;
  button.setAttribute("aria-pressed", String(state.tickedOnly));
  button.title = state.tickedOnly
    ? "Menampilkan hanya baris yang ditandai — klik untuk menampilkan semua"
    : "Tampilkan hanya baris yang ditandai";
}

function buildRow(row) {
  const tr = document.createElement("tr");
  tr.dataset.id = row[0];
  if (state.ticks.get(row[0]) === true) tr.classList.add("is-ticked");
  state.visible.forEach((col) => {
    const td = document.createElement("td");
    td.dataset.col = String(col);
    const text = value(row, col);
    if (isFrozen(col)) {
      td.classList.add("frozen");
      if (isFrozenEdge(col)) td.classList.add("frozen-edge");
    }
    applyColumnStyle(td, col);
    td.textContent = text;
    if (text.length > 12) td.title = text;
    tr.append(td);
  });
  const tdTick = document.createElement("td");
  tdTick.className = "tickcell";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = state.ticks.get(row[0]) === true;
  box.setAttribute("aria-label", `Tandai baris ${row[1]}`);
  box.title = "Tandai baris ini";
  box.addEventListener("change", () => setTicks([[row[0], box.checked]]));
  tdTick.append(box);
  tr.append(tdTick);
  return tr;
}

function renderRows(slice) {
  const frag = document.createDocumentFragment();
  for (const index of slice) frag.append(buildRow(state.rows[index]));
  els.tbody.replaceChildren(frag);
  applyTickWidth();
  refreshFrozenOffsets();
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
  els.pageBtns.replaceChildren(frag);
}

function goToPage(page) {
  state.page = page;
  render();
  els.tableWrap.scrollTop = 0;
}

function updatePageInfo(total, start, shown) {
  if (total === 0) {
    els.pageInfo.textContent = "0 baris";
    return;
  }
  const range = `${nf.format(start + 1)}–${nf.format(start + shown)}`;
  els.pageInfo.textContent = `Menampilkan ${range} dari ${nf.format(total)} baris` +
    (isFiltering() ? ` (total ${nf.format(state.rows.length)})` : "");
}

function updateStats(filteredCount) {
  const total = state.rows.length;
  let ticked = 0;
  for (const row of state.rows) if (state.ticks.get(row[0]) === true) ticked++;
  els.statTotal.textContent = nf.format(total);
  els.statFiltered.textContent = isFiltering() ? `${nf.format(filteredCount)} baris terfilter` : "tanpa filter aktif";
  els.statTicked.textContent = nf.format(ticked);
  els.statTickedHint.textContent = `dari ${nf.format(total)} baris`;
  const pct = total ? (ticked / total) * 100 : 0;
  els.statPct.textContent = `${nf1.format(pct)}%`;
  els.statBar.style.width = `${Math.min(100, pct)}%`;
  els.statBarWrap.setAttribute("aria-valuenow", String(Math.round(pct)));
  els.exportBtn.disabled = ticked === 0;
}

function render() {
  const filtered = getFiltered();
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (state.page > pages) state.page = pages;
  const start = (state.page - 1) * PAGE_SIZE;
  const slice = filtered.slice(start, start + PAGE_SIZE);
  renderRows(slice);
  renderPager(pages);
  updatePageInfo(filtered.length, start, slice.length);
  updateTickControls();
  updateStats(filtered.length);
  updateIssues();
  els.tableEmpty.hidden = filtered.length !== 0;
  if (filtered.length === 0) {
    els.emptyMsg.textContent = state.tickedOnly
      ? "Belum ada baris yang ditandai."
      : "Tidak ada baris yang cocok dengan filter.";
  }
}

// Kartu ringkasan untuk 5 kolom terakhir: jumlah baris kosong/0 pada hasil
// filter yang sedang aktif (di luar saringan kartu itu sendiri), dari seluruh
// baris hasil — bukan hanya halaman yang tampil. Klik kartu menambah saringan;
// beberapa kartu digabung dengan AND.
function updateIssues() {
  if (!els.issueStrip) return;
  const cols = state.visible.slice(-ISSUE_COUNT);
  if (!cols.length) return;
  const base = getIssueBase();
  const frag = document.createDocumentFragment();
  for (const col of cols) {
    const name = state.columns[col];
    let count = 0;
    for (const index of base) {
      if (isMissingValue(value(state.rows[index], col))) count++;
    }
    const active = state.missing.has(col);
    const card = document.createElement("button");
    card.type = "button";
    card.className = "issue-card";
    card.dataset.col = String(col);
    card.setAttribute("aria-pressed", String(active));
    card.title = active
      ? `Hapus saringan ${name} dari tabel`
      : `Tampilkan hanya baris dengan ${name} kosong / 0`;
    const label = document.createElement("span");
    label.className = "issue-name";
    label.textContent = name;
    label.title = name;
    const num = document.createElement("span");
    num.className = "issue-num";
    num.textContent = nf.format(count);
    if (count === 0) num.classList.add("ok");
    const sub = document.createElement("span");
    sub.className = "issue-sub";
    if (!base.length) sub.textContent = "tidak ada baris";
    else if (count === 0) sub.textContent = "lengkap";
    else sub.textContent = `${nf1.format((count / base.length) * 100)}% dari ${nf.format(base.length)} baris`;
    card.append(label, num, sub);
    frag.append(card);
  }
  els.issueStrip.replaceChildren(frag);
  els.issues.hidden = false;
}

function toggleMissing(col) {
  if (state.missing.has(col)) state.missing.delete(col);
  else state.missing.add(col);
  filteredCache = null;
  state.page = 1;
  render();
  updateResetState();
}

function refreshTickUI(ids) {
  const set = new Set(ids);
  for (const tr of els.tbody.querySelectorAll("tr")) {
    if (!set.has(tr.dataset.id)) continue;
    const ticked = state.ticks.get(tr.dataset.id) === true;
    tr.classList.toggle("is-ticked", ticked);
    const box = tr.querySelector("input[type=checkbox]");
    if (box) box.checked = ticked;
  }
  if (state.tickedOnly) {
    filteredCache = null;
    render();
  } else {
    updateTickControls();
  }
}

function persistLocal() {
  try {
    localStorage.setItem(LS_TICKS, JSON.stringify([...state.ticks]));
    localStorage.setItem(LS_PENDING, JSON.stringify([...pending]));
  } catch {}
}

function loadLocalTicks() {
  try {
    const rawTicks = localStorage.getItem(LS_TICKS);
    if (rawTicks) for (const [id, v] of JSON.parse(rawTicks)) state.ticks.set(id, v === true);
    const rawPending = localStorage.getItem(LS_PENDING);
    if (rawPending) for (const [id, v] of JSON.parse(rawPending)) pending.set(id, v === true);
  } catch {}
}

function setTicks(entries) {
  const now = Date.now();
  for (const [id, ticked] of entries) {
    state.ticks.set(id, ticked);
    pending.set(id, ticked);
    localWrites.set(id, { ticked, at: now });
  }
  for (const [id, write] of localWrites) {
    if (now - write.at > LOCAL_WRITE_TTL) localWrites.delete(id);
  }
  persistLocal();
  refreshTickUI(entries.map(([id]) => id));
  updateStats(getFiltered().length);
  flushPending();
}

async function flushPending() {
  if (!supabase || flushing || pending.size === 0) return;
  flushing = true;
  const snapshot = [...pending.entries()].map(([row_id, ticked]) => ({
    row_id,
    ticked,
    updated_at: new Date().toISOString(),
  }));
  try {
    const { error } = await supabase.from("ticks").upsert(snapshot, { onConflict: "row_id" });
    if (error) throw error;
    for (const item of snapshot) {
      if (pending.get(item.row_id) === item.ticked) pending.delete(item.row_id);
    }
    persistLocal();
    setSync("online");
  } catch {
    setSync("offline");
  } finally {
    flushing = false;
  }
}

function setSync(next) {
  if (syncState === next) return;
  const previous = syncState;
  syncState = next;
  els.syncBadge.dataset.state = next;
  els.syncText.textContent = {
    loading: "Memuat…",
    online: "Tersinkron",
    offline: "Offline — tersimpan lokal",
    local: "Lokal (tanpa server)",
  }[next];
  if (next === "offline" && previous !== "loading") {
    toast("Koneksi ke server gagal. Tanda disimpan di browser dan akan dikirim ulang.", "warn");
  }
}

async function loadRemoteTicks() {
  try {
    const { data, error } = await supabase.from("ticks").select("row_id,ticked").limit(20000);
    if (error) throw error;
    const next = new Map();
    for (const record of data || []) next.set(record.row_id, record.ticked === true);
    for (const [id, v] of pending) next.set(id, v);
    state.ticks = next;
    persistLocal();
    setSync("online");
    refreshTickUI([...next.keys()]);
    updateStats(getFiltered().length);
  } catch {
    setSync("offline");
  }
}

function subscribeRealtime() {
  supabase
    .channel("ticks-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "ticks" }, (payload) => {
      const record = payload.new;
      if (!record || typeof record.row_id !== "string") return;
      const ticked = record.ticked === true;
      const local = localWrites.get(record.row_id);
      if (local && local.ticked !== ticked && Date.now() - local.at < LOCAL_WRITE_TTL) return;
      if (local && local.ticked === ticked) localWrites.delete(record.row_id);
      state.ticks.set(record.row_id, ticked);
      if (pending.get(record.row_id) === ticked) pending.delete(record.row_id);
      persistLocal();
      refreshTickUI([record.row_id]);
      updateStats(getFiltered().length);
    })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") setSync("online");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setSync("offline");
    });
}

async function initTicks() {
  loadLocalTicks();
  render();
  if (!SUPABASE_URL || !SUPABASE_KEY || SUPABASE_URL.includes("__")) {
    setSync("local");
    return;
  }
  try {
    const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      realtime: { params: { eventsPerSecond: 10 } },
    });
  } catch {
    setSync("local");
    toast("Pustaka sinkronisasi gagal dimuat. Tanda hanya tersimpan di browser ini.", "warn");
    return;
  }
  await loadRemoteTicks();
  subscribeRealtime();
  flushPending();
}

/* ---------- filter panel ---------- */

function positionPanel(anchor) {
  const rect = anchor.getBoundingClientRect();
  els.panel.style.visibility = "hidden";
  els.panel.hidden = false;
  const width = els.panel.offsetWidth;
  const height = els.panel.offsetHeight;
  let left = Math.min(rect.left - 12, window.innerWidth - width - 12);
  left = Math.max(12, left);
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 12) top = Math.max(12, rect.top - height - 6);
  els.panel.style.left = `${left}px`;
  els.panel.style.top = `${top}px`;
  els.panel.style.visibility = "";
}

function openPanel(col, anchor) {
  panelCol = col;
  const filter = state.filters.get(col);
  els.panelTitle.textContent = state.columns[col];
  els.panelSearch.value = "";
  els.panelContains.value = filter ? filter.contains : "";
  renderPanelList();
  positionPanel(anchor);
  updateHeadIndicators();
  els.panelSearch.focus();
}

function closePanel() {
  if (els.panel.hidden) return;
  els.panel.hidden = true;
  panelCol = null;
  updateHeadIndicators();
}

function renderPanelList() {
  if (panelCol === null) return;
  const term = els.panelSearch.value.trim().toLowerCase();
  const all = getUnique(panelCol);
  const selected = effectiveSelected(panelCol);
  const matches = term ? all.filter((v) => v.toLowerCase().includes(term)) : all;
  const shown = matches.slice(0, LIST_RENDER_LIMIT);
  const frag = document.createDocumentFragment();
  if (!shown.length) {
    const empty = document.createElement("p");
    empty.className = "none";
    empty.textContent = "Tidak ada nilai yang cocok.";
    frag.append(empty);
  }
  for (const option of shown) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset.value = option;
    box.checked = selected.has(option);
    const text = document.createElement("span");
    text.textContent = option === "" ? "(kosong)" : option;
    text.title = option;
    label.append(box, text);
    frag.append(label);
  }
  els.panelList.replaceChildren(frag);
  updatePanelNote();
}

function updatePanelNote() {
  if (panelCol === null) return;
  const all = getUnique(panelCol);
  const filter = state.filters.get(panelCol);
  const selected = effectiveSelected(panelCol);
  if (filter && filter.none) {
    els.panelNote.textContent = "Tidak ada nilai dipilih — tidak ada baris yang ditampilkan untuk kolom ini.";
    return;
  }
  const term = els.panelSearch.value.trim();
  const matches = term ? all.filter((v) => v.toLowerCase().includes(term.toLowerCase())).length : all.length;
  const parts = [`${nf.format(selected.size)} dari ${nf.format(all.length)} nilai dipilih`];
  if (term && matches > LIST_RENDER_LIMIT) parts.push(`${nf.format(matches)} nilai cocok, hanya ${nf.format(LIST_RENDER_LIMIT)} ditampilkan`);
  els.panelNote.textContent = parts.join(" · ");
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

function exportTicked() {
  const rows = state.rows.filter((row) => state.ticks.get(row[0]) === true);
  if (!rows.length) {
    toast("Belum ada baris yang ditandai.", "warn");
    return;
  }
  const aoa = [[...state.columns, "Ditandai"], ...rows.map((row) => [...row.slice(1), "Ya"])];
  const name = `data-master-tanah-ditandai-${timestamp()}`;
  if (window.XLSX) {
    const sheet = window.XLSX.utils.aoa_to_sheet(aoa);
    sheet["!cols"] = state.columns.map((col, i) => ({
      wch: Math.min(60, Math.max(10, col.length + 2, ...aoa.slice(1, 40).map((r) => String(r[i] ?? "").length + 2))),
    }));
    const book = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(book, sheet, "Ditandai");
    window.XLSX.writeFile(book, `${name}.xlsx`);
    toast(`${nf.format(rows.length)} baris diekspor ke Excel.`);
  } else {
    const csv = "\uFEFF" + aoa.map((row) => row.map(csvCell).join(",")).join("\r\n");
    downloadBlob(csv, `${name}.csv`, "text/csv;charset=utf-8");
    toast(`${nf.format(rows.length)} baris diekspor ke CSV.`);
  }
}

/* ---------- toasts ---------- */

function toast(message, kind = "info") {
  const el = document.createElement("p");
  el.className = `toast${kind === "warn" ? " warn" : ""}`;
  el.textContent = message;
  els.toasts.append(el);
  setTimeout(() => el.remove(), 4500);
}

/* ---------- version watch ---------- */

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

/* ---------- events ---------- */

let quickTimer = null;
els.quickSearch.addEventListener("input", () => {
  clearTimeout(quickTimer);
  quickTimer = setTimeout(() => {
    state.quick = els.quickSearch.value.trim().toLowerCase();
    filteredCache = null;
    state.page = 1;
    render();
    updateResetState();
  }, 150);
});

let containsTimer = null;
els.panelContains.addEventListener("input", () => {
  clearTimeout(containsTimer);
  containsTimer = setTimeout(() => setContains(panelCol, els.panelContains.value), 150);
});

els.panelSearch.addEventListener("input", renderPanelList);
els.panelClose.addEventListener("click", closePanel);

els.panelList.addEventListener("change", (event) => {
  const box = event.target.closest("input[type=checkbox]");
  if (!box) return;
  setValueSelected(panelCol, box.dataset.value, box.checked);
});

els.panelAll.addEventListener("click", () => {
  const filter = state.filters.get(panelCol);
  if (filter) {
    filter.values = null;
    filter.none = false;
    cleanupFilter(panelCol);
  }
  afterFilterChange(panelCol, true);
});

els.panelNone.addEventListener("click", () => {
  const filter = ensureFilter(panelCol);
  filter.values = new Set();
  filter.none = true;
  afterFilterChange(panelCol, true);
});

els.panelInvert.addEventListener("click", () => {
  const all = getUnique(panelCol);
  const selected = effectiveSelected(panelCol);
  const inverted = new Set(all.filter((v) => !selected.has(v)));
  const filter = ensureFilter(panelCol);
  filter.none = inverted.size === 0;
  filter.values = inverted;
  cleanupFilter(panelCol);
  afterFilterChange(panelCol, true);
});

els.resetFilters.addEventListener("click", clearAllFilters);
els.tickedFilterBtn.addEventListener("click", () => setTickedOnly(!state.tickedOnly));
els.issueStrip.addEventListener("click", (event) => {
  const card = event.target.closest(".issue-card");
  if (!card) return;
  toggleMissing(Number(card.dataset.col));
});
els.emptyReset.addEventListener("click", clearAllFilters);
els.exportBtn.addEventListener("click", exportTicked);

els.refreshBtn.addEventListener("click", async () => {
  if (!supabase) {
    toast("Sinkronisasi tidak aktif — tanda hanya tersimpan di browser.", "warn");
    return;
  }
  els.refreshBtn.disabled = true;
  await loadRemoteTicks();
  await flushPending();
  els.refreshBtn.disabled = false;
  toast("Tanda dimuat ulang dari server.");
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePanel();
});

document.addEventListener("mousedown", (event) => {
  if (els.panel.hidden) return;
  if (els.panel.contains(event.target) || event.target.closest(".funnel")) return;
  closePanel();
});

els.tableWrap.addEventListener("scroll", closePanel);
window.addEventListener("resize", () => {
  closePanel();
  requestAnimationFrame(refreshFrozenOffsets);
});
window.addEventListener("offline", () => { if (supabase) setSync("offline"); });
window.addEventListener("online", () => {
  if (!supabase) return;
  loadRemoteTicks().then(flushPending);
});

/* ---------- boot ---------- */

async function boot() {
  try {
    const response = await fetch("data.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.columns = data.columns;
    state.rows = data.rows;
    const hidden = new Set(HIDDEN_COLUMNS);
    state.visible = data.columns.map((_, col) => col).filter((col) => !hidden.has(data.columns[col]));
    loadWidths();
  } catch (error) {
    els.tableEmpty.hidden = false;
    els.emptyMsg.textContent = "Data tidak dapat dimuat. Muat ulang halaman untuk mencoba lagi.";
    els.emptyReset.hidden = true;
    toast("Data gagal dimuat. Periksa koneksi lalu muat ulang.", "warn");
    return;
  }
  renderHead();
  updateResetState();
  watchVersion();
  await initTicks();
}

boot();
