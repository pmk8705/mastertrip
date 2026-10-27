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
    syncSoon(800); // 앱을 열 때 맞추기
  } catch (e) { console.warn('로그인 정보 불러오기 실패', e); }
}

/* ---------- 여행 ↔ 항목 (서버 trip_items 한 줄씩) ---------- */
// meta: 여행 정보, day: 날짜 정보(도시·한 줄 평), item: 일정, check·expense·booking·contact
// 폰에만 두는 것: 기록 사진(day.photos). 비상 서류·스크랩은 여행 밖이라 처음부터 안 들어옴.
const ARRAY_TYPES = [['checklist', 'check'], ['expenses', 'expense'], ['bookings', 'booking'], ['contacts', 'contact']];
// 순서 번호: 전에 쓰던 번호(st.rows[id].o)를 최대한 그대로 두고, 옮기거나 새로 넣은 것만 사이 값(예: 1.5)을 준다.
// 하나를 지우거나 끼워 넣어도 나머지 항목은 '바뀐 것'이 아니게 → 덜 보내고, 다른 항목을 고친 배우자와 가짜 충돌이 안 난다.
function stableOrder(ids, prevOf) {
  const c = ids.map(prevOf);
  // 전 번호가 오름차순으로 이어지는 가장 긴 묶음은 그대로 둔다
  const tails = [], tailAt = [], parent = new Map();
  c.forEach((v, i) => {
    if (typeof v !== 'number') return;
    let lo = 0, hi = tails.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tails[m] < v) lo = m + 1; else hi = m; }
    tails[lo] = v; tailAt[lo] = i; parent.set(i, lo > 0 ? tailAt[lo - 1] : -1);
  });
  const keep = new Set();
  for (let k = tails.length ? tailAt[tails.length - 1] : -1; k >= 0; k = parent.get(k)) keep.add(k);
  const out = [];
  let last = null;
  for (let i = 0; i < ids.length; i++) {
    if (keep.has(i)) { out.push(c[i]); last = c[i]; continue; }
    let next = null;
    for (let j = i + 1; j < ids.length; j++) if (keep.has(j)) { next = c[j]; break; }
    const v = last == null ? (next == null ? i : next - 1) : next == null ? last + 1 : (last + next) / 2;
    out.push(v);
    last = v;
  }
  return out;
}
// st: 이 여행의 '보낸 그대로' 저장본 (순서 번호를 이어 쓰려고). 없으면 0,1,2…
function flattenTrip(t, st) {
  const prevOf = (id) => { const p = st && st.rows[id]; return p && !p.del ? p.o : undefined; };
  const ordered = (list) => { const o = stableOrder(list.map((x) => x.id), prevOf); return list.map((x, i) => [x, o[i]]); };
  const { id, days, checklist, expenses, bookings, contacts, ...meta } = t;
  const rows = [{ id: 'meta', type: 'meta', order_index: null, payload: meta }];
  for (const d of days || []) {
    const { items, photos, ...day } = d;
    rows.push({ id: `day:${d.date}`, type: 'day', order_index: null, payload: day });
    for (const [it, o] of ordered(items || [])) rows.push({ id: it.id, type: 'item', order_index: o, payload: { ...it, date: d.date } });
  }
  for (const [key, type] of ARRAY_TYPES) for (const [x, o] of ordered(t[key] || [])) rows.push({ id: x.id, type, order_index: o, payload: x });
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
  const rows = flattenTrip(trip, st);
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
      if (res.status === 'ok') { st.rows[res.id] = { v: res.version, h: mine.h, t: mine.type, del: !!mine.is_deleted, o: mine.order_index }; sent++; }
      else conflicts.push({ ...res, mine });
    }
    saveSyncStore(store); // 끊겨도 보낸 데까지는 기억
  }
  return { sent, conflicts };
}

/* ---------- 받기: 서버에서 바뀐 항목을 폰에 합치기 ---------- */
const snapOf = (r) => ({ v: r.version, h: r.is_deleted ? '' : rowHash(r), t: r.type, del: !!r.is_deleted, o: r.order_index });
const sbRow = (r) => ({ id: r.id, type: r.type, order_index: r.order_index, payload: r.payload });

// cursor(마지막으로 받은 서버 시각)보다 1분 앞부터 받는다 (겹쳐 받아 빠뜨림 방지). 1000개씩
async function fetchRows(tripId, cursor) {
  const since = cursor ? new Date(new Date(cursor).getTime() - 60e3).toISOString() : null;
  const all = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from('trip_items').select('*').eq('trip_id', tripId).order('updated_at').range(from, from + 999);
    if (since) q = q.gt('updated_at', since);
    const { data, error } = await q;
    if (error) throw error;
    all.push(...data);
    if (data.length < 1000) return all;
  }
}

// 충돌 하나를 사람에게 묻는다 → 'mine' | 'theirs' | 'allMine' | 'allTheirs'
const ROW_NAME = { meta: '여행 정보', day: '날짜 정보', item: '일정', check: '체크리스트', expense: '지출', booking: '예약', contact: '연락처' };
function rowSummary(type, p) {
  if (!p) return '(지움)';
  const bits = type === 'item' ? [p.date && fmtDate(p.date), p.time, p.title, p.place, p.memo]
    : type === 'expense' ? [p.date && fmtDate(p.date), p.amount != null && money(Number(p.amount) || 0, p.currency || 'KRW'), p.cat, p.memo]
      : type === 'check' ? [p.text, p.done ? '✓ 완료' : '미완료']
        : type === 'booking' ? [p.title, p.date && fmtDate(p.date), p.code && `예약번호 ${p.code}`, p.memo]
          : type === 'day' ? [p.date && fmtDate(p.date), p.city, p.note]
            : type === 'meta' ? [p.title, p.start && `${p.start} ~ ${p.end}`, p.currency]
              : [p.name, p.phone, p.memo];
  return bits.filter(Boolean).join(' · ') || '(내용 없음)';
}
function askConflict(c, left) {
  return new Promise((res) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; $('#modalBody').onclick = null; if (modal.open) modal.close(); res(v); };
    openModal({
      title: '✋ 둘이 같은 곳을 고쳤어요',
      html: `<p class="muted small" style="margin-top:0">${esc(ROW_NAME[c.type] || '항목')} · 어느 쪽으로 할까요?${left > 1 ? ` (남은 ${left}개)` : ''}</p>
        <div class="col-btns">
          <button type="button" class="btn" data-pick="theirs">배우자(서버) 것<br><span class="small">${esc(rowSummary(c.type, c.theirs))}</span></button>
          <button type="button" class="btn" data-pick="mine">이 폰의 것<br><span class="small">${esc(rowSummary(c.type, c.mine))}</span></button>
        </div>
        ${left > 1 ? `<div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
          <button type="button" class="link-btn" data-pick="allTheirs">남은 것 모두 배우자 것</button>
          <button type="button" class="link-btn" data-pick="allMine">남은 것 모두 이 폰의 것</button></div>` : ''}`,
    });
    $('#modalCancel').textContent = '나중에';
    $('#modalBody').onclick = (ev) => { const b = ev.target.closest('[data-pick]'); if (b) finish(b.dataset.pick); };
    $('#modalCancel').addEventListener('click', () => finish(null), { once: true });
    // 뒤로가기 등으로 닫혀도 멈추지 않게 (다음 질문 창이 이미 열렸으면 무시)
    modal.addEventListener('close', () => { if (!modal.open) finish(null); }, { once: true });
  });
}
// 충돌들을 차례로 묻는다. 고른 대로: theirs → 서버 것을 폰에, mine → 다음 보내기에서 이 폰의 것으로 덮음
async function resolveConflicts(list, local, st) {
  let all = null;
  let changed = false;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const pick = all || await askConflict(c, list.length - i);
    if (!pick) return { changed, stopped: true }; // '나중에': 남은 건 다음 맞출 때 다시 물음
    if (pick.startsWith('all')) all = pick;
    if (/theirs/i.test(pick)) {
      if (c.server.is_deleted) local.delete(c.id); else local.set(c.id, sbRow(c.server));
      st.rows[c.id] = snapOf(c.server);
      changed = true;
    } else {
      // 서버 버전을 '본 것'으로 기록 → 이 폰 내용이 달라서 다음 보내기에서 그대로 올라감
      st.rows[c.id] = { v: c.server.version, h: '', t: c.type, del: false };
    }
  }
  return { changed, stopped: false };
}

let applyingRemote = false; // 받은 것을 저장할 때는 '고쳤으니 보내기'를 다시 부르지 않음
function rebuildTrip(tripId, local) {
  const old = getTrip(tripId);
  const keepPhotos = {}; // 기록 사진은 폰마다 따로라 이 폰 것을 그대로
  if (old) for (const d of old.days) if (d.photos) keepPhotos[d.date] = d.photos;
  const t = normalizeTrip(unflattenTrip(tripId, [...local.values()], keepPhotos));
  if (old) state.trips[state.trips.indexOf(old)] = t; else state.trips.push(t);
  applyingRemote = true;
  try { save(); } finally { applyingRemote = false; }
  return t;
}

// 여행 하나 맞추기: 받기 → (충돌 묻기) → 보내기 → (그사이 바뀐 것 충돌 묻기 → 다시 보내기)
async function syncTrip(tripId, store, report) {
  const st = store.trips[tripId] = store.trips[tripId] || { cursor: null, rows: {} };
  const trip = getTrip(tripId);
  const local = new Map(trip ? flattenTrip(trip, st).map((r) => [r.id, r]) : []);
  const server = await fetchRows(tripId, st.cursor);
  const conflicts = [];
  let got = 0;
  for (const r of server) {
    const prev = st.rows[r.id];
    if (prev && prev.v >= r.version) continue; // 이미 받은 것
    const cur = local.get(r.id);
    const dirty = prev ? (cur ? rowHash(cur) !== prev.h : !prev.del) : !!cur && rowHash(cur) !== rowHash(r);
    if (!dirty) {
      if (r.is_deleted) local.delete(r.id); else local.set(r.id, sbRow(r));
      st.rows[r.id] = snapOf(r);
      got++;
    } else conflicts.push({ id: r.id, type: r.type, server: r, theirs: r.is_deleted ? null : r.payload, mine: cur ? cur.payload : null });
  }
  if (server.length) st.cursor = server[server.length - 1].updated_at;
  const res = conflicts.length ? await resolveConflicts(conflicts, local, st) : { changed: false, stopped: false };
  let t = trip;
  if (got || res.changed || !trip) t = rebuildTrip(tripId, local);
  saveSyncStore(store);
  if (res.stopped) { report.push(`⏸ ${t.title}: 고르지 않은 항목은 다음에 다시 물어요`); return; }
  // 보내기 (보내는 사이 배우자가 또 고친 것은 한 번 더 묻는다)
  for (let round = 0; round < 2; round++) {
    const { sent, conflicts: late } = await pushTrip(getTrip(tripId), store);
    if (got || sent) report.push(`✅ ${t.title}: 받음 ${got} · 보냄 ${sent}`);
    got = 0;
    if (!late.length) break;
    const cur = new Map(flattenTrip(getTrip(tripId), st).map((r) => [r.id, r]));
    const list = late.map((x) => ({ id: x.id, type: x.mine.type, server: { ...x, type: x.mine.type }, theirs: x.is_deleted ? null : x.payload, mine: x.mine.is_deleted ? null : x.mine.payload }));
    const again = await resolveConflicts(list, cur, st);
    if (again.changed) rebuildTrip(tripId, cur);
    saveSyncStore(store);
    if (again.stopped) break;
  }
  st.uploadedAt = new Date().toISOString();
  saveSyncStore(store);
}

/* ---------- 전체 맞추기 ---------- */
// 로그인 + '올리기'를 한 번 한 뒤(store.on)부터 자동: 앱을 열 때·돌아올 때·인터넷이 다시 될 때·고친 뒤 4초
let syncAgain = false;
async function syncAll({ manual = false } = {}) {
  if (!sbUser || !navigator.onLine) { if (manual) toast('인터넷 연결이 필요해요'); return; }
  if (syncBusy) { syncAgain = true; return; }
  // 무언가 고치는 중(입력 창·전체 화면 보기·순서 끌기)에는 바꾸지 않는다 → 잠시 뒤 다시
  if ((modal.open && !manual) || $('#viewer') || (typeof drag !== 'undefined' && drag)) { syncSoon(5000); return; }
  syncBusy = true;
  const report = [];
  try {
    await loadSupabase();
    const store = syncStore();
    if (Object.values(store.trips).some((x) => x.uploadedAt)) store.on = true; // 예전(올리기만 하던 때) 저장본
    if (!store.on && !manual) return;
    store.on = true;
    const { data: srv, error } = await sb.from('trips').select('id, is_deleted, owner_id');
    if (error) throw error;
    const onServer = new Map(srv.map((x) => [x.id, x]));
    // 이 폰에서 지운 여행: 주인이면 서버에서도 지움 표시, 아니면 함께 쓰기에서 나가기
    for (const id of Object.keys(store.trips)) {
      if (getTrip(id)) continue;
      const s = onServer.get(id);
      if (s && !s.is_deleted) {
        if (s.owner_id === sbUser.id) await sb.from('trips').update({ is_deleted: true }).eq('id', id);
        else await sb.from('trip_members').delete().eq('trip_id', id).eq('user_id', sbUser.id);
      }
      delete store.trips[id];
      onServer.delete(id);
    }
    // 이 폰의 여행
    for (const trip of [...state.trips]) {
      const s = onServer.get(trip.id);
      if (s && s.is_deleted) { // 상대가 지운 여행: 이 폰엔 남기고 맞추기만 멈춤
        if (store.trips[trip.id]) { delete store.trips[trip.id]; report.push(`ℹ ${trip.title}: 배우자가 지운 여행이라 맞추기를 멈췄어요 (이 폰엔 남아 있어요)`); }
        continue;
      }
      if (!s) {
        const { data: claim, error: e2 } = await sb.rpc('claim_trip', { p_trip: trip.id });
        if (e2) throw e2;
        if (claim === 'taken') { report.push(`⚠ ${trip.title}: 같은 id의 여행이 서버에 이미 있어요 — 배우자에게 초대 코드를 받아 넣으면 합쳐져요`); continue; }
      } else if (!store.trips[trip.id] && !manual) {
        // 초대로 들어온 여행이 이 폰에도 있음(예전에 파일로 받음): 한 번 묻는다
        if (!confirm(`“${trip.title}” 여행이 서버에도 있어요.\n\n[확인] 서버(배우자) 것으로 맞추기 — 이 폰과 다른 곳은 하나씩 물어봐요\n[취소] 나중에`)) continue;
      }
      await syncTrip(trip.id, store, report);
      saveSyncStore(store);
    }
    // 서버에만 있는 여행 (초대로 들어온 여행) → 받아 오기
    for (const [id, s] of onServer) {
      if (s.is_deleted || getTrip(id)) continue;
      await syncTrip(id, store, report);
    }
    saveSyncStore(store);
    syncMsg = report.join('\n') || `맞춤 · ${whenStr(new Date().toISOString())}`;
    if (manual || report.some((l) => l.startsWith('✅') && !/받음 0 ·/.test(l))) render();
  } catch (e) {
    console.warn('맞추기 실패', e);
    syncMsg = `맞추지 못했어요: ${e.message || e}`;
    if (manual) toast('맞추지 못했어요');
  } finally {
    syncBusy = false;
    if (mainTab === 'settings') render();
    if (syncAgain) { syncAgain = false; syncSoon(1000); }
  }
}
let syncTimer = null;
function syncSoon(ms = 4000) {
  if (!sbUser || applyingRemote) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncAll(), ms);
}

/* ---------- 처음: 내 여행 올리기 (자동 백업 먼저) ---------- */
async function uploadMyTrips() {
  if (syncBusy) return;
  if (!navigator.onLine) return toast('인터넷 연결이 필요해요');
  const store = syncStore();
  if (!store.on) {
    if (!confirm(`이 폰의 여행 ${state.trips.length}개를 서버에 올리고, 이제부터 자동으로 맞춰요.\n\n먼저 백업 파일을 하나 저장할게요(혹시를 위해). 계속할까요?`)) return;
    await exportData(); // 비상 서류가 있으면 확인 창이 한 번 더 뜸
  }
  syncMsg = '맞추는 중…';
  render();
  await syncAll({ manual: true });
  toast('맞추기 끝');
}

/* ---------- 초대 코드 ---------- */
async function inviteForm(tripId) {
  const t = getTrip(tripId);
  try {
    await loadSupabase();
    const { data: code, error } = await sb.rpc('create_invite', { p_trip: tripId });
    if (error) throw error;
    const text = `MasterTrip “${t.title}” 함께 쓰기 초대 코드: ${code}\n앱 → 설정 → 함께 쓰기 → 초대 코드 넣기 (7일 안에, 한 번만)`;
    openModal({
      title: '👥 배우자 초대',
      html: `<p class="muted small" style="margin-top:0">배우자가 로그인한 뒤 <b>설정 → 함께 쓰기 → 초대 코드 넣기</b>에 이 코드를 넣으면 “${esc(t.title)}”을 함께 고칠 수 있어요. 7일 안에 한 번만 쓸 수 있어요.</p>
        <p style="font-size:30px;font-weight:800;letter-spacing:4px;text-align:center;margin:14px 0">${esc(code)}</p>
        <div class="seg-btns"><button type="button" class="btn" id="invCopy">📋 복사</button><button type="button" class="btn primary" id="invShare">💬 보내기</button></div>`,
    });
    $('#invCopy').onclick = () => navigator.clipboard.writeText(text).then(() => toast('복사했어요'), () => toast('복사하지 못했어요'));
    $('#invShare').onclick = () => (navigator.share ? navigator.share({ text }).catch(() => {}) : navigator.clipboard.writeText(text).then(() => toast('복사했어요 — 카톡에 붙여 넣어 주세요')));
  } catch (e) {
    toast(`초대 코드를 만들지 못했어요 (${e.message || e})`);
  }
}
function joinForm() {
  openModal({
    title: '👥 초대 코드 넣기',
    fields: [{ name: 'code', label: '배우자가 보낸 8자리 코드', required: true, placeholder: '예: 3F9A1C2B', attrs: 'autocapitalize="characters" autocorrect="off" autocomplete="off" spellcheck="false" maxlength="8"' }],
    saveLabel: '들어가기',
    onSave: (d) => {
      sb.rpc('join_trip', { p_code: d.code.trim().toUpperCase() }).then(async ({ data: tripId, error }) => {
        if (error) return toast(/invalid|expired/.test(error.message) ? '코드가 맞지 않거나 기간이 지났어요' : `들어가지 못했어요 (${error.message})`);
        modal.close();
        toast('여행에 들어왔어요. 받아 오는 중…');
        const store = syncStore();
        store.on = true;
        saveSyncStore(store);
        await syncAll({ manual: true });
        pickTrip(tripId);
        setMain('trips');
      });
      return false;
    },
  });
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
    syncSoon(500);
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
        <p class="small muted" style="margin-top:0">로그인하면 이 폰의 여행을 서버에 올려 두고 배우자와 같은 여행을 함께 고칠 수 있어요. 로그인하지 않아도 지금처럼 쓸 수 있어요.</p>
        <button type="button" class="btn primary" data-act="sync-login">🔑 로그인 / 가입</button>
      </div>`;
  }
  const store = syncStore();
  const on = store.on || Object.values(store.trips).some((x) => x.uploadedAt);
  const rows = state.trips.filter((t) => store.trips[t.id]).map((t) => `
    <div class="row small" style="padding:4px 0"><span>${esc(t.emoji)} ${esc(t.title)}</span><span class="spacer"></span>
      <button type="button" class="btn sm" data-act="sync-invite" data-id="${t.id}">👥 초대 코드</button></div>`).join('');
  return `<div class="section-title"><h3>함께 쓰기</h3></div>
    <div class="card">
      <div class="row small"><span>🔑 ${esc(sbUser.email)}</span><span class="spacer"></span><button type="button" class="link-btn" data-act="sync-logout">로그아웃</button></div>
      <p class="small muted">${on ? '자동으로 맞추는 중이에요 (앱을 열 때·돌아올 때·고친 뒤)' : '아직 서버에 올리지 않았어요'}</p>
      ${rows}
      ${syncMsg ? `<p class="small" style="white-space:pre-line">${esc(syncMsg)}</p>` : ''}
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <button type="button" class="btn primary" data-act="sync-upload" ${syncBusy ? 'disabled' : ''}>☁️ ${on ? '지금 맞추기' : '내 여행 서버에 올리기'}</button>
        <button type="button" class="btn" data-act="sync-join">초대 코드 넣기</button>
      </div>
      <button type="button" class="link-btn" data-act="sync-password" style="margin-top:6px">비밀번호 바꾸기</button>
    </div>`;
}
