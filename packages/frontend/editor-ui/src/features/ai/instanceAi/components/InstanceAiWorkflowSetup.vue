<script lang="ts" setup>
import { ref, computed } from 'vue';
import { N8nButton, N8nIcon, N8nText, type IconName } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import type { InstanceAiWorkflowSetupNode, InstanceAiCredentialFlow } from '@n8n/api-types';
import { useInstanceAiStore } from '../instanceAi.store';
import { useCredentialsStore } from '@/features/credentials/credentials.store';
import CredentialPicker from '@/features/credentials/components/CredentialPicker/CredentialPicker.vue';
import CredentialIcon from '@/features/credentials/components/CredentialIcon.vue';
import WizardNavigationFooter from '@/features/ai/shared/components/WizardNavigationFooter.vue';
import { useWizardNavigation } from '@/features/ai/shared/composables/useWizardNavigation';

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

const totalSteps = computed(() => props.setupRequests.length);

const { currentStepIndex, isPrevDisabled, isNextDisabled, goToNext, goToPrev } =
	useWizardNavigation({ totalSteps });

const isSubmitted = ref(false);
const isDeferred = ref(false);

// Track credential selections: credentialType → credentialId
const selections = ref<Record<string, string | null>>(
	Object.fromEntries(
		props.setupRequests.filter((r) => r.credentialType).map((r) => [r.credentialType!, null]),
	),
);

// Track parameter values: nodeName → { paramName: value }
const paramValues = ref<Record<string, Record<string, unknown>>>({});

const currentRequest = computed(() => props.setupRequests[currentStepIndex.value]);

const allCredentialsSelected = computed(() =>
	props.setupRequests
		.filter((r) => r.credentialType)
		.every((r) => selections.value[r.credentialType!] !== null),
);

const currentCredentialSelected = computed(() => {
	if (!currentRequest.value?.credentialType) return true;
	return selections.value[currentRequest.value.credentialType] !== null;
});

function getDisplayName(credentialType: string): string {
	return credentialsStore.getCredentialTypeByName(credentialType)?.displayName ?? credentialType;
}

function getNodeDisplayName(node: InstanceAiWorkflowSetupNode): string {
	if (node.credentialType) {
		return getDisplayName(node.credentialType);
	}
	return node.node.name;
}

function handleCredentialSelected(credentialType: string, credentialId: string) {
	selections.value[credentialType] = credentialId;
}

function handleCredentialDeselected(credentialType: string) {
	selections.value[credentialType] = null;
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
				v-if="currentRequest"
				data-test-id="instance-ai-workflow-setup-card"
				:class="[$style.card, { [$style.completed]: allCredentialsSelected }]"
			>
				<!-- Header -->
				<header :class="$style.header">
					<CredentialIcon
						v-if="currentRequest.credentialType"
						:credential-type-name="currentRequest.credentialType"
						:size="16"
					/>
					<N8nIcon v-else icon="play" size="small" />
					<N8nText :class="$style.title" size="medium" color="text-dark" bold>
						{{ getNodeDisplayName(currentRequest) }}
					</N8nText>
					<N8nText
						v-if="currentCredentialSelected"
						data-test-id="instance-ai-workflow-setup-step-check"
						:class="$style.completeLabel"
						size="medium"
						color="success"
					>
						<N8nIcon icon="check" size="large" />
					</N8nText>
				</header>

				<!-- Content -->
				<div :class="$style.content">
					<!-- Node name label -->
					<N8nText :class="$style.nodeName" size="small" color="text-light">
						{{ currentRequest.node.name }}
					</N8nText>

					<!-- Credential picker -->
					<CredentialPicker
						v-if="currentRequest.credentialType"
						:key="currentRequest.credentialType"
						:app-name="getDisplayName(currentRequest.credentialType)"
						:credential-type="currentRequest.credentialType"
						:selected-credential-id="selections[currentRequest.credentialType]"
						:project-id="props.projectId"
						create-button-variant="outline"
						@credential-selected="handleCredentialSelected(currentRequest.credentialType!, $event)"
						@credential-deselected="handleCredentialDeselected(currentRequest.credentialType!)"
					/>

					<!-- Parameter issues -->
					<div v-if="currentRequest.parameterIssues" :class="$style.parameterIssues">
						<N8nText size="small" color="text-light">
							{{ i18n.baseText('instanceAi.workflowSetup.parameterIssues') }}
						</N8nText>
						<ul :class="$style.issueList">
							<li v-for="(issues, paramName) in currentRequest.parameterIssues" :key="paramName">
								<N8nText size="small" color="text-dark" bold>{{ paramName }}:</N8nText>
								{{ issues.join(', ') }}
							</li>
						</ul>
					</div>

					<!-- Trigger test -->
					<div v-if="currentRequest.isTrigger" :class="$style.triggerSection">
						<div :class="$style.triggerRow">
							<N8nButton
								size="small"
								variant="outline"
								:label="i18n.baseText('instanceAi.workflowSetup.testTrigger')"
								:disabled="!currentCredentialSelected"
								data-test-id="instance-ai-workflow-setup-test-trigger"
								@click="handleTestTrigger(currentRequest.node.name)"
							/>
							<template v-if="currentRequest.triggerTestResult">
								<N8nIcon
									:icon="getTriggerTestStatusIcon(currentRequest.triggerTestResult)"
									size="small"
									:class="$style[getTriggerTestStatusClass(currentRequest.triggerTestResult)]"
								/>
								<N8nText
									size="small"
									:color="
										currentRequest.triggerTestResult.status === 'success'
											? 'success'
											: currentRequest.triggerTestResult.status === 'error'
												? 'danger'
												: 'text-light'
									"
								>
									{{
										currentRequest.triggerTestResult.status === 'success'
											? i18n.baseText('instanceAi.workflowSetup.triggerSuccess')
											: currentRequest.triggerTestResult.status === 'error'
												? (currentRequest.triggerTestResult.error ??
													i18n.baseText('instanceAi.workflowSetup.triggerError'))
												: i18n.baseText('instanceAi.workflowSetup.triggerListening')
									}}
								</N8nText>
							</template>
						</div>
					</div>
				</div>

				<!-- Footer -->
				<WizardNavigationFooter
					:step-index="currentStepIndex"
					:total-steps="totalSteps"
					:is-prev-disabled="isPrevDisabled"
					:is-next-disabled="isNextDisabled"
					@prev="goToPrev"
					@next="goToNext"
				>
					<template #actions>
						<button :class="$style.secondaryButton" @click="handleLater">
							{{ i18n.baseText('instanceAi.workflowSetup.later') }}
						</button>
						<N8nButton
							size="small"
							:label="i18n.baseText('instanceAi.workflowSetup.apply')"
							:disabled="!allCredentialsSelected"
							data-test-id="instance-ai-workflow-setup-apply-button"
							@click="handleApply"
						/>
					</template>
				</WizardNavigationFooter>
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

	:global([data-test-id='create-credential']) {
		width: auto;
	}
}

.nodeName {
	color: var(--color--text--tint-2);
	font-size: var(--font-size--2xs);
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
