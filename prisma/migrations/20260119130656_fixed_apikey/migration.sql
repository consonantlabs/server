/*
  Warnings:

  - You are about to drop the column `secretHash` on the `clusters` table. All the data in the column will be lost.
  - Made the column `apiKeyId` on table `clusters` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "clusters" DROP CONSTRAINT "clusters_apiKeyId_fkey";

-- AlterTable
ALTER TABLE "clusters" DROP COLUMN "secretHash",
ALTER COLUMN "apiKeyId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
