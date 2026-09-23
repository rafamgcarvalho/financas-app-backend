import {
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiError,
  FinishReason,
  GoogleGenAI,
  type Content,
  type GenerateContentConfig,
  type GenerateContentResponse,
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
 * Quantas vezes a geração pode ser retomada de onde parou.
 *
 * Existe porque nenhum teto resolve o caso sozinho: `maxOutputTokens` não é
 * ilimitado nem quando omitido — vale o máximo do modelo —, e **os tokens de
 * raciocínio contam dentro dele** ("max_output_tokens sets the maximum number of
 * tokens a response can generate, including thought tokens",
 * ai.google.dev/gemini-api/docs/thinking). Em vez de torcer para o teto ser
 * suficiente, quando ele é atingido pedimos a continuação e emendamos o texto —
 * ninguém deveria precisar digitar "continue".
 *
 * Cada retomada reenvia o contexto inteiro. Três é o ponto onde a conta ainda
 * compensa: uma resposta que não fecha em quatro gerações do modelo não é uma
 * resposta, é um relatório que ninguém vai ler.
 */
const MAX_CONTINUATIONS = 3;

/**
 * O pedido de continuação.
 *
 * "Inclusive no meio de uma palavra" não é firula: a emenda é literal, sem
 * separador, porque qualquer caractere inserido no ponto de corte apareceria no
 * meio de uma frase ou quebraria a linha de uma tabela Markdown.
 */
const CONTINUE_PROMPT = `Sua resposta anterior foi interrompida pelo limite de tokens, no meio. Continue EXATAMENTE do ponto onde parou — inclusive no meio de uma palavra, linha ou tabela, se for o caso.

Não cumprimente, não recomece, não resuma o que já disse e não repita nenhum trecho anterior. Escreva apenas a continuação, como se fosse o próximo caractere do mesmo texto.`;

/**
 * Status HTTP que valem uma nova tentativa.
 *
 * São as falhas do lado deles, não da pergunta: sobrecarga momentânea (503),
 * limite de taxa (429), erro interno (500/502/504) e timeout (408). Repetir a
 * mesma requisição depois de um instante costuma passar.
 *
 * 400, 401, 403 e 404 ficam de fora de propósito — nenhuma delas melhora com
 * insistência, e repeti-las só faria o usuário esperar mais pelo mesmo erro.
 */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Quantas vezes uma chamada pode ser repetida antes de desistir.
 *
 * Duas. Com o backoff abaixo, o pior caso adiciona cerca de 1,2s antes de
 * devolver o erro — tempo que o usuário já gastaria clicando em "tentar
 * novamente", que era exatamente o que ele vinha tendo que fazer.
 */
const MAX_RETRIES = 2;

/** Espera base do backoff exponencial: 300ms, depois 600ms. */
const RETRY_BASE_DELAY_MS = 300;

export type GeminiResult = {
  text: string;
  /**
   * A resposta continuou truncada mesmo depois das retomadas. Sinal para a
   * interface avisar, e não para esconder o problema.
   */
  truncated: boolean;
  /** Quantas retomadas foram necessárias. Zero é o caso comum. */
  continuations: number;
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
    };

    // Sem `maxOutputTokens` de propósito: omitir deixa valer o máximo do próprio
    // modelo, que é o maior valor possível sem ter que fixar no código um número
    // que muda a cada geração de Flash. Quem quiser conter custo põe a variável.
    const maxOutputTokens = this.envNumber('GEMINI_MAX_OUTPUT_TOKENS', 0);
    if (maxOutputTokens > 0) config.maxOutputTokens = maxOutputTokens;

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

  /** Pausa entre tentativas. Método para os testes poderem adiantar o relógio. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * A falha é do lado deles e passa sozinha?
   *
   * Além do status HTTP, cobre a queda de conexão: quando o fetch morre antes de
   * ter resposta o SDK propaga um TypeError ("fetch failed") sem status nenhum,
   * e esse é justamente o caso em que repetir resolve.
   */
  private isRetryable(error: unknown): boolean {
    if (error instanceof ApiError) return RETRYABLE_STATUSES.has(error.status);

    if (error instanceof Error) {
      return /fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(
        error.message,
      );
    }

    return false;
  }

  /**
   * Uma chamada ao modelo, repetida quando a falha é transitória.
   *
   * O Gemini devolve 503 de vez em quando sob carga, e sem isto uma única
   * oscilação virava erro na cara do usuário — que clicava de novo e funcionava.
   * Se ele ia repetir a chamada de qualquer forma, é o servidor que deve fazer
   * isso, mais rápido e sem perder a pergunta.
   *
   * O backoff é exponencial com jitter: várias abas falhando ao mesmo tempo não
   * devem voltar todas juntas no mesmo instante e derrubar de novo.
   */
  private async callModel(
    contents: Content[],
    config: GenerateContentConfig,
  ): Promise<GenerateContentResponse> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'O assistente financeiro não está configurado neste servidor.',
      );
    }

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.client.models.generateContent({
          model: this.model,
          contents,
          config,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        if (attempt < MAX_RETRIES && this.isRetryable(error)) {
          const backoff =
            RETRY_BASE_DELAY_MS * 2 ** attempt * (1 + Math.random());

          this.logger.warn(
            `Gemini falhou (${reason}); tentando de novo em ${Math.round(backoff)}ms (${attempt + 1}/${MAX_RETRIES}).`,
          );

          await this.sleep(backoff);
          continue;
        }

        // O detalhe fica no log do servidor; o cliente recebe só o que pode agir.
        this.logger.error(`Falha ao chamar o Gemini: ${reason}`);

        throw new ServiceUnavailableException(
          'Não consegui falar com o assistente agora. Tente de novo em instantes.',
        );
      }
    }
  }

  /**
   * Gera a resposta, retomando de onde parou enquanto o modelo bater no teto.
   *
   * Os pedaços são emendados sem `trim` no meio: o espaço que existia no ponto
   * de corte é parte do texto, e apará-lo grudaria a última palavra de um pedaço
   * na primeira do seguinte.
   */
  async generate(params: {
    systemInstruction: string;
    contents: Content[];
  }): Promise<GeminiResult> {
    const config = this.buildConfig(params.systemInstruction);
    const contents = [...params.contents];

    let answer = '';
    let continuations = 0;

    for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
      const response = await this.callModel(contents, config);
      const chunk = response.text ?? '';
      const finishReason = response.candidates?.[0]?.finishReason;
      const hitCeiling = finishReason === FinishReason.MAX_TOKENS;

      if (!chunk) {
        // Na primeira chamada, nada a entregar: o motivo vira mensagem.
        if (attempt === 0) this.failEmpty(response, finishReason, hitCeiling);

        // Numa retomada, o que já veio vale mais do que um erro.
        this.logger.warn(
          'Retomada voltou vazia; devolvendo a resposta parcial acumulada.',
        );
        return { text: answer.trim(), truncated: true, continuations };
      }

      answer += chunk;

      if (!hitCeiling)
        return { text: answer.trim(), truncated: false, continuations };

      if (attempt === MAX_CONTINUATIONS) break;

      continuations++;
      this.logger.log(
        `Resposta atingiu o teto de tokens; pedindo continuação ${continuations}/${MAX_CONTINUATIONS}.`,
      );

      contents.push({ role: 'model', parts: [{ text: chunk }] });
      contents.push({ role: 'user', parts: [{ text: CONTINUE_PROMPT }] });
    }

    this.logger.warn(
      `Resposta ainda truncada após ${MAX_CONTINUATIONS} retomadas.`,
    );

    return { text: answer.trim(), truncated: true, continuations };
  }

  /** Resposta vazia na primeira tentativa — cada causa pede uma orientação. */
  private failEmpty(
    response: GenerateContentResponse,
    finishReason: FinishReason | undefined,
    hitCeiling: boolean,
  ): never {
    const blockReason = response.promptFeedback?.blockReason;

    this.logger.warn(
      `Resposta vazia do Gemini (finishReason=${finishReason ?? 'n/d'}, blockReason=${blockReason ?? 'n/d'}).`,
    );

    if (hitCeiling) {
      throw new ServiceUnavailableException(
        'O modelo gastou todo o limite de tokens antes de escrever a resposta. Tente uma pergunta mais específica.',
      );
    }

    throw new ServiceUnavailableException(
      'Não consegui gerar uma resposta para essa mensagem. Tente reformular a pergunta.',
    );
  }
}
