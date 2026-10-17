import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  GetCommunityRunsQueryDto,
  ToggleRunParticipationRequestDto,
} from "./community.dto";

/**
 * DTO validation is pure class-validator logic, exercised here outside of any
 * Nest validation pipe so the rules themselves are what is under test. This
 * mirrors `src/modules/auth/dto/auth.dto.test.ts`.
 */
describe("ToggleRunParticipationRequestDto validation", () => {
  it('accepts action "join"', async () => {
    const dto = plainToInstance(ToggleRunParticipationRequestDto, {
      action: "join",
    });

    await expect(validate(dto)).resolves.toEqual([]);
  });

  it('accepts action "leave"', async () => {
    const dto = plainToInstance(ToggleRunParticipationRequestDto, {
      action: "leave",
    });

    await expect(validate(dto)).resolves.toEqual([]);
  });

  it("accepts an omitted action (toggle semantics)", async () => {
    const dto = plainToInstance(ToggleRunParticipationRequestDto, {});

    await expect(validate(dto)).resolves.toEqual([]);
  });

  it("rejects any other action value", async () => {
    const dto = plainToInstance(ToggleRunParticipationRequestDto, {
      action: "maybe",
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe("action");
    expect(errors[0].constraints).toHaveProperty("isIn");
  });
});

describe("GetCommunityRunsQueryDto validation", () => {
  it("accepts an omitted clubId", async () => {
    const dto = plainToInstance(GetCommunityRunsQueryDto, {});

    await expect(validate(dto)).resolves.toEqual([]);
  });

  it("accepts a string clubId", async () => {
    const dto = plainToInstance(GetCommunityRunsQueryDto, {
      clubId: "club-01",
    });

    await expect(validate(dto)).resolves.toEqual([]);
  });

  it("rejects a repeated clubId (query params parse to a string[])", async () => {
    // `?clubId=a&clubId=b` arrives as an array; @IsString() must reject it.
    const dto = plainToInstance(GetCommunityRunsQueryDto, {
      clubId: ["club-01", "club-02"],
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe("clubId");
    expect(errors[0].constraints).toHaveProperty("isString");
  });
});
