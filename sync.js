'use strict';
// 3단계: 로그인 + 동기화 (Supabase). 설계는 docs/sync-design.md
// app.js보다 먼저 불러오지만, 여기 함수들은 app.js의 state·render·openModal 등을 부를 때만 쓴다.
// 로그인은 선택: 안 하면 지금처럼 폰에서만 동작. 라이브러리(vendor/supabase)는 로그인할 때만 불러온다.

const SB_URL = 'https://ogypfnqbtczhomdjrpvl.supabase.co';
const SB_KEY = 'sb_publishable_jrmy-Bp40VJfBOVn2JK46A_gqv1yw3O'; // 공개 키 (앱에 들어가도 됨). 비밀 키는 절대 넣지 않는다
const SB_SESSION_KEY = 'sb-ogypfnqbtczhomdjrpvl-auth-token'; // supabase-js가 로그인 정보를 넣는 곳
const SYNC_KEY = 'mastertrip-sync';

let sb = null; // supabase 연결 (불러온 뒤)
let sbUser = null; // 로그인한 사람 {id, email}
let syncBusy = false;
let syncMsg = ''; // 설정 화면에 보여 줄 마지막 결과

/* ---------- 라이브러리 불러오기·로그인 상태 ---------- */
const hasSavedSession = () => { try { return !!localStorage.getItem(SB_SESSION_KEY); } catch (e) { return false; } };
let sbLoading = null;
function loadSupabase() {
  if (sb) return Promise.resolve(sb);
  sbLoading = sbLoading || new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'vendor/supabase/supabase.js';
    s.onload = () => {
      sb = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
      sb.auth.onAuthStateChange((event, session) => {
        sbUser = session ? { id: session.user.id, email: session.user.email } : null;
        if (event === 'PASSWORD_RECOVERY') setTimeout(newPasswordForm, 300); // 비밀번호 재설정 메일의 링크로 들어옴
        if (typeof render === 'function' && mainTab === 'settings') render();
      });
      res(sb);
    };
    s.onerror = () => { sbLoading = null; rej(new Error('라이브러리를 불러오지 못했어요')); };
    document.head.append(s);
  });
  return sbLoading;
}

// app.js 끝에서 부름: 예전에 로그인했거나 메일 링크로 들어왔으면 연결해 둔다
async function syncBoot() {
  if (!hasSavedSession() && !/access_token|type=recovery|code=/.test(location.hash + location.search)) return;
  try {
    await loadSupabase();
    const { data } = await sb.auth.getSession();
    sbUser = data.session ? { id: data.session.user.id, email: data.session.user.email } : null;
    if (mainTab === 'settings') render();
  } catch (e) { console.warn('로그인 정보 불러오기 실패', e); }
}

/* ---------- 여행 ↔ 항목 (서버 trip_items 한 줄씩) ---------- */
// meta: 여행 정보, day: 날짜 정보(도시·한 줄 평), item: 일정, check·expense·booking·contact
// 폰에만 두는 것: 기록 사진(day.photos). 비상 서류·스크랩은 여행 밖이라 처음부터 안 들어옴.
const ARRAY_TYPES = [['checklist', 'check'], ['expenses', 'expense'], ['bookings', 'booking'], ['contacts', 'contact']];
function flattenTrip(t) {
  const { id, days, checklist, expenses, bookings, contacts, ...meta } = t;
  const rows = [{ id: 'meta', type: 'meta', order_index: null, payload: meta }];
  for (const d of days || []) {
    const { items, photos, ...day } = d;
    rows.push({ id: `day:${d.date}`, type: 'day', order_index: null, payload: day });
    (items || []).forEach((it, i) => rows.push({ id: it.id, type: 'item', order_index: i, payload: { ...it, date: d.date } }));
  }
  for (const [key, type] of ARRAY_TYPES) (t[key] || []).forEach((x, i) => rows.push({ id: x.id, type, order_index: i, payload: x }));
  return rows;
}
// 거꾸로: 항목들 → 여행 (3단계 '받기'에서 씀). keepPhotos: 이 폰의 기록 사진은 그대로
function unflattenTrip(tripId, rows, keepPhotos = {}) {
  const live = rows.filter((r) => !r.is_deleted);
  const by = (type) => live.filter((r) => r.type === type).sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));
  const meta = (live.find((r) => r.type === 'meta') || {}).payload || {};
  const t = { ...meta, id: tripId, days: [] };
  for (const r of by('day')) {
    const day = { ...r.payload, items: [] };
    if (keepPhotos[day.date]) day.photos = keepPhotos[day.date];
    t.days.push(day);
  }
  t.days.sort((a, b) => a.date.localeCompare(b.date));
  for (const r of by('item')) {
    const { date, ...it } = r.payload;
    const day = t.days.find((d) => d.date === date);
    if (day) day.items.push(it);
  }
  for (const [key, type] of ARRAY_TYPES) t[key] = by(type).map((r) => r.payload);
  return t;
}
// 키 순서와 상관없이 같은 내용이면 같은 글자 (서버 jsonb는 키 순서를 바꿔서 돌려줌)
function stableStr(v) {
  if (Array.isArray(v)) return `[${v.map(stableStr).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStr(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
const rowHash = (r) => `${r.type}|${r.order_index ?? ''}|${stableStr(r.payload)}`;

/* ---------- '보낸 그대로' 저장본: 이것과 다른 것만 보낸다 ---------- */
// { user, trips: { 여행id: { cursor, uploadedAt, rows: { 항목id: { v: 서버 버전, h: 보낸 내용, t: type, del } } } } }
function syncStore() {
  let s;
  try { s = JSON.parse(localStorage.getItem(SYNC_KEY) || 'null'); } catch (e) { s = null; }
  if (!s || !sbUser || s.user !== sbUser.id) s = { user: sbUser && sbUser.id, trips: {} }; // 다른 사람으로 로그인하면 새로
  return s;
}
function saveSyncStore(s) { try { localStorage.setItem(SYNC_KEY, JSON.stringify(s)); } catch (e) { console.warn(e); } }

// 여행 하나 보내기 → { sent, conflicts: [서버 내용…] }
async function pushTrip(trip, store) {
  const st = store.trips[trip.id] = store.trips[trip.id] || { cursor: null, rows: {} };
  const rows = flattenTrip(trip);
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    seen.add(r.id);
    const h = rowHash(r);
    const prev = st.rows[r.id];
    if (prev && prev.h === h && !prev.del) continue; // 그대로면 안 보냄
    out.push({ ...r, h, base_version: prev ? prev.v : null });
  }
  for (const [id, prev] of Object.entries(st.rows)) { // 폰에서 지운 것 → 지움 표시
    if (!seen.has(id) && !prev.del) out.push({ id, type: prev.t, order_index: null, payload: {}, is_deleted: true, h: '', base_version: prev.v });
  }
  const conflicts = [];
  let sent = 0;
  for (let i = 0; i < out.length; i += 200) { // 한 번에 200개씩
    const part = out.slice(i, i + 200);
    const { data, error } = await sb.rpc('push_items', { p_trip: trip.id, p_items: part.map(({ h, ...x }) => x) });
    if (error) throw error;
    for (const res of data || []) {
      const mine = part.find((x) => x.id === res.id);
      if (res.status === 'ok') { st.rows[res.id] = { v: res.version, h: mine.h, t: mine.type, del: !!mine.is_deleted }; sent++; }
      else conflicts.push({ ...res, mine });
    }
    saveSyncStore(store); // 끊겨도 보낸 데까지는 기억
  }
  return { sent, conflicts };
}

/* ---------- 처음 로그인: 내 여행 올리기 ---------- */
async function uploadMyTrips() {
  if (syncBusy) return;
  if (!navigator.onLine) return toast('인터넷 연결이 필요해요');
  const n = state.trips.length;
  if (!n) return toast('올릴 여행이 없어요');
  if (!confirm(`이 폰의 여행 ${n}개를 서버에 올려요.\n\n먼저 백업 파일을 하나 저장할게요(혹시를 위해). 계속할까요?`)) return;
  syncBusy = true;
  syncMsg = '올리는 중…';
  render();
  try {
    await exportData(); // 자동 백업 (비상 서류가 있으면 확인 창이 한 번 더 뜸)
    await loadSupabase();
    const store = syncStore();
    const report = [];
    for (const trip of state.trips) {
      const { data: claim, error } = await sb.rpc('claim_trip', { p_trip: trip.id });
      if (error) throw error;
      if (claim === 'taken') { report.push(`⚠ ${trip.title}: 다른 사람이 먼저 올린 여행이라 건너뜀 (초대 코드로 합치기는 다음 단계)`); continue; }
      const { sent, conflicts } = await pushTrip(trip, store);
      store.trips[trip.id].uploadedAt = new Date().toISOString();
      report.push(`✅ ${trip.title}: ${sent}개 올림${conflicts.length ? ` · 서버에 이미 다른 내용 ${conflicts.length}개 (다음 단계에서 합침)` : ''}`);
    }
    saveSyncStore(store);
    syncMsg = report.join('\n');
    toast('올리기 끝');
  } catch (e) {
    console.warn('올리기 실패', e);
    syncMsg = `올리지 못했어요: ${e.message || e}`;
    toast('올리지 못했어요');
  } finally {
    syncBusy = false;
    render();
  }
}

/* ---------- 로그인·가입·로그아웃·비밀번호 ---------- */
const AUTH_ERR = {
  'Invalid login credentials': '이메일이나 비밀번호가 맞지 않아요',
  'User already registered': '이미 가입된 이메일이에요. 로그인을 눌러 주세요',
  'Password should be at least 6 characters.': '비밀번호는 6자 이상이어야 해요',
  'Unable to validate email address: invalid format': '이메일 형식을 확인해 주세요',
};
const authErr = (e) => AUTH_ERR[e && e.message] || (e && /rate limit/i.test(e.message) ? '잠시 뒤에 다시 해 주세요 (요청이 너무 많음)' : `실패: ${(e && e.message) || e}`);

function loginForm() {
  if (!navigator.onLine) return toast('인터넷 연결이 필요해요');
  openModal({
    title: '🔑 로그인',
    fields: [
      { name: 'email', label: '이메일', type: 'email', required: true, placeholder: 'you@example.com', attrs: 'autocomplete="email" autocapitalize="off"' },
      { name: 'password', label: '비밀번호 (6자 이상)', type: 'password', required: true, attrs: 'autocomplete="current-password" minlength="6"' },
    ],
    html: '<p class="muted small" style="margin-top:0">두 분이 같은 여행을 함께 고치려면 각자 로그인해요. 로그인하지 않아도 지금처럼 이 폰에서 쓸 수 있어요.</p>',
    saveLabel: '로그인',
    onSave: (d) => { auth('login', d); return false; }, // 결과를 기다렸다가 직접 닫는다
  });
  $('#modalBody').insertAdjacentHTML('beforeend', `
    <div id="authMsg" class="small" style="min-height:1.4em;color:var(--danger)"></div>
    <div class="row" style="flex-wrap:wrap;gap:8px">
      <button type="button" class="btn sm" id="signupBtn">처음이면 가입하기</button>
      <button type="button" class="link-btn" id="forgotBtn">비밀번호를 잊었어요</button>
    </div>`);
  const form = $('#modalForm');
  $('#signupBtn').onclick = () => { if (form.reportValidity()) auth('signup', Object.fromEntries(new FormData(form))); };
  $('#forgotBtn').onclick = async () => {
    const email = form.email.value.trim();
    if (!email) return ($('#authMsg').textContent = '이메일을 먼저 넣어 주세요');
    try {
      await loadSupabase();
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      $('#authMsg').textContent = error ? authErr(error) : '재설정 메일을 보냈어요. 메일의 링크를 누르면 새 비밀번호를 정할 수 있어요.';
    } catch (e) { $('#authMsg').textContent = authErr(e); }
  };
}
async function auth(kind, d) {
  const msg = $('#authMsg');
  const btn = $('#modalSave');
  btn.disabled = true;
  if (msg) msg.textContent = kind === 'signup' ? '가입하는 중…' : '로그인하는 중…';
  try {
    await loadSupabase();
    const creds = { email: d.email.trim(), password: d.password };
    const { data, error } = kind === 'signup' ? await sb.auth.signUp(creds) : await sb.auth.signInWithPassword(creds);
    if (error) throw error;
    if (!data.session) throw new Error('가입은 됐지만 로그인되지 않았어요. 잠시 뒤 로그인을 눌러 주세요');
    sbUser = { id: data.session.user.id, email: data.session.user.email };
    modal.close();
    toast(kind === 'signup' ? '가입했어요' : '로그인했어요');
    render();
  } catch (e) {
    if (msg) msg.textContent = authErr(e);
  } finally {
    btn.disabled = false;
  }
}
async function logout() {
  if (!confirm('로그아웃할까요? 이 폰의 여행은 그대로 남아요.')) return;
  try { await loadSupabase(); await sb.auth.signOut(); } catch (e) { console.warn(e); }
  sbUser = null;
  syncMsg = '';
  render();
  toast('로그아웃했어요');
}
// 비밀번호 재설정 메일 링크로 들어왔을 때
function newPasswordForm() {
  openModal({
    title: '🔑 새 비밀번호',
    fields: [{ name: 'password', label: '새 비밀번호 (6자 이상)', type: 'password', required: true, attrs: 'autocomplete="new-password" minlength="6"' }],
    saveLabel: '바꾸기',
    onSave: (d) => {
      sb.auth.updateUser({ password: d.password })
        .then(({ error }) => { toast(error ? authErr(error) : '비밀번호를 바꿨어요'); if (!error) modal.close(); });
      return false;
    },
  });
}

/* ---------- 설정 화면 '함께 쓰기' 칸 ---------- */
const whenStr = (iso) => { const d = new Date(iso); return `${fmtDate(ymd(d))} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
function syncCardHtml() {
  if (!sbUser) {
    return `<div class="section-title"><h3>함께 쓰기</h3></div>
      <div class="card">
        <p class="small muted" style="margin-top:0">로그인하면 이 폰의 여행을 서버에 올려 두고, 다음 업데이트부터 배우자와 같은 여행을 함께 고칠 수 있어요. 로그인하지 않아도 지금처럼 쓸 수 있어요.</p>
        <button type="button" class="btn primary" data-act="sync-login">🔑 로그인 / 가입</button>
      </div>`;
  }
  const store = syncStore();
  const up = state.trips.filter((t) => store.trips[t.id] && store.trips[t.id].uploadedAt);
  const last = up.map((t) => store.trips[t.id].uploadedAt).sort().pop();
  return `<div class="section-title"><h3>함께 쓰기</h3></div>
    <div class="card">
      <div class="row small"><span>🔑 ${esc(sbUser.email)}</span><span class="spacer"></span><button type="button" class="link-btn" data-act="sync-logout">로그아웃</button></div>
      <p class="small muted">서버에 올린 여행 ${up.length}/${state.trips.length}개${last ? ` · 마지막 ${whenStr(last)}` : ''}</p>
      ${syncMsg ? `<p class="small" style="white-space:pre-line">${esc(syncMsg)}</p>` : ''}
      <button type="button" class="btn primary" data-act="sync-upload" ${syncBusy ? 'disabled' : ''}>☁️ ${up.length ? '바뀐 것 다시 올리기' : '내 여행 서버에 올리기'}</button>
    </div>`;
}
