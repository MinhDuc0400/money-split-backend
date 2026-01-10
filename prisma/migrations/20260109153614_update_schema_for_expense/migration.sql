/*
  Warnings:

  - You are about to drop the column `deletedAt` on the `expenses` table. All the data in the column will be lost.
  - You are about to drop the column `exchangeRate` on the `expenses` table. All the data in the column will be lost.
  - You are about to drop the column `payer_id` on the `expenses` table. All the data in the column will be lost.
  - Added the required column `updated_at` to the `settlements` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'COMPLETED', 'REJECTED');

-- DropForeignKey
ALTER TABLE "expenses" DROP CONSTRAINT "expenses_payer_id_fkey";

-- DropIndex
DROP INDEX "expenses_payer_id_idx";

-- AlterTable
ALTER TABLE "expense_splits" ADD COLUMN     "percentage" DECIMAL(18,6),
ADD COLUMN     "share" DECIMAL(18,6);

-- AlterTable
ALTER TABLE "expenses" DROP COLUMN "deletedAt",
DROP COLUMN "exchangeRate",
DROP COLUMN "payer_id",
ADD COLUMN     "attachments" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "category_id" TEXT,
ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "exchange_rate" DECIMAL(18,6);

-- AlterTable
ALTER TABLE "settlements" ADD COLUMN     "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL;

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "group_id" TEXT,
    "name" TEXT NOT NULL,
    "icon" TEXT,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_payers" (
    "id" TEXT NOT NULL,
    "expense_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "amount" DECIMAL(18,6) NOT NULL,

    CONSTRAINT "expense_payers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "categories_group_id_name_key" ON "categories"("group_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "expense_payers_expense_id_member_id_key" ON "expense_payers"("expense_id", "member_id");

-- CreateIndex
CREATE INDEX "expenses_category_id_idx" ON "expenses"("category_id");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_payers" ADD CONSTRAINT "expense_payers_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_payers" ADD CONSTRAINT "expense_payers_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "group_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
