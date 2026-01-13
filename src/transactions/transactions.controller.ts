/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// src/transactions/transactions.controller.ts
import { Controller, Post, Get, Body, UseGuards, Req } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { AuthGuard } from '../auth/auth.guard';
import { Query, Patch, Param, Delete } from '@nestjs/common';

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
  ) {
    return this.transactionsService.findAllById(
      req.user.sub,
      month ? parseInt(month) : undefined,
      year ? parseInt(year) : undefined,
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
  remove(@Param('id') id: string, @Req() req: any) {
    return this.transactionsService.remove(id, req.user.sub);
  }

  @Get('balance')
  async getBalance(@Req() req: any) {
    return this.transactionsService.getBalance(req.user.sub);
  }
}
