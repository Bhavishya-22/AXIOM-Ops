import { Router } from 'express';
import { prisma } from '../prisma.js';

export const investigationsRouter = Router();

// GET /investigations/:id
investigationsRouter.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const investigation = await prisma.investigation.findUnique({
      where: { id },
      include: {
        ticket: {
          include: {
            incident: true,
          },
        },
        auditEvents: {
          orderBy: { ts: 'asc' },
        },
      },
    });

    if (!investigation) {
      return res.status(404).json({ error: 'Investigation not found' });
    }

    return res.status(200).json({ investigation });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});
