/**
 * src/schemas/goal.schema.ts
 * 
 * Zod schemas for validating goal submission requests.
 * Provides runtime type safety and detailed error messages.
 */

import { z } from 'zod';

// ============================================================================
// GOAL SUBMISSION SCHEMA
// ============================================================================

/**
 * Goal submission request validation schema
 * 
 * @example
 * ```typescript
 * const result = GoalSubmissionSchema.safeParse({
 *   goal: "diagnose why the database is slow in production",
 *   environment: "production",
 *   idempotencyKey: "550e8400-e29b-41d4-a716-446655440000"
 * });
 * ```
 */
export const GoalSubmissionSchema = z.object({
    /**
     * Natural language goal describing what the user wants to achieve.
     * Must be descriptive enough for the orchestrator to understand intent.
     */
    goal: z
        .string()
        .min(1, 'Goal must be at least 1 character'),

    /**
     * Optional metadata to attach to the workflow.
     * Can be used for custom routing, labeling, or audit purposes.
     */
    context: z
        .string()
        .optional(),

});

/**
 * Inferred TypeScript type from the schema
 */
export type GoalSubmission = z.infer<typeof GoalSubmissionSchema>;

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

/**
 * Validate goal submission and return detailed errors
 * 
 * @param data - Raw request data
 * @returns Validation result with typed data or detailed errors
 */
export function validateGoalSubmission(data: unknown) {
    const result = GoalSubmissionSchema.safeParse(data);

    if (!result.success) {
        const errors = result.error.issues.map((issue) => {
            const path = issue.path.join('.');
            return `${path || 'body'}: ${issue.message}`;
        });

        return {
            valid: false as const,
            errors,
            data: undefined,
        };
    }

    return {
        valid: true as const,
        errors: [],
        data: result.data,
    };
}

/**
 * Strict validation that throws on error
 * 
 * @param data - Raw request data
 * @returns Validated and typed data
 * @throws {z.ZodError} If validation fails
 */
export function strictValidateGoalSubmission(data: unknown): GoalSubmission {
    return GoalSubmissionSchema.parse(data);
}
