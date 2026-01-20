/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import {
  Injectable,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { db } from '../db/drizzle';
import { transactions, users } from '../db/schema';
import { CreateUserDto } from './dto/create-user.dto';
import * as bcrypt from 'bcrypt';
import { and, eq } from 'drizzle-orm';
import { CreateTransactionDto } from 'src/transactions/dto/create-transaction.dto';

@Injectable()
export class UsersService {
  /*Criar um usuário*/
  async create(dto: CreateUserDto) {
    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.username, dto.username))
      .limit(1);

    if (existingUser.length > 0) {
      throw new ConflictException('Este nome de usuário já está em uso');
    }

    try {
      const hashedPassword = await bcrypt.hash(dto.password, 10);

      const [user] = await db
        .insert(users)
        .values({
          name: dto.name,
          username: dto.username,
          password: hashedPassword,
        })
        .returning({
          id: users.id,
          name: users.name,
          username: users.username,
        });

      return user;
    } catch (error) {
      if (error.code === '23505') {
        throw new ConflictException('Nome de usuário já cadastrado');
      }

      console.error('Erro ao criar usuário:', error);
      throw new InternalServerErrorException('Erro interno ao criar usuário');
    }
  }

  /*Editar um usuário*/
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

  /*Excluir um usuário*/
  async remove(id: string, userId: string) {
    const [deleted] = await db
      .delete(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.userId, userId)))
      .returning();

    return deleted;
  }

  /*Encontrar pelo email*/
  async findByUsername(username: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.username, username.toLowerCase()))
      .limit(1);
    return user;
  }
}
