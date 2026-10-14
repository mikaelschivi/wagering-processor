import { Module, type DynamicModule } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "./config";
import { HealthController } from "./infra/http/health.controller";

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [{ provide: APP_CONFIG, useValue: config }],
    };
  }
}
