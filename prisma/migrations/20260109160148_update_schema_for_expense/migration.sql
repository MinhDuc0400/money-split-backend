/*
  Warnings:

  - You are about to drop the column `attachments` on the `expenses` table. All the data in the column will be lost.
  - You are about to drop the column `category_id` on the `expenses` table. All the data in the column will be lost.
  - You are about to drop the `categories` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "categories" DROP CONSTRAINT "categories_group_id_fkey";

-- DropForeignKey
ALTER TABLE "expenses" DROP CONSTRAINT "expenses_category_id_fkey";

-- DropIndex
DROP INDEX "expenses_category_id_idx";

-- AlterTable
ALTER TABLE "expenses" DROP COLUMN "attachments",
DROP COLUMN "category_id";

-- DropTable
DROP TABLE "categories";
