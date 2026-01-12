// import { drizzle } from 'drizzle-orm/node-postgres';
// import { Pool } from 'pg';

// const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
//   ssl: true,
// });

// export const db = drizzle(pool);

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
  max: 1,
});

export const db = drizzle(pool);
