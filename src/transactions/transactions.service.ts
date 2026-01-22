/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable } from '@nestjs/common';
import { db } from '../db/drizzle';
import { transactions } from '../db/schema';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { and, eq, gte, lte, max, min, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';

@Injectable()
export class TransactionsService {
  async create(dto: CreateTransactionDto, userId: string) {
    const transactionsToInsert: (typeof transactions.$inferInsert)[] = [];

    const baseDate = new Date(dto.date);
    const isRecurring = dto.isRecurring === true;
    const installments =
      dto.installments && dto.installments > 0 ? dto.installments : 1;

    const totalRepetitions = isRecurring ? 12 : installments;
    const groupId = totalRepetitions > 1 ? randomUUID() : null;

    for (let i = 0; i < totalRepetitions; i++) {
      const currentDate = new Date(baseDate);

      currentDate.setUTCMonth(currentDate.getUTCMonth() + i);

      const finalAmount = isRecurring
        ? Number(dto.amount)
        : Number(dto.amount) / totalRepetitions;

      transactionsToInsert.push({
        id: randomUUID(),
        userId,
        title:
          !isRecurring && totalRepetitions > 1
            ? `${dto.title} (${i + 1}/${totalRepetitions})`
            : `${dto.title} Recorrente`,
        amount: finalAmount.toFixed(2),
        type: dto.type,
        category: dto.category,
        date: currentDate,
        isRecurring: isRecurring,
        installments: totalRepetitions,
        groupId: groupId,
      });
    }

    const insertedTransactions = await db
      .insert(transactions)
      .values(transactionsToInsert)
      .returning();

    return insertedTransactions[0];
  }

  /* Encontrar transações */
  async findAllById(userId: string, month?: number, year?: number) {
    const targetMonth = month || new Date().getMonth() + 1;
    const targetYear = year || new Date().getFullYear();

    const startDate = new Date(
      Date.UTC(targetYear, targetMonth - 1, 1, 0, 0, 0),
    );
    const endDate = new Date(
      Date.UTC(targetYear, targetMonth, 0, 23, 59, 59, 999),
    );

    return await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          gte(transactions.date, startDate),
          lte(transactions.date, endDate),
        ),
      )
      .orderBy(sql`${transactions.date} DESC`);
  }

  /* Editar transação */
  async update(id: string, userId: string, dto: Partial<CreateTransactionDto>) {
    const [original] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.userId, userId)));

    if (!original) return null;

    const updateData: any = {
      title: dto.title,
      amount: dto.amount?.toString(),
      description: dto.description,
      category: dto.category,
      date: dto.date ? new Date(dto.date) : undefined,
    };

    if (original.isRecurring && original.groupId) {
      const { date, ...dataWithoutDate } = updateData;

      return await db
        .update(transactions)
        .set(dataWithoutDate)
        .where(
          and(
            eq(transactions.groupId, original.groupId),
            eq(transactions.userId, userId),
          ),
        )
        .returning();
    }

    const [updated] = await db
      .update(transactions)
      .set(updateData)
      .where(and(eq(transactions.id, id), eq(transactions.userId, userId)))
      .returning();

    return updated;
  }

  /* Excluir */
  async remove(id: string, userId: string, deleteAll?: boolean) {
    const [transaction] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.userId, userId)));

    if (!transaction) return null;

    if ((transaction.isRecurring || deleteAll) && transaction.groupId) {
      return await db
        .delete(transactions)
        .where(
          and(
            eq(transactions.groupId, transaction.groupId),
            eq(transactions.userId, userId),
          ),
        )
        .returning();
    }

    const [deleted] = await db
      .delete(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.userId, userId)))
      .returning();

    return deleted;
  }

  /* Balanço */
  async getBalance(userId: string, month?: number, year?: number) {
    const allTransactions = await this.findAllById(userId, month, year);

    const totals = allTransactions.reduce(
      (acc, transaction) => {
        const amount = Number(transaction.amount);
        if (transaction.type === 'INCOME') acc.income += amount;
        if (transaction.type === 'EXPENSE') acc.expense += amount;
        return acc;
      },
      { income: 0, expense: 0 },
    );

    return {
      ...totals,
      total: totals.income - totals.expense,
    };
  }

  async getTransactionRange(userId: string, type?: string) {
    const whereConditions = [eq(transactions.userId, userId)];

    if (type && type !== 'all') {
      const validType = type.toUpperCase() as 'INCOME' | 'EXPENSE';
      whereConditions.push(eq(transactions.type, validType));
    }

    const [first] = await db
      .select({ date: transactions.date })
      .from(transactions)
      .where(and(...whereConditions))
      .orderBy(sql`${transactions.date} ASC`)
      .limit(1);

    const [last] = await db
      .select({ date: transactions.date })
      .from(transactions)
      .where(and(...whereConditions))
      .orderBy(sql`${transactions.date} DESC`)
      .limit(1);

    const minDate = first?.date ? new Date(first.date) : new Date();
    const maxDate = last?.date ? new Date(last.date) : new Date();

    return {
      minDate: minDate.toISOString(),
      maxDate: maxDate.toISOString(),
    };
  }
}
