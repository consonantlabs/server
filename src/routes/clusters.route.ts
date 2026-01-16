import type { FastifyInstance } from 'fastify';
import { createClusterController } from '../controllers/clusters.controller.js';

export async function clusterRoutes(app: FastifyInstance) {
  app.post(
    '/clusters',
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
    createClusterController
  );
}



// // ============================================================================
// // src/routes/clusters.route.ts - UPDATED with gRPC Connection Status
// // ============================================================================

// import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
// import { prisma } from '../services/db/index.js';
// import { getGrpcServer } from '../grpc/server.js';

// export async function clusterRoutes(app: FastifyInstance) {
//   /**
//    * Get all clusters with gRPC connection status
//    * 
//    * GET /api/v1/clusters
//    */
//   app.get('/clusters', async (_request: FastifyRequest, reply: FastifyReply) => {
//     try {
//       const clusters = await prisma.cluster.findMany({
//         select: {
//           id: true,
//           name: true,
//           namespace: true,
//           status: true,
//           createdAt: true,
//           updatedAt: true,
//           lastSeenAt: true,
//           lastHealthCheckAt: true,
//         },
//       });

//       // Enrich with gRPC connection status
//       const grpcServer = getGrpcServer();
//       const connectionManager = grpcServer?.getConnectionManager();
      
//       const enrichedClusters = clusters.map(cluster => ({
//         ...cluster,
//         grpcConnection: {
//           connected: connectionManager?.isConnected(cluster.id) || false,
//           connectedAt: connectionManager?.getConnection(cluster.id)?.connectedAt || null,
//           lastHeartbeat: connectionManager?.getConnection(cluster.id)?.lastHeartbeat || null
//         }
//       }));

//       return reply.send({
//         success: true,
//         data: enrichedClusters,
//         meta: {
//           total: enrichedClusters.length,
//           connectedCount: enrichedClusters.filter(c => c.grpcConnection.connected).length
//         }
//       });
//     } catch (error) {
//       app.log.error('[Clusters Route] Error fetching clusters', { error });
//       return reply.status(500).send({
//         success: false,
//         error: 'Failed to fetch clusters',
//         message: error instanceof Error ? error.message : 'Unknown error'
//       });
//     }
//   });

//   /**
//    * Get cluster by ID with detailed gRPC status
//    * 
//    * GET /api/v1/clusters/:id
//    */
//   app.get<{ Params: { id: string } }>(
//     '/clusters/:id',
//     async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
//       const { id } = request.params;

//       try {
//         const cluster = await prisma.cluster.findUnique({
//           where: { id },
//           select: {
//             id: true,
//             name: true,
//             namespace: true,
//             status: true,
//             createdAt: true,
//             updatedAt: true,
//             lastSeenAt: true,
//             lastHealthCheckAt: true,
//             healthStatus: true,
//           },
//         });

//         if (!cluster) {
//           return reply.status(404).send({
//             success: false,
//             error: 'Cluster not found',
//           });
//         }

//         // Get detailed gRPC connection info
//         const grpcServer = getGrpcServer();
//         const connectionManager = grpcServer?.getConnectionManager();
//         const connection = connectionManager?.getConnection(id);

//         return reply.send({
//           success: true,
//           data: {
//             ...cluster,
//             grpcConnection: connection ? {
//               connected: true,
//               connectedAt: connection.connectedAt,
//               lastHeartbeat: connection.lastHeartbeat,
//               metadata: connection.metadata
//             } : {
//               connected: false,
//               connectedAt: null,
//               lastHeartbeat: null,
//               metadata: {}
//             }
//           }
//         });
//       } catch (error) {
//         app.log.error('[Clusters Route] Error fetching cluster', { error, id });
//         return reply.status(500).send({
//           success: false,
//           error: 'Failed to fetch cluster',
//           message: error instanceof Error ? error.message : 'Unknown error'
//         });
//       }
//     }
//   );

//   /**
//    * Delete cluster by ID
//    * Also closes gRPC connection if active
//    * 
//    * DELETE /api/v1/clusters/:id
//    */
//   app.delete<{ Params: { id: string } }>(
//     '/clusters/:id',
//     async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
//       const { id } = request.params;

//       try {
//         // Close gRPC connection first
//         const grpcServer = getGrpcServer();
//         const connectionManager = grpcServer?.getConnectionManager();
        
//         if (connectionManager?.isConnected(id)) {
//           app.log.info('[Clusters Route] Closing gRPC connection', { id });
//           connectionManager.removeConnection(id);
//         }

//         // Delete from database
//         await prisma.cluster.delete({
//           where: { id },
//         });

//         return reply.send({ 
//           success: true,
//           message: 'Cluster deleted successfully'
//         });
//       } catch (error) {
//         app.log.error('[Clusters Route] Error deleting cluster', { error, id });
//         return reply.status(404).send({
//           success: false,
//           error: 'Cluster not found',
//         });
//       }
//     }
//   );

//   /**
//    * Get gRPC connection statistics
//    * 
//    * GET /api/v1/clusters/stats/connections
//    */
//   app.get('/clusters/stats/connections', async (_request: FastifyRequest, reply: FastifyReply) => {
//     try {
//       const grpcServer = getGrpcServer();
      
//       if (!grpcServer) {
//         return reply.send({
//           success: true,
//           data: {
//             serverStatus: 'not_initialized',
//             connections: []
//           }
//         });
//       }

//       const connectionManager = grpcServer.getConnectionManager();
//       const stats = connectionManager.getStats();

//       return reply.send({
//         success: true,
//         data: {
//           serverStatus: grpcServer.getStats().isRunning ? 'running' : 'stopped',
//           totalConnections: stats.totalConnections,
//           clusters: stats.clusters
//         }
//       });
//     } catch (error) {
//       app.log.error('[Clusters Route] Error fetching connection stats', { error });
//       return reply.status(500).send({
//         success: false,
//         error: 'Failed to fetch connection statistics',
//         message: error instanceof Error ? error.message : 'Unknown error'
//       });
//     }
//   });

//   /**
//    * Send command to cluster (for testing)
//    * 
//    * POST /api/v1/clusters/:id/command
//    */
//   app.post<{ 
//     Params: { id: string },
//     Body: {
//       type: string;
//       payload?: any;
//       timeout?: number;
//       priority?: number;
//     }
//   }>(
//     '/clusters/:id/command',
//     async (request: FastifyRequest<{ 
//       Params: { id: string },
//       Body: {
//         type: string;
//         payload?: any;
//         timeout?: number;
//         priority?: number;
//       }
//     }>, reply: FastifyReply) => {
//       const { id } = request.params;
//       const { type, payload, timeout = 30, priority = 1 } = request.body;

//       try {
//         const grpcServer = getGrpcServer();
//         const connectionManager = grpcServer?.getConnectionManager();

//         if (!connectionManager?.isConnected(id)) {
//           return reply.status(503).send({
//             success: false,
//             error: 'Cluster not connected',
//             message: 'gRPC connection not established'
//           });
//         }

//         // Generate command ID
//         const commandId = `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

//         // Create command
//         const command = {
//           commandId,
//           type,
//           issuedAt: new Date(),
//           timeoutSeconds: timeout,
//           priority,
//           payload: payload || null,
//           metadata: {}
//         };

//         // Send command via connection manager
//         // Note: You'll need to add this method to ConnectionManager
//         const sent = connectionManager.sendToCluster(id, { command });

//         if (!sent) {
//           return reply.status(500).send({
//             success: false,
//             error: 'Failed to send command',
//             message: 'Stream write failed'
//           });
//         }

//         return reply.send({
//           success: true,
//           data: {
//             commandId,
//             status: 'sent',
//             message: 'Command sent successfully'
//           }
//         });
//       } catch (error) {
//         app.log.error('[Clusters Route] Error sending command', { error, id });
//         return reply.status(500).send({
//           success: false,
//           error: 'Failed to send command',
//           message: error instanceof Error ? error.message : 'Unknown error'
//         });
//       }
//     }
//   );
// }