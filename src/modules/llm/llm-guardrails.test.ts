import { LlmService } from "./llm.service";

function createService(env: Record<string, string | undefined> = {}): LlmService {
  const configStub = { get: (key: string) => env[key] } as any;
  return new LlmService(configStub);
}

const OK_RESPONSE = {
  ok: true,
  status: 200,
  text: async () => "",
  json: async () => ({
    choices: [{ message: { content: '{"replyText":"ok","reformulatedIntent":"x","safetyStatus":"safe"}' } }],
  }),
} as any;

const FAIL_429 = {
  ok: false,
  status: 429,
  text: async () => "rate limited",
  json: async () => ({}),
} as any;

describe("LLM guard rails", () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(OK_RESPONSE);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("opens the circuit breaker after sustained 429s", async () => {
    fetchSpy.mockResolvedValue(FAIL_429);
    const service = createService({
      LLM_API_KEY: "k",
      LLM_RETRY_MAX: "0",
      LLM_CIRCUIT_BREAKER_THRESHOLD: "2",
    });

    await expect(
      (service as any).callOpenAiCompatibleJson("gemini-3.5-flash-lite", "sys", "user"),
    ).rejects.toThrow(/HTTP 429/);
    await expect(
      (service as any).callOpenAiCompatibleJson("gemini-3.5-flash-lite", "sys", "user"),
    ).rejects.toThrow(/HTTP 429/);

    expect((service as any).isCircuitBreakerOpen()).toBe(true);
    await expect(
      (service as any).callOpenAiCompatibleJson("gemini-3.5-flash-lite", "sys", "user"),
    ).rejects.toThrow(/circuit breaker open/);
    // third call must not hit the network
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries with exponential backoff on a retryable status", async () => {
    fetchSpy
      .mockResolvedValueOnce(FAIL_429)
      .mockResolvedValueOnce(OK_RESPONSE);
    const service = createService({
      LLM_API_KEY: "k",
      LLM_RETRY_MAX: "1",
      LLM_CIRCUIT_BREAKER_THRESHOLD: "10",
    });

    const result = await (service as any).callOpenAiCompatibleJson("gemini-3.5-flash-lite", "sys", "user");
    expect(result).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("enforces the per-user daily cap before upstream calls", async () => {
    const service = createService({
      LLM_API_KEY: "k",
      LLM_DAILY_USER_CAP: "1",
    });
    const spy = jest
      .spyOn(service as any, "callOpenAiCompatibleJson")
      .mockResolvedValue({ replyText: "ok" } as any);

    await service.generateCoachReply({
      userId: "u1",
      userPrompt: "bonjour",
      athleteContext: {} as any,
    });
    await service.generateCoachReply({
      userId: "u1",
      userPrompt: "bonjour",
      athleteContext: {} as any,
    });

    // Second call is blocked by the daily cap, so the upstream helper is not invoked.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("throws when the estimated cost exceeds the guard", async () => {
    const service = createService({
      LLM_API_KEY: "k",
      LLM_MAX_REQUEST_COST_USD: "0.000001",
      LLM_RETRY_MAX: "0",
    });

    await expect(
      (service as any).callOpenAiCompatibleJson("m", "a".repeat(10000), "user"),
    ).rejects.toThrow(/cost guard/);
  });

  it("limits concurrent upstream calls", async () => {
    let active = 0;
    let maxActive = 0;
    fetchSpy.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return OK_RESPONSE;
    });

    const service = createService({
      LLM_API_KEY: "k",
      LLM_MAX_CONCURRENT: "1",
      LLM_RETRY_MAX: "0",
      LLM_CIRCUIT_BREAKER_THRESHOLD: "100",
      LLM_DAILY_USER_CAP: "1000",
    });

    const results = await Promise.allSettled([
      (service as any).callOpenAiCompatibleJson("gemini-3.5-flash-lite", "sys", "user"),
      (service as any).callOpenAiCompatibleJson("gemini-3.5-flash-lite", "sys", "user"),
    ]);

    expect(maxActive).toBe(1);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });
});
