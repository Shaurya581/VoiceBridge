-- Add a claim state and bounded-retry metadata for reminder/emergency dispatch.
ALTER TYPE "DeliveryStatus" ADD VALUE 'PROCESSING';

ALTER TABLE "Reminder"
ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastAttemptAt" TIMESTAMP(3);

ALTER TABLE "EmergencyEvent"
ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastAttemptAt" TIMESTAMP(3);
