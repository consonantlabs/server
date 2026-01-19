import type { FastifyInstance } from 'fastify';
import { registerCluster } from '../controllers/clusters.controller.js';

export async function clusterRoutes(app: FastifyInstance) {
  app.post(
    '/',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'namespace'],
          properties: {
            name: { type: 'string' },
            namespace: { type: 'string' },
          },
        },
      },
    },
    registerCluster
  );
}
