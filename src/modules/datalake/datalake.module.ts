import { Global, Module } from "@nestjs/common";
import { DataLakeService } from "./datalake.service";
import { DataLakeController } from "./datalake.controller";

@Global()
@Module({
  controllers: [DataLakeController],
  providers: [DataLakeService],
  exports: [DataLakeService],
})
export class DataLakeModule {}
