import { Global, Module } from "@nestjs/common";
import { DataLakeService } from "./datalake.service";

@Global()
@Module({
  providers: [DataLakeService],
  exports: [DataLakeService],
})
export class DataLakeModule {}
