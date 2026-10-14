Build a distributed financial service that processes betting transactions received from multiple game providers.

This challenge does not assess CRUD or superficial familiarity with NestJS. The evaluation is centered on:

    financial correctness;

    concurrency across multiple instances;

    persistent idempotency;

    consistency between materialized balance and ledger;

    asynchronous processing and recovery after failures;

    clarity of technical decisions.

The system must remain correct when messages are duplicated, delivered out of order, or processed simultaneously.
