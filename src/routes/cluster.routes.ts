import type { FastifyInstance } from 'fastify';
import {
  registerCluster,
  listClusters,
  getCluster,
  deleteCluster
} from '../controllers/clusters.controller.js';

export async function clusterRoutes(app: FastifyInstance) {
  // POST / - Register a new cluster
  app.post('/', registerCluster);

  // GET / - List all clusters
  app.get('/', listClusters);

  // GET /:clusterId - Get cluster details
  app.get('/:clusterId', getCluster);

  // DELETE /:clusterId - Delete a cluster
  app.delete('/:clusterId', deleteCluster);
}
