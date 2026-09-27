import { Module } from "@nestjs/common";
import { WorkoutsService } from "./workouts.service";
import { WorkoutsController } from "./workouts.controller";

@Module({
  controllers: [WorkoutsController],
  providers: [WorkoutsService],
  exports: [WorkoutsService],
})
export class WorkoutsModule {}
