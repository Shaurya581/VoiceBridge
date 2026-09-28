-- Persist the reporter's spoken verification request and bounded delivery retries.
ALTER TABLE "ClosureVerification"
ADD COLUMN "taskCompletedAt" TIMESTAMP(3),
ADD COLUMN "language" TEXT NOT NULL DEFAULT 'hi',
ADD COLUMN "prompt" TEXT NOT NULL DEFAULT '',
ADD COLUMN "deliveryMode" TEXT NOT NULL DEFAULT 'MOCK',
ADD COLUMN "deliveryStatus" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastAttemptAt" TIMESTAMP(3);

CREATE INDEX "ClosureVerification_deliveryStatus_attemptCount_requestedAt_idx"
ON "ClosureVerification"("deliveryStatus", "attemptCount", "requestedAt");

WITH "closurePromptSource" AS (
    SELECT
        verification."id",
        CASE
            WHEN lower(COALESCE(report."language", '')) LIKE 'ta%' THEN 'ta'
            WHEN lower(COALESCE(report."language", '')) = 'hinglish' THEN 'hinglish'
            ELSE 'hi'
        END AS "language",
        COALESCE(NULLIF(btrim(incident."asset"), ''), incident."title") AS "subject"
    FROM "ClosureVerification" verification
    JOIN "Incident" incident ON incident."id" = verification."incidentId"
    LEFT JOIN LATERAL (
        SELECT voice."language"
        FROM "VoiceReport" voice
        WHERE voice."incidentId" = incident."id"
        ORDER BY voice."createdAt" ASC
        LIMIT 1
    ) report ON TRUE
)
UPDATE "ClosureVerification" verification
SET
    "language" = source."language",
    "prompt" = CASE source."language"
        WHEN 'ta' THEN source."subject" || ' தொடர்பான பிரச்சினை சரிசெய்யப்பட்டதாகக் குறிக்கப்பட்டுள்ளது. சரியாகிவிட்டால் 1 ஐ அழுத்துங்கள். இன்னும் பிரச்சினை இருந்தால் 2 ஐ அழுத்துங்கள்.'
        WHEN 'hinglish' THEN source."subject" || ' ka issue theek kiya gaya hai. Agar ab theek hai to 1 dabayein. Agar issue abhi bhi hai to 2 dabayein.'
        ELSE source."subject" || ' की समस्या ठीक बताई गई है। अगर समस्या ठीक हो गई है तो 1 दबाएँ। अगर समस्या अभी भी है तो 2 दबाएँ।'
    END
FROM "closurePromptSource" source
WHERE verification."id" = source."id";

-- Retain the explicit assignee-completion state for earlier pending closure records.
UPDATE "Task" task
SET "status" = 'COMPLETED_BY_ASSIGNEE'
FROM "Incident" incident
WHERE task."incidentId" = incident."id"
  AND task."status" = 'COMPLETED'
  AND incident."status" = 'REPORTER_VERIFICATION_PENDING';
