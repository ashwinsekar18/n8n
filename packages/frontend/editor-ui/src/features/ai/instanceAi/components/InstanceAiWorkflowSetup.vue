<script lang="ts" setup>
import { ref, computed, watch } from 'vue';
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
	hasParamIssues: boolean;
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
// Card grouping
// ---------------------------------------------------------------------------

const cards = computed((): SetupCard[] => {
	const result: SetupCard[] = [];
	const credGroups = new Map<string, InstanceAiWorkflowSetupNode[]>();

	for (const req of props.setupRequests) {
		const hasIssues =
			req.parameterIssues !== undefined && Object.keys(req.parameterIssues).length > 0;

		if (hasIssues) {
			result.push({
				id: `node-${req.node.id}`,
				credentialType: req.credentialType,
				nodes: [req],
				isTrigger: req.isTrigger,
				hasParamIssues: true,
			});
		} else if (req.credentialType) {
			const existing = credGroups.get(req.credentialType);
			if (existing) {
				existing.push(req);
			} else {
				credGroups.set(req.credentialType, [req]);
			}
		} else if (req.isTrigger) {
			result.push({
				id: `trigger-${req.node.id}`,
				nodes: [req],
				isTrigger: true,
				hasParamIssues: false,
			});
		}
	}

	for (const [credType, nodes] of credGroups) {
		result.push({
			id: `cred-${credType}`,
			credentialType: credType,
			nodes,
			isTrigger: nodes.some((n) => n.isTrigger),
			hasParamIssues: false,
		});
	}

	return result;
});

// ---------------------------------------------------------------------------
// Wizard navigation
// ---------------------------------------------------------------------------

const totalSteps = computed(() => cards.value.length);
const { currentStepIndex, isPrevDisabled, isNextDisabled, goToNext, goToPrev } =
	useWizardNavigation({ totalSteps });

const currentCard = computed(() => cards.value[currentStepIndex.value]);
const showArrows = computed(() => totalSteps.value > 1);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const isSubmitted = ref(false);
const isDeferred = ref(false);
const selections = ref<Record<string, string | null>>({});
const paramValues = ref<Record<string, Record<string, unknown>>>({});

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
// Auto-credential selection
// ---------------------------------------------------------------------------

function initSelections() {
	for (const req of props.setupRequests) {
		if (!req.credentialType) continue;
		if (selections.value[req.credentialType] !== undefined) continue;

		// 1. Pre-fill from node's existing credential assignment
		const existingOnNode = req.node.credentials?.[req.credentialType];
		if (existingOnNode?.id) {
			selections.value[req.credentialType] = existingOnNode.id;
			// 2. Auto-select if exactly one credential available
		} else if (req.existingCredentials?.length === 1) {
			selections.value[req.credentialType] = req.existingCredentials[0].id;
		} else {
			selections.value[req.credentialType] = null;
		}
	}
}
initSelections();

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

function isCardComplete(card: SetupCard): boolean {
	if (card.credentialType) {
		const selectedId = selections.value[card.credentialType];
		if (!selectedId) return false;
	}
	if (card.hasParamIssues) return false;
	if (card.isTrigger) {
		const triggerNode = card.nodes.find((n) => n.isTrigger);
		if (triggerNode && !triggerTestResults.value[triggerNode.node.name]) return false;
	}
	return true;
}

const allCredentialsSelected = computed(() =>
	cards.value
		.filter((c) => c.credentialType)
		.every((c) => selections.value[c.credentialType!] !== null),
);

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

/** True when this card only has a trigger (no credentials, no params) */
function isTriggerOnly(card: SetupCard): boolean {
	return card.isTrigger && !card.credentialType && !card.hasParamIssues;
}

/** Use credential icon when it's a credential-only card (no params shown) */
function useCredentialIcon(card: SetupCard): boolean {
	return !!card.credentialType && !card.hasParamIssues && !isTriggerOnly(card);
}

const nodeNames = computed(() => {
	const card = currentCard.value;
	if (!card) return [];
	return card.nodes.map((n) => n.node.name);
});

const nodeNamesTooltip = computed(() => nodeNames.value.join(', '));

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function onCredentialSelected(card: SetupCard, updateInfo: INodeUpdatePropertiesInformation) {
	if (!card.credentialType) return;
	const credentialData = updateInfo.properties.credentials?.[card.credentialType];
	const credentialId = typeof credentialData === 'string' ? undefined : credentialData?.id;

	if (credentialId) {
		selections.value[card.credentialType] = credentialId;
	} else {
		selections.value[card.credentialType] = null;
	}
}

function handleTestTrigger(nodeName: string) {
	const credentials: Record<string, string> = {};
	for (const [type, id] of Object.entries(selections.value)) {
		if (id) credentials[type] = id;
	}

	store.resolveConfirmation(props.requestId, 'approved');
	void store.confirmAction(
		props.requestId,
		true,
		undefined,
		credentials,
		undefined,
		undefined,
		undefined,
		{
			action: 'test-trigger',
			testTriggerNode: nodeName,
			nodeParameters: Object.keys(paramValues.value).length > 0 ? paramValues.value : undefined,
		},
	);
}

function handleApply() {
	const credentials: Record<string, string> = {};
	for (const [type, id] of Object.entries(selections.value)) {
		if (id) credentials[type] = id;
	}

	isSubmitted.value = true;
	store.resolveConfirmation(props.requestId, 'approved');
	void store.confirmAction(
		props.requestId,
		true,
		undefined,
		credentials,
		undefined,
		undefined,
		undefined,
		{
			action: 'apply',
			nodeParameters: Object.keys(paramValues.value).length > 0 ? paramValues.value : undefined,
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
				<!-- Header (matches BuilderSetupCard) -->
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

				<!-- Content (matches BuilderSetupCard) -->
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

					<!-- Parameter issues (per-node cards) -->
					<div
						v-if="currentCard.hasParamIssues && currentCard.nodes[0]?.parameterIssues"
						:class="$style.parameterIssues"
					>
						<N8nText size="small" color="text-light">
							{{ i18n.baseText('instanceAi.workflowSetup.parameterIssues') }}
						</N8nText>
						<ul :class="$style.issueList">
							<li
								v-for="(issues, paramName) in currentCard.nodes[0].parameterIssues"
								:key="paramName"
							>
								<N8nText size="small" color="text-dark" bold>{{ paramName }}:</N8nText>
								{{ issues.join(', ') }}
							</li>
						</ul>
					</div>
				</div>

				<!-- Footer (matches BuilderSetupCard) -->
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
							@click="goToPrev"
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
							@click="goToNext"
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
							v-if="currentCard.isTrigger"
							size="small"
							:class="$style.actionButton"
							:label="i18n.baseText('instanceAi.workflowSetup.testTrigger')"
							:disabled="
								currentCard.credentialType ? selections[currentCard.credentialType] === null : false
							"
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
/* Matches BuilderSetupCard.vue from the chat sidebar */

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

.parameterIssues {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}

.issueList {
	margin: 0;
	padding-left: var(--spacing--sm);
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
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
