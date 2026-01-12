/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// src/transactions/transactions.controller.ts
import { Controller, Post, Get, Body, UseGuards, Req } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { AuthGuard } from '../auth/auth.guard';

@Controller('transactions')
@UseGuards(AuthGuard) // Protege TODAS as rotas deste controller
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post()
  create(@Body() dto: CreateTransactionDto, @Req() req: any) {
    // O id do Rafael vem do token JWT decodificado pelo Guard
    const userId = req.user.sub;
    return this.transactionsService.create(dto, userId);
  }

  @Get()
  findAll(@Req() req: any) {
    return this.transactionsService.findAllByUser(req.user.sub);
  }

  @Get('balance')
  async getBalance(@Req() req: any) {
    return this.transactionsService.getBalance(req.user.sub);
  }
}
