import { Router, Request, Response } from 'express';
import { prisma } from '../prisma.js';

export const logsRouter = Router();

logsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const { category, service, level, since, limit, order } = req.query;
    let sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;

    // Current session by default: find the latest active sessionId from logs if not provided
    if (!sessionId) {
      const latest = await prisma.log.findFirst({
        orderBy: { ts: 'desc' },
        select: { sessionId: true },
      });
      if (latest) {
        sessionId = latest.sessionId;
      }
    }

    const where: Record<string, unknown> = {};

    if (sessionId) {
      where.sessionId = sessionId;
    }
    if (typeof category === 'string' && category) {
      where.category = category;
    }
    if (typeof service === 'string' && service) {
      where.service = service;
    }
    if (typeof level === 'string' && level) {
      where.level = level;
    }
    if (typeof since === 'string' && since) {
      const sinceDate = new Date(since);
      if (!isNaN(sinceDate.getTime())) {
        where.ts = { gte: sinceDate };
      }
    }

    const take = Math.min(Math.max(parseInt(String(limit || '100'), 10) || 100, 1), 1000);
    const sortOrder = order === 'asc' ? 'asc' : 'desc';

    const logs = await prisma.log.findMany({
      where,
      orderBy: { ts: sortOrder },
      take,
    });

    return res.status(200).json({ logs });
  } catch (err) {
    console.error('Error fetching logs:', err);
    return res.status(500).json({ error: 'Failed to query logs' });
  }
});
