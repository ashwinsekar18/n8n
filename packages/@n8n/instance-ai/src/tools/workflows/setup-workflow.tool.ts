import { createTool } from '@mastra/core/tools';
import { instanceAiConfirmationSeveritySchema } from '@n8n/api-types';
import type { NodeJSON } from '@n8n/workflow-sdk';
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
	isTrigger: z.boolean(),
	isFirstTrigger: z.boolean().optional(),
	isTestable: z.boolean().optional(),
	isAutoApplied: z.boolean().optional(),
	credentialTestResult: z
		.object({
			success: z.boolean(),
			message: z.string().optional(),
		})
		.optional(),
	triggerTestResult: z
		.object({
			status: z.enum(['success', 'error', 'listening']),
			error: z.string().optional(),
		})
		.optional(),
});

type SetupRequest = z.infer<typeof setupNodeSchema>;

/**
 * Build setup request(s) from a WorkflowJSON node.
 * Detects credential types, auto-selects the most recent credential,
 * tests testable credentials, and determines trigger eligibility.
 */
async function buildSetupRequests(
	context: InstanceAiContext,
	node: NodeJSON,
	triggerTestResult?: { status: 'success' | 'error'; error?: string },
): Promise<SetupRequest[]> {
	if (!node.name) return [];
	if (node.disabled) return [];

	const typeVersion = node.typeVersion ?? 1;
	const parameters = (node.parameters as Record<string, unknown>) ?? {};

	const nodeDesc = await context.nodeService.getDescription(node.type).catch(() => undefined);

	const isTrigger = nodeDesc?.group?.includes('trigger') ?? false;
	const isTestable =
		isTrigger &&
		((nodeDesc?.webhooks !== undefined && nodeDesc.webhooks.length > 0) ||
			nodeDesc?.polling === true ||
			nodeDesc?.triggerPanel !== undefined);

	let credentialTypes: string[] = [];
	if (context.nodeService.getNodeCredentialTypes) {
		credentialTypes = await context.nodeService
			.getNodeCredentialTypes(
				node.type,
				typeVersion,
				parameters,
				node.credentials as Record<string, unknown> | undefined,
			)
			.catch(() => []);
	} else {
		const nodeCredTypes = node.credentials ? Object.keys(node.credentials) : [];
		if (nodeCredTypes.length > 0) {
			credentialTypes = nodeCredTypes;
		} else if (nodeDesc?.credentials?.[0]?.name) {
			credentialTypes = [nodeDesc.credentials[0].name];
		}
	}

	const nodeId = node.id ?? nanoid();
	const nodePosition: [number, number] = node.position ?? [0, 0];

	const requests: SetupRequest[] = [];
	const processedCredTypes = credentialTypes.length > 0 ? credentialTypes : [undefined];

	for (const credentialType of processedCredTypes) {
		let existingCredentials: Array<{ id: string; name: string }> = [];
		let isAutoApplied = false;
		let credentialTestResult: { success: boolean; message?: string } | undefined;
		const nodeCredentials = node.credentials
			? Object.fromEntries(
					Object.entries(node.credentials)
						.filter(([, v]) => v.id !== undefined)
						.map(([k, v]) => [k, { id: v.id!, name: v.name }]),
				)
			: undefined;

		if (credentialType) {
			const creds = await context.credentialService.list({ type: credentialType });
			existingCredentials = creds
				.map((c) => ({ id: c.id, name: c.name, updatedAt: c.updatedAt }))
				.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
				.map((c) => ({ id: c.id, name: c.name }));

			const existingOnNode = node.credentials?.[credentialType];
			if (!existingOnNode?.id && existingCredentials.length > 0) {
				isAutoApplied = true;
				if (nodeCredentials) {
					nodeCredentials[credentialType] = {
						id: existingCredentials[0].id,
						name: existingCredentials[0].name,
					};
				}
			}

			// Only test if the credential type has a test function (skip Header Auth etc.)
			const credToTest =
				existingOnNode?.id ?? (isAutoApplied ? existingCredentials[0]?.id : undefined);
			if (credToTest) {
				const canTest = context.credentialService.isTestable
					? await context.credentialService.isTestable(credentialType).catch(() => true)
					: true;
				if (canTest) {
					credentialTestResult = await context.credentialService
						.test(credToTest)
						.catch((testError) => ({
							success: false,
							message: testError instanceof Error ? testError.message : 'Test failed',
						}));
				}
			}
		}

		// Only include nodes that need credentials or are triggers
		if (!credentialType && !isTrigger) continue;
		// Suppress standalone cards for non-testable triggers (matches builder)
		if (!credentialType && isTrigger && !isTestable) continue;

		const request: SetupRequest = {
			node: {
				name: node.name,
				type: node.type,
				typeVersion,
				parameters,
				position: nodePosition,
				id: nodeId,
				...(nodeCredentials && Object.keys(nodeCredentials).length > 0
					? {
							credentials:
								isAutoApplied && credentialType && existingCredentials.length > 0
									? {
											...nodeCredentials,
											[credentialType]: {
												id: existingCredentials[0].id,
												name: existingCredentials[0].name,
											},
										}
									: nodeCredentials,
						}
					: isAutoApplied && credentialType && existingCredentials.length > 0
						? {
								credentials: {
									[credentialType]: {
										id: existingCredentials[0].id,
										name: existingCredentials[0].name,
									},
								},
							}
						: {}),
			},
			...(credentialType ? { credentialType } : {}),
			...(existingCredentials.length > 0 ? { existingCredentials } : {}),
			isTrigger,
			...(isTestable ? { isTestable } : {}),
			...(isAutoApplied ? { isAutoApplied } : {}),
			...(credentialTestResult ? { credentialTestResult } : {}),
			...(triggerTestResult ? { triggerTestResult } : {}),
		};

		requests.push(request);
	}

	return requests;
}

/** Sort setup requests by position (Y-then-X) and mark the first trigger. */
function sortAndMarkFirstTrigger(requests: SetupRequest[]) {
	requests.sort(
		(a, b) => a.node.position[1] - b.node.position[1] || a.node.position[0] - b.node.position[0],
	);
	const firstTrigger = requests.find((r) => r.isTrigger);
	if (firstTrigger) {
		firstTrigger.isFirstTrigger = true;
	}
}

/** Apply per-node credentials from resume data to a WorkflowJSON. */
async function applyNodeCredentials(
	context: InstanceAiContext,
	workflowId: string,
	nodeCredentials: Record<string, Record<string, string>>,
) {
	const workflowJson = await context.workflowService.getAsWorkflowJSON(workflowId);
	for (const node of workflowJson.nodes) {
		if (!node.name) continue;
		const credsMap = nodeCredentials[node.name];
		if (!credsMap) continue;
		for (const [credType, credId] of Object.entries(credsMap)) {
			const cred = await context.credentialService.get(credId);
			if (cred) {
				node.credentials = {
					...node.credentials,
					[credType]: { id: cred.id, name: cred.name },
				};
			}
		}
	}
	await context.workflowService.updateFromWorkflowJSON(workflowId, workflowJson);
}

export function createSetupWorkflowTool(context: InstanceAiContext) {
	let currentRequestId: string | null = null;

	return createTool({
		id: 'setup-workflow',
		description:
			'Open the workflow setup UI for the user to configure credentials and test triggers ' +
			'for all nodes in a workflow. Always use this instead of setup-credentials when a ' +
			'workflowId is available. The user handles setup through the UI — you never see ' +
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
			credentials: z.record(z.record(z.string())).optional(),
			testTriggerNode: z.string().optional(),
		}),
		execute: async (input, ctx) => {
			const { resumeData, suspend } = ctx?.agent ?? {};

			// State 1: First call — build setup requests and suspend
			if (resumeData === undefined || resumeData === null) {
				const workflowJson = await context.workflowService.getAsWorkflowJSON(input.workflowId);

				const allRequestArrays = await Promise.all(
					workflowJson.nodes.map(async (node) => await buildSetupRequests(context, node)),
				);

				const setupRequests = allRequestArrays
					.flat()
					.filter((req) => req.credentialType !== undefined || req.isTrigger);

				sortAndMarkFirstTrigger(setupRequests);

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

			// State 2: User declined
			if (!resumeData.approved) {
				return {
					success: true,
					deferred: true,
					reason: 'User skipped workflow setup for now.',
				};
			}

			// State 3: Test trigger — persist creds, run trigger, re-suspend with result
			if (resumeData.action === 'test-trigger' && resumeData.testTriggerNode) {
				if (resumeData.credentials) {
					await applyNodeCredentials(context, input.workflowId, resumeData.credentials);
				}

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

				const updatedJson = await context.workflowService.getAsWorkflowJSON(input.workflowId);
				const allRefreshed = await Promise.all(
					updatedJson.nodes.map(
						async (node) =>
							await buildSetupRequests(
								context,
								node,
								node.name === resumeData.testTriggerNode ? triggerTestResult : undefined,
							),
					),
				);

				const refreshedRequests = allRefreshed
					.flat()
					.filter((req) => req.credentialType !== undefined || req.isTrigger);

				sortAndMarkFirstTrigger(refreshedRequests);

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

			// State 4: Apply — save credentials to workflow
			if (resumeData.credentials) {
				await applyNodeCredentials(context, input.workflowId, resumeData.credentials);
			}

			return { success: true };
		},
	});
}
