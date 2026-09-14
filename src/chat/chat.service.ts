import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Content } from '@google/genai';
import { FinanceContextService } from './finance-context.service';
import { GeminiService } from './gemini.service';
import { ChatRequestDto } from './dto/chat-request.dto';
import { looksLikeInjection, sanitizeUserMessage } from './sanitize';
import {
  buildUserTurn,
  FINBOT_SYSTEM_PROMPT,
  type OtherConversation,
} from './system-prompt';
import { SlidingWindowRateLimiter } from './rate-limiter';

/**
 * Orquestração de uma pergunta ao assistente.
 *
 * A ordem importa: limite → contexto → modelo. Buscar o contexto antes de checar
 * o limite faria um cliente em laço varrer o banco de graça, mesmo sem nunca
 * chegar ao Gemini.
 */

const RATE_LIMIT_MESSAGES = 20;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

/**
 * Quantos turnos do histórico seguem para o modelo (20 pares pergunta/resposta).
 *
 * Cortar curto demais era parte do problema relatado: o assistente perdia o que
 * tinha sido combinado no começo da conversa e voltava a se apresentar.
 */
const MAX_HISTORY_TURNS = 40;

export type ChatReply = {
  answer: string;
  model: string;
  generatedAt: string;
  /** True quando o modelo bateu no teto de tokens e a resposta ficou pela metade. */
  truncated: boolean;
};

@Injectable()
export class ChatService {
  private readonly rateLimiter = new SlidingWindowRateLimiter(
    RATE_LIMIT_MESSAGES,
    RATE_LIMIT_WINDOW_MS,
  );

  constructor(
    private readonly financeContext: FinanceContextService,
    private readonly gemini: GeminiService,
  ) {}

  /**
   * @param userId sempre o `sub` do JWT. O DTO não tem campo de usuário, e este
   *   parâmetro não tem outra origem possível no controller.
   */
  async reply(userId: string, dto: ChatRequestDto): Promise<ChatReply> {
    const message = sanitizeUserMessage(dto.message);

    if (!message) {
      throw new BadRequestException(
        'Escreva uma pergunta para o assistente financeiro.',
      );
    }

    this.enforceRateLimit(userId);

    const snapshot = await this.financeContext.buildFor(userId);
    const history = this.buildHistory(dto.history);

    const result = await this.gemini.generate({
      systemInstruction: FINBOT_SYSTEM_PROMPT,
      contents: [
        ...history,
        {
          role: 'user',
          parts: [
            {
              text: buildUserTurn({
                snapshot,
                question: message,
                suspicious: looksLikeInjection(message),
                state: {
                  // Conta só os turnos do usuário: é o número da pergunta, não
                  // o de linhas trocadas.
                  messageNumber:
                    history.filter((turn) => turn.role === 'user').length + 1,
                  isFirstMessage: history.length === 0,
                },
                otherConversations: this.buildOtherConversations(
                  dto.otherConversations,
                ),
              }),
            },
          ],
        },
      ],
    });

    return {
      answer: result.text,
      model: this.gemini.model,
      generatedAt: new Date().toISOString(),
      truncated: result.truncated,
    };
  }

  private enforceRateLimit(userId: string): void {
    const verdict = this.rateLimiter.check(userId);
    if (verdict.allowed) return;

    throw new HttpException(
      `Muitas perguntas em sequência. Tente de novo em ${verdict.retryAfterSeconds}s.`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /**
   * Histórico da conversa, sem os contextos antigos.
   *
   * Só o texto da pergunta volta — a foto financeira é remontada a cada turno.
   * Reenviar as fotos anteriores encheria a janela do modelo de números
   * desatualizados, e um saldo velho ao lado do atual é convite para a resposta
   * citar o errado.
   */
  private buildHistory(history: ChatRequestDto['history']): Content[] {
    if (!history?.length) return [];

    const turns = history.slice(-MAX_HISTORY_TURNS);

    // A conversa precisa começar por um turno do usuário: um histórico cortado
    // no meio pode começar com a resposta do assistente pendurada no vazio.
    while (turns.length && turns[0].role !== 'user') turns.shift();

    return turns
      .map((turn) => ({
        role: turn.role,
        parts: [{ text: sanitizeUserMessage(turn.content) }],
      }))
      .filter((turn) => turn.parts[0].text.length > 0);
  }

  /** Resumo dos outros chats, higienizado e sem entradas vazias. */
  private buildOtherConversations(
    conversations: ChatRequestDto['otherConversations'],
  ): OtherConversation[] {
    if (!conversations?.length) return [];

    return conversations
      .map((conversation) => ({
        title: sanitizeUserMessage(conversation.title),
        questions: conversation.questions
          .map((question) => sanitizeUserMessage(question))
          .filter((question) => question.length > 0),
      }))
      .filter(
        (conversation) =>
          conversation.title.length > 0 && conversation.questions.length > 0,
      );
  }
}
