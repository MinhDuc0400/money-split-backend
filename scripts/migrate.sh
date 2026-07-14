#!/bin/sh
set -e

# Write a prisma config with the actual DATABASE_URL value substituted by the shell
cat > /app/prisma.config.mjs << ENDOFCONFIG
import { defineConfig } from 'prisma/config';
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: '$DATABASE_URL' },
});
ENDOFCONFIG

echo "Running prisma migrate deploy..."
cd /app && npx prisma migrate deploy
echo "Migrations done."
