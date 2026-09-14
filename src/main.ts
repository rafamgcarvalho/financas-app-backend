import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { runMigrations } from './db/migrate';

async function bootstrap() {
  // Antes de aceitar requisições: um deploy nunca deve rodar com o banco
  // atrasado em relação ao código.
  await runMigrations();

  // Tipado como Express para poder ajustar o body parser abaixo.
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // O padrão do Express é 100kb, apertado para o chat: o histórico de uma
  // conversa longa reenviado a cada pergunta passa disso e voltaria 413 sem
  // explicação nenhuma na tela. O cliente já limita o que manda (ver
  // `toApiHistory`, no frontend); isto é a folga do outro lado.
  app.useBodyParser('json', { limit: '1mb' });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors();

  await app.listen(process.env.PORT ?? 3001, '0.0.0.0');
}
void bootstrap();
