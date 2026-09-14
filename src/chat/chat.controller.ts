import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { ChatService, type ChatReply } from './chat.service';
import { GeminiService } from './gemini.service';
import { ChatRequestDto } from './dto/chat-request.dto';

/**
 * O que o AuthGuard pendura na requisição depois de validar o token.
 * `sub` é o id do usuário — a única origem aceita para o dono dos dados.
 */
type AuthenticatedRequest = Request & { user: { sub: string } };

/**
 * Assistente financeiro.
 *
 * O prefixo é `chat` e não `api/chat` para acompanhar as demais rotas do
 * projeto (`/auth`, `/transactions`, `/goals`), que não usam prefixo global.
 */
@Controller('chat')
@UseGuards(AuthGuard)
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly gemini: GeminiService,
  ) {}

  /**
   * Deixa a interface saber se vale a pena mostrar o assistente. Devolve apenas
   * se está configurado e qual modelo responde — nunca nada derivado da chave.
   */
  @Get('status')
  status(): { enabled: boolean; model: string } {
    return { enabled: this.gemini.isEnabled, model: this.gemini.model };
  }

  @Post()
  send(
    @Body() dto: ChatRequestDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ChatReply> {
    // O id vem do token, sempre. Nada do corpo da requisição escolhe de quem
    // são os dados que vão para o modelo.
    return this.chatService.reply(req.user.sub, dto);
  }
}
