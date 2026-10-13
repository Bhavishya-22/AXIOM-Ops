import express from 'express';
import cors from 'cors';
import { ingestRouter } from './routes/ingest.js';
import { logsRouter } from './routes/logs.js';

export function createServer() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  // Basic health check
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'rca-backend' });
  });

  // Task 2 routes
  app.use('/ingest', ingestRouter);
  app.use('/logs', logsRouter);

  return app;
}
