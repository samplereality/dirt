// Runs in the page's isolated content-script world right after dirt-core.js.
// The module is idempotent, so a second click toggles the overlay off.
Dirt.toggle({ debug: true });
