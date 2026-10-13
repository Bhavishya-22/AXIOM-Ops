import { Router } from 'express';

export const scenariosRouter = Router();

scenariosRouter.post('/:name/trigger', async (req, res) => {
  const { name } = req.params;
  const simulatorUrl = process.env.SIMULATOR_URL || 'http://localhost:4000';
  const controlToken = process.env.CONTROL_TOKEN || 'test-control-token';

  try {
    const response = await fetch(`${simulatorUrl}/control/trigger/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${controlToken}`,
      },
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    return res.status(200).json(data);
  } catch (err: any) {
    return res.status(502).json({
      error: 'Failed to contact simulator',
      details: err.message,
    });
  }
});
