// src/transactions/transactions.service.ts
import { Injectable } from '@nestjs/common';
import { db } from '../db/drizzle';
import { transactions } from '../db/schema';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { eq } from 'drizzle-orm';

@Injectable()
export class TransactionsService {
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

  // Método essencial para o seu Dashboard futuro
  async findAllByUser(userId: string) {
    return await db
      .select()
      .from(transactions)
      .where(eq(transactions.userId, userId));
  }

  async getBalance(userId: string) {
    const allTransactions = await this.findAllByUser(userId);

    const balance = allTransactions.reduce(
      (acc, transaction) => {
        // Convertemos a string do banco para número para o cálculo
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
