/**
 * @fileoverview Audit Log Listeners
 * @module services/inngest/functions/audit-listeners
 * 
 * Production-grade audit logging separated from main orchestration workflows.
 * This ensures that audit log failures don't block business operations and
 * can be scaled independently.
 */

import { inngest } from '../client.js';
import { prismaManager } from '../../db/manager.js';
import { logger } from '../../../utils/logger.js';

/**
 * Audit log for agent registration.
 */
export const agentRegisteredAuditLog = inngest.createFunction(
    { id: 'agent-registered-audit-log', name: 'Agent Registered Audit Log' },
    { event: 'agent.registered' },
    async ({ event, step }) => {
        const { organizationId, agentId, config, action } = event.data;

        await step.run('write-audit-log', async () => {
            const prisma = await prismaManager.getClient();
            await prisma.auditLog.create({
                data: {
                    organizationId,
                    action: action === 'created' ? 'AGENT_CREATED' : 'AGENT_UPDATED',
                    resourceType: 'Agent',
                    resourceId: agentId,
                    metadata: {
                        name: (config as any).name,
                        image: (config as any).image,
                    },
                }
            });
        });

        logger.info({ agentId, organizationId }, 'Audit log written for agent registration');
    }
);

/**
 * Audit log for execution initialization.
 */
export const executionRequestedAuditLog = inngest.createFunction(
    { id: 'execution-requested-audit-log', name: 'Execution Requested Audit Log' },
    { event: 'agent.execution.requested' },
    async ({ event, step }) => {
        const { organizationId, executionId, agentId, priority } = event.data;

        await step.run('write-audit-log', async () => {
            const prisma = await prismaManager.getClient();
            await prisma.auditLog.create({
                data: {
                    organizationId,
                    action: 'EXECUTION_TRIGGERED',
                    resourceType: 'Execution',
                    resourceId: executionId,
                    metadata: {
                        agentId,
                        priority
                    },
                }
            });
        });
    }
);

/**
 * Audit log for execution completion.
 */
export const executionCompletedAuditLog = inngest.createFunction(
    { id: 'execution-completed-audit-log', name: 'Execution Completed Audit Log' },
    { event: 'agent.execution.completed' },
    async ({ event, step }) => {
        const { organizationId, executionId, status, durationMs } = event.data;

        await step.run('write-audit-log', async () => {
            const prisma = await prismaManager.getClient();
            await prisma.auditLog.create({
                data: {
                    organizationId: organizationId as string,
                    action: 'EXECUTION_COMPLETED',
                    resourceType: 'Execution',
                    resourceId: executionId as string,
                    metadata: {
                        status: status as string,
                        durationMs: durationMs as number
                    },
                }
            });
        });
    }
);
