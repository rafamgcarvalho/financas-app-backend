import { Anonymizer } from './sanitize';
import {
  averageWindow,
  buildInstallments,
  buildMonthlyHistory,
  buildRecurring,
  buildSnapshot,
  observedGoalPace,
  type GoalRow,
  type TransactionRow,
} from './finance-snapshot';

const NOW = new Date(Date.UTC(2026, 8, 9)); // 2026-09-09

function tx(
  overrides: Omit<Partial<TransactionRow>, 'date'> & { date: string },
): TransactionRow {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    userId: 'user-1',
    title: 'Lançamento',
    amount: '100.00',
    description: null,
    category: 'outros',
    type: 'EXPENSE',
    isRecurring: false,
    installments: 1,
    installmentNumber: null,
    groupId: null,
    goalId: null,
    ...overrides,
    date: new Date(`${overrides.date}T12:00:00.000Z`),
  };
}

describe('averageWindow', () => {
  it('exclui o mês corrente para a média não oscilar dentro do mês', () => {
    const rows = [tx({ date: '2026-01-10' }), tx({ date: '2026-09-02' })];

    const window = averageWindow(rows, NOW);

    expect(window.excluiMesCorrente).toBe(true);
    // Termina em agosto/2026 e não passa de 6 meses.
    expect(window.months).toBe(6);
  });

  it('não começa antes do primeiro lançamento', () => {
    const rows = [tx({ date: '2026-07-10' }), tx({ date: '2026-08-10' })];

    expect(averageWindow(rows, NOW).months).toBe(2);
  });

  it('usa o mês corrente quando não há nenhum mês fechado', () => {
    const window = averageWindow([tx({ date: '2026-09-03' })], NOW);

    expect(window.excluiMesCorrente).toBe(false);
    expect(window.months).toBe(1);
  });
});

describe('buildMonthlyHistory', () => {
  it('devolve doze meses, inclusive os vazios', () => {
    const history = buildMonthlyHistory([tx({ date: '2026-08-10' })], NOW);

    expect(history).toHaveLength(12);
    expect(history[0].mes).toBe('2025-10');
    expect(history[11].mes).toBe('2026-09');
  });

  it('separa investimento do saldo, como o resto do app', () => {
    const rows = [
      tx({ date: '2026-08-05', type: 'INCOME', amount: '5000' }),
      tx({ date: '2026-08-06', type: 'EXPENSE', amount: '3000' }),
      tx({ date: '2026-08-07', type: 'INVESTMENT', amount: '800' }),
    ];

    const august = buildMonthlyHistory(rows, NOW).find(
      (month) => month.mes === '2026-08',
    );

    // O mês produziu 2.000, mas só 1.200 sobraram em caixa.
    expect(august).toMatchObject({ resultado: 2000, variacaoDoCaixa: 1200 });
  });

  it('o resgate devolve caixa sem virar receita', () => {
    const rows = [
      tx({ date: '2026-08-05', type: 'INCOME', amount: '5000' }),
      tx({ date: '2026-08-06', type: 'EXPENSE', amount: '3000' }),
      tx({ date: '2026-08-07', type: 'INVESTMENT', amount: '800' }),
      tx({ date: '2026-08-20', type: 'WITHDRAWAL', amount: '300' }),
    ];

    const august = buildMonthlyHistory(rows, NOW).find(
      (month) => month.mes === '2026-08',
    );

    expect(august).toMatchObject({
      receitas: 5000,
      resgates: 300,
      resultado: 2000,
      variacaoDoCaixa: 1500,
    });
  });
});

describe('buildInstallments', () => {
  const group = (paid: string[], pending: string[]): TransactionRow[] =>
    [...paid, ...pending].map((date, index) =>
      tx({
        date,
        title: 'Notebook',
        amount: '500.00',
        installments: paid.length + pending.length,
        installmentNumber: index + 1,
        groupId: 'grupo-1',
      }),
    );

  it('conta o que falta pagar a partir das parcelas ainda não vencidas', () => {
    const rows = group(
      ['2026-07-10', '2026-08-10', '2026-09-08'],
      ['2026-10-10', '2026-11-10'],
    );

    const [item] = buildInstallments(rows, NOW, new Anonymizer());

    expect(item).toMatchObject({
      parcelasPagas: 3,
      parcelasRestantes: 2,
      saldoDevedor: 1000,
      proximaParcela: '2026-10-10',
      terminoPrevisto: '2026-11-10',
    });
  });

  it('omite parcelamentos já quitados', () => {
    const rows = group(['2026-06-10', '2026-07-10'], []);

    expect(buildInstallments(rows, NOW, new Anonymizer())).toHaveLength(0);
  });

  it('ignora recorrências, que não têm saldo devedor', () => {
    const rows = [
      tx({
        date: '2026-10-10',
        isRecurring: true,
        installments: 12,
        groupId: 'grupo-2',
      }),
    ];

    expect(buildInstallments(rows, NOW, new Anonymizer())).toHaveLength(0);
  });
});

describe('buildRecurring', () => {
  it('agrupa a recorrência e marca se ainda há ocorrência futura', () => {
    const rows = [
      tx({
        date: '2026-08-05',
        type: 'EXPENSE',
        title: 'Aluguel',
        amount: '1800',
        isRecurring: true,
        groupId: 'grupo-3',
      }),
      tx({
        date: '2026-10-05',
        type: 'EXPENSE',
        title: 'Aluguel',
        amount: '1800',
        isRecurring: true,
        groupId: 'grupo-3',
      }),
    ];

    const [item] = buildRecurring(rows, 'EXPENSE', NOW, new Anonymizer());

    expect(item).toMatchObject({
      descricao: 'Aluguel',
      valorMensal: 1800,
      ocorrenciasFuturasRegistradas: 1,
      ativa: true,
    });
  });
});

describe('observedGoalPace', () => {
  const aporte = (date: string, amount: string) => ({
    date: new Date(`${date}T12:00:00Z`),
    amount,
    type: 'INVESTMENT',
  });

  const resgate = (date: string, amount: string) => ({
    date: new Date(`${date}T12:00:00Z`),
    amount,
    type: 'WITHDRAWAL',
  });

  it('usa a mediana, para um aporte atípico não inflar o ritmo', () => {
    const contributions = [
      aporte('2026-04-10', '900'),
      aporte('2026-05-10', '900'),
      aporte('2026-06-10', '900'),
      aporte('2026-07-10', '5000'),
      aporte('2026-08-10', '900'),
      aporte('2026-09-05', '900'),
    ];

    expect(observedGoalPace(contributions, NOW).ritmo).toBe(900);
  });

  it('conta mês sem aporte como zero', () => {
    const contributions = [
      aporte('2026-04-10', '600'),
      aporte('2026-09-05', '600'),
    ];

    // Janela de abril a setembro: 600, 0, 0, 0, 0, 600 -> mediana zero.
    expect(observedGoalPace(contributions, NOW).ritmo).toBe(0);
  });

  it('desconta o resgate: um mês que aportou e sacou o mesmo não andou', () => {
    const movements = [
      aporte('2026-04-10', '500'),
      aporte('2026-05-10', '500'),
      aporte('2026-06-10', '500'),
      // Julho aportou 500 e sacou 500: ritmo zero naquele mês.
      aporte('2026-07-10', '500'),
      resgate('2026-07-20', '500'),
      aporte('2026-08-10', '500'),
      aporte('2026-09-05', '500'),
    ];

    // Janela de abril a setembro: 500, 500, 500, 0, 500, 500 -> mediana 500.
    expect(observedGoalPace(movements, NOW).ritmo).toBe(500);
  });

  it('não projeta ritmo sem histórico', () => {
    expect(observedGoalPace([], NOW)).toEqual({ ritmo: 0, janelaMeses: 0 });
  });
});

describe('buildSnapshot', () => {
  const goal: GoalRow = {
    id: 'goal-1',
    title: 'Viagem com Nubank pontos',
    description: null,
    targetValue: '12000',
    currentValue: '3000',
    monthlyPlan: '750',
    startDate: new Date('2026-01-01T00:00:00Z'),
    targetDate: new Date('2027-01-01T00:00:00Z'),
    type: 'MEDIUM',
    status: 'ACTIVE',
    priority: 'IMPORTANT',
    isOwner: true,
    memberIds: ['user-1', 'user-2'],
  };

  const snapshot = () =>
    buildSnapshot({
      rows: [
        tx({ date: '2026-08-05', type: 'INCOME', amount: '6000' }),
        tx({ date: '2026-08-06', type: 'EXPENSE', amount: '4000' }),
        tx({ date: '2026-08-07', type: 'INVESTMENT', amount: '750' }),
      ],
      lifetimeTotals: {
        receitas: 60000,
        despesas: 40000,
        investimentos: 8000,
        resgates: 1000,
      },
      goalRows: [goal],
      contributionsByGoal: new Map([
        [
          'goal-1',
          [
            {
              date: new Date('2026-08-07T12:00:00Z'),
              amount: '750',
              type: 'INVESTMENT',
            },
          ],
        ],
      ]),
      now: NOW,
      anonymizer: new Anonymizer({ name: 'Rafael', username: 'rafa' }),
    });

  it('separa caixa de patrimônio sem contar o investido duas vezes', () => {
    const { patrimonio } = snapshot();

    // 60.000 − 40.000 − 8.000 + 1.000
    expect(patrimonio.caixaDisponivel).toBe(13000);
    // 8.000 aportados − 1.000 resgatados
    expect(patrimonio.totalInvestido).toBe(7000);
    // Aporte e resgate só movem dinheiro: 60.000 − 40.000.
    expect(patrimonio.total).toBe(20000);
  });

  it('preserva o histórico de aportes ao lado da posição atual', () => {
    const { investimentos } = snapshot();

    expect(investimentos.totalAportadoHistorico).toBe(8000);
    expect(investimentos.totalResgatado).toBe(1000);
    expect(investimentos.valorInvestidoAtual).toBe(7000);
  });

  it('anonimiza o título da meta e os participantes', () => {
    const [meta] = snapshot().metas;

    expect(meta.titulo).toBe('Viagem com Instituição A pontos');
    expect(meta.participantes).toEqual(['Participante 1', 'Participante 2']);
    expect(meta.compartilhada).toBe(true);
  });

  it('projeta a meta pelo plano declarado quando ele existe', () => {
    const [meta] = snapshot().metas;

    expect(meta.baseDaProjecao).toBe('plano declarado');
    expect(meta.valorRestante).toBe(9000);
    expect(meta.mesesParaConcluirNoRitmo).toBe(12);
    expect(meta.aporteMensalNecessarioParaAlvo).toBe(2250);
  });

  it('declara as lacunas do contexto para o modelo não preenchê-las sozinho', () => {
    expect(snapshot().limitacoesDoContexto.length).toBeGreaterThan(0);
  });

  it('não deixa nome nem id de usuário vazarem para o payload', () => {
    const serialized = JSON.stringify(snapshot());

    expect(serialized).not.toContain('user-1');
    expect(serialized).not.toContain('Rafael');
  });
});
