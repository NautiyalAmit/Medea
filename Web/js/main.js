// Register the service worker 
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('js/service-worker.js')
    .then(reg => console.log('service worker: registered'))
    .catch(err => console.log('service worker: not registered', err));
}