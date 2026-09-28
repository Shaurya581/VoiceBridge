-- CreateEnum
CREATE TYPE "AudioQuality" AS ENUM ('CLEAN', 'NOISY', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DuplicateReviewStatus" AS ENUM ('PENDING', 'MERGED', 'DISTINCT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WorkflowStatus" ADD VALUE 'COMPLETED_BY_ASSIGNEE';
ALTER TYPE "WorkflowStatus" ADD VALUE 'REPORTER_VERIFICATION_PENDING';
ALTER TYPE "WorkflowStatus" ADD VALUE 'REPORTER_CONFIRMED';
ALTER TYPE "WorkflowStatus" ADD VALUE 'REPORTER_REJECTED';
ALTER TYPE "WorkflowStatus" ADD VALUE 'REOPENED';
ALTER TYPE "WorkflowStatus" ADD VALUE 'EMERGENCY';
ALTER TYPE "WorkflowStatus" ADD VALUE 'AWAITING_CONFIRMATION';
ALTER TYPE "WorkflowStatus" ADD VALUE 'ASSIGNED';
ALTER TYPE "WorkflowStatus" ADD VALUE 'DUPLICATE_MERGED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "VoiceReportStatus" ADD VALUE 'VOICE_RECEIVED';
ALTER TYPE "VoiceReportStatus" ADD VALUE 'TRANSCRIBING';
ALTER TYPE "VoiceReportStatus" ADD VALUE 'EXTRACTION_PENDING';
ALTER TYPE "VoiceReportStatus" ADD VALUE 'AWAITING_CONFIRMATION';
ALTER TYPE "VoiceReportStatus" ADD VALUE 'SAFETY_CHECK';
ALTER TYPE "VoiceReportStatus" ADD VALUE 'DUPLICATE_CHECK';
ALTER TYPE "VoiceReportStatus" ADD VALUE 'ASSIGNMENT_PENDING';
ALTER TYPE "VoiceReportStatus" ADD VALUE 'ASSIGNED';
ALTER TYPE "VoiceReportStatus" ADD VALUE 'IN_PROGRESS';
ALTER TYPE "VoiceReportStatus" ADD VALUE 'COMPLETED_BY_ASSIGNEE';
ALTER TYPE "VoiceReportStatus" ADD VALUE 'REPORTER_VERIFICATION_PENDING';
ALTER TYPE "VoiceReportStatus" ADD VALUE 'REPORTER_CONFIRMED';
ALTER TYPE "VoiceReportStatus" ADD VALUE 'REPORTER_REJECTED';
ALTER TYPE "VoiceReportStatus" ADD VALUE 'REOPENED';
ALTER TYPE "VoiceReportStatus" ADD VALUE 'OVERDUE';
ALTER TYPE "VoiceReportStatus" ADD VALUE 'ESCALATED';
ALTER TYPE "VoiceReportStatus" ADD VALUE 'CLOSED';
ALTER TYPE "VoiceReportStatus" ADD VALUE 'EMERGENCY';

-- DropForeignKey
ALTER TABLE "Incident" DROP CONSTRAINT "Incident_voiceReportId_fkey";

-- DropIndex
DROP INDEX "Incident_voiceReportId_key";

-- AlterTable
ALTER TABLE "VoiceReport" ADD COLUMN     "audioQuality" "AudioQuality" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "incidentId" TEXT,
ADD COLUMN     "retryCount" INTEGER NOT NULL DEFAULT 0;

-- Preserve the former one-report-to-one-incident association while moving to one-to-many.
UPDATE "VoiceReport" AS report
SET "incidentId" = incident."id"
FROM "Incident" AS incident
WHERE incident."voiceReportId" = report."id";

-- AlterTable
ALTER TABLE "Incident" DROP COLUMN "voiceReportId",
ADD COLUMN     "duplicateGroupId" TEXT,
ADD COLUMN     "duplicateOfIncidentId" TEXT,
ADD COLUMN     "emergencyStatus" TEXT,
ADD COLUMN     "isEmergency" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reopenReason" TEXT,
ADD COLUMN     "reopenedAt" TIMESTAMP(3),
ADD COLUMN     "reporterVerificationStatus" "VerificationStatus",
ADD COLUMN     "reporterVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ClosureVerification" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "response" TEXT,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "evidenceRef" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClosureVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyEvent" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "triggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "alertedAt" TIMESTAMP(3),
    "responseDeadline" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "EmergencyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DuplicateReview" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "existingIncidentId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "status" "DuplicateReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DuplicateReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClosureVerification_incidentId_requestedAt_idx" ON "ClosureVerification"("incidentId", "requestedAt");

-- CreateIndex
CREATE INDEX "ClosureVerification_reporterId_status_idx" ON "ClosureVerification"("reporterId", "status");

-- CreateIndex
CREATE INDEX "EmergencyEvent_incidentId_triggeredAt_idx" ON "EmergencyEvent"("incidentId", "triggeredAt");

-- CreateIndex
CREATE INDEX "EmergencyEvent_status_triggeredAt_idx" ON "EmergencyEvent"("status", "triggeredAt");

-- CreateIndex
CREATE INDEX "DuplicateReview_status_createdAt_idx" ON "DuplicateReview"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DuplicateReview_candidateId_existingIncidentId_key" ON "DuplicateReview"("candidateId", "existingIncidentId");

-- CreateIndex
CREATE INDEX "VoiceReport_incidentId_createdAt_idx" ON "VoiceReport"("incidentId", "createdAt");

-- AddForeignKey
ALTER TABLE "VoiceReport" ADD CONSTRAINT "VoiceReport_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_duplicateOfIncidentId_fkey" FOREIGN KEY ("duplicateOfIncidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClosureVerification" ADD CONSTRAINT "ClosureVerification_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClosureVerification" ADD CONSTRAINT "ClosureVerification_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyEvent" ADD CONSTRAINT "EmergencyEvent_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuplicateReview" ADD CONSTRAINT "DuplicateReview_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuplicateReview" ADD CONSTRAINT "DuplicateReview_existingIncidentId_fkey" FOREIGN KEY ("existingIncidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;
