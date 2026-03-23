import { createTool } from '@mastra/core/tools';
import { instanceAiConfirmationSeveritySchema } from '@n8n/api-types';
import type { IDataObject, NodeJSON } from '@n8n/workflow-sdk';
import { nanoid } from 'nanoid';
import { z } from 'zod';

import type { InstanceAiContext } from '../../types';

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

/**
 * Build a setup request from a WorkflowJSON node.
 * Uses the node's own credential types (from its credentials field) rather than
 * fetching the node type description, which avoids typeVersion mismatch issues.
 */
async function buildSetupRequest(
	context: InstanceAiContext,
	node: NodeJSON,
	triggerTestResult?: { status: 'success' | 'error'; error?: string },
): Promise<SetupRequest | null> {
	if (!node.name) return null;

	// Use credentials already on the node (from WorkflowJSON) to determine type.
	// This is more reliable than getDescription() which may return the wrong version.
	const nodeCredTypes = node.credentials ? Object.keys(node.credentials) : [];

	// Fall back to node description if the node has no credentials assigned yet
	let credentialType: string | undefined;
	if (nodeCredTypes.length > 0) {
		credentialType = nodeCredTypes[0];
	} else {
		const nodeDesc = await context.nodeService.getDescription(node.type).catch(() => undefined);
		credentialType = nodeDesc?.credentials?.[0]?.name;
	}

	const isTrigger = node.type.toLowerCase().includes('trigger');

	let existingCredentials: Array<{ id: string; name: string }> = [];
	if (credentialType) {
		const creds = await context.credentialService.list({ type: credentialType });
		existingCredentials = creds.map((c) => ({ id: c.id, name: c.name }));
	}

	return {
		node: {
			name: node.name,
			type: node.type,
			typeVersion: node.typeVersion ?? 1,
			parameters: (node.parameters as Record<string, unknown>) ?? {},
			position: node.position ?? [0, 0],
			id: node.id ?? nanoid(),
			...(node.credentials
				? {
						credentials: Object.fromEntries(
							Object.entries(node.credentials)
								.filter(([, v]) => v.id !== undefined)
								.map(([k, v]) => [k, { id: v.id!, name: v.name }]),
						),
					}
				: {}),
		},
		...(credentialType ? { credentialType } : {}),
		...(existingCredentials.length > 0 ? { existingCredentials } : {}),
		isTrigger,
		...(triggerTestResult ? { triggerTestResult } : {}),
	};
}

/**
 * Build a map of which credential types each node needs.
 * Used during Apply to assign credentials only to matching nodes.
 */
function buildNodeCredentialMap(setupRequests: SetupRequest[]): Map<string, Set<string>> {
	const map = new Map<string, Set<string>>();
	for (const req of setupRequests) {
		if (!req.credentialType) continue;
		let nodeNames = map.get(req.credentialType);
		if (!nodeNames) {
			nodeNames = new Set();
			map.set(req.credentialType, nodeNames);
		}
		for (const node of [req]) {
			nodeNames.add(node.node.name);
		}
	}
	return map;
}

export function createSetupWorkflowTool(context: InstanceAiContext) {
	// Stable requestId across re-suspends so the frontend component persists
	let currentRequestId: string | null = null;
	// Keep the last setup requests to know which nodes need which credentials
	let lastSetupRequests: SetupRequest[] = [];

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
				// Use getAsWorkflowJSON for full node data (typeVersion, credentials, id)
				const workflowJson = await context.workflowService.getAsWorkflowJSON(input.workflowId);

				const allRequests = await Promise.all(
					workflowJson.nodes.map(async (node) => await buildSetupRequest(context, node)),
				);

				const setupRequests = allRequests.filter(
					(req): req is SetupRequest =>
						req !== null && (req.credentialType !== undefined || req.isTrigger),
				);

				if (setupRequests.length === 0) {
					return { success: true, reason: 'No nodes require setup.' };
				}

				// Store for later use during Apply
				lastSetupRequests = setupRequests;
				// Generate stable requestId for this tool invocation
				currentRequestId = nanoid();

				await suspend?.({
					requestId: currentRequestId,
					message: 'Configure credentials and parameters for your workflow',
					severity: 'info' as const,
					setupRequests,
					workflowId: input.workflowId,
					...(input.projectId ? { projectId: input.projectId } : {}),
				});
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
				// Apply credentials to matching nodes only
				if (resumeData.credentials) {
					const workflowJson = await context.workflowService.getAsWorkflowJSON(input.workflowId);
					const nodeCredMap = buildNodeCredentialMap(lastSetupRequests);

					for (const node of workflowJson.nodes) {
						if (!node.name) continue;
						for (const [credType, credId] of Object.entries(resumeData.credentials)) {
							const nodesForType = nodeCredMap.get(credType);
							if (!nodesForType?.has(node.name)) continue;

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

				// Re-fetch and rebuild with trigger result
				const updatedJson = await context.workflowService.getAsWorkflowJSON(input.workflowId);
				const allRefreshed = await Promise.all(
					updatedJson.nodes.map(
						async (node) =>
							await buildSetupRequest(
								context,
								node,
								node.name === resumeData.testTriggerNode ? triggerTestResult : undefined,
							),
					),
				);

				const refreshedRequests = allRefreshed.filter(
					(req): req is SetupRequest =>
						req !== null && (req.credentialType !== undefined || req.isTrigger),
				);

				lastSetupRequests = refreshedRequests;

				// Re-suspend with SAME requestId so frontend component persists
				await suspend?.({
					requestId: currentRequestId ?? nanoid(),
					message: 'Configure credentials and parameters for your workflow',
					severity: 'info' as const,
					setupRequests: refreshedRequests,
					workflowId: input.workflowId,
					...(input.projectId ? { projectId: input.projectId } : {}),
				});
				return { success: false };
			}

			// State 4: Apply — save credentials and parameters to matching nodes only
			if (resumeData.credentials || resumeData.nodeParameters) {
				const workflowJson = await context.workflowService.getAsWorkflowJSON(input.workflowId);

				if (resumeData.credentials) {
					const nodeCredMap = buildNodeCredentialMap(lastSetupRequests);

					for (const node of workflowJson.nodes) {
						if (!node.name) continue;
						for (const [credType, credId] of Object.entries(resumeData.credentials)) {
							const nodesForType = nodeCredMap.get(credType);
							if (!nodesForType?.has(node.name)) continue;

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
