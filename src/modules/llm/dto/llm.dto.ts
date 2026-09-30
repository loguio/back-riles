import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export type SafetyStatus =
  | "safe"
  | "warning_fatigue"
  | "medical_stop"
  | "unrealistic_goal";

export type EligibilityStatus =
  | "ELIGIBLE"
  | "CONTEXT_NEEDED"
  | "WARNING"
  | "UNREALISTIC_DANGEROUS";

export interface ExtractedGoalDto {
  title: string;
  target: string;
  raceDate: string;
  weeksRemaining: number;
  distanceKm?: number;
}

export interface ExtractedRuleDto {
  title: string;
  description: string;
  icon: string;
}

export interface RecentSessionMetricDto {
  avgPaceSecPerKm: number; // ex: 345 pour 5:45/km
  avgHeartRate?: number; // ex: 144 bpm
  maxHeartRate?: number; // ex: 188 bpm
  distanceKm?: number; // ex: 10.5 km
}

export interface StravaMonthlyStatDto {
  monthKey: string; // ex: "2026-05"
  monthLabel: string; // ex: "Mai"
  label?: string; // alias "Mai"
  totalKm: number;
  sessionsCount: number;
  avgPace: string;
}

export interface StravaSportsBreakdownDto {
  runningSessions: number;
  runningKm: number;
  cyclingSessions: number;
  cyclingKm: number;
  swimmingSessions: number;
  strengthAndOtherSessions: number;
  crossTrainingHours: number;
}

export interface StravaSixMonthsSummaryDto {
  periodMonths: number; // 6
  startDateKey: string;
  endDateKey: string;
  periodStartDate?: string;
  periodEndDate?: string;
  totalActivities: number;
  totalSessions?: number;
  totalDistanceKm: number;
  totalKm?: number;
  totalDurationHours: number;
  totalElevationGainM: number;
  activeWeeks: number;
  averageWeeklyKm: number;
  avgWeeklyKm?: number;
  recent4WeeksAvgKm: number;
  longestRunKm: number;
  avgHeartRate: number;
  maxHeartRateObserved: number;
  ctlFitness?: number;
  atlFatigue?: number;
  tsbForm?: number;
  easyPaceRange?: string;
  thresholdPace?: string;
  estimatedPaces: TargetPacesDto & {
    easyPaceRange?: string;
    thresholdPace?: string;
    intervalPace?: string;
  };
  banisterLoad: {
    ctlFitness: number;
    atlFatigue: number;
    tsbForm: number;
    readinessScore: number;
  };
  sportsBreakdown?: StravaSportsBreakdownDto;
  monthlyBreakdown: StravaMonthlyStatDto[];
  ahaInsight: string;
  syncedAt: string;
  sourceMode: "strava_oauth_live" | "strava_history_import";
}

export interface AthleteTrainingContextDto {
  hasSyncedHistory?: boolean;
  recentWeeklyKm?: number;
  recent4WeeksAvgKm?: number;
  totalKm6Months?: number;
  longestRecentRunKm?: number;
  activeWeeks?: number;
  hrMax?: number;
  restingHr?: number;
  importedThresholdPaceSecPerKm?: number;
  importedEasyPaceSecPerKm?: number;
  recentSessions?: RecentSessionMetricDto[];
  sixMonthsSummary?: StravaSixMonthsSummaryDto;
}

export interface TargetPacesDto {
  easyPaceZ2: string;
  marathonPaceZ3: string;
  thresholdPaceZ4: string;
  intervalPaceZ5: string;
  targetRacePace: string;
  calibrationSource?: "watch_zones" | "recent_sessions_hr" | "default_baseline";
}

export interface EligibilityResultDto {
  status: EligibilityStatus;
  isRealistic: boolean;
  pedagogicalMessage: string;
  suggestedAlternative?: string;
}

export class ReformulateGoalResultDto {
  @ApiProperty({
    example:
      "Préparer le Semi-Marathon de Paris (objectif sub-1h45) avec prévention mollets et jeudi sanctuarisé.",
  })
  reformulatedGoal: string;

  @ApiProperty()
  extractedGoal: ExtractedGoalDto;

  @ApiProperty()
  extractedRules: ExtractedRuleDto[];

  @ApiProperty()
  targetPaces: TargetPacesDto;

  @ApiProperty()
  eligibility: EligibilityResultDto;
}

export interface CalendarDaySlotDto {
  dateKey: string; // "YYYY-MM-DD"
  dayName: string; // "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"
  dayNumber: number;
  month: number; // 0-11
  year: number;
  weekNumber: number;
  fullDateLabel: string; // "MERCREDI 14 OCTOBRE"
}

export interface GeneratedWorkoutItemDto {
  dateKey: string;
  dayName: string;
  dayNumber: number;
  month: number;
  year: number;
  weekNumber: number;
  fullDateLabel: string;
  timeLabel?: string;
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
  aiAdjustmentNote?: string;
  tss?: number;
}

export interface MultiWeekPlanGenerationInput {
  userProfile: {
    name: string;
    mainGoal?: string;
    activeGoalTitle: string;
    activeGoalTarget: string;
    activeGoalRaceDate: string;
    activeGoalWeeksRemaining: number;
    selectedSports: string[];
  };
  physiologicalState: {
    readinessScore: number;
    totalKm: number;
    activeWeeks: number;
    recentWeeklyKm: number;
    atlFatigue: number;
    ctlFitness: number;
    tsbForm: number;
    sleepScore: number;
    hrvStatus: string;
  };
  calculatedPaces: TargetPacesDto;
  lifeRules: Array<{ title: string; description: string; icon: string }>;
  recentCompletedSessions: Array<{
    dateKey: string;
    title: string;
    actualDistanceKm?: number;
    actualPace?: string;
    actualAvgHeartRate?: number;
    actualMaxHeartRate?: number;
    rpeRating?: number;
  }>;
  sixMonthsStravaSummary?: StravaSixMonthsSummaryDto;
  calendarSlots: CalendarDaySlotDto[];
}

export interface MultiWeekPlanGenerationOutput {
  planSummary: string;
  modelUsed: string;
  workouts: GeneratedWorkoutItemDto[];
}

export interface LlmCoachReplyInput {
  userPrompt: string;
  athleteContext: {
    userName?: string;
    readinessScore?: number;
    activeGoalTitle?: string;
    activeGoalTarget?: string;
    activeGoalRaceDate?: string;
    activeGoalWeeksRemaining?: number;
    totalKm?: number;
    activeWeeks?: number;
    atlFatigue?: number;
    ctlFitness?: number;
    tsbForm?: number;
    selectedSports?: string[];
    rules?: Array<{ id?: string; title: string; description: string; icon: string }>;
    trainingContext?: AthleteTrainingContextDto;
    activeWorkout?: {
      id?: string;
      dateKey?: string;
      title?: string;
      category?: string;
      duration?: string;
      distance?: string;
      targetPace?: string;
      targetZoneLabel?: string;
    };
    currentWeekWorkouts?: Array<{
      id?: string;
      dateKey: string;
      dayName: string;
      status: string;
      isRestDay: boolean;
      title: string;
      duration: string;
      distance: string;
      targetPace: string;
      actualDistanceKm?: number | null;
      actualPace?: string | null;
      actualAvgHeartRate?: number | null;
    }>;
    lastRpe?: {
      rating?: number;
      feedbackLabel?: string;
    };
  };
}

export interface LlmCoachSuggestedAction {
  type:
    | "adjust_workout"
    | "reschedule"
    | "reduce_intensity"
    | "add_life_rule"
    | "recalculate_week";
  label: string;
  applied: boolean;
  workoutId?: string;
  details: string;
  ruleData?: ExtractedRuleDto;
}

export interface LlmCoachReplyOutput {
  replyText: string;
  reformulatedIntent?: string;
  safetyStatus: SafetyStatus;
  suggestedAction?: LlmCoachSuggestedAction;
  recalculatedWeekWorkouts?: Array<{
    dateKey: string;
    isRestDay?: boolean;
    category?: string;
    title: string;
    duration: string;
    distance: string;
    targetPace?: string;
    targetZoneLabel?: string;
    targetZoneBpm?: string;
    aiAdjustmentNote?: string;
    tags?: string[];
  }>;
  modelUsed: string;
}
