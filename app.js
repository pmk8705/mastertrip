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
  return seedData();
}

function normalizeTrip(t) {
  t.emoji = t.emoji || '✈️';
  t.places = t.places || '';
  t.region = t.region || '해외';
  t.currency = t.currency || (t.region === '국내' ? 'KRW' : 'EUR');
  for (const k of ['days', 'checklist', 'expenses', 'bookings', 'contacts']) if (!Array.isArray(t[k])) t[k] = [];
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
function fmtDate(s, withYear = false) {
  if (!s) return '';
  const d = parseDate(s);
  return `${withYear ? d.getFullYear() + '. ' : ''}${d.getMonth() + 1}/${d.getDate()} (${WEEK[d.getDay()]})`;
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
function mapUrl(place) { return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(place); }
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
const TABS = ['trips', 'check', 'budget', 'book'];
let tab = sessionStorage.getItem('tab');
if (!TABS.includes(tab)) tab = 'trips';
let pickedTripId = sessionStorage.getItem('trip') || null;
let openTripId = (history.state && history.state.trip) || null; // 여행 상세 화면에 들어가 있으면 그 여행 id
let tripFilter = { now: true, soon: true, past: false };
let selectedDate = null;
let checkFilter = 'all';

function remember(key, val) {
  try { if (val == null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, val); } catch (e) {}
}

function setTab(next) {
  tab = next;
  remember('tab', tab);
  render();
  window.scrollTo(0, 0);
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
  setTab('trips');
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
    if (btn.dataset.tab === 'trips' && tab === 'trips' && openTripId) return closeTrip();
    setTab(btn.dataset.tab);
  });
});

function render() {
  if (openTripId && !detailTrip()) openTripId = null;
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  renderHeader();
  const view = $('#view');
  if (tab === 'trips') view.innerHTML = detailTrip() ? renderDays(detailTrip()) : renderHome();
  else {
    const t = focusTrip();
    if (!t) view.innerHTML = renderNoTrip();
    else if (tab === 'check') view.innerHTML = renderCheck(t);
    else if (tab === 'budget') view.innerHTML = renderBudget(t);
    else view.innerHTML = renderBook(t);
  }
  if (tab === 'trips' && detailTrip()) {
    const active = $('.chip.active');
    if (active) active.scrollIntoView({ inline: 'center', block: 'nearest' });
  }
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

function renderHeader() {
  const inDetail = tab === 'trips' && detailTrip();
  $('#backBtn').hidden = !inDetail;
  $('#tripEditBtn').hidden = !inDetail;
  const h1 = $('#tripTitle');
  const sub = $('#tripSub');

  if (tab === 'trips' && !inDetail) {
    h1.textContent = '내 여행';
    const next = autoTrip();
    sub.textContent = state.trips.length
      ? `여행 ${state.trips.length}개${next && phaseOf(next) !== 'past' ? ` · ${next.title} ${phaseOf(next) === 'now' ? '여행 중' : 'D-' + diffDays(next.start, todayStr())}` : ''}`
      : '첫 여행을 만들어 보세요';
    document.title = 'MasterTrip Planner';
    return;
  }

  const t = inDetail ? detailTrip() : focusTrip();
  if (!t) { h1.textContent = '여행 없음'; sub.textContent = ''; return; }
  if (inDetail) h1.textContent = `${t.emoji} ${t.title}`;
  else h1.innerHTML = `<button class="trip-switch" id="tripSwitch" aria-label="여행 바꾸기">${esc(t.emoji)} ${esc(t.title)} <span class="caret">▾</span></button>`;
  sub.textContent = tripSub(t);
  document.title = `${t.title} · MasterTrip`;
}

/* ============ 홈: 내 여행 ============ */
const PHASE_LABEL = { now: '현재 여행', soon: '다가오는 여행', past: '지난 여행' };

function tripBadge(t) {
  const p = phaseOf(t);
  if (p === 'now') return '<span class="badge now">여행 중</span>';
  if (p === 'soon') {
    const d = diffDays(t.start, todayStr());
    return `<span class="badge soon">D-${d}</span>`;
  }
  return '<span class="badge past">지난 여행</span>';
}

function renderHome() {
  const counts = { now: 0, soon: 0, past: 0 };
  state.trips.forEach((t) => counts[phaseOf(t)]++);
  const list = sortTrips(state.trips.filter((t) => tripFilter[phaseOf(t)]));

  const chips = Object.keys(PHASE_LABEL).map((p) => `
    <button class="seg ${tripFilter[p] ? 'active' : ''}" data-act="trip-filter" data-v="${p}">${PHASE_LABEL[p]} <span class="cnt">${counts[p]}</span></button>`).join('');

  const cards = list.map((t) => {
    const done = t.checklist.filter((c) => c.done).length;
    const total = t.checklist.length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    return `
    <button class="trip-card ${phaseOf(t)}" data-act="open-trip" data-id="${t.id}">
      <span class="trip-emoji">${esc(t.emoji)}</span>
      <span class="trip-main">
        <span class="row"><b class="trip-title">${esc(t.title)}</b><span class="spacer"></span>${tripBadge(t)}</span>
        <span class="muted small">${fmtRange(t.start, t.end)}</span>
        ${t.places ? `<span class="trip-places small">${esc(t.places)}</span>` : ''}
        ${total ? `<span class="trip-prep"><span class="progress"><i style="width:${pct}%"></i></span><span class="muted small">준비 ${pct}%</span></span>` : ''}
      </span>
    </button>`;
  }).join('');

  let empty = '';
  if (!state.trips.length) empty = '<div class="empty-state">아직 여행이 없어요.<br>위 버튼으로 첫 여행을 만들어 보세요.</div>';
  else if (!list.length) empty = '<div class="empty-state">이 조건에 맞는 여행이 없어요</div>';

  return `
    <button class="cta" data-act="new-trip">+ 새로운 여행 일정 만들기</button>
    <div class="filter-row chips">${chips}</div>
    <div class="trip-list">${cards}${empty}</div>`;
}

function renderNoTrip() {
  return `<div class="empty-state">아직 여행이 없어요.<br><br><button class="btn primary" data-act="new-trip">+ 새 여행 만들기</button></div>`;
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
      trip.budget.rate = rate;
    },
    onDelete: isNew ? null : () => {
      state.trips = state.trips.filter((x) => x !== trip);
      if (pickedTripId === trip.id) pickTrip(null);
      if (openTripId === trip.id) closeTrip();
    },
    deleteConfirm: `'${t.title}' 여행과 그 안의 일정·체크리스트·지출·예약이 모두 지워집니다. 삭제할까요?`,
  });
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

/* ============ 일정 (여행 상세) ============ */
function renderDays(trip) {
  if (!trip.days.length) return '<div class="empty-state">날짜가 없어요. ✎ 버튼으로 기간을 확인하세요.</div>';
  const t = todayStr();
  if (!selectedDate || !trip.days.some((d) => d.date === selectedDate)) {
    selectedDate = trip.days.some((d) => d.date === t) ? t : trip.days[0].date;
  }
  const strip = trip.days.map((d, i) => {
    const dt = parseDate(d.date);
    const cls = ['chip', d.date === selectedDate && 'active', d.date === t && 'today'].filter(Boolean).join(' ');
    return `<button class="${cls}" data-act="pick-day" data-date="${d.date}">
      <span>${i + 1}일차</span><b>${dt.getMonth() + 1}/${dt.getDate()}</b><span>${WEEK[dt.getDay()]}</span></button>`;
  }).join('');

  const idx = trip.days.findIndex((d) => d.date === selectedDate);
  const day = trip.days[idx];
  const doneCnt = day.items.filter((i) => i.done).length;
  const items = day.items.length ? day.items.map((it) => `
    <li class="tl-item ${it.done ? 'done' : ''}">
      <button class="tl-check" data-act="toggle-item" data-id="${it.id}" aria-label="완료 표시">${it.done ? '✓' : ''}</button>
      <div class="tl-body" data-act="edit-item" data-id="${it.id}">
        ${it.time ? `<div class="tl-time">${esc(it.time)}</div>` : ''}
        <div class="tl-title">${esc(it.title)}</div>
        ${it.memo ? `<div class="tl-memo">${esc(it.memo)}</div>` : ''}
        ${it.place ? `<div class="tl-links"><a class="map-link" href="${mapUrl(it.place)}" target="_blank" rel="noopener" data-act="link">📍 ${esc(it.place)}</a></div>` : ''}
      </div>
    </li>`).join('') : '<li class="empty-state">아직 일정이 없어요</li>';

  return `
    <div class="day-strip">${strip}</div>
    <div class="card">
      <div class="day-head row">
        <div>
          <div class="muted small">${idx + 1}일차 · ${fmtDate(day.date, true)}</div>
          <h2><span class="city">${esc(day.city || '도시 미정')}</span></h2>
        </div>
        <span class="spacer"></span>
        ${day.items.length ? `<span class="badge">${doneCnt}/${day.items.length}</span>` : ''}
        <button class="btn sm" data-act="edit-day">도시 수정</button>
      </div>
      <ul class="timeline">${items}</ul>
    </div>
    <button class="add-btn" data-act="add-item">+ 일정 추가</button>
    <p class="muted small" style="text-align:center;margin-top:14px">일정을 누르면 수정할 수 있어요.</p>`;
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
  const day = currentDay();
  const isNew = !item;
  item = item || { id: uid(), time: '', title: '', place: '', memo: '', done: false };
  openModal({
    title: isNew ? '일정 추가' : '일정 수정',
    fields: [
      { name: 'time', label: '시간 (예: 09:30, 오전, 저녁)', value: item.time },
      { name: 'title', label: '할 일', value: item.title, required: true },
      { name: 'place', label: '장소 (구글 지도 검색어)', value: item.place, placeholder: '예: Sagrada Família' },
      { name: 'memo', label: '메모', type: 'textarea', value: item.memo },
    ],
    onSave: (d) => { Object.assign(item, d); placeItem(day, item); },
    onDelete: isNew ? null : () => { day.items = day.items.filter((x) => x !== item); },
  });
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
function settingsForm() {
  openModal({
    title: '설정',
    html: `
      <p class="small muted" style="margin-top:0">데이터는 이 폰 안에만 저장돼요. 폰을 바꾸거나 브라우저 데이터를 지우면 사라지니 가끔 내보내기로 백업하세요. 백업에는 모든 여행이 들어갑니다.</p>
      <div class="row" style="flex-wrap:wrap;margin-bottom:14px">
        <button type="button" class="btn" id="exportBtn">⬇ 내보내기 (백업)</button>
        <label class="btn" style="display:inline-block">⬆ 가져오기 <input type="file" id="importInput" accept="application/json,.json" hidden></label>
      </div>
      <button type="button" class="btn danger" id="resetBtn" style="padding-left:0">처음 상태로 초기화</button>`,
  });
  $('#exportBtn').onclick = exportData;
  $('#importInput').onchange = importData;
  $('#resetBtn').onclick = () => {
    if (!confirm('모든 여행과 수정 내용이 지워지고 처음 상태(스페인 여행 초안)로 돌아갑니다. 계속할까요?')) return;
    state = seedData(); pickTrip(null); openTripId = null; save(); modal.close(); render(); toast('초기화했어요');
  };
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
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
      state = migrate(data); pickTrip(null); openTripId = null; save(); modal.close(); render(); toast('가져오기 완료');
    } catch (e) {
      toast('올바른 백업 파일이 아니에요');
    }
  };
  reader.readAsText(file);
}

/* ============ 이벤트 위임 ============ */
$('#settingsBtn').addEventListener('click', settingsForm);
$('#backBtn').addEventListener('click', closeTrip);
$('#tripEditBtn').addEventListener('click', () => { const t = detailTrip(); if (t) tripForm(t); });
$('.topbar').addEventListener('click', (ev) => { if (ev.target.closest('#tripSwitch')) tripPicker(); });

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

$('#view').addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.dataset.act !== 'toggle-check') return;
  const c = focusTrip().checklist.find((x) => x.id === el.dataset.id);
  c.done = el.checked;
  save();
  render();
});

// 자정이 지나면 오늘 날짜/D-day 갱신
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

render();

/* ============ 오프라인 (Service Worker) ============ */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW 등록 실패', e));
}
