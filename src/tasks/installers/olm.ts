/**
 * Copyright (c) 2019-2021 Red Hat, Inc.
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *
 * Contributors:
 *   Red Hat, Inc. - initial API and implementation
 */

import Command from '@oclif/command'
import { cli } from 'cli-ux'
import * as yaml from 'js-yaml'
import * as path from 'path'
import { CheHelper } from '../../api/che'
import { OLM, OLMInstallationUpdate } from '../../api/context'
import { KubeHelper } from '../../api/kube'
import { CatalogSource, Subscription } from '../../api/types/olm'
import { VersionHelper } from '../../api/version'
import { CHECTL_PROJECT_NAME, CSV_PREFIX, CUSTOM_CATALOG_SOURCE_NAME, DEFAULT_CHE_NAMESPACE, DEFAULT_CHE_OLM_PACKAGE_NAME, DEFAULT_CHE_OPERATOR_SUBSCRIPTION_NAME, DEFAULT_OLM_KUBERNETES_NAMESPACE, DEFAULT_OPENSHIFT_MARKET_PLACE_NAMESPACE, DEFAULT_OPENSHIFT_OPERATORS_NS_NAME, INDEX_IMG, KUBERNETES_OLM_CATALOG, NEXT_CATALOG_SOURCE_NAME, OLM_NEXT_ALL_NAMESPACES_CHANNEL_NAME, OLM_NEXT_CHANNEL_NAME, OLM_STABLE_ALL_NAMESPACES_CHANNEL_NAME, OLM_STABLE_ALL_NAMESPACES_CHANNEL_STARTING_CSV_TEMPLATE, OLM_STABLE_CHANNEL_NAME, OLM_STABLE_CHANNEL_STARTING_CSV_TEMPLATE, OPENSHIFT_OLM_CATALOG, OPERATOR_GROUP_NAME } from '../../constants'
import { getEmbeddedTemplatesDirectory, getProjectName, isKubernetesPlatformFamily } from '../../util'
import { createEclipseCheCluster, patchingEclipseCheCluster } from './common-tasks'
import { OLMDevWorkspaceTasks } from './olm-dev-workspace-operator'
import Listr = require('listr')

export const TASK_TITLE_SET_CUSTOM_OPERATOR_IMAGE = 'Set custom operator image'
export const TASK_TITLE_CREATE_CUSTOM_CATALOG_SOURCE_FROM_FILE = 'Create custom catalog source from file'
export const TASK_TITLE_PREPARE_CHE_CLUSTER_CR = 'Prepare CodeReady Workspaces cluster CR'

export const TASK_TITLE_DELETE_CUSTOM_CATALOG_SOURCE = `Delete(OLM) custom catalog source ${CUSTOM_CATALOG_SOURCE_NAME}`
export const TASK_TITLE_DELETE_NEXT_CATALOG_SOURCE = `Delete(OLM) nigthly catalog source ${NEXT_CATALOG_SOURCE_NAME}`

export class OLMTasks {
  private readonly prometheusRoleName = 'prometheus-k8s'
  private readonly prometheusRoleBindingName = 'prometheus-k8s'
  private readonly kube: KubeHelper
  private readonly che: CheHelper
  private readonly olmDevWorkspaceTasks: OLMDevWorkspaceTasks

  constructor(flags: any) {
    this.kube = new KubeHelper(flags)
    this.che = new CheHelper(flags)
    this.olmDevWorkspaceTasks = new OLMDevWorkspaceTasks(flags)
  }

  startTasks(flags: any, command: Command): Listr.ListrTask<any>[] {
    return [
      this.isOlmPreInstalledTask(command),
      {
        title: 'Configure context information',
        task: async (ctx: any, task: any) => {
          ctx.operatorNamespace = flags.chenamespace || DEFAULT_CHE_NAMESPACE
          if (flags[OLM.CHANNEL] === OLM_STABLE_ALL_NAMESPACES_CHANNEL_NAME || flags[OLM.CHANNEL] === OLM_NEXT_ALL_NAMESPACES_CHANNEL_NAME) {
            ctx.operatorNamespace = DEFAULT_OPENSHIFT_OPERATORS_NS_NAME
          }

          ctx.defaultCatalogSourceNamespace = isKubernetesPlatformFamily(flags.platform) ? DEFAULT_OLM_KUBERNETES_NAMESPACE : DEFAULT_OPENSHIFT_MARKET_PLACE_NAMESPACE
          // catalog source name for stable Che version
          ctx.catalogSourceNameStable = isKubernetesPlatformFamily(flags.platform) ? KUBERNETES_OLM_CATALOG : OPENSHIFT_OLM_CATALOG

          ctx.sourceName = flags[OLM.CATALOG_SOURCE_NAME] || CUSTOM_CATALOG_SOURCE_NAME
          ctx.generalPlatformName = isKubernetesPlatformFamily(flags.platform) ? 'kubernetes' : 'openshift'

          if (flags.version) {
            // Convert version flag to channel (see subscription object), starting CSV and approval starategy
            flags.version = VersionHelper.removeVPrefix(flags.version, true)
            // Need to point to specific CSV
            if (flags[OLM.STARTING_CSV]) {
              ctx.startingCSV = flags[OLM.STARTING_CSV]
            } else if (flags[OLM.CHANNEL] === OLM_STABLE_CHANNEL_NAME) {
              ctx.startingCSV = OLM_STABLE_CHANNEL_STARTING_CSV_TEMPLATE.replace(new RegExp('{{VERSION}}', 'g'), flags.version)
            } else if (flags[OLM.CHANNEL] === OLM_STABLE_ALL_NAMESPACES_CHANNEL_NAME) {
              ctx.startingCSV = OLM_STABLE_ALL_NAMESPACES_CHANNEL_STARTING_CSV_TEMPLATE.replace(new RegExp('{{VERSION}}', 'g'), flags.version)
            } // else use latest in the channel
            // Set approval starategy to manual to prevent autoupdate to the latest version right before installation
            ctx.approvalStrategy = OLMInstallationUpdate.MANUAL
          } else {
            ctx.startingCSV = flags[OLM.STARTING_CSV]
            if (ctx.startingCSV) {
              // Ignore auto-update flag, otherwise it will automatically update to the latest version and 'starting-csv' will not have any effect.
              ctx.approvalStrategy = OLMInstallationUpdate.MANUAL
            } else if (flags[OLM.AUTO_UPDATE] === undefined) {
              ctx.approvalStrategy = OLMInstallationUpdate.AUTO
            } else {
              ctx.approvalStrategy = flags[OLM.AUTO_UPDATE] ? OLMInstallationUpdate.AUTO : OLMInstallationUpdate.MANUAL
            }
          }

          task.title = `${task.title}...[OK]`
        },
      },
      {
        enabled: () => flags['cluster-monitoring'] && flags.platform === 'openshift',
        title: `Create Role ${this.prometheusRoleName} in namespace ${flags.chenamespace}`,
        task: async (_ctx: any, task: any) => {
          if (await this.kube.isRoleExist(this.prometheusRoleName, flags.chenamespace)) {
            task.title = `${task.title}...[Exists]`
          } else {
            const yamlFilePath = path.join(getEmbeddedTemplatesDirectory(), '..', 'resources', 'prometheus-role.yaml')
            await this.kube.createRoleFromFile(yamlFilePath, flags.chenamespace)
            task.title = `${task.title}...[OK].`
          }
        },
      },
      {
        enabled: () => flags['cluster-monitoring'] && flags.platform === 'openshift',
        title: `Create RoleBinding ${this.prometheusRoleBindingName} in namespace ${flags.chenamespace}`,
        task: async (_ctx: any, task: any) => {
          if (await this.kube.isRoleBindingExist(this.prometheusRoleBindingName, flags.chenamespace)) {
            task.title = `${task.title}...[Exists]`
          } else {
            const yamlFilePath = path.join(getEmbeddedTemplatesDirectory(), '..', 'resources', 'prometheus-role-binding.yaml')
            await this.kube.createRoleBindingFromFile(yamlFilePath, flags.chenamespace)
            task.title = `${task.title}...[OK]`
          }
        },
      },
      {
        title: 'Create operator group',
        enabled: (ctx: any) => ctx.operatorNamespace !== DEFAULT_OPENSHIFT_OPERATORS_NS_NAME,
        task: async (_ctx: any, task: any) => {
          if (await this.che.findCheOperatorOperatorGroup(flags.chenamespace)) {
            task.title = `${task.title}...[Exists]`
          } else {
            await this.kube.createOperatorGroup(OPERATOR_GROUP_NAME, flags.chenamespace)
            task.title = `${task.title}...[OK]`
          }
        },
      },
      {
        enabled: () => !flags[OLM.CATALOG_SOURCE_NAME] && !flags[OLM.CATALOG_SOURCE_YAML] && flags[OLM.CHANNEL] !== OLM_STABLE_CHANNEL_NAME,
        title: 'Create CatalogSource for \'next\' channel',
        task: async (ctx: any, task: any) => {
          if (!await this.kube.IsCatalogSourceExists(NEXT_CATALOG_SOURCE_NAME, ctx.operatorNamespace)) {
            const nextCatalogSource = this.constructNextCatalogSource(ctx.operatorNamespace)
            await this.kube.createCatalogSource(nextCatalogSource)
            await this.kube.waitCatalogSource(ctx.operatorNamespace, NEXT_CATALOG_SOURCE_NAME)
            task.title = `${task.title}...[OK]`
          } else {
            task.title = `${task.title}...[Exists]`
          }
        },
      },
      {
        enabled: () => getProjectName() === CHECTL_PROJECT_NAME,
        title: 'Deploy Dev Workspace operator',
        task: async () => this.olmDevWorkspaceTasks.startTasks(flags, command),
      },
      {
        title: TASK_TITLE_CREATE_CUSTOM_CATALOG_SOURCE_FROM_FILE,
        enabled: () => flags[OLM.CATALOG_SOURCE_YAML],
        task: async (ctx: any, task: any) => {
          const customCatalogSource: CatalogSource = this.kube.readCatalogSourceFromFile(flags[OLM.CATALOG_SOURCE_YAML])
          if (!await this.kube.IsCatalogSourceExists(customCatalogSource.metadata!.name!, flags.chenamespace)) {
            customCatalogSource.metadata.name = ctx.sourceName
            customCatalogSource.metadata.namespace = flags.chenamespace
            await this.kube.createCatalogSource(customCatalogSource)
            await this.kube.waitCatalogSource(flags.chenamespace, CUSTOM_CATALOG_SOURCE_NAME)
            task.title = `${task.title}...[OK: ${CUSTOM_CATALOG_SOURCE_NAME}]`
          } else {
            task.title = `${task.title}...[Exists]`
          }
        },
      },
      {
        title: 'Create operator subscription',
        task: async (ctx: any, task: any) => {
          let subscription = await this.che.findCheOperatorSubscription(ctx.operatorNamespace)
          if (subscription) {
            ctx.subscriptionName = subscription.metadata.name
            task.title = `${task.title}...[Exists]`
            return
          }
          ctx.subscriptionName = DEFAULT_CHE_OPERATOR_SUBSCRIPTION_NAME
          const channel = flags[OLM.CHANNEL]

          if (flags[OLM.CATALOG_SOURCE_YAML] || flags[OLM.CATALOG_SOURCE_NAME]) {
            // custom Che CatalogSource
            const catalogSourceNamespace = flags[OLM.CATALOG_SOURCE_NAMESPACE] || ctx.operatorNamespace
            subscription = this.constructSubscription(ctx.subscriptionName, flags[OLM.PACKAGE_MANIFEST_NAME], ctx.operatorNamespace, catalogSourceNamespace, channel || OLM_STABLE_CHANNEL_NAME, ctx.sourceName, ctx.approvalStrategy, ctx.startingCSV)
          } else if (channel === OLM_STABLE_CHANNEL_NAME || channel === OLM_STABLE_ALL_NAMESPACES_CHANNEL_NAME || (VersionHelper.isDeployingStableVersion(flags) && !channel)) {
            // stable Che CatalogSource
            subscription = this.constructSubscription(ctx.subscriptionName, DEFAULT_CHE_OLM_PACKAGE_NAME, ctx.operatorNamespace, ctx.defaultCatalogSourceNamespace, channel || OLM_STABLE_CHANNEL_NAME, ctx.catalogSourceNameStable, ctx.approvalStrategy, ctx.startingCSV)
          } else if (channel === OLM_NEXT_CHANNEL_NAME || channel === OLM_NEXT_ALL_NAMESPACES_CHANNEL_NAME || !channel) {
            // next Che CatalogSource
            subscription = this.constructSubscription(ctx.subscriptionName, `eclipse-che-preview-${ctx.generalPlatformName}`, ctx.operatorNamespace, ctx.operatorNamespace, channel || OLM_NEXT_CHANNEL_NAME, NEXT_CATALOG_SOURCE_NAME, ctx.approvalStrategy, ctx.startingCSV)
          } else {
            throw new Error(`Unknown OLM channel ${flags[OLM.CHANNEL]}`)
          }
          await this.kube.createOperatorSubscription(subscription)
          task.title = `${task.title}...[OK]`
        },
      },
      {
        title: 'Wait while subscription is ready',
        task: async (ctx: any, task: any) => {
          const installPlan = await this.kube.waitOperatorSubscriptionReadyForApproval(ctx.operatorNamespace, ctx.subscriptionName, 600)
          ctx.installPlanName = installPlan.name
          task.title = `${task.title}...[OK]`
        },
      },
      {
        title: 'Approve installation',
        enabled: ctx => ctx.approvalStrategy === OLMInstallationUpdate.MANUAL,
        task: async (ctx: any, task: any) => {
          await this.kube.approveOperatorInstallationPlan(ctx.installPlanName, ctx.operatorNamespace)
          task.title = `${task.title}...[OK]`
        },
      },
      {
        title: 'Wait operator install plan',
        task: async (ctx: any, task: any) => {
          await this.kube.waitOperatorInstallPlan(ctx.installPlanName, ctx.operatorNamespace)
          task.title = `${task.title}...[OK]`
        },
      },
      {
        title: 'Check cluster service version resource',
        task: async (ctx: any, task: any) => {
          const installedCSV = await this.kube.waitInstalledCSV(ctx.operatorNamespace, ctx.subscriptionName)
          const csv = await this.kube.getCSV(installedCSV, ctx.operatorNamespace)
          if (!csv) {
            throw new Error(`cluster service version resource ${installedCSV} not found`)
          }
          if (csv.status.phase === 'Failed') {
            throw new Error(`cluster service version resource failed. Cause: ${csv.status.message}. Reason: ${csv.status.reason}.`)
          }
          task.title = `${task.title}...[OK]`
        },
      },
      {
        title: TASK_TITLE_SET_CUSTOM_OPERATOR_IMAGE,
        enabled: () => flags['che-operator-image'],
        task: async (_ctx: any, task: any) => {
          const csvList = await this.kube.getClusterServiceVersions(flags.chenamespace)
          if (csvList.items.length < 1) {
            throw new Error('Failed to get CSV for Che operator')
          }
          const csv = csvList.items[0]
          const jsonPatch = [{ op: 'replace', path: '/spec/install/spec/deployments/0/spec/template/spec/containers/0/image', value: flags['che-operator-image'] }]
          await this.kube.patchClusterServiceVersion(csv.metadata.namespace!, csv.metadata.name!, jsonPatch)
          task.title = `${task.title}...[OK]`
        },
      },
      {
        title: TASK_TITLE_PREPARE_CHE_CLUSTER_CR,
        task: async (ctx: any, task: any) => {
          const cheCluster = await this.kube.getCheCluster(flags.chenamespace)
          if (cheCluster) {
            task.title = `${task.title}...[Exists]`
            return
          }

          if (!ctx.customCR) {
            ctx.defaultCR = await this.getCRFromCSV(ctx.operatorNamespace, ctx.subscriptionName)
          }

          task.title = `${task.title}...[OK]`
        },
      },
      createEclipseCheCluster(flags, this.kube),
    ]
  }

  preUpdateTasks(flags: any, command: Command): Listr {
    return new Listr([
      this.isOlmPreInstalledTask(command),
      {
        title: 'Check operator subscription',
        task: async (ctx: any, task: Listr.ListrTaskWrapper<any>) => {
          const subscription = await this.che.findCheOperatorSubscription(flags.chenamespace)
          if (!subscription) {
            command.error('Unable to find operator subscription')
          }
          ctx.operatorNamespace = subscription.metadata.namespace
          ctx.installPlanApproval = subscription.spec.installPlanApproval

          if (subscription.spec.installPlanApproval === OLMInstallationUpdate.AUTO) {
            task.title = `${task.title}...[Interrupted]`
            return new Listr([
              {
                title: '[Warning] OLM itself manage operator update with installation mode \'Automatic\'.',
                task: () => { },
              },
              {
                title: '[Warning] Use \'crwctl server:update\' command only with \'Manual\' installation plan approval.',
                task: () => {
                  command.exit(0)
                },
              },
            ], ctx.listrOptions)
          }

          task.title = `${task.title}...[OK]`
        },
      },
      {
        title: 'Check if CheCluster CR exists',
        task: async (ctx: any, _task: any) => {
          if (ctx.operatorNamespace === DEFAULT_OPENSHIFT_OPERATORS_NS_NAME) {
            const cheClusters = await this.kube.getAllCheClusters()
            if (cheClusters.length === 0) {
              command.error(`CodeReady Workspaces cluster CR was not found in the namespace '${flags.chenamespace}'`)
            }
            if (cheClusters.length > 0) {
              command.error('CodeReady Workspaces does not support more than one installation in all namespaces mode.')
            }
            ctx.checlusterNamespace = cheClusters[0].metadata.namespace
          } else {
            const cheCluster = await this.kube.getCheCluster(ctx.operatorNamespace)
            if (!cheCluster) {
              command.error(`CodeReady Workspaces cluster CR was not found in the namespace '${flags.chenamespace}'`)
            }
            ctx.checlusterNamespace = cheCluster.metadata.namespace
          }
        },
      },
    ], { renderer: flags['listr-renderer'] as any })
  }

  updateTasks(flags: any, command: Command): Listr {
    const kube = new KubeHelper(flags)
    const che = new CheHelper(flags)
    return new Listr([
      {
        title: 'Get operator installation plan',
        task: async (ctx: any, task: any) => {
          // We can be sure that the subscription exist, because it was checked in preupdate tasks
          const subscription: Subscription = (await che.findCheOperatorSubscription(ctx.operatorNamespace))!

          if (subscription.status) {
            if (subscription.status.state === 'AtLatestKnown') {
              task.title = `Everything is up to date. Installed the latest known version '${subscription.status.currentCSV}'.`
              return
            }

            // Retrieve current and next version from the subscription status
            const installedCSV = subscription.status.installedCSV
            if (installedCSV) {
              ctx.currentVersion = installedCSV.substr(installedCSV.lastIndexOf('v') + 1)
            }
            const currentCSV = subscription.status.currentCSV
            ctx.nextVersion = currentCSV.substr(currentCSV.lastIndexOf('v') + 1)

            if (subscription.status.state === 'UpgradePending' && subscription.status!.conditions) {
              const installCondition = subscription.status.conditions.find(condition => condition.type === 'InstallPlanPending' && condition.status === 'True')
              if (installCondition) {
                ctx.installPlanName = subscription.status.installplan.name
                task.title = `${task.title}...[OK]`
                return
              }
            }

            if (subscription.status.state === 'UpgradeAvailable' && installedCSV === currentCSV) {
              command.error('Another update is in progress')
            }
          }
          command.error('Unable to find installation plan to update.')
        },
      },
      {
        title: 'Approve installation',
        enabled: (ctx: any) => ctx.installPlanName,
        task: async (ctx: any, task: any) => {
          await kube.approveOperatorInstallationPlan(ctx.installPlanName, ctx.operatorNamespace)
          task.title = `${task.title}...[OK]`
        },
      },
      {
        title: 'Wait while newer operator installed',
        enabled: (ctx: any) => ctx.installPlanName,
        task: async (ctx: any, task: any) => {
          await kube.waitOperatorInstallPlan(ctx.installPlanName, ctx.operatorNamespace, 60)
          ctx.highlightedMessages.push(`Operator is updated from ${ctx.currentVersion} to ${ctx.nextVersion} version`)
          task.title = `${task.title}...[OK]`
        },
      },
      patchingEclipseCheCluster(flags, kube, command),
    ], { renderer: flags['listr-renderer'] as any })
  }

  deleteTasks(flags: any): ReadonlyArray<Listr.ListrTask> {
    const kube = new KubeHelper(flags)
    const che = new CheHelper(flags)
    return [
      {
        title: 'Check if OLM is pre-installed on the platform',
        task: async (ctx: any, task: any) => {
          ctx.isPreInstalledOLM = Boolean(await kube.isPreInstalledOLM())
          task.title = `${task.title}: ${ctx.isPreInstalledOLM}...[OK]`
        },
      },
      {
        title: 'Check if operator is installed',
        task: async (ctx: any, task: any) => {
          const subscription = await che.findCheOperatorSubscription(flags.chenamespace)
          if (subscription) {
            ctx.subscriptionName = subscription.metadata.name
            ctx.operatorNamespace = subscription.metadata.namespace
            task.title = `${task.title}...[Found ${ctx.subscriptionName}]`
          } else {
            ctx.operatorNamespace = flags.chenamespace || DEFAULT_CHE_NAMESPACE
            task.title = `${task.title}...[Not Found]`
          }
          // Also get operator group here, because if delete subscription and csv we'll lose the link to it
          ctx.operatorGroup = await che.findCheOperatorOperatorGroup(ctx.operatorNamespace)
        },
      },
      {
        title: 'Delete operator subscription',
        enabled: ctx => ctx.isPreInstalledOLM && ctx.subscriptionName,
        task: async (ctx: any, task: any) => {
          await kube.deleteOperatorSubscription(ctx.subscriptionName, ctx.operatorNamespace)
          task.title = `${task.title}...[OK]`
        },
      },
      {
        title: 'Delete CodeReady Workspaces cluster service versions',
        enabled: ctx => ctx.isPreInstalledOLM,
        task: async (ctx: any, task: any) => {
          const csvs = await kube.getClusterServiceVersions(ctx.operatorNamespace)
          const csvsToDelete = csvs.items.filter(csv => csv.metadata.name!.startsWith(CSV_PREFIX))
          for (const csv of csvsToDelete) {
            await kube.deleteClusterServiceVersion(ctx.operatorNamespace, csv.metadata.name!)
          }
          task.title = `${task.title}...[OK]`
        },
      },
      {
        title: 'Delete operator group',
        // Do not delete global operator group if operator is in all namespaces mode
        enabled: ctx => ctx.isPreInstalledOLM && ctx.operatorNamespace !== DEFAULT_OPENSHIFT_OPERATORS_NS_NAME,
        task: async (ctx: any, task: any) => {
          const opgr = ctx.operatorGroup
          if (opgr && opgr.metadata && opgr.metadata.name && opgr.metadata.namespace) {
            await kube.deleteOperatorGroup(opgr.metadata.name, opgr.metadata.namespace)
          }
          task.title = `${task.title}...[OK]`
        },
      },
      {
        title: TASK_TITLE_DELETE_CUSTOM_CATALOG_SOURCE,
        task: async (ctx: any, task: any) => {
          await kube.deleteCatalogSource(ctx.operatorNamespace, CUSTOM_CATALOG_SOURCE_NAME)
          task.title = `${task.title}...[OK]`
        },
      },
      {
        title: TASK_TITLE_DELETE_NEXT_CATALOG_SOURCE,
        task: async (ctx: any, task: any) => {
          await kube.deleteCatalogSource(ctx.operatorNamespace, NEXT_CATALOG_SOURCE_NAME)
          task.title = `${task.title}...[OK]`
        },
      },
      {
        title: `Delete role ${this.prometheusRoleName}`,
        task: async (_ctx: any, task: any) => {
          await kube.deleteRole(this.prometheusRoleName, flags.chenamespace)
          task.title = `${task.title}...[OK]`
        },
      },
      {
        title: `Delete role binding ${this.prometheusRoleName}`,
        task: async (_ctx: any, task: any) => {
          await kube.deleteRoleBinding(this.prometheusRoleName, flags.chenamespace)
          task.title = `${task.title}...[OK]`
        },
      },
    ]
  }

  private isOlmPreInstalledTask(command: Command): Listr.ListrTask<Listr.ListrContext> {
    return {
      title: 'Check if OLM is pre-installed on the platform',
      task: async (_ctx: any, task: any) => {
        if (!await this.kube.isPreInstalledOLM()) {
          cli.warn('Looks like your platform hasn\'t got embedded OLM, so you should install it manually. For quick start you can use:')
          cli.url('install.sh', 'https://raw.githubusercontent.com/operator-framework/operator-lifecycle-manager/master/deploy/upstream/quickstart/install.sh')
          command.error('OLM is required for installation of CodeReady Workspaces with installer flag \'olm\'')
        }
        task.title = `${task.title}...[OK]`
      },
    }
  }

  private constructSubscription(name: string, packageName: string, namespace: string, sourceNamespace: string, channel: string, sourceName: string, installPlanApproval: string, startingCSV?: string): Subscription {
    return {
      apiVersion: 'operators.coreos.com/v1alpha1',
      kind: 'Subscription',
      metadata: {
        name,
        namespace,
      },
      spec: {
        channel,
        installPlanApproval,
        name: packageName,
        source: sourceName,
        sourceNamespace,
        startingCSV,
      },
    }
  }

  private constructNextCatalogSource(namespace: string): CatalogSource {
    return {
      apiVersion: 'operators.coreos.com/v1alpha1',
      kind: 'CatalogSource',
      metadata: {
        name: NEXT_CATALOG_SOURCE_NAME,
        namespace,
      },
      spec: {
        image: INDEX_IMG,
        sourceType: 'grpc',
        updateStrategy: {
          registryPoll: {
            interval: '15m',
          },
        },
      },
    }
  }

  private async getCRFromCSV(namespace: string, subscriptionName: string): Promise<any> {
    const subscription = await this.kube.getOperatorSubscription(subscriptionName, namespace)
    if (!subscription) {
      throw new Error(`Subscription '${subscriptionName}' not found in namespace '${namespace}'`)
    }
    const installedCSV = subscription.status!.installedCSV!
    const csv = await this.kube.getCSV(installedCSV, namespace)

    if (csv && csv.metadata.annotations) {
      const CRRaw = csv.metadata.annotations!['alm-examples']
      return (yaml.load(CRRaw) as Array<any>).find(cr => cr.kind === 'CheCluster')
    } else {
      throw new Error(`Unable to retrieve CheCluster CR ${!csv ? '' : 'from CSV: ' + csv.spec.displayName}`)
    }
  }
}
