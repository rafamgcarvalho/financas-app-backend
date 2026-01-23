/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { Body, Controller, Req, UseGuards, Post, Get } from '@nestjs/common';
import { GoalsService } from './goals.service';
import { AuthGuard } from 'src/auth/auth.guard';
import { createGoalsDto } from './dto/create-goals';

@Controller('goals')
@UseGuards(AuthGuard)
export class GoalsController {
  constructor(private readonly goalsService: GoalsService) {}

  @Post()
  create(@Body() dto: createGoalsDto, @Req() req: any) {
    const userId = req.user.sub;
    return this.goalsService.create(dto, userId);
  }

  @Get()
  getAll(@Req() req: any) {
    const userId = req.user.sub;
    return this.goalsService.getAll(userId);
  }
}
