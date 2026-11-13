'use strict';
/* ============ 엑셀 불러오기 · 내보내기 ============ */
// 엑셀 = 계획 원본, 앱 = 여행 중 기록. 양식: templates/MasterTrip_여행계획표_스페인.xlsx (시트 이름 + 2행 제목 줄)
// 다시 불러오면 같은 항목(ID → 같은 이름)의 엑셀 칸만 고치고, 앱에서만 넣은 위치·바우처·사진·완료·지출은 그대로 둔다.
// 엑셀 도구(SheetJS 0.18.5, Apache-2.0, vendor/sheetjs)는 버튼을 누를 때만 불러온다 (한 번 받으면 서비스 워커가 저장).

let xlsxLoad;
const loadXLSX = () => (window.XLSX ? Promise.resolve(window.XLSX) : xlsxLoad || (xlsxLoad = new Promise((res, rej) => {
  const sc = document.createElement('script');
  sc.src = 'vendor/sheetjs/xlsx.full.min.js';
  sc.onload = () => res(window.XLSX);
  sc.onerror = () => { xlsxLoad = null; sc.remove(); rej(new Error('엑셀 도구를 불러오지 못했어요 (처음 한 번은 인터넷이 필요해요)')); };
  document.head.append(sc);
})));

// 파일 고르기 칸은 화면(#view) 밖에 하나만 (다시 그려도 사라지지 않게)
const excelPicker = Object.assign(document.createElement('input'), {
  type: 'file', hidden: true,
  accept: '.xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv',
});
document.body.append(excelPicker);
excelPicker.addEventListener('change', async () => {
  const file = excelPicker.files[0];
  excelPicker.value = '';
  if (!file) return;
  try {
    toast('엑셀을 읽는 중…');
    const X = await loadXLSX();
    const wb = X.read(await file.arrayBuffer(), { type: 'array' });
    excelPreview(wb, file.name);
  } catch (e) {
    console.warn('엑셀 읽기 실패', e);
    toast(`엑셀을 읽지 못했어요 (${e.message})`);
  }
});
const excelImport = () => excelPicker.click();

/* ---------- 칸 읽기 ---------- */
const xlNorm = (v) => String(v ?? '').replace(/\s/g, '');
const xlStr = (v) => String(v ?? '').trim();
const pad2 = (n) => String(n).padStart(2, '0');

// 시트를 표로: 처음 10줄 안에서 need 제목이 다 있는 줄을 제목 줄로. 제목은 같은 이름 → 앞부분이 같은 이름 순으로 찾는다
// (예: '장소' → '장소(영문·검색어)', '금액' → '금액(원)'). 같은 제목이 두 번이면 처음 것.
function xlTable(wb, name, need) {
  const ws = wb.Sheets[name];
  if (!ws) return null;
  const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const hi = rows.slice(0, 10).findIndex((r) => need.every((n) => r.some((c) => xlNorm(c).startsWith(xlNorm(n)))));
  if (hi < 0) return { rows: [], missing: true };
  const head = rows[hi].map(xlNorm);
  const col = (n) => { const k = xlNorm(n); const i = head.indexOf(k); return i >= 0 ? i : head.findIndex((h) => h.startsWith(k)); };
  return {
    rows: rows.slice(hi + 1).map((r, i) => ({ r, line: hi + 2 + i })).filter((x) => x.r.some((c) => xlStr(c) !== '')),
    get: (x, n) => { const i = col(n); return i < 0 ? '' : x.r[i]; },
  };
}

// 날짜: 엑셀 날짜(일련번호 46482 = 2027-04-05) · '2027-04-07' · '2027.4.7' · '4/7' · '4월 7일' → 'YYYY-MM-DD'
function xlDate(v, year) {
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = new Date(Math.round((v - 25569) * 864e5)); // 엑셀 날짜는 시간대가 없어서 UTC로 읽는다
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }
  const t = xlStr(v);
  let m = t.match(/(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = t.match(/(\d{1,2})\s*[/.월]\s*(\d{1,2})/);
  if (m && year) return `${year}-${pad2(m[1])}-${pad2(m[2])}`;
  return '';
}
// 시간: 엑셀 시간(0.5416 = 13:00) · '13:00' · '오후 1:00' · '13시' → 'HH:MM', 정해지지 않은 말(오전·저녁~밤)은 그대로
function xlTime(v) {
  if (typeof v === 'number' && v >= 0 && v < 1) { const m = Math.round(v * 1440); return `${pad2(Math.floor(m / 60) % 24)}:${pad2(m % 60)}`; }
  const t = xlStr(v);
  if (!t) return '';
  const m = t.match(/^(오전|오후|아침|낮|저녁|밤)?\s*(\d{1,2})\s*(?::|시)\s*(\d{1,2})?\s*(분)?\s*(~.*)?$/);
  if (m) {
    let h = Number(m[2]);
    if (/오후|저녁|밤|낮/.test(m[1] || '') && h < 12) h += 12;
    if (m[1] === '오전' && h === 12) h = 0;
    if (h < 24) return `${pad2(h)}:${pad2(Number(m[3] || 0))}`;
  }
  return t;
}
// 정해지지 않은 시간말의 대략 순서 (같은 날 안에서 정렬용)
const XL_TIME_WORDS = [['새벽', 300], ['아침', 420], ['이른 저녁', 1050], ['늦은 오후', 960], ['오전', 540], ['점심', 720], ['낮', 780], ['오후', 840], ['저녁', 1110], ['밤', 1260]];
function xlTimeRank(t) {
  if (/^\d{2}:\d{2}$/.test(t || '')) return Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const w = XL_TIME_WORDS.find(([k]) => (t || '').startsWith(k));
  return w ? w[1] : null;
}
const xlNum = (v) => { if (typeof v === 'number') return v; const n = parseFloat(xlStr(v).replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : ''; };
const xlUrl = (v) => { const t = xlStr(v); return t ? cleanUrl(t) : ''; };

// 분류 이름 맞추기 (예전 양식의 '숙박'도 숙소로)
const XL_ALIAS = { 숙박: '숙소', 항공권: '항공', '투어/명소': '관광', 입장권: '관광', 명소: '관광', 투어: '관광', 식사: '식비', 렌트: '렌터카', 렌트카: '렌터카' };
function xlItemCat(v, title) { const k = xlNorm(v); const c = XL_ALIAS[k] === '식비' ? '식사' : XL_ALIAS[k] || k; return ITEM_CATS[c] ? c : guessCat(title); }
function xlBookType(v) { const k = xlNorm(v); const c = XL_ALIAS[k] || k; return BOOK_TYPES[c] ? c : '기타'; }
// 예약 종류 → 예산 분류
const XL_BOOK_TO_CAT = { 항공: '항공', 숙소: '숙소', 교통: '교통', 렌터카: '교통', 관광: '관광', 식당: '식비', 보험: '기타', 기타: '기타' };

/* ---------- 엑셀 → 계획 (읽기만) ---------- */
function xlParse(wb, fallbackYear) {
  const P = { info: null, cities: [], items: [], bookings: [], budget: [], checks: [], tips: [], warn: [], sheets: [] };
  const warn = (sheet, line, msg) => P.warn.push(`${sheet} ${line}행: ${msg}`);

  const info = xlTable(wb, '여행 정보', ['항목', '값']);
  let year = fallbackYear;
  if (info && !info.missing) {
    P.sheets.push('여행 정보');
    const kv = {};
    for (const x of info.rows) kv[xlNorm(info.get(x, '항목'))] = info.get(x, '값');
    const start = xlDate(kv['출발일']), end = xlDate(kv['도착일']);
    if (start) year = start.slice(0, 4);
    P.info = {
      title: xlStr(kv['여행이름']), emoji: xlStr(kv['아이콘']), places: xlStr(kv['여행지']),
      region: xlStr(kv['지역']) === '국내' ? '국내' : xlStr(kv['지역']) ? '해외' : '',
      start, end, people: Math.round(xlNum(kv['인원'])) || '', currency: xlStr(kv['통화']).toUpperCase(), rate: xlNum(kv['환율']),
    };
  }
  P.year = year;

  const cities = xlTable(wb, '날짜별 도시', ['날짜', '도시']);
  if (cities && !cities.missing) {
    P.sheets.push('날짜별 도시');
    for (const x of cities.rows) {
      const date = xlDate(cities.get(x, '날짜'), year), city = xlStr(cities.get(x, '도시'));
      if (date && city) P.cities.push({ date, city });
    }
  }

  const sch = xlTable(wb, '일정', ['날짜', '이름']);
  if (sch && !sch.missing) {
    P.sheets.push('일정');
    sch.rows.forEach((x, order) => {
      const title = xlStr(sch.get(x, '이름'));
      if (!title) return;
      const date = xlDate(sch.get(x, '날짜'), year);
      if (!date) return warn('일정', x.line, `날짜를 못 읽었어요 (${title})`);
      const cost = xlNum(sch.get(x, '예상 경비'));
      P.items.push({
        xid: xlStr(sch.get(x, 'ID')), date, order, line: x.line, title,
        time: xlTime(sch.get(x, '시간')), dur: xlStr(sch.get(x, '소요')), place: xlStr(sch.get(x, '장소')),
        cat: xlItemCat(sch.get(x, '분류'), title), memo: xlStr(sch.get(x, '메모')), cost: cost > 0 ? cost : '',
        ticketUrl: xlUrl(sch.get(x, '예매 링크')), link: xlUrl(sch.get(x, '참고 링크')),
      });
    });
  }

  const bk = xlTable(wb, '예약', ['종류', '이름']);
  if (bk && !bk.missing) {
    P.sheets.push('예약');
    for (const x of bk.rows) {
      const title = xlStr(bk.get(x, '이름'));
      if (!title) continue;
      const amount = xlNum(bk.get(x, '금액'));
      const st = xlStr(bk.get(x, '상태'));
      P.bookings.push({
        xid: xlStr(bk.get(x, 'ID')), line: x.line, title, type: xlBookType(bk.get(x, '종류')),
        date: xlDate(bk.get(x, '날짜'), year), end: xlDate(bk.get(x, '끝 날짜'), year), time: xlTime(bk.get(x, '시간')),
        status: BOOK_STATUS.includes(st) ? st : '', code: xlStr(bk.get(x, '예약번호')), amount: amount > 0 ? amount : '',
        memo: xlStr(bk.get(x, '메모')), link: xlUrl(bk.get(x, '링크')),
      });
    }
  }

  // 예산: 구분이 '예약'인 회색 줄은 예약 시트를 비춘 것이라 건너뛴다 (예약 금액은 예약에서 한 번만)
  const bd = xlTable(wb, '예산', ['분류', '금액']);
  if (bd && !bd.missing) {
    P.sheets.push('예산');
    for (const x of bd.rows) {
      if (xlStr(bd.get(x, '구분')) === '예약') continue;
      const raw = xlStr(bd.get(x, '분류')), amount = xlNum(bd.get(x, '금액'));
      if (!raw || !(amount > 0)) continue;
      let cat = XL_ALIAS[xlNorm(raw)] || xlNorm(raw);
      if (!CATS.includes(cat)) { warn('예산', x.line, `분류 "${raw}"를 몰라서 기타로 넣어요`); cat = '기타'; }
      P.budget.push({ cat, title: xlStr(bd.get(x, '상세')), amount });
    }
  }

  const ck = xlTable(wb, '체크리스트', ['할 일']);
  if (ck && !ck.missing) {
    P.sheets.push('체크리스트');
    for (const x of ck.rows) {
      const text = xlStr(ck.get(x, '할 일'));
      if (!text) continue;
      const g = xlStr(ck.get(x, '묶음'));
      P.checks.push({ xid: xlStr(ck.get(x, 'ID')), text, group: g || '지금 바로', done: /^(o|ㅇ|완료|v|✓|y)/i.test(xlStr(ck.get(x, '완료'))) });
    }
  }

  const tp = xlTable(wb, '맛집·팁', ['이름']);
  if (tp && !tp.missing) {
    P.sheets.push('맛집·팁');
    for (const x of tp.rows) {
      const name = xlStr(tp.get(x, '이름'));
      if (name) P.tips.push({ city: xlStr(tp.get(x, '도시')), kind: xlStr(tp.get(x, '분류')), name, desc: xlStr(tp.get(x, '설명')) });
    }
  }
  return P;
}

/* ---------- 앱 데이터와 맞춰 보기: 같은 항목 찾기 ---------- */
const xlKey = (s) => xlNorm(s).toLowerCase().replace(/[()·,.\-→>~/]/g, '');
// rows의 각 줄에 같은 앱 항목을 짝지음: ID가 같으면 그것, 없으면 이름이 같은 것(날짜까지 같은 것 먼저). 한 앱 항목은 한 번만.
function xlPair(rows, list, title, date) {
  const used = new Set();
  const byId = new Map(list.map((o) => [o.id, o]));
  const pick = (cands) => cands.find((o) => !used.has(o));
  for (const r of rows) {
    let o = r.xid && byId.get(r.xid);
    if (!o || used.has(o)) {
      const same = list.filter((x) => xlKey(title(x)) === xlKey(r.title || r.text));
      o = (date && pick(same.filter((x) => date(x) === r.date))) || pick(same);
    }
    r.match = o || null;
    if (o) used.add(o);
  }
  return list.filter((o) => !used.has(o)); // 엑셀에 없는 앱 항목
}

function xlPlan(trip, P) {
  // 고를 때마다(지금 여행/새 여행) 다시 짝지음. 새 여행이면 모두 '새로'
  const dates = new Map();
  if (trip) for (const d of trip.days) for (const it of d.items) dates.set(it, d.date);
  const pairItems = xlPair(P.items, [...dates.keys()], (x) => x.title, (x) => dates.get(x));
  const pairBooks = xlPair(P.bookings, trip ? trip.bookings : [], (x) => x.title, (x) => x.date);
  const pairChecks = xlPair(P.checks, trip ? trip.checklist : [], (x) => x.text, null);
  const changed = (r, o, keys) => keys.some((k) => String(r[k] ?? '') !== String(o[k] ?? ''));
  const IK = ['title', 'time', 'dur', 'place', 'cat', 'memo', 'cost', 'ticketUrl', 'link'];
  const BK = ['title', 'type', 'date', 'end', 'time', 'memo', 'link', 'amount'];
  const dayOf = (o) => trip && (trip.days.find((d) => d.items.includes(o)) || {}).date;
  const count = (rows, test) => {
    const c = { add: 0, upd: 0, same: 0 };
    for (const r of rows) c[!r.match ? 'add' : test(r) ? 'upd' : 'same']++;
    return c;
  };
  return {
    items: count(P.items, (r) => changed(r, r.match, IK) || dayOf(r.match) !== r.date),
    extraItems: pairItems,
    books: count(P.bookings, (r) => changed(r, r.match, BK) || (r.code && r.code !== r.match.code) || (r.status && r.status !== r.match.status)),
    extraBooks: pairBooks,
    checks: count(P.checks, (r) => r.text !== r.match.text || r.group !== r.match.group || (r.done && !r.match.done)),
    extraChecks: pairChecks,
  };
}

/* ---------- 미리보기 창 ---------- */
function excelPreview(wb, fileName) {
  const cur = focusTrip();
  const P = xlParse(wb, (cur && cur.start || todayStr()).slice(0, 4));
  if (!P.sheets.length) return toast('MasterTrip 양식의 시트(일정·예약·예산…)를 찾지 못했어요');
  const first = !cur || !cur.xlAt; // 이 여행에 처음 불러오는지 (처음이면 엑셀에 없는 앱 일정 지우기를 기본으로)
  const sum = (cat) => P.budget.filter((b) => b.cat === cat).reduce((a, b) => a + b.amount, 0)
    + P.bookings.filter((b) => b.status !== '취소' && XL_BOOK_TO_CAT[b.type] === cat).reduce((a, b) => a + (Number(b.amount) || 0), 0);
  const budgetLine = CATS.map((k) => [k, sum(k)]).filter(([, v]) => v).map(([k, v]) => `${k} ${korWon(v).replace(' 원', '')}`).join(' · ');
  const dates = P.items.map((r) => r.date).sort();

  const draw = (target) => {
    const trip = target === 'new' ? null : cur;
    const pl = xlPlan(trip, P);
    const c = (o) => [o.add && `새로 ${o.add}`, o.upd && `바뀜 ${o.upd}`, o.same && `그대로 ${o.same}`].filter(Boolean).join(' · ') || '없음';
    const names = (list, f) => list.slice(0, 4).map((o) => esc(f(o))).join(', ') + (list.length > 4 ? ` 외 ${list.length - 4}개` : '');
    const extra = (list, key, label, f, on) => (trip && list.length ? `
      <label class="xl-opt"><input type="checkbox" name="${key}" ${on ? 'checked' : ''}> 엑셀에 없는 앱 ${label} ${list.length}개 지우기
        <span class="muted small">${names(list, f)}</span></label>` : '');
    return `
      <div class="xl-row"><b>📅 일정</b> <span>${P.items.length}줄${dates.length ? ` · ${fmtDate(dates[0]).slice(3)}~${fmtDate(dates[dates.length - 1]).slice(3)}` : ''}</span><span class="muted small">${c(pl.items)}</span></div>
      ${extra(pl.extraItems, 'delItems', '일정', (o) => o.title, first)}
      <div class="xl-row"><b>📄 예약</b> <span>${P.bookings.length}개</span><span class="muted small">${c(pl.books)}</span></div>
      ${extra(pl.extraBooks, 'delBooks', '예약', (o) => o.title, first)}
      <div class="xl-row"><b>✅ 체크리스트</b> <span>${P.checks.length}개</span><span class="muted small">${c(pl.checks)} (앱의 기본 체크리스트는 그대로)</span></div>`;
  };

  openModal({
    title: '📄 엑셀 불러오기',
    saveLabel: '불러오기',
    html: `
      <p class="muted small" style="margin:-4px 0 10px">${esc(fileName)} · 읽은 시트: ${P.sheets.join(', ')}</p>
      <label class="field"><span>어디에 넣을까요?</span><select name="target" id="xlTarget">
        ${cur ? `<option value="cur">지금 여행: ${esc(cur.emoji)} ${esc(cur.title)}</option>` : ''}
        <option value="new" ${cur ? '' : 'selected'}>새 여행으로 만들기${P.info && P.info.title ? `: ${esc(P.info.title)}` : ''}</option>
      </select></label>
      <div id="xlSummary">${draw(cur ? 'cur' : 'new')}</div>
      ${P.info ? `<label class="xl-opt"><input type="checkbox" name="info" checked> 여행 정보도 엑셀대로 (이름·기간·인원·통화)
        <span class="muted small">${esc(P.info.title)} · ${P.info.start ? fmtDate(P.info.start) : '?'} ~ ${P.info.end ? fmtDate(P.info.end) : '?'}</span></label>` : ''}
      ${P.cities.length ? `<label class="xl-opt"><input type="checkbox" name="cities" checked> 날짜별 도시 ${P.cities.length}일 넣기</label>` : ''}
      ${P.budget.length || P.bookings.some((b) => b.amount) ? `<label class="xl-opt"><input type="checkbox" name="budget" checked> 예산을 엑셀대로 (예약 금액 + 직접 입력)
        <span class="muted small">${budgetLine || '0원'}</span></label>` : ''}
      ${P.tips.length ? `<label class="field"><span>🍽 맛집·팁 ${P.tips.length}개</span><select name="tips">
        <option value="scrap" ${first ? 'selected' : ''}>홈의 스크랩으로 넣기 (나중에 일정에 넣기)</option>
        <option value="none" ${first ? '' : 'selected'}>넣지 않기</option></select></label>` : ''}
      ${P.warn.length ? `<details class="xl-warn"><summary>⚠ 못 읽거나 바꿔 읽은 줄 ${P.warn.length}개</summary><ul>${P.warn.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}
      <p class="muted small">앱에서 넣은 장소 위치·바우처·사진·완료 체크·지출은 그대로 남아요. 불러온 뒤 몇 초 동안 [되돌리기]를 누를 수 있어요.</p>`,
    onSave: (d) => { excelApply(cur, P, d); },
  });
  const sel = $('#xlTarget');
  sel.onchange = () => { $('#xlSummary').innerHTML = draw(sel.value); };
}

/* ---------- 넣기 ---------- */
function excelApply(cur, P, d) {
  commitDelete(); // 앞에서 지운 것은 확정
  const snap = JSON.stringify(state);
  const held = blobHold = [];
  let trip, msg;
  try {
    ({ trip, msg } = xlApplyInner(d.target === 'new' ? null : cur, P, d));
  } finally { blobHold = null; }
  save();
  pickTrip(trip.id);
  selectedDate = null;
  subTab = 'plan';
  remember('sub', subTab);
  setMain('trips');
  pendingDelete = { held, timer: setTimeout(commitDelete, 10000) };
  toast(msg, {
    label: '되돌리기',
    run: () => {
      if (!pendingDelete || pendingDelete.held !== held) return toast('이미 확정됐어요');
      clearTimeout(pendingDelete.timer);
      pendingDelete = null;
      state = migrate(JSON.parse(snap));
      save();
      render();
      toast('불러오기 전으로 되돌렸어요');
    },
  });
}

function xlApplyInner(trip, P, d) {
  const I = P.info || {};
  if (!trip) {
    const region = I.region || '해외';
    const start = I.start || P.items.map((r) => r.date).sort()[0] || todayStr();
    const end = I.end || P.items.map((r) => r.date).sort().slice(-1)[0] || start;
    const tpl = newTripTemplate(region);
    trip = normalizeTrip({
      id: 'trip-' + uid(), title: I.title || '엑셀에서 불러온 여행', emoji: I.emoji || '✈️', places: I.places || '', region,
      people: I.people || 2, currency: I.currency || (region === '국내' ? 'KRW' : 'EUR'), start, end,
      days: buildDays(start, end, []), checklist: tpl.checklist, contacts: tpl.contacts,
      budget: { rate: I.rate || 1, rateAuto: !I.rate, plan: Object.fromEntries(CATS.map((k) => [k, 0])) },
    });
    state.trips.push(trip);
    d.info = ''; // 새 여행은 이미 엑셀 정보로 만들었음
  }
  if (d.info && P.info) {
    for (const k of ['title', 'emoji', 'places', 'region', 'people', 'currency']) if (I[k]) trip[k] = I[k];
    if (I.rate > 0) Object.assign(trip.budget, { rate: I.rate, rateAuto: false });
    if (I.start && I.end && I.end >= I.start && (I.start !== trip.start || I.end !== trip.end)) {
      trip.start = I.start; trip.end = I.end;
      trip.days = buildDays(I.start, I.end, trip.days); // 기간 밖으로 빠진 날의 일정은 사라짐 (되돌리기 가능)
    }
  }
  const dayOf = (date) => trip.days.find((x) => x.date === date);
  if (d.cities) for (const c of P.cities) { const day = dayOf(c.date); if (day) day.city = c.city; }

  // 일정
  const plan = xlPlan(trip, P);
  let added = 0, outside = 0;
  const touched = new Set();
  for (const r of P.items) {
    const day = dayOf(r.date);
    if (!day) { outside++; continue; }
    let it = r.match;
    if (it) {
      const from = trip.days.find((x) => x.items.includes(it));
      if (from && from !== day) { from.items = from.items.filter((x) => x !== it); day.items.push(it); touched.add(from); delete it.move; }
      if (xlKey(it.place) !== xlKey(r.place)) { delete it.lat; delete it.lng; delete it.geo; } // 장소가 바뀌면 위치 다시 찾기
    } else {
      it = { id: uid(), done: false, bookingId: '' };
      day.items.push(it);
      added++;
    }
    Object.assign(it, { title: r.title, time: r.time, dur: r.dur, place: r.place, cat: r.cat, memo: r.memo, cost: r.cost, ticketUrl: r.ticketUrl });
    if (r.link) it.link = r.link; else delete it.link;
    it._xo = r.order;
    touched.add(day);
  }
  if (d.delItems) for (const it of plan.extraItems) {
    for (const day of trip.days) if (day.items.includes(it)) { day.items = day.items.filter((x) => x !== it); touched.add(day); }
    if (it.photo) deletePhotos([it.photo]);
  }
  // 손댄 날은 시간 순으로 (정해지지 않은 시간은 바로 앞 일정 다음 자리, 엑셀 줄 순서 유지)
  for (const day of touched) {
    let last = -1;
    const keyed = day.items.map((it, i) => { const r = xlTimeRank(it.time); if (r != null) last = r; return { it, k: r != null ? r : last, o: it._xo ?? 1e6 + i }; });
    keyed.sort((a, b) => a.k - b.k || a.o - b.o);
    day.items = keyed.map((x) => x.it);
  }
  for (const day of trip.days) for (const it of day.items) delete it._xo;

  // 예약 (예약번호·상태가 엑셀에서 비어 있으면 앱 것을 지운다 대신 그대로 둔다. 바우처는 항상 그대로)
  for (const r of P.bookings) {
    let b = r.match;
    if (!b) { b = { id: uid(), code: '', vouchers: [] }; trip.bookings.push(b); }
    Object.assign(b, { type: r.type, title: r.title, date: r.date, end: r.end, time: r.time, amount: r.amount, memo: r.memo, link: r.link });
    if (r.code) b.code = r.code;
    if (r.status) b.status = r.status;
  }
  if (d.delBooks) for (const b of plan.extraBooks) {
    deleteVouchers(b.vouchers);
    trip.bookings = trip.bookings.filter((x) => x !== b);
    for (const day of trip.days) for (const it of day.items) if (it.bookingId === b.id) it.bookingId = '';
  }

  // 예산 = 예약 금액(취소 제외, 종류→분류) + 예산 시트 직접 입력
  if (d.budget) {
    const pl = Object.fromEntries(CATS.map((k) => [k, 0]));
    for (const b of trip.bookings) if (b.status !== '취소' && Number(b.amount) > 0) pl[XL_BOOK_TO_CAT[b.type] || '기타'] += Number(b.amount);
    for (const b of P.budget) pl[b.cat] += b.amount;
    trip.budget.plan = pl;
  }

  // 체크리스트 (엑셀에 없는 앱 항목은 지우지 않음 — 기본 체크리스트가 있어서)
  for (const r of P.checks) {
    let c = r.match;
    if (!c) { c = { id: uid(), due: null, done: false }; trip.checklist.push(c); }
    Object.assign(c, { text: r.text, group: r.group });
    if (r.done) c.done = true;
  }

  // 맛집·팁 → 스크랩 (이미 같은 이름이 있으면 건너뜀)
  let tipN = 0;
  if (d.tips === 'scrap') {
    const have = new Set(scraps().map((s) => xlKey(s.title)));
    for (const t of P.tips) {
      if (have.has(xlKey(t.name))) continue;
      scraps().push({ id: 'sc-' + uid(), title: t.name, memo: [t.city, t.kind, t.desc].filter(Boolean).join(' · '), url: '', photo: '', at: todayStr() });
      tipN++;
    }
  }

  trip.xlAt = todayStr();
  autoLinkBookings(trip);
  normalizeTrip(trip);
  // 알림은 짧게 (길면 [되돌리기] 버튼이 화면 밖으로 밀림)
  const msg = outside ? `불러왔어요 · 기간 밖 일정 ${outside}개는 뺐어요` : `불러왔어요 · 일정 ${P.items.length} · 예약 ${P.bookings.length}`;
  return { trip, msg };
}

/* ---------- 앱 → 엑셀 내보내기 (같은 양식, ID 채움) ---------- */
async function excelExport(trip) {
  if (!trip) return;
  let X;
  try { X = await loadXLSX(); } catch (e) { return toast(e.message); }
  const serial = (ymd) => { if (!ymd) return ''; const [y, m, dd] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, dd) / 864e5 + 25569; };
  const wb = X.utils.book_new();
  const DATE = 'yyyy-mm-dd (aaa)', MONEY = '#,##0';
  const add = (name, note, head, rows, widths, fmt = {}) => {
    const ws = X.utils.aoa_to_sheet([[note], head, ...rows]);
    ws['!cols'] = widths.map((w) => ({ wch: w }));
    rows.forEach((row, i) => row.forEach((v, c) => {
      const cell = ws[X.utils.encode_cell({ r: i + 2, c })];
      if (cell && fmt[c] && typeof v === 'number') cell.z = fmt[c];
    }));
    X.utils.book_append_sheet(wb, ws, name);
    return ws;
  };
  add('안내', 'MasterTrip에서 내보낸 계획표', ['이 파일을 고친 뒤 앱 → 일정 탭 → 📄 엑셀 불러오기로 다시 넣으면 바뀐 것만 반영돼요. ID 칸은 지우지 마세요.'], [
    [`내보낸 날: ${todayStr()}`], ['고르기 목록·색은 빠져 있어요. 보기 좋게 쓰려면 원래 양식 파일에 붙여 넣어도 돼요 (ID 열도 같이).'],
  ], [100]);
  add('여행 정보', '값 칸(B)만 채우세요.', ['항목', '값', '설명'], [
    ['여행 이름', trip.title, ''], ['아이콘', trip.emoji, ''], ['여행지', trip.places, ''], ['지역', trip.region, '해외 / 국내'],
    ['출발일', serial(trip.start), ''], ['도착일', serial(trip.end), ''], ['인원', trip.people, ''], ['통화', trip.currency, ''],
    ['환율', trip.budget.rateAuto ? '' : trip.budget.rate, '비우면 자동'], ['양식 버전', '1', ''],
  ], [14, 34, 20], { 1: DATE });
  ['출발일', '도착일'].forEach((k, i) => { const c = wb.Sheets['여행 정보'][`B${7 + i}`]; if (c) c.z = DATE; });
  add('날짜별 도시', '날마다 머무는 도시', ['날짜', '도시', '숙소', '메모'], trip.days.map((d) => [serial(d.date), d.city, '', '']), [18, 28, 26, 30], { 0: DATE });
  const items = trip.days.flatMap((d) => d.items.map((it) => [it.id, serial(d.date), it.time || '', it.dur || '', it.title, it.place || '', it.cat || '',
    it.memo || '', Number(it.cost) || '', it.ticketUrl || '', it.link || '']));
  add('일정', '한 줄 = 일정 하나. ID는 지우지 마세요.', ['ID', '날짜', '시간', '소요', '이름', '장소(영문·검색어)', '분류', '메모', '예상 경비(€)', '예매 링크', '참고 링크'],
    items, [14, 16, 10, 10, 40, 30, 9, 36, 12, 22, 22], { 1: DATE, 8: MONEY });
  const books = [...trip.bookings].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
  add('예약', '숙소·렌터카는 날짜=시작, 끝 날짜=체크아웃·반납.', ['ID', '종류', '이름', '날짜', '끝 날짜', '시간', '상태', '예약번호', '금액(원)', '메모', '링크'],
    books.map((b) => [b.id, b.type, b.title, serial(b.date), serial(b.end), b.time || '', b.status || '', b.code || '', Number(b.amount) || '', b.memo || '', b.link || '']),
    [14, 9, 38, 16, 16, 9, 10, 16, 13, 30, 22], { 3: DATE, 4: DATE, 8: MONEY });
  // 예산: 앱 예산에서 예약 금액을 뺀 나머지를 '직접' 줄로 (다시 불러오면 예약 금액 + 이 줄 = 같은 예산)
  const booked = Object.fromEntries(CATS.map((k) => [k, 0]));
  for (const b of trip.bookings) if (b.status !== '취소' && Number(b.amount) > 0) booked[XL_BOOK_TO_CAT[b.type] || '기타'] += Number(b.amount);
  const direct = CATS.map((k) => [k, Math.max(0, (Number(trip.budget.plan[k]) || 0) - booked[k])]).filter(([, v]) => v > 0);
  add('예산', '예약 금액은 예약 시트에서 자동으로 더해져요. 여기는 예약이 없는 돈만 "직접"으로.', ['구분', '분류', '상세 내역', '금액(원)', '메모'],
    direct.map(([k, v]) => ['직접', k, `${k} 예산 (예약 제외분)`, v, '']), [7, 9, 30, 14, 30], { 3: MONEY });
  add('체크리스트', '완료는 O로 표시.', ['ID', '묶음', '할 일', '완료'], trip.checklist.map((c) => [c.id, c.group, c.text, c.done ? 'O' : '']), [14, 14, 60, 8]);
  add('맛집·팁', '도시별 추천 (불러올 때 스크랩으로 넣을 수 있어요)', ['도시', '분류', '이름', '설명'], [], [12, 14, 26, 60]);

  const out = X.write(wb, { bookType: 'xlsx', type: 'array' });
  const name = `${trip.title.replace(/[\\/:*?"<>|]/g, '').trim() || '여행'}_계획표_${todayStr()}.xlsx`;
  const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`엑셀로 저장했어요 (${name})`);
}
