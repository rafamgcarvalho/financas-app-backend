import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  numeric,
  boolean,
  pgEnum,
  integer,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Tipo da transação
 */
export const transactionTypeEnum = pgEnum('transaction_type', [
  'INCOME',
  'EXPENSE',
  'INVESTMENT',
]);

/**
 * Tipo da meta
 */
export const goalTypeEnum = pgEnum('goal_type', ['SHORT', 'MEDIUM', 'LONG']);

/**
 * Tipo do status da meta
 */
export const goalStatusEnum = pgEnum('goal_status', [
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
]);

/**
 * Tipo da prioridade da meta
 */
export const metaPriorityEnum = pgEnum('meta_priority', [
  'ESSENTIAL',
  'IMPORTANT',
  'DESIRABLE',
]);

/**
 * Usuário
 * Login básico: username + senha
 */
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  username: varchar('username', { length: 150 }).notNull().unique(),
  password: varchar('password', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

/**
 * Metas de investimento
 */

export const goals = pgTable('goals', {
  id: uuid('id').defaultRandom().primaryKey(),

  userId: uuid('user_id')
    .references(() => users.id)
    .notNull(),

  title: varchar('title', { length: 50 }).notNull(),
  description: varchar('description', { length: 100 }),

  targetValue: numeric('targetValue').notNull(),
  currentValue: numeric('currentValue').default('0'),

  startDate: timestamp('startDate').notNull(),
  targetDate: timestamp('targetDate'),

  type: goalTypeEnum('type').notNull(),
  status: goalStatusEnum('status').notNull(),
  priority: metaPriorityEnum('priority').default('IMPORTANT').notNull(),

  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
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

  installments: integer('installments').default(1),
  groupId: text('group_id'),

  createdAt: timestamp('created_at').defaultNow(),

  goalId: uuid('goal_id').references(() => goals.id, {
    onDelete: 'cascade',
  }),
});

/**
 * Role do membro na meta (dono ou participante)
 */
export const goalRoleEnum = pgEnum('goal_role', ['OWNER', 'MEMBER']);

/**
 * Membros de uma meta (relacionamento N:N entre usuários e metas)
 */
export const goalMembers = pgTable(
  'goal_members',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    goalId: uuid('goal_id')
      .references(() => goals.id, { onDelete: 'cascade' })
      .notNull(),

    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),

    role: goalRoleEnum('role').notNull(),

    joinedAt: timestamp('joined_at').defaultNow(),
  },
  (table) => [
    uniqueIndex('goal_members_goal_user_idx').on(table.goalId, table.userId),
  ],
);
