// FacturaPro Service Worker
// Version - changer ce numéro pour forcer mise à jour
const CACHE_VERSION = 'facturapro-v1';
const CACHE_NAME = `${CACHE_VERSION}-cache`;

// Fichiers à mettre en cache au moment de l'installation
const URLS_TO_CACHE = [
    './',
    './index.html',
    './app.html',
    './manifest.json'
];

// CDNs externes à cacher
const EXTERNAL_CACHE = [
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.31/jspdf.plugin.autotable.min.js',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

// === INSTALL: Cache les fichiers essentiels ===
self.addEventListener('install', (event) => {
    console.log('[SW] Install version', CACHE_VERSION);
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[SW] Caching app shell');
            return cache.addAll(URLS_TO_CACHE).catch(err => {
                console.warn('[SW] Some files failed to cache:', err);
            });
        }).then(() => self.skipWaiting())
    );
});

// === ACTIVATE: Nettoie les vieux caches ===
self.addEventListener('activate', (event) => {
    console.log('[SW] Activate version', CACHE_VERSION);
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter(name => name.startsWith('facturapro-') && name !== CACHE_NAME)
                    .map(name => {
                        console.log('[SW] Deleting old cache:', name);
                        return caches.delete(name);
                    })
            );
        }).then(() => self.clients.claim())
    );
});

// === FETCH: Stratégie cache-first pour assets, network-first pour API ===
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    // Ignorer les requêtes non-GET
    if (event.request.method !== 'GET') return;
    
    // Ignorer les requêtes Chrome extension
    if (url.protocol === 'chrome-extension:') return;
    
    // === API Supabase : Network-first (data fresh prioritaire) ===
    if (url.hostname.includes('supabase.co')) {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    // Cloner la réponse pour pouvoir la cacher
                    const responseClone = response.clone();
                    if (response.status === 200) {
                        caches.open(CACHE_NAME).then(cache => {
                            cache.put(event.request, responseClone).catch(() => {});
                        });
                    }
                    return response;
                })
                .catch(() => {
                    // Si offline, essayer le cache
                    return caches.match(event.request).then(cachedResponse => {
                        if (cachedResponse) return cachedResponse;
                        // Sinon retourner une erreur réseau
                        return new Response(JSON.stringify({ error: 'offline' }), {
                            status: 503,
                            headers: { 'Content-Type': 'application/json' }
                        });
                    });
                })
        );
        return;
    }
    
    // === Assets statiques : Cache-first ===
    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) {
                // Servir depuis le cache, mais update en arrière-plan
                fetch(event.request).then(response => {
                    if (response.status === 200) {
                        caches.open(CACHE_NAME).then(cache => {
                            cache.put(event.request, response).catch(() => {});
                        });
                    }
                }).catch(() => {}); // Silently fail si offline
                return cachedResponse;
            }
            
            // Pas en cache, fetch et cache
            return fetch(event.request).then(response => {
                // Ne cache que les responses OK
                if (!response || response.status !== 200 || response.type === 'opaque') {
                    return response;
                }
                
                // Clone car la response est un stream à usage unique
                const responseClone = response.clone();
                caches.open(CACHE_NAME).then(cache => {
                    cache.put(event.request, responseClone).catch(() => {});
                });
                
                return response;
            }).catch(() => {
                // Si fetch échoue ET pas en cache, retourner page offline
                if (event.request.destination === 'document') {
                    return caches.match('./app.html');
                }
                return new Response('Offline', { status: 503 });
            });
        })
    );
});

// === MESSAGE: Communication avec l'app ===
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    
    if (event.data && event.data.type === 'CLEAR_CACHE') {
        caches.delete(CACHE_NAME).then(() => {
            event.ports[0]?.postMessage({ status: 'cleared' });
        });
    }
});

console.log('[SW] FacturaPro Service Worker loaded - version', CACHE_VERSION);
