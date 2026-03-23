/**
 * setup-workflow tool — thin suspend/resume state machine.
 * All setup logic lives in setup-workflow.service.ts.
 */
import { createTool } from '@mastra/core/tools';
import type { WorkflowJSON } from '@n8n/workflow-sdk';
import { nanoid } from 'nanoid';
import { z } from 'zod';

import { setupSuspendSchema, setupResumeSchema } from './setup-workflow.schema';
import {
	analyzeWorkflow,
	applyNodeCredentials,
	applyNodeParameters,
} from './setup-workflow.service';
import type { InstanceAiContext } from '../../types';

export function createSetupWorkflowTool(context: InstanceAiContext) {
	let currentRequestId: string | null = null;
	let preTestSnapshot: WorkflowJSON | null = null;

	return createTool({
		id: 'setup-workflow',
		description:
			'Open the workflow setup UI for the user to configure credentials, parameters, and ' +
			'test triggers for all nodes in a workflow. Always use this instead of setup-credentials ' +
			'when a workflowId is available. The user handles setup through the UI — you never see ' +
			'sensitive data. Returns success when the user applies changes.',
		inputSchema: z.object({
			workflowId: z.string().describe('ID of the workflow to set up'),
			projectId: z.string().optional().describe('Project ID to scope credential creation to'),
		}),
		outputSchema: z.object({
			success: z.boolean(),
			deferred: z.boolean().optional(),
			reason: z.string().optional(),
		}),
		suspendSchema: setupSuspendSchema,
		resumeSchema: setupResumeSchema,
		execute: async (input, ctx) => {
			const { resumeData, suspend } = ctx?.agent ?? {};

			// State 1: Analyze workflow and suspend for user setup
			if (resumeData === undefined || resumeData === null) {
				const setupRequests = await analyzeWorkflow(context, input.workflowId);

				if (setupRequests.length === 0) {
					return { success: true, reason: 'No nodes require setup.' };
				}

				currentRequestId = nanoid();

				await suspend?.({
					requestId: currentRequestId,
					message: 'Configure credentials for your workflow',
					severity: 'info' as const,
					setupRequests,
					workflowId: input.workflowId,
					...(input.projectId ? { projectId: input.projectId } : {}),
				});
				return { success: false };
			}

			// State 2: User declined — revert any trigger-test changes
			if (!resumeData.approved) {
				if (preTestSnapshot) {
					await context.workflowService.updateFromWorkflowJSON(input.workflowId, preTestSnapshot);
					preTestSnapshot = null;
				}
				return {
					success: true,
					deferred: true,
					reason: 'User skipped workflow setup for now.',
				};
			}

			// State 3: Test trigger — persist changes, run, re-suspend with result
			if (resumeData.action === 'test-trigger' && resumeData.testTriggerNode) {
				preTestSnapshot ??= await context.workflowService.getAsWorkflowJSON(input.workflowId);

				if (resumeData.credentials) {
					await applyNodeCredentials(context, input.workflowId, resumeData.credentials);
				}
				if (resumeData.nodeParameters) {
					await applyNodeParameters(context, input.workflowId, resumeData.nodeParameters);
				}

				let triggerTestResult: {
					status: 'success' | 'error' | 'listening';
					error?: string;
				};
				try {
					const result = await context.executionService.run(input.workflowId, undefined, {
						timeout: 30_000,
					});
					if (result.status === 'success') {
						triggerTestResult = { status: 'success' };
					} else if (result.status === 'waiting') {
						triggerTestResult = { status: 'listening' as const };
					} else {
						triggerTestResult = {
							status: 'error',
							error: result.error ?? 'Trigger test failed',
						};
					}
				} catch (error) {
					triggerTestResult = {
						status: 'error',
						error: error instanceof Error ? error.message : 'Trigger test failed',
					};
				}

				const refreshedRequests = await analyzeWorkflow(context, input.workflowId, {
					[resumeData.testTriggerNode]: triggerTestResult,
				});

				await suspend?.({
					requestId: currentRequestId ?? nanoid(),
					message: 'Configure credentials for your workflow',
					severity: 'info' as const,
					setupRequests: refreshedRequests,
					workflowId: input.workflowId,
					...(input.projectId ? { projectId: input.projectId } : {}),
				});
				return { success: false };
			}

			// State 4: Apply — save credentials and parameters
			preTestSnapshot = null;
			if (resumeData.credentials) {
				await applyNodeCredentials(context, input.workflowId, resumeData.credentials);
			}
			if (resumeData.nodeParameters) {
				await applyNodeParameters(context, input.workflowId, resumeData.nodeParameters);
			}

			return { success: true };
		},
	});
}
