/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { AuthGuard } from '../auth/auth.guard';
import { Query, Patch, Param, Delete, Request } from '@nestjs/common';

@Controller('transactions')
@UseGuards(AuthGuard)
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post()
  create(@Body() dto: CreateTransactionDto, @Req() req: any) {
    const userId = req.user.sub;
    return this.transactionsService.create(dto, userId);
  }

  @Get()
  findAll(
    @Req() req: any,
    @Query('month') month?: string,
    @Query('year') year?: string,
    @Query('goalId') goalId?: string,
  ) {
    return this.transactionsService.findAllById(
      req.user.sub,
      month ? parseInt(month) : undefined,
      year ? parseInt(year) : undefined,
      goalId,
    );
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Req() req: any,
    @Body() dto: Partial<CreateTransactionDto>,
  ) {
    return this.transactionsService.update(id, req.user.sub, dto);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Req() req: any,
    @Query('deleteAll') deleteAll?: string,
  ) {
    const shouldDeleteAll = deleteAll === 'true';
    return this.transactionsService.remove(id, req.user.sub, shouldDeleteAll);
  }

  @Get('balance')
  async getBalance(
    @Req() req: any,
    @Query('month') month?: string,
    @Query('year') year?: string,
  ) {
    return this.transactionsService.getBalance(
      req.user.sub,
      month ? parseInt(month) : undefined,
      year ? parseInt(year) : undefined,
    );
  }

  @Get('range')
  async getRange(@Req() req: any, @Query('type') type?: string) {
    const userId = req.user?.id || req.user?.sub;

    if (!userId) {
      throw new UnauthorizedException('Usuário não identificado');
    }

    return this.transactionsService.getTransactionRange(userId, type);
  }

  @Get('stats')
  async getStats(@Req() req: any) {
    return this.transactionsService.getStats(req.user.sub);
  }

  @Get('stats/comparison')
  async getComparison(
    @Request() req,
    @Query('month') month: number,
    @Query('year') year: number,
  ) {
    const userId = req.user?.id || req.user?.sub;
    return this.transactionsService.getMonthlyComparison(
      userId,
      Number(month),
      Number(year),
    );
  }

  @Get('stats/categories')
  async getCategoryStats(
    @Request() req,
    @Query('month') month: number,
    @Query('year') year: number,
  ) {
    const userId = req.user?.id || req.user?.sub;
    return this.transactionsService.getCategoryStats(
      userId,
      Number(month),
      Number(year),
    );
  }
}
