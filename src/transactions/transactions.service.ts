// src/transactions/transactions.service.ts
import { Injectable } from '@nestjs/common';
import { db } from '../db/drizzle';
import { transactions } from '../db/schema';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { and, eq, gte, lte, SQL, sql } from 'drizzle-orm';

@Injectable()
export class TransactionsService {
  /*Adicionar uma transação*/
  async create(dto: CreateTransactionDto, userId: string) {
    const [newTransaction] = await db
      .insert(transactions)
      .values({
        ...dto,
        userId,
        amount: dto.amount.toString(),
        date: new Date(dto.date),
      })
      .returning();

    return newTransaction;
  }

  /*Encontrar transações de um usuário por id*/
  async findAllById(userId: string, month?: number, year?: number) {
    // 1. Define o padrão para o mês/ano atual se não forem fornecidos
    const targetMonth = month || new Date().getMonth() + 1;
    const targetYear = year || new Date().getFullYear();

    // 2. Cria as datas de início e fim com precisão
    const startDate = new Date(
      Date.UTC(targetYear, targetMonth - 1, 1, 0, 0, 0),
    );
    const endDate = new Date(
      Date.UTC(targetYear, targetMonth, 0, 23, 59, 59, 999),
    );

    // 3. A cláusula WHERE agora sempre filtrará por data, garantindo a lógica do Dashboard
    const whereClause = and(
      eq(transactions.userId, userId),
      gte(transactions.date, startDate),
      lte(transactions.date, endDate),
    ) as SQL;

    return await db
      .select()
      .from(transactions)
      .where(whereClause)
      .orderBy(sql`${transactions.date} DESC`);
  }

  /*Editar uma transação*/
  async update(id: string, userId: string, dto: Partial<CreateTransactionDto>) {
    const [updated] = await db
      .update(transactions)
      .set({
        ...dto,
        amount: dto.amount?.toString(),
        date: dto.date ? new Date(dto.date) : undefined,
      })
      .where(and(eq(transactions.id, id), eq(transactions.userId, userId)))
      .returning();

    return updated;
  }

  /*Excluir uma transação*/
  async remove(id: string, userId: string) {
    const [deleted] = await db
      .delete(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.userId, userId)))
      .returning();

    return deleted;
  }

  /*Calcular balanço*/
  async getBalance(userId: string, month?: number, year?: number) {
    const allTransactions = await this.findAllById(userId, month, year);

    const balance = allTransactions.reduce(
      (acc, transaction) => {
        const amount = Number(transaction.amount);

        if (transaction.type === 'INCOME') {
          acc.income += amount;
        } else {
          acc.expense += amount;
        }

        acc.total = acc.income - acc.expense;
        return acc;
      },
      { income: 0, expense: 0, total: 0 },
    );

    return balance;
  }
}
