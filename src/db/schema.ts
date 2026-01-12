import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  numeric,
  boolean,
  pgEnum,
} from 'drizzle-orm/pg-core';

/**
 * Tipo da transação
 */
export const transactionTypeEnum = pgEnum('transaction_type', [
  'INCOME',
  'EXPENSE',
]);

/**
 * Usuário
 * Login básico: email + senha
 */
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  email: varchar('email', { length: 150 }).notNull().unique(),
  password: varchar('password', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

/**
 * Transações financeiras
 */
export const transactions = pgTable('transactions', {
  id: uuid('id').defaultRandom().primaryKey(),

  userId: uuid('user_id')
    .references(() => users.id)
    .notNull(),

  title: varchar('title', { length: 100 }).notNull(),
  amount: numeric('amount').notNull(),

  description: varchar('description', { length: 255 }),
  date: timestamp('date').notNull(),

  category: varchar('category', { length: 50 }).notNull(),
  type: transactionTypeEnum('type').notNull(),

  isRecurring: boolean('is_recurring').default(false),
  createdAt: timestamp('created_at').defaultNow(),
});
