import { createHash } from 'crypto';
import { prisma } from '../prisma.js';
import { Role } from '@axiomops/shared';

export interface AuthenticatedDemoUser {
  id: string;
  name: string;
  role: Role;
}

export function hashDemoToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Ensures standard demo users are seeded in the database.
 */
export async function ensureDemoUsersSeeded(): Promise<void> {
  const users = [
    {
      id: 'operator-1',
      name: 'Operator One',
      role: 'operator' as Role,
      token: process.env.OPERATOR_1_TOKEN || 'operator-1-token',
    },
    {
      id: 'operator-2',
      name: 'Operator Two',
      role: 'operator' as Role,
      token: process.env.OPERATOR_2_TOKEN || 'operator-2-token',
    },
    {
      id: 'sme-1',
      name: 'Subject Matter Expert 1',
      role: 'sme' as Role,
      token: process.env.SME_1_TOKEN || 'sme-1-token',
    },
  ];

  for (const u of users) {
    const tokenHash = hashDemoToken(u.token);
    await prisma.demoUser.upsert({
      where: { id: u.id },
      update: { tokenHash, role: u.role, name: u.name },
      create: { id: u.id, name: u.name, role: u.role, tokenHash },
    });
  }
}

/**
 * Authenticates a demo token against seeded DemoUser rows.
 * Server strictly derives approverRole from stored DemoUser row.
 * Caller-supplied roles are completely ignored.
 */
export async function authenticateDemoToken(
  tokenOrHeader?: string | null
): Promise<AuthenticatedDemoUser | null> {
  if (!tokenOrHeader) return null;

  const rawToken = tokenOrHeader.startsWith('Bearer ')
    ? tokenOrHeader.slice(7).trim()
    : tokenOrHeader.trim();

  if (!rawToken) return null;

  const tokenHash = hashDemoToken(rawToken);
  let user = await prisma.demoUser.findFirst({
    where: { tokenHash },
  });

  // If not seeded yet, seed and retry once
  if (!user) {
    await ensureDemoUsersSeeded();
    user = await prisma.demoUser.findFirst({
      where: { tokenHash },
    });
  }

  if (!user) return null;

  return {
    id: user.id,
    name: user.name,
    role: user.role as Role,
  };
}
