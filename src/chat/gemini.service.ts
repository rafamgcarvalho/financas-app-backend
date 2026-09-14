import {
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  FinishReason,
  GoogleGenAI,
  type Content,
  type GenerateContentConfig,
} from '@google/genai';

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

/**
 * Teto de saída.
 *
 * O número precisa ser generoso porque **os tokens de raciocínio do modelo
 * contam aqui dentro**: "The max_output_tokens generation parameter sets the
 * maximum number of tokens a response can generate, including thought tokens"
 * (ai.google.dev/gemini-api/docs/thinking). Com 2048 no total, uma pergunta de
 * projeção gastava quase tudo pensando e a resposta era cortada no meio da
 * frase — foi exatamente o que aconteceu em produção.
 *
 * 8192 deixa folga para o raciocínio e ainda cabe uma resposta longa com tabela.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export type GeminiResult = {
  text: string;
  /** O modelo bateu no teto de tokens e a resposta terminou no meio. */
  truncated: boolean;
};

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

  /** Lê um número do ambiente, caindo no padrão quando ausente ou inválido. */
  private envNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;

    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private buildConfig(systemInstruction: string): GenerateContentConfig {
    const config: GenerateContentConfig = {
      systemInstruction,
      temperature: this.envNumber('GEMINI_TEMPERATURE', DEFAULT_TEMPERATURE),
      maxOutputTokens: this.envNumber(
        'GEMINI_MAX_OUTPUT_TOKENS',
        DEFAULT_MAX_OUTPUT_TOKENS,
      ),
    };

    // O orçamento de raciocínio fica como ajuste opcional, e não como padrão:
    // o parâmetro varia entre gerações de modelo, e fixá-lo no código quebraria
    // a troca de `GEMINI_MODEL` — que é justamente o jeito de acompanhar as
    // versões novas do Flash. Sem a variável, vale o padrão do próprio modelo.
    const thinkingBudget = process.env.GEMINI_THINKING_BUDGET;
    if (thinkingBudget !== undefined && thinkingBudget.trim() !== '') {
      const parsed = Number(thinkingBudget);
      if (Number.isFinite(parsed))
        config.thinkingConfig = { thinkingBudget: parsed };
    }

    return config;
  }

  async generate(params: {
    systemInstruction: string;
    contents: Content[];
  }): Promise<GeminiResult> {
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
        config: this.buildConfig(params.systemInstruction),
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

    const finishReason = response.candidates?.[0]?.finishReason;
    const text = response.text?.trim();
    const truncated = finishReason === FinishReason.MAX_TOKENS;

    if (text) {
      if (truncated) {
        // Devolver texto cortado como se estivesse completo é o pior desfecho:
        // quem lê "faltam 10 parcelas de" sem o número decide no escuro.
        this.logger.warn(
          `Resposta truncada por maxOutputTokens (pensamento=${
            response.usageMetadata?.thoughtsTokenCount ?? 'n/d'
          }, saída=${response.usageMetadata?.candidatesTokenCount ?? 'n/d'}).`,
        );
      }

      return { text, truncated };
    }

    // Resposta vazia tem causa: filtro de segurança, corte por limite de tokens
    // ou bloqueio do prompt. Cada uma pede uma orientação diferente ao usuário.
    const blockReason = response.promptFeedback?.blockReason;

    this.logger.warn(
      `Resposta vazia do Gemini (finishReason=${finishReason ?? 'n/d'}, blockReason=${blockReason ?? 'n/d'}).`,
    );

    if (truncated) {
      throw new ServiceUnavailableException(
        'O modelo gastou todo o limite de tokens antes de escrever a resposta. Tente uma pergunta mais específica.',
      );
    }

    throw new ServiceUnavailableException(
      'Não consegui gerar uma resposta para essa mensagem. Tente reformular a pergunta.',
    );
  }
}
