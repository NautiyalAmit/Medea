const staticCacheName = 'v1';
//Precache offline page
const assets = [
  '/',
  '/Web/index.html',
  '/Web/404.html',
  '/Web/blog.html',
  '/Web/browse.html',
  '/Web/single.html',
  '/Web/css/audio.css',
  '/Web/css/bootstrap.css',
  '/Web/css/easy-responsive-tabs.css',
  '/Web/css/font-awesome.css',
  '/Web/css/icon-font.css',
  '/Web/css/jplayer.blue.monday.min.css',
  '/Web/css/popuo-box.css',
  '/Web/css/style.css',
  '/Web/js/main.js',
  'https://fonts.googleapis.com/css?family=Lato:300,400,700',
];

// Call Install Event
self.addEventListener('install', e => {
    console.log('Service Worker: Installed');
  
    e.waitUntil(
      caches
        .open(staticCacheName)
        .then(cache => {
          console.log('Service Worker:Pre Caching Files');
          return cache.addAll(assets);
        })
        .then(() => self.skipWaiting())
    );
  });
  
  // Call Activate Event to Clean-up old offline pages
  self.addEventListener('activate', e => {
    console.log('Service Worker: Activated');
    // Remove unwanted caches
    e.waitUntil(
      caches.keys().then(staticCacheNames => {
        return Promise.all(
            staticCacheNames.map(cache => {
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
     e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
   });

  