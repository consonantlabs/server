// import { CommandResult, Command, ServerMessage } from '@consonant/proto-relayer';
// import { logger } from '../../../utils/logger.js';
// import { ConnectionManager } from '../connection-manager.js';
// import { prisma } from '../../db/index.js';

// /**
//  * Handles command results received from relayers
//  */
// export class CommandHandler {
//   constructor(private connectionManager: ConnectionManager) { }

//   /**
//    * Handle command result from relayer
//    */
//   async handleCommandResult(
//     clusterId: string,
//     result: CommandResult
//   ): Promise<void> {
//     logger.info({
//       clusterId,
//       commandId: result.commandId,
//       statusCode: result.status?.code,
//       durationMs: result.durationMs
//     }, '[CommandHandler] Command result received');

//     try {
//       // Store result in database
//       await this.storeCommandResult(clusterId, result);

//       // Emit event for real-time updates
//       this.connectionManager.emit('commandResult', {
//         clusterId,
//         commandId: result.commandId,
//         result
//       });

//       // Log success/failure
//       if (result.status?.code === 0) {
//         logger.info({
//           clusterId,
//           commandId: result.commandId,
//           durationMs: result.durationMs
//         }, '[CommandHandler] Command executed successfully');
//       } else {
//         logger.error({
//           clusterId,
//           commandId: result.commandId,
//           errorMessage: result.status?.message
//         }, '[CommandHandler] Command execution failed');
//       }
//     } catch (error) {
//       logger.error({
//         error,
//         clusterId,
//         commandId: result.commandId
//       }, '[CommandHandler] Error handling command result');
//     }
//   }

//   /**
//    * Send command to specific cluster
//    */
//   async sendCommand(
//     clusterId: string,
//     command: Command
//   ): Promise<boolean> {
//     logger.info({
//       clusterId,
//       commandId: command.commandId,
//       commandType: command.type
//     }, '[CommandHandler] Sending command');

//     // Check if cluster is connected
//     if (!this.connectionManager.isConnected(clusterId)) {
//       logger.error({ clusterId }, '[CommandHandler] Cluster not connected');
//       return false;
//     }

//     // Create server message
//     const message: ServerMessage = { command };

//     // Send to cluster
//     const sent = this.connectionManager.sendToCluster(clusterId, message);

//     if (sent) {
//       // Store command in database for tracking
//       await this.storeCommandSent(clusterId, command);
//     }

//     return sent;
//   }

//   /**
//    * Store command result in database
//    */
//   private async storeCommandResult(
//     clusterId: string,
//     result: CommandResult
//   ): Promise<void> {
//     try {
//       await prisma.commandResult.create({
//         data: {
//           commandId: result.commandId,
//           clusterId,
//           statusCode: result.status?.code || 0,
//           statusMessage: result.status?.message || '',
//           durationMs: Number(result.durationMs),
//           completedAt: result.completedAt ? new Date(result.completedAt as any) : new Date(),
//           result: result.result ? JSON.stringify(result.result) : null,
//           metadata: result.metadata || {}
//         }
//       });
//     } catch (error) {
//       logger.error({
//         error,
//         commandId: result.commandId
//       }, '[CommandHandler] Failed to store command result');
//     }
//   }

//   /**
//    * Store sent command in database
//    */
//   private async storeCommandSent(
//     clusterId: string,
//     command: Command
//   ): Promise<void> {
//     try {
//       await prisma.commandSent.create({
//         data: {
//           commandId: command.commandId,
//           clusterId,
//           commandType: command.type,
//           issuedAt: command.issuedAt ? new Date(command.issuedAt as any) : new Date(),
//           timeoutSeconds: command.timeoutSeconds,
//           priority: command.priority,
//           payload: command.payload ? JSON.stringify(command.payload) : null,
//           metadata: command.metadata || {}
//         }
//       });
//     } catch (error) {
//       logger.error({
//         error,
//         commandId: command.commandId
//       }, '[CommandHandler] Failed to store sent command');
//     }
//   }
// }
