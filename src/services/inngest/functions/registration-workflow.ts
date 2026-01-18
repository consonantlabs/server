import { inngest } from '../client.js';
import { getAgentService } from '../../agent.service.js';
import { logger } from '../../../utils/logger.js';
import { prismaManager } from '../../db/manager.js';
import type { Agent } from '@prisma/client';
import type { AgentConfig } from '../events.js';

/**
 * Async Workflow for Agent Registration.
 * 
 * Triggered by: API (agent.registration.requested)
 * Actions:
 * 1. Upsert Agent in DB
 * 2. Emit agent.registered event (for webhooks/integrations)
 */
export const registrationWorkflow = inngest.createFunction(
    { id: 'agent-registration-workflow', name: 'Agent Registration Workflow' },
    { event: 'agent.registration.requested' },
    async ({ event, step }) => {
        const { organizationId, config, requestId } = event.data;
        const agentService = getAgentService();

        logger.info({
            requestId,
            organizationId,
            agentName: config.name
        }, 'Processing async registration');

        // Step 1: Validated DB Upsert
        const result = await step.run('upsert-agent-db', async (): Promise<{ agent: Agent; action: 'created' | 'updated' | 'unchanged' }> => {
            // Logic moved from API -> Here
            // This ensures retries on DB failure
            return await agentService.registerOrUpdate(organizationId, config as AgentConfig);
        });

        // Step 2: Audit Logging
        if (result.action !== 'unchanged') {
            await step.run('audit-log', async () => {
                const prisma = await prismaManager.getClient();
                await prisma.auditLog.create({
                    data: {
                        organizationId,
                        action: result.action === 'created' ? 'AGENT_CREATED' : 'AGENT_UPDATED',
                        resourceType: 'Agent',
                        resourceId: result.agent.id,
                        metadata: {
                            name: config.name,
                            image: config.image,
                            requestId
                        },
                    }
                });
            });
        }

        // Step 3: Emit Completion Event
        if (result.action !== 'unchanged') {
            await step.run('emit-completion-event', async () => {
                await inngest.send({
                    name: 'agent.registered', // Use existing event for compatibility
                    data: {
                        agentId: result.agent.id,
                        organizationId: result.agent.organizationId,
                        config: config,
                        action: result.action,
                        createdAt: new Date(result.agent.createdAt).toISOString(),
                    },
                });

                // Also emit notification for the specific request
                await inngest.send({
                    name: 'agent.registration.completed',
                    data: {
                        agentId: result.agent.id,
                        organizationId: result.agent.organizationId,
                        status: 'success',
                        action: result.action,
                        completedAt: new Date().toISOString()
                    }
                });
            });
        }

        return {
            agentId: result.agent.id,
            action: result.action,
            status: 'success'
        };
    }
);
