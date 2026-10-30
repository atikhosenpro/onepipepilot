import http from 'node:http';
import { buildApp } from './app';
import { loadConfig, loadDotEnv } from './config';

async function main() {
  loadDotEnv(process.cwd());
  const config = loadConfig();
  const built = buildApp();
  const server = http.createServer(built.app);
  server.requestTimeout = 0;           // large uploads may take long on slow links
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  if (built.attachDev) await built.attachDev(server);

  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') console.error(`\nPort ${config.port} is already in use. Stop the other program or set another port (e.g. PORT=3100 in .env).\n`);
    else console.error(e);
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    const shown = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host === '127.0.0.1' ? 'localhost' : config.host;
    console.log(`\n  OnePipePilot v${config.version} (${config.devMode ? 'development' : 'production'})\n  Open in your browser:  http://${shown}:${config.port}\n  Storage:               ${config.storageRoot}\n  Database:              ${config.dbPath}\n`);
  });

  const shutdown = () => { console.log('Shutting down...'); server.close(() => { built.close(); process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
