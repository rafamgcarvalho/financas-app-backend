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
export const MAX_HISTORY_ITEMS = 40;
/**
 * Teto por mensagem do histórico.
 *
 * Bate com o orçamento total de caracteres que o cliente envia (`toApiHistory`,
 * no frontend): assim, qualquer mensagem que ele consiga mandar é aceita. Um
 * teto menor devolveria 400 na pergunta seguinte por causa da própria resposta
 * do assistente — que agora pode ser longa, já que a geração é retomada quando
 * bate no limite de tokens do modelo.
 */
const MAX_HISTORY_ITEM_LENGTH = 120000;

/** Tetos do resumo de outros chats — o digest não pode virar o prompt inteiro. */
export const MAX_OTHER_CONVERSATIONS = 6;
const MAX_OTHER_QUESTIONS = 6;
const MAX_OTHER_TITLE_LENGTH = 120;

export class ChatHistoryItemDto {
  /** "model" é o nome que o Gemini dá ao turno do assistente. */
  @IsIn(['user', 'model'])
  role: 'user' | 'model';

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_HISTORY_ITEM_LENGTH)
  content: string;
}

/**
 * Resumo de um outro chat do mesmo usuário.
 *
 * Só as perguntas que ele escreveu, nunca as respostas do modelo: a pergunta
 * carrega a intenção e os fatos que ele declarou ("meu salário vai aumentar
 * para 3000"), enquanto a resposta antiga carregaria números que podem já estar
 * desatualizados — e número velho ao lado do atual é convite para o modelo citar
 * o errado.
 */
export class OtherConversationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_OTHER_TITLE_LENGTH)
  title: string;

  @IsArray()
  @ArrayMaxSize(MAX_OTHER_QUESTIONS)
  @IsString({ each: true })
  @MaxLength(MAX_MESSAGE_LENGTH, { each: true })
  questions: string[];
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

  /**
   * Os outros chats do usuário, resumidos. É o que dá a cada conversa alguma
   * memória das demais sem precisar de um banco de conversas no servidor.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_OTHER_CONVERSATIONS)
  @ValidateNested({ each: true })
  @Type(() => OtherConversationDto)
  otherConversations?: OtherConversationDto[];
}
