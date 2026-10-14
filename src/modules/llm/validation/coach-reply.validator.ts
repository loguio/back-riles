// Les schémas ci-dessous sont décorés au chargement du module : le polyfill
// Reflect (déjà chargé par le runtime Nest) doit être présent dès cet import.
import "reflect-metadata";
import { plainToInstance, Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
  validateSync,
  type ValidationError,
} from "class-validator";
import type { SafetyStatus } from "../dto/llm.dto";

/**
 * RILES-011 — Schémas stricts des sorties du modèle.
 *
 * Le modèle renvoyait du JSON désérialisé avec un simple `JSON.parse(...) as T`
 * : tout champ inventé (dateKey arbitraire, type d'action inconnu, règles de
 * vie hors schéma) était ensuite écrit en base via `updateMany` / `create`.
 *
 * Ici, TOUTE sortie de modèle destinée à déclencher une écriture passe par ces
 * schémas :
 *  - champs inconnus => rejet (`forbidNonWhitelisted`) ;
 *  - valeurs hors énumération (type/details/safetyStatus/icône) => rejet ;
 *  - types incorrects (applied: "true", dateKey: "demain") => rejet ;
 *  - bornes de longueur sur toutes les chaînes persistées.
 *
 * `sanitizeWeekWorkoutChanges` ajoute la liste blanche opérationnelle : le
 * `dateKey` doit appartenir à la semaine réellement ciblée de l'athlète, sinon
 * la proposition est écartée (aucune écriture possible sur une ligne choisie
 * par le modèle).
 */

export const SAFETY_STATUSES = [
  "safe",
  "warning_fatigue",
  "medical_stop",
  "unrealistic_goal",
] as const;

export const SUGGESTED_ACTION_TYPES = [
  "adjust_workout",
  "reschedule",
  "reduce_intensity",
  "add_life_rule",
  "recalculate_week",
] as const;

export const SUGGESTED_ACTION_DETAILS = [
  "lighten",
  "easy_run",
  "postpone",
  "injury_care",
  "add_life_rule",
  "increase_volume",
  "decrease_volume",
] as const;

export const LIFE_RULE_ICONS = [
  "calendar-lock",
  "clock-outline",
  "bullseye-arrow",
  "sleep",
] as const;

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const STRICT_OPTIONS = {
  forbidUnknownValues: true,
  forbidNonWhitelisted: true,
  whitelist: true,
  validationError: { target: false },
};

export type SuggestedActionType = (typeof SUGGESTED_ACTION_TYPES)[number];
export type SuggestedActionDetail = (typeof SUGGESTED_ACTION_DETAILS)[number];

export interface ValidatedRuleData {
  title: string;
  description: string;
  icon: string;
}

export interface ValidatedSuggestedAction {
  type: SuggestedActionType;
  label: string;
  applied: boolean;
  workoutId?: string;
  details?: SuggestedActionDetail;
  ruleData?: ValidatedRuleData;
}

export interface ValidatedWeekWorkoutChange {
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
}

export interface ValidatedCoachReply {
  replyText: string;
  reformulatedIntent?: string;
  safetyStatus?: SafetyStatus;
  suggestedAction?: ValidatedSuggestedAction;
  recalculatedWeekWorkouts?: ValidatedWeekWorkoutChange[];
}

/**
 * Résultat d'une validation : `ok` + `errors` (toujours présent, vide quand
 * `ok === true`) + `value` (uniquement si `ok`). Le repo compile avec
 * `strictNullChecks: false`, mode où TypeScript n'affine pas les unions
 * discriminées — cette structure simple reste donc lisible partout.
 */
export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  errors: string[];
}

class RuleDataSchema {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(8000)
  description!: string;

  @IsString()
  @IsIn([...LIFE_RULE_ICONS])
  icon!: string;
}

class SuggestedActionSchema {
  @IsIn([...SUGGESTED_ACTION_TYPES])
  type!: SuggestedActionType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  label!: string;

  @IsBoolean()
  applied!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  workoutId?: string;

  @IsOptional()
  @IsIn([...SUGGESTED_ACTION_DETAILS])
  details?: SuggestedActionDetail;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => RuleDataSchema)
  ruleData?: RuleDataSchema;
}

class WeekWorkoutChangeSchema {
  @Matches(DATE_KEY_PATTERN)
  dateKey!: string;

  @IsOptional()
  @IsBoolean()
  isRestDay?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  duration!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  distance!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  targetPace?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  targetZoneLabel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  targetZoneBpm?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  aiAdjustmentNote?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(16)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  tags?: string[];
}

class CoachReplySchema {
  @IsString()
  @IsNotEmpty()
  @MaxLength(8000)
  replyText!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reformulatedIntent?: string;

  @IsOptional()
  @IsIn([...SAFETY_STATUSES])
  safetyStatus?: SafetyStatus;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => SuggestedActionSchema)
  suggestedAction?: SuggestedActionSchema;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WeekWorkoutChangeSchema)
  recalculatedWeekWorkouts?: WeekWorkoutChangeSchema[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenErrors(errors: ValidationError[], parentPath = ""): string[] {
  const messages: string[] = [];
  for (const error of errors) {
    const path = parentPath
      ? `${parentPath}.${error.property}`
      : error.property;
    for (const message of Object.values(error.constraints ?? {})) {
      messages.push(`${path}: ${message}`);
    }
    if (error.children && error.children.length > 0) {
      messages.push(...flattenErrors(error.children, path));
    }
  }
  return messages;
}

function validateStrict<T extends object>(
  raw: unknown,
  schema: new () => T,
): T | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const instance = plainToInstance(schema, raw);
  const errors = validateSync(instance, STRICT_OPTIONS);
  return errors.length > 0 ? null : instance;
}

function toSuggestedAction(
  source: SuggestedActionSchema,
): ValidatedSuggestedAction {
  const action: ValidatedSuggestedAction = {
    type: source.type,
    label: source.label,
    applied: source.applied,
  };
  if (source.workoutId !== undefined) {
    action.workoutId = source.workoutId;
  }
  if (source.details !== undefined) {
    action.details = source.details;
  }
  if (source.ruleData !== undefined) {
    action.ruleData = {
      title: source.ruleData.title,
      description: source.ruleData.description,
      icon: source.ruleData.icon,
    };
  }
  return action;
}

function toWeekWorkoutChange(
  source: WeekWorkoutChangeSchema,
): ValidatedWeekWorkoutChange {
  const change: ValidatedWeekWorkoutChange = {
    dateKey: source.dateKey,
    title: source.title,
    duration: source.duration,
    distance: source.distance,
  };
  if (source.isRestDay !== undefined) {
    change.isRestDay = source.isRestDay;
  }
  if (source.category !== undefined) {
    change.category = source.category;
  }
  if (source.targetPace !== undefined) {
    change.targetPace = source.targetPace;
  }
  if (source.targetZoneLabel !== undefined) {
    change.targetZoneLabel = source.targetZoneLabel;
  }
  if (source.targetZoneBpm !== undefined) {
    change.targetZoneBpm = source.targetZoneBpm;
  }
  if (source.aiAdjustmentNote !== undefined) {
    change.aiAdjustmentNote = source.aiAdjustmentNote;
  }
  if (source.tags !== undefined) {
    change.tags = [...source.tags];
  }
  return change;
}

/**
 * Valide une sortie de coach déjà désérialisée (objet JSON du modèle).
 * Tout champ inconnu ou valeur hors schéma => rejet.
 */
export function validateCoachReplyOutput(
  raw: unknown,
): ValidationResult<ValidatedCoachReply> {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      errors: [`coachReply: objet JSON attendu mais reçu ${typeof raw}`],
    };
  }

  const instance = plainToInstance(CoachReplySchema, raw);
  const errors = validateSync(instance, STRICT_OPTIONS);
  if (errors.length > 0) {
    return { ok: false, errors: flattenErrors(errors) };
  }

  if (
    instance.recalculatedWeekWorkouts !== undefined &&
    instance.recalculatedWeekWorkouts.some((item) => !isPlainObject(item))
  ) {
    return {
      ok: false,
      errors: ["recalculatedWeekWorkouts: élément non objet"],
    };
  }

  const value: ValidatedCoachReply = {
    replyText: instance.replyText,
  };
  if (instance.reformulatedIntent !== undefined) {
    value.reformulatedIntent = instance.reformulatedIntent;
  }
  if (instance.safetyStatus !== undefined) {
    value.safetyStatus = instance.safetyStatus;
  }
  if (instance.suggestedAction !== undefined) {
    value.suggestedAction = toSuggestedAction(instance.suggestedAction);
  }
  if (instance.recalculatedWeekWorkouts !== undefined) {
    value.recalculatedWeekWorkouts =
      instance.recalculatedWeekWorkouts.map(toWeekWorkoutChange);
  }
  return { ok: true, value, errors: [] };
}

/**
 * Nettoie les éventuelles fences markdown puis valide la sortie du modèle.
 * JSON malformé => rejet explicite (aucune écriture possible en aval).
 */
export function parseCoachReplyModelJson(
  rawContent: string,
): ValidationResult<ValidatedCoachReply> {
  if (typeof rawContent !== "string" || rawContent.trim().length === 0) {
    return { ok: false, errors: ["coachReply: contenu vide"] };
  }
  const cleaned = rawContent
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [`coachReply: JSON malformé (${message})`] };
  }
  return validateCoachReplyOutput(parsed);
}

/**
 * Valide une action suggérée par le modèle. Retourne `null` (aucune écriture,
 * aucune action exposée au client) si elle est absente ou hors schéma.
 */
export function sanitizeSuggestedAction(
  raw: unknown,
): ValidatedSuggestedAction | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const instance = validateStrict(raw, SuggestedActionSchema);
  return instance ? toSuggestedAction(instance) : null;
}

/**
 * Valide puis filtre les modifications de semaine proposées par le modèle.
 *
 * - `schemaErrors` non vide => AU MOINS UN élément est hors schéma : le lot
 *   entier est rejeté (aucune écriture), conformément à l'AC
 *   « out-of-schema model JSON is rejected and nothing is written » ;
 * - `droppedDateKeys` => éléments bien formés dont le `dateKey` n'appartient
 *   pas à la semaine autorisée de l'athlète (liste blanche) : écartés.
 */
export interface WeekChangeSanitization {
  changes: ValidatedWeekWorkoutChange[];
  schemaErrors: string[];
  droppedDateKeys: string[];
}

export function sanitizeWeekWorkoutChanges(
  raw: unknown,
  allowedDateKeys: Iterable<string>,
): WeekChangeSanitization {
  const allowed = new Set<string>(allowedDateKeys);

  if (raw === undefined || raw === null) {
    return { changes: [], schemaErrors: [], droppedDateKeys: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      changes: [],
      schemaErrors: [
        `recalculatedWeekWorkouts: tableau attendu mais reçu ${typeof raw}`,
      ],
      droppedDateKeys: [],
    };
  }
  if (raw.length === 0) {
    return { changes: [], schemaErrors: [], droppedDateKeys: [] };
  }

  const validated: ValidatedWeekWorkoutChange[] = [];
  const schemaErrors: string[] = [];
  raw.forEach((item: unknown, index: number) => {
    const instance = validateStrict(item, WeekWorkoutChangeSchema);
    if (!instance) {
      schemaErrors.push(
        `recalculatedWeekWorkouts[${index}]: structure ou champs hors schéma`,
      );
      return;
    }
    validated.push(toWeekWorkoutChange(instance));
  });

  if (schemaErrors.length > 0) {
    return { changes: [], schemaErrors, droppedDateKeys: [] };
  }

  // Déduplication par dateKey : la dernière proposition écrase les précédentes
  // afin d'appliquer une seule écriture par séance.
  const byDateKey = new Map<string, ValidatedWeekWorkoutChange>();
  for (const change of validated) {
    byDateKey.set(change.dateKey, change);
  }

  const changes: ValidatedWeekWorkoutChange[] = [];
  const droppedDateKeys: string[] = [];
  for (const [dateKey, change] of byDateKey) {
    if (allowed.has(dateKey)) {
      changes.push(change);
    } else {
      droppedDateKeys.push(dateKey);
    }
  }

  return { changes, schemaErrors: [], droppedDateKeys };
}
