ALTER TABLE "transactions" ADD COLUMN "installment_number" integer;--> statement-breakpoint

-- Até aqui a posição da parcela só existia embutida no título, no formato
-- "Aluguel (3/12)", e as recorrentes ganhavam um sufixo " Recorrente".
-- Passamos esse dado para a coluna própria e devolvemos o título limpo.
--
-- Os dois UPDATEs são idempotentes: rodar de novo não encontra mais nada
-- para casar, porque o sufixo já foi removido.

UPDATE "transactions"
SET "installment_number" = CAST(
      (regexp_match("title", '\s\((\d+)/(\d+)\)$'))[1] AS integer
    ),
    "title" = regexp_replace("title", '\s\(\d+/\d+\)$', '')
WHERE "title" ~ '\s\(\d+/\d+\)$'
  -- Só mexe quando o total no título bate com a coluna, para não corromper
  -- um lançamento que legitimamente se chame "Aluguel (1/2)".
  AND CAST((regexp_match("title", '\s\((\d+)/(\d+)\)$'))[2] AS integer) = "installments";
--> statement-breakpoint

UPDATE "transactions"
SET "title" = regexp_replace("title", '\sRecorrente$', '')
WHERE "is_recurring" = true
  AND "title" ~ '\sRecorrente$';
