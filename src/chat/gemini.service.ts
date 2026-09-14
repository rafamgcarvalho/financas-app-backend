import {
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { FinishReason, GoogleGenAI, type Content } from '@google/genai';

/**
 * Cliente do Gemini.
 *
 * A chave vive só aqui, lida do ambiente do servidor. Nenhuma rota devolve o
 * valor dela, e nenhum erro do SDK chega ao cliente sem passar por esta classe —
 * mensagens de erro de API costumam ecoar a URL da requisição, e a URL do Gemini
 * carrega a chave.
 */

const DEFAULT_MODEL = 'gemini-2.5-flash';

/**
 * Temperatura baixa por decisão de projeto: o assistente fala sobre dinheiro
 * alheio. Resposta determinística erra menos número e adere melhor às regras de
 * escopo do system prompt do que uma resposta criativa.
 */
const DEFAULT_TEMPERATURE = 0.2;

const MAX_OUTPUT_TOKENS = 2048;

@Injectable()
export class GeminiService implements OnModuleInit {
  private readonly logger = new Logger(GeminiService.name);
  private client: GoogleGenAI | null = null;

  readonly model = process.env.GEMINI_MODEL || DEFAULT_MODEL;

  onModuleInit() {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      // Não derruba o boot: o resto da API não depende do chat, e um deploy sem
      // a chave deve continuar servindo lançamentos e metas normalmente.
      this.logger.warn(
        'GEMINI_API_KEY ausente — o assistente financeiro ficará indisponível.',
      );
      return;
    }

    this.client = new GoogleGenAI({ apiKey });
    this.logger.log(`Assistente financeiro pronto (modelo ${this.model}).`);
  }

  get isEnabled(): boolean {
    return this.client !== null;
  }

  private get temperature(): number {
    const configured = Number(process.env.GEMINI_TEMPERATURE);
    return Number.isFinite(configured) ? configured : DEFAULT_TEMPERATURE;
  }

  async generate(params: {
    systemInstruction: string;
    contents: Content[];
  }): Promise<string> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'O assistente financeiro não está configurado neste servidor.',
      );
    }

    let response: Awaited<ReturnType<GoogleGenAI['models']['generateContent']>>;

    try {
      response = await this.client.models.generateContent({
        model: this.model,
        contents: params.contents,
        config: {
          systemInstruction: params.systemInstruction,
          temperature: this.temperature,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
      });
    } catch (error) {
      // O detalhe fica no log do servidor; o cliente recebe só o que pode agir.
      this.logger.error(
        `Falha ao chamar o Gemini: ${error instanceof Error ? error.message : String(error)}`,
      );

      throw new ServiceUnavailableException(
        'Não consegui falar com o assistente agora. Tente de novo em instantes.',
      );
    }

    const text = response.text?.trim();

    if (text) return text;

    // Resposta vazia tem causa: filtro de segurança, corte por limite de tokens
    // ou bloqueio do prompt. Cada uma pede uma orientação diferente ao usuário.
    const finishReason = response.candidates?.[0]?.finishReason;
    const blockReason = response.promptFeedback?.blockReason;

    this.logger.warn(
      `Resposta vazia do Gemini (finishReason=${finishReason ?? 'n/d'}, blockReason=${blockReason ?? 'n/d'}).`,
    );

    if (finishReason === FinishReason.MAX_TOKENS) {
      throw new ServiceUnavailableException(
        'A resposta ficou longa demais. Tente uma pergunta mais específica.',
      );
    }

    throw new ServiceUnavailableException(
      'Não consegui gerar uma resposta para essa mensagem. Tente reformular a pergunta.',
    );
  }
}
