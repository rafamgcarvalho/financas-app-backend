/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable } from '@nestjs/common';
import { db } from '../db/drizzle';
import { goals, transactions, goalMembers, users } from '../db/schema';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { and, eq, gte, lte, max, min, sql, or, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { GoalsGateway } from '../goals/goals.gateway';

@Injectable()
export class TransactionsService {
  constructor(private readonly goalsGateway: GoalsGateway) {}
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

      let finalTitle = dto.title;

      if (isRecurring) {
        finalTitle = `${dto.title} Recorrente`;
      } else if (totalRepetitions > 1) {
        finalTitle = `${dto.title} (${i + 1}/${totalRepetitions})`;
      }

      transactionsToInsert.push({
        id: randomUUID(),
        userId,
        title: finalTitle,
        amount: finalAmount.toFixed(2),
        type: dto.type,
        category: dto.category,
        date: currentDate,
        isRecurring: isRecurring,
        installments: totalRepetitions,
        groupId: groupId,
        goalId: dto.goalId,
      });
    }

    const result = await db
      .insert(transactions)
      .values(transactionsToInsert)
      .returning();

    // REGRA DE NEGÓCIO: Se for investimento vinculado a uma meta, atualiza a meta
    if (dto.type === 'INVESTMENT' && dto.goalId) {
      const selectedGoalId: string = dto.goalId;
      const totalAportado = Number(dto.amount) * (isRecurring ? 12 : 1);

      await db
        .update(goals)
        .set({
          currentValue: sql`${goals.currentValue} + ${totalAportado.toFixed(2)}`,
        })
        .where(eq(goals.id, selectedGoalId));

      const [updatedGoal] = await db
        .select()
        .from(goals)
        .where(eq(goals.id, selectedGoalId));

      if (updatedGoal) {
        const current = Number(updatedGoal.currentValue);
        const target = Number(updatedGoal.targetValue);

        if (current >= target && updatedGoal.status !== 'COMPLETED') {
          await db
            .update(goals)
            .set({ status: 'COMPLETED' })
            .where(eq(goals.id, selectedGoalId));
        }
      }

      // Busca o nome do usuário para notificar via WebSocket
      const [user] = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, userId));

      this.goalsGateway.notifyGoalUpdated({
        goalId: selectedGoalId,
        currentValue: updatedGoal?.currentValue || '0',
        userName: user?.name || 'Alguém',
        amount: Number(dto.amount),
        action: 'created',
      });
    }

    return result;
  }

  /* Encontrar transações */
  async findAllById(
    userId: string,
    month?: number,
    year?: number,
    goalId?: string,
  ) {
    // Se tiver goalId, busca transações de TODOS os membros da meta
    if (goalId) {
      return this.findByGoalId(goalId, userId);
    }

    const conditions = [eq(transactions.userId, userId)];

    if (month !== undefined && year !== undefined) {
      const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
      const endDate = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

      conditions.push(gte(transactions.date, startDate));
      conditions.push(lte(transactions.date, endDate));
    }

    return await db
      .select()
      .from(transactions)
      .where(and(...conditions))
      .orderBy(sql`${transactions.date} DESC`);
  }

  /**
   * Busca aportes de TODOS os membros de uma meta,
   * incluindo o nome do autor de cada transação.
   */
  async findByGoalId(goalId: string, requestingUserId: string) {
    // Verifica se o usuário é membro da meta
    const [membership] = await db
      .select()
      .from(goalMembers)
      .where(
        and(
          eq(goalMembers.goalId, goalId),
          eq(goalMembers.userId, requestingUserId),
        ),
      );

    if (!membership) {
      return [];
    }

    // Busca todas as transações dessa meta, com JOIN em users para pegar o nome
    const result = await db
      .select({
        id: transactions.id,
        userId: transactions.userId,
        title: transactions.title,
        amount: transactions.amount,
        description: transactions.description,
        date: transactions.date,
        category: transactions.category,
        type: transactions.type,
        isRecurring: transactions.isRecurring,
        installments: transactions.installments,
        groupId: transactions.groupId,
        createdAt: transactions.createdAt,
        goalId: transactions.goalId,
        userName: users.name,
      })
      .from(transactions)
      .innerJoin(users, eq(transactions.userId, users.id))
      .where(eq(transactions.goalId, goalId))
      .orderBy(sql`${transactions.date} DESC`);

    return result;
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

    const filteredUpdateData = Object.entries(updateData).reduce(
      (acc, [key, value]) => {
        if (value !== undefined) {
          acc[key] = value;
        }
        return acc;
      },
      {} as Record<string, any>,
    );

    const appliesToGroup = !!original.groupId;
    const groupCondition = appliesToGroup
      ? and(
          eq(transactions.groupId, original.groupId as string),
          eq(transactions.userId, userId),
        )
      : undefined;

    const totalRecords = appliesToGroup
      ? await db
          .select({ count: sql`COUNT(*)::int` })
          .from(transactions)
          .where(groupCondition)
          .then((result) => Number(result[0]?.count || 0))
      : 1;

    const originalAmount = Number(original.amount);
    const originalTotalAmount = original.isRecurring ? originalAmount * 12 : originalAmount * totalRecords;

    const dataWithoutDate = (({ date, ...rest }) => rest)(filteredUpdateData);

    const [updated] = appliesToGroup
      ? await db
          .update(transactions)
          .set(dataWithoutDate)
          .where(groupCondition)
          .returning()
      : await db
          .update(transactions)
          .set(filteredUpdateData)
          .where(and(eq(transactions.id, id), eq(transactions.userId, userId)))
          .returning();

    if (original.type === 'INVESTMENT' && original.goalId) {
      const updatedAmount = dto.amount !== undefined ? Number(dto.amount) : originalAmount;
      const updatedTotalAmount = original.isRecurring
        ? updatedAmount * 12
        : updatedAmount * totalRecords;
      const diff = updatedTotalAmount - originalTotalAmount;

      if (diff !== 0) {
        await db
          .update(goals)
          .set({
            currentValue: sql`${goals.currentValue} + ${diff.toFixed(2)}`,
          })
          .where(eq(goals.id, original.goalId));
      }

      const [goal] = await db
        .select()
        .from(goals)
        .where(eq(goals.id, original.goalId));

      if (goal) {
        const current = Number(goal.currentValue);
        const target = Number(goal.targetValue);

        if (current >= target && goal.status !== 'COMPLETED') {
          await db
            .update(goals)
            .set({ status: 'COMPLETED' })
            .where(eq(goals.id, original.goalId));
        } else if (current < target && goal.status === 'COMPLETED') {
          await db
            .update(goals)
            .set({ status: 'ACTIVE' })
            .where(eq(goals.id, original.goalId));
        }
      }

      // Notifica via WebSocket
      const [user] = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, userId));

      this.goalsGateway.notifyGoalUpdated({
        goalId: original.goalId,
        currentValue: goal?.currentValue || '0',
        userName: user?.name || 'Alguém',
        amount: updatedAmount,
        action: 'updated',
      });
    }

    return updated;
  }

  /* Excluir */
  async remove(id: string, userId: string, deleteAll?: boolean) {
    // 1. Buscamos a transação antes de deletar
    const [transaction] = await db
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.userId, userId)));

    if (!transaction) return null;

    // Tipando explicitamente o que esperamos do Drizzle
    let deletedResult: (typeof transactions.$inferSelect)[];

    if ((transaction.isRecurring || deleteAll) && transaction.groupId) {
      deletedResult = await db
        .delete(transactions)
        .where(
          and(
            eq(transactions.groupId, transaction.groupId),
            eq(transactions.userId, userId),
          ),
        )
        .returning();
    } else {
      const result = await db
        .delete(transactions)
        .where(and(eq(transactions.id, id), eq(transactions.userId, userId)))
        .returning();
      deletedResult = result;
    }

    // 2. REGRA DE ESTORNO
    if (transaction.type === 'INVESTMENT' && transaction.goalId) {
      const amountToSubtract = Number(transaction.amount);

      // Agora o TS sabe que deletedResult é um array, acabando com o erro de unsafe member access
      const totalEffect =
        (transaction.isRecurring || deleteAll) && transaction.groupId
          ? amountToSubtract * deletedResult.length
          : amountToSubtract;

      await db
        .update(goals)
        .set({
          currentValue: sql`${goals.currentValue} - ${totalEffect.toFixed(2)}`,
          status: 'ACTIVE',
        })
        .where(eq(goals.id, transaction.goalId));

      // Busca meta atualizada e notifica via WebSocket
      const [updatedGoal] = await db
        .select()
        .from(goals)
        .where(eq(goals.id, transaction.goalId));

      const [user] = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, userId));

      this.goalsGateway.notifyGoalUpdated({
        goalId: transaction.goalId,
        currentValue: updatedGoal?.currentValue || '0',
        userName: user?.name || 'Alguém',
        amount: totalEffect,
        action: 'deleted',
      });
    }

    return deletedResult;
  }

  /* Balanço */
  async getBalance(userId: string, month?: number, year?: number) {
    const allTransactions = await this.findAllById(userId, month, year);

    const totals = allTransactions.reduce(
      (acc, transaction) => {
        const amount = Number(transaction.amount);
        if (transaction.type === 'INCOME') acc.income += amount;

        if (
          transaction.type === 'EXPENSE' ||
          transaction.type === 'INVESTMENT'
        ) {
          acc.expense += amount;
        }
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

  async getStats(userId: string) {
    const allTransactions = await db
      .select()
      .from(transactions)
      .where(eq(transactions.userId, userId));

    if (allTransactions.length === 0) return [];

    const statsMap: Record<
      string,
      { label: string; income: number; expense: number; dateRef: Date }
    > = {};

    allTransactions.forEach((t) => {
      const date = typeof t.date === 'string' ? new Date(t.date) : t.date;

      if (!date || isNaN(date.getTime())) return;

      const month = date.getUTCMonth();
      const year = date.getUTCFullYear();
      const key = `${year}-${month}`;

      const label = date.toLocaleDateString('pt-BR', {
        month: 'short',
        year: '2-digit',
      });

      if (!statsMap[key]) {
        statsMap[key] = {
          label: label.replace('.', ''),
          income: 0,
          expense: 0,
          dateRef: new Date(year, month, 1),
        };
      }

      const amount = Number(t.amount);
      if (t.type === 'INCOME') {
        statsMap[key].income += amount;
      } else if (t.type === 'EXPENSE') {
        statsMap[key].expense += amount;
      }
    });

    return Object.values(statsMap)
      .sort((a, b) => a.dateRef.getTime() - b.dateRef.getTime())
      .map(({ label, income, expense }) => ({
        label,
        income: Number(income.toFixed(2)),
        expense: Number(expense.toFixed(2)),
      }));
  }

  async getMonthlyComparison(userId: string, month: number, year: number) {
    const transactions = await this.findAllById(userId, month, year);

    const stats = {
      income: 0,
      expense: 0,
      investment: 0,
    };

    transactions.forEach((t) => {
      const amount = Number(t.amount);
      if (t.type === 'INCOME') stats.income += amount;
      else if (t.type === 'EXPENSE') stats.expense += amount;
      // Se no futuro você tiver o type 'INVESTMENT', colocar o else if aqui
    });

    return [
      { name: 'Receitas', valor: stats.income, fill: '#42B7B2' },
      { name: 'Despesas', valor: stats.expense, fill: '#EF4444' },
      { name: 'Investimento', valor: stats.investment, fill: '#3B82F6' },
    ];
  }

  async getCategoryStats(userId: string, month: number, year: number) {
    const transactions = await this.findAllById(userId, month, year);

    const categoryMap: Record<string, number> = {};

    transactions.forEach((t) => {
      if (t.type === 'EXPENSE') {
        const rawCategory = t.category || 'Outros';

        const formattedCategory =
          rawCategory.charAt(0).toUpperCase() +
          rawCategory.slice(1).toLowerCase();

        categoryMap[formattedCategory] =
          (categoryMap[formattedCategory] || 0) + Number(t.amount);
      }
    });

    const colors = [
      '#6366F1', // Indigo
      '#A855F7', // Purple
      '#F97316', // Orange
      '#F59E0B', // Amber
      '#EAB308', // Yellow
      '#EF4444', // Red
      '#64748B', // Slate
    ];

    return Object.entries(categoryMap).map(([name, value], index) => ({
      name,
      value,
      fill: colors[index % colors.length],
    }));
  }
}
