/* eslint-disable @typescript-eslint/no-unused-vars */

import { BadRequestException, Injectable } from '@nestjs/common';
import { db } from '../db/drizzle';
import { goals, transactions, goalMembers, users } from '../db/schema';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { and, eq, gte, lte, max, min, sql, or, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { GoalsGateway } from '../goals/goals.gateway';
import {
  cashFlowOf,
  goalValueOf,
  normalizeFinanceType,
  positionOf,
  savingsRateOf,
  sumByType,
  type FinanceType,
} from '../finance/finance-math';

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

type TransactionType = FinanceType;

/**
 * Tipos do filtro, aceitando "expense", "EXPENSE" e listas como
 * "INVESTMENT,WITHDRAWAL". Qualquer coisa fora do enum é ignorada.
 *
 * A tela de investimentos precisa dos dois numa consulta só: são as duas faces
 * do mesmo histórico, e pedir separado devolveria duas listas para o navegador
 * intercalar por data.
 */
function normalizeTransactionTypes(type?: string): TransactionType[] {
  if (!type || type === 'all') return [];

  return [
    ...new Set(
      type
        .split(',')
        .map((part) => normalizeFinanceType(part.trim()))
        .filter((value): value is TransactionType => Boolean(value)),
    ),
  ];
}

/** Aporte e resgate são os tipos que movimentam o saldo de uma meta. */
function movesGoal(type: string): boolean {
  return type === 'INVESTMENT' || type === 'WITHDRAWAL';
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

    // O resgate sai de algum lugar: sacar mais do que a meta tem produziria um
    // saldo negativo que nenhuma tela sabe explicar. Barrar na entrada é mais
    // barato do que descobrir depois, olhando um card com valor impossível.
    if (dto.type === 'WITHDRAWAL' && dto.goalId) {
      const requested =
        Number(dto.amount) * (isRecurring ? totalRepetitions : 1);
      await this.assertWithdrawalFits(dto.goalId, requested);
    }

    const result = await db
      .insert(transactions)
      .values(transactionsToInsert)
      .returning();

    // Aporte e resgate mexem no saldo da meta — o valor é recalculado a partir
    // das transações, nunca somado em cima do que estava lá.
    if (movesGoal(dto.type) && dto.goalId) {
      await this.syncGoal(dto.goalId, userId, Number(dto.amount), 'created');
    }

    return result;
  }

  /**
   * Recalcula o valor de uma meta a partir das transações vinculadas a ela.
   *
   * Aportes menos resgates, lido do banco a cada vez. É mais uma consulta do
   * que somar um delta no lugar, mas é a única forma de editar, apagar ou
   * remanejar um lançamento sem chance de deixar resíduo — que era exatamente
   * o defeito da aritmética incremental anterior.
   */
  private async recalcGoalValue(goalId: string) {
    const rows = await db
      .select({
        type: transactions.type,
        total: sql<string>`COALESCE(SUM(${transactions.amount}), 0)`,
      })
      .from(transactions)
      .where(eq(transactions.goalId, goalId))
      .groupBy(transactions.type);

    const current = goalValueOf(
      sumByType(rows.map((row) => ({ ...row, amount: row.total }))),
    );

    const [goal] = await db.select().from(goals).where(eq(goals.id, goalId));
    if (!goal) return null;

    const target = Number(goal.targetValue);

    // PAUSED é uma escolha do usuário e sobrevive ao recálculo: só a dupla
    // ATIVA/CONCLUÍDA é derivada do valor. Antes, excluir um aporte reativava
    // uma meta pausada sem que ninguém tivesse pedido.
    const status =
      target > 0 && current >= target
        ? 'COMPLETED'
        : goal.status === 'COMPLETED'
          ? 'ACTIVE'
          : goal.status;

    const [updated] = await db
      .update(goals)
      .set({ currentValue: current.toFixed(2), status, updatedAt: new Date() })
      .where(eq(goals.id, goalId))
      .returning();

    return updated ?? null;
  }

  /** Recalcula a meta e avisa os participantes conectados. */
  private async syncGoal(
    goalId: string,
    userId: string,
    amount: number,
    action: 'created' | 'updated' | 'deleted',
  ) {
    const goal = await this.recalcGoalValue(goalId);

    const [user] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId));

    this.goalsGateway.notifyGoalUpdated({
      goalId,
      currentValue: goal?.currentValue ?? '0',
      userName: user?.name || 'Alguém',
      amount,
      action,
    });
  }

  /** @throws BadRequestException quando o resgate excede o saldo da meta. */
  private async assertWithdrawalFits(goalId: string, amount: number) {
    const [goal] = await db
      .select({ title: goals.title, currentValue: goals.currentValue })
      .from(goals)
      .where(eq(goals.id, goalId));

    if (!goal) return;

    const available = Number(goal.currentValue) || 0;

    if (amount > available) {
      throw new BadRequestException(
        `A meta "${goal.title}" tem R$ ${available.toFixed(2)} investidos — não é possível resgatar R$ ${amount.toFixed(2)}.`,
      );
    }
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
    // baixavam o mês inteiro e descartavam o resto no navegador. A de
    // Investimentos pede dois, separados por vírgula.
    const types = normalizeTransactionTypes(type);
    if (types.length === 1) {
      conditions.push(eq(transactions.type, types[0]));
    } else if (types.length > 1) {
      conditions.push(inArray(transactions.type, types));
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

    // Remanejar um aporte de uma meta para outra é uma operação legítima; o
    // que não pode é a meta antiga ficar com o valor do lançamento que saiu.
    // As duas são recalculadas no fim.
    const goalChanged =
      movesGoal(original.type) &&
      dto.goalId !== undefined &&
      dto.goalId !== original.goalId;

    const updateData: any = {
      title: dto.title,
      amount: dto.amount?.toString(),
      description: dto.description,
      category: dto.category,
      date: dto.date ? new Date(dto.date) : undefined,
      goalId: goalChanged ? dto.goalId : undefined,
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

    if (movesGoal(original.type)) {
      const updatedAmount =
        dto.amount !== undefined ? Number(dto.amount) : Number(original.amount);

      // A meta de origem entra na lista mesmo quando o lançamento mudou de
      // meta: é ela que precisa devolver o valor que saiu.
      const affectedGoals = new Set(
        [original.goalId, goalChanged ? dto.goalId : null].filter(
          (goalId): goalId is string => Boolean(goalId),
        ),
      );

      for (const goalId of affectedGoals) {
        await this.syncGoal(goalId, userId, updatedAmount, 'updated');
      }
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
    // O recálculo já enxerga as linhas que sobraram, então não importa quantas
    // foram apagadas — não há delta para acertar nem risco de subtrair a mais.
    if (movesGoal(transaction.type) && transaction.goalId) {
      const removed = Number(transaction.amount) * deletedResult.length;
      await this.syncGoal(transaction.goalId, userId, removed, 'deleted');
    }

    return deletedResult;
  }

  /**
   * Balanço do período, nos dois eixos que o app precisa distinguir.
   *
   * `cashFlow` é movimento: o que entrou e saiu no período, com aporte e
   * resgate em linhas próprias — investimento não vira despesa só para a conta
   * fechar, e resgate não vira receita.
   *
   * `position` é estoque: quanto existe acumulado até o fim do período. É de
   * onde saem caixa disponível, valor investido e patrimônio. Somar totais de
   * um mês não daria posição nenhuma, então ela vem de uma consulta própria
   * sobre todo o histórico até aquela data.
   *
   * Os campos soltos do topo (`income`, `total`, `unallocated`...) existiam
   * antes desta mudança e continuam respondendo o mesmo que sempre
   * responderam — `unallocated` agora desconta também os resgates, porque a
   * fórmula antiga ignorava que eles devolvem dinheiro ao caixa.
   */
  async getBalance(userId: string, month?: number, year?: number) {
    const period = this.periodBounds(month, year);

    const [periodRows, accumulatedRows] = await Promise.all([
      this.findAllById(userId, month, year),
      this.totalsUpTo(userId, period?.end),
    ]);

    const totals = sumByType(periodRows);
    const cashFlow = cashFlowOf(totals);
    const position = positionOf(accumulatedRows);

    return {
      income: cashFlow.income,
      expense: cashFlow.expense,
      investment: cashFlow.contributions,
      withdrawal: cashFlow.withdrawals,
      total: cashFlow.result,
      unallocated: cashFlow.net,
      savingsRate: savingsRateOf(totals),

      cashFlow,
      position,
    };
  }

  /** Primeiro e último instante do mês; null quando não há período pedido. */
  private periodBounds(month?: number, year?: number) {
    if (month === undefined || year === undefined) return null;

    return {
      start: new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)),
    };
  }

  /**
   * Totais por tipo de todo o histórico até `until`, somados no banco.
   *
   * Recortar por data é o que permite ao dashboard mostrar a posição de um mês
   * passado — navegar até março devolve o caixa que existia no fim de março, e
   * não o de hoje. Sem `until`, é a posição considerando tudo o que está
   * lançado, inclusive parcelas ainda por vencer.
   */
  private async totalsUpTo(userId: string, until?: Date) {
    const conditions = [eq(transactions.userId, userId)];
    if (until) conditions.push(lte(transactions.date, until));

    const rows = await db
      .select({
        type: transactions.type,
        total: sql<string>`COALESCE(SUM(${transactions.amount}), 0)`,
      })
      .from(transactions)
      .where(and(...conditions))
      .groupBy(transactions.type);

    return sumByType(rows.map((row) => ({ ...row, amount: row.total })));
  }

  async getTransactionRange(userId: string, type?: string) {
    const whereConditions = [eq(transactions.userId, userId)];

    const types = normalizeTransactionTypes(type);
    if (types.length === 1) {
      whereConditions.push(eq(transactions.type, types[0]));
    } else if (types.length > 1) {
      whereConditions.push(inArray(transactions.type, types));
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
    const rows = await this.findAllById(userId, month, year);
    const totals = sumByType(rows);

    // As cores ficam por conta do frontend, que tem a paleta por tipo.
    const comparison = [
      { name: 'Receitas', valor: totals.income },
      { name: 'Despesas', valor: totals.expense },
      { name: 'Aportes', valor: totals.contributions },
    ];

    // A quarta barra só aparece quando houve resgate: numa conta que nunca
    // resgata, uma coluna zerada fixa ocuparia espaço sem dizer nada.
    if (totals.withdrawals > 0) {
      comparison.push({ name: 'Resgates', valor: totals.withdrawals });
    }

    return comparison;
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
