import { inngest } from '../client.js';
import { prismaManager } from '../../db/manager.js';
import { getWorkQueue } from '../../redis/work-queue.js';
import { logger } from '../../../utils/logger.js';

/**
 * Async Workflow for Agent Registration.
 * 
 * Triggered by: API (agent.registration.requested)
 * Actions:
 * 1. Fetch all active clusters for the organization.
 * 2. For each cluster, queue a REGISTRATION work item in Redis.
 * 3. Relayers will pull this work and prepare the environment (pulling images, etc.).
 */
export const registrationWorkflow = inngest.createFunction(
    { id: 'agent-registration-workflow', name: 'Agent Registration Workflow' },
    { event: 'agent.registration.requested' },
    async ({ event, step }) => {
        const { organizationId, config } = event.data;
        const targetClusterName = config.cluster;

        // Step 1: Resolve target cluster by name for the organization
        const targetCluster = await step.run('resolve-cluster', async () => {
            const prisma = await prismaManager.getClient();
            return await prisma.cluster.findFirst({
                where: { organizationId, name: targetClusterName, status: 'ACTIVE' },
                select: { id: true, name: true }
            });
        });

        if (!targetCluster) {
            logger.error({ organizationId, targetClusterName, agentName: config.name }, 'Target cluster not found or inactive for registration');

            // Mark registration as FAILED for this cluster if missing
            await step.run('mark-registration-failed-no-cluster', async () => {
                const prisma = await prismaManager.getClient();
                // We'll update the global status to FAILED since the primary target is missing
                await prisma.agent.update({
                    where: { organizationId_name: { organizationId, name: config.name } },
                    data: {
                        status: 'FAILED',
                        registrationReport: { error: `Target cluster '${targetClusterName}' not found or inactive` } as any
                    }
                });
            });

            return { status: 'cluster_not_found', targetClusterName };
        }

        // Step 2: Queue registration work with COMPLETE configuration payload
        await step.run('queue-registration-payload', async () => {
            const workQueue = getWorkQueue();
            const prisma = await prismaManager.getClient();

            // Fetch current agent metadata
            const agent = await prisma.agent.findUnique({
                where: { organizationId_name: { organizationId, name: config.name } },
                select: { id: true, configHash: true }
            });

            if (!agent) throw new Error(`Agent ${config.name} not found in database during workflow`);

            await workQueue.enqueue(
                organizationId,
                targetCluster.id,
                {
                    type: 'REGISTRATION',
                    data: {
                        agentId: agent.id,
                        agentName: config.name,
                        image: config.image,
                        resources: config.resources,
                        retryPolicy: config.retryPolicy,
                        useAgentSandbox: config.useAgentSandbox ?? false,
                        warmPoolSize: config.warmPoolSize ?? 0,
                        networkPolicy: config.networkPolicy ?? 'standard',
                        environmentVariables: config.environmentVariables,
                        configHash: agent.configHash
                    }
                },
                'high'
            );

            logger.info({
                organizationId,
                agentName: config.name,
                clusterId: targetCluster.id
            }, 'Full agent configuration queued to specific cluster');
        });

        return {
            status: 'queued',
            clusterId: targetCluster.id,
            clusterName: targetCluster.name
        };
    }
);
