import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const PAGE_SIZE = 50;
const LIST_RENDER_LIMIT = 500;
const LS_TICKS = "dmt.ticks.v1";
const LS_PENDING = "dmt.pending.v1";

// Kolom yang disembunyikan dari tabel (tidak dihapus dari data/export).
const HIDDEN_COLUMNS = [
  "dok_kepemilikan",
  "jns_dok_kepemilikan",
  "kd_jns_serti",
  "nm_jns_serti",
  "no_dokumen",
  "tgl_dokumen",
  "status_sertipikasi",
  "status_dok",
  "status_validasi",
  "ur_sts_valid_kpknl",
  "ur_sts_valid_kanwil",
];

// Kolom beku (sticky) beserta lebar tetapnya, dihitung dari kiri.
const FROZEN_WIDTHS = new Map([
  ["No", 62],
  ["kd_satker", 208],
  ["ur_satker", 170],
  ["ur_sskel", 132],
  ["kd_brg", 116],
  ["no_aset", 82],
  ["luas_asset", 98],
  ["luas_bidang", 106],
  ["jml_bid", 80],
]);

const state = {
  columns: [],
  rows: [],
  visible: [],
  filters: new Map(),
  quick: "",
  sort: null,
  page: 1,
  ticks: new Map(),
};

const pending = new Map();
const uniqueCache = new Map();
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
  srcLabel: document.getElementById("srcLabel"),
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
  tableWrap: document.getElementById("tableWrap"),
  grid: document.getElementById("grid"),
  headRow: document.getElementById("headRow"),
  tbody: document.getElementById("tbody"),
  tableEmpty: document.getElementById("tableEmpty"),
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

let frozenOffsets = null;

function frozenLeft(col) {
  if (!frozenOffsets) {
    frozenOffsets = new Map();
    let left = 0;
    for (const visibleCol of state.visible) {
      const name = state.columns[visibleCol];
      if (!FROZEN_WIDTHS.has(name)) break;
      frozenOffsets.set(visibleCol, left);
      left += FROZEN_WIDTHS.get(name);
    }
  }
  return frozenOffsets.get(col);
}

function isFrozenEdge(col) {
  const position = state.visible.indexOf(col);
  const next = state.visible[position + 1];
  return next === undefined || !FROZEN_WIDTHS.has(state.columns[next]);
}

function isFiltering() {
  return state.quick !== "" || state.filters.size > 0;
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

function getFiltered() {
  if (filteredCache) return filteredCache;
  const out = [];
  state.rows.forEach((row, index) => {
    if (matchesQuick(row) && matchesFilters(row)) out.push(index);
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

function renderHead() {
  const frag = document.createDocumentFragment();
  state.visible.forEach((col) => {
    const name = state.columns[col];
    const th = document.createElement("th");
    th.dataset.col = String(col);
    const left = frozenLeft(col);
    if (left !== undefined) {
      const width = FROZEN_WIDTHS.get(name);
      th.classList.add("frozen");
      if (isFrozenEdge(col)) th.classList.add("frozen-edge");
      th.style.width = `${width}px`;
      th.style.minWidth = `${width}px`;
      th.style.maxWidth = `${width}px`;
      th.style.left = `${left}px`;
    }
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
    th.append(wrap);
    frag.append(th);
  });
  const thTick = document.createElement("th");
  thTick.className = "tickhead";
  const headTick = document.createElement("input");
  headTick.type = "checkbox";
  headTick.id = "headTick";
  headTick.title = "Tandai semua baris di halaman ini";
  headTick.setAttribute("aria-label", "Tandai semua baris di halaman ini");
  headTick.addEventListener("change", () => {
    const entries = [...els.tbody.querySelectorAll("tr")].map((tr) => [tr.dataset.id, headTick.checked]);
    if (entries.length) setTicks(entries);
  });
  thTick.append(headTick);
  frag.append(thTick);
  els.headRow.replaceChildren(frag);
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

const headTickEl = () => document.getElementById("headTick");

function updatePageCheckbox() {
  const headTick = headTickEl();
  if (!headTick) return;
  const rows = [...els.tbody.querySelectorAll("tr")];
  if (!rows.length) {
    headTick.checked = false;
    headTick.indeterminate = false;
    headTick.disabled = true;
    return;
  }
  headTick.disabled = false;
  let count = 0;
  for (const tr of rows) if (state.ticks.get(tr.dataset.id) === true) count++;
  headTick.checked = count === rows.length;
  headTick.indeterminate = count > 0 && count < rows.length;
}

function buildRow(row) {
  const tr = document.createElement("tr");
  tr.dataset.id = row[0];
  if (state.ticks.get(row[0]) === true) tr.classList.add("is-ticked");
  state.visible.forEach((col) => {
    const td = document.createElement("td");
    td.dataset.col = String(col);
    const text = value(row, col);
    const left = frozenLeft(col);
    if (left !== undefined) {
      const width = FROZEN_WIDTHS.get(state.columns[col]);
      td.classList.add("frozen");
      if (isFrozenEdge(col)) td.classList.add("frozen-edge");
      td.style.width = `${width}px`;
      td.style.minWidth = `${width}px`;
      td.style.maxWidth = `${width}px`;
      td.style.left = `${left}px`;
    }
    td.textContent = text;
    if (text.length > 24) td.title = text;
    tr.append(td);
  });
  const tdTick = document.createElement("td");
  tdTick.className = "tickcell";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = state.ticks.get(row[0]) === true;
  box.setAttribute("aria-label", `Tandai baris No ${row[1]}`);
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
  updatePageCheckbox();
  updateStats(filtered.length);
  els.tableEmpty.hidden = filtered.length !== 0;
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
  updatePageCheckbox();
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
  for (const [id, ticked] of entries) {
    state.ticks.set(id, ticked);
    pending.set(id, ticked);
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
window.addEventListener("resize", closePanel);
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
    els.srcLabel.textContent = `${data.source} / ${data.sheet}`;
  } catch (error) {
    els.srcLabel.textContent = "data gagal dimuat";
    els.tableEmpty.hidden = false;
    els.tableEmpty.textContent = "Data tidak dapat dimuat. Muat ulang halaman untuk mencoba lagi.";
    toast("Data gagal dimuat. Periksa koneksi lalu muat ulang.", "warn");
    return;
  }
  renderHead();
  updateResetState();
  await initTicks();
}

boot();
