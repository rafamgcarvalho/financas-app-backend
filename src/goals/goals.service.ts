import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateGoalsDto } from './dto/create-goals';
import { db } from '../db/drizzle';
import { and, eq, desc } from 'drizzle-orm';
import { goals } from 'src/db/schema';
import { randomUUID } from 'crypto';

@Injectable()
export class GoalsService {
  /* Cria uma meta */
  async create(dto: CreateGoalsDto, userId: string) {
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

  async getOne(id: string, userId: string) {
    const [goal] = await db
      .select()
      .from(goals)
      .where(and(eq(goals.id, id), eq(goals.userId, userId)));

    if (!goal) {
      throw new NotFoundException('Meta não encontrada');
    }

    return goal;
  }

  async update(id: string, userId: string, dto: Partial<CreateGoalsDto>) {
    const { targetValue, startDate, targetDate, ...rest } = dto;

    const updateData = {
      ...rest,
      ...(targetValue !== undefined && { targetValue: targetValue.toString() }),

      ...(startDate && { startDate: new Date(startDate) }),
      ...(targetDate && { targetDate: new Date(targetDate) }),

      updatedAt: new Date(),
    };

    const [updated] = await db
      .update(goals)
      .set(updateData)
      .where(and(eq(goals.id, id), eq(goals.userId, userId)))
      .returning();

    if (!updated) {
      throw new NotFoundException('Meta não encontrada');
    }

    return updated;
  }

  async remove(id: string, userId: string) {
    const [goal] = await db
      .select()
      .from(goals)
      .where(and(eq(goals.id, id), eq(goals.userId, userId)));

    if (!goal) return null;

    const [deleted] = await db
      .delete(goals)
      .where(and(eq(goals.id, id), eq(goals.userId, userId)))
      .returning();

    return deleted;
  }
}
