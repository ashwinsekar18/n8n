import { createTool } from '@mastra/core/tools';
import { instanceAiConfirmationSeveritySchema } from '@n8n/api-types';
import type { IDataObject } from '@n8n/workflow-sdk';
import { nanoid } from 'nanoid';
import { z } from 'zod';

import type { InstanceAiContext, WorkflowNode } from '../../types';

const setupNodeSchema = z.object({
	node: z.object({
		name: z.string(),
		type: z.string(),
		typeVersion: z.number(),
		parameters: z.record(z.unknown()),
		credentials: z.record(z.object({ id: z.string(), name: z.string() })).optional(),
		position: z.tuple([z.number(), z.number()]),
		id: z.string(),
	}),
	credentialType: z.string().optional(),
	existingCredentials: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
	parameterIssues: z.record(z.array(z.string())).optional(),
	isTrigger: z.boolean(),
	triggerTestResult: z
		.object({
			status: z.enum(['success', 'error', 'listening']),
			error: z.string().optional(),
		})
		.optional(),
});

type SetupRequest = z.infer<typeof setupNodeSchema>;

async function buildSetupRequest(
	context: InstanceAiContext,
	node: WorkflowNode,
	triggerTestResult?: { status: 'success' | 'error'; error?: string },
): Promise<SetupRequest> {
	const nodeDesc = await context.nodeService.getDescription(node.type).catch(() => undefined);
	const credentialType = nodeDesc?.credentials?.[0]?.name;
	const isTrigger = node.type.toLowerCase().includes('trigger');

	let existingCredentials: Array<{ id: string; name: string }> = [];
	if (credentialType) {
		const creds = await context.credentialService.list({ type: credentialType });
		existingCredentials = creds.map((c) => ({ id: c.id, name: c.name }));
	}

	const nodeRecord = node as unknown as Record<string, unknown>;
	return {
		node: {
			name: node.name,
			type: node.type,
			typeVersion: typeof nodeRecord.typeVersion === 'number' ? nodeRecord.typeVersion : 1,
			parameters: node.parameters ?? {},
			position: node.position as [number, number],
			id: typeof nodeRecord.id === 'string' ? nodeRecord.id : nanoid(),
		},
		...(credentialType ? { credentialType } : {}),
		...(existingCredentials.length > 0 ? { existingCredentials } : {}),
		isTrigger,
		...(triggerTestResult ? { triggerTestResult } : {}),
	};
}

export function createSetupWorkflowTool(context: InstanceAiContext) {
	return createTool({
		id: 'setup-workflow',
		description:
			'Open the workflow setup UI for the user to configure credentials, parameters, and ' +
			'test triggers for all nodes in a workflow. Always use this instead of setup-credentials ' +
			'when a workflowId is available — after building a workflow, or when the user asks to ' +
			'set up/configure a specific workflow. The user handles setup through the UI — you never ' +
			'see sensitive data. Returns success when the user applies changes.',
		inputSchema: z.object({
			workflowId: z.string().describe('ID of the workflow to set up'),
			projectId: z.string().optional().describe('Project ID to scope credential creation to'),
		}),
		outputSchema: z.object({
			success: z.boolean(),
			deferred: z.boolean().optional(),
			reason: z.string().optional(),
		}),
		suspendSchema: z.object({
			requestId: z.string(),
			message: z.string(),
			severity: instanceAiConfirmationSeveritySchema,
			setupRequests: z.array(setupNodeSchema),
			workflowId: z.string(),
			projectId: z.string().optional(),
		}),
		resumeSchema: z.object({
			approved: z.boolean(),
			action: z.enum(['apply', 'test-trigger']).optional(),
			credentials: z.record(z.string()).optional(),
			nodeParameters: z.record(z.record(z.unknown())).optional(),
			testTriggerNode: z.string().optional(),
		}),
		execute: async (input, ctx) => {
			const { resumeData, suspend } = ctx?.agent ?? {};

			// State 1: First call — fetch workflow, analyze nodes, build setup requests, suspend
			if (resumeData === undefined || resumeData === null) {
				const workflow = await context.workflowService.get(input.workflowId);

				const setupRequests = await Promise.all(
					workflow.nodes.map(async (node) => await buildSetupRequest(context, node)),
				);

				// Only include nodes that need setup (have credentials or are triggers)
				const filteredRequests = setupRequests.filter(
					(req) => req.credentialType !== undefined || req.isTrigger,
				);

				if (filteredRequests.length === 0) {
					return { success: true, reason: 'No nodes require setup.' };
				}

				await suspend?.({
					requestId: nanoid(),
					message: 'Configure credentials and parameters for your workflow',
					severity: 'info' as const,
					setupRequests: filteredRequests,
					workflowId: input.workflowId,
					...(input.projectId ? { projectId: input.projectId } : {}),
				});
				// suspend() never resolves
				return { success: false };
			}

			// State 2: User declined
			if (!resumeData.approved) {
				return {
					success: true,
					deferred: true,
					reason: 'User skipped workflow setup for now.',
				};
			}

			// State 3: Test trigger — apply creds/params, run trigger, re-suspend with result
			if (resumeData.action === 'test-trigger' && resumeData.testTriggerNode) {
				// Apply credentials to workflow if provided
				if (resumeData.credentials) {
					const workflowJson = await context.workflowService.getAsWorkflowJSON(input.workflowId);
					for (const node of workflowJson.nodes) {
						for (const [credType, credId] of Object.entries(resumeData.credentials)) {
							const cred = await context.credentialService.get(credId);
							if (cred) {
								node.credentials = {
									...node.credentials,
									[credType]: { id: cred.id, name: cred.name },
								};
							}
						}
					}
					await context.workflowService.updateFromWorkflowJSON(input.workflowId, workflowJson);
				}

				// Run trigger test
				let triggerTestResult: { status: 'success' | 'error'; error?: string };
				try {
					const result = await context.executionService.run(input.workflowId, undefined, {
						timeout: 30_000,
					});
					triggerTestResult =
						result.status === 'success'
							? { status: 'success' }
							: { status: 'error', error: result.error ?? 'Trigger test failed' };
				} catch (error) {
					triggerTestResult = {
						status: 'error',
						error: error instanceof Error ? error.message : 'Trigger test failed',
					};
				}

				// Re-fetch workflow and rebuild setup requests with trigger result
				const updatedWorkflow = await context.workflowService.get(input.workflowId);
				const refreshedRequests = await Promise.all(
					updatedWorkflow.nodes.map(
						async (node) =>
							await buildSetupRequest(
								context,
								node,
								node.name === resumeData.testTriggerNode ? triggerTestResult : undefined,
							),
					),
				);

				const filteredRefreshed = refreshedRequests.filter(
					(req) => req.credentialType !== undefined || req.isTrigger,
				);

				// Re-suspend with updated data
				await suspend?.({
					requestId: nanoid(),
					message: 'Configure credentials and parameters for your workflow',
					severity: 'info' as const,
					setupRequests: filteredRefreshed,
					workflowId: input.workflowId,
					...(input.projectId ? { projectId: input.projectId } : {}),
				});
				return { success: false };
			}

			// State 4: Apply — save credentials and parameters to workflow
			if (resumeData.credentials || resumeData.nodeParameters) {
				const workflowJson = await context.workflowService.getAsWorkflowJSON(input.workflowId);

				if (resumeData.credentials) {
					for (const node of workflowJson.nodes) {
						for (const [credType, credId] of Object.entries(resumeData.credentials)) {
							const cred = await context.credentialService.get(credId);
							if (cred) {
								node.credentials = {
									...node.credentials,
									[credType]: { id: cred.id, name: cred.name },
								};
							}
						}
					}
				}

				if (resumeData.nodeParameters) {
					for (const node of workflowJson.nodes) {
						if (!node.name) continue;
						const params = resumeData.nodeParameters[node.name] as IDataObject | undefined;
						if (params) {
							node.parameters = { ...node.parameters, ...params };
						}
					}
				}

				await context.workflowService.updateFromWorkflowJSON(input.workflowId, workflowJson);
			}

			return { success: true };
		},
	});
}
