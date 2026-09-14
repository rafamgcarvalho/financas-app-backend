import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { FinanceContextService } from './finance-context.service';
import { GeminiService } from './gemini.service';

@Module({
  controllers: [ChatController],
  providers: [ChatService, FinanceContextService, GeminiService],
})
export class ChatModule {}
