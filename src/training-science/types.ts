/**
 * Domain types for the training-science core (RILES-035).
 *
 * Structurally compatible with the LLM DTOs (src/modules/llm/dto/llm.dto.ts)
 * but deliberately NOT imported from there: the core must stay free of
 * NestJS / provider-layer dependencies.
 */

/** Pace (sec/km) + heart-rate metrics of one performed running session. */
export interface RecentSessionMetric {
  avgPaceSecPerKm: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  distanceKm?: number;
}

/** Subset of the athlete training context read by the pace engine. */
export interface AthleteTrainingContext {
  hrMax?: number;
  importedThresholdPaceSecPerKm?: number;
  importedEasyPaceSecPerKm?: number;
  recentSessions?: RecentSessionMetric[];
}

/** Physiological training paces (strings in /km) used across plan generation. */
export interface TargetPaces {
  easyPaceZ2: string;
  marathonPaceZ3: string;
  thresholdPaceZ4: string;
  intervalPaceZ5: string;
  targetRacePace: string;
  calibrationSource?: "watch_zones" | "recent_sessions_hr" | "default_baseline";
}

/** Prisma workout columns read when converting workouts to session metrics. */
export interface SessionWorkoutSource {
  actualPace?: string | null;
  actualAvgHeartRate?: number | null;
  actualMaxHeartRate?: number | null;
  actualDistanceKm?: number | null;
  targetPace?: string | null;
  targetZoneBpm?: string | null;
  distance?: string | null;
  isRestDay?: boolean;
  isCommute?: boolean;
  sportType?: string | null;
}

/** Object form of computeSessionTss. */
export interface SessionTssInput {
  durationSec: number;
  distanceKm?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
}

/** Object form of updateBanisterLoad. */
export interface BanisterLoadInput {
  previousAtl: number;
  previousCtl: number;
  todayTss: number;
  sleepScore?: number;
  hrvStatus?: string;
}

/** Banister impulse-response output: ATL / CTL / TSB / readiness. */
export interface BanisterLoadResult {
  atlFatigue: number;
  ctlFitness: number;
  tsbForm: number;
  readinessScore: number;
}

/** Life rule entry used to lock training days. */
export interface LifeRule {
  title: string;
  description: string;
}

/** One calendar slot of a multi-week plan (mirrors CalendarDaySlotDto). */
export interface PlanCalendarSlot {
  dateKey: string;
  dayName: string;
  dayNumber: number;
  month: number;
  year: number;
  weekNumber: number;
  fullDateLabel: string;
}

/** Normalized workout item produced by plan generation. */
export interface GeneratedPlanWorkout extends PlanCalendarSlot {
  timeLabel: string;
  isRestDay: boolean;
  category: string;
  title: string;
  duration: string;
  distance: string;
  targetPace: string;
  targetZoneLabel: string;
  targetZoneBpm: string;
  targetZoneSegments: Array<{ color: string; flex: number }>;
  pinPositionPercent: number;
  effortBlocks: Array<{
    title: string;
    durationLabel: string;
    type: "warmup" | "threshold" | "cooldown" | "interval" | "recovery";
    flexRatio: number;
  }>;
  tags: string[];
  aiAdjustmentNote: string;
  tss: number;
}

/** Weekly volume metrics produced by the 3:1 periodization model. */
export interface PeriodizedWeekMetrics {
  targetKm: number;
  isDeload: boolean;
  isTaper: boolean;
  phaseLabel: string;
}

/** Input consumed by the deterministic periodized fallback generator. */
export interface PeriodizationPlanInput {
  userProfile: {
    activeGoalTitle: string;
    activeGoalTarget: string;
    [key: string]: any;
  };
  physiologicalState?: { recentWeeklyKm?: number; [key: string]: any };
  sixMonthsStravaSummary?: {
    totalActivities: number;
    totalDistanceKm: number;
    recent4WeeksAvgKm: number;
    longestRunKm: number;
    [key: string]: any;
  };
  calendarSlots: PlanCalendarSlot[];
  [key: string]: any;
}

/** Result of a plan generation (LLM or deterministic fallback). */
export interface MultiWeekPlanResult {
  planSummary: string;
  modelUsed: string;
  workouts: GeneratedPlanWorkout[];
}
