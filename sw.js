// 앱 파일을 폰에 저장해 두고 인터넷 없이도 열리게 한다.
// 앱 파일을 수정해서 다시 배포할 때는 CACHE 이름의 숫자를 올린다.
const CACHE = 'mastertrip-v57';
// 한 번 본 지도 그림(OpenStreetMap 타일)은 따로 저장해 두고 인터넷이 없을 때 보여 준다.
// OSM 이용 규칙상 미리 대량으로 받아 두기는 금지 → 사용자가 실제로 본 것만, 최대 TILE_MAX장(한 장 7KB 안팎).
// 앱 버전(CACHE)이 바뀌어도 지우지 않는다.
const TILE_CACHE = 'mastertrip-tiles';
const TILE_MAX = 1500;
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'data.js',
  'phrases.js',
  'app.js',
  'manifest.webmanifest',
  'img/header.jpg',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== TILE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 지도 그림: 인터넷이 되면 평소처럼 받고(받은 것은 저장), 안 되면 저장해 둔 그림
let trimming = null;
function trimTiles() {
  // 너무 자주 돌지 않게 한 번에 하나만. 오래 전에 넣은 것부터 지운다 (keys()는 넣은 순서)
  trimming = trimming || caches.open(TILE_CACHE)
    .then((c) => c.keys().then((keys) => Promise.all(keys.slice(0, Math.max(0, keys.length - TILE_MAX)).map((k) => c.delete(k)))))
    .catch(() => {})
    .then(() => { trimming = null; });
  return trimming;
}
let putCount = 0;
function tileFetch(req) {
  return fetch(req)
    .then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(TILE_CACHE)
          .then((c) => c.put(req.url, copy))
          .then(() => { if (++putCount % 50 === 0) trimTiles(); })
          .catch(() => {});
      }
      return res;
    })
    .catch(() => caches.open(TILE_CACHE).then((c) => c.match(req.url)).then((r) => r || Response.error()));
}

// 네트워크 우선, 실패하면 캐시 (온라인이면 항상 최신, 오프라인이면 저장본)
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'GET' && url.hostname === 'tile.openstreetmap.org') return e.respondWith(tileFetch(e.request));
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    // no-cache: 브라우저 HTTP 캐시(GitHub Pages는 최대 10분)를 건너뛰고 서버에 새 버전이 있는지 매번 확인
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
