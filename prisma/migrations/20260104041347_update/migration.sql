/*
  Warnings:

  - You are about to drop the column `paid` on the `expense_splits` table. All the data in the column will be lost.
  - The `role` column on the `group_members` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Changed the type of `split_type` on the `expenses` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "GroupRole" AS ENUM ('OWNER', 'MEMBER');

-- CreateEnum
CREATE TYPE "SplitType" AS ENUM ('EVEN', 'EXACT', 'PERCENTAGE', 'SHARES');

-- AlterTable
ALTER TABLE "expense_splits" DROP COLUMN "paid",
ALTER COLUMN "amount" SET DATA TYPE DECIMAL(18,6);

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'USD',
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "exchangeRate" DECIMAL(18,6),
ADD COLUMN     "rounding_diff" DECIMAL(18,6) NOT NULL DEFAULT 0,
ALTER COLUMN "amount" SET DATA TYPE DECIMAL(18,6),
DROP COLUMN "split_type",
ADD COLUMN     "split_type" "SplitType" NOT NULL;

-- AlterTable
ALTER TABLE "group_members" ADD COLUMN     "deletedAt" TIMESTAMP(3),
DROP COLUMN "role",
ADD COLUMN     "role" "GroupRole" NOT NULL DEFAULT 'MEMBER';

-- AlterTable
ALTER TABLE "groups" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "settlements" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "from_id" TEXT NOT NULL,
    "to_id" TEXT NOT NULL,
    "amount" DECIMAL(18,6) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "settlements_group_id_idx" ON "settlements"("group_id");

-- CreateIndex
CREATE INDEX "settlements_from_id_idx" ON "settlements"("from_id");

-- CreateIndex
CREATE INDEX "settlements_to_id_idx" ON "settlements"("to_id");

-- CreateIndex
CREATE INDEX "expense_splits_member_id_idx" ON "expense_splits"("member_id");

-- CreateIndex
CREATE INDEX "expenses_group_id_idx" ON "expenses"("group_id");

-- CreateIndex
CREATE INDEX "expenses_payer_id_idx" ON "expenses"("payer_id");

-- CreateIndex
CREATE INDEX "group_members_group_id_idx" ON "group_members"("group_id");

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_from_id_fkey" FOREIGN KEY ("from_id") REFERENCES "group_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_to_id_fkey" FOREIGN KEY ("to_id") REFERENCES "group_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
