const staticCacheName = 'v2';
 
// Call Install Event
self.addEventListener('install', e => {
    console.log('Service Worker: Installed');
  });
  
  // Call Activate Event to Clean-up old offline pages

  self.addEventListener('activate', e => {
    console.log('Service Worker: Activated');
    // Remove unwanted caches
    e.waitUntil(
      caches.keys().then(cacheNames => {
        return Promise.all(
          cacheNames.map(cache => {
            if (cache !== staticCacheName) {
              console.log('Service Worker: Clearing Old Cache');
              return caches.delete(cache);
            }
          })
        );
      })
    );
  });
  
  //  Call Fetch Event:The fetch handler only needs to handle page navigations, 
  // so other requests can be dumped out of the handler and dealt with normally by the browser.
  self.addEventListener('fetch', e => {
    console.log('Service Worker: Fetching');
    e.respondWith(
      fetch(e.request)
        .then(res => {
          // Make copy/clone of response
          const resClone = res.clone();
          // Open cahce
          caches.open(staticCacheName).then(cache => {
            // Add response to cache
            cache.put(e.request, resClone);
          });
          return res;
        })
        .catch(err => caches.match(e.request).then(res => res))
    );
  });