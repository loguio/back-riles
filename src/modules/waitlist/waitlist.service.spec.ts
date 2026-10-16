import { WaitlistService } from "./waitlist.service";
import { WaitlistController } from "./waitlist.controller";

describe("WaitlistService", () => {
  const build = (createImpl?: jest.Mock) => {
    const create = createImpl ?? jest.fn().mockResolvedValue({ id: "w1" });
    const prisma = { waitlistEntry: { create, count: jest.fn().mockResolvedValue(3) } };
    const config = { get: jest.fn().mockReturnValue("riles") };
    return { service: new WaitlistService(prisma as never, config as never), create };
  };

  it("stores a new signup and normalises the email", async () => {
    const { service, create } = build();
    await service.subscribe({ email: "  Marius@RILES.run " } as never, "1.2.3.4");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: "marius@riles.run" }) }),
    );
  });

  it("never stores the raw IP, only a salted hash", async () => {
    const { service, create } = build();
    await service.subscribe({ email: "a@b.co" } as never, "203.0.113.9");
    const args = create.mock.calls[0][0] as { data: { ipHash: string } };
    expect(args.data.ipHash).toMatch(/^[a-f0-9]{16}$/);
    expect(args.data.ipHash).not.toContain("203");
  });

  it("uses the server clock when the client omits consentAt", async () => {
    const { service, create } = build();
    await service.subscribe({ email: "a@b.co" } as never);
    const args = create.mock.calls[0][0] as { data: { consentAt: Date } };
    expect(args.data.consentAt).toBeInstanceOf(Date);
  });

  it("reports duplicates without throwing", async () => {
    const err = Object.assign(new Error("dup"), { code: "P2002" });
    const { service } = build(jest.fn().mockRejectedValue(err));
    await expect(service.subscribe({ email: "x@y.zo" } as never)).resolves.toEqual({
      ok: true,
      duplicate: true,
    });
  });

  it("drops honeypot submissions silently", async () => {
    const { service, create } = build();
    await service.subscribe({ email: "bot@bots.io", botField: "x" } as never);
    expect(create).not.toHaveBeenCalled();
  });

  it("propagates real database failures so the client can fall back", async () => {
    const { service } = build(jest.fn().mockRejectedValue(new Error("conn reset")));
    await expect(service.subscribe({ email: "z@z.zo" } as never)).rejects.toThrow("conn reset");
  });
});

describe("WaitlistController", () => {
  it("returns duplicate status and forwards the caller IP", async () => {
    const subscribe = jest.fn().mockResolvedValue({ ok: true, duplicate: true });
    const controller = new WaitlistController({ subscribe } as never);
    const res = await controller.subscribe({ email: "a@b.co" } as never, {
      ip: "1.2.3.4",
      headers: {},
    });
    expect(res.status).toBe("already");
    expect(subscribe).toHaveBeenCalledWith(expect.anything(), "1.2.3.4", "fr");
  });
});
