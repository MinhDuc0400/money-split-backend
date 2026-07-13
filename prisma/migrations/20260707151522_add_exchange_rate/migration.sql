-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" TEXT NOT NULL,
    "base_currency" TEXT NOT NULL,
    "target_currency" TEXT NOT NULL,
    "rate" NUMERIC(18,8) NOT NULL,
    "date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rates_base_currency_target_currency_date_key" ON "exchange_rates"("base_currency", "target_currency", "date");

-- CreateIndex
CREATE INDEX "exchange_rates_base_currency_date_idx" ON "exchange_rates"("base_currency", "date");
