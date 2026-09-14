/**
 * Limite de mensagens por usuário.
 *
 * Cada pergunta custa uma chamada paga ao Gemini e uma varredura no banco. Sem
 * teto, uma aba deixada num laço consome a cota do plano inteiro — e a conta é
 * do dono do app, não de quem abriu a aba.
 *
 * A janela vive em memória: vale por instância. Com mais de um processo o
 * limite efetivo multiplica, e o lugar certo de resolver isso é um Redis
 * compartilhado. Enquanto o app roda num nó só, isto basta e não adiciona
 * infraestrutura.
 */

export type RateLimitVerdict = {
  allowed: boolean;
  /** Segundos até liberar a próxima mensagem. Só faz sentido quando bloqueado. */
  retryAfterSeconds: number;
};

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  check(key: string, now = Date.now()): RateLimitVerdict {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );

    if (recent.length >= this.limit) {
      this.hits.set(key, recent);

      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((recent[0] + this.windowMs - now) / 1000),
      };
    }

    recent.push(now);
    this.hits.set(key, recent);

    // Um usuário que parou de perguntar não deve continuar ocupando memória.
    if (this.hits.size > 1000) this.evictExpired(cutoff);

    return { allowed: true, retryAfterSeconds: 0 };
  }

  private evictExpired(cutoff: number): void {
    for (const [key, timestamps] of this.hits) {
      if (timestamps.every((timestamp) => timestamp <= cutoff)) {
        this.hits.delete(key);
      }
    }
  }
}
