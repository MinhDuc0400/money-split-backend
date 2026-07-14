import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { RedisIoAdapter } from './events/redis-io.adapter';
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';

// Write prisma config with the live DATABASE_URL and run migrations before the app starts.
// This is necessary on Railway where nixpacks excludes source/config files from the runtime image.
if (process.env.DATABASE_URL) {
  writeFileSync(
    'prisma.config.mjs',
    `import{defineConfig}from'prisma/config';export default defineConfig({schema:'prisma/schema.prisma',migrations:{path:'prisma/migrations'},datasource:{url:${JSON.stringify(process.env.DATABASE_URL)}}})`
  );
  try {
    execSync('npx prisma migrate deploy', { stdio: 'inherit' });
  } catch (e) {
    console.error('Migration failed:', e);
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    const redisIoAdapter = new RedisIoAdapter(app);
    await redisIoAdapter.connectToRedis(redisUrl);
    app.useWebSocketAdapter(redisIoAdapter);
    console.log('RedisIoAdapter connected');
  }

  // Enable CORS for frontend
  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  });

  // Enable global validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('SplitMoney API')
    .setDescription('Backend API for SplitMoney expense splitting application')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  await app.listen(process.env.PORT ?? 3000);
  console.log(
    `Application is running on: http://localhost:${process.env.PORT ?? 3000}`,
  );
}
bootstrap();
