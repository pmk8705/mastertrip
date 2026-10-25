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

// 유명 관광지 → 공식 운영 주체 사이트만 (재판매·대행 사이트 금지). url이 없는 곳은 공식 판매처를 확인하지 못해 예약 연결에만 쓴다.
// 2026-10-23 확인: 각 사이트를 열어 운영 주체 이름·공식 표기와 티켓 페이지를 확인함.
const SIGHTS = [
  { name: '사그라다 파밀리아', re: /사그라다|sagrada/i, url: 'https://sagradafamilia.org/en/tickets' }, // Junta Constructora del Temple Expiatori de la Sagrada Família
  { name: '알함브라', re: /알함브라|alhambra/i, url: 'https://tickets.alhambra-patronato.es/' }, // Patronato de la Alhambra y Generalife 공식 사이트가 연결하는 판매처
  { name: '구엘 공원', re: /구엘\s*공원|park\s*g[üu]ell|parc\s*g[üu]ell/i, url: 'https://parkguell.barcelona/en/buy-tickets' }, // Barcelona de Serveis Municipals
  { name: '카사 바트요', re: /바트요|batll[oó]/i, url: 'https://www.casabatllo.es/en/online-tickets/' },
  { name: '카사 밀라', re: /카사\s*밀라|페드레라|casa\s*mil[aà]|pedrera/i, url: 'https://www.lapedrera.com/en/tickets/' }, // Fundació Catalunya La Pedrera
  { name: '세비야 대성당', re: /세비야\s*대성당|히랄다|catedral\s*de\s*sevilla|seville\s*cathedral|giralda/i, url: 'https://tickets.catedraldesevilla.eu/' }, // 공식 사이트(catedraldesevilla.es)가 연결하는 판매처
  { name: '세비야 알카사르', re: /알카사르|real\s*alc[aá]zar|alc[aá]zar\s*de\s*sevilla/i, url: 'https://alcazardesevilla.infoticketing.com/es' }, // 공식 사이트(alcazarsevilla.org '방문 준비')가 연결하는 판매처. 비슷한 이름의 realalcazarsevilla.org는 대행이라 넣지 않음
];
const sightsOf = (it) => SIGHTS.filter((s) => s.re.test(`${it.title || ''} ${it.place || ''}`));

function normalizeTrip(t) {
  t.emoji = t.emoji || '✈️';
  t.places = t.places || '';
  t.region = t.region || '해외';
  t.people = t.people || 2; // 여행 인원 (숙소·항공 찾기)
  t.currency = t.currency || (t.region === '국내' ? 'KRW' : 'EUR');
  for (const k of ['days', 'checklist', 'expenses', 'bookings', 'contacts']) if (!Array.isArray(t[k])) t[k] = [];
  for (const d of t.days) {
    d.items = d.items || [];
    for (const it of d.items) {
      if (!it.cat) it.cat = guessCat(it.title);
      if (it.dur == null) it.dur = '';
      if (it.cost == null) it.cost = '';
      if (it.ticketUrl == null) it.ticketUrl = '';
    }
  }
  autoLinkBookings(t);
  t.budget = t.budget || {};
  t.budget.rate = t.budget.rate || 1;
  if (t.budget.rateAuto == null) t.budget.rateAuto = true; // 환율 자동 (하루 한 번 갱신). 직접 입력하면 false
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

// 한국인이 많이 가는 나라 30곳 (Gemini 정리 2026-10-25). 여행지 칸의 나라·도시 이름으로 통화를 골라 준다.
// 통화마다 환율은 fetchRate가 받는다 (VND·TWD·MOP·MNT·LAK·AED는 Frankfurter에 없어 open.er-api.com)
const COUNTRIES = [
  { name: '일본', flag: '🇯🇵', cur: 'JPY', unit: '엔', sym: '¥', words: '도쿄 오사카 교토 후쿠오카 삿포로 홋카이도 오키나와 나고야 고베 요코하마 유후인 벳푸 가고시마 시즈오카 하코네' },
  { name: '베트남', flag: '🇻🇳', cur: 'VND', unit: '동', sym: '₫', words: '다낭 하노이 호치민 나트랑 냐짱 푸꾸옥 호이안 달랏 하롱 사파' },
  { name: '태국', flag: '🇹🇭', cur: 'THB', unit: '바트', sym: '฿', words: '방콕 푸켓 치앙마이 파타야 코사무이 끄라비 후아힌' },
  { name: '대만', flag: '🇹🇼', cur: 'TWD', unit: '대만 달러', sym: 'NT$', words: '타이베이 타이페이 가오슝 타이중 타이난 지우펀 화롄' },
  { name: '필리핀', flag: '🇵🇭', cur: 'PHP', unit: '페소', sym: '₱', words: '세부 보라카이 마닐라 보홀 클락 팔라완' },
  { name: '미국', flag: '🇺🇸', cur: 'USD', unit: '달러', sym: '$', words: '하와이 호놀룰루 괌 사이판 뉴욕 로스앤젤레스 라스베이거스 샌프란시스코 시애틀 마우이' },
  { name: '중국', flag: '🇨🇳', cur: 'CNY', unit: '위안', sym: '¥', words: '상하이 베이징 북경 칭다오 장가계 청두 시안 하이난 하얼빈 백두산' },
  { name: '홍콩', flag: '🇭🇰', cur: 'HKD', unit: '홍콩 달러', sym: 'HK$', words: '' },
  { name: '마카오', flag: '🇲🇴', cur: 'MOP', unit: '파타카', sym: 'MOP$', words: '' },
  { name: '싱가포르', flag: '🇸🇬', cur: 'SGD', unit: '싱가포르 달러', sym: 'S$', words: '센토사' },
  { name: '말레이시아', flag: '🇲🇾', cur: 'MYR', unit: '링깃', sym: 'RM', words: '코타키나발루 쿠알라룸푸르 랑카위 페낭' },
  { name: '인도네시아', flag: '🇮🇩', cur: 'IDR', unit: '루피아', sym: 'Rp', words: '발리 자카르타 롬복 우붓' },
  { name: '호주', flag: '🇦🇺', cur: 'AUD', unit: '호주 달러', sym: 'A$', words: '시드니 멜버른 브리즈번 골드코스트 케언스 퍼스' },
  { name: '프랑스', flag: '🇫🇷', cur: 'EUR', unit: '유로', sym: '€', words: '파리 니스 몽생미셸 리옹 마르세유' },
  { name: '이탈리아', flag: '🇮🇹', cur: 'EUR', unit: '유로', sym: '€', words: '로마 피렌체 베네치아 베니스 밀라노 나폴리 아말피 돌로미티' },
  { name: '스페인', flag: '🇪🇸', cur: 'EUR', unit: '유로', sym: '€', words: '바르셀로나 마드리드 세비야 그라나다 마요르카 말라가 론다' },
  { name: '영국', flag: '🇬🇧', cur: 'GBP', unit: '파운드', sym: '£', words: '런던 에든버러 맨체스터 리버풀' },
  { name: '체코', flag: '🇨🇿', cur: 'CZK', unit: '코루나', sym: 'Kč', words: '프라하 체스키크룸로프' },
  { name: '스위스', flag: '🇨🇭', cur: 'CHF', unit: '프랑', sym: 'CHF', words: '취리히 인터라켄 제네바 루체른 체르마트 융프라우' },
  { name: '몽골', flag: '🇲🇳', cur: 'MNT', unit: '투그릭', sym: '₮', words: '울란바토르 고비' },
  { name: '독일', flag: '🇩🇪', cur: 'EUR', unit: '유로', sym: '€', words: '프랑크푸르트 뮌헨 베를린 하이델베르크 퓌센 로텐부르크 쾰른 함부르크' },
  { name: '오스트리아', flag: '🇦🇹', cur: 'EUR', unit: '유로', sym: '€', words: '비엔나 잘츠부르크 할슈타트 인스브루크' }, // '빈'은 다른 낱말에 너무 많이 들어가서 뺌
  { name: '캐나다', flag: '🇨🇦', cur: 'CAD', unit: '캐나다 달러', sym: 'C$', words: '밴쿠버 토론토 밴프 로키 퀘벡 몬트리올 옐로나이프' },
  { name: '튀르키예', flag: '🇹🇷', cur: 'TRY', unit: '리라', sym: '₺', words: '터키 이스탄불 카파도키아 안탈리아 파묵칼레' },
  { name: '뉴질랜드', flag: '🇳🇿', cur: 'NZD', unit: '뉴질랜드 달러', sym: 'NZ$', words: '오클랜드 퀸스타운 크라이스트처치' },
  { name: '포르투갈', flag: '🇵🇹', cur: 'EUR', unit: '유로', sym: '€', words: '리스본 포르투 신트라' },
  { name: '라오스', flag: '🇱🇦', cur: 'LAK', unit: '킵', sym: '₭', words: '비엔티안 방비엥 루앙프라방' },
  { name: '헝가리', flag: '🇭🇺', cur: 'HUF', unit: '포린트', sym: 'Ft', words: '부다페스트' },
  { name: '아랍에미리트', flag: '🇦🇪', cur: 'AED', unit: '디르함', sym: 'Dh', words: 'UAE 두바이 아부다비' }, // 아랍 글자 기호는 오른쪽→왼쪽이라 줄이 뒤섞여서 Dh
  { name: '멕시코', flag: '🇲🇽', cur: 'MXN', unit: '페소', sym: 'Mex$', words: '칸쿤' },
];
// 통화 고르기 목록: 나라마다 한 줄, 가나다순 (유로 나라도 따로 — 나라 이름으로 찾기 쉽게). 값은 나라 이름, 저장은 통화
const COUNTRY_OPTIONS = [...COUNTRIES].sort((a, b) => a.name.localeCompare(b.name, 'ko'))
  .map((c) => ({ v: c.name, l: `${c.flag} ${c.name}, ${c.unit} (${c.cur}/${c.sym})` }));
const curOf = (name) => (COUNTRIES.find((c) => c.name === name) || {}).cur || '';
// 글에서 가장 먼저 나오는 나라·도시 (같은 자리면 긴 이름: '베니스'가 '니스'보다 먼저)
function guessCountry(text) {
  let best = null;
  for (const c of COUNTRIES) {
    for (const w of [c.name, ...c.words.split(' ').filter(Boolean)]) {
      const i = text.indexOf(w);
      if (i >= 0 && (!best || i < best.i || (i === best.i && w.length > best.w.length))) best = { i, w, c };
    }
  }
  return best && best.c;
}
const SYMBOLS = { EUR: '€', USD: '$', JPY: '¥', GBP: '£', CNY: '¥' };
function won(n) { return Math.round(n).toLocaleString('ko-KR') + '원'; }
function money(n, cur) {
  if (cur === 'KRW') return won(n);
  const v = (Math.round(n * 100) / 100).toLocaleString('ko-KR');
  return SYMBOLS[cur] ? SYMBOLS[cur] + v : `${v} ${cur}`;
}
// 1단위 = ?원. 원 단위가 작은 통화(엔 8.447, 동 0.0513)도 유효숫자 4자리
const roundRate = (r) => (r >= 1000 ? Math.round(r * 10) / 10 : Number(r.toPrecision(4)));

/* ---------- 환율 자동 ---------- */
// Frankfurter(유럽중앙은행, 키 없음, 평일 갱신) → 없는 통화(TWD·VND 등)는 open.er-api.com
async function fetchRate(cur) {
  try {
    const r = await fetch(`https://api.frankfurter.dev/v1/latest?base=${cur}&symbols=KRW`);
    if (r.ok) {
      const j = await r.json();
      if (j.rates && j.rates.KRW > 0) return { rate: j.rates.KRW, date: j.date };
    }
  } catch (e) { /* 아래 예비 사이트로 */ }
  const r = await fetch(`https://open.er-api.com/v6/latest/${cur}`);
  const j = await r.json();
  if (j.result !== 'success' || !(j.rates && j.rates.KRW > 0)) throw new Error('환율 없음: ' + cur);
  return { rate: j.rates.KRW, date: ymd(new Date(j.time_last_update_unix * 1000)) };
}

// 자동 환율 여행만, 하루 한 번 (force = 지금 바로). 실패하면 마지막 환율 그대로 둔다.
let rateBusy = false;
async function refreshRates(force) {
  if (rateBusy || !navigator.onLine) return;
  const today = todayStr();
  const due = state.trips.filter((t) => t.currency !== 'KRW' && t.budget.rateAuto && (force || t.budget.rateAt !== today));
  if (!due.length) return;
  rateBusy = true;
  const got = {};
  for (const cur of new Set(due.map((t) => t.currency))) {
    try { got[cur] = await fetchRate(cur); } catch (e) { console.warn('환율 불러오기 실패', cur, e); }
  }
  rateBusy = false;
  let changed = false;
  for (const t of due) {
    const g = got[t.currency];
    if (!g) continue;
    Object.assign(t.budget, { rate: roundRate(g.rate), rateDate: g.date, rateAt: today });
    changed = true;
  }
  if (changed) { save(); render(); }
}
function rateNote(trip) {
  const b = trip.budget;
  if (!b.rateAuto) return '직접 입력';
  return b.rateDate ? `자동 · ${b.rateDate.slice(5).replace('-', '/')} 기준` : '자동 · 인터넷 연결 때 불러와요';
}

/* ---------- 현지 날씨 (Open-Meteo, 키 없음) ---------- */
// 오늘부터 16일 안은 예보, 그 뒤는 지난해 같은 날 실제 날씨(참고). 폰에만 저장하고 백업에는 넣지 않는다.
const WX_KEY = 'mastertrip-weather';
const FORECAST_DAYS = 16;
const wx = (() => { try { return JSON.parse(localStorage.getItem(WX_KEY)) || {}; } catch (e) { return {}; } })();
wx.geo = wx.geo || {}; // 도시 이름 → { lat, lng } (못 찾으면 lat: null)
wx.days = wx.days || {}; // '위도,경도|날짜' → { k: 'fc'(예보)|'past'(지난해), hi, lo, code, pop, ref, at }
function saveWx() {
  const today = todayStr();
  for (const k of Object.keys(wx.days)) if (k.split('|')[1] < today) delete wx.days[k]; // 지난 날은 지움
  try { localStorage.setItem(WX_KEY, JSON.stringify(wx)); } catch (e) { /* 저장 못 해도 화면은 그대로 */ }
}

// WMO 날씨 코드 → [이 번호까지, 그림, 말]
const WX_CODES = [[0, '☀️', '맑음'], [1, '🌤️', '대체로 맑음'], [2, '⛅', '구름 조금'], [3, '☁️', '흐림'], [48, '🌫️', '안개'],
  [57, '🌦️', '약한 비'], [67, '🌧️', '비'], [77, '🌨️', '눈'], [82, '🌦️', '소나기'], [86, '🌨️', '눈'], [99, '⛈️', '뇌우']];
const wxLook = (code) => WX_CODES.find(([max]) => code <= max) || WX_CODES[WX_CODES.length - 1];

// 그날 머무는 도시 (이동하는 날은 도착 도시)
function wxPlace(day) {
  const city = dayCities(day).pop();
  const g = city && wx.geo[city];
  return g && g.lat != null ? { city, lat: g.lat, lng: g.lng } : null;
}
const wxKey = (p, date) => `${p.lat},${p.lng}|${date}`;
// 참고용 날짜: 일주일 전보다 앞선 해의 같은 날 (2/29는 2/28)
function wxRefDate(date) {
  const limit = addDays(todayStr(), -7);
  let y = Number(date.slice(0, 4)) - 1;
  const md = date.slice(5) === '02-29' ? '02-28' : date.slice(5);
  while (`${y}-${md}` > limit) y--;
  return `${y}-${md}`;
}

// 같은 이름 도시가 여럿이면 여행 중앙에서 가까운 곳, 아니면 인구 많은 곳.
// Open-Meteo 지명 검색은 한글 이름의 큰 도시를 놓치기도 해서(인천 → 전남의 작은 마을) 그럴 땐 Nominatim으로.
const round2 = (n) => Math.round(n * 100) / 100;
async function wxGeocode(city, center) {
  const nearest = (list) => (center ? list.filter((x) => distKm(center, x) < FAR_KM).sort((a, b) => distKm(center, a) - distKm(center, b))[0] : null);
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=10&language=ko`);
  if (!r.ok) throw new Error('도시 검색 ' + r.status);
  const list = ((await r.json()).results || []).map((x) => ({ lat: x.latitude, lng: x.longitude, pop: x.population || 0 }));
  const hit = nearest(list) || list.sort((a, b) => b.pop - a.pop).find((x) => x.pop > 0);
  const best = hit || (await (async () => { const n = await geocode(city, 5, center); return nearest(n) || n[0]; })());
  return best ? { lat: round2(best.lat), lng: round2(best.lng) } : { lat: null };
}
// 일정 위치가 부족하면 이미 찾은 다른 도시들의 가운데를 기준으로
function wxCenter(trip) {
  const pts = trip.days.map(wxPlace).filter(Boolean);
  if (tripCenter(trip) || !pts.length) return tripCenter(trip);
  const mid = (arr) => { const a = [...arr].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  return { lat: mid(pts.map((p) => p.lat)), lng: mid(pts.map((p) => p.lng)) };
}

async function wxFetch(p, kind, dates) {
  const fc = kind === 'fc';
  const when = fc ? (s) => s : wxRefDate;
  const url = fc ? 'https://api.open-meteo.com/v1/forecast' : 'https://archive-api.open-meteo.com/v1/archive';
  const daily = 'weather_code,temperature_2m_max,temperature_2m_min' + (fc ? ',precipitation_probability_max' : '');
  const r = await fetch(`${url}?latitude=${p.lat}&longitude=${p.lng}&daily=${daily}&timezone=auto&start_date=${when(dates[0])}&end_date=${when(dates[dates.length - 1])}`);
  if (!r.ok) throw new Error('날씨 ' + r.status);
  const d = (await r.json()).daily;
  const out = {};
  for (const date of dates) {
    const i = d.time.indexOf(when(date));
    if (i < 0 || d.temperature_2m_max[i] == null) continue;
    out[wxKey(p, date)] = {
      k: kind, hi: Math.round(d.temperature_2m_max[i]), lo: Math.round(d.temperature_2m_min[i]), code: d.weather_code[i],
      pop: fc ? d.precipitation_probability_max[i] : null, ref: fc ? null : when(date).slice(0, 4), at: Date.now(),
    };
  }
  return out;
}

// 화면을 그릴 때마다 부르지만, 필요한 것(새 도시, 3시간 지난 예보, 예보 범위에 들어온 날)만 받는다.
let wxBusy = false, wxFailAt = 0;
async function refreshWeather(trip) {
  if (!trip || wxBusy || !navigator.onLine || Date.now() - wxFailAt < 5 * 60e3) return;
  const today = todayStr();
  const last = addDays(today, FORECAST_DAYS - 1);
  const days = trip.days.filter((d) => d.date >= today);
  wxBusy = true;
  let changed = false;
  try {
    for (const d of days) {
      const city = dayCities(d).pop();
      if (city && !wx.geo[city]) { wx.geo[city] = await wxGeocode(city, wxCenter(trip)); changed = true; }
    }
    const groups = {}; // 위치·종류별로 모아 한 번에 받는다
    for (const d of days) {
      const p = wxPlace(d);
      if (!p) continue;
      const kind = d.date <= last ? 'fc' : 'past';
      const c = wx.days[wxKey(p, d.date)];
      if (c && (kind === 'past' ? c.k === 'past' : Date.now() - c.at < 3 * 3600e3)) continue; // 예보는 3시간마다
      (groups[`${wxKey(p, '')}${kind}`] ||= { p, kind, dates: [] }).dates.push(d.date);
    }
    for (const g of Object.values(groups)) {
      const got = await wxFetch(g.p, g.kind, g.dates);
      // 예보 마지막 날은 비어 오기도 한다 → 지난해 값으로. 그래도 없으면 빈 칸으로 기억해 되풀이 요청을 막는다.
      const miss = () => g.dates.filter((d) => !got[wxKey(g.p, d)]);
      if (g.kind === 'fc' && miss().length) Object.assign(got, await wxFetch(g.p, 'past', miss()));
      for (const d of miss()) got[wxKey(g.p, d)] = { k: g.kind, code: null, at: Date.now() };
      Object.assign(wx.days, got);
      changed = true;
    }
  } catch (e) {
    console.warn('날씨 불러오기 실패', e);
    wxFailAt = Date.now();
  }
  wxBusy = false;
  if (changed) { saveWx(); render(); }
}

function wxHtml(day) {
  if (day.date < todayStr()) return '';
  const p = wxPlace(day);
  const w = p && wx.days[wxKey(p, day.date)];
  if (!w || w.code == null) return '';
  const [, icon, text] = wxLook(w.code);
  const where = dayCities(day).length > 1 ? `${esc(p.city)} ` : '';
  if (w.k === 'fc') return `<div class="wx">${where}${icon} ${text} <b>${w.hi}°</b> / ${w.lo}°${w.pop ? ` · 비 ${w.pop}%` : ''}</div>`;
  return `<div class="wx past">${where}${icon} ${text} ${w.hi}° / ${w.lo}° <span>· ${w.ref}년 같은 날 (참고)</span></div>`;
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

/* ============ 여행 표지 사진 · 바우처 (IndexedDB) ============ */
// 사진은 localStorage(약 5MB)에 넣기엔 커서 IndexedDB에 Blob으로 저장한다.
// covers: 여행 id → 표지 사진 / vouchers: 바우처 id → 티켓 사진·PDF (목록은 booking.vouchers에)
let mediaDb;
const openMedia = () => mediaDb || (mediaDb = new Promise((res, rej) => {
  const r = indexedDB.open('mastertrip-media', 2);
  r.onupgradeneeded = () => {
    for (const name of ['covers', 'vouchers']) if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name);
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
}));
function mediaStore(name) {
  const run = async (mode, fn) => {
    const db = await openMedia();
    return new Promise((res, rej) => {
      const tx = db.transaction(name, mode);
      const req = fn(tx.objectStore(name));
      tx.oncomplete = () => res(req && req.result);
      tx.onerror = () => rej(tx.error);
    });
  };
  return {
    get: (k) => run('readonly', (st) => st.get(k)),
    set: (k, v) => run('readwrite', (st) => st.put(v, k)),
    del: (k) => run('readwrite', (st) => st.delete(k)),
    clear: () => run('readwrite', (st) => st.clear()),
    keys: () => run('readonly', (st) => st.getAllKeys()),
    values: () => run('readonly', (st) => st.getAll()),
  };
}
const media = mediaStore('covers');
const voucherDb = mediaStore('vouchers');
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
async function shrinkImage(file, max = 1200, quality = 0.82) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
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
    input = `<select ${attrs}>${f.options.map((o) => (typeof o === 'object'
      ? `<option value="${esc(o.v)}" ${o.v === f.value ? 'selected' : ''}>${esc(o.l)}</option>`
      : `<option ${o === f.value ? 'selected' : ''}>${esc(o)}</option>`)).join('')}</select>`;
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
  closeViewer();
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
  refreshWeather(detail ? detailTrip() : mainTab === 'home' ? autoTrip() : null);
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
    sub.textContent = '화면 · 백업 · 데이터 관리';
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
    <label class="add-btn import-trip">📥 받은 여행 열기 (카톡으로 받은 파일)<input type="file" id="importTripInput" accept="application/pdf,.pdf,text/plain,.txt,application/json,.json" hidden></label>
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
      ${day ? wxHtml(day).replace('class="wx', 'class="card wx') : ''}
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
  const t = trip || { emoji: '✈️', title: '', places: '', start: '', end: '', region: '해외', currency: 'EUR', budget: { rate: '', rateAuto: true }, people: 2 };
  const autoRate = t.budget.rateAuto && t.region !== '국내';
  // 고른 나라: 여행지에서 찾은 나라(통화가 같을 때) → 그 통화의 첫 나라 → 목록에 없으면 '직접 입력'
  const guess = guessCountry(t.places || '');
  const first = COUNTRIES.find((c) => c.cur === t.currency);
  const curPicked = guess && guess.cur === t.currency ? guess.name : first ? first.name : '';
  const otherCur = first || t.currency === 'KRW' ? '' : t.currency;
  openModal({
    title: isNew ? '새 여행 만들기' : '여행 정보 수정',
    html: `<div class="field-row emoji-row">${fieldHtml({ name: 'emoji', label: '아이콘', value: t.emoji })}${fieldHtml({ name: 'title', label: '여행 이름', value: t.title, required: true, placeholder: '예: 제주도 힐링 여행' })}</div>`,
    fields: [
      { name: 'places', label: '여행지 (도시)', value: t.places, placeholder: '예: 제주시 · 서귀포' },
      { name: 'start', label: '출발일', type: 'date', value: t.start, required: true },
      { name: 'end', label: '도착일 (돌아오는 날)', type: 'date', value: t.end, required: true },
      { name: 'people', label: '인원 (숙소·항공 찾기에 쓰여요)', type: 'number', value: t.people },
      { name: 'region', label: '지역', type: 'select', options: ['해외', '국내'], value: t.region },
      { name: 'currency', label: '현지 통화 (해외) — 여행지를 쓰면 자동으로 골라요', type: 'select', value: curPicked,
        options: [...COUNTRY_OPTIONS, { v: '', l: '✏️ 목록에 없는 나라 (통화 직접 입력)' }] },
      { name: 'currencyOther', label: '통화 코드 (영문 3글자)', value: otherCur, list: CURRENCIES, placeholder: '예: CAD, NZD' },
      { name: 'rate', label: '환율: 현지 통화 1단위 = ?원 (비우면 자동)', type: 'number', value: autoRate || t.region === '국내' ? '' : t.budget.rate,
        placeholder: autoRate && t.budget.rate > 1 ? `자동 (지금 ${t.budget.rate}원)` : '자동' },
    ],
    onSave: (d) => {
      if (!d.start || !d.end || d.end < d.start) { toast('날짜를 확인하세요 (도착일이 출발일보다 빠름)'); return false; }
      if (diffDays(d.end, d.start) > 120) { toast('여행 기간은 120일까지 가능해요'); return false; }
      let currency = (curOf(d.currency) || d.currencyOther || '').toUpperCase();
      let rate = parseFloat(d.rate);
      let rateAuto = !d.rate; // 비우면 자동
      if (d.region === '국내' || currency === 'KRW') { currency = 'KRW'; rate = 1; rateAuto = true; }
      else if (!currency) { toast('현지 통화를 입력하세요'); return false; }
      else if (rateAuto) rate = trip && trip.currency === currency ? trip.budget.rate : 1; // 곧 자동으로 불러옴
      else if (!(rate > 0)) { toast('환율을 확인하세요'); return false; }
      const people = Math.min(9, Math.max(1, Math.round(Number(d.people)) || 2)); // 아고다·스카이스캐너 검색 인원 (1~9명)

      if (isNew) {
        const tpl = newTripTemplate(d.region);
        const nt = normalizeTrip({
          id: 'trip-' + uid(), title: d.title, emoji: d.emoji || '✈️', places: d.places, region: d.region, people,
          currency, start: d.start, end: d.end, days: buildDays(d.start, d.end, []),
          checklist: tpl.checklist, contacts: tpl.contacts,
          budget: { rate, rateAuto, plan: Object.fromEntries(CATS.map((k) => [k, 0])) },
        });
        state.trips.push(nt);
        applyCoverChoice(nt.id);
        save();
        if (rateAuto) refreshRates(true);
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
      Object.assign(trip, { title: d.title, emoji: d.emoji || '✈️', places: d.places, region: d.region, people, currency, start: d.start, end: d.end });
      applyCoverChoice(trip.id);
      Object.assign(trip.budget, { rate, rateAuto });
      if (rateAuto) setTimeout(() => refreshRates(true)); // 저장·화면 갱신 뒤에
    },
    onDelete: isNew ? null : () => {
      state.trips = state.trips.filter((x) => x !== trip);
      removeCover(trip.id);
      deleteVouchers(trip.bookings.flatMap((x) => x.vouchers || []));
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
  if (!isNew) {
    $('#modalBody').insertAdjacentHTML('beforeend', `
      <div class="field"><span>함께 보기</span>
        <div class="seg-btns">
          <button type="button" class="btn" id="shareTripBtn">📤 공유 (카톡 등)</button>
          <button type="button" class="btn" id="saveTripBtn">⬇ 파일로 저장</button>
        </div>
        <div class="muted small" style="margin-top:4px">일정·예약·바우처가 파일 하나로 가요. 공유로 파일이 안 가면 '파일로 저장' 후 카톡에서 + → 파일로 보내 주세요.
          받는 사람은 내 여행 → '📥 받은 여행 열기'로 열면 이 여행만 추가돼요(이미 있으면 새 내용으로 바뀜).</div>
      </div>`);
    $('#shareTripBtn').onclick = () => shareTrip(trip);
    $('#saveTripBtn').onclick = () => shareTrip(trip, true);
  }

  // 통화: 여행지 칸에서 나라·도시를 찾으면 자동 선택 (직접 고른 뒤로는 그대로). 국내면 통화·환율 칸을 숨긴다.
  const form = $('#modalForm');
  const box = (name) => form.elements[name].closest('.field');
  const sync = () => {
    const dom = form.region.value === '국내';
    box('currency').style.display = dom ? 'none' : '';
    box('currencyOther').style.display = dom || form.currency.value ? 'none' : '';
    box('rate').style.display = dom ? 'none' : '';
  };
  const curChanged = () => { if (curOf(form.currency.value) !== t.currency) form.rate.value = ''; sync(); }; // 다른 통화의 환율은 자동으로
  let touched = false;
  form.currency.onchange = () => { touched = true; curChanged(); };
  form.region.onchange = sync;
  form.places.oninput = () => {
    const c = guessCountry(form.places.value);
    if (!c || touched || form.currency.value === c.name) return;
    form.currency.value = c.name;
    form.region.value = '해외';
    curChanged();
  };
  sync();
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
/* ---------- 전체 일정 흐름 (도시별 머무는 기간) ---------- */
// 그날 머무는 도시(이동하는 날은 도착 도시)가 같은 날끼리 묶는다. 첫날·마지막 날의 출국·도착은 ✈️
function flowSegments(trip) {
  const segs = [];
  trip.days.forEach((d, i) => {
    const edge = (i === 0 || i === trip.days.length - 1) && /출국|도착|귀국/.test(d.city || '');
    const city = edge ? '' : dayCities(d).pop() || '';
    const last = segs[segs.length - 1];
    if (last && !edge && !last.edge && last.city === city) last.dates.push(d.date);
    else segs.push({ city, edge, dates: [d.date] });
  });
  return segs;
}
// 막대 하나 = 한 도시, 길이 = 머무는 날 수. 누르면 그 도시 첫날로 (고른 날이 이미 그 안이면 그대로)
function flowHtml(trip) {
  const segs = flowSegments(trip);
  if (segs.length < 2) return '';
  const cities = [...new Set(segs.filter((x) => x.city).map((x) => x.city))];
  return `<div class="flow" aria-label="전체 일정 흐름">${segs.map((x) => {
    const on = x.dates.includes(selectedDate);
    const n = x.dates.length;
    const name = x.edge ? '✈️' : x.city ? esc(x.city) : '미정';
    const cls = x.edge ? 'edge' : x.city ? `c${cities.indexOf(x.city) % 6}` : 'none';
    return `<button type="button" class="flow-seg ${cls}${on ? ' on' : ''}" style="flex:${x.edge ? '0 0 28px' : n}"
      data-act="pick-day" data-date="${on ? selectedDate : x.dates[0]}" title="${name} ${n}일">
      <b>${name}</b>${x.edge ? '' : `<span>${n}일</span>`}</button>`;
  }).join('')}</div>`;
}

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
  const clash = conflictIds(day);
  const items = day.items.length
    ? day.items.map((it, i) => (i ? legHtml(day.items[i - 1], it) : '') + timelineItem(trip, it, i, clash.has(it.id))).join('')
    : '<li class="empty-state">아직 일정이 없어요</li>';
  const hasLeg = day.items.some((it, i) => i && travelLeg(day.items[i - 1], it));

  return `
    ${flowHtml(trip)}
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
        ${wxHtml(day)}
        ${costSum ? `<div class="muted small">예상 경비 ${money(costSum, trip.currency)}</div>` : ''}
      </div>
      <ul class="timeline2">${items}</ul>
    </div>
    <button class="add-btn" data-act="add-item">+ 장소 추가</button>
    <p class="muted small" style="text-align:center;margin-top:14px">일정을 누르면 수정, 좌우로 밀면 다른 날로 넘어가요.<br>왼쪽 동그라미를 잡고 위아래로 끌면 순서가 바뀌어요.${hasLeg ? '<br>“자동” 이동 시간은 직선거리 어림값이에요. 이동 줄을 눌러 수단·시간을 정할 수 있어요.' : ''}</p>`;
}

/* ---------- 시간 겹침 ---------- */
// 소요 시간 글자 → 분 ("30분", "1시간 30분", "1.5시간", "반나절"). 못 알아들으면 null
function parseDurMin(text) {
  const t = String(text || '').replace(/\s/g, '');
  if (!t) return null;
  if (/반나절/.test(t)) return 240;
  if (/종일|하루/.test(t)) return 480;
  const h = t.match(/(\d+(?:\.\d+)?)시간/);
  const m = t.match(/(\d+)분/);
  if (!h && !m) return null;
  return Math.round((h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0)) || null;
}
const DEFAULT_DUR_MIN = 60; // 소요 시간이 없으면 1시간으로 가정
const toMin = (t) => { const [hh, mm] = t.split(':').map(Number); return hh * 60 + mm; };
const fromMin = (n) => `${String(Math.floor(n / 60) % 24).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

// 일정의 시간 범위 (시간 미정이면 null)
function itemRange(it) {
  if (!isHHMM(it.time)) return null;
  const start = toMin(it.time);
  return { start, end: start + (parseDurMin(it.dur) || DEFAULT_DUR_MIN) };
}
const overlaps = (a, b) => a.start < b.end && b.start < a.end;

// 그날 일정 중 시간이 겹치는 것들의 id
function conflictIds(day) {
  const ids = new Set();
  const ranged = day.items.map((it) => [it, itemRange(it)]).filter(([, r]) => r);
  for (let i = 0; i < ranged.length; i++) {
    for (let j = i + 1; j < ranged.length; j++) {
      if (overlaps(ranged[i][1], ranged[j][1])) { ids.add(ranged[i][0].id); ids.add(ranged[j][0].id); }
    }
  }
  return ids;
}

/* ---------- 일정 사이 이동: 앱이 거리로 제안(자동) → 여행자가 수단·시간을 정함 ---------- */
// 직접 정한 이동은 '도착하는 일정'에 저장: item.move = { mode, label, min, memo }
// 실제 길찾기는 유료/제한이 있어 2단계에서. 지금 '자동'은 직선거리 × 1.3(30km 넘으면 × 1.15) 어림값.
const MOVE_MODES = {
  walk: { icon: '🚶', name: '도보' },
  subway: { icon: '🚇', name: '지하철' },
  bus: { icon: '🚌', name: '버스' },
  car: { icon: '🚗', name: '차' },
  train: { icon: '🚆', name: '기차' },
  flight: { icon: '✈️', name: '항공' },
  etc: { icon: '✏️', name: '기타' },
};
const ROUTE_FACTOR = 1.3;

function legKm(a, b) {
  if (!hasPos(a) || !hasPos(b)) return null;
  const straight = distKm(a, b);
  return straight * (straight * ROUTE_FACTOR > 30 ? 1.15 : ROUTE_FACTOR); // 장거리(기차·고속도로)는 덜 돌아감
}
// 거리로 고른 '자동' 수단
function autoMode(km) {
  if (km <= 2) return 'walk'; // 여행 중엔 2km(약 25분)까지는 대개 걸어감
  if (km <= 30) return 'car';
  if (km <= 300) return 'train';
  return 'flight';
}
// 수단별 어림 시간(분). 짐작할 수 없으면 null (항공·기타)
function estMin(km, mode) {
  if (km == null) return null;
  const r5 = (n) => (n < 10 ? Math.max(1, Math.round(n)) : Math.round(n / 5) * 5);
  switch (mode) {
    case 'walk': return r5(km / 4.5 * 60);
    case 'subway': return r5(km / 25 * 60 + 10); // 역까지 걷기·기다림 포함
    case 'bus': return r5(km / 18 * 60 + 8);
    case 'car': return r5(km > 30 ? km / 70 * 60 + 10 : km / 22 * 60 + 5);
    case 'train': return r5(km / 80 * 60 + 15);
    default: return null;
  }
}
const fmtDist = (km) => (km < 1 ? `${Math.round(km * 100) * 10}m` : `${km < 10 ? km.toFixed(1) : Math.round(km)}km`);
function fmtMin(n) {
  if (n < 60) return `${n}분`;
  const h = Math.floor(n / 60), m = n % 60;
  return m ? `${h}시간 ${m}분` : `${h}시간`;
}

// a → b 이동 정보: 직접 정한 값이 있으면 그것, 없으면 자동
function travelLeg(a, b) {
  const km = legKm(a, b);
  const mv = b.move;
  if (mv && mv.mode) {
    const min = mv.min != null && mv.min !== '' ? Number(mv.min) : estMin(km, mv.mode);
    const m = MOVE_MODES[mv.mode] || MOVE_MODES.etc;
    return { km, min, icon: m.icon, name: mv.mode === 'etc' ? (mv.label || '기타') : m.name, memo: mv.memo || '', manual: true, mode: mv.mode };
  }
  if (km == null) return null;
  const mode = autoMode(km);
  return { km, min: estMin(km, mode), icon: MOVE_MODES[mode].icon, name: mode === 'car' ? '차·대중교통' : MOVE_MODES[mode].name, memo: '', manual: false, mode };
}

// 두 일정 사이 줄. 누르면 수단·시간을 정하는 창
function legHtml(a, b) {
  const leg = travelLeg(a, b);
  if (!leg || (!leg.manual && leg.km < 0.05)) return '';
  const ra = itemRange(a), rb = itemRange(b);
  const gap = ra && rb ? rb.start - ra.end : null;
  // 자동일 때는 '이동' 일정이 끼었거나 장거리면 경고하지 않음 (그 일정 자체가 이동이라 헛경고). 직접 정했으면 항상 확인
  const skip = !leg.manual && (a.cat === '이동' || b.cat === '이동' || leg.km > 30);
  const tight = !skip && leg.min != null && gap != null && gap >= 0 && leg.min > gap;
  const parts = [`${leg.icon} ${esc(leg.name)}`];
  if (leg.min != null) parts.push(`${leg.manual && b.move.min != null && b.move.min !== '' ? '' : '약 '}${fmtMin(leg.min)}`);
  if (leg.km != null) parts.push(fmtDist(leg.km));
  return `
    <li class="tl2-leg ${tight ? 'tight' : ''} ${leg.manual ? 'set' : 'auto'}">
      <button class="leg-text" data-act="edit-leg" data-id="${b.id}">${parts.join(' · ')}${leg.manual ? '' : ' <span class="leg-auto">자동</span>'} <span class="leg-edit">✎</span></button>
      ${leg.memo ? `<div class="leg-memo">${esc(leg.memo)}</div>` : ''}
      ${tight ? `<span class="leg-warn">⚠ 이동 시간이 빠듯해요 (여유 ${fmtMin(gap)})</span>` : ''}
    </li>`;
}

function legForm(a, b) {
  const km = legKm(a, b);
  const auto = km != null ? autoMode(km) : null;
  const cur = b.move && b.move.mode ? b.move.mode : 'auto';
  const chips = [['auto', `🤖 자동${auto ? ` (${MOVE_MODES[auto].name})` : ''}`], ...Object.entries(MOVE_MODES).map(([k, m]) => [k, `${m.icon} ${m.name}`])]
    .map(([k, label]) => `<label class="pick-chip cat"><input type="radio" name="mode" value="${k}" ${k === cur ? 'checked' : ''}><span>${label}</span></label>`).join('');
  const mv = b.move || {};
  openModal({
    title: '이동 방법',
    html: `
      <p class="small muted" style="margin-top:0">${esc(a.title)} → ${esc(b.title)}${km != null ? ` · 약 ${fmtDist(km)}` : ''}</p>
      <div class="field"><span>이동 수단</span><div class="pick-wrap">${chips}</div></div>
      <div class="field" id="legLabelBox" ${cur === 'etc' ? '' : 'hidden'}><span>직접 입력</span>
        <input name="label" class="dur-input" style="margin-top:0" value="${esc(mv.label || '')}" placeholder="예: 도보+지하철, 페리, 자전거"></div>
      <div class="field"><span>소요 시간</span>
        <input name="min" class="dur-input" style="margin-top:0" value="${mv.min != null && mv.min !== '' ? esc(fmtMin(Number(mv.min))) : ''}" placeholder="">
        <div class="small muted" id="legEstTip" style="margin-top:6px"></div></div>
      ${fieldHtml({ name: 'memo', label: '메모 (노선·출구 등)', value: mv.memo || '', placeholder: '예: L5호선 Diagonal → Verdaguer' })}`,
    onSave: (d) => {
      if (d.mode === 'auto') { delete b.move; return; }
      const typed = d.min.trim();
      const min = typed === '' ? '' : (/^\d+$/.test(typed) ? Number(typed) : parseDurMin(typed));
      if (typed !== '' && !min) { toast('소요 시간을 확인하세요 (예: 25, 1시간 30분)'); return false; }
      if (d.mode === 'etc' && !d.label) { toast('이동 방법을 적어 주세요 (예: 도보+지하철)'); return false; }
      b.move = { mode: d.mode, label: d.mode === 'etc' ? d.label : '', min, memo: d.memo };
    },
  });
  // 수단을 바꾸면: 기타 입력칸 보이기 + 그 수단의 어림 시간을 안내
  const form = $('#modalForm');
  const update = () => {
    const mode = form.querySelector('input[name=mode]:checked').value;
    $('#legLabelBox').hidden = mode !== 'etc';
    const est = estMin(km, mode === 'auto' ? auto : mode);
    form.min.placeholder = est != null ? `비우면 자동: 약 ${fmtMin(est)}` : '예: 25, 1시간 30분';
    $('#legEstTip').textContent = mode === 'auto' ? '앱이 거리로 짐작한 값을 써요'
      : est != null ? '비워 두면 거리로 어림잡고, 적으면 그 시간을 써요 (예: 25 → 25분)'
      : '이 수단은 앱이 시간을 짐작할 수 없어요. 시간을 적어 주세요';
  };
  form.querySelectorAll('input[name=mode]').forEach((r) => { r.onchange = update; });
  update();
}

/* ---------- 입장권 ---------- */

// http(s)로 시작하지 않으면 붙여 준다 (javascript: 같은 주소는 막기)
function cleanUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  return /^https?:\/\//i.test(u) ? u : 'https://' + u.replace(/^[a-z]+:\/*/i, '');
}

// 카드 아래 입장권 버튼: 내 예매 링크 > 공식 예매처 > (관광·액티비티만) 입장권 찾기
function ticketLinks(it) {
  const a = (url, label) => `<a class="map-btn ticket-btn" href="${esc(url)}" target="_blank" rel="noopener" data-act="link">${label}</a>`;
  if (it.ticketUrl) return a(it.ticketUrl, '🎟 내 예매 링크 ›');
  const official = sightsOf(it).filter((s) => s.url);
  if (official.length === 1) return a(official[0].url, '🎟 공식 예매처 ›');
  if (official.length) return official.map((s) => a(s.url, `🎟 ${esc(s.name)} 공식 ›`)).join('');
  if (it.cat !== '관광' && it.cat !== '액티비티') return '';
  if (/산책|해변|전망대|일몰|휴식|드라이브|광장|지구|거리/.test(it.title || '')) return ''; // 보통 입장권이 없는 곳
  const q = `${it.place || it.title} official tickets`;
  return a(`https://www.google.com/search?q=${encodeURIComponent(q)}`, '🎟 입장권 찾기 ›');
}

// 연결된 예약 → 예약번호 표시 (누르면 예약 수정)
function bookingChip(trip, it) {
  const b = it.bookingId && trip.bookings.find((x) => x.id === it.bookingId);
  if (!b) return '';
  return `<button type="button" class="book-chip ${b.code ? '' : 'empty'}" data-act="open-book" data-id="${b.id}">📄 ${b.code ? '예약번호 ' + esc(b.code) : '예약번호 미입력'}</button>${voucherBtn(b)}`;
}

// 예전 데이터: 같은 관광지·같은 날(또는 날짜 없는) 예약이 하나뿐이면 한 번만 자동 연결. 이후엔 사용자가 정한 대로.
function autoLinkBookings(t) {
  for (const d of t.days) {
    for (const it of d.items) {
      if ('bookingId' in it) continue;
      it.bookingId = '';
      const sights = sightsOf(it);
      if (!sights.length) continue;
      const hits = t.bookings.filter((b) => (!b.date || b.date === d.date) && sights.some((s) => s.re.test(b.title || '')));
      if (hits.length === 1) it.bookingId = hits[0].id;
    }
  }
}

function timelineItem(trip, it, i, clash) {
  const c = ITEM_CATS[it.cat] || ITEM_CATS['기타'];
  const when = [it.time, it.dur].filter(Boolean).join(' · ');
  const cost = Number(it.cost) || 0;
  const link = mapLink(trip, it);
  const links = ticketLinks(it) + (link ? `<a class="map-btn" href="${link.url}" target="_blank" rel="noopener" data-act="link">${link.label}</a>` : '');
  const foot = (it.place ? `<span class="tl2-place">${hasPos(it) ? '📍' : '◌'} ${esc(it.place)}</span>` : '')
    + (cost ? `<span class="tl2-cost">💰 ${money(cost, trip.currency)}</span>` : '')
    + bookingChip(trip, it)
    + (links ? `<span class="tl2-links">${links}</span>` : '');
  return `
    <li class="tl2 ${it.done ? 'done' : ''}" style="--cat:${c.color}">
      <span class="tl2-dot" title="${esc(it.cat)} · 끌어서 순서 바꾸기">${c.icon}<span class="tl2-num">${i + 1}</span></span>
      <div class="tl2-card" data-act="edit-item" data-id="${it.id}">
        <div class="tl2-top">
          <span class="tl2-time">${esc(when || it.cat)}</span>${clash ? '<span class="tl2-warn">⚠ 시간 겹침</span>' : ''}<span class="spacer"></span>
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
  item = item || { id: uid(), time: '', dur: '', title: '', place: '', memo: '', cat: '관광', cost: '', ticketUrl: '', bookingId: '', done: false };
  const dayChips = trip.days.map((d, i) => {
    const dt = parseDate(d.date);
    return `<label class="pick-chip"><input type="radio" name="date" value="${d.date}" ${d.date === curDay.date ? 'checked' : ''}>
      <span>Day ${i + 1}<br><b>${dt.getMonth() + 1}/${dt.getDate()}</b></span></label>`;
  }).join('');
  const catChips = Object.entries(ITEM_CATS).map(([k, c]) =>
    `<label class="pick-chip cat"><input type="radio" name="cat" value="${k}" ${k === item.cat ? 'checked' : ''}><span>${c.icon} ${k}</span></label>`).join('');
  const bookOpts = [...trip.bookings].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999')).map((b) =>
    `<option value="${b.id}" ${b.id === item.bookingId ? 'selected' : ''}>${BOOK_TYPES[b.type] || '📄'} ${esc(b.title)}${b.date ? ' · ' + fmtDate(b.date) : ''}${b.code ? ' · ' + esc(b.code) : ''}</option>`).join('');
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
        <div id="timeConflict" class="time-conflict" hidden></div>
      </div>
      <div class="field"><span>소요 시간</span>
        <div class="pick-wrap" id="durChips">${DUR_PRESETS.map((v) => `<button type="button" class="dur-chip ${v === item.dur ? 'on' : ''}">${v}</button>`).join('')}</div>
        <input name="dur" class="dur-input" value="${esc(item.dur)}" placeholder="직접 입력 (예: 40분)">
      </div>
      ${fieldHtml({ name: 'memo', label: '✏️ 메모 / 할 일', type: 'textarea', value: item.memo })}
      <div class="field"><span>분류</span><div class="pick-wrap">${catChips}</div></div>
      ${fieldHtml({ name: 'cost', label: `💰 예상 경비 (${trip.currency})`, type: 'number', value: item.cost })}
      ${fieldHtml({ name: 'ticketUrl', label: '🎟 예매 링크 (있으면 카드 버튼이 이 링크를 열어요)', type: 'url', value: item.ticketUrl || '', placeholder: 'https://' })}
      <label class="field"><span>📄 연결할 예약 (예약 탭)</span>
        <select name="bookingId">
          <option value="">연결 안 함</option>
          ${bookOpts}
        </select>
      </label>`,
    onSave: (d) => {
      const cost = parseFloat(d.cost);
      Object.assign(item, {
        time: d.time, dur: d.dur, title: d.title, place: d.place, memo: d.memo,
        cat: d.cat || '기타', cost: cost > 0 ? cost : '',
        ticketUrl: cleanUrl(d.ticketUrl), bookingId: d.bookingId || '',
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
  wireTimeWheel(item, curDay, isNew, () => checkConflict(trip, item));
  // 날짜 칩은 입력창을 열 때마다 새로 만들어지므로 여기에 직접 연결 (폼 자체에 붙이면 열 때마다 쌓임)
  document.querySelectorAll('#modalBody input[name=date]').forEach((r) => { r.onchange = () => checkConflict(trip, item); });
  checkConflict(trip, item);
}

/* ---------- 시간 휠 (00~23시 · 5분 단위) + 시간 미정 ---------- */
const DUR_PRESETS = ['30분', '1시간', '1시간 30분', '2시간', '3시간', '반나절'];
const WHEEL_ROW = 44; // 휠 한 칸 높이(px) — styles.css .wheel div 와 같게
const VAGUE_TIME = { 새벽: '06:00', 아침: '08:00', 오전: '09:00', 점심: '12:00', 오후: '14:00', 저녁: '19:00', 밤: '21:00' };

// 입력창에서 고른 날짜·시간·소요 시간이 그날 다른 일정과 겹치면 경고 (저장은 막지 않음)
function checkConflict(trip, item) {
  const form = $('#modalForm');
  const box = $('#timeConflict');
  if (!form || !box) return;
  const date = (form.querySelector('input[name=date]:checked') || {}).value;
  const day = trip.days.find((d) => d.date === date);
  const mine = itemRange({ time: form.time.value, dur: form.dur.value });
  const hits = day && mine ? day.items.filter((x) => x !== item && itemRange(x) && overlaps(mine, itemRange(x))) : [];
  box.hidden = !hits.length;
  box.innerHTML = hits.map((x) => {
    const r = itemRange(x);
    return `⚠ <b>${esc(x.time)} ${esc(x.title)}</b> (${fromMin(r.start)}~${fromMin(r.end)})과 시간이 겹쳐요`;
  }).join('<br>') + (hits.length && !parseDurMin(form.dur.value) ? '<br><span class="muted">소요 시간이 없으면 1시간으로 계산해요</span>' : '');
}

function wireTimeWheel(item, day, isNew, onChange = () => {}) {
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
    onChange();
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
      onChange();
    };
  });
  durInput.addEventListener('input', () => {
    document.querySelectorAll('#durChips .dur-chip').forEach((x) => x.classList.toggle('on', x.textContent === durInput.value.trim()));
    onChange();
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
        <span class="muted small">${cur === 'KRW' ? '원화 여행' : `환율 ${money(1, cur)} = ${rate.toLocaleString('ko-KR')}원<br>${rateNote(trip)}`}</span>
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
  const { plan, rate, rateAuto } = trip.budget;
  const foreign = trip.currency !== 'KRW';
  openModal({
    title: foreign ? '예산·환율 설정 (원 단위)' : '예산 설정 (원 단위)',
    fields: [
      ...(foreign ? [{ name: 'rate', label: `환율: 1 ${trip.currency} = ?원 (비우면 자동)`, type: 'number', value: rateAuto ? '' : rate,
        placeholder: rateAuto ? `자동 (지금 ${rate}원)` : '자동' }] : []),
      ...CATS.map((k) => ({ name: 'p_' + k, label: k + ' 예산', type: 'number', value: plan[k] || '' })),
    ],
    onSave: (d) => {
      if (foreign) {
        if (!d.rate) {
          const was = trip.budget.rateAuto;
          trip.budget.rateAuto = true;
          if (!was) setTimeout(() => refreshRates(true)); // 직접 입력 → 자동으로 바꾸면 바로 불러오기
        } else {
          const r = parseFloat(d.rate);
          if (!(r > 0)) { toast('환율을 확인하세요'); return false; }
          Object.assign(trip.budget, { rate: r, rateAuto: false });
        }
      }
      CATS.forEach((k) => { trip.budget.plan[k] = parseFloat(d['p_' + k]) || 0; });
    },
  });
}

/* ============ 예약·서류 ============ */
const BOOK_TYPES = { 항공: '✈️', 숙소: '🏨', 교통: '🚆', 관광: '🎟️', 식당: '🍽️', 보험: '🛡️', 기타: '📄' };

/* ---------- 숙소·항공 찾기 (아고다 · 스카이스캐너) ---------- */
// 2026-10-23 확인: 아고다는 도시 이름 검색 주소가 홈으로 돌아가서 아고다 도시 번호가 필요 (아고다 검색창 제안 목록에서 찾은 값).
// 스카이스캐너는 /transport/flights/출발/도착/YYMMDD/ (공항 코드, 여러 공항 도시는 스카이스캐너 도시 코드).
const AGODA_CITY = {
  세비야: 16577, 그라나다: 9170, 마요르카: 16716, 팔마: 16716, 바르셀로나: 2002, 마드리드: 5531, 말라가: 73929, 발렌시아: 1623,
  리스본: 16364, 포르투: 8738, 파리: 15470, 로마: 16594, 런던: 233, 도쿄: 5085, 오사카: 9590, 후쿠오카: 16527,
  방콕: 9395, 다낭: 16440, 서울: 14690, 부산: 17172, 제주: 16901, 강릉: 19041, 속초: 17236, 경주: 17179, 여수: 213193,
};
const AIRPORT = {
  인천: 'icn', 김포: 'gmp', 서울: 'sela', 부산: 'pus', 김해: 'pus', 제주: 'cju',
  세비야: 'svq', 그라나다: 'grx', 마요르카: 'pmi', 팔마: 'pmi', 바르셀로나: 'bcn', 마드리드: 'mad', 말라가: 'agp', 발렌시아: 'vlc',
  리스본: 'lis', 포르투: 'opo', 파리: 'pari', 로마: 'rome', 런던: 'lond', 도쿄: 'tyoa', 오사카: 'osaa', 후쿠오카: 'fuk', 방콕: 'bkk', 다낭: 'dad',
};
// 글자 안에서 아는 도시 이름 찾기 (앞에 나온 것부터)
const findCity = (text, table) => Object.keys(table).filter((k) => text.includes(k)).sort((a, b) => text.indexOf(a) - text.indexOf(b))[0];

function bookSearchLink(trip, b) {
  if (!b.date) return '';
  const a = (url, label) => `<a class="book-search" href="${url}" target="_blank" rel="noopener" data-act="link">${label}</a>`;
  if (b.type === '숙소') {
    // 도시: 예약 이름 → 없으면 그날 도시 칸(“A → B”면 도착 도시)
    const day = trip.days.find((d) => d.date === b.date);
    const city = findCity(b.title, AGODA_CITY) || (day && findCity(dayCities(day).slice(-1)[0] || '', AGODA_CITY));
    const nights = Number((b.title.match(/(\d+)\s*박/) || [])[1]) || 1;
    if (!city) return a('https://www.agoda.com/ko-kr/', '🏨 아고다에서 숙소 찾기 ›');
    const q = `city=${AGODA_CITY[city]}&checkIn=${b.date}&checkOut=${addDays(b.date, nights)}&rooms=1&adults=${trip.people || 2}&children=0`;
    return a(`https://www.agoda.com/ko-kr/search?${q}`, `🏨 아고다에서 ${esc(city)} ${nights}박 찾기 ›`);
  }
  if (b.type === '항공') {
    const [from, to] = b.title.split(/→|->|~/).map((x) => findCity(x || '', AIRPORT));
    if (!from || !to) return a('https://www.skyscanner.co.kr/', '✈️ 스카이스캐너에서 찾기 ›');
    const yymmdd = b.date.slice(2).replace(/-/g, '');
    return a(`https://www.skyscanner.co.kr/transport/flights/${AIRPORT[from]}/${AIRPORT[to]}/${yymmdd}/?adultsv2=${trip.people || 2}&cabinclass=economy&rtn=0`, `✈️ 스카이스캐너에서 항공권 찾기 ›`);
  }
  return '';
}

/* ---------- 바우처 (티켓·QR 사진, PDF) ---------- */
// 예약마다 여러 장. 목록 {id, name, type}은 booking.vouchers, 파일은 IndexedDB vouchers → 인터넷 없이 열린다.
const VOUCHER_MAX = 15 * 1024 * 1024;
const isPdf = (v) => v.type === 'application/pdf';
async function voucherBlob(file) {
  if (file.type === 'application/pdf') return file.size > VOUCHER_MAX ? null : file;
  if (!file.type.startsWith('image/')) return null;
  return shrinkImage(file, 2400, 0.92); // QR이 뭉개지지 않게 크고 선명하게
}
// PDF → 앞 3쪽을 사진으로 (PDF.js 4.10.38, Apache-2.0, vendor/pdfjs). 넣을 때만 불러온다(한 번 받으면 서비스 워커가 저장).
// 안드로이드 크롬은 앱 안에서 PDF를 못 펼치므로, 현장에서는 이 사진을 바로 보여준다.
const PDF_PAGES = 3;
let pdfjsLoad;
const loadPdfjs = () => pdfjsLoad || (pdfjsLoad = import('./vendor/pdfjs/pdf.min.mjs').then((m) => {
  m.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.mjs';
  return m;
}).catch((e) => { pdfjsLoad = null; throw e; }));
async function pdfPages(file) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  try {
    for (let n = 1; n <= Math.min(PDF_PAGES, doc.numPages); n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: Math.min(3, 1600 / page.getViewport({ scale: 1 }).width) }); // 폭 1600px 정도: QR이 선명하게
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      // intent 'print': 화면 새로고침(rAF)을 기다리지 않아 앱이 뒤로 가도 변환이 멈추지 않는다
      await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
      pages.push(await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92)));
    }
    return { pages, total: doc.numPages };
  } finally {
    doc.destroy();
  }
}
async function deleteVouchers(list) {
  for (const v of list || []) await voucherDb.del(v.id).catch(() => {});
}
const voucherBtn = (b) => (b && b.vouchers && b.vouchers.length
  ? `<button type="button" class="book-chip voucher-btn" data-act="voucher" data-id="${b.id}">🎫 바우처 보기${b.vouchers.length > 1 ? ` (${b.vouchers.length})` : ''}</button>` : '');

// 전체 화면 보기: 흰 배경, 보는 동안 화면이 꺼지지 않게(Wake Lock). 사진을 누르면 2배 확대. 뒤로가기로 닫힘.
let viewerUrls = [];
let wakeLock = null;
async function openVoucher(b) {
  if (!b || !(b.vouchers || []).length) return;
  closeViewer();
  const el = document.createElement('div');
  el.id = 'viewer';
  el.innerHTML = `<div class="viewer-bar"><b>${esc(b.title)}</b><span class="spacer"></span><button type="button" class="btn sm" data-close>닫기 ✕</button></div>
    <div class="viewer-body"><p class="viewer-note">불러오는 중…</p></div>`;
  document.body.append(el);
  document.body.classList.add('viewer-open');
  history.pushState({ ...(history.state || {}), viewer: 1 }, '');
  el.onclick = (ev) => {
    if (ev.target.closest('[data-close]')) return history.back();
    const img = ev.target.closest('img');
    if (img) img.classList.toggle('zoom');
  };
  try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* 지원 안 하면 그냥 */ }
  const parts = [];
  for (const v of [...b.vouchers].sort((x, y) => isPdf(x) - isPdf(y))) { // 사진(변환된 쪽 포함) 먼저, PDF 원본은 맨 아래
    const blob = await voucherDb.get(v.id).catch(() => null);
    if (!blob) { parts.push(`<p class="viewer-note">${esc(v.name)}: 이 폰에 파일이 없어요</p>`); continue; }
    const url = URL.createObjectURL(blob);
    viewerUrls.push(url);
    parts.push(isPdf(v)
      ? `<a class="viewer-pdf" href="${url}" download="${esc(v.name)}" target="_blank" rel="noopener">📄 ${esc(v.name)}<span>전체 PDF 보기 · 눌러서 PDF 앱으로 열기</span></a>`
      : `<img src="${url}" alt="${esc(v.name)}">`);
  }
  if (el.isConnected) el.querySelector('.viewer-body').innerHTML = parts.join('') + '<p class="viewer-note">사진을 누르면 크게 · 화면 밝기를 올리면 QR이 잘 읽혀요</p>';
}
function closeViewer() {
  const el = $('#viewer');
  if (!el) return false;
  el.remove();
  document.body.classList.remove('viewer-open');
  viewerUrls.forEach((u) => URL.revokeObjectURL(u));
  viewerUrls = [];
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  return true;
}

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
        ${voucherBtn(b)}
        ${b.code ? '' : bookSearchLink(trip, b)}
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
    onSave: (d) => {
      Object.assign(b, d);
      const gone = (b.vouchers || []).filter((v) => !vList.includes(v));
      b.vouchers = vList;
      if (isNew) trip.bookings.push(b);
      const put = [...added].filter(([id]) => vList.some((v) => v.id === id)).map(([id, blob]) => voucherDb.set(id, blob));
      Promise.all(put).then(() => deleteVouchers(gone)).catch(() => toast('바우처 저장에 실패했어요'));
    },
    onDelete: isNew ? null : () => {
      deleteVouchers(b.vouchers);
      trip.bookings = trip.bookings.filter((x) => x !== b);
      for (const d of trip.days) for (const it of d.items) if (it.bookingId === b.id) it.bookingId = ''; // 일정 연결도 풀기
    },
  });

  // 바우처: 저장을 눌러야 반영 (취소하면 그대로)
  let vList = [...(b.vouchers || [])];
  const added = new Map(); // 새로 넣은 파일 id → Blob
  $('#modalBody').insertAdjacentHTML('beforeend', `
    <div class="field"><span>바우처 · 티켓 (인터넷 없이 보기)</span>
      <div id="vList"></div>
      <label class="btn sm" style="margin-top:6px">+ 사진·PDF 추가<input type="file" id="vInput" accept="image/*,application/pdf" multiple hidden></label>
      <div class="muted small" style="margin-top:4px">PDF는 앞 ${PDF_PAGES}쪽을 사진으로 바꿔 함께 저장해요. QR 화면 스크린샷도 좋아요</div>
    </div>`);
  const draw = () => {
    $('#vList').innerHTML = vList.map((v) => `
      <div class="v-row"><span class="grow">${v.from ? '↳ ' : ''}${isPdf(v) ? '📄' : '🖼️'} ${esc(v.name)}</span>
        <button type="button" class="btn sm ghost" data-v="${v.id}" aria-label="빼기">✕</button></div>`).join('')
      || '<div class="muted small">아직 없어요</div>';
    // PDF만 있으면 안내: 앱 밖(PDF 앱)에서 열려 현장에서 느리거나 안 열릴 수 있다. 저장은 막지 않는다.
    if (vList.some(isPdf) && !vList.some((v) => !isPdf(v))) {
      $('#vList').insertAdjacentHTML('beforeend', `<div class="notice" style="margin:8px 0 4px">📄 PDF는 앱 안에서 바로 안 보이고 PDF 앱으로 열려요.
        현장에서 바로 보이도록 <b>QR이 있는 화면을 스크린샷으로 찍어 사진으로도</b> 넣어 두세요.</div>`);
    }
  };
  draw();
  $('#vList').onclick = (ev) => {
    const id = ev.target.closest('[data-v]')?.dataset.v;
    if (!id) return;
    for (const v of vList) if (v.id === id || v.from === id) added.delete(v.id);
    vList = vList.filter((v) => v.id !== id && v.from !== id); // PDF를 빼면 변환한 쪽도 함께
    draw();
  };
  $('#vInput').onchange = async (ev) => {
    for (const f of ev.target.files) {
      const blob = await voucherBlob(f).catch(() => null);
      if (!blob) { toast(`${f.name}: 사진이나 15MB 이하 PDF만 넣을 수 있어요`); continue; }
      const v = { id: 'v-' + uid(), name: f.name, type: blob.type || f.type };
      added.set(v.id, blob);
      vList.push(v);
      if (isPdf(v)) await addPdfPages(f, v);
    }
    ev.target.value = '';
    draw();
  };
  // PDF 앞 3쪽을 사진으로 바꿔 함께 넣는다. 바꾸는 동안은 저장 버튼을 잠근다.
  async function addPdfPages(f, v) {
    draw();
    $('#vList .notice')?.remove(); // 바꾸는 동안은 'PDF만 있음' 안내를 숨긴다
    $('#vList').insertAdjacentHTML('beforeend', '<div class="muted small" style="padding:6px 0">📄 PDF를 사진으로 바꾸는 중…</div>');
    $('#modalSave').disabled = true;
    try {
      const { pages, total } = await pdfPages(f);
      pages.forEach((blob, i) => {
        const pv = { id: 'v-' + uid(), name: `${f.name} (${i + 1}쪽)`, type: 'image/jpeg', from: v.id };
        added.set(pv.id, blob);
        vList.push(pv);
      });
      if (total > PDF_PAGES) toast(`앞 ${PDF_PAGES}쪽만 사진으로 바꿨어요 (전체 ${total}쪽은 PDF로 열기)`);
    } catch (e) {
      console.warn('PDF 변환 실패', e);
      toast('PDF를 사진으로 바꾸지 못했어요. QR 화면 스크린샷을 넣어 주세요');
    } finally {
      $('#modalSave').disabled = false;
    }
  }
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
// 화면 모드: 자동(폰 설정) / 밝게 / 어둡게. 이 폰에만 저장 (index.html 머리에서 그리기 전에 먼저 적용)
const THEME_KEY = 'mastertrip-theme';
const THEMES = { auto: '📱 자동', light: '☀️ 밝게', dark: '🌙 어둡게' };
function getTheme() { try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { return 'auto'; } }
function setTheme(v) {
  try { if (v === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, v); } catch (e) {}
  if (v === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = v;
  render();
}

function renderSettings() {
  const theme = getTheme();
  return `
    <div class="section-title"><h3>화면</h3></div>
    <div class="card">
      <p class="small muted" style="margin-top:0">화면 모드 — 자동은 폰의 다크 모드 설정을 따라가요.</p>
      <div class="seg-btns">${Object.entries(THEMES).map(([k, l]) =>
        `<button type="button" class="btn sm${k === theme ? ' primary' : ''}" data-act="theme" data-v="${k}">${l}</button>`).join('')}</div>
    </div>
    <div class="section-title"><h3>백업</h3></div>
    <div class="card">
      <p class="small muted" style="margin-top:0">데이터는 이 폰 안에만 저장돼요. 폰을 바꾸거나 브라우저 데이터를 지우면 사라지니 가끔 내보내기로 백업하세요. 백업에는 모든 여행이 들어갑니다. 가져오기는 백업 파일과 받은 여행 파일(.mastertrip.pdf)을 모두 열 수 있어요.</p>
      <div class="row" style="flex-wrap:wrap">
        <button type="button" class="btn" data-act="export">⬇ 내보내기 (백업)</button>
        <label class="btn" style="display:inline-block">⬆ 가져오기 <input type="file" id="importInput" accept="application/json,.json,text/plain,.txt,application/pdf,.pdf" hidden></label>
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
  voucherDb.clear().catch(() => {});
}

async function exportData() {
  // 백업 파일에는 표지 사진·바우처도 함께 넣는다 (dataURL)
  const dump = async (store) => {
    const out = {};
    try {
      const [keys, vals] = await Promise.all([store.keys(), store.values()]);
      for (let i = 0; i < keys.length; i++) out[keys[i]] = await blobToDataUrl(vals[i]);
    } catch (e) { console.warn(e); }
    return out;
  };
  const covers = await dump(media);
  const vouchers = await dump(voucherDb);
  const blob = new Blob([JSON.stringify({ ...state, covers, vouchers }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mastertrip-backup-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('백업 파일을 저장했어요');
}

/* ---------- 여행 하나 보내기 (배우자 폰으로) ---------- */
// 여행 하나 + 표지 사진 + 바우처를 파일 하나로. 받은 쪽은 '받은 여행 열기'(또는 설정 → 가져오기)로 열면 그 여행만 추가(같은 여행이면 교체).
// 크롬 공유는 .json을 못 보내고, 카톡은 공유로 받은 .txt를 파일로 안 붙인다 → PDF로 만든다:
// 열어 보면 안내 한 장, 데이터는 PDF 주석 줄(%MASTERTRIP-DATA:base64)에 담는다. 예전 .txt(JSON)도 가져올 수 있다.
const TRIP_FILE = 'mastertrip-trip';
const PDF_MARK = '%MASTERTRIP-DATA:';
function tripPdf(b64) {
  const text = [['MasterTrip trip file', 20, 780], ['Open this file in the MasterTrip app:', 12, 748], ['My Trips > Open received trip  (or Settings > Import)', 12, 728]]
    .map(([t, size, y]) => `BT /F1 ${size} Tf 50 ${y} Td (${t.replace(/[()\\]/g, '\\$&')}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = `%PDF-1.4\n${PDF_MARK}${b64}\n`; // 데이터는 주석 줄 (PDF 보기 프로그램은 무시)
  const offs = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([out], { type: 'application/pdf' });
}
// 받은 파일 글자 → 여행 데이터 (PDF면 주석 줄을 꺼내 base64 → UTF-8 JSON)
async function readTripFileText(text) {
  const i = text.indexOf(PDF_MARK);
  if (i < 0) return JSON.parse(text);
  const b64 = text.slice(i + PDF_MARK.length, text.indexOf('\n', i));
  return JSON.parse(await (await fetch(`data:application/octet-stream;base64,${b64}`)).text());
}
async function tripFileBlob(trip) {
  const covers = {};
  const vouchers = {};
  try {
    const c = await media.get(trip.id);
    if (c) covers[trip.id] = await blobToDataUrl(c);
    for (const v of trip.bookings.flatMap((b) => b.vouchers || [])) {
      const blob = await voucherDb.get(v.id);
      if (blob) vouchers[v.id] = await blobToDataUrl(blob);
    }
  } catch (e) { console.warn(e); }
  const data = { type: TRIP_FILE, v: 1, sentAt: new Date().toISOString(), trip, covers, vouchers };
  const b64 = (await blobToDataUrl(new Blob([JSON.stringify(data)]))).split(',')[1]; // UTF-8 → base64
  return tripPdf(b64);
}
// asFile: 공유창 대신 바로 파일로 저장 (카톡에서 + → 파일로 첨부)
async function shareTrip(trip, asFile) {
  toast('보낼 파일을 만드는 중…');
  const blob = await tripFileBlob(trip);
  const name = `${trip.title.replace(/[\/:*?"<>|]/g, '').trim() || '여행'}.mastertrip.pdf`;
  const file = new File([blob], name, { type: 'application/pdf' });
  if (!asFile && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      // 파일만 보낸다: 글(text·title)을 같이 넣으면 카톡 등은 글만 받고 파일을 버린다 (.txt는 아예 안 붙어서 PDF)
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // 공유 창을 닫음
    }
  }
  // 공유를 못 하면 파일로 저장
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('다운로드 폴더에 저장했어요. 카톡에서 + → 파일로 보내 주세요');
}
const restoreBlob = (url) => fetch(url).then((r) => r.blob());
// 받은 여행 하나: 처음 받는 여행이면 추가, 이미 있는 여행(같은 id)이면 받은 내용으로 교체
async function importTrip(data) {
  const t = migrate({ trips: [data.trip] }).trips[0];
  const old = getTrip(t.id);
  const when = data.sentAt ? ` (${fmtDate(ymd(new Date(data.sentAt)))} 보냄)` : '';
  const msg = old
    ? `이미 있는 '${old.title}' 여행을 받은 파일${when} 내용으로 바꿀까요?
이 폰에서만 고친 내용은 사라져요.`
    : `'${t.title}' 여행을 추가할까요?${when}`;
  if (!confirm(msg)) return;
  if (old) {
    // 새 파일에 없는 옛 바우처만, 다 지운 뒤에 새 것을 넣는다 (동시에 하면 새로 넣은 게 지워질 수 있음)
    const keep = new Set(Object.keys(data.vouchers || {}));
    await deleteVouchers(old.bookings.flatMap((b) => b.vouchers || []).filter((v) => !keep.has(v.id)));
    state.trips[state.trips.indexOf(old)] = t;
  } else state.trips.push(t);
  save();
  try {
    for (const [id, url] of Object.entries(data.vouchers || {})) await voucherDb.set(id, await restoreBlob(url));
    if (data.covers && data.covers[t.id]) await setCover(t.id, await restoreBlob(data.covers[t.id]));
  } catch (e) { console.warn('사진·바우처 복원 실패', e); }
  mainTab = 'trips';
  remember('main', mainTab);
  openTrip(t.id);
  toast(old ? '받은 내용으로 바꿨어요' : '여행을 추가했어요');
}

function importData(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = await readTripFileText(reader.result);
      if (data.type === TRIP_FILE && data.trip) { importTrip(data); return; }
      const valid = Array.isArray(data.trips) || (data.trip && Array.isArray(data.days));
      if (!valid) throw new Error('형식 오류');
      if (!confirm('현재 데이터를 백업 파일 내용으로 바꿀까요?')) return;
      const covers = data.covers || {};
      const vouchers = data.vouchers || {};
      delete data.covers;
      delete data.vouchers;
      state = migrate(data); pickTrip(null); openTripId = null; save(); render(); toast('가져오기 완료');
      clearCovers()
        .then(() => Promise.all(Object.entries(covers).map(([id, url]) => fetch(url).then((r) => r.blob()).then((b) => setCover(id, b)))))
        .then(render);
      voucherDb.clear()
        .then(() => Promise.all(Object.entries(vouchers).map(([id, url]) => fetch(url).then((r) => r.blob()).then((b) => voucherDb.set(id, b)))))
        .catch((e) => console.warn('바우처 복원 실패', e));
    } catch (e) {
      toast('올바른 백업·여행 파일이 아니에요');
    }
  };
  reader.readAsText(file);
  ev.target.value = ''; // 같은 파일을 다시 골라도 열리게
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
    case 'edit-leg': {
      const j = day.items.findIndex((x) => x.id === id);
      if (j > 0) legForm(day.items[j - 1], day.items[j]);
      break;
    }
    case 'toggle-map': mapOpen = !mapOpen; remember('map', mapOpen ? '1' : '0'); render(); break;
    case 'geocode-all': geocodeAll(detailTrip()); break;
    case 'search-close': searchOpen = false; searchQuery = ''; render(); break;
    case 'goto-sub': pickTrip(id); mainTab = 'trips'; remember('main', mainTab); setSub(el.dataset.v); window.scrollTo(0, 0); break;
    case 'export': exportData(); break;
    case 'theme': setTheme(el.dataset.v); break;
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
    case 'open-book': { const t = detailTrip(); bookForm(t, t.bookings.find((x) => x.id === id)); break; } // 일정 카드의 예약번호
    case 'voucher': { const t = inDetail() ? detailTrip() : ft; openVoucher(t.bookings.find((x) => x.id === id)); break; }
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
  if (el.id === 'importInput' || el.id === 'importTripInput') return importData(ev);
  if (el.dataset.act !== 'toggle-check') return;
  const c = focusTrip().checklist.find((x) => x.id === el.dataset.id);
  c.done = el.checked;
  save();
  render();
});

/* ---------- 일정 끌어서 순서 바꾸기: 왼쪽 동그라미를 잡고 위아래로 ---------- */
let drag = null;
const dragRows = () => [...document.querySelectorAll('#dayCard .tl2')];
$('#view').addEventListener('pointerdown', (ev) => {
  const dot = ev.target.closest('.tl2-dot');
  if (!dot || !inDetail() || ev.button > 0) return;
  const rows = dragRows();
  if (rows.length < 2) return;
  ev.preventDefault();
  try { dot.setPointerCapture(ev.pointerId); } catch (e) { /* 이미 끝난 손가락 */ }
  const li = dot.closest('.tl2');
  drag = { li, rows, from: rows.indexOf(li), to: rows.indexOf(li), y0: ev.clientY + window.scrollY };
  li.classList.add('dragging');
  $('#dayCard').classList.add('drag-on');
});
$('#view').addEventListener('pointermove', (ev) => {
  if (!drag) return;
  const y = ev.clientY;
  // 화면 위·아래 끝에 가까우면 천천히 스크롤
  if (y < 90) window.scrollBy(0, -10);
  else if (y > window.innerHeight - 110) window.scrollBy(0, 10);
  drag.li.style.transform = `translateY(${y + window.scrollY - drag.y0}px)`;
  const others = drag.rows.filter((r) => r !== drag.li);
  const to = others.filter((r) => { const b = r.getBoundingClientRect(); return b.top + b.height / 2 < y; }).length;
  drag.to = to;
  others.forEach((r) => r.classList.remove('drop-before', 'drop-after'));
  if (to === drag.from) return;
  if (to < others.length) others[to].classList.add('drop-before');
  else others[others.length - 1].classList.add('drop-after');
});
function endDrag() {
  if (!drag) return;
  const { li, rows, from, to } = drag;
  drag = null;
  li.style.transform = '';
  li.classList.remove('dragging');
  rows.forEach((r) => r.classList.remove('drop-before', 'drop-after'));
  $('#dayCard')?.classList.remove('drag-on');
  if (to !== from) moveItem(currentDay(), from, to);
}
$('#view').addEventListener('pointerup', endDrag);
$('#view').addEventListener('pointercancel', endDrag);

// 순서를 옮기고, 앞 일정이 바뀐 일정의 '이동 수단'은 지운다(어디서 오는지가 달라졌으므로).
// 옮긴 일정의 시간이 앞뒤 순서와 어긋나면 시간을 어떻게 할지 묻는다.
function moveItem(day, from, to) {
  const prevOf = (list) => Object.fromEntries(list.map((x, i) => [x.id, i ? list[i - 1].id : null]));
  const before = prevOf(day.items);
  const [it] = day.items.splice(from, 1);
  day.items.splice(to, 0, it);
  const after = prevOf(day.items);
  for (const x of day.items) if (x.move && before[x.id] !== after[x.id]) delete x.move;
  save();
  render();
  const prev = day.items[to - 1];
  const next = day.items[to + 1];
  const t = isHHMM(it.time) && hhmm(it.time);
  const off = t && ((prev && isHHMM(prev.time) && hhmm(prev.time) > t) || (next && isHHMM(next.time) && hhmm(next.time) < t));
  if (off) askMovedTime(day, it, prev, next);
}
// 제안 시간: 앞 일정 끝(+이동 시간) → 맨 앞으로 옮겼으면 다음 일정 시작 전. 5분 단위로 올림.
function suggestTime(it, prev, next) {
  const r5 = (n) => Math.ceil(n / 5) * 5;
  const legMin = (a, b) => { const l = travelLeg(a, b); return (l && l.min) || 0; };
  if (prev && isHHMM(prev.time)) {
    const n = r5(itemRange(prev).end + legMin(prev, it));
    return n < 24 * 60 ? { time: fromMin(n), why: '앞 일정 끝 + 이동' } : null;
  }
  if (next && isHHMM(next.time)) {
    const n = Math.floor((toMin(next.time) - (parseDurMin(it.dur) || DEFAULT_DUR_MIN) - legMin(it, next)) / 5) * 5;
    return n >= 0 ? { time: fromMin(n), why: '다음 일정 전' } : null;
  }
  return null;
}
function askMovedTime(day, it, prev, next) {
  const sug = suggestTime(it, prev, next);
  openModal({
    title: '옮긴 일정의 시간',
    html: `<p style="margin-top:0">“${esc(it.title)}”(${esc(it.time)})이 앞뒤 일정과 시간 순서가 맞지 않아요.</p>
      <div class="col-btns">
        ${sug ? `<button type="button" class="btn primary" data-t="${sug.time}">⏱ ${sug.time}로 맞추기 <span class="small">(${sug.why})</span></button>` : ''}
        <button type="button" class="btn" data-t="">시간 미정으로</button>
        <button type="button" class="btn ghost" data-t="keep">그대로 두기</button>
      </div>`,
  });
  $('#modalCancel').style.display = 'none';
  $('#modalBody').onclick = (ev) => {
    const b = ev.target.closest('[data-t]');
    if (!b) return;
    if (b.dataset.t !== 'keep') { it.time = b.dataset.t; save(); render(); }
    modal.close();
  };
  modal.addEventListener('close', () => { $('#modalCancel').style.display = ''; $('#modalBody').onclick = null; }, { once: true });
}

let touchStart = null;
$('#view').addEventListener('touchstart', (ev) => {
  if (drag || !inDetail() || !ev.target.closest('#dayCard')) return; // 순서 끌기 중에는 날짜 넘기기 안 함
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
window.addEventListener('online', () => { if (inDetail()) render(); refreshRates(); });
window.addEventListener('offline', () => { if (inDetail()) render(); });

// 자정이 지나면 오늘 날짜/D-day 갱신 (환율도 날이 바뀌었으면 다시)
document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); refreshRates(); } });

render();
refreshRates();
loadCovers().then(render);

/* ============ 오프라인 (Service Worker) ============ */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW 등록 실패', e));
}
