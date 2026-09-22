import {
  cashFlowOf,
  goalValueOf,
  positionOf,
  savingsRateOf,
  signedGoalAmount,
  sumByType,
  type FinanceType,
} from './finance-math';

type Row = { type: FinanceType; amount: string };

const row = (type: FinanceType, amount: number): Row => ({
  type,
  amount: amount.toFixed(2),
});

const income = (amount: number) => row('INCOME', amount);
const expense = (amount: number) => row('EXPENSE', amount);
const contribution = (amount: number) => row('INVESTMENT', amount);
const withdrawal = (amount: number) => row('WITHDRAWAL', amount);

/** Caixa, investido e patrimônio a partir das linhas cruas. */
const positionFrom = (rows: Row[]) => positionOf(sumByType(rows));
const flowFrom = (rows: Row[]) => cashFlowOf(sumByType(rows));

/*
 * Os cenários abaixo são os critérios de aceitação da modelagem financeira.
 * Cada um é uma frase do modelo conceitual escrita como número: se algum deles
 * quebrar, é a regra de negócio que mudou, não o teste que ficou velho.
 */
describe('cenários de aceitação', () => {
  it('cenário 1 — só receita: tudo vira caixa', () => {
    const position = positionFrom([income(3000)]);

    expect(position.cash).toBe(3000);
    expect(position.invested).toBe(0);
    expect(position.netWorth).toBe(3000);
  });

  it('cenário 2 — despesa reduz caixa e patrimônio', () => {
    const position = positionFrom([income(3000), expense(1500)]);

    expect(position.cash).toBe(1500);
    expect(position.invested).toBe(0);
    expect(position.netWorth).toBe(1500);
  });

  it('cenário 3 — aporte reduz o caixa sem reduzir o patrimônio', () => {
    const rows = [income(3000), expense(1500), contribution(800)];

    const position = positionFrom(rows);

    expect(position.cash).toBe(700);
    expect(position.invested).toBe(800);
    // O dinheiro mudou de lugar, não sumiu: mesmo patrimônio do cenário 2.
    expect(position.netWorth).toBe(1500);

    // E o aporte continua fora das despesas.
    expect(flowFrom(rows).expense).toBe(1500);
  });

  it('cenário 4 — resgate devolve caixa sem virar receita', () => {
    const rows = [
      income(3000),
      expense(1500),
      contribution(800),
      withdrawal(300),
    ];

    const position = positionFrom(rows);

    expect(position.cash).toBe(1000);
    expect(position.invested).toBe(500);
    expect(position.netWorth).toBe(1500);

    // O resgate não engordou a receita nem a despesa do período.
    const flow = flowFrom(rows);
    expect(flow.income).toBe(3000);
    expect(flow.expense).toBe(1500);
    expect(flow.withdrawals).toBe(300);
  });

  it('cenário 5 — valor da meta é aporte menos resgate', () => {
    const totals = sumByType([
      contribution(1000),
      contribution(800),
      withdrawal(300),
    ]);

    expect(goalValueOf(totals)).toBe(1500);
    // 1500 de uma meta de 10.000 = 15%.
    expect((goalValueOf(totals) / 10000) * 100).toBe(15);
  });

  it('exemplo completo do modelo: aporte com meta, aporte solto e resgate', () => {
    const rows = [
      income(3000),
      expense(1500),
      contribution(800), // vinculado a uma meta
      contribution(200), // sem meta
      withdrawal(300),
    ];

    const flow = flowFrom(rows);
    expect(flow.income).toBe(3000);
    expect(flow.expense).toBe(1500);
    expect(flow.contributions).toBe(1000);
    expect(flow.withdrawals).toBe(300);
    expect(flow.net).toBe(800);

    const position = positionFrom(rows);
    expect(position.cash).toBe(800);
    expect(position.invested).toBe(700);
    expect(position.netWorth).toBe(1500);
  });
});

describe('fluxo de caixa', () => {
  it('separa o resultado do período da variação do caixa', () => {
    const flow = flowFrom([income(3000), expense(1500), contribution(800)]);

    // O mês produziu 1.500...
    expect(flow.result).toBe(1500);
    // ...mas só 700 sobraram disponíveis.
    expect(flow.net).toBe(700);
  });

  it('um período só de aportes tem resultado zero e caixa negativo', () => {
    const flow = flowFrom([contribution(500)]);

    expect(flow.result).toBe(0);
    expect(flow.net).toBe(-500);
  });

  it('resgate sozinho devolve caixa sem produzir resultado', () => {
    const flow = flowFrom([withdrawal(500)]);

    expect(flow.result).toBe(0);
    expect(flow.net).toBe(500);
  });
});

describe('patrimônio', () => {
  it('não se move quando o dinheiro só troca de lugar', () => {
    const before = positionFrom([income(1500)]);
    const afterContribution = positionFrom([income(1500), contribution(800)]);
    const afterWithdrawal = positionFrom([
      income(1500),
      contribution(800),
      withdrawal(800),
    ]);

    expect(before.netWorth).toBe(1500);
    expect(afterContribution.netWorth).toBe(1500);
    expect(afterWithdrawal.netWorth).toBe(1500);

    // O que muda é onde o dinheiro está.
    expect(before.cash).toBe(1500);
    expect(afterContribution.cash).toBe(700);
    expect(afterWithdrawal.cash).toBe(1500);
  });

  it('reserva espaço para outros ativos sem inventá-los', () => {
    const position = positionOf(sumByType([income(5000)]), 285000);

    expect(position.otherAssets).toBe(285000);
    expect(position.netWorth).toBe(290000);
  });

  it('caixa fica negativo quando se aporta mais do que se tem', () => {
    const position = positionFrom([income(1000), contribution(1500)]);

    expect(position.cash).toBe(-500);
    expect(position.invested).toBe(1500);
    expect(position.netWorth).toBe(1000);
  });
});

describe('total aportado x valor investido', () => {
  it('o resgate move o saldo sem apagar o histórico de aportes', () => {
    const totals = sumByType([
      contribution(2000),
      contribution(1000),
      withdrawal(500),
    ]);

    // Histórico: quanto já foi aportado ao longo da vida.
    expect(totals.contributions).toBe(3000);
    // Posição: quanto continua investido agora.
    expect(positionOf(totals).invested).toBe(2500);
  });
});

describe('sumByType', () => {
  it('ignora tipo desconhecido em vez de contá-lo como despesa', () => {
    const totals = sumByType([
      income(1000),
      { type: 'TRANSFER', amount: '900' },
    ]);

    expect(totals).toEqual({
      income: 1000,
      expense: 0,
      contributions: 0,
      withdrawals: 0,
    });
  });

  it('aceita o tipo em minúsculas, como chega da query string', () => {
    const totals = sumByType([{ type: 'withdrawal', amount: '250' }]);

    expect(totals.withdrawals).toBe(250);
  });

  it('trata valor não numérico como zero', () => {
    expect(sumByType([{ type: 'INCOME', amount: 'abc' }]).income).toBe(0);
  });
});

describe('signedGoalAmount', () => {
  it('soma o aporte, subtrai o resgate e ignora o resto', () => {
    expect(signedGoalAmount(contribution(1000))).toBe(1000);
    expect(signedGoalAmount(withdrawal(300))).toBe(-300);
    expect(signedGoalAmount(income(500))).toBe(0);
  });
});

describe('savingsRateOf', () => {
  it('mede o aporte contra a renda, sem descontar o resgate', () => {
    const totals = sumByType([
      income(4000),
      contribution(800),
      withdrawal(800),
    ]);

    expect(savingsRateOf(totals)).toBe(0.2);
  });

  it('não inventa taxa quando não houve renda', () => {
    expect(savingsRateOf(sumByType([contribution(500)]))).toBeNull();
  });
});
