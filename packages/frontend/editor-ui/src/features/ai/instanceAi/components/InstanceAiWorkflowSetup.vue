<script lang="ts" setup>
import { ref, computed, watch } from 'vue';
import { N8nButton, N8nIcon, N8nText, type IconName } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import type { InstanceAiWorkflowSetupNode, InstanceAiCredentialFlow } from '@n8n/api-types';
import type { ICredentialsDecrypted } from 'n8n-workflow';
import type { INodeUi, INodeUpdatePropertiesInformation } from '@/Interface';
import { useInstanceAiStore } from '../instanceAi.store';
import { useCredentialsStore } from '@/features/credentials/credentials.store';
import CredentialIcon from '@/features/credentials/components/CredentialIcon.vue';
import NodeCredentials from '@/features/credentials/components/NodeCredentials.vue';
import { useWizardNavigation } from '@/features/ai/shared/composables/useWizardNavigation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single card in the wizard — grouped by credential type or per-node */
interface SetupCard {
	id: string;
	credentialType?: string;
	/** All setup nodes covered by this card */
	nodes: InstanceAiWorkflowSetupNode[];
	/** True when any node in this card is a trigger */
	isTrigger: boolean;
	/** True when this card has per-node parameter issues (not grouped) */
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
// Card grouping (smart + adaptive splitting)
// ---------------------------------------------------------------------------

/** Build grouped cards from flat setup requests.
 *  - Nodes with parameterIssues → per-node card (even if they share a credential type)
 *  - Nodes with credentialType and no param issues → grouped by credential type
 *  - Trigger-only nodes (no credential, no param issues) → trigger card
 */
const cards = computed((): SetupCard[] => {
	const result: SetupCard[] = [];
	const credGroups = new Map<string, InstanceAiWorkflowSetupNode[]>();

	for (const req of props.setupRequests) {
		const hasIssues =
			req.parameterIssues !== undefined && Object.keys(req.parameterIssues).length > 0;

		if (hasIssues) {
			// Per-node card — has parameter issues
			result.push({
				id: `node-${req.node.id}`,
				credentialType: req.credentialType,
				nodes: [req],
				isTrigger: req.isTrigger,
				hasParamIssues: true,
			});
		} else if (req.credentialType) {
			// Group by credential type
			const existing = credGroups.get(req.credentialType);
			if (existing) {
				existing.push(req);
			} else {
				credGroups.set(req.credentialType, [req]);
			}
		} else if (req.isTrigger) {
			// Trigger-only card
			result.push({
				id: `trigger-${req.node.id}`,
				nodes: [req],
				isTrigger: true,
				hasParamIssues: false,
			});
		}
	}

	// Add grouped credential cards
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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const isSubmitted = ref(false);
const isDeferred = ref(false);

// Credential selections: credentialType → credentialId
const selections = ref<Record<string, string | null>>({});

// Credential test status: credentialId → status
const credentialTestStatus = ref<Record<string, 'testing' | 'success' | 'error'>>({});

// Trigger test results (from backend re-suspend): nodeName → result
const triggerTestResults = computed(() => {
	const results: Record<string, InstanceAiWorkflowSetupNode['triggerTestResult']> = {};
	for (const req of props.setupRequests) {
		if (req.triggerTestResult) {
			results[req.node.name] = req.triggerTestResult;
		}
	}
	return results;
});

// Track parameter values: nodeName → { paramName: value }
const paramValues = ref<Record<string, Record<string, unknown>>>({});

// Sticky card tracking — cards that have been shown stay visible
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

		// Auto-select if exactly one existing credential
		if (req.existingCredentials?.length === 1) {
			selections.value[req.credentialType] = req.existingCredentials[0].id;
			// Auto-test the credential
			void testCredentialInBackground(req.existingCredentials[0].id, req.credentialType);
		} else {
			selections.value[req.credentialType] = null;
		}
	}
}
initSelections();

// ---------------------------------------------------------------------------
// Credential testing
// ---------------------------------------------------------------------------

async function testCredentialInBackground(credentialId: string, credentialType: string) {
	const cred = credentialsStore.getCredentialById(credentialId);
	if (!cred) return;

	credentialTestStatus.value[credentialId] = 'testing';
	try {
		const result = await credentialsStore.testCredential({
			id: cred.id,
			name: cred.name,
			type: credentialType,
			data: {},
		} as ICredentialsDecrypted);
		credentialTestStatus.value[credentialId] = result.status === 'OK' ? 'success' : 'error';
	} catch {
		credentialTestStatus.value[credentialId] = 'error';
	}
}

// ---------------------------------------------------------------------------
// Completion tracking
// ---------------------------------------------------------------------------

function isCardComplete(card: SetupCard): boolean {
	// Credential check
	if (card.credentialType) {
		const selectedId = selections.value[card.credentialType];
		if (!selectedId) return false;
		// Credential must be tested successfully
		if (credentialTestStatus.value[selectedId] !== 'success') return false;
	}
	// Parameter issues check
	if (card.hasParamIssues) return false;
	// Trigger check — only for the first trigger
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
	if (card.credentialType) return getDisplayName(card.credentialType);
	if (card.nodes.length === 1) return card.nodes[0].node.name;
	return 'Setup';
}

function getCardSubtitle(card: SetupCard): string | undefined {
	if (card.nodes.length === 1) return card.nodes[0].node.name;
	if (card.nodes.length > 1) {
		return i18n.baseText('instanceAi.workflowSetup.usedByNodes', {
			interpolate: { count: String(card.nodes.length) },
		});
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/** Build a minimal INodeUi from setup request node data for NodeCredentials */
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

/** Build a representative node for a card (first node in the group) */
function cardNodeUi(card: SetupCard): INodeUi {
	return toNodeUi(card.nodes[0]);
}

function onCredentialSelected(card: SetupCard, updateInfo: INodeUpdatePropertiesInformation) {
	if (!card.credentialType) return;
	const credentialData = updateInfo.properties.credentials?.[card.credentialType];
	const credentialId = typeof credentialData === 'string' ? undefined : credentialData?.id;

	if (credentialId) {
		selections.value[card.credentialType] = credentialId;
		void testCredentialInBackground(credentialId, card.credentialType);
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

function getTriggerTestStatusIcon(
	result?: InstanceAiWorkflowSetupNode['triggerTestResult'],
): IconName {
	if (!result) return 'info';
	if (result.status === 'success') return 'check';
	if (result.status === 'error') return 'triangle-alert';
	return 'loader';
}

function getTriggerTestStatusClass(
	result?: InstanceAiWorkflowSetupNode['triggerTestResult'],
): string {
	if (!result) return '';
	if (result.status === 'success') return 'success';
	if (result.status === 'error') return 'error';
	return 'loading';
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
						v-if="currentCard.credentialType"
						:credential-type-name="currentCard.credentialType"
						:size="16"
					/>
					<N8nIcon v-else icon="play" size="small" />
					<N8nText :class="$style.title" size="medium" color="text-dark" bold>
						{{ getCardTitle(currentCard) }}
					</N8nText>
					<!-- Loading spinner (credential testing) -->
					<N8nIcon
						v-if="
							!isCardComplete(currentCard) &&
							currentCard.credentialType &&
							selections[currentCard.credentialType] &&
							credentialTestStatus[selections[currentCard.credentialType]!] === 'testing'
						"
						data-test-id="instance-ai-workflow-setup-loading-icon"
						icon="spinner"
						:spin="true"
						:class="$style.loadingIcon"
						size="medium"
					/>
					<!-- Complete icon in header -->
					<N8nIcon
						v-else-if="isCardComplete(currentCard)"
						data-test-id="instance-ai-workflow-setup-step-check"
						icon="check"
						:class="$style.completeIcon"
						size="medium"
					/>
				</header>

				<!-- Content -->
				<div :class="$style.content">
					<!-- Subtitle: node name or "Used by X nodes" -->
					<N8nText
						v-if="getCardSubtitle(currentCard)"
						:class="$style.nodeName"
						size="small"
						color="text-light"
					>
						{{ getCardSubtitle(currentCard) }}
					</N8nText>

					<!-- Credential select (matches builder's NodeCredentials dropdown) -->
					<div v-if="currentCard.credentialType" :class="$style.credentialContainer">
						<NodeCredentials
							:node="cardNodeUi(currentCard)"
							:override-cred-type="currentCard.credentialType"
							standalone
							hide-issues
							@credential-selected="onCredentialSelected(currentCard, $event)"
						>
							<template v-if="currentCard.nodes.length > 1" #label-postfix>
								<span :class="$style.nodesHint">
									{{
										i18n.baseText('instanceAi.workflowSetup.usedByNodes', {
											interpolate: { count: String(currentCard.nodes.length) },
										})
									}}
								</span>
							</template>
						</NodeCredentials>
					</div>

					<!-- Parameter issues (per-node cards only) -->
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

					<!-- Trigger test -->
					<div v-if="currentCard.isTrigger" :class="$style.triggerSection">
						<div
							v-for="node in currentCard.nodes.filter((n) => n.isTrigger)"
							:key="node.node.id"
							:class="$style.triggerRow"
						>
							<N8nButton
								size="small"
								variant="outline"
								:label="i18n.baseText('instanceAi.workflowSetup.testTrigger')"
								:disabled="
									currentCard.credentialType
										? selections[currentCard.credentialType] === null
										: false
								"
								data-test-id="instance-ai-workflow-setup-test-trigger"
								@click="handleTestTrigger(node.node.name)"
							/>
							<template v-if="triggerTestResults[node.node.name]">
								<N8nIcon
									:icon="getTriggerTestStatusIcon(triggerTestResults[node.node.name])"
									size="small"
									:class="$style[getTriggerTestStatusClass(triggerTestResults[node.node.name])]"
								/>
								<N8nText
									size="small"
									:color="
										triggerTestResults[node.node.name]?.status === 'success'
											? 'success'
											: triggerTestResults[node.node.name]?.status === 'error'
												? 'danger'
												: 'text-light'
									"
								>
									{{
										triggerTestResults[node.node.name]?.status === 'success'
											? i18n.baseText('instanceAi.workflowSetup.triggerSuccess')
											: triggerTestResults[node.node.name]?.status === 'error'
												? (triggerTestResults[node.node.name]?.error ??
													i18n.baseText('instanceAi.workflowSetup.triggerError'))
												: i18n.baseText('instanceAi.workflowSetup.triggerListening')
									}}
								</N8nText>
							</template>
						</div>
					</div>
				</div>

				<!-- Footer -->
				<footer :class="$style.footer">
					<!-- Complete check (shown when card is done) -->
					<div v-if="isCardComplete(currentCard)" :class="$style.footerCompleteCheck">
						<N8nIcon icon="check" :class="$style.completeIcon" size="large" />
						<N8nText size="medium" color="success">
							{{ i18n.baseText('generic.complete') }}
						</N8nText>
					</div>

					<!-- Navigation -->
					<div v-if="totalSteps > 1" :class="$style.footerNav">
						<N8nButton
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

					<!-- Actions -->
					<div :class="$style.footerActions">
						<button :class="$style.secondaryButton" @click="handleLater">
							{{ i18n.baseText('instanceAi.workflowSetup.later') }}
						</button>
						<N8nButton
							size="small"
							:class="$style.actionButton"
							:label="i18n.baseText('instanceAi.workflowSetup.apply')"
							:disabled="!allCredentialsSelected"
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
/* Matches SetupCard.vue from the setup panel */

.root {
	border-top: var(--border);
	background: var(--color--background--shade-1);
	padding: var(--spacing--xs);
}

.card {
	width: 100%;
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
	background-color: var(--color--background--light-3);
	border: var(--border);
	border-radius: var(--radius);
	padding-bottom: var(--spacing--xs);

	&.completed {
		border-color: var(--color--success);
	}
}

.header {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
	padding: var(--spacing--xs) var(--spacing--xs) 0;
	margin-bottom: var(--spacing--5xs);
}

.title {
	flex: 1;
	font-weight: var(--font-weight--medium);
}

.completeIcon {
	color: var(--color--success);
	display: flex;
	justify-content: center;
	width: var(--spacing--sm);
}

.loadingIcon {
	color: var(--color--text--tint-1);
	display: flex;
	justify-content: center;
	width: var(--spacing--sm);
	animation: spin 1s linear infinite;
}

.content {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
	padding: 0 var(--spacing--xs);
}

.credentialContainer {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);

	:global(.node-credentials) {
		margin-top: 0;
	}
}

.nodesHint {
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
	cursor: default;
}

.nodeName {
	color: var(--color--text--tint-2);
	font-size: var(--font-size--2xs);
}

.nodeList {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}

.nodeListItems {
	margin: 0;
	padding-left: var(--spacing--sm);
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
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

.triggerSection {
	padding: var(--spacing--4xs) 0;
}

.triggerRow {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}

.footer {
	display: flex;
	justify-content: flex-end;
	align-items: center;
	padding: 0 var(--spacing--xs);

	.completed & {
		justify-content: space-between;
	}
}

.footerCompleteCheck {
	display: flex;
	align-items: center;
	gap: var(--spacing--4xs);
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

.secondaryButton {
	padding: var(--spacing--4xs) var(--spacing--xs);
	border-radius: var(--radius);
	font-size: var(--font-size--2xs);
	font-family: var(--font-family);
	cursor: pointer;
	border: none;
	background: none;
	color: var(--color--text--tint-1);

	&:hover {
		color: var(--color--text);
		text-decoration: underline;
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
