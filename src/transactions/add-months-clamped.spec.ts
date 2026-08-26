import { addMonthsClamped } from './transactions.service';

/** "2026-01-31" a partir de uma data UTC, para leitura nas asserções. */
const day = (date: Date) => date.toISOString().slice(0, 10);
const utc = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

describe('addMonthsClamped', () => {
  it('mantém o dia quando ele existe no mês de destino', () => {
    expect(day(addMonthsClamped(utc('2026-01-15'), 1))).toBe('2026-02-15');
    expect(day(addMonthsClamped(utc('2026-01-15'), 6))).toBe('2026-07-15');
  });

  it('usa o último dia do mês quando o dia não existe', () => {
    // O caso que quebrava: setUTCMonth resolvia isto como 3 de março.
    expect(day(addMonthsClamped(utc('2026-01-31'), 1))).toBe('2026-02-28');
    expect(day(addMonthsClamped(utc('2026-03-31'), 1))).toBe('2026-04-30');
    expect(day(addMonthsClamped(utc('2026-08-31'), 1))).toBe('2026-09-30');
  });

  it('respeita ano bissexto', () => {
    expect(day(addMonthsClamped(utc('2028-01-30'), 1))).toBe('2028-02-29');
    expect(day(addMonthsClamped(utc('2026-01-30'), 1))).toBe('2026-02-28');
  });

  it('não deixa a data derivar ao longo de uma recorrência inteira', () => {
    const base = utc('2026-01-31');
    const meses = Array.from({ length: 12 }, (_, i) =>
      day(addMonthsClamped(base, i)),
    );

    expect(meses).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
      '2026-07-31',
      '2026-08-31',
      '2026-09-30',
      '2026-10-31',
      '2026-11-30',
      '2026-12-31',
    ]);
  });

  it('gera exatamente um lançamento por mês, sem pular nem repetir', () => {
    const base = utc('2026-01-31');
    const meses = Array.from({ length: 12 }, (_, i) =>
      addMonthsClamped(base, i).getUTCMonth(),
    );

    expect(meses).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('atravessa a virada de ano', () => {
    expect(day(addMonthsClamped(utc('2026-12-31'), 1))).toBe('2027-01-31');
    expect(day(addMonthsClamped(utc('2026-11-30'), 3))).toBe('2027-02-28');
  });

  it('preserva o horário, para a data não escorregar de fuso', () => {
    const resultado = addMonthsClamped(utc('2026-01-31'), 1);
    expect(resultado.toISOString()).toBe('2026-02-28T12:00:00.000Z');
  });
});
