// Runs before the page paints, so a saved theme never flashes the other one first.
try { if (localStorage.getItem('tbb-theme') === 'light') { document.documentElement.dataset.theme = 'light'; document.querySelector('meta[name=theme-color]')?.setAttribute('content', '#008080'); } } catch { /* private mode */ }
