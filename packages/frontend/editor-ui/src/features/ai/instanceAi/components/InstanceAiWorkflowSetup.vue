<script lang="ts" setup>
import { ref, computed, watch, onMounted } from 'vue';
import { N8nButton, N8nIcon, N8nText, N8nTooltip } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import type { InstanceAiWorkflowSetupNode, InstanceAiCredentialFlow } from '@n8n/api-types';
import type { INodeUi, INodeUpdatePropertiesInformation } from '@/Interface';
import { useInstanceAiStore } from '../instanceAi.store';
import { useCredentialsStore } from '@/features/credentials/credentials.store';
import CredentialIcon from '@/features/credentials/components/CredentialIcon.vue';
import NodeCredentials from '@/features/credentials/components/NodeCredentials.vue';
import { useWizardNavigation } from '@/features/ai/shared/composables/useWizardNavigation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SetupCard {
	id: string;
	credentialType?: string;
	nodes: InstanceAiWorkflowSetupNode[];
	isTrigger: boolean;
	isFirstTrigger: boolean;
	isTestable: boolean;
	credentialTestResult?: { success: boolean; message?: string };
	isAutoApplied: boolean;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

const props = defineProps<{
	requestId: string;
	setupRequests: InstanceAiWorkflowSetupNode[];
	workflowId: string;
	message: string;
	projectId?: string;
	credentialFlow?: InstanceAiCredentialFlow;
}>();

const i18n = useI18n();
const store = useInstanceAiStore();
const credentialsStore = useCredentialsStore();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HTTP_REQUEST_NODE_TYPE = 'n8n-nodes-base.httpRequest';
const HTTP_REQUEST_TOOL_NODE_TYPE = '@n8n/n8n-nodes-langchain.toolHttpRequest';

// ---------------------------------------------------------------------------
// Card grouping (with HTTP Request URL grouping)
// ---------------------------------------------------------------------------

const cards = computed((): SetupCard[] => {
	const result: SetupCard[] = [];
	const credGroups = new Map<string, InstanceAiWorkflowSetupNode[]>();

	for (const req of props.setupRequests) {
		if (req.credentialType) {
			// Group HTTP Request nodes by credentialType + URL
			const isHttpRequest =
				req.node.type === HTTP_REQUEST_NODE_TYPE || req.node.type === HTTP_REQUEST_TOOL_NODE_TYPE;

			let mapKey: string;
			if (isHttpRequest) {
				const url = String(req.node.parameters.url ?? '');
				mapKey = `${req.credentialType}:http:${url}`;
			} else {
				mapKey = req.credentialType;
			}

			const existing = credGroups.get(mapKey);
			if (existing) {
				existing.push(req);
			} else {
				credGroups.set(mapKey, [req]);
			}
		} else if (req.isTrigger) {
			result.push({
				id: `trigger-${req.node.id}`,
				nodes: [req],
				isTrigger: true,
				isFirstTrigger: req.isFirstTrigger ?? false,
				isTestable: req.isTestable ?? false,
				isAutoApplied: false,
			});
		}
	}

	for (const [mapKey, nodes] of credGroups) {
		const firstNode = nodes[0];
		const credType = firstNode.credentialType!;
		const testResult = nodes.find((n) => n.credentialTestResult)?.credentialTestResult;
		const autoApplied = nodes.some((n) => n.isAutoApplied);
		const hasFirstTrigger = nodes.some((n) => n.isFirstTrigger);

		result.push({
			id: `cred-${mapKey}`,
			credentialType: credType,
			nodes,
			isTrigger: nodes.some((n) => n.isTrigger),
			isFirstTrigger: hasFirstTrigger,
			isTestable: nodes.some((n) => n.isTestable),
			credentialTestResult: testResult,
			isAutoApplied: autoApplied,
		});
	}

	return result;
});

// ---------------------------------------------------------------------------
// Wizard navigation
// ---------------------------------------------------------------------------

const totalSteps = computed(() => cards.value.length);
const { currentStepIndex, isPrevDisabled, isNextDisabled, goToNext, goToPrev, goToStep } =
	useWizardNavigation({ totalSteps });

const currentCard = computed(() => cards.value[currentStepIndex.value]);
const showArrows = computed(() => totalSteps.value > 1);

// ---------------------------------------------------------------------------
// State — selections keyed by CARD ID (not credential type)
// ---------------------------------------------------------------------------

const isSubmitted = ref(false);
const isDeferred = ref(false);
const selections = ref<Record<string, string | null>>({});

const triggerTestResults = computed(() => {
	const results: Record<string, InstanceAiWorkflowSetupNode['triggerTestResult']> = {};
	for (const req of props.setupRequests) {
		if (req.triggerTestResult) {
			results[req.node.name] = req.triggerTestResult;
		}
	}
	return results;
});

// Sticky card tracking
const shownCardIds = ref(new Set<string>());
watch(
	cards,
	(newCards) => {
		for (const card of newCards) {
			shownCardIds.value.add(card.id);
		}
	},
	{ immediate: true },
);

// ---------------------------------------------------------------------------
// Auto-credential selection — keyed by card ID
// ---------------------------------------------------------------------------

function initSelections() {
	for (const card of cards.value) {
		if (!card.credentialType) continue;
		if (selections.value[card.id] !== undefined) continue;

		const firstReq = card.nodes[0];
		const credType = card.credentialType;

		// 1. Pre-fill from node's existing credential assignment
		const existingOnNode = firstReq.node.credentials?.[credType];
		if (existingOnNode?.id) {
			selections.value[card.id] = existingOnNode.id;
		} else if (firstReq.existingCredentials?.length === 1) {
			// 2. Auto-select if exactly one credential available
			selections.value[card.id] = firstReq.existingCredentials[0].id;
		} else if (card.isAutoApplied && firstReq.existingCredentials?.length) {
			// 3. Auto-selected by backend (most recent)
			selections.value[card.id] = firstReq.existingCredentials[0].id;
		} else {
			selections.value[card.id] = null;
		}
	}
}
initSelections();

// ---------------------------------------------------------------------------
// Completion — first-trigger-only logic
// ---------------------------------------------------------------------------

function isCardComplete(card: SetupCard): boolean {
	if (card.credentialType) {
		const selectedId = selections.value[card.id];
		if (!selectedId) return false;
		if (card.credentialTestResult && !card.credentialTestResult.success) return false;
	}

	// Trigger check — only the first trigger requires execution
	if (card.isTestable && card.isTrigger && card.isFirstTrigger) {
		const triggerNode = card.nodes.find((n) => n.isTrigger);
		if (triggerNode && !triggerTestResults.value[triggerNode.node.name]) return false;
	}

	return true;
}

const allCredentialsSelected = computed(() =>
	cards.value.filter((c) => c.credentialType).every((c) => selections.value[c.id] !== null),
);

// ---------------------------------------------------------------------------
// Auto-advance: only when a card transitions from incomplete → complete
// (not when navigating to an already-complete card)
// ---------------------------------------------------------------------------

const userNavigated = ref(false);

function wrappedGoToNext() {
	userNavigated.value = true;
	goToNext();
}

function wrappedGoToPrev() {
	userNavigated.value = true;
	goToPrev();
}

watch(
	() => currentCard.value && isCardComplete(currentCard.value),
	(complete, prevComplete) => {
		// Only auto-advance on a false→true transition (credential was just selected)
		// Skip if user just navigated to a card that was already complete
		if (!complete || prevComplete || userNavigated.value) {
			userNavigated.value = false;
			return;
		}
		const nextIncomplete = cards.value.findIndex(
			(c, i) => i > currentStepIndex.value && !isCardComplete(c),
		);
		if (nextIncomplete >= 0) {
			goToStep(nextIncomplete);
		}
	},
);

onMounted(() => {
	const firstIncomplete = cards.value.findIndex((c) => !isCardComplete(c));
	if (firstIncomplete > 0) {
		goToStep(firstIncomplete);
	}
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDisplayName(credentialType: string): string {
	return credentialsStore.getCredentialTypeByName(credentialType)?.displayName ?? credentialType;
}

function getCardTitle(card: SetupCard): string {
	if (card.nodes.length === 1) return card.nodes[0].node.name;
	if (card.credentialType) return getDisplayName(card.credentialType);
	return 'Setup';
}

function toNodeUi(setupNode: InstanceAiWorkflowSetupNode): INodeUi {
	return {
		id: setupNode.node.id,
		name: setupNode.node.name,
		type: setupNode.node.type,
		typeVersion: setupNode.node.typeVersion,
		position: setupNode.node.position,
		parameters: setupNode.node.parameters as INodeUi['parameters'],
		credentials: setupNode.node.credentials as INodeUi['credentials'],
	} as INodeUi;
}

function cardNodeUi(card: SetupCard): INodeUi {
	return toNodeUi(card.nodes[0]);
}

/** True when this card only has a trigger (no credentials) */
function isTriggerOnly(card: SetupCard): boolean {
	return card.isTrigger && !card.credentialType;
}

/** Use credential icon when it's a credential card */
function useCredentialIcon(card: SetupCard): boolean {
	return !!card.credentialType && !isTriggerOnly(card);
}

const nodeNames = computed(() => {
	const card = currentCard.value;
	if (!card) return [];
	return card.nodes.map((n) => n.node.name);
});

const nodeNamesTooltip = computed(() => nodeNames.value.join(', '));

function getCredTestIcon(card: SetupCard): 'spinner' | 'check' | 'triangle-alert' | null {
	if (!card.credentialType) return null;
	const selectedId = selections.value[card.id];
	if (!selectedId) return null;

	if (card.isAutoApplied && !card.credentialTestResult) return 'spinner';
	if (card.credentialTestResult?.success) return 'check';
	if (card.credentialTestResult && !card.credentialTestResult.success) return 'triangle-alert';
	return null;
}

// ---------------------------------------------------------------------------
// Build per-node credential mapping from card-scoped selections
// ---------------------------------------------------------------------------

function buildNodeCredentials(): Record<string, Record<string, string>> {
	const result: Record<string, Record<string, string>> = {};
	for (const card of cards.value) {
		if (!card.credentialType) continue;
		const selectedId = selections.value[card.id];
		if (!selectedId) continue;

		for (const req of card.nodes) {
			if (!result[req.node.name]) {
				result[req.node.name] = {};
			}
			result[req.node.name][card.credentialType] = selectedId;
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function onCredentialSelected(card: SetupCard, updateInfo: INodeUpdatePropertiesInformation) {
	if (!card.credentialType) return;
	const credentialData = updateInfo.properties.credentials?.[card.credentialType];
	const credentialId = typeof credentialData === 'string' ? undefined : credentialData?.id;

	if (credentialId) {
		selections.value[card.id] = credentialId;
	} else {
		selections.value[card.id] = null;
	}
}

function handleTestTrigger(nodeName: string) {
	const nodeCredentials = buildNodeCredentials();

	store.resolveConfirmation(props.requestId, 'approved');
	void store.confirmAction(
		props.requestId,
		true,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{
			action: 'test-trigger',
			testTriggerNode: nodeName,
			nodeCredentials,
		},
	);
}

function handleApply() {
	const nodeCredentials = buildNodeCredentials();

	isSubmitted.value = true;
	store.resolveConfirmation(props.requestId, 'approved');
	void store.confirmAction(
		props.requestId,
		true,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{
			action: 'apply',
			nodeCredentials,
		},
	);
}

function handleLater() {
	isSubmitted.value = true;
	isDeferred.value = true;
	store.resolveConfirmation(props.requestId, 'deferred');
	void store.confirmAction(props.requestId, false);
}
</script>

<template>
	<div :class="$style.root">
		<template v-if="!isSubmitted">
			<div
				v-if="currentCard"
				data-test-id="instance-ai-workflow-setup-card"
				:class="[$style.card, { [$style.completed]: isCardComplete(currentCard) }]"
			>
				<!-- Header -->
				<header :class="$style.header">
					<CredentialIcon
						v-if="useCredentialIcon(currentCard)"
						:credential-type-name="currentCard.credentialType!"
						:size="16"
					/>
					<N8nIcon v-else icon="play" size="small" />
					<N8nText :class="$style.title" size="medium" color="text-dark" bold>
						{{ getCardTitle(currentCard) }}
					</N8nText>

					<N8nIcon
						v-if="getCredTestIcon(currentCard) === 'spinner'"
						icon="spinner"
						size="small"
						:class="$style.loading"
					/>
					<N8nIcon
						v-else-if="getCredTestIcon(currentCard) === 'check'"
						icon="check"
						size="small"
						:class="$style.success"
					/>
					<N8nIcon
						v-else-if="getCredTestIcon(currentCard) === 'triangle-alert'"
						icon="triangle-alert"
						size="small"
						:class="$style.error"
					/>

					<N8nText
						v-if="isCardComplete(currentCard)"
						data-test-id="instance-ai-workflow-setup-step-check"
						:class="$style.completeLabel"
						size="medium"
						color="success"
					>
						<N8nIcon icon="check" size="large" />
						{{ i18n.baseText('generic.complete') }}
					</N8nText>
				</header>

				<!-- Content -->
				<div v-if="!isTriggerOnly(currentCard)" :class="$style.content">
					<div v-if="currentCard.credentialType" :class="$style.credentialContainer">
						<NodeCredentials
							:node="cardNodeUi(currentCard)"
							:override-cred-type="currentCard.credentialType"
							standalone
							hide-issues
							@credential-selected="onCredentialSelected(currentCard, $event)"
						>
							<template v-if="nodeNames.length > 1" #label-postfix>
								<N8nTooltip placement="top">
									<template #content>
										{{ nodeNamesTooltip }}
									</template>
									<N8nText
										data-test-id="instance-ai-workflow-setup-nodes-hint"
										size="small"
										color="text-light"
									>
										{{
											i18n.baseText('instanceAi.workflowSetup.usedByNodes', {
												interpolate: { count: String(nodeNames.length) },
											})
										}}
									</N8nText>
								</N8nTooltip>
							</template>
						</NodeCredentials>
					</div>
				</div>

				<!-- Footer -->
				<footer :class="$style.footer">
					<div :class="$style.footerNav">
						<N8nButton
							v-if="showArrows"
							variant="ghost"
							size="xsmall"
							icon-only
							:disabled="isPrevDisabled"
							data-test-id="instance-ai-workflow-setup-prev"
							aria-label="Previous step"
							@click="wrappedGoToPrev"
						>
							<N8nIcon icon="chevron-left" size="xsmall" />
						</N8nButton>
						<N8nText size="small" color="text-light">
							{{ currentStepIndex + 1 }} of {{ totalSteps }}
						</N8nText>
						<N8nButton
							v-if="showArrows"
							variant="ghost"
							size="xsmall"
							icon-only
							:disabled="isNextDisabled"
							data-test-id="instance-ai-workflow-setup-next"
							aria-label="Next step"
							@click="wrappedGoToNext"
						>
							<N8nIcon icon="chevron-right" size="xsmall" />
						</N8nButton>
					</div>

					<div :class="$style.footerActions">
						<N8nButton
							variant="ghost"
							size="small"
							:class="$style.actionButton"
							:label="i18n.baseText('instanceAi.workflowSetup.later')"
							data-test-id="instance-ai-workflow-setup-later"
							@click="handleLater"
						/>

						<N8nButton
							v-if="currentCard.isTestable && currentCard.isTrigger && currentCard.isFirstTrigger"
							size="small"
							:class="$style.actionButton"
							:label="i18n.baseText('instanceAi.workflowSetup.testTrigger')"
							:disabled="currentCard.credentialType ? selections[currentCard.id] === null : false"
							data-test-id="instance-ai-workflow-setup-test-trigger"
							@click="handleTestTrigger(currentCard.nodes.find((n) => n.isTrigger)!.node.name)"
						/>

						<N8nButton
							size="small"
							:class="$style.actionButton"
							:disabled="!allCredentialsSelected"
							:label="i18n.baseText('instanceAi.workflowSetup.apply')"
							data-test-id="instance-ai-workflow-setup-apply-button"
							@click="handleApply"
						/>
					</div>
				</footer>
			</div>
		</template>

		<div v-else :class="$style.submitted">
			<template v-if="isDeferred">
				<N8nIcon icon="arrow-right" size="small" :class="$style.skippedIcon" />
				<span>{{ i18n.baseText('instanceAi.workflowSetup.deferred') }}</span>
			</template>
			<template v-else>
				<N8nIcon icon="check" size="small" :class="$style.successIcon" />
				<span>{{ i18n.baseText('instanceAi.workflowSetup.applied') }}</span>
			</template>
		</div>
	</div>
</template>

<style lang="scss" module>
.root {
	border-top: var(--border);
	background: var(--color--background--shade-1);
	padding: var(--spacing--xs);
}

.card {
	width: 100%;
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
	padding: 0;
	background-color: var(--color--background--light-3);
	border: var(--border);
	border-radius: var(--radius);

	&.completed {
		border-color: var(--color--success);
	}
}

.header {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
	padding: var(--spacing--sm) var(--spacing--sm) 0;
}

.title {
	flex: 1;
}

.completeLabel {
	display: flex;
	align-items: center;
	gap: var(--spacing--4xs);
	white-space: nowrap;
}

.content {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
	padding: 0 var(--spacing--sm);
}

.credentialContainer {
	display: flex;
	flex-direction: column;

	:global(.node-credentials) {
		margin-top: 0;
	}
}

.footer {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
	border-top: var(--border);
	padding: var(--spacing--xs) var(--spacing--sm);
}

.footerNav {
	display: flex;
	flex: 1;
	align-items: center;
	gap: var(--spacing--4xs);
}

.footerActions {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}

.actionButton {
	--button--font-size: var(--font-size--2xs);
}

.success {
	color: var(--color--success);
}

.error {
	color: var(--color--danger);
}

.loading {
	color: var(--color--text--tint-1);
	animation: spin 1s linear infinite;
}

@keyframes spin {
	from {
		transform: rotate(0deg);
	}
	to {
		transform: rotate(360deg);
	}
}

.submitted {
	display: flex;
	align-items: center;
	gap: var(--spacing--4xs);
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
}

.successIcon {
	color: var(--color--success);
}

.skippedIcon {
	color: var(--color--text--tint-2);
}
</style>
