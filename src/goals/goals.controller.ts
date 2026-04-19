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

  @Get(':id')
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

  /* ========== MEMBROS ========== */

  @Post(':id/members')
  addMember(
    @Param('id') goalId: string,
    @Req() req: any,
    @Body('username') username: string,
  ) {
    return this.goalsService.addMember(goalId, req.user.sub, username);
  }

  @Get(':id/members')
  getMembers(@Param('id') goalId: string, @Req() req: any) {
    return this.goalsService.getMembers(goalId, req.user.sub);
  }

  @Delete(':id/members/:memberId')
  removeMember(
    @Param('id') goalId: string,
    @Param('memberId') memberId: string,
    @Req() req: any,
  ) {
    return this.goalsService.removeMember(goalId, req.user.sub, memberId);
  }
}
