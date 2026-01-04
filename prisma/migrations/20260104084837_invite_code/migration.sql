/*
  Warnings:

  - A unique constraint covering the columns `[invite_code]` on the table `groups` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `invite_code` to the `groups` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "groups" ADD COLUMN     "invite_code" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "groups_invite_code_key" ON "groups"("invite_code");

-- CreateIndex
CREATE INDEX "groups_invite_code_idx" ON "groups"("invite_code");
