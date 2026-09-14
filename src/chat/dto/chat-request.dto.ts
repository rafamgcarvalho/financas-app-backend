import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * Contrato do chat.
 *
 * Note o que NÃO existe aqui: `userId`. O `ValidationPipe` global roda com
 * `forbidNonWhitelisted`, então um cliente que tentar mandar `userId` no corpo
 * leva 400 antes de encostar no controller — o dono dos dados é sempre o `sub`
 * do token, e o próprio contrato torna a alternativa impossível.
 */

export const MAX_MESSAGE_LENGTH = 1000;
export const MAX_HISTORY_ITEMS = 20;
/**
 * Folgado o bastante para caber a resposta mais longa que o modelo consegue
 * gerar (`maxOutputTokens` 2048). Um teto apertado aqui devolveria 400 na
 * mensagem seguinte e travaria a conversa por causa do próprio assistente.
 */
const MAX_HISTORY_ITEM_LENGTH = 12000;

export class ChatHistoryItemDto {
  /** "model" é o nome que o Gemini dá ao turno do assistente. */
  @IsIn(['user', 'model'])
  role: 'user' | 'model';

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_HISTORY_ITEM_LENGTH)
  content: string;
}

export class ChatRequestDto {
  @IsString()
  @IsNotEmpty({ message: 'Escreva uma pergunta para o assistente.' })
  @MaxLength(MAX_MESSAGE_LENGTH, {
    message: `A pergunta deve ter no máximo ${MAX_MESSAGE_LENGTH} caracteres.`,
  })
  message: string;

  /**
   * Histórico da conversa mantido pelo cliente. É reenviado a cada mensagem
   * porque o servidor não guarda conversa — sem persistência não há transcrição
   * de finanças esquecida em nenhuma tabela.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_HISTORY_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => ChatHistoryItemDto)
  history?: ChatHistoryItemDto[];
}
