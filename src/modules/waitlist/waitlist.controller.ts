import { Body, Controller, Headers, HttpCode, HttpStatus, Post, Req } from "@nestjs/common";
import { Public } from "../../common/decorators/public.decorator";
import { CreateWaitlistEntryDto } from "./dto/waitlist.dto";
import { WaitlistService } from "./waitlist.service";

@Controller("waitlist")
export class WaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  /**
   * CD-08: the landing's true capture path.
   * 202 = created, 200 = already subscribed. Never 500: the client keeps its
   * Netlify fallback if this path is unreachable.
   */
  @Public()
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async subscribe(
    @Body() dto: CreateWaitlistEntryDto,
    @Req() req: { ip?: string; headers: Record<string, string | string[] | undefined> },
  ) {
    const result = await this.waitlist.subscribe(dto, req.ip, "fr");
    return {
      status: result.duplicate ? "already" : "created",
      ...result,
    };
  }
}
