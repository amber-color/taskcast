const CACHE = 'task-tracker-v14';

// すべて同一オリジン（CDN依存を排除）。1ファイル失敗してもSW更新をブロックしない。
const PRECACHE = [
  './',
  './index.html',
  './login.html',
  './dashboard.html',
  './setting.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/fullcalendar.min.css',
  './vendor/fullcalendar.min.js',
  './vendor/sortable.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // 個別に取得・キャッシュ。1つ失敗しても他は継続し install を成功させる
    // （addAll は all-or-nothing で、1ファイル失敗すると SW 更新全体が永久に止まる）
    await Promise.all(PRECACHE.map(async url => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res.ok) await c.put(url, res.clone());
      } catch (_) { /* 個別失敗は無視 */ }
    }));
  })());
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;

  // PHP (API・認証) は常にネットワーク
  if (req.url.includes('.php')) {
    e.respondWith(fetch(req));
    return;
  }

  // HTML ナビゲーションはネットワーク優先（更新を即反映、オフライン時のみキャッシュ）
  if (req.mode === 'navigate' || (req.method === 'GET' && req.headers.get('accept')?.includes('text/html'))) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(req, clone));
        }
        return res;
      } catch (_) {
        const cached = await caches.match(req);
        return cached || caches.match('./index.html');
      }
    })());
    return;
  }

  // その他静的アセット: キャッシュ優先、なければ取得してキャッシュ
  e.respondWith(
    caches.match(req).then(cached =>
      cached || fetch(req).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(req, clone));
        }
        return res;
      })
    )
  );
});
