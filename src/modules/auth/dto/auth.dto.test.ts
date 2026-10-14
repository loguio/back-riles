import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { LoginDto, RegisterDto } from "./auth.dto";

/**
 * DTO validation is pure class-validator logic, exercised here outside of any
 * Nest validation pipe so the rules themselves are what is under test.
 */
describe("LoginDto validation", () => {
  it("accepts a well-formed email", async () => {
    const dto = plainToInstance(LoginDto, {
      email: "marius@riles.app",
      password: "secret",
    });

    await expect(validate(dto)).resolves.toEqual([]);
  });

  it("rejects a malformed email and leaves the password untouched", async () => {
    const dto = plainToInstance(LoginDto, { email: "not-an-email" });

    const errors = await validate(dto);

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe("email");
    expect(errors[0].constraints).toHaveProperty("isEmail");
  });
});

describe("RegisterDto validation", () => {
  it("requires both an email and a name", async () => {
    const dto = plainToInstance(RegisterDto, { email: "not-an-email" });

    const errors = await validate(dto);

    const properties = errors.map((e) => e.property).sort();
    expect(properties).toEqual(["email", "name"]);
  });

  it("accepts a complete registration payload", async () => {
    const dto = plainToInstance(RegisterDto, {
      email: "sarah@riles.app",
      name: "Sarah Runner",
      password: "password123",
    });

    await expect(validate(dto)).resolves.toEqual([]);
  });
});
