/* 서비스 워커.
 * - 화면(index.html) 요청: 네트워크 우선(no-cache), 실패하면 캐시. 새 팩 버전이 담긴 새 빌드가 바로 전달된다.
 * - 해시가 붙은 자원·그 밖의 같은 출처 GET: stale-while-revalidate.
 * 캐시 이름을 바꾸면(릴리스마다 올린다) activate 에서 이전 캐시를 모두 지운다. */
const CACHE = 'tripsim-v9';
/** 화면 요청이 이 시간 안에 응답하지 않으면 캐시로 물러선다 (연결이 매달린 경우) */
const NAV_TIMEOUT_MS = 4000;
const SCOPE = self.registration.scope;
const scoped = u => new URL(u, SCOPE).href;

/** 200 응답만 담는다. 쓰기 실패(쿼터 등)는 앱 동작을 막지 않는다 */
async function safePut(cache, req, res) {
  if (res.status !== 200 || res.type !== 'basic') return;
  try { await cache.put(req, res); } catch { /* 캐시 실패는 무시 */ }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 앱 셸: 첫 방문 때 로드된 자원은 SW 를 거치지 않았으므로 index.html 에서 경로를 찾아 미리 담는다
    const res = await fetch(scoped('./'), { cache: 'reload' });
    if (res.status !== 200) throw new Error('앱 셸을 받지 못했다');
    const html = await res.clone().text();
    const entry = /<script[^>]*\ssrc="(\.\/[^"]+)"/.exec(html)?.[1];
    const css = /<link[^>]*rel="stylesheet"[^>]*\shref="(\.\/[^"]+)"/.exec(html)?.[1];
    // 화면·진입 스크립트·스타일 중 하나라도 못 담으면 설치를 실패시킨다 (반쪽 셸 방지)
    if (!entry || !css) throw new Error('앱 셸 자원을 찾지 못했다');
    for (const u of [entry, css]) {
      const r = await fetch(scoped(u), { cache: 'reload' });
      if (r.status !== 200) throw new Error(`필수 자원 실패: ${u}`);
      await cache.put(scoped(u), r);
    }
    await cache.put(scoped('./'), res);
    // 나머지(manifest·아이콘·modulepreload)는 실패해도 설치를 막지 않는다
    // 빌드 산출물 목록(precache.json)의 lazy chunk·팩도 같이 담는다
    // 목록을 못 받거나 JSON 이 아니면(호스트의 HTML 대체 응답 등) 없는 것으로 치고 설치는 계속한다
    let listed = [];
    try {
      const r = await fetch(scoped('./precache.json'), { cache: 'reload' });
      const parsed = r.status === 200 ? await r.json() : [];
      if (Array.isArray(parsed)) listed = parsed.filter(u => typeof u === 'string');
    } catch { /* 무시 */ }
    const fromHtml = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map(m => m[1]);
    const rest = [...new Set([...fromHtml, ...listed])].filter(u => u !== entry && u !== css);
    await Promise.allSettled(rest.map(async u => {
      const r = await fetch(scoped(u), { cache: 'reload' });
      await safePut(cache, scoped(u), r);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // 모듈 스크립트 요청은 Origin 헤더가 붙어 Vary: Origin 응답과 어긋나므로 ignoreVary 로 맞춘다
    if (req.mode === 'navigate') {
      const fromCache = async () => (await cache.match(req, { ignoreSearch: true, ignoreVary: true }))
        ?? (await cache.match(scoped('./'), { ignoreVary: true }));
      const net = fetch(req.url, { cache: 'no-cache' }).then(res => {
        // 늦게 도착한 응답도 캐시에 담는다. 이미 응답을 낸 뒤라 waitUntil 이 거절될 수 있어 직접 담는다
        if (res.status === 200 && res.type === 'basic') {
          const keep = safePut(cache, req, res.clone());
          try { event.waitUntil(keep); } catch { keep.catch(() => {}); }
        }
        return res;
      });
      // 시간 제한으로 캐시를 먼저 내더라도 네트워크 응답이 끝날 때까지 워커를 살려 둔다
      event.waitUntil(net.then(() => {}, () => {}));
      // 캐시된 화면이 있을 때만 시간 제한을 둔다. 없으면 네트워크를 끝까지 기다린다
      if (!(await fromCache())) return net;
      try {
        return await Promise.race([net, new Promise((_, rej) => setTimeout(rej, NAV_TIMEOUT_MS))]);
      } catch {
        net.catch(() => {});
        return (await fromCache()) ?? Response.error();
      }
    }
    const cached = await cache.match(req, { ignoreVary: true });
    const update = fetch(req).then(res => {
      if (res.status === 200 && res.type === 'basic') event.waitUntil(safePut(cache, req, res.clone()));
      return res;
    });
    if (cached) { event.waitUntil(update.catch(() => {})); return cached; }
    return update;
  })());
});
