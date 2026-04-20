import { Module } from '@nestjs/common';
import { GoalsController } from './goals.controller';
import { GoalsService } from './goals.service';
import { GoalsGateway } from './goals.gateway';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [UsersModule],
  controllers: [GoalsController],
  providers: [GoalsService, GoalsGateway],
  exports: [GoalsGateway],
})
export class GoalsModule {}
