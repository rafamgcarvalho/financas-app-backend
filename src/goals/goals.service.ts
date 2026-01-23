import { Injectable } from '@nestjs/common';
import { createGoalsDto } from './dto/create-goals';
import { db } from '../db/drizzle';
import { eq, desc } from 'drizzle-orm';
import { goals } from 'src/db/schema';
import { randomUUID } from 'crypto';

@Injectable()
export class GoalsService {
  /* Cria uma meta */
  async create(dto: createGoalsDto, userId: string) {
    const [newGoal] = await db
      .insert(goals)
      .values({
        id: randomUUID(),
        userId,
        title: dto.title,
        description: dto.description,
        targetValue: dto.targetValue.toString(),
        currentValue: '0',
        startDate: new Date(dto.startDate),
        targetDate: dto.targetDate ? new Date(dto.targetDate) : null,
        type: dto.type,
        status: dto.status,
        priority: dto.priority,
      })
      .returning();

    return newGoal;
  }

  async getAll(userId: string) {
    return await db
      .select()
      .from(goals)
      .where(eq(goals.userId, userId))
      .orderBy(desc(goals.createdAt));
  }
}
