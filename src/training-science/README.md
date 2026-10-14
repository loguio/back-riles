# training-science (RILES-035 / issue #28)

Pure, deterministic training-science core extracted from `LlmService`
(2 000+ lines of prompts, provider clients and math mixed together).

## Boundaries

- **No NestJS, no Prisma, no LLM provider imports** — enforced by a test in
  `training-science.test.ts` (issue #28 acceptance criteria).
- **No clock, no randomness, no I/O** — same inputs, same outputs. Anything
  time- or provider-dependent stays in `src/modules/llm/llm.service.ts`.
- Types live in `types.ts` and are structurally compatible with the LLM DTOs
  (`src/modules/llm/dto/llm.dto.ts`) without importing them.

## Public API (all re-exported from `src/training-science/`)

```ts
// paces.ts
computePacesFromRecentPerformance(trainingContext?: AthleteTrainingContext): TargetPaces
extractSessionMetricsFromWorkouts(workouts: SessionWorkoutSource[]): RecentSessionMetric[]
getEasySinglePace(paces: TargetPaces): string

// banister.ts
computeSessionTss(
  durationSecOrObj: number | SessionTssInput,
  avgHeartRateArg?: number,
  hrMaxArg?: number, // default 190
): number
updateBanisterLoad(
  currentAtlOrObj: number | BanisterLoadInput,
  currentCtlArg?: number,   // default 48 in positional form
  sessionTssArg?: number,   // default 0 in positional form
): BanisterLoadResult // { atlFatigue, ctlFitness, tsbForm, readinessScore }

// plan-generator.ts
getLockedDayNamesFromRules(lifeRules: LifeRule[]): Set<string>   // "Lun".."Dim"
normalizeGeneratedWorkout(
  slot: PlanCalendarSlot,
  raw: any,                       // LLM output, untrusted
  lockedDays: Set<string>,
  paces: TargetPaces,
): GeneratedPlanWorkout
generatePeriodizedMultiWeekFallback(
  input: PeriodizationPlanInput,
  lockedDays: Set<string>,
  paces: TargetPaces,
  modelName: string,              // e.g. LLM_PRO_MODEL → "<model>-periodized-engine"
): MultiWeekPlanResult
computePeriodizedWeekMetrics(weekIndex: number, totalWeeks: number, startWeeklyKm: number): PeriodizedWeekMetrics
deriveStartWeeklyKm(baseRecentKm: number): number
buildDistinctWeekIndex(slots: PlanCalendarSlot[]): Map<string, number>
```

`LlmService` keeps thin public wrappers with unchanged signatures so existing
callers (`workouts`, `webhooks`, `coach`, `onboarding`) and tests are untouched.

## Tests

- `golden-fixtures.json` — inputs **and** outputs captured from `LlmService`
  BEFORE the extraction (characterization / golden tests). They pin today's
  science: changing a value is a deliberate decision for the science-fix
  phase (RILES-020–024, RILES-034), not an accident.
- `training-science.test.ts` — golden tests + behavior invariants (3:1 cycle,
  taper, ramp cap, locked-day rest, purity) + boundary checks. Runs with no
  DB, no network, no NestJS bootstrap.
