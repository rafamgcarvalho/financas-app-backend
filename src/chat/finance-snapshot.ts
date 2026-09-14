import { Anonymizer } from './sanitize';
import { categoryLabel } from './category-labels';

/**
 * Montagem da foto financeira que vai no prompt.
 *
 * Este arquivo é puro de propósito: recebe linhas e devolve o objeto pronto,
 * sem tocar no banco. Números que viram conselho sobre o dinheiro de alguém
 * precisam ser testáveis sem subir Postgres.
 *
 * As chaves estão em português porque a conversa é em português — o modelo lê
 * "despesaMensalMedia" e responde sem traduzir, o que é uma tradução a menos
 * onde um erro sairia caro.
 */

export type TransactionRow = {
  id: string;
  userId: string;
  title: string;
  amount: string;
  description: string | null;
  date: Date;
  category: string;
  type: string;
  isRecurring: boolean | null;
  installments: number | null;
  installmentNumber: number | null;
  groupId: string | null;
  goalId: string | null;
};

export type GoalRow = {
  id: string;
  title: string;
  description: string | null;
  targetValue: string;
  currentValue: string | null;
  monthlyPlan: string | null;
  startDate: Date;
  targetDate: Date | null;
  type: string;
  status: string;
  priority: string;
  isOwner: boolean;
  memberIds: string[];
};

/** Janela usada nas médias e no ritmo das metas — o hábito recente é o que projeta. */
export const AVERAGE_WINDOW_MONTHS = 6;
export const HISTORY_MONTHS = 12;

/** Tetos para o contexto não crescer sem limite em conta antiga. */
const MAX_EVENTUAL_INCOMES = 12;
const MAX_RECENT_CONTRIBUTIONS = 10;

const round2 = (value: number): number => Math.round(value * 100) / 100;

const toNumber = (value: string | number | null | undefined): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Índice absoluto do mês (ano * 12 + mês), para subtrair meses sem dor. */
export const monthIndex = (date: Date): number =>
  date.getUTCFullYear() * 12 + date.getUTCMonth();

/** 2026-08 — ordenável, sem ambiguidade de formato entre pt-BR e en-US. */
export const monthLabel = (index: number): string => {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
};

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** Chave de agrupamento de parcelamentos e recorrências: o grupo, ou a própria linha. */
const groupKey = (row: TransactionRow): string => row.groupId ?? row.id;

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Mediana — resistente a um mês fora da curva, como na projeção do frontend. */
function median(values: number[]): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * A janela das médias exclui o mês corrente.
 *
 * O mês em curso está pela metade: incluí-lo faz a "despesa mensal média" cair
 * todo dia 2 e subir todo dia 30, e o conselho mudaria junto. Quando não há
 * nenhum mês fechado com dado, aí sim o mês corrente é tudo que existe.
 */
export function averageWindow(
  rows: TransactionRow[],
  now: Date,
): { start: number; end: number; months: number; excluiMesCorrente: boolean } {
  const current = monthIndex(now);

  const past = rows
    .map((row) => monthIndex(row.date))
    .filter((index) => index < current);

  if (past.length === 0) {
    return {
      start: current,
      end: current,
      months: 1,
      excluiMesCorrente: false,
    };
  }

  const firstIndex = Math.min(...past);
  const end = current - 1;
  const start = Math.max(firstIndex, end - (AVERAGE_WINDOW_MONTHS - 1));

  return { start, end, months: end - start + 1, excluiMesCorrente: true };
}

type MonthBucket = {
  receitas: number;
  despesas: number;
  investimentos: number;
};

function bucketByMonth(rows: TransactionRow[]): Map<number, MonthBucket> {
  const buckets = new Map<number, MonthBucket>();

  for (const row of rows) {
    const index = monthIndex(row.date);
    const bucket = buckets.get(index) ?? {
      receitas: 0,
      despesas: 0,
      investimentos: 0,
    };

    const amount = toNumber(row.amount);

    if (row.type === 'INCOME') bucket.receitas += amount;
    else if (row.type === 'EXPENSE') bucket.despesas += amount;
    else if (row.type === 'INVESTMENT') bucket.investimentos += amount;

    buckets.set(index, bucket);
  }

  return buckets;
}

export function buildMonthlyHistory(rows: TransactionRow[], now: Date) {
  const buckets = bucketByMonth(rows);
  const current = monthIndex(now);
  const history: {
    mes: string;
    receitas: number;
    despesas: number;
    investimentos: number;
    saldo: number;
    naoAlocado: number;
  }[] = [];

  for (let index = current - (HISTORY_MONTHS - 1); index <= current; index++) {
    const bucket = buckets.get(index) ?? {
      receitas: 0,
      despesas: 0,
      investimentos: 0,
    };

    const saldo = bucket.receitas - bucket.despesas;

    history.push({
      mes: monthLabel(index),
      receitas: round2(bucket.receitas),
      despesas: round2(bucket.despesas),
      investimentos: round2(bucket.investimentos),
      saldo: round2(saldo),
      naoAlocado: round2(saldo - bucket.investimentos),
    });
  }

  return history;
}

/**
 * Receitas e despesas que se repetem sozinhas.
 *
 * A recorrência é materializada como 12 lançamentos no momento da criação, então
 * "ativa" aqui quer dizer que ainda existe ocorrência daqui para a frente.
 */
export function buildRecurring(
  rows: TransactionRow[],
  type: 'INCOME' | 'EXPENSE',
  now: Date,
  anonymizer: Anonymizer,
) {
  const groups = new Map<string, TransactionRow[]>();

  for (const row of rows) {
    if (row.type !== type || !row.isRecurring) continue;

    const key = groupKey(row);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  return [...groups.values()]
    .map((group) => {
      const sorted = [...group].sort(
        (a, b) => a.date.getTime() - b.date.getTime(),
      );
      const last = sorted[sorted.length - 1];
      const future = sorted.filter((row) => row.date > now);

      return {
        descricao: anonymizer.text(sorted[0].title) ?? 'Sem título',
        categoria: categoryLabel(sorted[0].category),
        valorMensal: round2(toNumber(sorted[0].amount)),
        primeiraOcorrencia: isoDay(sorted[0].date),
        ultimaOcorrenciaRegistrada: isoDay(last.date),
        ocorrenciasFuturasRegistradas: future.length,
        ativa: future.length > 0,
      };
    })
    .sort((a, b) => b.valorMensal - a.valorMensal);
}

/** Receitas pontuais recentes — o que a recorrência não explica. */
export function buildOneOffIncomes(
  rows: TransactionRow[],
  now: Date,
  anonymizer: Anonymizer,
) {
  const window = averageWindow(rows, now);

  return rows
    .filter(
      (row) =>
        row.type === 'INCOME' &&
        !row.isRecurring &&
        monthIndex(row.date) >= window.start &&
        row.date <= now,
    )
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, MAX_EVENTUAL_INCOMES)
    .map((row) => ({
      descricao: anonymizer.text(row.title) ?? 'Sem título',
      categoria: categoryLabel(row.category),
      valor: round2(toNumber(row.amount)),
      data: isoDay(row.date),
    }));
}

/**
 * Parcelamentos em aberto.
 *
 * Contamos as linhas que existem, e não o campo `installments`: parcela apagada
 * é parcela que não será paga, e prometer ao modelo um saldo devedor que o
 * usuário já eliminou seria pior do que não informar nada.
 */
export function buildInstallments(
  rows: TransactionRow[],
  now: Date,
  anonymizer: Anonymizer,
) {
  const groups = new Map<string, TransactionRow[]>();

  for (const row of rows) {
    if (row.isRecurring || !row.groupId) continue;
    if ((row.installments ?? 1) <= 1) continue;

    const list = groups.get(row.groupId);
    if (list) list.push(row);
    else groups.set(row.groupId, [row]);
  }

  return [...groups.values()]
    .map((group) => {
      const sorted = [...group].sort(
        (a, b) => a.date.getTime() - b.date.getTime(),
      );
      const pending = sorted.filter((row) => row.date > now);
      const valorParcela = round2(toNumber(sorted[0].amount));

      return {
        descricao: anonymizer.text(sorted[0].title) ?? 'Sem título',
        categoria: categoryLabel(sorted[0].category),
        tipo: sorted[0].type,
        valorParcela,
        parcelasRegistradas: sorted.length,
        parcelasPagas: sorted.length - pending.length,
        parcelasRestantes: pending.length,
        saldoDevedor: round2(valorParcela * pending.length),
        proximaParcela: pending.length ? isoDay(pending[0].date) : null,
        terminoPrevisto: isoDay(sorted[sorted.length - 1].date),
      };
    })
    .filter((item) => item.parcelasRestantes > 0)
    .sort((a, b) => b.saldoDevedor - a.saldoDevedor);
}

/** Média mensal por categoria na janela, com o realizado do mês corrente ao lado. */
export function buildCategoryBreakdown(
  rows: TransactionRow[],
  type: 'INCOME' | 'EXPENSE' | 'INVESTMENT',
  now: Date,
) {
  const window = averageWindow(rows, now);
  const current = monthIndex(now);

  const totals = new Map<string, { janela: number; mesCorrente: number }>();

  for (const row of rows) {
    if (row.type !== type) continue;

    const index = monthIndex(row.date);
    const inWindow = index >= window.start && index <= window.end;
    const inCurrent = index === current;

    if (!inWindow && !inCurrent) continue;

    const entry = totals.get(row.category) ?? { janela: 0, mesCorrente: 0 };
    const amount = toNumber(row.amount);

    if (inWindow) entry.janela += amount;
    if (inCurrent) entry.mesCorrente += amount;

    totals.set(row.category, entry);
  }

  return [...totals.entries()]
    .map(([category, entry]) => ({
      categoria: categoryLabel(category),
      mediaMensal: round2(entry.janela / window.months),
      mesCorrente: round2(entry.mesCorrente),
    }))
    .sort((a, b) => b.mediaMensal - a.mediaMensal);
}

/** Últimos aportes, para o modelo enxergar o hábito e não só o acumulado. */
export function buildRecentContributions(
  rows: TransactionRow[],
  now: Date,
  anonymizer: Anonymizer,
) {
  return rows
    .filter((row) => row.type === 'INVESTMENT' && row.date <= now)
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, MAX_RECENT_CONTRIBUTIONS)
    .map((row) => ({
      descricao: anonymizer.text(row.title) ?? 'Aporte',
      categoria: categoryLabel(row.category),
      valor: round2(toNumber(row.amount)),
      data: isoDay(row.date),
      vinculadoAMeta: Boolean(row.goalId),
    }));
}

/**
 * Ritmo observado de uma meta.
 *
 * Mesma regra da projeção da tela de metas (`src/lib/goalProjection.ts` no
 * frontend): mediana dos aportes por mês numa janela que nunca começa antes do
 * primeiro aporte, com mês sem aporte entrando como zero. Divergir daqui faria o
 * assistente contradizer o gráfico que o usuário tem na frente.
 */
export function observedGoalPace(
  contributions: { date: Date; amount: string }[],
  now: Date,
): { ritmo: number; janelaMeses: number } {
  const current = monthIndex(now);
  const months = contributions.map((item) => monthIndex(item.date));

  if (months.length === 0) return { ritmo: 0, janelaMeses: 0 };

  const windowStart = Math.max(
    Math.min(...months),
    current - (AVERAGE_WINDOW_MONTHS - 1),
  );
  const windowMonths = Math.max(current - windowStart + 1, 1);
  const perMonth = new Array<number>(windowMonths).fill(0);

  for (const item of contributions) {
    const index = monthIndex(item.date);
    if (index >= windowStart && index <= current) {
      perMonth[index - windowStart] += toNumber(item.amount);
    }
  }

  return { ritmo: round2(median(perMonth)), janelaMeses: windowMonths };
}

export function buildGoals(
  goalRows: GoalRow[],
  contributionsByGoal: Map<string, { date: Date; amount: string }[]>,
  now: Date,
  anonymizer: Anonymizer,
) {
  const current = monthIndex(now);

  return goalRows.map((goal) => {
    const target = toNumber(goal.targetValue);
    const accumulated = toNumber(goal.currentValue);
    const remaining = Math.max(target - accumulated, 0);

    const plan = toNumber(goal.monthlyPlan) || null;
    const { ritmo, janelaMeses } = observedGoalPace(
      contributionsByGoal.get(goal.id) ?? [],
      now,
    );

    const pace = plan ?? ritmo;
    const monthsToFinish = pace > 0 ? Math.ceil(remaining / pace) : null;

    const targetIndex = goal.targetDate ? monthIndex(goal.targetDate) : null;
    const monthsToTarget = targetIndex === null ? null : targetIndex - current;

    const requiredMonthly =
      monthsToTarget === null
        ? null
        : monthsToTarget > 0
          ? round2(remaining / monthsToTarget)
          : round2(remaining);

    return {
      titulo: anonymizer.text(goal.title) ?? 'Meta sem título',
      descricao: anonymizer.text(goal.description),
      status: goal.status,
      prioridade: goal.priority,
      horizonte: goal.type,
      valorAlvo: round2(target),
      valorAcumulado: round2(accumulated),
      valorRestante: round2(remaining),
      percentualConcluido:
        target > 0 ? round2((accumulated / target) * 100) : 0,
      aportePlanejadoMensal: plan === null ? null : round2(plan),
      ritmoObservadoMensal: ritmo,
      janelaRitmoMeses: janelaMeses,
      // O plano declarado tem precedência: é ele que estabiliza a projeção.
      baseDaProjecao: plan ? 'plano declarado' : 'ritmo observado',
      mesesParaConcluirNoRitmo: monthsToFinish,
      dataInicio: isoDay(goal.startDate),
      dataAlvo: goal.targetDate ? isoDay(goal.targetDate) : null,
      mesesAteAlvo: monthsToTarget,
      aporteMensalNecessarioParaAlvo: requiredMonthly,
      compartilhada: goal.memberIds.length > 1,
      participantes: goal.memberIds.map((id) => anonymizer.person(id)),
      usuarioEDono: goal.isOwner,
    };
  });
}

/**
 * O que este contexto não sabe.
 *
 * Vai junto com os dados de propósito: a regra "nunca invente" só é aplicável se
 * o modelo souber onde estão as bordas. Sem esta lista ele preenche a lacuna com
 * o que costuma existir num app de finanças — fatura, rendimento, corretora — e
 * responde com convicção sobre algo que não existe aqui.
 */
export const CONTEXT_LIMITATIONS = [
  'O sistema não modela cartões de crédito, faturas nem contas bancárias. Compras parceladas existem apenas como parcelas individuais em despesas.parcelamentosEmAberto.',
  'Investimentos são registrados como aportes (dinheiro guardado). Não há cotação, rentabilidade, tipo de ativo (renda fixa, ações, FIIs, cripto) nem saldo de corretora. Só projete rendimento se o usuário informar a taxa na pergunta, deixando a premissa explícita.',
  'Nomes de instituições financeiras foram substituídos por apelidos genéricos ("Instituição A"). O apelido é estável dentro desta conversa, mas você não sabe qual é o banco real.',
  'saldoAcumulado é receitas menos despesas em todo o histórico e JÁ INCLUI o dinheiro aportado. Para saber o que ainda não foi guardado, use naoAlocado (saldoAcumulado menos totalInvestido). Nunca some saldoAcumulado com totalInvestido.',
  'Uma recorrência é gravada como 12 ocorrências a partir da data de criação. Quando ocorrenciasFuturasRegistradas chega a zero, a despesa pode continuar existindo na vida real sem aparecer aqui.',
  'Orçamentos por categoria e categorias personalizadas ficam no navegador do usuário e não estão neste contexto.',
  'Metas compartilhadas somam os aportes de todos os participantes em valorAcumulado.',
];

export type FinanceSnapshot = ReturnType<typeof buildSnapshot>;

export function buildSnapshot(input: {
  rows: TransactionRow[];
  lifetimeTotals: { receitas: number; despesas: number; investimentos: number };
  goalRows: GoalRow[];
  contributionsByGoal: Map<string, { date: Date; amount: string }[]>;
  now: Date;
  anonymizer: Anonymizer;
}) {
  const {
    rows,
    lifetimeTotals,
    goalRows,
    contributionsByGoal,
    now,
    anonymizer,
  } = input;

  const window = averageWindow(rows, now);
  const buckets = bucketByMonth(rows);
  const current = monthIndex(now);

  const windowMonths: MonthBucket[] = [];
  for (let index = window.start; index <= window.end; index++) {
    windowMonths.push(
      buckets.get(index) ?? { receitas: 0, despesas: 0, investimentos: 0 },
    );
  }

  const receitaMedia = mean(windowMonths.map((month) => month.receitas));
  const despesaMedia = mean(windowMonths.map((month) => month.despesas));
  const aporteMedio = mean(windowMonths.map((month) => month.investimentos));

  const currentBucket = buckets.get(current) ?? {
    receitas: 0,
    despesas: 0,
    investimentos: 0,
  };
  const currentSaldo = currentBucket.receitas - currentBucket.despesas;

  const saldoAcumulado = lifetimeTotals.receitas - lifetimeTotals.despesas;

  return {
    referencia: {
      hoje: isoDay(now),
      mesCorrente: monthLabel(current),
      moeda: 'BRL',
      janelaDasMedias: `${monthLabel(window.start)} a ${monthLabel(window.end)}`,
      janelaDasMediasMeses: window.months,
      mediasExcluemMesCorrente: window.excluiMesCorrente,
    },

    resumoGeral: {
      saldoAcumulado: round2(saldoAcumulado),
      totalInvestido: round2(lifetimeTotals.investimentos),
      naoAlocado: round2(saldoAcumulado - lifetimeTotals.investimentos),
      receitaMensalMedia: round2(receitaMedia),
      despesaMensalMedia: round2(despesaMedia),
      aporteMensalMedio: round2(aporteMedio),
      sobraMensalMedia: round2(receitaMedia - despesaMedia),
      taxaPoupanca:
        receitaMedia > 0 ? round2((aporteMedio / receitaMedia) * 100) : null,
    },

    mesCorrente: {
      mes: monthLabel(current),
      receitas: round2(currentBucket.receitas),
      despesas: round2(currentBucket.despesas),
      investimentos: round2(currentBucket.investimentos),
      saldo: round2(currentSaldo),
      naoAlocado: round2(currentSaldo - currentBucket.investimentos),
      observacao:
        'Mês em andamento: os totais ainda vão mudar até o fim do período.',
    },

    historicoMensal: buildMonthlyHistory(rows, now),

    receitas: {
      recorrentes: buildRecurring(rows, 'INCOME', now, anonymizer),
      eventuaisRecentes: buildOneOffIncomes(rows, now, anonymizer),
      mediaMensalPorCategoria: buildCategoryBreakdown(rows, 'INCOME', now),
    },

    despesas: {
      fixasRecorrentes: buildRecurring(rows, 'EXPENSE', now, anonymizer),
      mediaMensalPorCategoria: buildCategoryBreakdown(rows, 'EXPENSE', now),
      parcelamentosEmAberto: buildInstallments(rows, now, anonymizer),
    },

    investimentos: {
      totalAportado: round2(lifetimeTotals.investimentos),
      aporteMensalMedio: round2(aporteMedio),
      mediaMensalPorCategoria: buildCategoryBreakdown(rows, 'INVESTMENT', now),
      aportesRecentes: buildRecentContributions(rows, now, anonymizer),
    },

    metas: buildGoals(goalRows, contributionsByGoal, now, anonymizer),

    limitacoesDoContexto: CONTEXT_LIMITATIONS,
  };
}
