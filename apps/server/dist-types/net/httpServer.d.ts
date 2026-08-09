import { type Server } from 'node:http'
import type { Logger } from '@hobo/shared'
import type { ServerMetrics } from '../observability/metrics.js'
export declare function createHttpServer(
  staticDir: string | null,
  metrics: ServerMetrics,
  log: Logger,
): Server
//# sourceMappingURL=httpServer.d.ts.map
