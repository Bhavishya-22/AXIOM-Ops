import express from 'express';
import cors from 'cors';
import { ingestRouter } from './routes/ingest.js';
import { logsRouter } from './routes/logs.js';
import { incidentsRouter } from './routes/incidents.js';
import { ticketsRouter } from './routes/tickets.js';
import { investigationsRouter } from './routes/investigations.js';
import { scenariosRouter } from './routes/scenarios.js';

export function createServer() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  // Basic health check
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'rca-backend' });
  });

  // Core API routes
  app.use('/ingest', ingestRouter);
  app.use('/logs', logsRouter);
  app.use('/scenarios', scenariosRouter);
  app.use('/incidents', incidentsRouter);
  app.use('/tickets', ticketsRouter);
  app.use('/investigations', investigationsRouter);

  return app;
}
