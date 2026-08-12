-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('FOOD', 'TRANSPORT', 'RENT', 'UTILITIES', 'ENTERTAINMENT', 'SHOPPING', 'TRAVEL', 'HEALTH', 'OTHER');

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "category" "ExpenseCategory" NOT NULL DEFAULT 'OTHER';
