/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  Injectable,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { db } from '../db/drizzle';
import { users } from '../db/schema';
import { CreateUserDto } from './dto/create-user.dto';
import * as bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';

@Injectable()
export class UsersService {
  async create(dto: CreateUserDto) {
    // 1. Verificar se o e-mail já existe (Boa prática antes de tentar inserir)
    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.email, dto.email))
      .limit(1);

    if (existingUser.length > 0) {
      throw new ConflictException('Este e-mail já está em uso');
    }

    try {
      const hashedPassword = await bcrypt.hash(dto.password, 10);

      const [user] = await db
        .insert(users)
        .values({
          name: dto.name,
          email: dto.email,
          password: hashedPassword,
        })
        .returning({
          id: users.id,
          name: users.name,
          email: users.email,
        });

      return user;
    } catch (error) {
      // 2. Tratamento de erro específico do Postgres para Unique Constraint (erro 23505)
      if (error.code === '23505') {
        throw new ConflictException('E-mail já cadastrado');
      }

      console.error('Erro ao criar usuário:', error);
      throw new InternalServerErrorException('Erro interno ao criar usuário');
    }
  }

  async findByEmail(email: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    return user;
  }
}
