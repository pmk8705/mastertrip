'use strict';

/* ============ 저장소 ============ */
const STORE_KEY = 'mastertrip-v1';
const LEGACY_KEYS = ['spain-trip-v1']; // 이름 변경 전 저장 키. 남아 있으면 옮겨 온다.

function loadRaw() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
    for (const k of LEGACY_KEYS) {
      const old = localStorage.getItem(k);
      if (!old) continue;
      localStorage.setItem(STORE_KEY, old);
      localStorage.removeItem(k);
      return JSON.parse(old);
    }
  } catch (e) { console.warn('load failed', e); }
  return null;
}

// 어떤 버전의 저장 데이터든 현재 구조(schema 2: 여러 여행)로 바꾼다.
function migrate(s) {
  if (s && Array.isArray(s.trips)) {
    s.trips.forEach(normalizeTrip);
    s.schema = SCHEMA_VERSION;
    return s;
  }
  if (s && s.trip && Array.isArray(s.days)) {
    // schema 1: 여행 하나짜리 데이터 → 여행 목록의 첫 여행으로
    const title = s.trip.title || '내 여행';
    const trip = normalizeTrip({
      id: 'trip-' + uid(),
      title,
      emoji: /신혼|허니문/.test(title) ? '💍' : '✈️',
      places: placesFromDays(s.days),
      region: '해외',
      currency: 'EUR', // schema 1은 유로만 지원했다
      start: s.trip.start,
      end: s.trip.end,
      days: s.days,
      checklist: s.checklist,
      budget: s.budget,
      expenses: s.expenses,
      bookings: s.bookings,
      contacts: s.contacts,
    });
    return { schema: SCHEMA_VERSION, trips: [trip] };
  }
  return migrate(seedData()); // 처음 실행: 시드에도 분류 등 기본값 채우기
}

// 일정 항목 분류 (타임라인 아이콘·색)
const ITEM_CATS = {
  관광: { icon: '🏛️', color: '#3B82F6' },
  식사: { icon: '🍽️', color: '#F97316' },
  카페: { icon: '☕', color: '#A16207' },
  쇼핑: { icon: '🛍️', color: '#DB2777' },
  이동: { icon: '🚆', color: '#64748B' },
  숙소: { icon: '🏨', color: '#7C3AED' },
  액티비티: { icon: '🎢', color: '#059669' },
  기타: { icon: '📌', color: '#9CA3AF' },
};
// 분류가 없는 예전 일정은 제목으로 짐작한다 (나중에 바꿀 수 있음)
function guessCat(title) {
  const rules = [
    [/점심|저녁|아침|식사|타파스|디너|빠에야|레스토랑|맛집|해산물/, '식사'],
    [/카페|커피|디저트/, '카페'],
    [/쇼핑|시장|기념품|아울렛/, '쇼핑'],
    [/이동|공항|출국|도착|귀가|기차|버스|항공|트램|페리/, '이동'],
    [/체크인|체크아웃|숙소|호텔/, '숙소'],
    [/공연|플라멩코|해변|스파|투어|드라이브|일몰|전망대/, '액티비티'],
  ];
  const hit = rules.find(([re]) => re.test(title || ''));
  return hit ? hit[1] : '관광';
}

function normalizeTrip(t) {
  t.emoji = t.emoji || '✈️';
  t.places = t.places || '';
  t.region = t.region || '해외';
  t.currency = t.currency || (t.region === '국내' ? 'KRW' : 'EUR');
  for (const k of ['days', 'checklist', 'expenses', 'bookings', 'contacts']) if (!Array.isArray(t[k])) t[k] = [];
  for (const d of t.days) {
    d.items = d.items || [];
    for (const it of d.items) {
      if (!it.cat) it.cat = guessCat(it.title);
      if (it.dur == null) it.dur = '';
      if (it.cost == null) it.cost = '';
    }
  }
  t.budget = t.budget || {};
  t.budget.rate = t.budget.rate || 1;
  t.budget.plan = t.budget.plan || {};
  return t;
}

// "세비야 → 그라나다" 같은 도시 칸에서 방문 도시만 뽑는다 (출국·귀국일 제외)
function placesFromDays(days) {
  const seen = [];
  for (const d of days || []) {
    for (const tok of String(d.city || '').split('→').map((x) => x.trim())) {
      if (!tok || /출국|도착|귀국|인천|김포/.test(tok) || seen.includes(tok)) continue;
      seen.push(tok);
    }
  }
  return seen.join(' · ');
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    toast('저장 실패: 저장 공간을 확인하세요');
  }
}

/* ============ 유틸 ============ */
const $ = (sel, el = document) => el.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

function todayStr() {
  const d = new Date();
  return ymd(d);
}
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function diffDays(a, b) { return Math.round((parseDate(a) - parseDate(b)) / 86400000); }
function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return ymd(d); }
// 날짜 표기 (사용자 결정): 27.04.13 (화). 위쪽 날짜 버튼만 짧게 4/13.
function fmtDate(s) {
  if (!s) return '';
  const d = parseDate(s);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(d.getFullYear() % 100)}.${p2(d.getMonth() + 1)}.${p2(d.getDate())} (${WEEK[d.getDay()]})`;
}
function fmtRange(start, end) {
  const dot = (s) => s.replace(/-/g, '.');
  return start.slice(0, 4) === end.slice(0, 4) ? `${dot(start)} – ${dot(end.slice(5))}` : `${dot(start)} – ${dot(end)}`;
}

const CURRENCIES = ['EUR', 'USD', 'JPY', 'GBP', 'CNY', 'TWD', 'HKD', 'VND', 'THB', 'PHP', 'SGD', 'AUD', 'CAD', 'CHF', 'KRW'];
const SYMBOLS = { EUR: '€', USD: '$', JPY: '¥', GBP: '£', CNY: '¥' };
function won(n) { return Math.round(n).toLocaleString('ko-KR') + '원'; }
function money(n, cur) {
  if (cur === 'KRW') return won(n);
  const v = (Math.round(n * 100) / 100).toLocaleString('ko-KR');
  return SYMBOLS[cur] ? SYMBOLS[cur] + v : `${v} ${cur}`;
}
const isHHMM = (t) => /^\d{1,2}:\d{2}$/.test(t || '');
const hhmm = (t) => t.padStart(5, '0');

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

/* ============ 여행 표지 사진 (IndexedDB) ============ */
// 사진은 localStorage(약 5MB)에 넣기엔 커서 IndexedDB에 여행 id별로 Blob으로 저장한다.
const media = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('mastertrip-media', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('covers');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction('covers', mode);
      const req = fn(tx.objectStore('covers'));
      tx.oncomplete = () => res(req && req.result);
      tx.onerror = () => rej(tx.error);
    });
  };
  return {
    set: (k, v) => run('readwrite', (st) => st.put(v, k)),
    del: (k) => run('readwrite', (st) => st.delete(k)),
    clear: () => run('readwrite', (st) => st.clear()),
    keys: () => run('readonly', (st) => st.getAllKeys()),
    values: () => run('readonly', (st) => st.getAll()),
  };
})();
const coverUrls = {}; // 여행 id → 화면에 쓸 사진 주소

async function loadCovers() {
  try {
    const [keys, vals] = await Promise.all([media.keys(), media.values()]);
    keys.forEach((k, i) => { coverUrls[k] = URL.createObjectURL(vals[i]); });
  } catch (e) { console.warn('사진 불러오기 실패', e); }
}
async function setCover(id, blob) {
  await media.set(id, blob);
  if (coverUrls[id]) URL.revokeObjectURL(coverUrls[id]);
  coverUrls[id] = URL.createObjectURL(blob);
}
async function removeCover(id) {
  await media.del(id);
  if (coverUrls[id]) URL.revokeObjectURL(coverUrls[id]);
  delete coverUrls[id];
}
async function clearCovers() {
  await media.clear();
  Object.keys(coverUrls).forEach((k) => { URL.revokeObjectURL(coverUrls[k]); delete coverUrls[k]; });
}

// 폰 사진(수 MB)을 긴 변 1200px JPEG로 줄인다
async function shrinkImage(file, max = 1200) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
  } finally {
    URL.revokeObjectURL(url);
  }
}

const blobToDataUrl = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });

let state = migrate(loadRaw());
save();
// 홈 화면에 설치하지 않은 상태에서도 브라우저가 데이터를 지우지 않도록 요청
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

/* ============ 모달 (공용 폼) ============ */
const modal = $('#modal');
let modalHandlers = {};

function openModal({ title, fields = [], html = '', onSave, onDelete, saveLabel = '저장', deleteConfirm = '삭제할까요?' }) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html + fields.map(fieldHtml).join('');
  $('#modalSave').style.display = onSave ? '' : 'none';
  $('#modalSave').textContent = saveLabel;
  $('#modalDelete').style.display = onDelete ? '' : 'none';
  $('#modalCancel').textContent = onSave ? '취소' : '닫기';
  modalHandlers = { onSave, onDelete, deleteConfirm };
  modal.showModal();
  const first = $('#modalBody input:not([type=hidden]), #modalBody textarea');
  if (first && !('ontouchstart' in window)) first.focus();
}

function fieldHtml(f) {
  const v = esc(f.value ?? '');
  const attrs = `name="${f.name}" ${f.required ? 'required' : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}`;
  let input;
  if (f.type === 'select') {
    input = `<select ${attrs}>${f.options.map((o) => `<option ${o === f.value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  } else if (f.type === 'textarea') {
    input = `<textarea ${attrs}>${v}</textarea>`;
  } else {
    const extra = f.type === 'number' ? 'inputmode="decimal" step="any" min="0"' : '';
    input = `<input type="${f.type || 'text'}" ${attrs} ${extra} value="${v}" ${f.list ? `list="${f.name}-list"` : ''}>`;
    if (f.list) input += `<datalist id="${f.name}-list">${f.list.map((o) => `<option value="${esc(o)}">`).join('')}</datalist>`;
  }
  return `<label class="field"><span>${esc(f.label)}</span>${input}</label>`;
}

$('#modalForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!modalHandlers.onSave) return modal.close();
  const data = Object.fromEntries(new FormData(e.target).entries());
  for (const k in data) data[k] = data[k].trim();
  if (modalHandlers.onSave(data) === false) return;
  modal.close();
  save();
  render();
});
$('#modalCancel').addEventListener('click', () => modal.close());
$('#modalDelete').addEventListener('click', () => {
  if (!confirm(modalHandlers.deleteConfirm)) return;
  modalHandlers.onDelete();
  modal.close();
  save();
  render();
  toast('삭제했어요');
});

/* ============ 여행 선택 ============ */
const getTrip = (id) => state.trips.find((t) => t.id === id);

function phaseOf(t, today = todayStr()) {
  if (today < t.start) return 'soon';
  if (today > t.end) return 'past';
  return 'now';
}

// 홈 목록 순서: 여행 중 → 다가오는 여행(가까운 순) → 지난 여행(최근 순)
function sortTrips(list) {
  const rank = { now: 0, soon: 1, past: 2 };
  return [...list].sort((a, b) => {
    const pa = phaseOf(a), pb = phaseOf(b);
    if (pa !== pb) return rank[pa] - rank[pb];
    return pa === 'past' ? b.end.localeCompare(a.end) : a.start.localeCompare(b.start);
  });
}

// 체크리스트·예산·예약 탭이 보여줄 여행: 사용자가 고른 여행, 없으면 자동(여행 중 → 가장 가까운 여행)
function autoTrip() { return sortTrips(state.trips)[0] || null; }
function focusTrip() { return getTrip(pickedTripId) || autoTrip(); }
function detailTrip() { return getTrip(openTripId); }

/* ============ 라우팅 ============ */
// 하단 탭: 홈 | 내 여행 | 기록 | 설정. 내 여행 안의 상단 탭: 내 여행 | 체크리스트 | 예산 | 예약
const MAIN_TABS = ['home', 'trips', 'records', 'settings'];
const SUB_TABS = ['trips', 'check', 'budget', 'book'];
let mainTab = sessionStorage.getItem('main');
if (!MAIN_TABS.includes(mainTab)) mainTab = 'trips';
let subTab = sessionStorage.getItem('sub');
if (!SUB_TABS.includes(subTab)) subTab = 'trips';
let pickedTripId = sessionStorage.getItem('trip') || null;
let openTripId = (history.state && history.state.trip) || null; // 여행 상세 화면에 들어가 있으면 그 여행 id
let tripFilter = { now: true, soon: true, past: false };
let searchOpen = false;
let searchQuery = '';
let selectedDate = null;
let checkFilter = 'all';

function remember(key, val) {
  try { if (val == null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, val); } catch (e) {}
}

function setMain(next) {
  mainTab = next;
  remember('main', next);
  render();
  window.scrollTo(0, 0);
}
function setSub(next) {
  subTab = next;
  remember('sub', next);
  render();
}

function pickTrip(id) {
  pickedTripId = id;
  remember('trip', id);
}

// 상세 화면은 브라우저 기록에 남겨서 안드로이드 뒤로가기 버튼으로 목록에 돌아오게 한다
function openTrip(id) {
  pickTrip(id);
  selectedDate = null;
  openTripId = id;
  history.pushState({ trip: id }, '');
  setMain('trips');
}
function closeTrip() {
  if (history.state && history.state.trip) history.back();
  else { openTripId = null; render(); }
}
window.addEventListener('popstate', (e) => {
  openTripId = (e.state && e.state.trip) || null;
  selectedDate = null;
  render();
});

document.querySelectorAll('.tabbar button').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.main === 'trips' && mainTab === 'trips' && openTripId) return closeTrip();
    setMain(btn.dataset.main);
  });
});
document.querySelectorAll('.top-tabs button').forEach((btn) => {
  btn.addEventListener('click', () => setSub(btn.dataset.sub));
});

const inDetail = () => mainTab === 'trips' && !!detailTrip();

function render() {
  if (openTripId && !detailTrip()) openTripId = null;
  const detail = inDetail();
  const showHero = !detail && (mainTab === 'home' || mainTab === 'trips');
  $('#hero').hidden = !showHero;
  $('#topTabs').hidden = !(mainTab === 'trips' && !detail);
  $('#topbar').hidden = showHero;
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.main === mainTab));
  document.querySelectorAll('.top-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.sub === subTab));
  renderTopbar(detail);

  if (leafletMap) { leafletMap.remove(); leafletMap = null; }
  const view = $('#view');
  const oldStrip = $('.day-strip');
  const stripLeft = oldStrip ? oldStrip.scrollLeft : 0; // 다시 그려도 날짜 줄 위치를 유지
  if (mainTab === 'home') view.innerHTML = renderToday();
  else if (mainTab === 'records') view.innerHTML = renderRecords();
  else if (mainTab === 'settings') view.innerHTML = renderSettings();
  else if (detail) view.innerHTML = renderDays(detailTrip());
  else if (subTab === 'trips') view.innerHTML = renderTripsList();
  else {
    const t = focusTrip();
    if (!t) view.innerHTML = renderNoTrip();
    else view.innerHTML = tripSwitchRow(t) + (subTab === 'check' ? renderCheck(t) : subTab === 'budget' ? renderBudget(t) : renderBook(t));
  }
  if (detail) {
    centerActiveChip(stripLeft);
    mountMap(detailTrip(), currentDay());
  }
}

// 고른 날짜 버튼을 날짜 줄 가운데로. scrollIntoView는 페이지 전체까지 움직여서 화면이 흔들리므로 줄만 움직인다.
function centerActiveChip(fromLeft) {
  const strip = $('.day-strip');
  const chip = strip && strip.querySelector('.chip.active');
  if (!chip) return;
  strip.scrollLeft = fromLeft;
  const max = strip.scrollWidth - strip.clientWidth;
  const target = Math.max(0, Math.min(max, chip.offsetLeft - (strip.clientWidth - chip.offsetWidth) / 2));
  strip.scrollTo({ left: target, behavior: fromLeft ? 'smooth' : 'auto' });
  // 애니메이션이 멈춰 있는 환경(화면이 가려진 경우 등)에서도 결국 제자리에 오도록
  setTimeout(() => { if (strip.isConnected && Math.abs(strip.scrollLeft - target) > 2) strip.scrollLeft = target; }, 450);
}

function tripSub(t) {
  const today = todayStr();
  const p = phaseOf(t, today);
  if (p === 'soon') return `D-${diffDays(t.start, today)} · ${fmtRange(t.start, t.end)}`;
  if (p === 'now') {
    const day = t.days.find((d) => d.date === today);
    return `여행 ${diffDays(today, t.start) + 1}일차${day && day.city ? ' · ' + day.city : ''}`;
  }
  return `${fmtRange(t.start, t.end)} · 지난 여행`;
}

function renderTopbar(detail) {
  $('#backBtn').hidden = !detail;
  $('#tripEditBtn').hidden = !detail;
  const h1 = $('#tripTitle');
  const sub = $('#tripSub');
  document.title = 'MasterTrip Planner';
  if (detail) {
    const t = detailTrip();
    h1.textContent = `${t.emoji} ${t.title}`;
    sub.textContent = tripSub(t);
    document.title = `${t.title} · MasterTrip`;
  } else if (mainTab === 'records') {
    h1.textContent = '기록';
    sub.textContent = '여행의 순간을 남기는 곳';
  } else if (mainTab === 'settings') {
    h1.textContent = '설정';
    sub.textContent = '백업 · 데이터 관리';
  }
}

// 체크리스트·예산·예약 화면 맨 위: 지금 보고 있는 여행 + 바꾸기
function tripSwitchRow(t) {
  return `<button class="trip-switch-row" data-act="switch-trip">
    <span class="emo">${esc(t.emoji)}</span>
    <span class="grow"><b>${esc(t.title)}</b> <span class="caret">▾</span><br><span class="muted small">${tripSub(t)}</span></span>
    ${tripBadge(t)}
  </button>`;
}

/* ============ 내 여행 목록 · 홈 ============ */
const PHASE_LABEL = { now: '현재 여행', soon: '다가오는 여행', past: '지난 여행' };
// 사진이 없는 여행 카드의 노을빛 배경 (여행마다 하나씩 고정)
const COVER_GRADIENTS = [
  'linear-gradient(135deg, #2b3a67 0%, #b5475a 55%, #f2a65a 100%)',
  'linear-gradient(135deg, #1d3557 0%, #457b9d 50%, #e9c46a 100%)',
  'linear-gradient(135deg, #3d1e6d 0%, #c2185b 55%, #ff8a65 100%)',
  'linear-gradient(135deg, #0f3d3e 0%, #2a9d8f 50%, #f4a261 100%)',
  'linear-gradient(135deg, #22223b 0%, #9a4c95 50%, #f2cc8f 100%)',
];

function tripBadge(t) {
  const p = phaseOf(t);
  if (p === 'now') return '<span class="badge now">여행 중</span>';
  if (p === 'soon') return `<span class="badge soon">D-${diffDays(t.start, todayStr())}</span>`;
  return '<span class="badge past">지난 여행</span>';
}

function coverStyle(t) {
  if (coverUrls[t.id]) return `--cover: url('${coverUrls[t.id]}')`;
  let h = 0;
  for (const ch of t.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `--cover: ${COVER_GRADIENTS[h % COVER_GRADIENTS.length]}`;
}

// 카드 둘째 줄: 여행 중이면 오늘 동선, 다가오는 여행이면 첫 일정들, 아니면 여행지
function routeLine(t) {
  const p = phaseOf(t);
  const titles = (day) => {
    if (!day || !day.items.length) return '';
    const names = day.items.slice(0, 3).map((i) => esc(i.title));
    return names.join(' → ') + (day.items.length > 3 ? ' …' : '');
  };
  if (p === 'now') {
    const r = titles(t.days.find((d) => d.date === todayStr()));
    if (r) return `오늘 동선: ${r}`;
  } else if (p === 'soon') {
    const r = titles(t.days.find((d) => d.items.length));
    if (r) return r;
  }
  return esc(t.places);
}

function tripCard(t) {
  const p = phaseOf(t);
  const dayTag = p === 'now' ? ` <span class="daytag">(Day ${diffDays(todayStr(), t.start) + 1}/${t.days.length})</span>` : '';
  const route = routeLine(t);
  return `
    <button class="trip-card ${p}" data-act="open-trip" data-id="${t.id}" style="${coverStyle(t)}">
      <span class="tc-badge">${tripBadge(t)}</span>
      <span class="tc-title">${esc(t.title)}${dayTag}</span>
      <span class="tc-date">${fmtRange(t.start, t.end)}</span>
      ${route ? `<span class="tc-route">${route}</span>` : ''}
    </button>`;
}

function tripListHtml() {
  const q = searchQuery.trim().toLowerCase();
  // 검색 중에는 지난 여행까지 모두 찾는다
  const list = sortTrips(state.trips.filter((t) => (q
    ? `${t.title} ${t.places}`.toLowerCase().includes(q)
    : tripFilter[phaseOf(t)])));
  if (list.length) return list.map(tripCard).join('');
  if (!state.trips.length) return '<div class="empty-state">아직 여행이 없어요.<br>위 버튼으로 첫 여행을 만들어 보세요.</div>';
  return `<div class="empty-state">${q ? '검색 결과가 없어요' : '이 조건에 맞는 여행이 없어요'}</div>`;
}

function renderTripsList() {
  const counts = { now: 0, soon: 0, past: 0 };
  state.trips.forEach((t) => counts[phaseOf(t)]++);
  const chips = Object.keys(PHASE_LABEL).map((p) => `
    <button class="chip-f ${tripFilter[p] ? 'active' : ''}" data-act="trip-filter" data-v="${p}">${tripFilter[p] ? '<i class="dot"></i>' : ''}${PHASE_LABEL[p]} (${counts[p]})</button>`).join('');
  const search = searchOpen ? `
    <div class="search-box">
      <input id="searchInput" type="search" placeholder="여행 이름·도시 검색" value="${esc(searchQuery)}" autocomplete="off">
      <button class="more-btn" data-act="search-close" aria-label="검색 닫기">✕</button>
    </div>` : '';
  return `
    ${search}
    <div class="chips-row">${chips}</div>
    <button class="cta" data-act="new-trip">+ 새로운 여행 일정 만들기</button>
    <div class="trip-list" id="tripList">${tripListHtml()}</div>`;
}

function renderNoTrip() {
  return `<div class="empty-state">아직 여행이 없어요.<br><br><button class="btn primary" data-act="new-trip">+ 새 여행 만들기</button></div>`;
}

// 홈: 지금(또는 다음) 여행의 오늘 할 일을 한눈에
function renderToday() {
  const t = autoTrip();
  if (!t) return renderNoTrip();
  const p = phaseOf(t);
  const today = todayStr();
  let html = `<div class="section-title"><h3>${p === 'now' ? '지금 여행 중' : p === 'soon' ? '다음 여행' : '최근 여행'}</h3></div>${tripCard(t)}`;

  if (p === 'now') {
    const day = t.days.find((d) => d.date === today);
    const items = day && day.items.length ? day.items.map((it) => `
      <li class="today-item ${it.done ? 'done' : ''}" data-act="open-trip" data-id="${t.id}">
        <span class="tl-time">${esc(it.time || '·')}</span><span class="grow">${esc(it.title)}</span>${it.done ? '✓' : ''}
      </li>`).join('') : '<li class="empty-state">오늘 일정이 없어요</li>';
    const spent = t.expenses.filter((e) => e.date === today).reduce((s, e) => s + toKRW(t, e), 0);
    html += `
      <div class="section-title"><h3>오늘 일정${day && day.city ? ' · ' + esc(day.city) : ''}</h3></div>
      <div class="card" style="padding:4px 14px"><ul class="today-list">${items}</ul></div>
      <div class="card row"><span>오늘 지출</span><span class="spacer"></span><b class="num">${won(spent)}</b>
        <button class="btn sm" data-act="goto-sub" data-v="budget" data-id="${t.id}">기록하기</button></div>`;
  } else if (p === 'soon') {
    const all = t.checklist;
    const done = all.filter((c) => c.done).length;
    const pct = all.length ? Math.round((done / all.length) * 100) : 0;
    const todo = all.filter((c) => !c.done).sort((a, b) => (b.due ?? -1) - (a.due ?? -1)).slice(0, 4);
    html += `
      <div class="section-title"><h3>준비할 일</h3><span class="muted small">${done}/${all.length} · ${pct}%</span></div>
      <div class="card" style="padding:4px 14px"><ul class="today-list">${todo.map((c) => `
        <li class="today-item" data-act="goto-sub" data-v="check" data-id="${t.id}">
          <span class="grow">${esc(c.text)}</span>${isOverdue(t, c) ? '<span class="overdue">기한 지남</span>' : ''}
        </li>`).join('') || '<li class="empty-state">준비 끝! 즐거운 여행 되세요</li>'}</ul></div>
      <button class="add-btn" data-act="goto-sub" data-v="check" data-id="${t.id}">체크리스트 전체 보기</button>`;
  }
  return html;
}

function renderRecords() {
  return `
    <div class="card" style="text-align:center;padding:28px 18px">
      <div style="font-size:40px">📝</div>
      <h3 style="margin:8px 0 6px">기록은 준비 중이에요</h3>
      <p class="muted small" style="margin:0">여행 일기, 사진 모음, 다녀온 곳 지도 같은 기능이 들어올 자리예요.</p>
    </div>`;
}

function tripForm(trip) {
  const isNew = !trip;
  const t = trip || { emoji: '✈️', title: '', places: '', start: '', end: '', region: '해외', currency: 'EUR', budget: { rate: '' } };
  openModal({
    title: isNew ? '새 여행 만들기' : '여행 정보 수정',
    html: `<div class="field-row emoji-row">${fieldHtml({ name: 'emoji', label: '아이콘', value: t.emoji })}${fieldHtml({ name: 'title', label: '여행 이름', value: t.title, required: true, placeholder: '예: 제주도 힐링 여행' })}</div>`,
    fields: [
      { name: 'places', label: '여행지 (도시)', value: t.places, placeholder: '예: 제주시 · 서귀포' },
      { name: 'start', label: '출발일', type: 'date', value: t.start, required: true },
      { name: 'end', label: '도착일 (돌아오는 날)', type: 'date', value: t.end, required: true },
      { name: 'region', label: '지역', type: 'select', options: ['해외', '국내'], value: t.region },
      { name: 'currency', label: '현지 통화 (해외)', value: t.currency, list: CURRENCIES, placeholder: '예: EUR, USD, JPY' },
      { name: 'rate', label: '환율: 현지 통화 1단위 = ?원 (해외)', type: 'number', value: t.region === '국내' ? '' : t.budget.rate },
    ],
    onSave: (d) => {
      if (!d.start || !d.end || d.end < d.start) { toast('날짜를 확인하세요 (도착일이 출발일보다 빠름)'); return false; }
      if (diffDays(d.end, d.start) > 120) { toast('여행 기간은 120일까지 가능해요'); return false; }
      let currency = (d.currency || '').toUpperCase();
      let rate = parseFloat(d.rate);
      if (d.region === '국내' || currency === 'KRW') { currency = 'KRW'; rate = 1; }
      else if (!currency) { toast('현지 통화를 입력하세요'); return false; }
      else if (!(rate > 0)) { toast('환율을 입력하세요'); return false; }

      if (isNew) {
        const tpl = newTripTemplate(d.region);
        const nt = normalizeTrip({
          id: 'trip-' + uid(), title: d.title, emoji: d.emoji || '✈️', places: d.places, region: d.region,
          currency, start: d.start, end: d.end, days: buildDays(d.start, d.end, []),
          checklist: tpl.checklist, contacts: tpl.contacts,
          budget: { rate, plan: Object.fromEntries(CATS.map((k) => [k, 0])) },
        });
        state.trips.push(nt);
        applyCoverChoice(nt.id);
        save();
        openTrip(nt.id);
        toast('여행을 만들었어요');
        return;
      }
      if (d.start !== trip.start || d.end !== trip.end) {
        const kept = new Set(buildDays(d.start, d.end, []).map((x) => x.date));
        const lost = trip.days.filter((x) => !kept.has(x.date) && x.items.length);
        if (lost.length && !confirm(`바뀐 기간에서 빠지는 날의 일정 ${lost.reduce((s, x) => s + x.items.length, 0)}개가 지워집니다. 계속할까요?`)) return false;
        trip.days = buildDays(d.start, d.end, trip.days);
      }
      Object.assign(trip, { title: d.title, emoji: d.emoji || '✈️', places: d.places, region: d.region, currency, start: d.start, end: d.end });
      applyCoverChoice(trip.id);
      trip.budget.rate = rate;
    },
    onDelete: isNew ? null : () => {
      state.trips = state.trips.filter((x) => x !== trip);
      removeCover(trip.id);
      if (pickedTripId === trip.id) pickTrip(null);
      if (openTripId === trip.id) closeTrip();
    },
    deleteConfirm: `'${t.title}' 여행과 그 안의 일정·체크리스트·지출·예약이 모두 지워집니다. 삭제할까요?`,
  });
  const has = !isNew && coverUrls[trip.id];
  $('#modalBody').insertAdjacentHTML('beforeend', `
    <div class="field"><span>표지 사진 (여행 카드 배경)</span>
      <div class="cover-pick">
        <span class="cover-thumb" id="coverThumb" style="${has ? `background-image:url('${coverUrls[trip.id]}')` : ''}"></span>
        <label class="btn sm">앨범에서 고르기<input type="file" id="coverInput" accept="image/*" hidden></label>
        ${has ? '<label class="small"><input type="checkbox" id="coverRemove"> 사진 빼기</label>' : ''}
      </div>
    </div>`);
  $('#coverInput').onchange = (ev) => {
    const f = ev.target.files[0];
    if (f) $('#coverThumb').style.backgroundImage = `url('${URL.createObjectURL(f)}')`;
  };
}

// 여행 폼을 저장할 때 고른 사진을 줄여서 저장 (저장은 비동기라 끝나면 다시 그린다)
function applyCoverChoice(id) {
  const file = $('#coverInput') && $('#coverInput').files[0];
  const remove = $('#coverRemove') && $('#coverRemove').checked;
  if (file) {
    shrinkImage(file).then((b) => setCover(id, b)).then(render).catch(() => toast('사진을 불러오지 못했어요'));
  } else if (remove) {
    removeCover(id).then(render);
  }
}

// 기간에 맞춰 날짜 목록을 만들고, 같은 날짜의 기존 일정은 그대로 가져온다
function buildDays(start, end, oldDays) {
  const byDate = new Map(oldDays.map((x) => [x.date, x]));
  const out = [];
  for (let s = start; s <= end; s = addDays(s, 1)) out.push(byDate.get(s) || { date: s, city: '', items: [] });
  return out;
}

function tripPicker() {
  const cur = pickedTripId;
  const rows = sortTrips(state.trips).map((t) => `
    <button type="button" class="pick-row ${t.id === cur ? 'on' : ''}" data-pick="${t.id}">
      <span>${esc(t.emoji)}</span><span class="grow"><b>${esc(t.title)}</b><br><span class="muted small">${fmtRange(t.start, t.end)}</span></span>${tripBadge(t)}
    </button>`).join('');
  openModal({
    title: '어느 여행을 볼까요?',
    html: `<button type="button" class="pick-row ${!cur ? 'on' : ''}" data-pick=""><span>✨</span><span class="grow"><b>자동 선택</b><br><span class="muted small">여행 중이거나 가장 가까운 여행</span></span></button>${rows}`,
  });
  document.querySelectorAll('#modalBody [data-pick]').forEach((b) => {
    b.onclick = () => { pickTrip(b.dataset.pick || null); modal.close(); render(); };
  });
}

/* ============ 지도 · 장소 검색 ============ */
// 지도 그림: OpenStreetMap 타일 + Leaflet (vendor/leaflet). 장소 검색: OpenStreetMap Nominatim.
// Nominatim 규칙: 1초에 1번까지, 글자 칠 때마다 자동 검색 금지(버튼으로만 검색), 출처 표시.
let leafletMap = null;
let mapOpen = sessionStorage.getItem('map') !== '0';
let geocoding = false;
const hasPos = (it) => typeof it.lat === 'number' && typeof it.lng === 'number';

// 국내 여행은 네이버 지도, 해외는 구글 지도 웹사이트로 (앱이 없어도 열림)
function mapLink(trip, it) {
  const q = it.place || (hasPos(it) ? `${it.lat},${it.lng}` : '');
  if (!q) return null;
  if (trip.region === '국내') return { url: `https://m.map.naver.com/search?query=${encodeURIComponent(q)}`, label: '🟢 네이버 지도로 보기 ›' }; // map.naver.com은 폰에서 '앱으로 열기' 페이지로 넘어가므로 모바일 웹 주소
  return { url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`, label: '📍 구글 지도로 보기 ›' };
}

// 이미 위치를 찾은 일정들의 중앙값 (같은 이름의 먼 나라 장소를 거르는 기준). 3곳 이상일 때만.
function tripCenter(trip) {
  const pts = trip.days.flatMap((d) => d.items.filter(hasPos));
  if (pts.length < 3) return null;
  const mid = (arr) => { const a = [...arr].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  return { lat: mid(pts.map((p) => p.lat)), lng: mid(pts.map((p) => p.lng)) };
}
// 그날 이미 위치가 있는 일정들의 중앙 (없으면 여행 전체 기준)
function dayCenter(trip, day) {
  const pts = day.items.filter(hasPos);
  if (!pts.length) return tripCenter(trip);
  const mid = (arr) => { const a = [...arr].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  return { lat: mid(pts.map((p) => p.lat)), lng: mid(pts.map((p) => p.lng)) };
}
function distKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const FAR_KM = 1500;

let lastGeo = 0;
async function geocode(q, limit = 5, near = null) {
  const wait = lastGeo + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeo = Date.now();
  // near가 있으면 그 주변(약 ±4도)을 우선 (제외하지는 않음)
  const bias = near ? `&viewbox=${near.lng - 4},${near.lat + 4},${near.lng + 4},${near.lat - 4}` : '';
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=${limit}&accept-language=ko${bias}&q=${encodeURIComponent(q)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('geocode ' + res.status);
  return (await res.json()).map((r) => ({
    name: r.name || r.display_name.split(',')[0],
    addr: r.display_name,
    lat: Number(r.lat),
    lng: Number(r.lon),
  }));
}

// "세비야 → 그라나다" 같은 도시 칸의 도시들 (검색 정확도 보정용)
const dayCities = (day) => String(day.city || '').split('→').map((x) => x.trim()).filter((x) => x && !/출국|도착|귀국/.test(x));
const firstCity = (day) => dayCities(day)[0] || '';

// 장소 하나의 위치 찾기: 그대로 → (멀거나 없으면) 그날 도시 이름을 붙여서
async function findPlace(trip, day, place) {
  const near = tripCenter(trip);
  const okHit = (h) => h && (!near || distKm(h, near) < FAR_KM);
  const [first] = await geocode(place, 1, dayCenter(trip, day));
  if (okHit(first)) return first;
  for (const city of dayCities(day)) {
    if (place.includes(city)) continue;
    const [h] = await geocode(`${place}, ${city}`, 1, near);
    if (okHit(h)) return h;
  }
  return null;
}

function missingPlaces(trip) {
  const out = [];
  for (const d of trip.days) for (const it of d.items) if (it.place && !hasPos(it) && it.geo !== 'fail') out.push([d, it]);
  return out;
}

// 장소 글자만 있고 위치가 없는 일정들의 위치를 한 번에 찾는다 (1초에 1곳)
async function geocodeAll(trip) {
  if (geocoding) return;
  if (!navigator.onLine) return toast('인터넷 연결이 필요해요');
  const todo = missingPlaces(trip);
  if (!todo.length) return;
  geocoding = true;
  let ok = 0;
  try {
    for (let i = 0; i < todo.length; i++) {
      const [day, it] = todo[i];
      toast(`장소 위치 찾는 중 ${i + 1}/${todo.length}`);
      const hit = await findPlace(trip, day, it.place);
      if (hit) { it.lat = hit.lat; it.lng = hit.lng; delete it.geo; ok++; } else it.geo = 'fail';
      if (i % 5 === 4) save();
    }
  } catch (e) {
    toast('검색이 잠시 막혔어요. 조금 뒤에 다시 해보세요');
  } finally {
    geocoding = false;
    save();
    render();
  }
  const fail = todo.length - ok;
  setTimeout(() => toast(`위치 ${ok}곳 찾음${fail ? ` · ${fail}곳은 일정을 눌러 직접 검색해 주세요` : ''}`), 1900);
}

function mapSection(trip, day) {
  const missing = missingPlaces(trip).length;
  const fix = missing ? `<button class="btn sm" data-act="geocode-all">📍 장소 위치 자동 찾기 (${missing}곳)</button>` : '';
  if (!navigator.onLine) return '<div class="map-note">오프라인이라 지도는 숨겼어요. 일정은 아래에서 볼 수 있어요.</div>';
  if (!day.items.some(hasPos)) return fix ? `<div class="map-note">${fix}</div>` : '';
  return `
    <div class="map-wrap ${mapOpen ? '' : 'closed'}">
      <div id="map"></div>
      <button class="map-toggle" data-act="toggle-map">${mapOpen ? '지도 접기 ▲' : '지도 펼치기 ▼'}</button>
    </div>
    ${fix ? `<div class="map-note">${fix}</div>` : ''}`;
}

// 그날 일정 중 위치가 있는 곳에 번호 핀(타임라인 번호와 같음) + 방문 순서대로 점선
function mountMap(trip, day) {
  const el = $('#map');
  if (!el || !mapOpen || typeof L === 'undefined') return;
  leafletMap = L.map(el, { zoomControl: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(leafletMap);
  const pts = [];
  day.items.forEach((it, i) => {
    if (!hasPos(it)) return;
    const c = ITEM_CATS[it.cat] || ITEM_CATS['기타'];
    const icon = L.divIcon({ className: 'pin', html: `<span style="--cat:${c.color}">${i + 1}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] });
    L.marker([it.lat, it.lng], { icon }).addTo(leafletMap).bindPopup(`<b>${esc(it.title)}</b>${it.time ? '<br>' + esc(it.time) : ''}`);
    pts.push([it.lat, it.lng]);
  });
  if (pts.length > 1) L.polyline(pts, { color: '#FF7A00', weight: 3, opacity: 0.9, dashArray: '6 6' }).addTo(leafletMap);
  if (pts.length === 1) leafletMap.setView(pts[0], 15);
  else leafletMap.fitBounds(pts, { padding: [30, 30], maxZoom: 16 });
}

/* ============ 일정 (여행 상세) ============ */
function renderDays(trip) {
  if (!trip.days.length) return '<div class="empty-state">날짜가 없어요. ✎ 버튼으로 기간을 확인하세요.</div>';
  const t = todayStr();
  if (!selectedDate || !trip.days.some((d) => d.date === selectedDate)) {
    selectedDate = trip.days.some((d) => d.date === t) ? t : trip.days[0].date;
  }
  // 지난 날 = 회색 + ✓, 오늘 = ★, 고른 날 = 주황
  const strip = trip.days.map((d, i) => {
    const dt = parseDate(d.date);
    const past = d.date < t;
    const isToday = d.date === t;
    const cls = ['chip', d.date === selectedDate && 'active', isToday && 'today', past && 'past'].filter(Boolean).join(' ');
    const mark = isToday ? ' ★' : past ? ' ✓' : '';
    return `<button class="${cls}" data-act="pick-day" data-date="${d.date}">
      <span>Day ${i + 1}</span><b>${dt.getMonth() + 1}/${dt.getDate()}</b><span>${WEEK[dt.getDay()]}${mark}</span></button>`;
  }).join('');

  const idx = trip.days.findIndex((d) => d.date === selectedDate);
  const day = trip.days[idx];
  const doneCnt = day.items.filter((i) => i.done).length;
  const costSum = day.items.reduce((sum, i) => sum + (Number(i.cost) || 0), 0);
  const items = day.items.length ? day.items.map((it, i) => timelineItem(trip, it, i)).join('') : '<li class="empty-state">아직 일정이 없어요</li>';

  return `
    <div class="day-strip">${strip}</div>
    ${mapSection(trip, day)}
    <div class="card day-card" id="dayCard">
      <div class="day-head">
        <div class="row day-head-top">
          <span class="muted small">Day ${idx + 1} · ${fmtDate(day.date)}</span>
          <span class="spacer"></span>
          <button class="btn sm" data-act="edit-day">도시 수정</button>
          <button class="btn sm primary" data-act="add-item">+ 장소</button>
        </div>
        <div class="row day-head-city">
          <h2><span class="city">${esc(day.city || '도시 미정')}</span></h2>
          <span class="spacer"></span>
          ${day.items.length ? `<span class="badge">${doneCnt}/${day.items.length} 완료</span>` : ''}
        </div>
        ${costSum ? `<div class="muted small">예상 경비 ${money(costSum, trip.currency)}</div>` : ''}
      </div>
      <ul class="timeline2">${items}</ul>
    </div>
    <button class="add-btn" data-act="add-item">+ 장소 추가</button>
    <p class="muted small" style="text-align:center;margin-top:14px">일정을 누르면 수정, 좌우로 밀면 다른 날로 넘어가요.</p>`;
}

function timelineItem(trip, it, i) {
  const c = ITEM_CATS[it.cat] || ITEM_CATS['기타'];
  const when = [it.time, it.dur].filter(Boolean).join(' · ');
  const cost = Number(it.cost) || 0;
  const link = mapLink(trip, it);
  const foot = (it.place ? `<span class="tl2-place">${hasPos(it) ? '📍' : '◌'} ${esc(it.place)}</span>` : '')
    + (cost ? `<span class="tl2-cost">💰 ${money(cost, trip.currency)}</span>` : '')
    + (link ? `<a class="map-btn" href="${link.url}" target="_blank" rel="noopener" data-act="link">${link.label}</a>` : '');
  return `
    <li class="tl2 ${it.done ? 'done' : ''}" style="--cat:${c.color}">
      <span class="tl2-dot" title="${esc(it.cat)}">${c.icon}<span class="tl2-num">${i + 1}</span></span>
      <div class="tl2-card" data-act="edit-item" data-id="${it.id}">
        <div class="tl2-top">
          <span class="tl2-time">${esc(when || it.cat)}</span><span class="spacer"></span>
          <button class="tl2-check" data-act="toggle-item" data-id="${it.id}" aria-label="완료 표시">${it.done ? '✓' : ''}</button>
        </div>
        <div class="tl2-title">${esc(it.title)}</div>
        ${it.memo ? `<div class="tl-memo">${esc(it.memo)}</div>` : ''}
        ${foot ? `<div class="tl2-foot">${foot}</div>` : ''}
      </div>
    </li>`;
}

// 좌우로 밀거나 화살표로 다음/이전 날로
function stepDay(dir) {
  const trip = detailTrip();
  if (!trip) return;
  const j = trip.days.findIndex((d) => d.date === selectedDate) + dir;
  if (j < 0 || j >= trip.days.length) return;
  selectedDate = trip.days[j].date;
  render();
  const card = $('#dayCard');
  if (card) card.classList.add(dir > 0 ? 'slide-l' : 'slide-r');
}

function currentDay() {
  const trip = detailTrip();
  return trip && trip.days.find((d) => d.date === selectedDate);
}

function placeItem(day, item) {
  // HH:MM 시간이 있으면 시간 순서에 맞는 위치에 넣는다. 그 외에는 원래 위치/맨 뒤.
  const oldIdx = day.items.indexOf(item);
  if (!isHHMM(item.time)) { if (oldIdx < 0) day.items.push(item); return; }
  if (oldIdx >= 0) day.items.splice(oldIdx, 1);
  const j = day.items.findIndex((x) => isHHMM(x.time) && hhmm(x.time) > hhmm(item.time));
  if (j < 0) day.items.push(item); else day.items.splice(j, 0, item);
}

function itemForm(item) {
  const trip = detailTrip();
  const curDay = currentDay();
  const isNew = !item;
  item = item || { id: uid(), time: '', dur: '', title: '', place: '', memo: '', cat: '관광', cost: '', done: false };
  const dayChips = trip.days.map((d, i) => {
    const dt = parseDate(d.date);
    return `<label class="pick-chip"><input type="radio" name="date" value="${d.date}" ${d.date === curDay.date ? 'checked' : ''}>
      <span>Day ${i + 1}<br><b>${dt.getMonth() + 1}/${dt.getDate()}</b></span></label>`;
  }).join('');
  const catChips = Object.entries(ITEM_CATS).map(([k, c]) =>
    `<label class="pick-chip cat"><input type="radio" name="cat" value="${k}" ${k === item.cat ? 'checked' : ''}><span>${c.icon} ${k}</span></label>`).join('');
  openModal({
    title: isNew ? '장소 추가' : '일정 수정',
    html: `
      <div class="field"><span>날짜</span><div class="pick-scroll">${dayChips}</div></div>
      <div class="field"><span>🔍 장소 검색</span>
        <div class="search-row">
          <input name="place" value="${esc(item.place)}" placeholder="예: Sagrada Família" autocomplete="off">
          <button type="button" class="btn search-btn" id="placeSearchBtn">검색</button>
          <span class="search-sep" aria-hidden="true"></span>
          <a class="map-find" id="mapFindBtn" target="_blank" rel="noopener"></a>
        </div>
        <input type="hidden" name="lat" value="${hasPos(item) ? item.lat : ''}">
        <input type="hidden" name="lng" value="${hasPos(item) ? item.lng : ''}">
        <div id="placeStatus" class="small muted place-status">${hasPos(item) ? '📍 위치 저장됨 (지도에 표시돼요)' : '검색해서 후보를 고르면 지도에 표시돼요'}</div>
        <div id="placeResults"></div>
      </div>
      ${fieldHtml({ name: 'title', label: '이름 / 할 일', value: item.title, required: true, placeholder: '예: 사그라다 파밀리아 관람' })}
      <div class="field"><span>⏰ 방문 시간</span>
        <div class="time-pick">
          <div class="wheel-box" id="wheelBox">
            <div class="wheel" id="wheelH"></div><b class="wheel-colon">:</b><div class="wheel" id="wheelM"></div>
          </div>
          <label class="pick-chip unset"><input type="checkbox" id="timeUnset"><span>시간<br>미정</span></label>
        </div>
        <input type="hidden" name="time" value="${esc(item.time)}">
      </div>
      <div class="field"><span>소요 시간</span>
        <div class="pick-wrap" id="durChips">${DUR_PRESETS.map((v) => `<button type="button" class="dur-chip ${v === item.dur ? 'on' : ''}">${v}</button>`).join('')}</div>
        <input name="dur" class="dur-input" value="${esc(item.dur)}" placeholder="직접 입력 (예: 40분)">
      </div>
      ${fieldHtml({ name: 'memo', label: '✏️ 메모 / 할 일', type: 'textarea', value: item.memo })}
      <div class="field"><span>분류</span><div class="pick-wrap">${catChips}</div></div>
      ${fieldHtml({ name: 'cost', label: `💰 예상 경비 (${trip.currency})`, type: 'number', value: item.cost })}`,
    onSave: (d) => {
      const cost = parseFloat(d.cost);
      Object.assign(item, {
        time: d.time, dur: d.dur, title: d.title, place: d.place, memo: d.memo,
        cat: d.cat || '기타', cost: cost > 0 ? cost : '',
      });
      if (d.lat !== '' && d.lng !== '') { item.lat = Number(d.lat); item.lng = Number(d.lng); delete item.geo; }
      else { delete item.lat; delete item.lng; delete item.geo; }
      const target = trip.days.find((x) => x.date === d.date) || curDay;
      if (target !== curDay) {
        curDay.items = curDay.items.filter((x) => x !== item);
        selectedDate = target.date;
        toast(`${fmtDate(target.date)}로 옮겼어요`);
      }
      placeItem(target, item);
    },
    onDelete: isNew ? null : () => { curDay.items = curDay.items.filter((x) => x !== item); },
  });
  const checked = $('#modalBody input[name=date]:checked');
  if (checked) checked.parentElement.scrollIntoView({ inline: 'center', block: 'nearest' });
  wirePlaceSearch(trip, curDay);
  wireTimeWheel(item, curDay, isNew);
}

/* ---------- 시간 휠 (00~23시 · 5분 단위) + 시간 미정 ---------- */
const DUR_PRESETS = ['30분', '1시간', '1시간 30분', '2시간', '3시간', '반나절'];
const WHEEL_ROW = 44; // 휠 한 칸 높이(px) — styles.css .wheel div 와 같게
const VAGUE_TIME = { 새벽: '06:00', 아침: '08:00', 오전: '09:00', 점심: '12:00', 오후: '14:00', 저녁: '19:00', 밤: '21:00' };

function wireTimeWheel(item, day, isNew) {
  const form = $('#modalForm');
  const hidden = form.time;
  const original = item.time || '';
  const hEl = $('#wheelH');
  const mEl = $('#wheelM');
  const unset = $('#timeUnset');
  const pad = (n) => String(n).padStart(2, '0');
  const fill = (el, values) => {
    el.innerHTML = '<i class="sp"></i>' + values.map((v) => `<div>${pad(v)}</div>`).join('') + '<i class="sp"></i>';
  };
  fill(hEl, [...Array(24).keys()]);
  fill(mEl, [...Array(12).keys()].map((i) => i * 5));

  // 처음 위치: 정확한 시간이면 그대로(분은 5분 단위로 반올림), "오전" 같은 말이면 대략, 새 일정이면 직전 일정 + 1시간
  let start = isHHMM(original) ? original : VAGUE_TIME[original.trim()];
  if (!start) {
    const prev = [...day.items].reverse().find((x) => isHHMM(x.time));
    start = prev ? `${pad(Math.min(23, Number(prev.time.split(':')[0]) + 1))}:${prev.time.split(':')[1]}` : '09:00';
  }
  let [h, m] = start.split(':').map(Number);
  m = Math.round(m / 5) * 5;
  if (m === 60) { m = 0; h = Math.min(23, h + 1); }

  let touched = false; // 사용자가 휠·미정을 건드리지 않으면 원래 값(예: "오전")을 그대로 둔다
  const read = (el) => Math.max(0, Math.round(el.scrollTop / WHEEL_ROW));
  const mark = (el) => { const i = read(el); el.querySelectorAll('div').forEach((d, k) => d.classList.toggle('sel', k === i)); };
  const sync = () => {
    mark(hEl); mark(mEl);
    if (!touched) return;
    hidden.value = unset.checked ? '' : `${pad(Math.min(23, read(hEl)))}:${pad(Math.min(11, read(mEl)) * 5)}`;
  };
  // 휠은 레이아웃이 잡힌 뒤에 위치를 정해야 한다 (requestAnimationFrame은 화면이 가려지면 멈추므로 setTimeout)
  setTimeout(() => {
    hEl.scrollTop = h * WHEEL_ROW;
    mEl.scrollTop = (m / 5) * WHEEL_ROW;
    mark(hEl); mark(mEl);
    setTimeout(() => {
      for (const el of [hEl, mEl]) {
        let t;
        el.addEventListener('scroll', () => { touched = true; mark(el); clearTimeout(t); t = setTimeout(sync, 90); });
        // 칸을 눌러도 그 시간으로
        el.addEventListener('click', (e) => {
          const row = e.target.closest('.wheel div');
          if (!row) return;
          const i = [...el.querySelectorAll('div')].indexOf(row);
          el.scrollTop = i * WHEEL_ROW; // 즉시 이동 (애니메이션이 멈춘 환경에서도 동작)
          touched = true;
          sync();
        });
      }
    }, 150);
  }, 0);
  const applyUnset = () => { $('#wheelBox').classList.toggle('off', unset.checked); };
  unset.onchange = () => { touched = true; applyUnset(); sync(); };
  // 새 일정: 휠 시간으로 바로 시작. 시간이 비어 있던 기존 일정: '미정'으로 열기 (몰래 시간을 넣지 않음)
  if (isNew) { touched = true; setTimeout(sync, 200); }
  else if (!original) unset.checked = true;
  applyUnset();

  // 소요 시간: 버튼으로 빠르게, 아니면 직접 입력
  const durInput = form.dur;
  document.querySelectorAll('#durChips .dur-chip').forEach((b) => {
    b.onclick = () => {
      const on = !b.classList.contains('on');
      document.querySelectorAll('#durChips .dur-chip').forEach((x) => x.classList.remove('on'));
      b.classList.toggle('on', on);
      durInput.value = on ? b.textContent : '';
    };
  });
  durInput.addEventListener('input', () => {
    document.querySelectorAll('#durChips .dur-chip').forEach((x) => x.classList.toggle('on', x.textContent === durInput.value.trim()));
  });
}

// 구글 지도 '긴 주소'에서 위치 꺼내기 (짧은 공유 링크는 웹앱에서 열어볼 수 없음)
function posFromMapUrl(text) {
  const m = text.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || text.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/)
    || text.match(/[?&](?:q|query|ll|center)=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/i);
  if (!m) return null;
  const name = (text.match(/\/place\/([^/@?]+)/) || [])[1];
  return { lat: Number(m[1]), lng: Number(m[2]), name: name ? decodeURIComponent(name.replace(/\+/g, ' ')) : '' };
}

function wirePlaceSearch(trip, day) {
  const form = $('#modalForm');
  const input = form.place;
  const status = $('#placeStatus');
  const results = $('#placeResults');
  const setPos = (lat, lng) => { form.lat.value = lat; form.lng.value = lng; };

  // 지도 사이트에서 찾아보기 (국내 = 네이버, 해외 = 구글). 입력이 비어 있으면 그날 도시 지도
  const findBtn = $('#mapFindBtn');
  const updateFind = () => {
    const q = input.value.trim() || firstCity(day) || trip.places.split('·')[0].trim() || trip.title;
    const link = mapLink(trip, { place: q });
    findBtn.href = link.url;
    findBtn.textContent = trip.region === '국내' ? '🗺 네이버' : '🗺 구글';
    findBtn.title = (trip.region === '국내' ? '네이버' : '구글') + ' 지도 사이트에서 찾아보기';
    findBtn.classList.toggle('naver', trip.region === '국내');
  };
  updateFind();
  input.addEventListener('input', updateFind);

  const search = async () => {
    const q = input.value.trim();
    if (!q) return;
    if (/maps\.app\.goo\.gl|goo\.gl\/maps|naver\.me\//i.test(q)) {
      status.textContent = '짧은 공유 링크는 열어볼 수 없어요. 지도에서 장소 이름을 복사해 붙여넣어 주세요.';
      return;
    }
    const fromUrl = /^https?:\/\//i.test(q) && posFromMapUrl(q);
    if (fromUrl) {
      setPos(fromUrl.lat, fromUrl.lng);
      input.value = fromUrl.name || `${fromUrl.lat.toFixed(5)}, ${fromUrl.lng.toFixed(5)}`;
      if (!form.title.value.trim() && fromUrl.name) form.title.value = fromUrl.name;
      status.textContent = '📍 지도 주소에서 위치를 가져왔어요';
      results.innerHTML = '';
      updateFind();
      return;
    }
    if (!navigator.onLine) { status.textContent = '인터넷 연결이 필요해요'; return; }
    status.textContent = '검색 중…';
    results.innerHTML = '';
    try {
      const near = dayCenter(detailTrip(), day);
      let hits = await geocode(q, 5, near);
      if (!hits.length && firstCity(day) && !q.includes(firstCity(day))) hits = await geocode(`${q}, ${firstCity(day)}`, 5, near);
      if (near) hits.sort((a, b) => distKm(a, near) - distKm(b, near)); // 여행 지역에 가까운 후보부터
      status.textContent = hits.length ? '맞는 곳을 고르세요'
        : `찾지 못했어요. 옆의 [${findBtn.textContent}] 지도에서 찾은 뒤 이름을 복사해 붙여넣어 보세요`;
      findBtn.classList.toggle('hint', !hits.length);
      results.innerHTML = hits.map((h, i) => `
        <button type="button" class="place-hit" data-i="${i}"><b>${esc(h.name)}</b><span class="muted small">${esc(h.addr)}</span></button>`).join('');
      results.querySelectorAll('.place-hit').forEach((b) => {
        b.onclick = () => {
          const h = hits[Number(b.dataset.i)];
          input.value = h.name;
          setPos(h.lat, h.lng);
          if (!form.title.value.trim()) form.title.value = h.name;
          status.textContent = `📍 ${h.addr}`;
          results.innerHTML = '';
        };
      });
    } catch (e) {
      status.textContent = '검색이 잠시 막혔어요. 조금 뒤에 다시 해보세요';
    }
  };
  $('#placeSearchBtn').onclick = search;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
  input.addEventListener('input', () => { setPos('', ''); status.textContent = '검색해서 후보를 고르면 지도에 표시돼요'; });
}

/* ============ 체크리스트 ============ */
const GROUP_ORDER = ['지금 바로', '3~4개월 전', '1개월 전', '1주 전', '전날', '짐 싸기'];

function groupsInUse(trip) {
  const extra = [...new Set(trip.checklist.map((c) => c.group))].filter((g) => !GROUP_ORDER.includes(g));
  return [...GROUP_ORDER, ...extra];
}

function isOverdue(trip, c) {
  if (c.done || c.due == null) return false;
  return diffDays(trip.start, todayStr()) < c.due;
}

function renderCheck(trip) {
  const all = trip.checklist;
  const done = all.filter((c) => c.done).length;
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;
  const overdue = all.filter((c) => isOverdue(trip, c)).length;

  const groups = groupsInUse(trip).map((g) => {
    let list = all.filter((c) => c.group === g);
    if (!list.length) return '';
    const gDone = list.filter((c) => c.done).length;
    if (checkFilter === 'todo') list = list.filter((c) => !c.done);
    const rows = list.map((c) => `
      <li class="${c.done ? 'done' : ''}">
        <input type="checkbox" id="c-${c.id}" data-act="toggle-check" data-id="${c.id}" ${c.done ? 'checked' : ''}>
        <label for="c-${c.id}">${esc(c.text)}${isOverdue(trip, c) ? '<span class="overdue">기한 지남</span>' : ''}</label>
        <button class="more-btn" data-act="edit-check" data-id="${c.id}" aria-label="수정">⋯</button>
      </li>`).join('');
    return `
      <div class="section-title"><h3>${esc(g)}</h3><span class="muted small">${gDone}/${all.filter((c) => c.group === g).length}</span></div>
      <div class="card" style="padding:4px 14px">${rows ? `<ul class="check-list">${rows}</ul>` : '<div class="empty-state">모두 완료!</div>'}</div>`;
  }).join('');

  return `
    <div class="card">
      <div class="row" style="justify-content:space-between;margin-bottom:8px">
        <b>준비 진행률</b><span class="num">${done}/${all.length} · ${pct}%</span>
      </div>
      <div class="progress"><i style="width:${pct}%"></i></div>
      ${overdue ? `<p class="small" style="color:var(--danger);margin:8px 0 0">권장 기한이 지난 항목 ${overdue}개</p>` : ''}
    </div>
    <div class="filter-row">
      <button class="seg ${checkFilter === 'all' ? 'active' : ''}" data-act="filter" data-v="all">전체</button>
      <button class="seg ${checkFilter === 'todo' ? 'active' : ''}" data-act="filter" data-v="todo">남은 것만</button>
    </div>
    ${groups}
    <button class="add-btn" data-act="add-check" style="margin-top:8px">+ 항목 추가</button>`;
}

function checkForm(trip, c) {
  const isNew = !c;
  c = c || { id: uid(), group: GROUP_ORDER[0], text: '', due: null, done: false };
  openModal({
    title: isNew ? '항목 추가' : '항목 수정',
    fields: [
      { name: 'text', label: '내용', value: c.text, required: true },
      { name: 'group', label: '시기 (직접 입력 가능)', value: c.group, list: groupsInUse(trip), required: true },
    ],
    onSave: (d) => { c.text = d.text; c.group = d.group; if (isNew) trip.checklist.push(c); },
    onDelete: isNew ? null : () => { trip.checklist = trip.checklist.filter((x) => x !== c); },
  });
}

/* ============ 예산 ============ */
const CATS = ['항공', '숙소', '교통', '식비', '관광', '쇼핑', '기타'];
const toKRW = (trip, e) => (e.currency === 'KRW' ? e.amount : e.amount * trip.budget.rate);

function renderBudget(trip) {
  const { plan, rate } = trip.budget;
  const cur = trip.currency;
  const planTotal = CATS.reduce((s, k) => s + (Number(plan[k]) || 0), 0);
  const spent = trip.expenses.reduce((s, e) => s + toKRW(trip, e), 0);
  const today = todayStr();
  const todaySpent = trip.expenses.filter((e) => e.date === today).reduce((s, e) => s + toKRW(trip, e), 0);
  const left = planTotal - spent;
  const planned = trip.days.reduce((sum, d) => sum + d.items.reduce((a, i) => a + (Number(i.cost) || 0), 0), 0);

  const cats = CATS.map((k) => {
    const p = Number(plan[k]) || 0;
    const s = trip.expenses.filter((e) => e.cat === k).reduce((a, e) => a + toKRW(trip, e), 0);
    if (!p && !s) return '';
    const pct = p ? Math.min(100, (s / p) * 100) : 100;
    return `<div class="cat-row">
      <div class="row"><span>${k}</span><span class="num muted">${won(s)} / ${p ? won(p) : '예산 없음'}</span></div>
      <div class="progress ${p && s > p ? 'over' : ''}"><i style="width:${pct}%"></i></div>
    </div>`;
  }).join('');

  const exps = [...trip.expenses].sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.id.localeCompare(a.id));
  const expHtml = exps.length ? exps.map((e) => `
    <div class="exp-item" data-act="edit-exp" data-id="${e.id}">
      <span class="cat">${esc(e.cat)}</span>
      <span class="memo">${esc(e.memo || '-')}<br><span class="muted small">${fmtDate(e.date)}</span></span>
      <span class="amt num">${money(e.amount, e.currency)}
        ${e.currency !== 'KRW' ? `<small>≈ ${won(toKRW(trip, e))}</small>` : ''}</span>
    </div>`).join('') : '<div class="empty-state">아직 지출 기록이 없어요</div>';

  return `
    <div class="card">
      <div class="stat-grid">
        <div class="stat"><div class="label">총 예산</div><div class="value">${won(planTotal)}</div></div>
        <div class="stat"><div class="label">사용</div><div class="value">${won(spent)}</div></div>
        <div class="stat"><div class="label">남은 예산</div><div class="value" style="color:${left < 0 ? 'var(--danger)' : 'inherit'}">${won(left)}</div></div>
        <div class="stat"><div class="label">오늘 지출</div><div class="value">${won(todaySpent)}</div></div>
      </div>
      ${planned ? `<div class="row small" style="margin-top:10px"><span class="muted">일정에 적은 예상 경비</span><span class="spacer"></span><b class="num">${money(planned, cur)}${cur !== 'KRW' ? ` ≈ ${won(planned * rate)}` : ''}</b></div>` : ''}
      <div class="row" style="margin-top:10px">
        <span class="muted small">${cur === 'KRW' ? '원화 여행' : `환율 ${money(1, cur)} = ${rate.toLocaleString('ko-KR')}원`}</span>
        <span class="spacer"></span>
        <button class="btn sm" data-act="edit-plan">예산${cur === 'KRW' ? '' : '·환율'} 설정</button>
      </div>
    </div>
    ${cats ? `<div class="section-title"><h3>항목별</h3></div><div class="card">${cats}</div>` : ''}
    <button class="add-btn" data-act="add-exp">+ 지출 기록</button>
    <div class="section-title"><h3>지출 내역</h3><span class="muted small">${exps.length}건</span></div>
    <div class="card" style="padding:4px 14px">${expHtml}</div>`;
}

function expForm(trip, e) {
  const isNew = !e;
  e = e || { id: uid(), date: todayStr(), cat: '식비', amount: '', currency: trip.currency, memo: '' };
  const curOptions = [...new Set([trip.currency, 'KRW', e.currency])];
  const amountRow = [
    { name: 'amount', label: '금액', type: 'number', value: e.amount, required: true },
    { name: 'currency', label: '통화', type: 'select', options: curOptions, value: e.currency },
  ].map(fieldHtml).join('');
  openModal({
    title: isNew ? '지출 기록' : '지출 수정',
    html: `<div class="field-row">${amountRow}</div>`,
    fields: [
      { name: 'cat', label: '분류', type: 'select', options: CATS, value: e.cat },
      { name: 'memo', label: '내용', value: e.memo, placeholder: '예: 타파스 저녁' },
      { name: 'date', label: '날짜', type: 'date', value: e.date },
    ],
    onSave: (d) => {
      const amt = parseFloat(d.amount.replace(/,/g, ''));
      if (!(amt > 0)) { toast('금액을 입력하세요'); return false; }
      Object.assign(e, d, { amount: amt });
      if (isNew) trip.expenses.push(e);
      toast('기록했어요');
    },
    onDelete: isNew ? null : () => { trip.expenses = trip.expenses.filter((x) => x !== e); },
  });
}

function planForm(trip) {
  const { plan, rate } = trip.budget;
  const foreign = trip.currency !== 'KRW';
  openModal({
    title: foreign ? '예산·환율 설정 (원 단위)' : '예산 설정 (원 단위)',
    fields: [
      ...(foreign ? [{ name: 'rate', label: `환율: 1 ${trip.currency} = ?원`, type: 'number', value: rate, required: true }] : []),
      ...CATS.map((k) => ({ name: 'p_' + k, label: k + ' 예산', type: 'number', value: plan[k] || '' })),
    ],
    onSave: (d) => {
      if (foreign) {
        const r = parseFloat(d.rate);
        if (!(r > 0)) { toast('환율을 확인하세요'); return false; }
        trip.budget.rate = r;
      }
      CATS.forEach((k) => { trip.budget.plan[k] = parseFloat(d['p_' + k]) || 0; });
    },
  });
}

/* ============ 예약·서류 ============ */
const BOOK_TYPES = { 항공: '✈️', 숙소: '🏨', 교통: '🚆', 관광: '🎟️', 식당: '🍽️', 보험: '🛡️', 기타: '📄' };

function renderBook(trip) {
  const list = [...trip.bookings].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
  const missing = list.filter((b) => !b.code).length;
  const rows = list.map((b) => `
    <div class="book-item" data-act="edit-book" data-id="${b.id}">
      <div class="book-type">${BOOK_TYPES[b.type] || '📄'}</div>
      <div class="book-main">
        <div class="row"><b>${esc(b.title)}</b><span class="spacer"></span><span class="muted small">${b.date ? fmtDate(b.date) : ''}</span></div>
        <div class="${b.code ? 'book-code' : 'book-code empty'}">${b.code ? esc(b.code) : '예약번호 미입력'}</div>
        ${b.memo ? `<div class="muted small" style="white-space:pre-wrap">${esc(b.memo)}</div>` : ''}
        ${b.link ? `<a class="small" href="${esc(b.link)}" target="_blank" rel="noopener" data-act="link">🔗 예약 페이지</a>` : ''}
      </div>
    </div>`).join('');

  const contacts = trip.contacts.map((c) => `
    <div class="contact">
      <div style="flex:1;min-width:0" data-act="edit-contact" data-id="${c.id}">
        <b>${esc(c.name)}</b><div class="muted small">${esc(c.phone)}${c.memo ? ' · ' + esc(c.memo) : ''}</div>
      </div>
      <a class="call-btn" href="tel:${esc(c.phone.replace(/[^+\d]/g, ''))}">전화</a>
    </div>`).join('');

  return `
    ${missing ? `<div class="notice">아직 예약번호를 입력하지 않은 항목이 ${missing}개 있어요. 예약하면 바로 입력해 두세요.</div>` : ''}
    <div class="card" style="padding:4px 14px">${rows || '<div class="empty-state">예약이 없어요</div>'}</div>
    <button class="add-btn" data-act="add-book">+ 예약 추가</button>
    <div class="section-title"><h3>긴급 연락처</h3></div>
    <div class="card" style="padding:4px 14px">${contacts || '<div class="empty-state">연락처가 없어요</div>'}</div>
    <button class="add-btn" data-act="add-contact">+ 연락처 추가</button>`;
}

function bookForm(trip, b) {
  const isNew = !b;
  b = b || { id: uid(), type: '숙소', title: '', date: '', code: '', memo: '', link: '' };
  openModal({
    title: isNew ? '예약 추가' : '예약 수정',
    fields: [
      { name: 'type', label: '종류', type: 'select', options: Object.keys(BOOK_TYPES), value: b.type },
      { name: 'title', label: '이름', value: b.title, required: true },
      { name: 'date', label: '날짜', type: 'date', value: b.date },
      { name: 'code', label: '예약번호', value: b.code },
      { name: 'link', label: '예약 페이지 링크', type: 'url', value: b.link, placeholder: 'https://' },
      { name: 'memo', label: '메모 (주소, 체크인 시간, 좌석 등)', type: 'textarea', value: b.memo },
    ],
    onSave: (d) => { Object.assign(b, d); if (isNew) trip.bookings.push(b); },
    onDelete: isNew ? null : () => { trip.bookings = trip.bookings.filter((x) => x !== b); },
  });
}

function contactForm(trip, c) {
  const isNew = !c;
  c = c || { id: uid(), name: '', phone: '', memo: '' };
  openModal({
    title: isNew ? '연락처 추가' : '연락처 수정',
    fields: [
      { name: 'name', label: '이름', value: c.name, required: true },
      { name: 'phone', label: '전화번호 (국가번호 포함)', type: 'tel', value: c.phone, required: true },
      { name: 'memo', label: '메모', value: c.memo },
    ],
    onSave: (d) => { Object.assign(c, d); if (isNew) trip.contacts.push(c); },
    onDelete: isNew ? null : () => { trip.contacts = trip.contacts.filter((x) => x !== c); },
  });
}

/* ============ 설정 · 백업 ============ */
function renderSettings() {
  return `
    <div class="section-title"><h3>백업</h3></div>
    <div class="card">
      <p class="small muted" style="margin-top:0">데이터는 이 폰 안에만 저장돼요. 폰을 바꾸거나 브라우저 데이터를 지우면 사라지니 가끔 내보내기로 백업하세요. 백업에는 모든 여행이 들어갑니다.</p>
      <div class="row" style="flex-wrap:wrap">
        <button type="button" class="btn" data-act="export">⬇ 내보내기 (백업)</button>
        <label class="btn" style="display:inline-block">⬆ 가져오기 <input type="file" id="importInput" accept="application/json,.json" hidden></label>
      </div>
    </div>
    <div class="section-title"><h3>데이터</h3></div>
    <div class="card">
      <p class="small muted" style="margin-top:0">모든 여행을 지우고 처음 상태(스페인 여행 초안)로 돌아갑니다.</p>
      <button type="button" class="btn danger" data-act="reset" style="padding-left:0">처음 상태로 초기화</button>
    </div>
    <p class="muted small" style="text-align:center">MasterTrip Planner</p>`;
}

function resetAll() {
  if (!confirm('모든 여행과 수정 내용이 지워지고 처음 상태(스페인 여행 초안)로 돌아갑니다. 계속할까요?')) return;
  state = migrate(seedData()); pickTrip(null); openTripId = null; save(); render(); toast('초기화했어요'); // migrate: 분류 등 기본값 채우기
  clearCovers().then(render);
}

async function exportData() {
  // 백업 파일에는 표지 사진도 함께 넣는다 (dataURL)
  const covers = {};
  try {
    const [keys, vals] = await Promise.all([media.keys(), media.values()]);
    for (let i = 0; i < keys.length; i++) covers[keys[i]] = await blobToDataUrl(vals[i]);
  } catch (e) { console.warn(e); }
  const blob = new Blob([JSON.stringify({ ...state, covers }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mastertrip-backup-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('백업 파일을 저장했어요');
}

function importData(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const valid = Array.isArray(data.trips) || (data.trip && Array.isArray(data.days));
      if (!valid) throw new Error('형식 오류');
      if (!confirm('현재 데이터를 백업 파일 내용으로 바꿀까요?')) return;
      const covers = data.covers || {};
      delete data.covers;
      state = migrate(data); pickTrip(null); openTripId = null; save(); render(); toast('가져오기 완료');
      clearCovers()
        .then(() => Promise.all(Object.entries(covers).map(([id, url]) => fetch(url).then((r) => r.blob()).then((b) => setCover(id, b)))))
        .then(render);
    } catch (e) {
      toast('올바른 백업 파일이 아니에요');
    }
  };
  reader.readAsText(file);
}

/* ============ 이벤트 위임 ============ */
$('#backBtn').addEventListener('click', closeTrip);
$('#tripEditBtn').addEventListener('click', () => { const t = detailTrip(); if (t) tripForm(t); });
$('#searchBtn').addEventListener('click', () => {
  searchOpen = true;
  mainTab = 'trips'; remember('main', mainTab);
  setSub('trips');
  const input = $('#searchInput');
  if (input) input.focus();
});

$('#view').addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const id = el.dataset.id;
  if (act === 'link') return; // 링크는 기본 동작
  const day = currentDay();
  const ft = focusTrip();

  switch (act) {
    case 'new-trip': tripForm(null); break;
    case 'switch-trip': tripPicker(); break;
    case 'toggle-map': mapOpen = !mapOpen; remember('map', mapOpen ? '1' : '0'); render(); break;
    case 'geocode-all': geocodeAll(detailTrip()); break;
    case 'search-close': searchOpen = false; searchQuery = ''; render(); break;
    case 'goto-sub': pickTrip(id); mainTab = 'trips'; remember('main', mainTab); setSub(el.dataset.v); window.scrollTo(0, 0); break;
    case 'export': exportData(); break;
    case 'reset': resetAll(); break;
    case 'open-trip': openTrip(id); break;
    case 'trip-filter': tripFilter[el.dataset.v] = !tripFilter[el.dataset.v]; render(); break;
    case 'pick-day': selectedDate = el.dataset.date; render(); break;
    case 'toggle-item': { const it = day.items.find((x) => x.id === id); it.done = !it.done; save(); render(); break; }
    case 'edit-item': itemForm(day.items.find((x) => x.id === id)); break;
    case 'add-item': itemForm(null); break;
    case 'edit-day':
      openModal({
        title: `${fmtDate(day.date)} 도시`,
        fields: [{ name: 'city', label: '도시 / 이동', value: day.city, required: true }],
        onSave: (d) => { day.city = d.city; },
      });
      break;
    case 'filter': checkFilter = el.dataset.v; render(); break;
    case 'edit-check': checkForm(ft, ft.checklist.find((x) => x.id === id)); break;
    case 'add-check': checkForm(ft, null); break;
    case 'edit-plan': planForm(ft); break;
    case 'add-exp': expForm(ft, null); break;
    case 'edit-exp': expForm(ft, ft.expenses.find((x) => x.id === id)); break;
    case 'add-book': bookForm(ft, null); break;
    case 'edit-book': bookForm(ft, ft.bookings.find((x) => x.id === id)); break;
    case 'add-contact': contactForm(ft, null); break;
    case 'edit-contact': contactForm(ft, ft.contacts.find((x) => x.id === id)); break;
  }
});

$('#view').addEventListener('input', (ev) => {
  if (ev.target.id !== 'searchInput') return;
  searchQuery = ev.target.value;
  $('#tripList').innerHTML = tripListHtml(); // 목록만 다시 그려서 입력창 포커스를 유지
});

$('#view').addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.id === 'importInput') return importData(ev);
  if (el.dataset.act !== 'toggle-check') return;
  const c = focusTrip().checklist.find((x) => x.id === el.dataset.id);
  c.done = el.checked;
  save();
  render();
});

let touchStart = null;
$('#view').addEventListener('touchstart', (ev) => {
  if (!inDetail() || !ev.target.closest('#dayCard')) return;
  const p = ev.touches[0];
  touchStart = { x: p.clientX, y: p.clientY };
}, { passive: true });
$('#view').addEventListener('touchend', (ev) => {
  if (!touchStart) return;
  const p = ev.changedTouches[0];
  const dx = p.clientX - touchStart.x;
  const dy = p.clientY - touchStart.y;
  touchStart = null;
  if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.6) return; // 세로 스크롤은 무시
  stepDay(dx < 0 ? 1 : -1);
}, { passive: true });

// 인터넷이 끊기거나 다시 연결되면 지도 표시를 바꾼다
window.addEventListener('online', () => { if (inDetail()) render(); });
window.addEventListener('offline', () => { if (inDetail()) render(); });

// 자정이 지나면 오늘 날짜/D-day 갱신
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

render();
loadCovers().then(render);

/* ============ 오프라인 (Service Worker) ============ */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW 등록 실패', e));
}
