// src/transactions/dto/create-transaction.dto.ts
import {
  IsNotEmpty,
  IsNumber,
  IsEnum,
  IsString,
  IsOptional,
  IsISO8601,
} from 'class-validator';

export class CreateTransactionDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsNumber()
  @IsNotEmpty()
  amount: number;

  @IsString()
  @IsOptional()
  description?: string;

  @IsISO8601() // Garante formato de data válido (YYYY-MM-DD)
  @IsNotEmpty()
  date: string;

  @IsString()
  @IsNotEmpty()
  category: string;

  @IsEnum(['INCOME', 'EXPENSE'])
  @IsNotEmpty()
  type: 'INCOME' | 'EXPENSE';
}
