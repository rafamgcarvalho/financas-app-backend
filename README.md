# Finanças App — API

Backend do [financas-app](../financas-app): NestJS + Drizzle ORM sobre PostgreSQL,
com WebSocket para atualizar metas compartilhadas em tempo real.

## Rodando localmente

### 1. Banco de dados

Com Docker:

```bash
docker compose up -d
```

Sem Docker, via Homebrew (macOS):

```bash
brew install postgresql@15
brew services start postgresql@15

# usuário e banco com as mesmas credenciais do docker-compose.yml
psql -d postgres -c "ALTER ROLE postgres WITH LOGIN SUPERUSER PASSWORD 'root'" \
  || psql -d postgres -c "CREATE ROLE postgres LOGIN SUPERUSER PASSWORD 'root'"
psql -d postgres -c "CREATE DATABASE financias_local OWNER postgres"
```

Os dois caminhos produzem a mesma string de conexão, então dá para alternar
entre eles sem mexer no `.env`.

### 2. Variáveis de ambiente

```bash
cp .env.example .env
```

| Variável | Para que serve |
| --- | --- |
| `DATABASE_URL` | Conexão com o Postgres. O SSL liga sozinho quando o host não é local. |
| `JWT_SECRET` | Assina os tokens. Use um valor longo e aleatório em produção. |
| `PORT` | Porta da API (padrão 3001). |
| `GEMINI_API_KEY` | Chave do [Google AI Studio](https://aistudio.google.com/apikey), usada pelo assistente. Sem ela a API sobe normalmente e só o chat fica indisponível. |
| `GEMINI_MODEL` | Opcional. Padrão `gemini-2.5-flash`. |
| `GEMINI_TEMPERATURE` | Opcional. Padrão `0.2`. |
| `GEMINI_MAX_OUTPUT_TOKENS` | Opcional. **Não enviado por padrão**: vale o máximo do modelo. Defina só para conter custo. |
| `GEMINI_THINKING_BUDGET` | Opcional. Limita o raciocínio antes da resposta (`0` desliga, `-1` automático). Sem a variável, vale o padrão do modelo. |

O `.env` está no `.gitignore` e a `GEMINI_API_KEY` nunca sai do servidor: o
frontend não a recebe em nenhuma resposta.

### 3. Migrações e execução

```bash
npm install
npm run db:migrate
npm run start:dev
```

## Scripts

| Comando | O que faz |
| --- | --- |
| `npm run start:dev` | API em watch mode |
| `npm run build` | Compila para `dist/` |
| `npm run db:generate` | Gera uma migração a partir de `src/db/schema.ts` |
| `npm run db:migrate` | Aplica as migrações pendentes |
| `npm run db:studio` | Abre o Drizzle Studio |
| `npm test` | Testes unitários |

## Como as transações funcionam

Um lançamento pode gerar várias linhas na tabela `transactions`:

- **À vista** — uma linha.
- **Parcelado** — `installments` linhas, uma por mês a partir de `date`. O
  `amount` enviado é o **total**, e cada linha guarda `amount / installments`.
  A posição de cada parcela fica em `installmentNumber`.
- **Recorrente** — 12 linhas mensais com o valor cheio em cada uma.
  Recorrentes não recebem `installmentNumber`: elas repetem um gasto, não
  dividem uma compra.

Linhas geradas juntas compartilham um `groupId`, que é o que permite editar ou
excluir o conjunto:

- `DELETE /transactions/:id?deleteAll=true` remove o grupo inteiro.
- `PATCH /transactions/:id?updateAll=true` edita o grupo inteiro.

Sem esses parâmetros, ambos afetam apenas o lançamento indicado. A **data**
nunca se propaga para o grupo — é justamente ela que distingue uma parcela da
seguinte.

## Endpoints

| Método | Rota | Observações |
| --- | --- | --- |
| `POST` | `/users` | Cadastro |
| `POST` | `/auth/login` | Devolve `access_token` |
| `GET` | `/users/:username` | Perfil público |
| `GET` | `/transactions` | Filtros: `from`/`to` (AAAA-MM-DD, inclusive), `month`, `year`, `type`, `goalId` |
| `POST` | `/transactions` | Cria (pode gerar várias linhas) |
| `PATCH` | `/transactions/:id` | `?updateAll=true` para o grupo |
| `DELETE` | `/transactions/:id` | `?deleteAll=true` para o grupo |
| `GET` | `/transactions/range` | Primeira e última data; aceita `type` |
| `GET` | `/transactions/stats` | Série mensal de receitas x despesas |
| `GET` | `/transactions/stats/comparison` | Totais do mês por tipo |
| `GET` | `/transactions/stats/categories` | Gasto por categoria (chave crua) |
| `GET` | `/goals` … | Metas e membros |
| `GET` | `/chat/status` | Diz se o assistente está configurado |
| `POST` | `/chat` | Pergunta ao assistente. Corpo: `message` e `history` |

As categorias são texto livre: quem define rótulo, ícone e cor é o frontend.

## Filtro de período

`GET /transactions` aceita `from` e `to` no formato `AAAA-MM-DD`, inclusive nas
duas pontas: `from` ancora em 00:00:00.000 e `to` em 23:59:59.999 (UTC), senão o
último dia digitado ficaria de fora.

O intervalo tem **precedência** sobre `month`/`year`, que continuam valendo para
quem consulta um mês fechado — é o que o dashboard usa. Uma data fora do
calendário (`2026-02-31`) é ignorada em vez de rolar para março: um filtro que
responde sobre um dia inexistente é pior do que um filtro ignorado.

Antes, um período de vários meses virava uma requisição por mês no navegador,
com corte em 24 meses e filtragem do resto no cliente. Com o intervalo é uma
requisição só, e a API devolve exatamente as linhas pedidas.

## Assistente financeiro (`/chat`)

Um consultor conversacional sobre os próprios dados do usuário, servido pelo
Gemini. O código vive em `src/chat/`.

O fluxo de cada mensagem:

1. `AuthGuard` valida o token e o `user_id` sai do `sub` do JWT. O DTO **não tem**
   campo de usuário e o `ValidationPipe` global roda com `forbidNonWhitelisted`,
   então mandar `userId` no corpo devolve 400 — não há caminho para um IDOR.
2. `FinanceContextService` lê do banco só o que pertence àquele id e monta a foto
   financeira: saldo, médias dos últimos 6 meses fechados, histórico de 12 meses,
   receitas recorrentes, despesas fixas, parcelamentos em aberto, aportes e metas
   com projeção.
3. `Anonymizer` (`sanitize.ts`) higieniza o que é texto livre antes de sair:
   e-mail, CPF/CNPJ, telefone e sequências longas de dígitos são mascarados, o
   nome do próprio usuário é riscado, nomes de bancos viram "Instituição A" e
   participantes de metas compartilhadas viram "Participante 1". Nenhum `id`,
   nome ou username é enviado.
4. `GeminiService` chama o modelo com `temperature: 0.2` e o system prompt de
   `system-prompt.ts`. O contexto vai delimitado em `<contexto_financeiro>` e a
   pergunta em `<pergunta_do_usuario>` — título de lançamento é texto que o
   usuário escreveu, e sem a separação ele chegaria ao modelo parecendo ordem.

O payload leva junto uma lista de `limitacoesDoContexto`: o que o schema **não**
tem (cartão de crédito, fatura, rentabilidade, tipo de ativo). Sem ela o modelo
preenche a lacuna com o que costuma existir num app de finanças e responde com
convicção sobre algo que não existe aqui.

O histórico da conversa não é persistido no servidor — ele vem do navegador a
cada requisição. Há um limite de 20 mensagens por usuário a cada 5 minutos,
mantido em memória (vale por instância).

### Continuidade

Como o bloco de contexto é reenviado inteiro a cada turno, o modelo lia toda
mensagem como o começo de uma sessão nova e abria as respostas com "Olá!". O
envelope agora carrega um `<estado_da_conversa>` com o número da mensagem e um
`primeira_mensagem`, e o system prompt tem uma seção de CONTINUIDADE que proíbe
cumprimentar de novo. É determinístico: não depende de o modelo inferir o tom
pelo histórico.

### Tamanho da resposta

Nenhum teto é enviado: sem `maxOutputTokens`, vale o máximo do próprio modelo —
e o número certo muda a cada geração de Flash, então fixá-lo no código só criaria
um limite artificial para manter.

Ainda assim o teto do modelo existe, e os tokens de raciocínio contam dentro
dele. Por isso, quando a geração termina com `finishReason: MAX_TOKENS`, o
serviço reenvia o trecho parcial como turno do assistente, pede a continuação e
**emenda o texto sem inserir caractere nenhum no ponto de corte** — a emenda é
literal porque o corte pode cair no meio de uma palavra ou de uma linha de
tabela. São até 3 retomadas; o custo é reenviar o contexto a cada uma, o que só
acontece em resposta realmente longa.

Se nem as retomadas fecharem, a resposta volta com `truncated: true` e a
interface avisa. O que nunca acontece é entregar meia resposta como se fosse
inteira.

### Memória entre chats

O frontend mantém conversas separadas. Cada pergunta leva, além do histórico do
chat atual, um resumo dos outros: `otherConversations`, com o título e as
**perguntas** feitas em cada um.

Só as perguntas, nunca as respostas antigas do modelo. A pergunta carrega a
intenção e os fatos que o usuário declarou ("meu salário vai aumentar para
3000"); uma resposta antiga carregaria números que podem já estar desatualizados,
e número velho ao lado do atual é convite para o assistente citar o errado. O
bloco vai marcado como texto do usuário, não como dado do sistema.

---

<details>
<summary>Boilerplate original do NestJS</summary>

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).

</details>
