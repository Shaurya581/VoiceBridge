import 'dotenv/config';
import { createApp } from './app.js';
import { createDatabase } from './db.js';
import { startDeadlineWorker } from './services/worker.js';

const database = createDatabase();
const app = createApp(database);
const port = Number(process.env.PORT ?? 4000);
const stopWorker = database ? startDeadlineWorker(database) : () => undefined;

const server = app.listen(port, () => {
  console.info(JSON.stringify({ event: 'server_started', port, databaseConfigured: database !== null }));
});

async function shutdown() {
  stopWorker();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database?.$disconnect();
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
