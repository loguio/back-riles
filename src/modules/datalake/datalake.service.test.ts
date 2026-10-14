import * as crypto from "crypto";
import { DataLakeService } from "./datalake.service";

/**
 * anonymizeUserId / generatePartitionedPath are pure helpers of the data lake
 * writer. The service is constructed with a stubbed ConfigService and
 * onModuleInit is deliberately never called: no Supabase client, no filesystem
 * writes, no network.
 */
function createService(): DataLakeService {
  const configStub = {
    get: (key: string) =>
      key === "DATALAKE_BUCKET_NAME" ? "training-datalake" : undefined,
  } as any;
  return new DataLakeService(configStub);
}

describe("DataLakeService.anonymizeUserId", () => {
  it("hashes the user id with truncated SHA-256 (16 hex chars)", () => {
    const service = createService();
    const userId = "usr_998877665544332211";

    const expected = crypto
      .createHash("sha256")
      .update(userId)
      .digest("hex")
      .slice(0, 16);

    const anonymized = service.anonymizeUserId(userId);

    expect(anonymized).toBe(expected);
    expect(anonymized).toHaveLength(16);
    expect(anonymized).toMatch(/^[a-f0-9]{16}$/);
    expect(anonymized).not.toContain(userId);
  });

  it("falls back to a fixed placeholder for an empty id", () => {
    expect(createService().anonymizeUserId("")).toBe("anonymous_user");
  });
});

describe("DataLakeService.generatePartitionedPath", () => {
  it("builds a raw/year=YYYY/MM/DD/interaction_<ts>_<rand>.jsonl key", () => {
    const service = createService();
    const fixed = new Date("2026-09-16T14:30:00.000Z"); // 16:30 Europe/Paris

    const key = service.generatePartitionedPath(fixed);

    expect(key).toMatch(
      /^raw\/year=2026\/09\/16\/interaction_\d+_[a-f0-9]{8}\.jsonl$/,
    );
    expect(key).toContain(`interaction_${fixed.getTime()}_`);
  });
});
