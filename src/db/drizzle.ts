// import { drizzle } from 'drizzle-orm/node-postgres';
// import { Pool } from 'pg';

// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
//   ssl: {
//     rejectUnauthorized: false,
//   },
//   max: 1,
// });

// export const db = drizzle(pool);

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

// Verifica se a conexão é local ou nuvem
const isLocal =
  process.env.DATABASE_URL?.includes('localhost') ||
  process.env.DATABASE_URL?.includes('127.0.0.1');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Só ativa o SSL se NÃO for local
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 1,
});

// O console log para sua segurança
if (isLocal) {
  console.log('🚀 Conectado ao banco LOCAL (Docker)');
} else {
  console.log('☁️ Conectado ao banco NUVEM (Neon)');
}

export const db = drizzle(pool);
