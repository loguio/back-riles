-- RILES-033 : Community (Phase 5B) — clubs de course, sorties collectives,
-- participants et défis mensuels. Strictement additif : aucune table ni colonne
-- existante n'est modifiée.

-- CreateEnum
CREATE TYPE "ChallengeMetric" AS ENUM ('distance', 'duration', 'elevation', 'sessions');

-- CreateTable
CREATE TABLE "running_clubs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "running_clubs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_runs" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "location" TEXT NOT NULL,
    "theme" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "community_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_run_participants" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_run_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monthly_challenges" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "metric" "ChallengeMetric" NOT NULL,
    "target" DOUBLE PRECISION NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monthly_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "running_clubs_slug_key" ON "running_clubs"("slug");

-- CreateIndex
CREATE INDEX "running_clubs_ownerId_idx" ON "running_clubs"("ownerId");

-- CreateIndex
CREATE INDEX "community_runs_clubId_scheduledAt_idx" ON "community_runs"("clubId", "scheduledAt");

-- CreateIndex
CREATE INDEX "community_runs_scheduledAt_idx" ON "community_runs"("scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "community_run_participants_runId_userId_key" ON "community_run_participants"("runId", "userId");

-- CreateIndex
CREATE INDEX "community_run_participants_userId_joinedAt_idx" ON "community_run_participants"("userId", "joinedAt");

-- CreateIndex
CREATE INDEX "monthly_challenges_periodStart_periodEnd_idx" ON "monthly_challenges"("periodStart", "periodEnd");

-- AddForeignKey
ALTER TABLE "running_clubs" ADD CONSTRAINT "running_clubs_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_runs" ADD CONSTRAINT "community_runs_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "running_clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_run_participants" ADD CONSTRAINT "community_run_participants_runId_fkey" FOREIGN KEY ("runId") REFERENCES "community_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_run_participants" ADD CONSTRAINT "community_run_participants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
