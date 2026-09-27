export interface AthleteContext {
  readinessScore?: number;
  mainGoal?: string;
  activeGoalTitle?: string;
  activeGoalTarget?: string;
  activeGoalRaceDate?: string;
  activeGoalWeeksRemaining?: number;
  totalKm?: number;
  completedRaces?: number;
  selectedSports?: string[];
  [key: string]: any;
}

export interface InteractionData {
  type?: "chat" | "adaptation" | "rpe_check_in" | "workout_generation" | string;
  userPrompt?: string;
  aiResponse?: string;
  suggestedAction?: any;
  adaptationType?: string;
  workoutId?: string;
  workoutDetails?: any;
  [key: string]: any;
}

export interface FeedbackData {
  rating?: number;
  feedbackLabel?: string;
  aiPreservationMessage?: string;
  userComment?: string;
  acceptedSuggestion?: boolean;
  [key: string]: any;
}

export interface TrainingInteractionLogInput {
  userId: string;
  interactionType?: string;
  interaction?: InteractionData | any;
  athleteContext?: AthleteContext | any;
  feedback?: FeedbackData | any;
  metadata?: Record<string, any>;
  timestamp?: string | Date;
}

export interface DatalakeRecord {
  anonymousUserId: string;
  timestamp: string;
  schemaVersion: string;
  year: number;
  month: number;
  day: number;
  interactionType: string;
  interaction: any;
  athleteContext: any;
  feedback: any;
  metadata: Record<string, any>;
}
