import { Router } from 'express';
import { calculateScorecard } from '../scorecard.js';

export const scorecardRouter = Router();

/**
 * GET /scorecard
 * Exposes live metrics, benchmark scorecard, confusion matrix, and tier handling rates (Section 21A).
 */
scorecardRouter.get('/', async (_req, res) => {
  try {
    const scorecard = await calculateScorecard();
    res.status(200).json(scorecard);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to calculate scorecard', details: err?.message });
  }
});
