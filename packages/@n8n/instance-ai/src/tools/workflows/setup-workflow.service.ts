/**
 * Setup workflow service — encapsulates all logic for analyzing workflow nodes,
 * building setup requests, sorting by execution order, and applying user changes.
 *
 * Separated from the tool definition so the tool stays a thin suspend/resume
 * state machine, and this logic is testable independently.
 */
import type { IDataObject, NodeJSON } from '@n8n/workflow-sdk';
import { nanoid } from 'nanoid';

import type { SetupRequest } from './setup-workflow.schema';
import type { InstanceAiContext } from '../../types';

// ── Node analysis ───────────────────────────────────────────────────────────

/**
 * Build setup request(s) from a single WorkflowJSON node.
 * Detects credential types, auto-selects the most recent credential,
 * tests testable credentials, determines trigger eligibility, and
 * computes parameter issues with editable parameter definitions.
 */
export async function buildSetupRequests(
	context: InstanceAiContext,
	node: NodeJSON,
	triggerTestResult?: { status: 'success' | 'error' | 'listening'; error?: string },
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

	// Compute parameter issues
	let parameterIssues: Record<string, string[]> = {};
	if (context.nodeService.getParameterIssues) {
		parameterIssues = await context.nodeService
			.getParameterIssues(node.type, typeVersion, parameters)
			.catch(() => ({}));
	}

	// Build editable parameter definitions for parameters that have issues
	let editableParameters: SetupRequest['editableParameters'];
	if (Object.keys(parameterIssues).length > 0 && nodeDesc?.properties) {
		editableParameters = [];
		for (const paramName of Object.keys(parameterIssues)) {
			const prop = nodeDesc.properties.find((p) => p.name === paramName);
			if (!prop) continue;
			editableParameters.push({
				name: prop.name,
				displayName: prop.displayName,
				type: prop.type,
				...(prop.required !== undefined ? { required: prop.required } : {}),
				...(prop.default !== undefined ? { default: prop.default } : {}),
				...(prop.options
					? {
							options: prop.options as SetupRequest['editableParameters'] extends Array<infer T>
								? T extends { options?: infer O }
									? O
									: never
								: never,
						}
					: {}),
			});
		}
	}

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
	const hasParamIssues = Object.keys(parameterIssues).length > 0;

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

		if (!credentialType && !isTrigger && !hasParamIssues) continue;
		if (!credentialType && isTrigger && !isTestable && !hasParamIssues) continue;

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
			...(hasParamIssues ? { parameterIssues } : {}),
			...(editableParameters && editableParameters.length > 0 ? { editableParameters } : {}),
		};

		requests.push(request);
	}

	return requests;
}

// ── Execution order ─────────────────────────────────────────────────────────

/**
 * Sort setup requests by execution order derived from workflow connections,
 * then mark the first trigger in the result.
 *
 * Algorithm: DFS from each trigger (sorted left-to-right by X position),
 * following outgoing connections. Nodes not reachable from any trigger go last.
 */
export function sortByExecutionOrder(
	requests: SetupRequest[],
	connections: Record<string, unknown>,
): void {
	const adjacency = new Map<string, string[]>();
	for (const [sourceName, nodeConns] of Object.entries(connections)) {
		if (typeof nodeConns !== 'object' || nodeConns === null) continue;
		const destinations: string[] = [];
		for (const outputs of Object.values(nodeConns as Record<string, unknown>)) {
			if (!Array.isArray(outputs)) continue;
			for (const slot of outputs) {
				if (!Array.isArray(slot)) continue;
				for (const conn of slot) {
					if (typeof conn === 'object' && conn !== null && 'node' in conn) {
						const destName = (conn as { node: string }).node;
						if (!destinations.includes(destName)) {
							destinations.push(destName);
						}
					}
				}
			}
		}
		adjacency.set(sourceName, destinations);
	}

	const triggerRequests = requests
		.filter((r) => r.isTrigger)
		.sort((a, b) => a.node.position[0] - b.node.position[0]);

	const visited = new Set<string>();
	const executionOrder: string[] = [];

	function dfs(nodeName: string): void {
		if (visited.has(nodeName)) return;
		visited.add(nodeName);
		executionOrder.push(nodeName);
		const children = adjacency.get(nodeName) ?? [];
		for (const child of children) {
			dfs(child);
		}
	}

	for (const trigger of triggerRequests) {
		dfs(trigger.node.name);
	}

	const orderMap = new Map<string, number>();
	for (let i = 0; i < executionOrder.length; i++) {
		orderMap.set(executionOrder[i], i);
	}

	requests.sort((a, b) => {
		const aOrder = orderMap.get(a.node.name) ?? Number.MAX_SAFE_INTEGER;
		const bOrder = orderMap.get(b.node.name) ?? Number.MAX_SAFE_INTEGER;
		if (aOrder !== bOrder) return aOrder - bOrder;
		return a.node.position[0] - b.node.position[0] || a.node.position[1] - b.node.position[1];
	});

	const firstTrigger = requests.find((r) => r.isTrigger);
	if (firstTrigger) {
		firstTrigger.isFirstTrigger = true;
	}
}

// ── Workflow mutation ───────────────────────────────────────────────────────

/** Apply per-node credentials from resume data to a workflow. */
export async function applyNodeCredentials(
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

/** Apply per-node parameter values from resume data to a workflow. */
export async function applyNodeParameters(
	context: InstanceAiContext,
	workflowId: string,
	nodeParameters: Record<string, Record<string, unknown>>,
) {
	const workflowJson = await context.workflowService.getAsWorkflowJSON(workflowId);
	for (const node of workflowJson.nodes) {
		if (!node.name) continue;
		const params = nodeParameters[node.name];
		if (!params) continue;
		node.parameters = {
			...(node.parameters ?? {}),
			...params,
		} as IDataObject;
	}
	await context.workflowService.updateFromWorkflowJSON(workflowId, workflowJson);
}

// ── Full workflow analysis ──────────────────────────────────────────────────

/**
 * Analyze all nodes in a workflow and produce sorted setup requests.
 * This is the main entry point — combines buildSetupRequests + sort + filter.
 */
export async function analyzeWorkflow(
	context: InstanceAiContext,
	workflowId: string,
	triggerResults?: Record<string, { status: 'success' | 'error' | 'listening'; error?: string }>,
): Promise<SetupRequest[]> {
	const workflowJson = await context.workflowService.getAsWorkflowJSON(workflowId);

	const allRequestArrays = await Promise.all(
		workflowJson.nodes.map(async (node) => {
			return await buildSetupRequests(context, node, triggerResults?.[node.name ?? '']);
		}),
	);

	const setupRequests = allRequestArrays
		.flat()
		.filter(
			(req) =>
				req.credentialType !== undefined ||
				req.isTrigger ||
				(req.parameterIssues && Object.keys(req.parameterIssues).length > 0),
		);

	sortByExecutionOrder(
		setupRequests,
		workflowJson.connections as unknown as Record<string, unknown>,
	);

	return setupRequests;
}
