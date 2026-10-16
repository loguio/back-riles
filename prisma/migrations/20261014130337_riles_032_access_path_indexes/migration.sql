-- DropIndex
DROP INDEX "chat_messages_userId_idx";

-- DropIndex
DROP INDEX "rpe_checkins_userId_idx";

-- CreateIndex
CREATE INDEX "chat_messages_userId_createdAt_idx" ON "chat_messages"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "rpe_checkins_workoutId_idx" ON "rpe_checkins"("workoutId");

-- CreateIndex
CREATE INDEX "rpe_checkins_userId_submittedAt_idx" ON "rpe_checkins"("userId", "submittedAt");
