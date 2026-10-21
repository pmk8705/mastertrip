'use strict';

/* ============ 저장소 ============ */
const STORE_KEY = 'spain-trip-v1';

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { console.warn('load failed', e); }
  return seedData();
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    toast('저장 실패: 저장 공간을 확인하세요');
  }
}

let state = load();
save();
// 홈 화면에 설치하지 않은 상태에서도 브라우저가 데이터를 지우지 않도록 요청
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

/* ============ 유틸 ============ */
const $ = (sel, el = document) => el.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function diffDays(a, b) { return Math.round((parseDate(a) - parseDate(b)) / 86400000); }
function fmtDate(s, withYear = false) {
  if (!s) return '';
  const d = parseDate(s);
  return `${withYear ? d.getFullYear() + '. ' : ''}${d.getMonth() + 1}/${d.getDate()} (${WEEK[d.getDay()]})`;
}
function won(n) { return Math.round(n).toLocaleString('ko-KR') + '원'; }
function eur(n) { return '€' + (Math.round(n * 100) / 100).toLocaleString('ko-KR'); }
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

/* ============ 모달 (공용 폼) ============ */
const modal = $('#modal');
let modalHandlers = {};

function openModal({ title, fields = [], html = '', onSave, onDelete, saveLabel = '저장' }) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html + fields.map(fieldHtml).join('');
  $('#modalSave').style.display = onSave ? '' : 'none';
  $('#modalSave').textContent = saveLabel;
  $('#modalDelete').style.display = onDelete ? '' : 'none';
  $('#modalCancel').textContent = onSave ? '취소' : '닫기';
  modalHandlers = { onSave, onDelete };
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
  if (!confirm('삭제할까요?')) return;
  modalHandlers.onDelete();
  modal.close();
  save();
  render();
  toast('삭제했어요');
});

/* ============ 라우팅 ============ */
let tab = sessionStorage.getItem('tab') || 'days';
let selectedDate = null;
let checkFilter = 'all';

document.querySelectorAll('.tabbar button').forEach((btn) => {
  btn.addEventListener('click', () => {
    tab = btn.dataset.tab;
    try { sessionStorage.setItem('tab', tab); } catch (e) {}
    render();
    window.scrollTo(0, 0);
  });
});

function render() {
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  renderHeader();
  const view = $('#view');
  if (tab === 'days') view.innerHTML = renderDays();
  else if (tab === 'check') view.innerHTML = renderCheck();
  else if (tab === 'budget') view.innerHTML = renderBudget();
  else view.innerHTML = renderBook();
  if (tab === 'days') {
    const active = $('.chip.active');
    if (active) active.scrollIntoView({ inline: 'center', block: 'nearest' });
  }
}

function tripPhase() {
  const t = todayStr();
  const { start, end } = state.trip;
  if (t < start) return { phase: 'before', dday: diffDays(start, t) };
  if (t > end) return { phase: 'after' };
  return { phase: 'during', dayNo: diffDays(t, start) + 1 };
}

function renderHeader() {
  $('#tripTitle').textContent = state.trip.title;
  document.title = state.trip.title;
  const p = tripPhase();
  let sub;
  if (p.phase === 'before') sub = `D-${p.dday} · ${fmtDate(state.trip.start, true)} 출국`;
  else if (p.phase === 'during') {
    const day = state.days.find((d) => d.date === todayStr());
    sub = `여행 ${p.dayNo}일차 · ${day ? day.city : ''}`;
  } else sub = '여행 완료 · 수고했어요';
  $('#tripSub').textContent = sub;
}

/* ============ 일정 ============ */
function renderDays() {
  const t = todayStr();
  if (!selectedDate || !state.days.some((d) => d.date === selectedDate)) {
    selectedDate = state.days.some((d) => d.date === t) ? t : state.days[0].date;
  }
  const strip = state.days.map((d, i) => {
    const dt = parseDate(d.date);
    const cls = ['chip', d.date === selectedDate && 'active', d.date === t && 'today'].filter(Boolean).join(' ');
    return `<button class="${cls}" data-act="pick-day" data-date="${d.date}">
      <span>${i + 1}일차</span><b>${dt.getMonth() + 1}/${dt.getDate()}</b><span>${WEEK[dt.getDay()]}</span></button>`;
  }).join('');

  const idx = state.days.findIndex((d) => d.date === selectedDate);
  const day = state.days[idx];
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
          <h2><span class="city">${esc(day.city)}</span></h2>
        </div>
        <span class="spacer"></span>
        ${day.items.length ? `<span class="badge">${doneCnt}/${day.items.length}</span>` : ''}
        <button class="btn sm" data-act="edit-day">도시 수정</button>
      </div>
      <ul class="timeline">${items}</ul>
    </div>
    <button class="add-btn" data-act="add-item">+ 일정 추가</button>
    <p class="muted small" style="text-align:center;margin-top:14px">일정을 누르면 수정할 수 있어요. 초기 일정은 추천 초안입니다.</p>`;
}

function currentDay() { return state.days.find((d) => d.date === selectedDate); }

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

function groupsInUse() {
  const extra = [...new Set(state.checklist.map((c) => c.group))].filter((g) => !GROUP_ORDER.includes(g));
  return [...GROUP_ORDER, ...extra];
}

function isOverdue(c) {
  if (c.done || c.due == null) return false;
  return diffDays(state.trip.start, todayStr()) < c.due;
}

function renderCheck() {
  const all = state.checklist;
  const done = all.filter((c) => c.done).length;
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;
  const overdue = all.filter(isOverdue).length;

  const groups = groupsInUse().map((g) => {
    let list = all.filter((c) => c.group === g);
    if (!list.length) return '';
    const gDone = list.filter((c) => c.done).length;
    if (checkFilter === 'todo') list = list.filter((c) => !c.done);
    const rows = list.map((c) => `
      <li class="${c.done ? 'done' : ''}">
        <input type="checkbox" id="c-${c.id}" data-act="toggle-check" data-id="${c.id}" ${c.done ? 'checked' : ''}>
        <label for="c-${c.id}">${esc(c.text)}${isOverdue(c) ? '<span class="overdue">기한 지남</span>' : ''}</label>
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

function checkForm(c) {
  const isNew = !c;
  c = c || { id: uid(), group: GROUP_ORDER[0], text: '', due: null, done: false };
  openModal({
    title: isNew ? '항목 추가' : '항목 수정',
    fields: [
      { name: 'text', label: '내용', value: c.text, required: true },
      { name: 'group', label: '시기 (직접 입력 가능)', value: c.group, list: groupsInUse(), required: true },
    ],
    onSave: (d) => { c.text = d.text; c.group = d.group; if (isNew) state.checklist.push(c); },
    onDelete: isNew ? null : () => { state.checklist = state.checklist.filter((x) => x !== c); },
  });
}

/* ============ 예산 ============ */
const CATS = ['항공', '숙소', '교통', '식비', '관광', '쇼핑', '기타'];
const toKRW = (e) => (e.currency === 'EUR' ? e.amount * state.budget.rate : e.amount);

function renderBudget() {
  const { plan, rate } = state.budget;
  const planTotal = CATS.reduce((s, k) => s + (Number(plan[k]) || 0), 0);
  const spent = state.expenses.reduce((s, e) => s + toKRW(e), 0);
  const today = todayStr();
  const todaySpent = state.expenses.filter((e) => e.date === today).reduce((s, e) => s + toKRW(e), 0);
  const left = planTotal - spent;

  const cats = CATS.map((k) => {
    const p = Number(plan[k]) || 0;
    const s = state.expenses.filter((e) => e.cat === k).reduce((a, e) => a + toKRW(e), 0);
    if (!p && !s) return '';
    const pct = p ? Math.min(100, (s / p) * 100) : 100;
    return `<div class="cat-row">
      <div class="row"><span>${k}</span><span class="num muted">${won(s)} / ${p ? won(p) : '예산 없음'}</span></div>
      <div class="progress ${p && s > p ? 'over' : ''}"><i style="width:${pct}%"></i></div>
    </div>`;
  }).join('');

  const exps = [...state.expenses].sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.id.localeCompare(a.id));
  const expHtml = exps.length ? exps.map((e) => `
    <div class="exp-item" data-act="edit-exp" data-id="${e.id}">
      <span class="cat">${esc(e.cat)}</span>
      <span class="memo">${esc(e.memo || '-')}<br><span class="muted small">${fmtDate(e.date)}</span></span>
      <span class="amt num">${e.currency === 'EUR' ? eur(e.amount) : won(e.amount)}
        ${e.currency === 'EUR' ? `<small>≈ ${won(toKRW(e))}</small>` : ''}</span>
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
        <span class="muted small">환율 €1 = ${rate.toLocaleString('ko-KR')}원</span>
        <span class="spacer"></span>
        <button class="btn sm" data-act="edit-plan">예산·환율 설정</button>
      </div>
    </div>
    ${cats ? `<div class="section-title"><h3>항목별</h3></div><div class="card">${cats}</div>` : ''}
    <button class="add-btn" data-act="add-exp">+ 지출 기록</button>
    <div class="section-title"><h3>지출 내역</h3><span class="muted small">${exps.length}건</span></div>
    <div class="card" style="padding:4px 14px">${expHtml}</div>`;
}

function expForm(e) {
  const isNew = !e;
  e = e || { id: uid(), date: todayStr(), cat: '식비', amount: '', currency: 'EUR', memo: '' };
  const amountRow = [
    { name: 'amount', label: '금액', type: 'number', value: e.amount, required: true },
    { name: 'currency', label: '통화', type: 'select', options: ['EUR', 'KRW'], value: e.currency },
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
      if (isNew) state.expenses.push(e);
      toast('기록했어요');
    },
    onDelete: isNew ? null : () => { state.expenses = state.expenses.filter((x) => x !== e); },
  });
}

function planForm() {
  const { plan, rate } = state.budget;
  openModal({
    title: '예산·환율 설정 (원 단위)',
    fields: [
      { name: 'rate', label: '환율: 1유로 = ?원', type: 'number', value: rate, required: true },
      ...CATS.map((k) => ({ name: 'p_' + k, label: k + ' 예산', type: 'number', value: plan[k] || '' })),
    ],
    onSave: (d) => {
      const r = parseFloat(d.rate);
      if (!(r > 0)) { toast('환율을 확인하세요'); return false; }
      state.budget.rate = r;
      CATS.forEach((k) => { state.budget.plan[k] = parseFloat(d['p_' + k]) || 0; });
    },
  });
}

/* ============ 예약·서류 ============ */
const BOOK_TYPES = { 항공: '✈️', 숙소: '🏨', 교통: '🚆', 관광: '🎟️', 식당: '🍽️', 보험: '🛡️', 기타: '📄' };

function renderBook() {
  const list = [...state.bookings].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
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

  const contacts = state.contacts.map((c) => `
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
    <div class="card" style="padding:4px 14px">${contacts}</div>
    <button class="add-btn" data-act="add-contact">+ 연락처 추가</button>`;
}

function bookForm(b) {
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
    onSave: (d) => { Object.assign(b, d); if (isNew) state.bookings.push(b); },
    onDelete: isNew ? null : () => { state.bookings = state.bookings.filter((x) => x !== b); },
  });
}

function contactForm(c) {
  const isNew = !c;
  c = c || { id: uid(), name: '', phone: '', memo: '' };
  openModal({
    title: isNew ? '연락처 추가' : '연락처 수정',
    fields: [
      { name: 'name', label: '이름', value: c.name, required: true },
      { name: 'phone', label: '전화번호 (국가번호 포함)', type: 'tel', value: c.phone, required: true },
      { name: 'memo', label: '메모', value: c.memo },
    ],
    onSave: (d) => { Object.assign(c, d); if (isNew) state.contacts.push(c); },
    onDelete: isNew ? null : () => { state.contacts = state.contacts.filter((x) => x !== c); },
  });
}

/* ============ 설정 · 백업 ============ */
function settingsForm() {
  openModal({
    title: '설정',
    html: `
      <p class="small muted" style="margin-top:0">데이터는 이 폰 안에만 저장돼요. 폰을 바꾸거나 브라우저 데이터를 지우면 사라지니 가끔 내보내기로 백업하세요.</p>
      <div class="row" style="flex-wrap:wrap;margin-bottom:14px">
        <button type="button" class="btn" id="exportBtn">⬇ 내보내기 (백업)</button>
        <label class="btn" style="display:inline-block">⬆ 가져오기 <input type="file" id="importInput" accept="application/json,.json" hidden></label>
      </div>`,
    fields: [{ name: 'title', label: '여행 이름', value: state.trip.title, required: true }],
    onSave: (d) => { state.trip.title = d.title; },
  });
  $('#modalBody').insertAdjacentHTML('beforeend',
    '<button type="button" class="btn danger" id="resetBtn" style="padding-left:0">처음 상태로 초기화</button>');
  $('#exportBtn').onclick = exportData;
  $('#importInput').onchange = importData;
  $('#resetBtn').onclick = () => {
    if (!confirm('모든 수정 내용이 지워지고 추천 초안으로 돌아갑니다. 계속할까요?')) return;
    state = seedData(); save(); modal.close(); render(); toast('초기화했어요');
  };
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `spain-trip-backup-${todayStr()}.json`;
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
      if (!data.days || !data.checklist || !data.trip) throw new Error('형식 오류');
      if (!confirm('현재 데이터를 백업 파일 내용으로 바꿀까요?')) return;
      state = data; save(); modal.close(); render(); toast('가져오기 완료');
    } catch (e) {
      toast('올바른 백업 파일이 아니에요');
    }
  };
  reader.readAsText(file);
}

/* ============ 이벤트 위임 ============ */
$('#settingsBtn').addEventListener('click', settingsForm);

$('#view').addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const id = el.dataset.id;
  if (act === 'link') return; // 링크는 기본 동작
  const day = currentDay();

  switch (act) {
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
    case 'edit-check': checkForm(state.checklist.find((x) => x.id === id)); break;
    case 'add-check': checkForm(null); break;
    case 'edit-plan': planForm(); break;
    case 'add-exp': expForm(null); break;
    case 'edit-exp': expForm(state.expenses.find((x) => x.id === id)); break;
    case 'add-book': bookForm(null); break;
    case 'edit-book': bookForm(state.bookings.find((x) => x.id === id)); break;
    case 'add-contact': contactForm(null); break;
    case 'edit-contact': contactForm(state.contacts.find((x) => x.id === id)); break;
  }
});

$('#view').addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.dataset.act !== 'toggle-check') return;
  const c = state.checklist.find((x) => x.id === el.dataset.id);
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
