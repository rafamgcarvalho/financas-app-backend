import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db } from './drizzle';

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

type JournalEntry = { tag: string; when: number };

function readJournal(): JournalEntry[] {
  const path = join(MIGRATIONS_FOLDER, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(path, 'utf8')) as {
    entries: JournalEntry[];
  };

  return journal.entries;
}

/** Mesmo hash que o Drizzle grava: sha256 do conteúdo do arquivo .sql. */
function hashOf(tag: string): string {
  const content = readFileSync(join(MIGRATIONS_FOLDER, `${tag}.sql`), 'utf8');
  return createHash('sha256').update(content).digest('hex');
}

async function tableExists(name: string): Promise<boolean> {
  const result = await db.execute(
    sql`SELECT to_regclass(${`public.${name}`}) IS NOT NULL AS found`,
  );

  return Boolean((result.rows[0] as { found: boolean } | undefined)?.found);
}

/**
 * Marca migrações antigas como já aplicadas.
 *
 * O banco de produção foi criado antes de existir um fluxo de migração: as
 * tabelas estão lá, mas o Drizzle nunca registrou nada em
 * `drizzle.__drizzle_migrations`. Sem este passo ele tentaria reexecutar a
 * 0000 e pararia em "type goal_status already exists".
 *
 * Só roda quando o controle não existe E o schema existe — ou seja, num banco
 * legado. Em banco vazio não faz nada e as migrações rodam normalmente.
 */
async function baselineLegacyDatabase(): Promise<void> {
  const controlExists = await db
    .execute(
      sql`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS found`,
    )
    .then((r) => Boolean((r.rows[0] as { found: boolean } | undefined)?.found));

  if (controlExists) return;

  // Um banco realmente novo não tem as tabelas: deixa o migrate fazer o
  // trabalho do zero.
  if (!(await tableExists('transactions'))) return;

  // Cada migração já refletida no banco é reconhecida por um objeto que ela
  // cria. Se o objeto está lá, a migração já rodou.
  const applied: { tag: string; when: number }[] = [];
  const journal = readJournal();

  const evidence: Record<string, () => Promise<boolean>> = {
    '0000_square_inhumans': () => tableExists('transactions'),
    '0001_fine_eternals': () => tableExists('goals'),
    '0002_windy_patriot': () => tableExists('goal_members'),
  };

  for (const entry of journal) {
    const check = evidence[entry.tag];
    if (check && (await check())) applied.push(entry);
  }

  if (applied.length === 0) return;

  console.log(
    `🧭 Banco anterior ao controle de migrações: marcando ${applied.length} como já aplicada(s).`,
  );

  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

  for (const entry of applied) {
    await db.execute(sql`
      INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
      VALUES (${hashOf(entry.tag)}, ${entry.when})
    `);
  }
}

/**
 * Aplica as migrações pendentes antes de o servidor aceitar requisições.
 *
 * Sem isto, publicar código que usa uma coluna nova derruba a API até alguém
 * lembrar de migrar o banco na mão — foi o caso de `installment_number`.
 *
 * O Drizzle registra o que já rodou, então reiniciar o serviço não reaplica
 * nada.
 */
export async function runMigrations(): Promise<void> {
  if (!existsSync(MIGRATIONS_FOLDER)) {
    console.warn(
      `⚠️  Pasta de migrações não encontrada em ${MIGRATIONS_FOLDER} — seguindo sem migrar.`,
    );
    return;
  }

  console.log('🗄️  Verificando migrações...');
  await baselineLegacyDatabase();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  console.log('✅ Banco em dia.');
}
