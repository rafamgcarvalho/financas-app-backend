import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { FinishReason, type GenerateContentResponse } from '@google/genai';
import { GeminiService } from './gemini.service';

/**
 * Retomada automática da geração.
 *
 * É a parte que garante que ninguém precise digitar "continue": se o modelo
 * parar no teto de tokens, o serviço pede o resto e emenda. A emenda é literal,
 * então o teste vigia o caractere do ponto de corte tanto quanto a lógica.
 */

type FakeClient = {
  models: { generateContent: jest.Mock<Promise<GenerateContentResponse>, []> };
};

/** Resposta do SDK reduzida ao que o serviço lê. */
function reply(text: string, finishReason = FinishReason.STOP) {
  return {
    text,
    candidates: [{ finishReason }],
    promptFeedback: undefined,
    usageMetadata: {},
  } as unknown as GenerateContentResponse;
}

function setup(replies: GenerateContentResponse[]) {
  const generateContent = jest.fn<Promise<GenerateContentResponse>, []>();
  replies.forEach((response) =>
    generateContent.mockResolvedValueOnce(response),
  );

  const service = new GeminiService();
  const client: FakeClient = { models: { generateContent } };
  (service as unknown as { client: FakeClient }).client = client;

  return { service, generateContent };
}

const ask = (service: GeminiService) =>
  service.generate({
    systemInstruction: 'regras',
    contents: [{ role: 'user', parts: [{ text: 'pergunta' }] }],
  });

describe('GeminiService.generate', () => {
  // As retomadas registram aviso a cada corte; aqui isso é o esperado, e o log
  // só polui a saída do `npm test`.
  beforeAll(() => {
    Logger.overrideLogger(false);
  });
  afterAll(() => {
    Logger.overrideLogger(true);
  });

  it('devolve a resposta inteira quando ela cabe de uma vez', async () => {
    const { service, generateContent } = setup([reply('Sobram R$ 800.')]);

    await expect(ask(service)).resolves.toEqual({
      text: 'Sobram R$ 800.',
      truncated: false,
      continuations: 0,
    });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('pede a continuação e emenda sem inserir caractere no corte', async () => {
    const { service, generateContent } = setup([
      reply('Faltam 10 parcelas de R$ ', FinishReason.MAX_TOKENS),
      reply('566,46 para quitar.'),
    ]);

    const result = await ask(service);

    expect(result.text).toBe('Faltam 10 parcelas de R$ 566,46 para quitar.');
    expect(result.truncated).toBe(false);
    expect(result.continuations).toBe(1);
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it('emenda corte no meio da palavra', async () => {
    const { service } = setup([
      reply('O parcelamento termina em ju', FinishReason.MAX_TOKENS),
      reply('nho de 2027.'),
    ]);

    await expect(ask(service)).resolves.toMatchObject({
      text: 'O parcelamento termina em junho de 2027.',
    });
  });

  it('encadeia várias retomadas', async () => {
    const { service, generateContent } = setup([
      reply('um ', FinishReason.MAX_TOKENS),
      reply('dois ', FinishReason.MAX_TOKENS),
      reply('três'),
    ]);

    const result = await ask(service);

    expect(result.text).toBe('um dois três');
    expect(result.continuations).toBe(2);
    expect(generateContent).toHaveBeenCalledTimes(3);
  });

  it('para no teto de retomadas e avisa em vez de insistir', async () => {
    const truncatedReply = () => reply('mais ', FinishReason.MAX_TOKENS);
    const { service, generateContent } = setup([
      truncatedReply(),
      truncatedReply(),
      truncatedReply(),
      truncatedReply(),
    ]);

    const result = await ask(service);

    // Quatro gerações: a original e as três retomadas.
    expect(generateContent).toHaveBeenCalledTimes(4);
    expect(result.truncated).toBe(true);
    expect(result.continuations).toBe(3);
    expect(result.text).toBe('mais mais mais mais');
  });

  it('entrega o parcial quando a retomada volta vazia', async () => {
    const { service } = setup([
      reply('Começo da resposta', FinishReason.MAX_TOKENS),
      reply(''),
    ]);

    await expect(ask(service)).resolves.toEqual({
      text: 'Começo da resposta',
      truncated: true,
      continuations: 1,
    });
  });

  it('reenvia o texto parcial como turno do modelo ao pedir o resto', async () => {
    const { service, generateContent } = setup([
      reply('parcial', FinishReason.MAX_TOKENS),
      reply(' e fim'),
    ]);

    await ask(service);

    const secondCall = generateContent.mock.calls[1] as unknown as [
      { contents: { role: string; parts: { text: string }[] }[] },
    ];
    const { contents } = secondCall[0];

    expect(contents).toHaveLength(3);
    expect(contents[1]).toMatchObject({ role: 'model' });
    expect(contents[1].parts[0].text).toBe('parcial');
    expect(contents[2].role).toBe('user');
    expect(contents[2].parts[0].text).toContain('Continue EXATAMENTE');
  });

  it('falha com mensagem útil quando a primeira chamada vem vazia', async () => {
    const { service } = setup([reply('')]);

    await expect(ask(service)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('recusa quando o assistente não está configurado', async () => {
    const service = new GeminiService();

    await expect(ask(service)).rejects.toThrow(
      'O assistente financeiro não está configurado neste servidor.',
    );
  });
});
