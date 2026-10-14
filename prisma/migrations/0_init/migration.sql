-- CreateEnum
CREATE TYPE "WorkoutStatus" AS ENUM ('done', 'selected', 'rest', 'upcoming');

-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('email', 'apple', 'google');

-- CreateEnum
CREATE TYPE "PlanType" AS ENUM ('basic', 'pro');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "name" TEXT NOT NULL,
    "initials" TEXT NOT NULL,
    "readinessScore" INTEGER NOT NULL DEFAULT 88,
    "activeGoalTitle" TEXT NOT NULL DEFAULT 'Semi-marathon de Paris',
    "activeGoalTarget" TEXT NOT NULL DEFAULT 'Passer sous les 2h',
    "activeGoalRaceDate" TEXT NOT NULL DEFAULT '17 mars 2025',
    "activeGoalWeeksRemaining" INTEGER NOT NULL DEFAULT 6,
    "activeGoalProgressPercentage" INTEGER NOT NULL DEFAULT 65,
    "activeWeeks" INTEGER NOT NULL DEFAULT 12,
    "totalKm" DOUBLE PRECISION NOT NULL DEFAULT 328.0,
    "completedRaces" INTEGER NOT NULL DEFAULT 4,
    "atlFatigue" DOUBLE PRECISION NOT NULL DEFAULT 42.0,
    "ctlFitness" DOUBLE PRECISION NOT NULL DEFAULT 48.0,
    "tsbForm" DOUBLE PRECISION NOT NULL DEFAULT 6.0,
    "sleepScore" INTEGER NOT NULL DEFAULT 82,
    "hrvStatus" TEXT NOT NULL DEFAULT 'balanced',
    "planType" "PlanType" NOT NULL DEFAULT 'pro',
    "authProvider" "AuthProvider" NOT NULL DEFAULT 'email',
    "isOnboardingCompleted" BOOLEAN NOT NULL DEFAULT true,
    "mainGoal" TEXT,
    "selectedSports" TEXT[] DEFAULT ARRAY['running']::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "life_rules" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "life_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workouts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "dayName" TEXT NOT NULL,
    "dayNumber" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "weekNumber" INTEGER NOT NULL,
    "fullDateLabel" TEXT NOT NULL,
    "timeLabel" TEXT,
    "status" "WorkoutStatus" NOT NULL DEFAULT 'upcoming',
    "isRestDay" BOOLEAN NOT NULL DEFAULT false,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "duration" TEXT NOT NULL,
    "distance" TEXT NOT NULL,
    "targetPace" TEXT NOT NULL,
    "targetZoneLabel" TEXT NOT NULL,
    "targetZoneBpm" TEXT NOT NULL,
    "targetZoneSegments" JSONB NOT NULL,
    "pinPositionPercent" DOUBLE PRECISION NOT NULL DEFAULT 50,
    "effortBlocks" JSONB NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "aiAdjustmentNote" TEXT,
    "tss" DOUBLE PRECISION,
    "externalActivityId" TEXT,
    "sourceProvider" TEXT,
    "actualDistanceKm" DOUBLE PRECISION,
    "actualDurationSec" INTEGER,
    "actualPace" TEXT,
    "actualAvgHeartRate" INTEGER,
    "actualMaxHeartRate" INTEGER,
    "actualElevationGain" DOUBLE PRECISION,
    "actualCalories" INTEGER,
    "actualCadence" INTEGER,
    "actualSplitsJson" JSONB,
    "completedAt" TIMESTAMP(3),
    "sportType" TEXT DEFAULT 'running',
    "isCommute" BOOLEAN DEFAULT false,
    "secondaryActivities" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rpe_checkins" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workoutId" TEXT,
    "rating" INTEGER NOT NULL,
    "feedbackLabel" TEXT NOT NULL,
    "textComment" TEXT,
    "perceivedLegs" TEXT,
    "aiPreservationMessage" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rpe_checkins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "externalUserId" TEXT,
    "isConnected" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "timestamp" TEXT NOT NULL,
    "suggestedAction" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quick_prompts" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "quick_prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "life_rules_userId_idx" ON "life_rules"("userId");

-- CreateIndex
CREATE INDEX "workouts_userId_weekNumber_year_idx" ON "workouts"("userId", "weekNumber", "year");

-- CreateIndex
CREATE INDEX "workouts_userId_month_year_idx" ON "workouts"("userId", "month", "year");

-- CreateIndex
CREATE INDEX "workouts_dateKey_idx" ON "workouts"("dateKey");

-- CreateIndex
CREATE UNIQUE INDEX "workouts_userId_dateKey_key" ON "workouts"("userId", "dateKey");

-- CreateIndex
CREATE INDEX "rpe_checkins_userId_idx" ON "rpe_checkins"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "sync_tokens_userId_provider_key" ON "sync_tokens"("userId", "provider");

-- CreateIndex
CREATE INDEX "chat_messages_userId_idx" ON "chat_messages"("userId");

-- AddForeignKey
ALTER TABLE "life_rules" ADD CONSTRAINT "life_rules_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workouts" ADD CONSTRAINT "workouts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rpe_checkins" ADD CONSTRAINT "rpe_checkins_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rpe_checkins" ADD CONSTRAINT "rpe_checkins_workoutId_fkey" FOREIGN KEY ("workoutId") REFERENCES "workouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_tokens" ADD CONSTRAINT "sync_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

