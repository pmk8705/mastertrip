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
  // 지출마다 기록할 때의 환율을 박제 (나중에 환율이 바뀌어도 지난 지출의 원화는 그대로). 예전 지출은 지금 환율로 고정
  for (const e of t.expenses) if (e.currency !== 'KRW' && !(e.rate > 0)) e.rate = t.budget.rate;
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
// action = { label, run }: 알림 안에 버튼 하나 (5초간)
function toast(msg, action) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('has-act', !!action);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.onclick = () => { el.classList.remove('show'); action.run(); };
    el.append(b);
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 5000 : 1800);
}

/* ============ 여행 표지 사진 · 바우처 (IndexedDB) ============ */
// 사진은 localStorage(약 5MB)에 넣기엔 커서 IndexedDB에 Blob으로 저장한다.
// covers: 여행 id → 표지 사진 / vouchers: 바우처 id → 티켓 사진·PDF (목록은 booking.vouchers에)
// photos: 사진 id → 기록 탭 하루 사진 (목록은 day.photos에, 하루 3장)
let mediaDb;
const openMedia = () => mediaDb || (mediaDb = new Promise((res, rej) => {
  const r = indexedDB.open('mastertrip-media', 3);
  r.onupgradeneeded = () => {
    for (const name of ['covers', 'vouchers', 'photos']) if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name);
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
const photoDb = mediaStore('photos');
const photoUrls = {}; // 사진 id → 화면에 쓸 주소
async function loadPhotos() {
  try {
    const [keys, vals] = await Promise.all([photoDb.keys(), photoDb.values()]);
    keys.forEach((k, i) => { photoUrls[k] = URL.createObjectURL(vals[i]); });
  } catch (e) { console.warn('기록 사진 불러오기 실패', e); }
}
async function deletePhotos(ids) {
  for (const id of ids || []) {
    await photoDb.del(id).catch(() => {});
    if (photoUrls[id]) { URL.revokeObjectURL(photoUrls[id]); delete photoUrls[id]; }
  }
}
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
  $('#modalBody').onclick = null; // 여행 바꾸기 창이 단 클릭 처리를 다른 창에 남기지 않게
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
// '일정' 칸이 보여 주는 여행 (일정 수정 창·지도 등이 쓴다)
function detailTrip() { return focusTrip(); }

/* ============ 라우팅 ============ */
// 하단 탭: 홈 | 여행 | 기록 | 설정. 여행 안의 상단 탭: 일정 | 체크리스트 | 예산 | 예약 (네 칸 모두 focusTrip, 맨 위 tripSwitchRow로 바꾸기)
const MAIN_TABS = ['home', 'trips', 'records', 'settings'];
const SUB_TABS = ['plan', 'check', 'budget', 'book'];
let mainTab = sessionStorage.getItem('main');
if (!MAIN_TABS.includes(mainTab)) mainTab = 'trips';
let subTab = sessionStorage.getItem('sub');
if (!SUB_TABS.includes(subTab)) subTab = 'plan';
let pickedTripId = sessionStorage.getItem('trip') || null;
let tripFilter = { now: true, soon: true, past: false }; // 여행 바꾸기 창의 칩
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

// 여행 카드를 누르면 그 여행의 '일정' 칸으로
function openTrip(id) {
  pickTrip(id);
  selectedDate = null;
  subTab = 'plan';
  remember('sub', subTab);
  setMain('trips');
}
window.addEventListener('popstate', () => {
  closeViewer();
  render();
});

document.querySelectorAll('.tabbar button').forEach((btn) => {
  btn.addEventListener('click', () => setMain(btn.dataset.main));
});
document.querySelectorAll('.top-tabs button').forEach((btn) => {
  btn.addEventListener('click', () => setSub(btn.dataset.sub));
});

const inDetail = () => mainTab === 'trips' && subTab === 'plan' && !!focusTrip();

function render() {
  const detail = inDetail();
  const showHero = mainTab === 'home' || mainTab === 'trips';
  $('#hero').hidden = !showHero;
  $('#hero').classList.toggle('slim', mainTab === 'trips'); // 여행 탭에서는 배너를 얇게 (일정 자리를 넓게)
  $('#topTabs').hidden = mainTab !== 'trips';
  $('#topbar').hidden = showHero;
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.main === mainTab));
  document.querySelectorAll('.top-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.sub === subTab));
  renderTopbar();

  if (leafletMap) { leafletMap.remove(); leafletMap = null; }
  const view = $('#view');
  const oldStrip = $('.day-strip');
  const stripLeft = oldStrip ? oldStrip.scrollLeft : 0; // 다시 그려도 날짜 줄 위치를 유지
  if (mainTab === 'home') view.innerHTML = renderToday();
  else if (mainTab === 'records') view.innerHTML = renderRecords();
  else if (mainTab === 'settings') view.innerHTML = renderSettings();
  else {
    const t = focusTrip();
    if (!t) view.innerHTML = renderNoTrip();
    else view.innerHTML = tripSwitchRow(t) + (subTab === 'plan' ? renderDays(t) : subTab === 'check' ? renderCheck(t) : subTab === 'budget' ? renderBudget(t) : renderBook(t));
  }
  if (mainTab === 'records' && focusTrip()) mountFootprint(focusTrip());
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

function renderTopbar() {
  const h1 = $('#tripTitle');
  const sub = $('#tripSub');
  const t = mainTab === 'trips' && focusTrip();
  document.title = t ? `${t.title} · MasterTrip` : 'MasterTrip Planner';
  if (mainTab === 'records') {
    h1.textContent = '기록';
    sub.textContent = '여행의 순간을 남기는 곳';
  } else if (mainTab === 'settings') {
    h1.textContent = '설정';
    sub.textContent = '화면 · 백업 · 데이터 관리';
  }
}

// 여행 탭 네 칸·기록 맨 위: 지금 보고 있는 여행 (누르면 여행 바꾸기 창) + ✎ 여행 정보 수정
// (D-day·여행 중 표시는 둘째 줄에 이미 있어서 배지는 안 단다. 새 여행은 홈 맨 아래·바꾸기 창에서)
function tripSwitchRow(t) {
  return `<div class="trip-switch-row">
    <button type="button" class="tsr-main" data-act="switch-trip">
      <span class="emo">${esc(t.emoji)}</span>
      <span class="grow"><span class="tsr-title"><b>${esc(t.title)}</b><span class="caret">바꾸기 ▾</span></span><span class="muted small">${tripSub(t)}</span></span>
    </button>
    <button type="button" class="icon-btn" data-act="edit-trip" aria-label="여행 정보 수정">✎</button>
  </div>`;
}

/* ============ 여행 카드 · 홈 ============ */
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
  html += '<button class="cta home-new" data-act="new-trip">＋ 새로운 여행 일정 만들기</button>';
  return html;
}

/* ---------- 기록: 여행 요약 + 하루 카드 (지나간 날·오늘, 최근 날이 위) ---------- */
// 자동으로 모으는 것(완료 체크한 일정, 그날 지출) + 직접 남기는 것(한 줄 평 day.note, 사진은 다음 단계)
function renderRecords() {
  const t = focusTrip();
  if (!t) return renderNoTrip();
  const today = todayStr();
  const cities = new Set(flowSegments(t).filter((x) => x.city).map((x) => x.city));
  const doneCnt = t.days.reduce((n, d) => n + d.items.filter((x) => x.done).length, 0);
  const spent = t.expenses.reduce((s, e) => s + toKRW(t, e), 0);
  const days = t.days.map((d, i) => [d, i]).filter(([d]) => d.date <= today).reverse();
  return `${tripSwitchRow(t)}
    <div class="card rec-summary">
      <div class="rec-big">${t.days.length}일의 여정</div>
      <div class="rec-stats">
        <span><b>${cities.size}</b>도시</span><span><b>${doneCnt}</b>곳 다녀옴</span><span><b>${won(spent)}</b>지출</span>
      </div>
      <button class="btn sm primary story-btn" data-act="story">📸 ${phaseOf(t) === 'soon' ? '곧 떠나요 카드 만들기' : '요약 이미지 만들기'} (9:16)</button>
    </div>
    ${footprintHtml(t)}
    ${days.map(([d, i]) => recordDay(t, d, i)).join('')
      || `<div class="empty-state">여행이 시작되면 하루마다 기록 카드가 생겨요.<br>${fmtDate(t.start)}부터</div>`}`;
}
/* ---------- 기록: 발자취 지도 (도시를 잇는 곡선 + 이동 수단 + 다녀온 곳 핀) ---------- */
// 도시 위치: 날씨용 도시 위치(wx.geo, 도시 중심) → 없으면 그 도시에 머문 날 일정 위치들의 가운데
function footCities(trip) {
  const mid = (arr) => { const a = [...arr].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  return flowSegments(trip).filter((x) => x.city).map((x) => {
    const g = wx.geo[x.city];
    if (g && g.lat != null) return { ...x, lat: g.lat, lng: g.lng };
    const pts = trip.days.filter((d) => x.dates.includes(d.date)).flatMap((d) => d.items.filter(hasPos));
    return pts.length ? { ...x, lat: mid(pts.map((p) => p.lat)), lng: mid(pts.map((p) => p.lng)) } : { ...x };
  });
}
// 도시 사이 이동 수단: 이동하는 날 일정(기차·항공 낱말, 직접 정한 수단) → 없으면 거리(350km 넘으면 비행기)
function footMode(trip, a, b) {
  const day = trip.days.find((d) => d.date === b.dates[0]);
  for (const it of day ? day.items : []) {
    const buf = departBuffer({ ...it, time: '00:00' });
    if (buf) return buf.name === '비행기' ? '✈️' : '🚆';
    if (it.move && it.move.mode === 'flight') return '✈️';
    if (it.move && it.move.mode === 'train') return '🚆';
  }
  return distKm(a, b) > 350 ? '✈️' : '🚆';
}
let footGeoBusy = false;
async function ensureFootGeo(trip) { // 위치를 모르는 도시는 한 번 찾아서 기억 (날씨와 같은 wx.geo)
  if (footGeoBusy || !navigator.onLine || Date.now() - wxFailAt < 5 * 60e3) return;
  const todo = footCities(trip).filter((c) => c.lat == null && !wx.geo[c.city]);
  if (!todo.length) return;
  footGeoBusy = true;
  try {
    for (const c of todo) wx.geo[c.city] = await wxGeocode(c.city, wxCenter(trip));
    saveWx();
  } catch (e) { console.warn('도시 위치 찾기 실패', e); wxFailAt = Date.now(); }
  footGeoBusy = false;
  if (mainTab === 'records') render();
}
function footprintHtml(trip) {
  const cities = footCities(trip);
  if (cities.length < 2) return '';
  if (!navigator.onLine) return '<div class="map-note">발자취 지도는 인터넷이 연결되면 보여요</div>';
  return `<div class="card foot-card"><div class="row foot-head"><b>🗺 발자취</b><span class="spacer"></span>
    <span class="muted small">${cities.map((c) => esc(c.city)).join(' → ')}</span></div><div id="footMap"></div></div>`;
}
function mountFootprint(trip) {
  const el = $('#footMap');
  if (!el || typeof L === 'undefined') return;
  const cities = footCities(trip).filter((c) => c.lat != null);
  if (cities.length < 2) { ensureFootGeo(trip); return; }
  ensureFootGeo(trip); // 일부만 아는 경우 나머지도
  // 전체가 보이는 처음 크기에서는 끌기를 꺼서 페이지가 넘어가게 하고, 확대하면 끌어서 움직일 수 있게 (zoomend에서 켜고 끔)
  leafletMap = L.map(el, { dragging: false, scrollWheelZoom: false, tap: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(leafletMap);
  const bounds = [];
  const modes = []; // 지도 크기가 정해진 뒤 붙인다 (가까운 도시 사이엔 아이콘이 이름을 가려서 뺌)
  cities.forEach((c, i) => {
    bounds.push([c.lat, c.lng]);
    if (!i) return;
    // 앞 도시 → 이 도시: 옆으로 살짝 휜 곡선(2차 베지어) + 가운데에 이동 수단
    const a = cities[i - 1];
    const ctl = { lat: (a.lat + c.lat) / 2 - (c.lng - a.lng) * 0.2, lng: (a.lng + c.lng) / 2 + (c.lat - a.lat) * 0.2 };
    const at = (t) => [(1 - t) ** 2 * a.lat + 2 * (1 - t) * t * ctl.lat + t * t * c.lat, (1 - t) ** 2 * a.lng + 2 * (1 - t) * t * ctl.lng + t * t * c.lng];
    L.polyline(Array.from({ length: 25 }, (_, k) => at(k / 24)), { color: '#FF7A00', weight: 3, dashArray: '6 8', interactive: false }).addTo(leafletMap);
    modes.push({ a, c, pos: at(0.5), mode: footMode(trip, a, c) });
  });
  // 다녀온 곳(완료 체크 + 위치 있는 일정)
  for (const d of trip.days) for (const it of d.items) {
    if (!it.done || !hasPos(it)) continue;
    const col = (ITEM_CATS[it.cat] || ITEM_CATS['기타']).color;
    L.circleMarker([it.lat, it.lng], { radius: 6, color: '#fff', weight: 2, fillColor: col, fillOpacity: 1 }).addTo(leafletMap).bindPopup(`<b>${esc(it.title)}</b><br>${fmtDate(d.date)}`);
  }
  // 도시 이름이 핀 오른쪽에 붙으니 오른쪽 여백을 넉넉히
  leafletMap.fitBounds(bounds, { paddingTopLeft: [30, 30], paddingBottomRight: [95, 30], maxZoom: 9 });
  const map = leafletMap;
  const baseZoom = map.getZoom();
  map.on('zoomend', () => {
    if (map.getZoom() > baseZoom) map.dragging.enable();
    else { map.dragging.disable(); map.fitBounds(bounds, { paddingTopLeft: [30, 30], paddingBottomRight: [95, 30], maxZoom: 9, animate: false }); }
  });
  // 도시 핀 + 이름. 오른쪽 가까이에 다른 도시가 있으면 이름을 왼쪽에 (겹치지 않게)
  const px = cities.map((c) => leafletMap.latLngToContainerPoint([c.lat, c.lng]));
  cities.forEach((c, i) => {
    const crowded = px.some((q, j) => j !== i && q.x > px[i].x && q.x - px[i].x < 150 && Math.abs(q.y - px[i].y) < 30);
    const side = !crowded ? '' : px[i].x > 110 ? ' left' : ' below'; // 왼쪽에 자리가 없으면 아래로
    const icon = L.divIcon({ className: `city-pin${side}`, html: `<span>${i + 1}</span><b>${esc(c.city)}</b>`, iconSize: [26, 26], iconAnchor: [13, 13] });
    L.marker([c.lat, c.lng], { icon, interactive: false, zIndexOffset: 500 }).addTo(leafletMap);
  });
  for (const m of modes) {
    const px = leafletMap.latLngToContainerPoint([m.a.lat, m.a.lng]).distanceTo(leafletMap.latLngToContainerPoint([m.c.lat, m.c.lng]));
    if (px < 110) continue;
    L.marker(m.pos, { icon: L.divIcon({ className: 'mode-pin', html: m.mode, iconSize: [26, 26], iconAnchor: [13, 13] }), interactive: false }).addTo(leafletMap);
  }
}

/* ---------- 기록: 9:16 요약 이미지 (인스타 스토리 크기 1080×1920, canvas에 직접 그림) ---------- */
// 여행 전 = '곧 떠나요' 카드(D-day·경로·가 볼 곳), 여행 중·후 = 요약 카드(다녀온 곳·사진·분류별 지출).
const STORY_W = 1080, STORY_H = 1920;
const loadImg = (url) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = url; });
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
// 사진을 칸에 꽉 차게 (가운데 잘라내기)
function drawCover(g, img, x, y, w, h, r) {
  g.save(); roundRect(g, x, y, w, h, r); g.clip();
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const iw = img.naturalWidth * s, ih = img.naturalHeight * s;
  g.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
  g.restore();
}
// 한 줄에 안 들어가면 말줄임
function fitText(g, text, maxW) {
  if (g.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}
async function drawStory(trip) {
  const c = document.createElement('canvas');
  c.width = STORY_W; c.height = STORY_H;
  const g = c.getContext('2d');
  const F = (w, size) => `${w} ${size}px "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif`;
  const before = phaseOf(trip) === 'soon';
  const cities = flowSegments(trip).filter((x) => x.city).map((x) => x.city);
  const done = trip.days.flatMap((d) => d.items.filter((x) => x.done));
  // 관광·액티비티 일정, 공식 예매처가 있는 유명 명소(알함브라 등)를 먼저
  const sights = (before ? trip.days.flatMap((d) => d.items) : done).filter((x) => ['관광', '액티비티'].includes(x.cat))
    .sort((a, b) => (sightsOf(b).length > 0) - (sightsOf(a).length > 0)).map((x) => x.title.replace(/\s*\(.*?\)\s*/g, ' ').trim());
  const photos = trip.days.flatMap((d) => d.photos || []).filter((id) => photoUrls[id]);

  // 배경: 노을 그라데이션
  const bg = g.createLinearGradient(0, 0, 0, STORY_H);
  bg.addColorStop(0, '#2B1B4A'); bg.addColorStop(0.45, '#B8326A'); bg.addColorStop(1, '#FF7A00');
  g.fillStyle = bg; g.fillRect(0, 0, STORY_W, STORY_H);
  g.fillStyle = '#fff'; g.textBaseline = 'alphabetic';

  // 제목
  g.font = F(600, 40); g.globalAlpha = 0.85;
  g.fillText(before ? '곧 떠나요 ✈️' : '우리의 여행', 80, 150);
  g.globalAlpha = 1; g.font = F(800, 84);
  g.fillText(fitText(g, `${trip.emoji} ${trip.title}`, STORY_W - 160), 80, 250);
  g.font = F(500, 40); g.globalAlpha = 0.9;
  g.fillText(`${fmtRange(trip.start, trip.end)} · ${trip.days.length}일 · ${cities.length}개 도시`, 80, 315);
  g.globalAlpha = 1;

  // 사진: 기록 사진 3장 → 없으면 표지 사진 1장 → 없으면 큰 D-day/요일 글자
  const top = 380, ph = 640;
  const urls = photos.length ? photos.slice(0, 3).map((id) => photoUrls[id]) : coverUrls[trip.id] ? [coverUrls[trip.id]] : [];
  const imgs = (await Promise.all(urls.map(loadImg))).filter(Boolean);
  if (imgs.length >= 3) {
    drawCover(g, imgs[0], 80, top, 920, 390, 36);
    drawCover(g, imgs[1], 80, top + 410, 450, 230, 30);
    drawCover(g, imgs[2], 550, top + 410, 450, 230, 30);
  } else if (imgs.length) {
    drawCover(g, imgs[0], 80, top, 920, ph, 36);
  } else {
    g.fillStyle = 'rgba(255,255,255,.12)'; roundRect(g, 80, top, 920, ph, 36); g.fill();
    g.fillStyle = '#fff'; g.textAlign = 'center';
    if (before) {
      g.font = F(800, 220); g.fillText(`D-${diffDays(trip.start, todayStr())}`, STORY_W / 2, top + ph / 2 + 40);
      g.font = F(500, 44); g.fillText(fmtDate(trip.start) + ' 출발', STORY_W / 2, top + ph / 2 + 130);
    } else {
      g.font = F(800, 300); g.fillText(trip.emoji, STORY_W / 2, top + ph / 2 + 100);
    }
    g.textAlign = 'left';
  }
  if (before && imgs.length) { // 사진 위에 D-day 딱지
    g.fillStyle = '#FF7A00'; roundRect(g, 110, top + 30, 300, 110, 55); g.fill();
    g.fillStyle = '#fff'; g.font = F(800, 64); g.textAlign = 'center';
    g.fillText(`D-${diffDays(trip.start, todayStr())}`, 260, top + 108); g.textAlign = 'left';
  }

  // 경로: 도시를 점으로 잇기
  let y = top + ph + 110;
  g.font = F(700, 38); g.fillText('🗺 경로', 80, y);
  y += 70;
  g.font = F(600, 40);
  const route = fitText(g, cities.join('  →  '), STORY_W - 160);
  g.fillText(route, 80, y);

  // 숫자 세 칸
  y += 90;
  const stats = before
    ? [[`${trip.days.length}일`, '여정'], [`${cities.length}곳`, '도시'], [`${sights.length}곳`, '가 볼 곳']]
    : [[`${done.length}곳`, '다녀온 곳'], [`${photos.length}장`, '사진'], [won(trip.expenses.reduce((s, e) => s + toKRW(trip, e), 0)), '지출']];
  stats.forEach(([v, l], i) => {
    const x = 80 + i * 313;
    g.fillStyle = 'rgba(255,255,255,.16)'; roundRect(g, x, y, 290, 170, 28); g.fill();
    g.fillStyle = '#fff'; g.textAlign = 'center';
    g.font = F(800, v.length > 8 ? 44 : 60); g.fillText(v, x + 145, y + 92);
    g.font = F(500, 32); g.globalAlpha = 0.85; g.fillText(l, x + 145, y + 140); g.globalAlpha = 1;
    g.textAlign = 'left';
  });
  y += 240;

  // 여행 전: 가 볼 곳 / 여행 후: 분류별 지출 막대 (없으면 다녀온 명소)
  const byCat = CATS.map((k) => [k, trip.expenses.filter((e) => e.cat === k).reduce((s, e) => s + toKRW(trip, e), 0)]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (!before && byCat.length) {
    g.font = F(700, 38); g.fillText('💶 어디에 썼나', 80, y); y += 40;
    const max = byCat[0][1];
    for (const [k, v] of byCat) {
      g.font = F(500, 32); g.fillText(k, 80, y + 38);
      g.fillStyle = 'rgba(255,255,255,.2)'; roundRect(g, 220, y + 12, 560, 34, 17); g.fill();
      g.fillStyle = '#fff'; roundRect(g, 220, y + 12, Math.max(34, 560 * v / max), 34, 17); g.fill();
      g.font = F(600, 30); g.textAlign = 'right'; g.fillText(won(v), 1000, y + 38); g.textAlign = 'left';
      y += 62;
    }
  } else if (sights.length) {
    g.font = F(700, 38); g.fillText(before ? '📍 가 볼 곳' : '📍 다녀온 곳', 80, y); y += 66;
    // 두 줄까지: 들어가는 만큼 이어 붙이고 넘치면 다음 줄
    g.font = F(500, 38);
    const lines = [''];
    for (const name of [...new Set(sights)].slice(0, 8)) {
      const next = lines[lines.length - 1] ? `${lines[lines.length - 1]} · ${name}` : name;
      if (g.measureText(next).width <= STORY_W - 160) lines[lines.length - 1] = next;
      else if (lines.length < 2) lines.push(name);
      else break;
    }
    lines.forEach((ln, k) => g.fillText(fitText(g, ln, STORY_W - 160), 80, y + k * 58));
  }

  // 아래 서명
  g.font = F(700, 36); g.globalAlpha = 0.8; g.textAlign = 'center';
  g.fillText('MasterTrip Planner', STORY_W / 2, STORY_H - 80);
  g.globalAlpha = 1; g.textAlign = 'left';
  return new Promise((res) => c.toBlob(res, 'image/png'));
}
// 미리보기 + 공유(인스타·카톡) / 저장
async function openStory(trip) {
  toast('이미지를 만드는 중…');
  const blob = await drawStory(trip);
  const url = URL.createObjectURL(blob);
  const name = `${trip.title.replace(/[\\/:*?"<>|]/g, '').trim() || '여행'}-요약.png`;
  const file = new File([blob], name, { type: 'image/png' });
  const el = viewerShell(phaseOf(trip) === 'soon' ? '곧 떠나요 카드' : '여행 요약 카드', async (act) => {
    if (act === 'share' && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); } catch (e) { /* 닫음 */ }
      return;
    }
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    toast('사진을 저장했어요');
  });
  viewerUrls.push(url);
  el.querySelector('.viewer-body').innerHTML = `<img src="${url}" alt="여행 요약 카드" class="story-img">
    <div class="story-btns"><button type="button" class="btn primary" data-del="share">📤 공유 (인스타·카톡)</button>
    <button type="button" class="btn" data-del="save">⬇ 저장</button></div>`;
}

function recordDay(t, d, i) {
  const done = d.items.filter((x) => x.done);
  const exps = t.expenses.filter((e) => e.date === d.date);
  const krw = exps.reduce((s, e) => s + toKRW(t, e), 0);
  const local = t.currency === 'KRW' ? 0 : exps.filter((e) => e.currency === t.currency).reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const chips = done.map((x) => `<span class="rec-chip">${(ITEM_CATS[x.cat] || ITEM_CATS['기타']).icon} ${esc(x.title)}</span>`).join('');
  return `
    <div class="card rec-day">
      <div class="row"><b>Day ${i + 1}</b><span class="muted small">${fmtDate(d.date)}</span><span class="spacer"></span>${d.city ? `<span class="badge">${esc(d.city)}</span>` : ''}</div>
      <div class="rec-done">${chips || '<span class="muted small">완료 체크한 일정이 없어요</span>'}</div>
      <div class="rec-photos">${(d.photos || []).map((id) => (photoUrls[id]
        ? `<button type="button" class="rec-photo" style="background-image:url('${photoUrls[id]}')" data-act="photo-view" data-date="${d.date}" aria-label="사진 보기"></button>` : '')).join('')}
        ${(d.photos || []).length < PHOTOS_PER_DAY ? `<button type="button" class="rec-photo add" data-act="photo-add" data-date="${d.date}">＋<span>사진</span></button>` : ''}</div>
      <div class="row rec-money"><span class="muted small">지출</span><span class="spacer"></span><b class="num">${won(krw)}</b>${local ? `<span class="muted small">${money(local, t.currency)}</span>` : ''}</div>
      <button type="button" class="rec-note ${d.note ? '' : 'empty'}" data-act="day-note" data-date="${d.date}">${d.note ? `“${esc(d.note)}”` : '✎ 오늘의 한 줄 남기기'}</button>
    </div>`;
}
// 하루 사진: 최대 3장, 긴 변 1600px JPEG. 고르기 칸은 #view 밖(importPicker와 같은 이유)
const PHOTOS_PER_DAY = 3;
let photoTarget = null; // { tripId, date }
const photoPicker = Object.assign(document.createElement('input'), { type: 'file', hidden: true, accept: 'image/*', multiple: true });
document.body.append(photoPicker);
photoPicker.addEventListener('change', async () => {
  const files = [...photoPicker.files];
  photoPicker.value = '';
  const trip = photoTarget && getTrip(photoTarget.tripId);
  const d = trip && trip.days.find((x) => x.date === photoTarget.date);
  if (!d) return;
  d.photos = d.photos || [];
  const room = PHOTOS_PER_DAY - d.photos.length;
  if (files.length > room) toast(`하루 ${PHOTOS_PER_DAY}장까지예요. 앞의 ${room}장만 넣을게요`);
  for (const f of files.slice(0, room)) {
    try {
      const blob = await shrinkImage(f, 1600);
      const id = 'p-' + uid();
      await photoDb.set(id, blob);
      photoUrls[id] = URL.createObjectURL(blob);
      d.photos.push(id);
    } catch (e) { console.warn(e); toast('사진을 넣지 못했어요'); }
  }
  save();
  render();
});
function openDayPhotos(trip, date) {
  const d = trip.days.find((x) => x.date === date);
  const el = viewerShell(`${fmtDate(date)} 사진`, (id) => {
    if (!confirm('이 사진을 뺄까요?')) return;
    d.photos = d.photos.filter((x) => x !== id);
    deletePhotos([id]);
    save();
    history.back(); // 보기 닫기 → 화면 다시 그림
  });
  el.querySelector('.viewer-body').innerHTML = (d.photos || []).map((id) => (photoUrls[id]
    ? `<img src="${photoUrls[id]}" alt=""><button type="button" class="btn sm viewer-del" data-del="${id}">이 사진 빼기</button>` : '')).join('')
    + '<p class="viewer-note">사진을 누르면 크게</p>';
}

function noteForm(trip, date) {
  const d = trip.days.find((x) => x.date === date);
  openModal({
    title: `${fmtDate(date)} 한 줄`,
    fields: [{ name: 'note', label: '오늘의 한 줄 (100자까지)', type: 'textarea', value: d.note || '', placeholder: '예: 알함브라 야경이 꿈같았다' }],
    onSave: (v) => { if (v.note) d.note = v.note.slice(0, 100); else delete d.note; },
    onDelete: d.note ? () => { delete d.note; } : null,
    deleteConfirm: '한 줄을 지울까요?',
  });
  $('#modalBody textarea').maxLength = 100;
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
    html: `<div class="field-row emoji-row">${fieldHtml({ name: 'emoji', label: '아이콘', value: t.emoji })}${fieldHtml({ name: 'title', label: '여행 이름', value: t.title, required: true, placeholder: '예: 제주도 힐링 여행' })}</div>
      ${fieldHtml({ name: 'places', label: '여행지 (도시)', value: t.places, placeholder: '예: 제주시 · 서귀포' })}
      ${rangeCalHtml(t.start, t.end)}`,
    fields: [
      { name: 'people', label: '인원 (숙소·항공 찾기에 쓰여요)', type: 'number', value: t.people },
      { name: 'region', label: '지역', type: 'select', options: ['해외', '국내'], value: t.region },
      { name: 'currency', label: '현지 통화 (해외) — 여행지를 쓰면 자동으로 골라요', type: 'select', value: curPicked,
        options: [...COUNTRY_OPTIONS, { v: '', l: '✏️ 목록에 없는 나라 (통화 직접 입력)' }] },
      { name: 'currencyOther', label: '통화 코드 (영문 3글자)', value: otherCur, list: CURRENCIES, placeholder: '예: CAD, NZD' },
      { name: 'rate', label: '환율: 현지 통화 1단위 = ?원 (내가 환전한 환율을 넣으면 고정, 비우면 자동)', type: 'number', value: autoRate || t.region === '국내' ? '' : t.budget.rate,
        placeholder: autoRate && t.budget.rate > 1 ? `자동 (지금 ${t.budget.rate}원)` : '자동' },
    ],
    onSave: (d) => {
      if (!d.start || !d.end || d.end < d.start) { toast(d.start ? '달력에서 도착일(돌아오는 날)도 눌러 주세요' : '달력에서 출발일과 도착일을 눌러 주세요'); return false; }
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
      deletePhotos(trip.days.flatMap((d) => d.photos || []));
      if (pickedTripId === trip.id) pickTrip(null);
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
          받는 사람은 여행 탭 ▾(여행 바꾸기) → '📥 받은 여행 열기'로 열면 이 여행만 추가돼요(이미 있으면 새 내용으로 바뀜).</div>
      </div>`);
    $('#shareTripBtn').onclick = () => shareTrip(trip);
    $('#saveTripBtn').onclick = () => shareTrip(trip, true);
  }

  wireRangeCal();

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

/* ---------- 여행 날짜: 달력 하나에서 출발일 → 도착일 순서로 누르기 ---------- */
// 값은 숨은 칸 start/end에 담아 폼과 함께 저장된다. 둘 다 골라진 뒤 다시 누르면 출발일부터 새로 고른다.
function rangeCalHtml(start, end) {
  return `<div class="field rcal-field"><span>여행 날짜 — 출발일 → 도착일 순서로 눌러요 (좌우로 밀면 다른 달)</span>
    <input type="hidden" name="start" value="${esc(start)}"><input type="hidden" name="end" value="${esc(end)}">
    <div class="rcal-sum" id="rcalSum"></div>
    <div class="rcal">
      <div class="rcal-head">
        <button type="button" class="icon-btn" data-cal-step="-1" aria-label="이전 달">‹</button>
        <b id="rcalMonth"></b>
        <button type="button" class="icon-btn" data-cal-step="1" aria-label="다음 달">›</button>
      </div>
      <div class="rcal-grid rcal-week">${WEEK.map((w) => `<span>${w}</span>`).join('')}</div>
      <div class="rcal-grid" id="rcalDays"></div>
    </div>
  </div>`;
}

function wireRangeCal() {
  const form = $('#modalForm');
  const inS = form.elements.start, inE = form.elements.end;
  const base = parseDate(inS.value || todayStr());
  let view = new Date(base.getFullYear(), base.getMonth(), 1);
  const draw = () => {
    const s = inS.value, e = inE.value, today = todayStr();
    const box = (label, v, on) => `<div class="rcal-box ${on ? 'on' : ''}"><small>${label}</small><b>${v ? fmtDate(v) : '날짜 선택'}</b></div>`;
    $('#rcalSum').innerHTML = box('출발', s, !s || (s && e)) + '<span class="rcal-arrow">→</span>' + box('도착', e, s && !e)
      + (s && e ? `<span class="rcal-len">${diffDays(e, s) + 1}일</span>` : '');
    $('#rcalMonth').textContent = `${view.getFullYear()}년 ${view.getMonth() + 1}월`;
    const first = ymd(view);
    const lead = view.getDay();
    const count = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    let html = '<span></span>'.repeat(lead);
    for (let i = 0; i < count; i++) {
      const d = addDays(first, i);
      const cls = ['rcal-day',
        d === s && 'start', d === e && 'end', d === s && (!e || e === s) && 'solo', s && e && d > s && d < e && 'mid',
        d === today && 'today', (lead + i) % 7 === 0 && 'sun'].filter(Boolean).join(' ');
      html += `<button type="button" class="${cls}" data-cal-day="${d}">${i + 1}</button>`;
    }
    $('#rcalDays').innerHTML = html;
  };
  const cal = form.querySelector('.rcal');
  const stepMonth = (dir) => {
    view = new Date(view.getFullYear(), view.getMonth() + dir, 1);
    draw();
    const grid = $('#rcalDays');
    grid.classList.remove('slide-l', 'slide-r');
    void grid.offsetWidth; // 연달아 넘겨도 애니메이션이 다시 돌게
    grid.classList.add(dir > 0 ? 'slide-l' : 'slide-r');
  };
  // 좌우로 밀어도 다른 달로 (일정 날짜 넘기기와 같은 기준)
  let swipe = null;
  cal.ontouchstart = (ev) => { const p = ev.touches[0]; swipe = { x: p.clientX, y: p.clientY }; };
  cal.ontouchend = (ev) => {
    if (!swipe) return;
    const p = ev.changedTouches[0];
    const dx = p.clientX - swipe.x, dy = p.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
    ev.preventDefault(); // 민 끝에 날짜가 눌리지 않게
    stepMonth(dx < 0 ? 1 : -1);
  };
  cal.onclick = (ev) => {
    const step = ev.target.closest('[data-cal-step]');
    if (step) return stepMonth(Number(step.dataset.calStep));
    const b = ev.target.closest('[data-cal-day]');
    if (!b) return;
    const d = b.dataset.calDay;
    if (!inS.value || inE.value || d < inS.value) { inS.value = d; inE.value = ''; } // 새로 시작 (출발일보다 앞을 누르면 출발일을 옮김)
    else inE.value = d; // 같은 날을 누르면 당일치기
    draw();
  };
  draw();
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

const PICK_LABEL = { now: '여행 중', soon: '다가오는', past: '지난 여행' };
// 여행 바꾸기 창: 검색 + 상태 칩 + 새 여행·받은 여행 열기 + 여행 목록 (자동 선택 포함)
function tripPicker({ search = false } = {}) {
  searchQuery = '';
  const rows = () => {
    const cur = pickedTripId;
    const q = searchQuery.trim().toLowerCase();
    // 검색 중에는 지난 여행까지 모두 찾는다
    const list = sortTrips(state.trips.filter((t) => (q ? `${t.title} ${t.places}`.toLowerCase().includes(q) : tripFilter[phaseOf(t)])));
    const auto = q ? '' : `<button type="button" class="pick-row ${!cur ? 'on' : ''}" data-pick=""><span>✨</span><span class="grow"><b>자동 선택</b><br><span class="muted small">여행 중이거나 가장 가까운 여행</span></span></button>`;
    const html = list.map((t) => `
      <button type="button" class="pick-row ${t.id === cur ? 'on' : ''}" data-pick="${t.id}">
        <span class="pick-cover" style="${coverStyle(t)}">${esc(t.emoji)}</span>
        <span class="grow"><b>${esc(t.title)}</b><br><span class="muted small">${fmtRange(t.start, t.end)}${t.places ? ' · ' + esc(t.places) : ''}</span></span>${tripBadge(t)}
      </button>`).join('');
    return auto + (html || `<div class="empty-state">${q ? '검색 결과가 없어요' : state.trips.length ? '이 조건에 맞는 여행이 없어요' : '아직 여행이 없어요'}</div>`);
  };
  const chips = () => {
    const counts = { now: 0, soon: 0, past: 0 };
    state.trips.forEach((t) => counts[phaseOf(t)]++);
    return Object.keys(PICK_LABEL).map((p) => `
      <button type="button" class="chip-f ${tripFilter[p] ? 'active' : ''}" data-filter="${p}">${tripFilter[p] ? '<i class="dot"></i>' : ''}${PICK_LABEL[p]} (${counts[p]})</button>`).join('');
  };
  openModal({
    title: '어느 여행을 볼까요?',
    html: `
      <div class="search-box"><input id="searchInput" type="search" placeholder="여행 이름·도시 검색" value="${esc(searchQuery)}" autocomplete="off"></div>
      <div class="chips-row" id="pickChips">${chips()}</div>
      <div class="pick-new">
        <button type="button" class="btn primary" data-pick-act="new">+ 새 여행</button>
        <button type="button" class="btn" data-pick-act="import">📥 받은 여행 열기</button>
      </div>
      <div id="pickList">${rows()}</div>`,
  });
  const body = $('#modalBody');
  const done = (fn) => { modal.close(); fn(); };
  body.onclick = (ev) => {
    const f = ev.target.closest('[data-filter]');
    if (f) {
      tripFilter[f.dataset.filter] = !tripFilter[f.dataset.filter];
      $('#pickChips').innerHTML = chips();
      $('#pickList').innerHTML = rows();
      return;
    }
    const act = ev.target.closest('[data-pick-act]');
    if (act) return done(() => (act.dataset.pickAct === 'new' ? tripForm(null) : importPicker.click()));
    const b = ev.target.closest('[data-pick]');
    if (b) done(() => { pickTrip(b.dataset.pick || null); selectedDate = null; render(); window.scrollTo(0, 0); });
  };
  const input = $('#searchInput');
  input.oninput = () => { searchQuery = input.value; $('#pickList').innerHTML = rows(); };
  if (search) input.focus();
}

/* ============ 지도 · 장소 검색 ============ */
// 지도 그림: OpenStreetMap 타일 + Leaflet (vendor/leaflet). 장소 검색: OpenStreetMap Nominatim.
// Nominatim 규칙: 1초에 1번까지, 글자 칠 때마다 자동 검색 금지(버튼으로만 검색), 출처 표시.
let leafletMap = null;
let mapOpen = sessionStorage.getItem('map') !== '0';
let geocoding = false;
const hasPos = (it) => typeof it.lat === 'number' && typeof it.lng === 'number';

// 국내 여행은 네이버 지도, 해외는 구글 지도 웹사이트로 (앱이 없어도 열림)
// 인터넷이 없으면 웹 지도는 안 열리니 폰의 지도 앱으로 (미리 받아 둔 오프라인 지도를 쓸 수 있게).
// 해외 = geo: (지도 앱 고르기), 국내 = 네이버 지도 앱. web=true면 항상 웹 (장소 찾기 버튼용)
function mapLink(trip, it, web) {
  const q = it.place || (hasPos(it) ? `${it.lat},${it.lng}` : '');
  if (!q) return null;
  if (!web && !navigator.onLine) {
    const name = encodeURIComponent(it.title || it.place || '');
    if (trip.region === '국내') {
      const url = hasPos(it) ? `nmap://place?lat=${it.lat}&lng=${it.lng}&name=${name}&appname=pmk8705.github.io`
        : `nmap://search?query=${encodeURIComponent(q)}&appname=pmk8705.github.io`;
      return { url, label: '📱 네이버 지도 앱으로 보기 ›', app: true };
    }
    const url = hasPos(it) ? `geo:${it.lat},${it.lng}?q=${it.lat},${it.lng}(${name})` : `geo:0,0?q=${encodeURIComponent(q)}`;
    return { url, label: '📱 지도 앱으로 보기 ›', app: true };
  }
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
  const hasDepart = day.items.some(departBuffer);

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
    <p class="muted small" style="text-align:center;margin-top:14px">일정을 누르면 수정, 좌우로 밀면 다른 날로 넘어가요.<br>왼쪽 동그라미를 잡고 위아래로 끌면 순서가 바뀌어요.${hasLeg ? '<br>“자동” 이동 시간은 직선거리 어림값이에요. 이동 줄을 눌러 수단·시간을 정할 수 있어요.' : ''}${hasDepart ? '<br>기차·비행기 일정의 시간은 출발 시각으로 보고, 역 30분·공항 2시간 전 도착 여유를 확인해요.' : ''}</p>`;
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
// 기차·비행기 일정('이동' 분류 + 이름·메모에 낱말, '…도착' 일정 제외)은 그 시간을 출발 시각으로 보고
// 역·공항에 미리 가 있을 여유(기차 30분, 비행기 2시간)가 있는지 본다.
const DEPART_BUFFER = [
  { re: /비행|항공|flight/i, min: 120, name: '비행기', place: '공항' },
  { re: /기차|열차|렌페|Renfe|AVE|KTX|SRT|TGV|고속철|train/i, min: 30, name: '기차', place: '역' },
];
function departBuffer(it) {
  if (it.cat !== '이동' || !isHHMM(it.time) || /도착/.test(it.title)) return null;
  const text = `${it.title} ${it.memo || ''}`;
  return DEPART_BUFFER.find((d) => d.re.test(text)) || null;
}
function legHtml(a, b) {
  const leg = travelLeg(a, b);
  const ra = itemRange(a), rb = itemRange(b);
  const gap = ra && rb ? rb.start - ra.end : null;
  const buf = departBuffer(b);
  const spare = buf && gap != null ? gap - ((leg && leg.min) || 0) : null; // 역·공항에 도착한 뒤 남는 시간
  const bufWarn = spare != null && spare < buf.min
    ? `⚠ ${buf.name} 출발 ${fmtMin(buf.min)} 전에는 ${buf.place}에 있는 게 좋아요 (지금 여유 ${spare > 0 ? fmtMin(spare) : '없음'})` : '';
  if (!leg || (!leg.manual && leg.km < 0.05)) {
    return bufWarn ? `<li class="tl2-leg tight"><span class="leg-warn">${bufWarn}</span></li>` : '';
  }
  // 자동일 때는 '이동' 일정이 끼었거나 장거리면 경고하지 않음 (그 일정 자체가 이동이라 헛경고). 직접 정했으면 항상 확인
  const skip = !leg.manual && (a.cat === '이동' || b.cat === '이동' || leg.km > 30);
  const tight = !bufWarn && !skip && leg.min != null && gap != null && gap >= 0 && leg.min > gap;
  const parts = [`${leg.icon} ${esc(leg.name)}`];
  if (leg.min != null) parts.push(`${leg.manual && b.move.min != null && b.move.min !== '' ? '' : '약 '}${fmtMin(leg.min)}`);
  if (leg.km != null) parts.push(fmtDist(leg.km));
  return `
    <li class="tl2-leg ${tight || bufWarn ? 'tight' : ''} ${leg.manual ? 'set' : 'auto'}">
      <button class="leg-text" data-act="edit-leg" data-id="${b.id}">${parts.join(' · ')}${leg.manual ? '' : ' <span class="leg-auto">자동</span>'} <span class="leg-edit">✎</span></button>
      ${leg.memo ? `<div class="leg-memo">${esc(leg.memo)}</div>` : ''}
      ${tight ? `<span class="leg-warn">⚠ 이동 시간이 빠듯해요 (여유 ${fmtMin(gap)})</span>` : ''}
      ${bufWarn ? `<span class="leg-warn">${bufWarn}</span>` : ''}
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
  const links = ticketLinks(it) + (link ? `<a class="map-btn" href="${link.url}"${link.app ? '' : ' target="_blank" rel="noopener"'} data-act="link">${link.label}</a>` : '');
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
        <button type="button" class="link-btn" id="copyPosBtn" ${hasPos(item) ? '' : 'hidden'}>📋 좌표 복사 (다른 지도 앱에 붙여넣기)</button>
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
  const copyBtn = $('#copyPosBtn');
  const setPos = (lat, lng) => { form.lat.value = lat; form.lng.value = lng; copyBtn.hidden = lat === ''; };
  copyBtn.onclick = async () => {
    const text = `${form.lat.value}, ${form.lng.value}`;
    try { await navigator.clipboard.writeText(text); toast(`좌표를 복사했어요 (${text})`); } catch (e) { prompt('아래 좌표를 길게 눌러 복사하세요', text); }
  };

  // 지도 사이트에서 찾아보기 (국내 = 네이버, 해외 = 구글). 입력이 비어 있으면 그날 도시 지도
  const findBtn = $('#mapFindBtn');
  const updateFind = () => {
    const q = input.value.trim() || firstCity(day) || trip.places.split('·')[0].trim() || trip.title;
    const link = mapLink(trip, { place: q }, true);
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
const toKRW = (trip, e) => (e.currency === 'KRW' ? e.amount : e.amount * (e.rate || trip.budget.rate));

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

  // 환율 계산기: 현지 금액 → 원화, 바로 지출로 (식당·가게에서 계산기 앱 없이)
  const calc = cur === 'KRW' ? '' : `
    <div class="card calc">
      <div class="row"><b>💱 계산기</b><span class="spacer"></span><span class="muted small">${money(1, cur)} = ${rate.toLocaleString('ko-KR')}원</span></div>
      <div class="calc-row">
        <input id="calcIn" type="number" inputmode="decimal" step="any" min="0" placeholder="${cur} 금액" value="${calcValue}">
        <span class="muted">≈</span><b id="calcOut" class="num">${won((Number(calcValue) || 0) * rate)}</b>
      </div>
      <button class="btn sm primary" data-act="calc-add">이 금액 지출에 추가</button>
    </div>`;
  return `${calc}
    <div class="card">
      <div class="stat-grid">
        <div class="stat"><div class="label">총 예산</div><div class="value">${won(planTotal)}</div></div>
        <div class="stat"><div class="label">사용</div><div class="value">${won(spent)}</div></div>
        <div class="stat"><div class="label">남은 예산</div><div class="value" style="color:${left < 0 ? 'var(--danger)' : 'inherit'}">${won(left)}</div></div>
        <div class="stat"><div class="label">오늘 지출</div><div class="value">${won(todaySpent)}</div></div>
      </div>
      ${planned ? `<div class="row small" style="margin-top:10px"><span class="muted">일정에 적은 예상 경비</span><span class="spacer"></span><b class="num">${money(planned, cur)}${cur !== 'KRW' ? ` ≈ ${won(planned * rate)}` : ''}</b></div>` : ''}
      <div class="row" style="margin-top:10px">
        <span class="muted small">${cur === 'KRW' ? '원화 여행' : `환율 ${money(1, cur)} = ${rate.toLocaleString('ko-KR')}원<br>${rateNote(trip)}${trip.budget.rateAuto ? ' <button class="link-btn" data-act="rate-refresh">🔄 새로고침</button>' : ''}`}</span>
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
      ...(trip.currency === 'KRW' ? [] : [{ name: 'rate', label: `적용 환율: 1 ${trip.currency} = ?원 (카드 명세서 환율로 고칠 수 있어요)`, type: 'number',
        value: e.rate || '', placeholder: `비우면 지금 환율 ${trip.budget.rate}원` }]),
    ],
    onSave: (d) => {
      const amt = parseFloat(d.amount.replace(/,/g, ''));
      if (!(amt > 0)) { toast('금액을 입력하세요'); return false; }
      const rate = parseFloat(d.rate);
      delete d.rate;
      Object.assign(e, d, { amount: amt });
      if (e.currency === 'KRW') delete e.rate;
      else e.rate = rate > 0 ? rate : trip.budget.rate; // 기록하는 순간의 환율을 박제
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
      ...(foreign ? [{ name: 'rate', label: `환율: 1 ${trip.currency} = ?원 (내가 환전한 환율을 넣으면 고정, 비우면 자동)`, type: 'number', value: rateAuto ? '' : rate,
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
// 전체 화면 틀 (바우처·기록 사진 같이 씀). onAct: data-del 같은 단추를 누르면 불림
function viewerShell(title, onAct) {
  closeViewer();
  const el = document.createElement('div');
  el.id = 'viewer';
  el.innerHTML = `<div class="viewer-bar"><b>${esc(title)}</b><span class="spacer"></span><button type="button" class="btn sm" data-close>닫기 ✕</button></div>
    <div class="viewer-body"><p class="viewer-note">불러오는 중…</p></div>`;
  document.body.append(el);
  document.body.classList.add('viewer-open');
  history.pushState({ ...(history.state || {}), viewer: 1 }, '');
  el.onclick = (ev) => {
    if (ev.target.closest('[data-close]')) return history.back();
    const act = ev.target.closest('[data-del]');
    if (act && onAct) return onAct(act.dataset.del);
    const img = ev.target.closest('img');
    if (img) img.classList.toggle('zoom');
  };
  return el;
}
async function openVoucher(b) {
  if (!b || !(b.vouchers || []).length) return;
  const el = viewerShell(b.title);
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

/* ---------- 비상 서류 (여권 사본·보험·E-티켓) — 여행과 상관없이 하나, 예약 탭 맨 위 ---------- */
// 파일은 바우처와 같은 IndexedDB(voucherDb), 목록은 state.vault.docs. 백업에는 들어가고 여행 보내기 파일에는 안 들어간다.
// 잠금 = 폰 잠금(지문·얼굴·패턴·비밀번호)으로 확인 (WebAuthn 패스키, 서버 없이 폰 안에서만). 잊을 PIN이 없다.
// 파일 자체를 암호화하지는 않는다: 폰을 잠깐 빌려준 사람·주운 사람은 막지만, 개발 도구로 저장소를 뒤지는 사람까지는 못 막는다.
let vaultOpen = false; // 이번에 폰 잠금으로 확인했는지 (앱이 뒤로 가면 다시 잠금)
const vault = () => (state.vault = state.vault || { docs: [], lock: '' }); // lock = 패스키 id (base64url)
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const canPhoneLock = async () => {
  try { return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); } catch (e) { return false; }
};
// 폰 잠금 켜기: 이 폰에 패스키를 하나 만든다 (만들 때도 지문·패턴 확인)
async function lockOn() {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'MasterTrip' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'mastertrip-vault', displayName: 'MasterTrip 비상 서류' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      timeout: 60000,
    },
  });
  return b64u(cred.rawId);
}
// 폰 잠금 확인: 성공 + '사용자 확인(UV)' 표시가 있어야 연다
async function phoneUnlock(lock) {
  const got = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: unb64u(lock), transports: ['internal'] }],
      userVerification: 'required',
      timeout: 60000,
    },
  });
  const flags = new Uint8Array(got.response.authenticatorData)[32];
  return !!(flags & 0x04);
}
function vaultCard() {
  const v = vault();
  const n = v.docs.filter((d) => !d.from).length;
  const lock = v.lock ? `<span class="muted small">${vaultOpen ? '🔓' : '🔒'}</span>` : '';
  return `
    <div class="card vault">
      <div class="row"><b>🛂 비상 서류</b>${lock}<span class="spacer"></span>
        ${n ? `<button class="btn sm primary" data-act="vault-view">보기 (${n})</button>` : ''}
        <button class="btn sm" data-act="vault-edit">${n ? '관리' : '+ 넣기'}</button></div>
      <div class="muted small">여권 사본·여행자 보험·E-티켓 · 인터넷 없이 열려요. 카드 분실 신고 번호는 아래 긴급 연락처에.</div>
    </div>`;
}
// 잠금이 켜져 있으면 먼저 폰 잠금으로 확인한다
async function withVault(fn) {
  const v = vault();
  if (!v.lock || vaultOpen) return fn();
  try {
    if (!(await phoneUnlock(v.lock))) throw new Error('확인 안 됨');
    vaultOpen = true;
    render();
    fn();
  } catch (e) {
    console.warn('폰 잠금 확인 실패', e);
    // 그냥 취소한 경우가 대부분이라 지우기는 두 번 묻는다
    if (confirm('폰 잠금으로 확인하지 못했어요.\n\n폰을 바꿨거나 패스키를 지웠다면 열 수 없어요. 서류를 모두 지우고 잠금을 끌까요?\n(그냥 다시 시도하려면 취소)')
      && confirm('비상 서류를 모두 지워요. 되돌릴 수 없어요. 계속할까요?')) {
      deleteVouchers(v.docs);
      v.docs = [];
      v.lock = '';
      save();
      render();
      toast('비상 서류를 지우고 잠금을 껐어요');
    }
  }
}
function vaultForm() {
  const v = vault();
  openModal({
    title: '🛂 비상 서류',
    html: `<p class="small muted" style="margin-top:0">여권 사본(사진 면), 여행자 보험 증권, 항공 E-티켓 등. 모든 여행에서 같이 보여요.<br>
      ⚠ 백업 파일에는 함께 들어가니 백업 파일을 남에게 보내지 마세요. '여행 보내기' 파일에는 들어가지 않아요.</p>`,
    onSave: () => {
      const prev = v.docs;
      v.docs = files.list();
      files.commit(prev).catch(() => toast('서류 저장에 실패했어요'));
    },
  });
  const files = fileListEditor(v.docs, '서류 (사진·PDF)');
  $('#modalBody').insertAdjacentHTML('beforeend', `
    <div class="field"><span>잠금</span><div id="lockRow" class="small muted">확인하는 중…</div></div>`);
  const row = $('#lockRow');
  const draw = async () => {
    if (v.lock) {
      row.innerHTML = '🔒 <b>폰 잠금(지문·패턴)</b>으로 열려요 · <button type="button" class="link-btn" id="lockBtn">잠금 끄기</button>';
    } else if (await canPhoneLock()) {
      row.innerHTML = '<button type="button" class="btn sm" id="lockBtn">🔐 폰 잠금(지문·패턴)으로 가리기</button><div style="margin-top:4px">볼 때마다 지문이나 폰 잠금을 확인해요. 폰에 MasterTrip 패스키가 하나 만들어져요.</div>';
    } else {
      row.textContent = '이 기기는 폰 잠금 연동을 쓸 수 없어요. 폰 자체 잠금을 꼭 켜 두세요.';
      return;
    }
    $('#lockBtn').onclick = async () => {
      if (v.lock) {
        v.lock = '';
        save();
        toast('잠금을 껐어요');
      } else {
        try {
          v.lock = await lockOn();
          vaultOpen = true;
          save();
          toast('이제 폰 잠금으로 확인해야 열려요');
        } catch (e) {
          console.warn('패스키 만들기 실패', e);
          toast('폰 잠금 연결을 하지 못했어요');
        }
      }
      render();
      draw();
    };
  };
  draw();
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

  return `${vaultCard()}
    ${missing ? `<div class="notice">아직 예약번호를 입력하지 않은 항목이 ${missing}개 있어요. 예약하면 바로 입력해 두세요.</div>` : ''}
    <div class="card" style="padding:4px 14px">${rows || '<div class="empty-state">예약이 없어요</div>'}</div>
    <button class="add-btn" data-act="add-book">+ 예약 추가</button>
    <div class="section-title"><h3>긴급 연락처</h3></div>
    <div class="card" style="padding:4px 14px">${contacts || '<div class="empty-state">연락처가 없어요</div>'}</div>
    <button class="add-btn" data-act="add-contact">+ 연락처 추가</button>`;
}

// 모달 안 '사진·PDF 목록' 편집기 (바우처·비상 서류가 같이 씀). 저장을 눌러야 반영(취소하면 그대로):
// list()가 새 목록, commit(옛 목록)이 새 파일을 IndexedDB에 넣고 뺀 파일을 지운다.
function fileListEditor(initial, label) {
  let vList = [...(initial || [])];
  const added = new Map(); // 새로 넣은 파일 id → Blob
  $('#modalBody').insertAdjacentHTML('beforeend', `
    <div class="field"><span>${label}</span>
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
    // 처리하는 동안 저장을 잠근다 (끝나기 전에 저장하면 목록에만 있고 파일은 안 남던 문제)
    $('#modalSave').disabled = true;
    for (const f of ev.target.files) {
      const blob = await voucherBlob(f).catch(() => null);
      if (!blob) { toast(`${f.name}: 사진이나 15MB 이하 PDF만 넣을 수 있어요`); continue; }
      const v = { id: 'v-' + uid(), name: f.name, type: blob.type || f.type };
      added.set(v.id, blob);
      vList.push(v);
      if (isPdf(v)) await addPdfPages(f, v);
    }
    ev.target.value = '';
    $('#modalSave').disabled = false;
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
    }
  }
  return {
    list: () => [...vList],
    commit: async (prev) => {
      const gone = (prev || []).filter((v) => !vList.includes(v));
      await Promise.all([...added].filter(([id]) => vList.some((v) => v.id === id)).map(([id, blob]) => voucherDb.set(id, blob)));
      await deleteVouchers(gone);
    },
  };
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
      const prev = b.vouchers || [];
      b.vouchers = files.list();
      if (isNew) trip.bookings.push(b);
      files.commit(prev).catch(() => toast('바우처 저장에 실패했어요'));
    },
    onDelete: isNew ? null : () => {
      deleteVouchers(b.vouchers);
      trip.bookings = trip.bookings.filter((x) => x !== b);
      for (const d of trip.days) for (const it of d.items) if (it.bookingId === b.id) it.bookingId = ''; // 일정 연결도 풀기
    },
  });

  const files = fileListEditor(b.vouchers, '바우처 · 티켓 (인터넷 없이 보기)');
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
        <button type="button" class="btn" data-act="import-file">⬆ 가져오기</button>
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
  state = migrate(seedData()); pickTrip(null); save(); render(); toast('초기화했어요'); // migrate: 분류 등 기본값 채우기
  clearCovers().then(render);
  voucherDb.clear().catch(() => {});
  photoDb.clear().catch(() => {});
  Object.keys(photoUrls).forEach((k) => { URL.revokeObjectURL(photoUrls[k]); delete photoUrls[k]; });
}

async function exportData() {
  // 백업 파일에는 표지 사진·바우처·기록 사진도 함께 넣는다 (dataURL)
  if (vault().docs.length && !confirm('백업 파일에 비상 서류(여권 사본 등)도 들어가요.\n\n파일 자체는 암호화되지 않아서, 다른 폰이나 PC에서 열면 잠금 없이 보여요. 안전한 곳에만 보관하세요.\n\n계속 내보낼까요?')) return;
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
  const photos = await dump(photoDb);
  const blob = new Blob([JSON.stringify({ ...state, covers, vouchers, photos }, null, 2)], { type: 'application/json' });
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
  const text = [['MasterTrip trip file', 20, 780], ['Open this file in the MasterTrip app:', 12, 748], ['Trips tab > trip switcher > Open received trip  (or Settings > Import)', 12, 728]]
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
  // 기록 사진은 각자 폰의 것이라 보내지 않는다 (파일이 너무 커짐). 한 줄 평은 보냄
  const plain = { ...trip, days: trip.days.map(({ photos, ...d }) => d) };
  const data = { type: TRIP_FILE, v: 1, sentAt: new Date().toISOString(), trip: plain, covers, vouchers };
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
// 이미 있는 여행을 받으면: 일정·예약만 업데이트(기본) / 전체 바꾸기 / 닫기(취소)
function askImportMode(old, when) {
  return new Promise((res) => {
    let picked = null;
    openModal({
      title: '받은 여행',
      html: `<p style="margin-top:0">이미 있는 “${esc(old.title)}” 여행이에요${when}. 어떻게 할까요?</p>
        <div class="col-btns">
          <button type="button" class="btn primary" data-m="plan">일정·예약만 업데이트<br><span class="small">내 지출·한 줄 평·사진·완료 체크는 그대로</span></button>
          <button type="button" class="btn" data-m="all">전체 바꾸기<br><span class="small">지출·한 줄 평도 받은 내용으로 (사진은 그대로)</span></button>
        </div>`,
    });
    // 고르는 즉시 끝낸다 ('close' 이벤트는 화면이 가려져 있으면 늦거나 안 올 수 있어 닫기·뒤로가기 때만 보조로)
    const finish = (m) => {
      if (picked !== null) return;
      picked = m || '';
      $('#modalBody').onclick = null;
      $('#modalCancel').removeEventListener('click', onCancel);
      modal.removeEventListener('close', onCancel);
      if (modal.open) modal.close();
      res(m || null);
    };
    const onCancel = () => finish(null);
    $('#modalBody').onclick = (ev) => {
      const b = ev.target.closest('[data-m]');
      if (b) finish(b.dataset.m);
    };
    $('#modalCancel').addEventListener('click', onCancel);
    modal.addEventListener('close', onCancel);
  });
}
// 일정·예약만: 받은 여행(t)에 내 기록을 옮겨 담는다 — 지출·예산, 한 줄 평(내 것이 있으면), 일정·체크리스트 완료 표시
function keepMyRecords(old, t) {
  const doneItem = new Map(old.days.flatMap((d) => d.items).map((x) => [x.id, x.done]));
  const doneCheck = new Map(old.checklist.map((c) => [c.id, c.done]));
  for (const d of t.days) {
    const od = old.days.find((x) => x.date === d.date);
    if (od && od.note) d.note = od.note;
    for (const it of d.items) if (doneItem.has(it.id)) it.done = doneItem.get(it.id);
  }
  for (const c of t.checklist) if (doneCheck.has(c.id)) c.done = doneCheck.get(c.id);
  t.expenses = old.expenses;
  t.budget = old.budget;
}
async function importTrip(data) {
  const t = migrate({ trips: [data.trip] }).trips[0];
  const old = getTrip(t.id);
  const when = data.sentAt ? ` (${fmtDate(ymd(new Date(data.sentAt)))} 보냄)` : '';
  let mode = 'add';
  if (old) {
    mode = await askImportMode(old, when);
    if (!mode) return;
  } else if (!confirm(`“${t.title}” 여행을 추가할까요?${when}`)) return;
  if (old) {
    if (mode === 'plan') keepMyRecords(old, t);
    // 새 파일에 없는 옛 바우처만, 다 지운 뒤에 새 것을 넣는다 (동시에 하면 새로 넣은 게 지워질 수 있음)
    const keep = new Set(Object.keys(data.vouchers || {}));
    await deleteVouchers(old.bookings.flatMap((b) => b.vouchers || []).filter((v) => !keep.has(v.id)));
    // 기록 사진은 이 폰 것을 같은 날짜에 그대로 둔다 (없어진 날의 사진만 지움)
    for (const od of old.days) {
      const nd = t.days.find((x) => x.date === od.date);
      if (nd && od.photos) nd.photos = od.photos;
      else if (od.photos) deletePhotos(od.photos);
    }
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
  toast(mode === 'plan' ? '일정·예약을 업데이트했어요 (내 기록은 그대로)' : old ? '받은 내용으로 바꿨어요' : '여행을 추가했어요');
}

// 파일 고르기 칸은 화면(#view) 밖에 하나만 둔다: 고르는 동안 앱이 뒤로 갔다 오면 visibilitychange로 화면을
// 다시 그리는데, 칸이 #view 안에 있으면 그때 사라져서 '골랐다' 신호를 못 받았다 (폰에서 받은 여행이 안 열리던 문제).
const importPicker = Object.assign(document.createElement('input'), {
  type: 'file', hidden: true, accept: 'application/pdf,.pdf,text/plain,.txt,application/json,.json',
});
document.body.append(importPicker);
importPicker.addEventListener('change', (ev) => importData(ev));

function importData(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = await readTripFileText(reader.result);
      if (data.type === TRIP_FILE && data.trip) {
        await importTrip(data).catch((e) => { console.warn(e); toast(`여행을 열지 못했어요 (${e.message})`); });
        return;
      }
      const valid = Array.isArray(data.trips) || (data.trip && Array.isArray(data.days));
      if (!valid) throw new Error('형식 오류');
      if (!confirm('현재 데이터를 백업 파일 내용으로 바꿀까요?')) return;
      const covers = data.covers || {};
      const vouchers = data.vouchers || {};
      const photos = data.photos || {};
      delete data.covers;
      delete data.vouchers;
      delete data.photos;
      if (data.vault) data.vault.lock = ''; // 패스키는 원래 폰에만 있어서 다른 폰에선 못 연다 → 잠금은 끈 채로
      state = migrate(data); pickTrip(null); save(); render(); toast('가져오기 완료');
      clearCovers()
        .then(() => Promise.all(Object.entries(covers).map(([id, url]) => fetch(url).then((r) => r.blob()).then((b) => setCover(id, b)))))
        .then(render);
      voucherDb.clear()
        .then(() => Promise.all(Object.entries(vouchers).map(([id, url]) => fetch(url).then((r) => r.blob()).then((b) => voucherDb.set(id, b)))))
        .catch((e) => console.warn('바우처 복원 실패', e));
      Object.keys(photoUrls).forEach((k) => { URL.revokeObjectURL(photoUrls[k]); delete photoUrls[k]; });
      photoDb.clear()
        .then(() => Promise.all(Object.entries(photos).map(([id, url]) => fetch(url).then((r) => r.blob()).then((b) => photoDb.set(id, b)))))
        .then(loadPhotos).then(render)
        .catch((e) => console.warn('기록 사진 복원 실패', e));
    } catch (e) {
      console.warn('가져오기 실패', e);
      toast(`MasterTrip 백업·여행 파일이 아니에요 (${file.name})`);
    }
  };
  reader.readAsText(file);
  ev.target.value = ''; // 같은 파일을 다시 골라도 열리게
}

/* ============ 이벤트 위임 ============ */
$('#searchBtn').addEventListener('click', () => tripPicker({ search: true }));

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
    case 'edit-trip': tripForm(ft); break;
    case 'goto-sub': pickTrip(id); mainTab = 'trips'; remember('main', mainTab); setSub(el.dataset.v); window.scrollTo(0, 0); break;
    case 'export': withVault(exportData); break; // 백업에 비상 서류가 들어가니 잠금이 켜져 있으면 확인 후
    case 'import-file': importPicker.click(); break;
    case 'vault-view': withVault(() => openVoucher({ title: '🛂 비상 서류', vouchers: vault().docs })); break;
    case 'vault-edit': withVault(vaultForm); break;
    case 'day-note': noteForm(ft, el.dataset.date); break;
    case 'story': openStory(ft); break;
    case 'photo-add': photoTarget = { tripId: ft.id, date: el.dataset.date }; photoPicker.click(); break;
    case 'photo-view': openDayPhotos(ft, el.dataset.date); break;
    case 'theme': setTheme(el.dataset.v); break;
    case 'reset': resetAll(); break;
    case 'open-trip': openTrip(id); break;
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
    case 'rate-refresh':
      if (!navigator.onLine) { toast('인터넷 연결이 필요해요'); break; }
      toast('환율을 불러오는 중…');
      refreshRates(true).then(() => toast(`환율: ${money(1, ft.currency)} = ${ft.budget.rate.toLocaleString('ko-KR')}원`));
      break;
    case 'calc-add': {
      if (!(Number(calcValue) > 0)) { toast('금액을 먼저 입력하세요'); break; }
      expForm(ft, null);
      $('#modalForm').amount.value = calcValue; // 통화는 기본이 여행 통화
      calcValue = '';
      break;
    }
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

let calcValue = ''; // 계산기 입력 (화면을 다시 그려도 유지)
$('#view').addEventListener('input', (ev) => {
  if (ev.target.id === 'calcIn') {
    calcValue = ev.target.value;
    $('#calcOut').textContent = won((Number(calcValue) || 0) * focusTrip().budget.rate);
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
  if (!off) return;
  // 여러 개를 연달아 옮길 때 번거롭지 않게: 시간은 그대로 두고(겹치면 경고 표시), 원하면 알림의 버튼으로 맞춘다
  const sug = suggestTime(it, prev, next);
  if (sug) toast(`⏱ ${sug.time}로 맞출까요?`, { label: '맞추기', run: () => { it.time = sug.time; save(); render(); } });
  else toast('시간 순서가 앞뒤 일정과 달라요');
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
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { vaultOpen = false; return; } // 비상 서류는 앱이 뒤로 가면 다시 잠금
  render();
  refreshRates();
});

render();
refreshRates();
Promise.all([loadCovers(), loadPhotos()]).then(render);

/* ============ 오프라인 (Service Worker) ============ */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW 등록 실패', e));
}
