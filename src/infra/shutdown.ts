import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { SQS_CLIENT } from "./sqs/client";

@Injectable()
export class ResourceCloser implements OnApplicationShutdown {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  async onApplicationShutdown() {
    this.sqs.destroy();
    await this.orm.close();
  }
}
