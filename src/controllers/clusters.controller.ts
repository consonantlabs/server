import type { FastifyRequest, FastifyReply } from 'fastify';
import { generateSecureToken } from '../utils/crypto.js';

interface CreateClusterBody {
  name: string;
  namespace: string;
}

export async function createClusterController(
  request: FastifyRequest<{ Body: CreateClusterBody }>,
  reply: FastifyReply
) {
  const { name, namespace } = request.body;

  if (!name || !namespace) {
    return reply.code(400).send({
      success: false,
      error: 'Missing required fields: name, namespace',
    });
  }

 

  const existingCluster = await prisma.cluster.findUnique({
    where: { name },
  });

  if (existingCluster) {
    return reply.code(409).send({
      success: false,
      error: 'Cluster with this name already exists',
    });
  }

  const tokenHash = generateSecureToken(64)

  const cluster = await prisma.cluster.create({
    data: {
      name,
      namespace,
      tokenHash,
      status: 'PENDING',
    },
  });

  return reply.code(201).send({
    success: true,
    data: {
      id: cluster.id,
      name: cluster.name,
      namespace: cluster.namespace,
      tokenHash: cluster.tokenHash,
      status: cluster.status,
    },
  });
}
