import { Module } from '@nestjs/common';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { TransactionsModule } from './transactions/transactions.module';

@Module({
  imports: [UsersModule, AuthModule, TransactionsModule],
})
export class AppModule {}
