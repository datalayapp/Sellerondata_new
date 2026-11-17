-- Firma para birimi: ülkeye göre EUR ve GBP de seçilebilir.
ALTER TYPE "Currency" ADD VALUE IF NOT EXISTS 'EUR';
ALTER TYPE "Currency" ADD VALUE IF NOT EXISTS 'GBP';
