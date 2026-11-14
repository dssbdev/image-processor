/**
 * Bootstrap. Kept tiny and import-free so the very first line prints even if a dependency fails to load,
 * and a watchdog names the phase if startup hangs. The app itself lives in ./app.ts.
 */
console.log(`[server] node ${process.version} on ${process.platform}-${process.arch}, pid ${process.pid} — starting…`);

const watchdog = setTimeout(() => {
  console.error('[server] still not listening after 20 s — the last phase printed above is where it is stuck. Run "npm run doctor".');
}, 20_000);
watchdog.unref();

try {
  const { startServer } = await import('./app.js');
  await startServer();
  clearTimeout(watchdog);
} catch (err) {
  clearTimeout(watchdog);
  console.error('[server] failed to start:');
  console.error(err);
  process.exit(1);
}
