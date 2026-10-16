-- RILES-021 : FC max de l'athlète (IF/TSS calculé dessus, plus sur la FC max
-- observée de la séance) + RILES-027 : charge sRPE stockée par séance.
ALTER TABLE "users" ADD COLUMN "hrMax" INTEGER,
ADD COLUMN "restHr" INTEGER;

ALTER TABLE "workouts" ADD COLUMN "sRpe" DOUBLE PRECISION;
