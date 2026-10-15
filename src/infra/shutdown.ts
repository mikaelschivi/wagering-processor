import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { SQS_CLIENT } from "./sqs/client";
import { SQS_PRODUCER_CLIENT } from "./sqs/producer";

@Injectable()
export class ResourceCloser implements OnApplicationShutdown {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(SQS_PRODUCER_CLIENT) private readonly producer: SQSClient,
  ) {}

  async onApplicationShutdown() {
    this.sqs.destroy();
    this.producer.destroy();
    await this.orm.close();
  }
}
