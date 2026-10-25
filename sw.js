// 앱 파일을 폰에 저장해 두고 인터넷 없이도 열리게 한다.
// 앱 파일을 수정해서 다시 배포할 때는 CACHE 이름의 숫자를 올린다.
const CACHE = 'mastertrip-v37';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'data.js',
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
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 네트워크 우선, 실패하면 캐시 (온라인이면 항상 최신, 오프라인이면 저장본)
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
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
