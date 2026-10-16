import * as assert from "assert";
import * as crypto from "crypto";
import { DataLakeService } from "./datalake.service";
import { TrainingInteractionLogInput } from "./dto/datalake.dto";

async function runDataLakeTests() {
  console.log("▶ [Test Suite] DataLakeService Validation");

  let lastUploadedPath = "";
  let lastUploadedContent = "";
  let uploadShouldFail = false;

  const mockSupabaseClient: any = {
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, buffer: Buffer, options: any) => {
          if (uploadShouldFail) {
            return {
              data: null,
              error: { message: "Storage connection timeout simulation" },
            };
          }
          lastUploadedPath = path;
          lastUploadedContent = buffer.toString("utf-8");
          return {
            data: { path, id: "mock-id-123", fullPath: `${bucket}/${path}` },
            error: null,
          };
        },
      }),
    },
  };

  const mockConfigService: any = {
    get: (key: string, defaultValue?: any) => {
      if (key === "DATALAKE_BUCKET_NAME") return "training-datalake";
      if (key === "SUPABASE_URL") return "https://mock.supabase.co";
      if (key === "SUPABASE_SERVICE_ROLE_KEY") return "mock-service-role-key";
      if (key === "NODE_ENV") return "test";
      return defaultValue;
    },
  };

  const service = new DataLakeService(mockConfigService);
  // Inject mock supabase client directly
  (service as any).supabaseClient = mockSupabaseClient;

  // 1. Test anonymisation SHA-256 tronqué à 16 caractères
  const testUserId = "usr_998877665544332211";
  const expectedHash = crypto
    .createHash("sha256")
    .update(testUserId)
    .digest("hex")
    .slice(0, 16);

  const anonId = service.anonymizeUserId(testUserId);
  assert.strictEqual(
    anonId.length,
    16,
    "Anonymized ID must be exactly 16 chars",
  );
  assert.strictEqual(
    anonId,
    expectedHash,
    "Anonymized ID must match SHA-256 slice(0, 16)",
  );
  console.log(
    "  ✔ Test 1: User ID is correctly anonymized with SHA-256 (16 chars)",
  );

  // 2. Test partitionnement du chemin : raw/year=YYYY/MM/DD/interaction_[timestamp]_[random].jsonl
  const fixedDate = new Date("2026-09-16T14:30:00.000Z");
  const partitionedPath = service.generatePartitionedPath(fixedDate);
  const pathRegex =
    /^raw\/year=2026\/09\/16\/interaction_\d+_[a-f0-9]{8}\.jsonl$/;
  assert.ok(
    pathRegex.test(partitionedPath),
    `Path "${partitionedPath}" must match raw/year=YYYY/MM/DD/interaction_[timestamp]_[random].jsonl`,
  );
  console.log(
    `  ✔ Test 2: Partitioned path generated correctly: ${partitionedPath}`,
  );

  // 3. Test enregistrement et formatage JSON Lines
  const interactionPayload: TrainingInteractionLogInput = {
    userId: testUserId,
    interactionType: "coach_chat",
    interaction: {
      type: "chat",
      userPrompt:
        "Je ressens une gêne au mollet droit après ma séance de fractionné.",
      aiResponse:
        "Prudence avant tout ! Je te conseille 20 min de mobilité et repos aujourd'hui.",
      suggestedAction: {
        type: "injury_care",
        label: "Appliquer : Repos mollet",
      },
    },
    athleteContext: {
      readinessScore: 78,
      mainGoal: "Semi-marathon de Paris",
      totalKm: 340.5,
    },
    feedback: {
      rating: 4,
      feedbackLabel: "Modéré",
      acceptedSuggestion: true,
    },
    timestamp: fixedDate,
  };

  const uploadSuccess =
    await service.logTrainingInteraction(interactionPayload);
  assert.strictEqual(
    uploadSuccess,
    true,
    "logTrainingInteraction should return true on success",
  );
  assert.ok(lastUploadedPath.startsWith("raw/year=2026/09/16/interaction_"));
  assert.ok(
    lastUploadedContent.endsWith("\n"),
    "Content must be terminated by newline (JSON Lines)",
  );

  const parsedLine = JSON.parse(lastUploadedContent.trim());
  assert.strictEqual(parsedLine.anonymousUserId, expectedHash);
  assert.strictEqual(parsedLine.year, 2026);
  assert.strictEqual(parsedLine.month, 9);
  assert.strictEqual(parsedLine.day, 16);
  assert.strictEqual(parsedLine.interaction.type, "chat");
  assert.strictEqual(parsedLine.feedback.rating, 4);
  console.log(
    "  ✔ Test 3: Log record structured properly in JSON Lines format with date metadata",
  );

  // 4. Test non-bloquant en cas d'erreur de Supabase Storage
  uploadShouldFail = true;
  let didThrow = false;
  let result = false;
  try {
    result = await service.logTrainingInteraction(interactionPayload);
  } catch (err) {
    didThrow = true;
  }
  assert.strictEqual(
    didThrow,
    false,
    "Must NEVER throw an exception (non-blocking)",
  );
  assert.strictEqual(
    result,
    false,
    "Should return false gracefully when storage fails",
  );
  console.log(
    "  ✔ Test 4: Errors are caught gracefully without interrupting caller",
  );

  // 5. Test anonymisation avec userId vide/null
  const fallbackAnon = service.anonymizeUserId("");
  assert.strictEqual(fallbackAnon, "anonymous_user");
  console.log("  ✔ Test 5: Empty user ID fallback handled gracefully");

  console.log("\n✅ All 5 DataLakeService tests passed with 100% success!\n");
}

runDataLakeTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
