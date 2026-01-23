import { Module } from '@nestjs/common';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { TransactionsModule } from './transactions/transactions.module';
import { GoalsModule } from './goals/goals.module';

@Module({
  imports: [UsersModule, AuthModule, TransactionsModule, GoalsModule],
})
export class AppModule {}
