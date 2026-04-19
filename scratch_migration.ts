import { db } from './src/db/drizzle';
import { goals, goalMembers } from './src/db/schema';
import { notInArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';

async function migrate() {
  console.log('Migrando metas existentes para a tabela goal_members...');
  const allGoals = await db.select().from(goals);
  
  if (allGoals.length === 0) {
    console.log('Nenhuma meta encontrada.');
    process.exit(0);
  }

  const existingMemberships = await db.select({ goalId: goalMembers.goalId }).from(goalMembers);
  const skipMap = new Set(existingMemberships.map(m => m.goalId));

  const toInsert = allGoals
    .filter(g => !skipMap.has(g.id))
    .map(g => ({
      id: randomUUID(),
      goalId: g.id,
      userId: g.userId,
      role: 'OWNER' as const,
      joinedAt: new Date(),
    }));

  if (toInsert.length > 0) {
    await db.insert(goalMembers).values(toInsert);
    console.log(`Migrou ${toInsert.length} metas.`);
  } else {
    console.log('Todas as metas já possuem membros registrados.');
  }
  
  process.exit(0);
}

migrate().catch(err => {
  console.error(err);
  process.exit(1);
});
