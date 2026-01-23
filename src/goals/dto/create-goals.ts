import {
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

export class createGoalsDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsNumber()
  @IsNotEmpty()
  targetValue: number;

  @IsISO8601()
  @IsNotEmpty()
  startDate: string;

  @IsISO8601()
  @IsOptional()
  targetDate: string;

  @IsEnum(['SHORT', 'MEDIUM', 'LONG'])
  @IsNotEmpty()
  type: 'SHORT' | 'MEDIUM' | 'LONG';

  @IsEnum(['ACTIVE', 'PAUSED', 'COMPLETED'])
  @IsNotEmpty()
  status: 'ACTIVE' | 'PAUSED' | 'COMPLETED';

  @IsEnum(['ESSENTIAL', 'IMPORTANT', 'DESIRABLE'])
  @IsNotEmpty()
  priority: 'ESSENTIAL' | 'IMPORTANT' | 'DESIRABLE';
}
