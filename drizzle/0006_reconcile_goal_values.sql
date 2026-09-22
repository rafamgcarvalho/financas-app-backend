-- Reconcilia "goals"."currentValue" com as transações vinculadas à meta.
--
-- Até aqui esse valor era mantido em incrementos (+ no aporte, − na exclusão),
-- e cada caminho tinha sua própria aritmética: editar um grupo de parcelas
-- calculava um delta a partir da contagem de linhas, excluir calculava outro.
-- Qualquer divergência entre esses cálculos ficava gravada e não tinha como se
-- corrigir sozinha. A partir de agora o valor é sempre recalculado a partir das
-- transações, então este UPDATE é o acerto de contas de uma única vez.
--
-- Regra: valor da meta = aportes − resgates vinculados a ela.
--
-- O tipo é comparado como texto de propósito. O Drizzle aplica todas as
-- migrações pendentes numa transação só, e o Postgres proíbe usar um valor de
-- enum na mesma transação em que ele foi criado ('WITHDRAWAL' nasceu na 0005).
-- Comparar t."type"::text nunca resolve o literal contra o enum e contorna isso
-- sem precisar separar os deploys.
--
-- Idempotente: rodar de novo encontra tudo já reconciliado e não atualiza nada.

WITH saldo AS (
  SELECT
    g."id",
    COALESCE(
      SUM(
        CASE
          WHEN t."type"::text = 'INVESTMENT' THEN t."amount"
          WHEN t."type"::text = 'WITHDRAWAL' THEN -t."amount"
          ELSE 0
        END
      ),
      0
    ) AS valor
  FROM "goals" g
  LEFT JOIN "transactions" t ON t."goal_id" = g."id"
  GROUP BY g."id"
)
UPDATE "goals" g
SET "currentValue" = saldo.valor,
    "updated_at" = now()
FROM saldo
WHERE saldo."id" = g."id"
  -- Só escreve onde realmente houve divergência, para não carimbar
  -- updated_at em meta nenhuma quando o banco já está correto.
  AND g."currentValue" IS DISTINCT FROM saldo.valor;
