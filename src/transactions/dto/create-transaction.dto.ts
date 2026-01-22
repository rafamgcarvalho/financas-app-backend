import {
  IsNotEmpty,
  IsNumber,
  IsEnum,
  IsString,
  IsOptional,
  IsISO8601,
  IsBoolean,
  Min,
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

  @IsISO8601()
  @IsNotEmpty()
  date: string;

  @IsString()
  @IsNotEmpty()
  category: string;

  @IsEnum(['INCOME', 'EXPENSE'])
  @IsNotEmpty()
  type: 'INCOME' | 'EXPENSE';

  @IsBoolean()
  @IsOptional()
  isRecurring?: boolean;

  @IsNumber()
  @IsOptional()
  @Min(1)
  installments?: number;
}
