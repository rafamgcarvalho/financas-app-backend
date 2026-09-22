import { Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { goalMembers, goals, transactions, users } from '../db/schema';
import { Anonymizer } from './sanitize';
import {
  buildSnapshot,
  HISTORY_MONTHS,
  type FinanceSnapshot,
  type GoalMovement,
  type GoalRow,
  type TransactionRow,
} from './finance-snapshot';

/**
 * Leitura do banco para montar o contexto do assistente.
 *
 * Todo `where` daqui é ancorado no `userId` que veio do token — nunca do corpo
 * da requisição. É o ponto onde o isolamento entre contas deixa de ser promessa
 * e vira consulta.
 */

/** O histórico detalhado é recortado; o acumulado de vida inteira vem de um SUM. */
const DETAIL_WINDOW_MONTHS = HISTORY_MONTHS + 12;

@Injectable()
export class FinanceContextService {
  /**
   * @param userId extraído do JWT pelo AuthGuard. Um id vindo de outro lugar
   *   transformaria este método num IDOR — não existe sobrecarga que aceite isso.
   */
  async buildFor(userId: string, now = new Date()): Promise<FinanceSnapshot> {
    const owner = await this.findOwner(userId);
    const anonymizer = new Anonymizer(owner);

    const detailStart = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth() - DETAIL_WINDOW_MONTHS,
        1,
      ),
    );

    const [rows, lifetimeTotals, goalRows] = await Promise.all([
      this.findTransactions(userId, detailStart),
      this.findLifetimeTotals(userId, now),
      this.findGoals(userId),
    ]);

    const contributionsByGoal = await this.findGoalContributions(
      goalRows.map((goal) => goal.id),
    );

    return buildSnapshot({
      rows,
      lifetimeTotals,
      goalRows,
      contributionsByGoal,
      now,
      anonymizer,
    });
  }

  /**
   * O nome e o username são lidos só para alimentar o anonimizador — servem
   * para riscar a própria identidade dos títulos livres, e não são enviados.
   */
  private async findOwner(userId: string) {
    const [owner] = await db
      .select({ name: users.name, username: users.username })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return owner ?? null;
  }

  /**
   * Janela detalhada. Sem limite superior de propósito: as parcelas futuras já
   * estão gravadas, e é justamente o que ainda vai vencer que interessa a quem
   * pergunta "quando termino de pagar isso?".
   */
  private async findTransactions(
    userId: string,
    start: Date,
  ): Promise<TransactionRow[]> {
    return db
      .select()
      .from(transactions)
      .where(
        and(eq(transactions.userId, userId), gte(transactions.date, start)),
      )
      .orderBy(transactions.date);
  }

  /** Acumulado de todo o histórico, até hoje — parcela futura ainda não é gasto. */
  private async findLifetimeTotals(userId: string, now: Date) {
    const rows = await db
      .select({
        type: transactions.type,
        total: sql<string>`COALESCE(SUM(${transactions.amount}), 0)`,
      })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), lte(transactions.date, now)))
      .groupBy(transactions.type);

    const totals = {
      receitas: 0,
      despesas: 0,
      investimentos: 0,
      resgates: 0,
    };

    for (const row of rows) {
      const value = Number(row.total) || 0;

      if (row.type === 'INCOME') totals.receitas = value;
      else if (row.type === 'EXPENSE') totals.despesas = value;
      else if (row.type === 'INVESTMENT') totals.investimentos = value;
      else if (row.type === 'WITHDRAWAL') totals.resgates = value;
    }

    return totals;
  }

  /** Metas em que o usuário é membro — dono ou convidado, como na tela de metas. */
  private async findGoals(userId: string): Promise<GoalRow[]> {
    const memberships = await db
      .select({ goalId: goalMembers.goalId, role: goalMembers.role })
      .from(goalMembers)
      .where(eq(goalMembers.userId, userId));

    if (memberships.length === 0) return [];

    const goalIds = memberships.map((membership) => membership.goalId);
    const roleByGoal = new Map(
      memberships.map((membership) => [membership.goalId, membership.role]),
    );

    const [rows, members] = await Promise.all([
      db.select().from(goals).where(inArray(goals.id, goalIds)),
      db
        .select({ goalId: goalMembers.goalId, userId: goalMembers.userId })
        .from(goalMembers)
        .where(inArray(goalMembers.goalId, goalIds)),
    ]);

    const membersByGoal = new Map<string, string[]>();
    for (const member of members) {
      const list = membersByGoal.get(member.goalId) ?? [];
      list.push(member.userId);
      membersByGoal.set(member.goalId, list);
    }

    return rows.map((goal) => ({
      id: goal.id,
      title: goal.title,
      description: goal.description,
      targetValue: goal.targetValue,
      currentValue: goal.currentValue,
      monthlyPlan: goal.monthlyPlan,
      startDate: goal.startDate,
      targetDate: goal.targetDate,
      type: goal.type,
      status: goal.status,
      priority: goal.priority,
      isOwner: roleByGoal.get(goal.id) === 'OWNER',
      memberIds: membersByGoal.get(goal.id) ?? [],
    }));
  }

  /**
   * Aportes e resgates por meta, de todos os participantes.
   *
   * Não é vazamento: `currentValue` da meta já soma o que todo mundo guardou, e
   * a tela da meta mostra esse histórico para qualquer membro. O que fica de
   * fora é a identidade — quem aportou vira "Participante N".
   */
  private async findGoalContributions(goalIds: string[]) {
    const byGoal = new Map<string, GoalMovement[]>();

    if (goalIds.length === 0) return byGoal;

    const rows = await db
      .select({
        goalId: transactions.goalId,
        date: transactions.date,
        amount: transactions.amount,
        type: transactions.type,
      })
      .from(transactions)
      .where(
        and(
          inArray(transactions.goalId, goalIds),
          // O resgate entra junto: sem ele o ritmo da meta mostraria só o que
          // entrou e ignoraria o que saiu.
          inArray(transactions.type, ['INVESTMENT', 'WITHDRAWAL']),
        ),
      );

    for (const row of rows) {
      if (!row.goalId) continue;

      const list = byGoal.get(row.goalId) ?? [];
      list.push({ date: row.date, amount: row.amount, type: row.type });
      byGoal.set(row.goalId, list);
    }

    return byGoal;
  }
}
