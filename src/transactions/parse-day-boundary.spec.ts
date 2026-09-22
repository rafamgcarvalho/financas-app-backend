import { parseDayBoundary } from './transactions.service';

/**
 * Recorte por dia do filtro de datas.
 *
 * O intervalo é inclusive nas duas pontas, então o fim precisa cobrir o último
 * milissegundo do dia: parar em 00:00 esconderia tudo que foi lançado na data
 * final, que é justamente a que o usuário digitou.
 */
describe('parseDayBoundary', () => {
  it('ancora o início na primeira hora do dia, em UTC', () => {
    expect(parseDayBoundary('2026-10-01', 'start')?.toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });

  it('ancora o fim no último milissegundo do dia', () => {
    expect(parseDayBoundary('2026-10-31', 'end')?.toISOString()).toBe(
      '2026-10-31T23:59:59.999Z',
    );
  });

  it('cobre o mês inteiro quando as pontas são o primeiro e o último dia', () => {
    const start = parseDayBoundary('2026-02-01', 'start');
    const end = parseDayBoundary('2026-02-28', 'end');

    expect(start?.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(end?.toISOString()).toBe('2026-02-28T23:59:59.999Z');
  });

  it('ignora data inexistente em vez de rolar para o mês seguinte', () => {
    // `new Date(Date.UTC(2026, 1, 31))` viraria 3 de março.
    expect(parseDayBoundary('2026-02-31', 'start')).toBeUndefined();
    expect(parseDayBoundary('2026-13-01', 'start')).toBeUndefined();
  });

  it('ignora formato que não seja AAAA-MM-DD', () => {
    expect(parseDayBoundary('01/10/2026', 'start')).toBeUndefined();
    expect(parseDayBoundary('2026-10-01T15:00:00Z', 'start')).toBeUndefined();
    expect(parseDayBoundary('ontem', 'start')).toBeUndefined();
  });

  it('trata ausência como ausência de filtro', () => {
    expect(parseDayBoundary(undefined, 'start')).toBeUndefined();
    expect(parseDayBoundary('', 'end')).toBeUndefined();
  });

  it('aceita espaço em volta, que o querystring costuma carregar', () => {
    expect(parseDayBoundary(' 2026-10-01 ', 'start')?.toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });
});
