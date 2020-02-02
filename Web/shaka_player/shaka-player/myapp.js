

// document.write( '<script src="https://www.gstatic.com/firebasejs/7.6.1/firebase-app.js"></script>')


// document.write('<script src="https://www.gstatic.com/firebasejs/7.6.1/firebase-analytics.js"></script>')

            // <script src="https://www.gstatic.com/firebasejs/6.2.3/firebase-app.js"></script>
            // <script src="https://www.gstatic.com/firebasejs/6.2.3/firebase-storage.js"></script>
            // <script src="https://www.gstatic.com/firebasejs/7.6.1/firebase-analytics.js"></script>
            // <script src="https://www.gstatic.com/firebasejs/7.6.1/firebase-app.js"></script>
          //   import 'https://www.gstatic.com/firebasejs/6.2.3/firebase-app.js'
          //   var firebaseConfig = {
          //     apiKey: "AIzaSyAvSShkJqz3WwRxZotk3CYMeFmgoh0kqPg",
          //     authDomain: "madea-dd305.firebaseapp.com",
          //     databaseURL: "https://madea-dd305.firebaseio.com",
          //     projectId: "madea-dd305",
          //     storageBucket: "madea-dd305.appspot.com",
          //     messagingSenderId: "9428354749",
          //     appId: "1:9428354749:web:30b7915b739cc1087f19d4",
          //     measurementId: "G-B1Z5E9YC97"
          // };
          //  // Initialize Firebase
          //  firebase.initializeApp(firebaseConfig);
          //  // firebase.analytics();
          // //  var filebutton = document.getElementById('download');
          // //  console.log(filebutton);
           
           

          //      const videos = firebase.storage().ref('videos/');
          //      const video = videos.child('Maroon-Sugar.mp4');
          //      video.getDownloadURL().then(function(url) {
          //       // `url` is the download URL for 'images/stars.jpg'
              
          //       // This can be downloaded directly:
          //                         var xhr = new XMLHttpRequest();
          //                         xhr.responseType = 'blob';
          //                         xhr.onload = function(event) {
          //                             var blob = xhr.response;
          //                         };
          //                         xhr.open('GET', url);
          //                         xhr.send();
          //                         console.log(url);
                                  
          //  });
                    
          // console.log(url)
var manifestUri = 'http://127.0.0.1:5000/getvideo/Taylor-Swift-Bad Blood.mp4'
// 'https://firebasestorage.googleapis.com/v0/b/madea-dd305.appspot.com/o/videos%2FMaroon-Sugar.mp4?alt=media&token=6a8466b2-f66f-4497-82c9-38140e85dc9e'
//'http://127.0.0.1:5000/getvideo/output1.mpd',
//'../../video/output.mpd' ,
// 'http://127.0.0.1:5000/getvideo/output.mpd']
	//'../../video/Mark-Ronson-Uptown.mp4'
   //'https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd';

function initApp() {
  // Install built-in polyfills to patch browser incompatibilities.
  shaka.polyfill.installAll();

  // Check to see if the browser supports the basic APIs Shaka needs.
  if (shaka.Player.isBrowserSupported()) {
    // Everything looks good!
    initPlayer();
  } else {
    // This browser does not have the minimum set of APIs we need.
    console.error('Browser not supported!');
  }
}

function initPlayer() {
  // Create a Player instance.
  var video = document.getElementById('video');
  var player = new shaka.Player(video);

  // Attach player to the window to make it easy to access in the JS console.
  window.player = player;

  // Listen for error events.
  player.addEventListener('error', onErrorEvent);

  // Try to load a manifest.
  // This is an asynchronous process.
  player.load(manifestUri).then(function() {
    // This runs if the asynchronous load is successful.
    console.log('The video has now been loaded!');
  }).catch(onError);  // onError is executed if the asynchronous load fails.
}

function onErrorEvent(event) {
  // Extract the shaka.util.Error object from the event.
  onError(event.detail);
}

function onError(error) {
  // Log the error.
  console.error('Error code', error.code, 'object', error);
}

document.addEventListener('DOMContentLoaded', initApp);