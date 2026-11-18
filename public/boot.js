// Catch the browser's one-click install offer even if it comes before the app has loaded (install.js picks it up).
addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); window.__bip = e; });
