/* eslint-disable @typescript-eslint/no-unused-vars */

import { Injectable } from '@nestjs/common';
import { db } from '../db/drizzle';
import { goals, transactions, goalMembers, users } from '../db/schema';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { and, eq, gte, lte, max, min, sql, or, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { GoalsGateway } from '../goals/goals.gateway';

/**
 * Avança meses preservando o dia, sem estourar para o mês seguinte.
 *
 * `setUTCMonth` resolve 31 de fevereiro como 3 de março, o que fazia uma
 * recorrência lançada no dia 31 pular fevereiro inteiro e cair duas vezes em
 * março. Quando o dia não existe no mês de destino, usamos o último dia dele —
 * é o que bancos e cartões fazem com vencimento em dia 31.
 */
export function addMonthsClamped(base: Date, months: number): Date {
  const targetMonth = base.getUTCMonth() + months;

  // Dia 0 do mês seguinte = último dia do mês de destino.
  const lastDayOfTarget = new Date(
    Date.UTC(base.getUTCFullYear(), targetMonth + 1, 0),
  ).getUTCDate();

  return new Date(
    Date.UTC(
      base.getUTCFullYear(),
      targetMonth,
      Math.min(base.getUTCDate(), lastDayOfTarget),
      base.getUTCHours(),
      base.getUTCMinutes(),
      base.getUTCSeconds(),
      base.getUTCMilliseconds(),
    ),
  );
}

type TransactionType = 'INCOME' | 'EXPENSE' | 'INVESTMENT';

const TRANSACTION_TYPES: TransactionType[] = [
  'INCOME',
  'EXPENSE',
  'INVESTMENT',
];

/** Aceita "expense", "EXPENSE"... e ignora qualquer coisa fora do enum. */
function normalizeTransactionType(type?: string): TransactionType | undefined {
  if (!type || type === 'all') return undefined;

  const upper = type.toUpperCase() as TransactionType;
  return TRANSACTION_TYPES.includes(upper) ? upper : undefined;
}

/**
 * "2026-10-01" -> instante UTC daquele dia.
 *
 * `new Date("2026-10-01")` já resolve para meia-noite UTC, mas aceita também
 * "2026-10-01T15:00:00Z" e qualquer coisa que o cliente inventar. Montar a data
 * a partir dos três números garante que o recorte seja o dia inteiro, e nunca um
 * pedaço dele — é o mesmo tratamento que o filtro por mês já dava.
 *
 * @param edge `start` ancora em 00:00:00.000; `end`, em 23:59:59.999.
 */
export function parseDayBoundary(
  value: string | undefined,
  edge: 'start' | 'end',
): Date | undefined {
  if (!value) return undefined;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return undefined;

  const [, year, month, day] = match.map(Number);

  const date =
    edge === 'start'
      ? new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0))
      : new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));

  // Rejeita 2026-02-31 e afins: o Date rola para março, e um filtro que responde
  // sobre um dia que não existe é pior do que um filtro ignorado.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined;
  }

  return date;
}

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
      const currentDate = addMonthsClamped(baseDate, i);

      // Recorrente repete o mesmo valor todo mês; parcelado divide o total.
      const finalAmount = isRecurring
        ? Number(dto.amount)
        : Number(dto.amount) / totalRepetitions;

      transactionsToInsert.push({
        id: randomUUID(),
        userId,
        // O título fica limpo: a posição da parcela vive em installmentNumber,
        // e a recorrência já é indicada por isRecurring.
        title: dto.title,
        amount: finalAmount.toFixed(2),
        description: dto.description ?? null,
        type: dto.type,
        category: dto.category,
        date: currentDate,
        isRecurring: isRecurring,
        installments: totalRepetitions,
        // Só parcelamento numera: em recorrente "parcela 3 de 12" enganaria,
        // e é assim que o backfill da migração 0003 trata os dados antigos.
        installmentNumber: !isRecurring && totalRepetitions > 1 ? i + 1 : null,
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
  /**
   * @param from/@param to intervalo por dia ("AAAA-MM-DD"), inclusive nas duas
   *   pontas. Tem precedência sobre mês/ano: quando a tela filtra por intervalo,
   *   é uma requisição só, em vez de uma por mês atravessado.
   */
  async findAllById(
    userId: string,
    month?: number,
    year?: number,
    goalId?: string,
    type?: string,
    from?: string,
    to?: string,
  ) {
    // Se tiver goalId, busca transações de TODOS os membros da meta
    if (goalId) {
      return this.findByGoalId(goalId, userId);
    }

    const conditions = [eq(transactions.userId, userId)];

    // As telas de Receitas e Despesas pedem um tipo só; sem este filtro elas
    // baixavam o mês inteiro e descartavam o resto no navegador.
    const normalizedType = normalizeTransactionType(type);
    if (normalizedType) {
      conditions.push(eq(transactions.type, normalizedType));
    }

    const fromDate = parseDayBoundary(from, 'start');
    const toDate = parseDayBoundary(to, 'end');

    if (fromDate || toDate) {
      // Uma ponta só também vale: "de 01/10 em diante" é um filtro legítimo.
      if (fromDate) conditions.push(gte(transactions.date, fromDate));
      if (toDate) conditions.push(lte(transactions.date, toDate));
    } else if (month !== undefined && year !== undefined) {
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
        installmentNumber: transactions.installmentNumber,
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
  /**
   * Edita uma transação.
   *
   * `updateAll` decide o alcance quando o lançamento faz parte de um grupo
   * (parcelamento ou recorrência), espelhando o que remove() já fazia com
   * `deleteAll`. Antes a edição atingia o grupo inteiro sem perguntar, o que
   * surpreendia quem só queria corrigir uma parcela.
   *
   * A data nunca se propaga: ela é o que distingue uma parcela da outra.
   */
  async update(
    id: string,
    userId: string,
    dto: Partial<CreateTransactionDto>,
    updateAll = false,
  ) {
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

    const appliesToGroup = !!original.groupId && updateAll;
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
    // Quando a edição vale só para esta linha, o efeito na meta é o dela apenas.
    const affectedRecords = appliesToGroup ? totalRecords : 1;
    const originalTotalAmount = originalAmount * affectedRecords;

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
      const updatedAmount =
        dto.amount !== undefined ? Number(dto.amount) : originalAmount;
      const updatedTotalAmount = updatedAmount * affectedRecords;
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

  /**
   * Balanço do período.
   *
   * Investimento não é despesa: despesa destrói dinheiro, investimento apenas
   * muda de lugar. Somando os dois, quem investe o que sobra veria o saldo dar
   * zero todo mês — um número que é sempre zero não mede nada.
   *
   * `total` é receitas menos despesas; `unallocated` é o que sobrou e ainda não
   * foi guardado.
   */
  async getBalance(userId: string, month?: number, year?: number) {
    const allTransactions = await this.findAllById(userId, month, year);

    const totals = allTransactions.reduce(
      (acc, transaction) => {
        const amount = Number(transaction.amount);

        if (transaction.type === 'INCOME') acc.income += amount;
        else if (transaction.type === 'EXPENSE') acc.expense += amount;
        else if (transaction.type === 'INVESTMENT') acc.investment += amount;

        return acc;
      },
      { income: 0, expense: 0, investment: 0 },
    );

    const total = totals.income - totals.expense;

    return {
      ...totals,
      total,
      unallocated: total - totals.investment,
      savingsRate: totals.income > 0 ? totals.investment / totals.income : null,
    };
  }

  async getTransactionRange(userId: string, type?: string) {
    const whereConditions = [eq(transactions.userId, userId)];

    const normalizedType = normalizeTransactionType(type);
    if (normalizedType) {
      whereConditions.push(eq(transactions.type, normalizedType));
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
      .map(({ label, income, expense, dateRef }) => ({
        label,
        // O rótulo é para ler ("set 26"); mês e ano são para agir. Sem eles, um
        // clique no gráfico teria que adivinhar o período a partir do texto.
        month: dateRef.getMonth() + 1,
        year: dateRef.getFullYear(),
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
      else if (t.type === 'INVESTMENT') stats.investment += amount;
    });

    // As cores ficam por conta do frontend, que tem a paleta por tipo.
    return [
      { name: 'Receitas', valor: stats.income },
      { name: 'Despesas', valor: stats.expense },
      { name: 'Investimentos', valor: stats.investment },
    ];
  }

  /**
   * Total gasto por categoria no mês.
   *
   * Devolve a chave crua da categoria ("alimentacao"), e não um rótulo
   * capitalizado: quem sabe o nome de exibição e a cor de cada categoria é o
   * frontend, que tem o cadastro. Antes o retorno vinha como "Alimentacao",
   * sem acento e com uma cor de paleta rotativa que não batia com a do resto
   * da interface.
   */
  async getCategoryStats(userId: string, month: number, year: number) {
    const transactions = await this.findAllById(userId, month, year);

    const categoryMap: Record<string, number> = {};

    transactions.forEach((t) => {
      if (t.type !== 'EXPENSE') return;

      const category = t.category || 'outros';
      categoryMap[category] = (categoryMap[category] || 0) + Number(t.amount);
    });

    return Object.entries(categoryMap)
      .map(([category, value]) => ({
        category,
        // `name` continua presente para não quebrar consumidores antigos.
        name: category,
        value: Number(value.toFixed(2)),
      }))
      .sort((a, b) => b.value - a.value);
  }
}
