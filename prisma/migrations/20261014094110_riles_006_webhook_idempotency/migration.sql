-- RILES-006 : idempotence des webhooks & unicite des activites externes.
-- Ajoute WebhookEvent.objectId + unique (provider, eventType, objectId) et
-- unique Workout.externalActivityId. Prerequis : aucun doublon existant
-- (donnees de pre-lancement, cf. RILES-030 pour la baseline des migrations).
-- AlterTable
ALTER TABLE "webhook_events" ADD COLUMN     "objectId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "workouts_externalActivityId_key" ON "workouts"("externalActivityId");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_eventType_objectId_key" ON "webhook_events"("provider", "eventType", "objectId");

