/**
 * As regras financeiras do sistema, em um lugar só.
 *
 * Este arquivo é puro de propósito: recebe linhas e devolve números, sem tocar
 * no banco. Antes a mesma conta de saldo existia copiada em três lugares (o
 * endpoint de balanço, o dashboard e o contexto do assistente) e divergir era
 * questão de tempo. Agora o backend calcula num lugar e os outros consomem.
 *
 * O modelo tem dois eixos que é fácil confundir:
 *
 *   FLUXO   — quanto dinheiro se moveu num período.
 *   POSIÇÃO — quanto se tem acumulado até um instante.
 *
 * Aporte e resgate aparecem no fluxo (movem caixa) mas não mudam o patrimônio:
 * apenas transferem valor entre "caixa" e "investido". Despesa destrói
 * patrimônio, receita cria. É essa distinção que o resto do app depende daqui.
 */

export type FinanceType = 'INCOME' | 'EXPENSE' | 'INVESTMENT' | 'WITHDRAWAL';

export const FINANCE_TYPES: FinanceType[] = [
  'INCOME',
  'EXPENSE',
  'INVESTMENT',
  'WITHDRAWAL',
];

/**
 * Efeito de cada tipo sobre o dinheiro disponível em caixa.
 *
 * O aporte vale -1 justamente porque investir tira dinheiro do bolso — é o
 * ponto que o sistema errava: tratava investimento como algo fora do caixa.
 */
export const CASH_EFFECT: Record<FinanceType, -1 | 0 | 1> = {
  INCOME: 1,
  EXPENSE: -1,
  INVESTMENT: -1,
  WITHDRAWAL: 1,
};

/** Efeito de cada tipo sobre o valor que continua investido. */
export const INVESTED_EFFECT: Record<FinanceType, -1 | 0 | 1> = {
  INCOME: 0,
  EXPENSE: 0,
  INVESTMENT: 1,
  WITHDRAWAL: -1,
};

/**
 * Efeito de cada tipo sobre o patrimônio.
 *
 * Aporte e resgate valem 0: o dinheiro muda de lugar, não de dono. É o que
 * impede o patrimônio de subir sozinho a cada vez que alguém guarda dinheiro.
 */
export const NET_WORTH_EFFECT: Record<FinanceType, -1 | 0 | 1> = {
  INCOME: 1,
  EXPENSE: -1,
  INVESTMENT: 0,
  WITHDRAWAL: 0,
};

/** Totais brutos por tipo — nada foi compensado ainda. */
export type TypeTotals = {
  income: number;
  expense: number;
  /** Aportes do período. Histórico, não líquido. */
  contributions: number;
  /** Resgates do período. Histórico, não líquido. */
  withdrawals: number;
};

export type CashFlow = TypeTotals & {
  /**
   * Variação do caixa: receitas − despesas − aportes + resgates.
   *
   * Num período, é quanto o dinheiro disponível subiu ou desceu. Acumulado
   * desde o início, é o próprio caixa disponível.
   */
  net: number;
  /** Receitas menos despesas: o que o período de fato produziu. */
  result: number;
};

export type Position = {
  /** Dinheiro disponível para gastar. */
  cash: number;
  /** Quanto continua investido: aportes menos resgates. */
  invested: number;
  /**
   * Bens fora do caixa e dos investimentos (carro, imóvel).
   *
   * Ainda não há cadastro de ativos — entra como zero e já soma no patrimônio,
   * para que criar a tabela depois não exija mexer em quem lê este número.
   */
  otherAssets: number;
  /** Caixa + investido + outros ativos. */
  netWorth: number;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

const toNumber = (value: string | number | null | undefined): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function emptyTotals(): TypeTotals {
  return { income: 0, expense: 0, contributions: 0, withdrawals: 0 };
}

/** Aceita "investment", "INVESTMENT"... e devolve undefined fora do enum. */
export function normalizeFinanceType(
  type?: string | null,
): FinanceType | undefined {
  if (!type) return undefined;

  const upper = type.toUpperCase() as FinanceType;
  return FINANCE_TYPES.includes(upper) ? upper : undefined;
}

/** Soma as linhas em totais por tipo. Linha de tipo desconhecido é ignorada. */
export function sumByType(
  rows: { type: string; amount: string | number }[],
): TypeTotals {
  const totals = emptyTotals();

  for (const row of rows) {
    const amount = toNumber(row.amount);

    switch (normalizeFinanceType(row.type)) {
      case 'INCOME':
        totals.income += amount;
        break;
      case 'EXPENSE':
        totals.expense += amount;
        break;
      case 'INVESTMENT':
        totals.contributions += amount;
        break;
      case 'WITHDRAWAL':
        totals.withdrawals += amount;
        break;
    }
  }

  return totals;
}

export function cashFlowOf(totals: TypeTotals): CashFlow {
  return {
    income: round2(totals.income),
    expense: round2(totals.expense),
    contributions: round2(totals.contributions),
    withdrawals: round2(totals.withdrawals),
    net: round2(
      totals.income -
        totals.expense -
        totals.contributions +
        totals.withdrawals,
    ),
    result: round2(totals.income - totals.expense),
  };
}

/**
 * Posição acumulada a partir dos totais de *todo* o histórico considerado.
 *
 * Passar aqui os totais de um mês devolveria a variação daquele mês, não a
 * posição — quem chama precisa somar desde o início.
 */
export function positionOf(totals: TypeTotals, otherAssets = 0): Position {
  const cash =
    totals.income - totals.expense - totals.contributions + totals.withdrawals;
  const invested = totals.contributions - totals.withdrawals;

  return {
    cash: round2(cash),
    invested: round2(invested),
    otherAssets: round2(otherAssets),
    netWorth: round2(cash + invested + otherAssets),
  };
}

/**
 * Valor atual de uma meta: aportes menos resgates vinculados a ela.
 *
 * O total aportado continua disponível em `contributions` — um resgate move o
 * saldo, não apaga o histórico de que o aporte existiu.
 */
export function goalValueOf(totals: TypeTotals): number {
  return round2(totals.contributions - totals.withdrawals);
}

/**
 * Quanto um lançamento move o saldo da meta.
 *
 * Aporte soma, resgate subtrai, qualquer outro tipo é neutro — é a mesma regra
 * que `goalValueOf` aplica em lote, útil quando a conta é feita linha a linha
 * (gráfico de evolução, ritmo observado).
 */
export function signedGoalAmount(row: {
  type: string;
  amount: string | number;
}): number {
  const type = normalizeFinanceType(row.type);
  if (!type) return 0;

  return toNumber(row.amount) * INVESTED_EFFECT[type];
}

/** Quanto da renda virou aporte, de 0 a 1. Null quando não houve renda. */
export function savingsRateOf(totals: TypeTotals): number | null {
  if (totals.income <= 0) return null;
  return totals.contributions / totals.income;
}
