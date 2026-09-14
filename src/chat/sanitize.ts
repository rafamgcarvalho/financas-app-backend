/**
 * Higienização do que sai daqui para o Gemini.
 *
 * O modelo é um serviço de terceiros: o contexto precisa ser suficiente para
 * raciocinar sobre dinheiro e insuficiente para identificar a pessoa. Valores,
 * datas, categorias, prazos e status passam; nome, documento, contato e o nome
 * real da instituição financeira, não.
 *
 * O apelido é estável dentro de uma requisição — "Instituição A" é sempre o
 * mesmo banco na mesma conversa —, porque sem isso o modelo não consegue
 * agrupar as despesas do mesmo cartão para responder sobre elas.
 */

/** Ordem importa: CNPJ tem 14 dígitos e casaria como CPF + resto se viesse depois. */
const REDACTIONS: { pattern: RegExp; replacement: string }[] = [
  { pattern: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, replacement: '[e-mail]' },
  {
    pattern: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g,
    replacement: '[documento]',
  },
  { pattern: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, replacement: '[documento]' },
  {
    pattern: /(?:\+55\s?)?\(?\b\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g,
    replacement: '[telefone]',
  },
  // Cartão, agência/conta, chave numérica: qualquer sequência longa de dígitos.
  { pattern: /\b(?:\d[ .-]?){12,19}\b/g, replacement: '[número]' },
  { pattern: /\b\d{6,}\b/g, replacement: '[número]' },
];

/**
 * Instituições financeiras conhecidas, como fontes de regex para cobrir as
 * grafias com e sem acento. A lista é deliberadamente ampla: trocar um nome a
 * mais por "Instituição A" custa pouco; deixar um a menos vazar custa caro.
 */
const INSTITUTION_PATTERNS = [
  'nu\\s?bank',
  'nu\\s?conta',
  'nu\\s?invest',
  'ita[uú](?:\\s?unibanco)?',
  'itaucard',
  'bradesco',
  'next',
  'santander',
  'banco\\s+do\\s+brasil',
  'caixa(?:\\s+econ[oô]mica(?:\\s+federal)?)?',
  'banco\\s+inter',
  'c6\\s?bank',
  'picpay',
  'mercado\\s?pago',
  'pagbank',
  'pagseguro',
  'will\\s?bank',
  'neon',
  'banco\\s+original',
  'safra',
  'sicoob',
  'sicredi',
  'banrisul',
  'unicred',
  'daycoval',
  'sofisa',
  'btg(?:\\s?pactual)?',
  'xp(?:\\s?investimentos)?',
  'rico(?:\\s?investimentos)?',
  'clear(?:\\s?corretora)?',
  'modalmais',
  'avenue',
  'nomad',
  'wise',
  'binance',
  'coinbase',
  'mercado\\s?bitcoin',
  'bitso',
  'foxbit',
  'visa',
  'master\\s?card',
  'american\\s+express',
  'amex',
  'hipercard',
  'elo',
];

/**
 * As bordas são `(?<!\w)`/`(?!\w)` e não `\b` porque `\b` não enxerga acento:
 * em "Itaú" o `ú` não é caractere de palavra, então não há fronteira depois dele
 * e o nome passava batido — justamente nas grafias mais comuns.
 */
const INSTITUTION_REGEX = new RegExp(
  `(?<!\\w)(?:${INSTITUTION_PATTERNS.join('|')})(?!\\w)`,
  'gi',
);

/** A, B, ... Z, AA, AB... — para nunca faltar apelido. */
function aliasLetter(index: number): string {
  let letters = '';
  let remaining = index;

  do {
    letters = String.fromCharCode(65 + (remaining % 26)) + letters;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);

  return letters;
}

/** Divide o nome em termos buscáveis, ignorando partículas ("de", "da", "dos"). */
function nameTerms(value?: string | null): string[] {
  if (!value) return [];

  return value
    .split(/[\s@._-]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Anonimizador de uma requisição.
 *
 * Vive por requisição, e não como singleton, para que os apelidos não vazem
 * entre usuários: "Instituição A" de uma conversa não tem nada a ver com a de
 * outra.
 */
export class Anonymizer {
  private readonly institutions = new Map<string, string>();
  private readonly people = new Map<string, string>();
  private readonly ownerRegex: RegExp | null;

  constructor(owner?: { name?: string | null; username?: string | null }) {
    const terms = [
      ...nameTerms(owner?.name),
      ...nameTerms(owner?.username),
    ].map(escapeRegex);

    // Mesma razão das instituições: "José" termina em caractere não-palavra e
    // `\b` deixaria passar exatamente os nomes acentuados.
    this.ownerRegex = terms.length
      ? new RegExp(`(?<!\\w)(?:${terms.join('|')})(?!\\w)`, 'gi')
      : null;
  }

  /**
   * Apelido estável para um participante de meta compartilhada.
   * O `userId` é a chave, mas nunca sai daqui — só o apelido.
   */
  person(userId: string): string {
    const existing = this.people.get(userId);
    if (existing) return existing;

    const alias = `Participante ${this.people.size + 1}`;
    this.people.set(userId, alias);

    return alias;
  }

  /** Texto livre digitado pelo usuário (título, descrição, nome de meta). */
  text(value?: string | null): string | undefined {
    if (!value) return undefined;

    let output = value;

    output = output.replace(INSTITUTION_REGEX, (match) =>
      this.institution(match),
    );

    if (this.ownerRegex) {
      output = output.replace(this.ownerRegex, 'o usuário');
    }

    for (const { pattern, replacement } of REDACTIONS) {
      output = output.replace(pattern, replacement);
    }

    // Espaços que sobraram das substituições não devem virar ruído no prompt.
    const cleaned = output.replace(/\s{2,}/g, ' ').trim();

    return cleaned || undefined;
  }

  private institution(match: string): string {
    const key = match.toLowerCase().replace(/\s+/g, ' ');
    const existing = this.institutions.get(key);
    if (existing) return existing;

    const alias = `Instituição ${aliasLetter(this.institutions.size)}`;
    this.institutions.set(key, alias);

    return alias;
  }
}

/**
 * Limpeza da mensagem digitada no chat.
 *
 * Caracteres de controle são removidos porque só servem para quebrar o
 * delimitador do prompt — um byte nulo no meio do texto não é digitação, é
 * tentativa de confundir o parser do outro lado.
 */
export function sanitizeUserMessage(message: string): string {
  return (
    message
      // A regra `no-control-regex` protege contra control char acidental numa
      // expressão; aqui eles são exatamente o alvo. \n, \r e \t ficam de fora
      // do intervalo de propósito — quebra de linha é digitação legítima.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * Marcadores explícitos de tentativa de burlar as regras do sistema.
 *
 * Não bloqueiam a mensagem: "ignore" e "esqueça" aparecem em perguntas legítimas
 * ("ignore os aportes de dezembro no cálculo"), e recusar a pergunta certa é um
 * erro pior do que responder a errada. O que a detecção faz é reforçar as regras
 * no turno — ver `buildUserTurn`.
 */
const INJECTION_MARKERS: RegExp[] = [
  /ignore\s+(?:todas\s+)?(?:as\s+)?(?:suas\s+)?(?:instru[cç][oõ]es|regras)/i,
  /esque[cç]a\s+(?:tudo|todas\s+as\s+(?:instru[cç][oõ]es|regras))/i,
  /(?:revele|mostre|repita|imprima)\s+(?:o\s+)?(?:seu\s+)?(?:system\s*prompt|prompt\s+(?:inicial|de\s+sistema)|instru[cç][oõ]es\s+(?:internas|do\s+sistema))/i,
  /\b(?:system\s*prompt|developer\s+mode|jailbreak|dan\s+mode)\b/i,
  /(?:a\s?partir\s+de\s+agora|de\s+agora\s+em\s+diante)[^.]{0,40}\bvoc[eê]\s+[ée]\b/i,
  /finja\s+(?:que\s+)?(?:voc[eê]\s+[ée]|ser)/i,
  /\b(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior)\s+instructions\b/i,
];

export function looksLikeInjection(message: string): boolean {
  return INJECTION_MARKERS.some((marker) => marker.test(message));
}
