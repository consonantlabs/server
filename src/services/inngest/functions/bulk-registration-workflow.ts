import { inngest } from '../client.js';
import { getAgentService } from '../../agent.service.js';
import { logger } from '../../../utils/logger.js';
import { prismaManager } from '../../db/manager.js';
import type { Agent } from '@prisma/client';
import type { AgentConfig } from '../events.js';

/**
 * Async Workflow for Bulk Agent Registration.
 * 
 * Triggered by: API (agent.bulk_registration.requested)
 * Actions:
 * 1. Loop through configs and upsert in DB
 * 2. Emit completion event with consolidated results
 */
export const bulkRegistrationWorkflow = inngest.createFunction(
    { id: 'bulk-agent-registration-workflow', name: 'Bulk Agent Registration Workflow' },
    { event: 'agent.bulk_registration.requested' },
    async ({ event, step }) => {
        const { organizationId, configs, requestId } = event.data;
        const agentService = getAgentService();

        logger.info({
            requestId,
            organizationId,
            count: configs.length
        }, 'Processing async bulk registration');

        const results = await step.run('bulk-upsert-agents', async () => {
            const registrationResults = [];

            for (const config of configs) {
                try {
                    const result = await agentService.registerOrUpdate(organizationId, config as AgentConfig);
                    registrationResults.push({
                        name: config.name,
                        agentId: result.agent.id,
                        status: 'success' as const,
                        action: result.action
                    });
                } catch (err: any) {
                    registrationResults.push({
                        name: config.name,
                        status: 'failed' as const,
                        error: err.message
                    });
                }
            }

            return registrationResults;
        });

        // Step 2: Consolidated Audit Log
        await step.run('audit-log-bulk', async () => {
            const prisma = await prismaManager.getClient();
            const successfulCount = results.filter(r => r.status === 'success').length;

            await prisma.auditLog.create({
                data: {
                    organizationId,
                    action: 'BULK_AGENT_REGISTRATION',
                    resourceType: 'Agent',
                    resourceId: requestId, // Use Request ID as collective resource ID
                    metadata: {
                        count: configs.length,
                        successful: successfulCount,
                        failed: configs.length - successfulCount,
                        requestId
                    },
                }
            });
        });

        // Step 3: Emit completion event
        await step.run('emit-bulk-completion', async () => {
            await inngest.send({
                name: 'agent.bulk_registration.completed',
                data: {
                    organizationId,
                    results: results.map(r => ({
                        name: r.name,
                        agentId: r.agentId,
                        status: r.status,
                        error: r.error
                    })),
                    completedAt: new Date().toISOString()
                }
            });
        });

        return {
            count: configs.length,
            status: 'completed'
        };
    }
);
