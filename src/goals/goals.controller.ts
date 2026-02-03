/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  Body,
  Controller,
  Req,
  UseGuards,
  Post,
  Get,
  Delete,
  Param,
  Patch,
} from '@nestjs/common';
import { GoalsService } from './goals.service';
import { AuthGuard } from 'src/auth/auth.guard';
import { CreateGoalsDto } from './dto/create-goals';

@Controller('goals')
@UseGuards(AuthGuard)
export class GoalsController {
  constructor(private readonly goalsService: GoalsService) {}

  @Post()
  create(@Body() dto: CreateGoalsDto, @Req() req: any) {
    const userId = req.user.sub;
    return this.goalsService.create(dto, userId);
  }

  @Get()
  getAll(@Req() req: any) {
    const userId = req.user.sub;
    return this.goalsService.getAll(userId);
  }

  @Get(':id') // Esta é a rota que estava faltando!
  getOne(@Param('id') id: string, @Req() req: any) {
    const userId = req.user.sub;
    return this.goalsService.getOne(id, userId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Req() req: any,
    @Body() dto: Partial<CreateGoalsDto>,
  ) {
    return this.goalsService.update(id, req.user.sub, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.goalsService.remove(id, req.user.sub);
  }
}
