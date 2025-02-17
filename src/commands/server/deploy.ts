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

import { Command, flags } from '@oclif/command'
import { boolean, string } from '@oclif/parser/lib/flags'
import { cli } from 'cli-ux'
import * as Listr from 'listr'
import { CertManagerTasks } from '../../tasks/component-installers/cert-manager'
import { ChectlContext, OIDCContextKeys, OLM } from '../../api/context'
import { KubeHelper } from '../../api/kube'
import { batch, cheDeployVersion, cheNamespace, cheOperatorCRPatchYaml, cheOperatorCRYaml, CHE_OPERATOR_CR_PATCH_YAML_KEY, CHE_OPERATOR_CR_YAML_KEY, CHE_TELEMETRY, DEPLOY_VERSION_KEY, k8sPodDownloadImageTimeout, K8SPODDOWNLOADIMAGETIMEOUT_KEY, k8sPodErrorRecheckTimeout, K8SPODERRORRECHECKTIMEOUT_KEY, k8sPodReadyTimeout, K8SPODREADYTIMEOUT_KEY, k8sPodWaitTimeout, K8SPODWAITTIMEOUT_KEY, listrRenderer, logsDirectory, LOG_DIRECTORY_KEY, skipKubeHealthzCheck as skipK8sHealthCheck } from '../../common-flags'
import { DEFAULT_ANALYTIC_HOOK_NAME, DEFAULT_CHE_NAMESPACE, DEFAULT_OLM_SUGGESTED_NAMESPACE, DOC_LINK_CONFIGURE_API_SERVER } from '../../constants'
import { CheTasks } from '../../tasks/che'
import { DexTasks } from '../../tasks/component-installers/dex'
import { createNamespaceTask, getPrintHighlightedMessagesTask, retrieveCheCaCertificateTask } from '../../tasks/installers/common-tasks'
import { InstallerTasks } from '../../tasks/installers/installer'
import { ApiTasks } from '../../tasks/platforms/api'
import { PlatformTasks } from '../../tasks/platforms/platform'
import { askForChectlUpdateIfNeeded, getCommandSuccessMessage, getWarnVersionFlagMsg, isKubernetesPlatformFamily, isOpenshiftPlatformFamily, notifyCommandCompletedSuccessfully, wrapCommandError } from '../../util'

export default class Deploy extends Command {
  static description = 'Deploy Red Hat OpenShift Dev Spaces server'

  static flags: flags.Input<any> = {
    help: flags.help({ char: 'h' }),
    chenamespace: cheNamespace,
    batch,
    'listr-renderer': listrRenderer,
    cheimage: string({
      char: 'i',
      description: 'Red Hat OpenShift Dev Spaces server container image',
      env: 'CHE_CONTAINER_IMAGE',
    }),
    templates: string({
      char: 't',
      description: 'Path to the templates folder',
      env: 'CHE_TEMPLATES_FOLDER',
      exclusive: [DEPLOY_VERSION_KEY],
    }),
    'devfile-registry-url': string({
      description: 'The URL of the external Devfile registry.',
      env: 'CHE_WORKSPACE_DEVFILE__REGISTRY__URL',
    }),
    'plugin-registry-url': string({
      description: 'The URL of the external plugin registry.',
      env: 'CHE_WORKSPACE_PLUGIN__REGISTRY__URL',
    }),
    cheboottimeout: string({
      char: 'o',
      description: 'Red Hat OpenShift Dev Spaces server bootstrap timeout (in milliseconds)',
      default: '40000',
      required: true,
      env: 'CHE_SERVER_BOOT_TIMEOUT',
    }),
    [K8SPODWAITTIMEOUT_KEY]: k8sPodWaitTimeout,
    [K8SPODREADYTIMEOUT_KEY]: k8sPodReadyTimeout,
    [K8SPODDOWNLOADIMAGETIMEOUT_KEY]: k8sPodDownloadImageTimeout,
    [K8SPODERRORRECHECKTIMEOUT_KEY]: k8sPodErrorRecheckTimeout,
    [LOG_DIRECTORY_KEY]: logsDirectory,
    multiuser: flags.boolean({
      char: 'm',
      description: 'Deprecated. The flag is ignored. Red Hat OpenShift Dev Spaces is always deployed in multi-user mode.',
      default: false,
      hidden: true,
    }),
    'self-signed-cert': flags.boolean({
      description: 'Deprecated. The flag is ignored. Self signed certificates usage is autodetected now.',
      default: false,
      hidden: true,
    }),
    platform: string({
      char: 'p',
      description: 'Type of OpenShift platform. Valid values are \"openshift\", \"crc (for CodeReady Containers)\".',
      options: ['openshift', 'crc'],
      default: 'openshift',
    }),
    installer: string({
      char: 'a',
      description: 'Installer type. If not set, default is olm for OpenShift >= 4.2, and operator for earlier versions.',
      options: ['olm', 'operator'],
    }),
    debug: boolean({
      description: 'Enables the debug mode for Red Hat OpenShift Dev Spaces server. To debug Red Hat OpenShift Dev Spaces server from localhost use \'server:debug\' command.',
      default: false,
    }),
    'che-operator-image': string({
      description: 'Container image of the operator. This parameter is used only when the installer is the operator or OLM.',
    }),
    [CHE_OPERATOR_CR_YAML_KEY]: cheOperatorCRYaml,
    [CHE_OPERATOR_CR_PATCH_YAML_KEY]: cheOperatorCRPatchYaml,
    'workspace-pvc-storage-class-name': string({
      description: 'persistent volume(s) storage class name to use to store Red Hat OpenShift Dev Spaces workspaces data',
      env: 'CHE_INFRA_KUBERNETES_PVC_STORAGE__CLASS__NAME',
      default: '',
    }),
    'postgres-pvc-storage-class-name': string({
      description: 'persistent volume storage class name to use to store Red Hat OpenShift Dev Spaces postgres database',
      default: '',
    }),
    'skip-version-check': flags.boolean({
      description: 'Skip minimal versions check.',
      default: false,
    }),
    'skip-cluster-availability-check': flags.boolean({
      description: 'Skip cluster availability check. The check is a simple request to ensure the cluster is reachable.',
      default: false,
    }),
    'skip-oidc-provider-check': flags.boolean({
      description: 'Skip OIDC Provider check',
      default: false,
    }),
    'auto-update': flags.boolean({
      description: `Auto update approval strategy for installation Red Hat OpenShift Dev Spaces.
                    With this strategy will be provided auto-update Red Hat OpenShift Dev Spaces without any human interaction.
                    By default this flag is enabled.
                    This parameter is used only when the installer is 'olm'.`,
      allowNo: true,
      exclusive: ['starting-csv'],
    }),
    'starting-csv': flags.string({
      description: `Starting cluster service version(CSV) for installation Red Hat OpenShift Dev Spaces.
                    Flags uses to set up start installation version Che.
                    For example: 'starting-csv' provided with value 'eclipse-che.v7.10.0' for stable channel.
                    Then OLM will install Red Hat OpenShift Dev Spaces with version 7.10.0.
                    Notice: this flag will be ignored with 'auto-update' flag. OLM with auto-update mode installs the latest known version.
                    This parameter is used only when the installer is 'olm'.`,
    }),
    'olm-channel': string({
      description: `Olm channel to install Red Hat OpenShift Dev Spaces, f.e. stable.
                    If options was not set, will be used default version for package manifest.
                    This parameter is used only when the installer is the 'olm'.`,
    }),
    'package-manifest-name': string({
      description: `Package manifest name to subscribe to Red Hat OpenShift Dev Spaces OLM package manifest.
                    This parameter is used only when the installer is the 'olm'.`,
    }),
    'catalog-source-yaml': string({
      description: `Path to a yaml file that describes custom catalog source for installation Red Hat OpenShift Dev Spaces operator.
                    Catalog source will be applied to the namespace with Che operator.
                    Also you need define 'olm-channel' name and 'package-manifest-name'.
                    This parameter is used only when the installer is the 'olm'.`,
    }),
    'catalog-source-name': string({
      description: `OLM catalog source to install Red Hat OpenShift Dev Spaces operator.
                    This parameter is used only when the installer is the 'olm'.`,
    }),
    'catalog-source-namespace': string({
      description: `Namespace for OLM catalog source to install Red Hat OpenShift Dev Spaces operator.
                    This parameter is used only when the installer is the 'olm'.`,
    }),
    'cluster-monitoring': boolean({
      default: false,
      hidden: false,
      description: `Enable cluster monitoring to scrape Red Hat OpenShift Dev Spaces metrics in Prometheus.
	                  This parameter is used only when the platform is 'openshift'.`,
    }),
    'olm-suggested-namespace': boolean({
      default: true,
      allowNo: true,
      description: `Indicate to deploy Red Hat OpenShift Dev Spaces in OLM suggested namespace: '${DEFAULT_OLM_SUGGESTED_NAMESPACE}'.
                    Flag 'chenamespace' is ignored in this case
                    This parameter is used only when the installer is 'olm'.`,
    }),
    'skip-kubernetes-health-check': skipK8sHealthCheck,
    telemetry: CHE_TELEMETRY,
    [DEPLOY_VERSION_KEY]: cheDeployVersion,
  }

  async setPlaformDefaults(flags: any, _ctx: any): Promise<void> {
    if (flags['self-signed-cert']) {
      this.warn('"self-signed-cert" flag is deprecated and has no effect. Autodetection is used instead.')
    }

    if (!flags.installer) {
      await setDefaultInstaller(flags)
      cli.info(`› Installer type is set to: '${flags.installer}'`)
    }

    if (flags.installer === 'olm' && flags['olm-suggested-namespace']) {
      flags.chenamespace = DEFAULT_OLM_SUGGESTED_NAMESPACE
      cli.info(` ❕olm-suggested-namespace flag is turned on. Red Hat OpenShift Dev Spaces will be deployed in namespace: ${DEFAULT_OLM_SUGGESTED_NAMESPACE}.`)
    }
  }

  private checkCompatibility(flags: any) {
    if (flags.installer === 'operator' && flags[CHE_OPERATOR_CR_YAML_KEY]) {
      const ignoredFlags = []
      flags['plugin-registry-url'] && ignoredFlags.push('--plugin-registry-url')
      flags['devfile-registry-url'] && ignoredFlags.push('--devfile-registry-url')
      flags['postgres-pvc-storage-class-name'] && ignoredFlags.push('--postgres-pvc-storage-class-name')
      flags['workspace-pvc-storage-class-name'] && ignoredFlags.push('--workspace-pvc-storage-class-name')
      flags.cheimage && ignoredFlags.push('--cheimage')
      flags.debug && ignoredFlags.push('--debug')
      flags.domain && ignoredFlags.push('--domain')

      if (ignoredFlags.length) {
        this.warn(`--${CHE_OPERATOR_CR_YAML_KEY} is used. The following flag(s) will be ignored: ${ignoredFlags.join('\t')}`)
      }
    }

    if (flags.domain && !flags[CHE_OPERATOR_CR_YAML_KEY] && isOpenshiftPlatformFamily(flags.platform)) {
      this.warn('"--domain" flag is ignored for Openshift family infrastructures. It should be done on the cluster level.')
    }

    if (flags.installer === 'olm') {
      // OLM installer only checks
      if (isKubernetesPlatformFamily(flags.platform)) {
        this.error(`🛑 The specified installer ${flags.installer} does not support Kubernentes`)
      }

      if (flags[OLM.CATALOG_SOURCE_NAME] && flags[OLM.CATALOG_SOURCE_YAML]) {
        this.error(`should be provided only one argument: "${OLM.CATALOG_SOURCE_NAME}" or "${OLM.CATALOG_SOURCE_YAML}"`)
      }

      if (!flags[OLM.PACKAGE_MANIFEST_NAME] && flags[OLM.CATALOG_SOURCE_YAML]) {
        this.error(`you need to define "${OLM.PACKAGE_MANIFEST_NAME}" flag to use "${OLM.CATALOG_SOURCE_YAML}".`)
      }
      if (!flags[OLM.CHANNEL] && flags[OLM.CATALOG_SOURCE_YAML]) {
        this.error(`you need to define "${OLM.CHANNEL}" flag to use "${OLM.CATALOG_SOURCE_YAML}".`)
      }
    } else {
      // Not OLM installer
      if (flags[OLM.STARTING_CSV]) {
        this.error(`"${OLM.STARTING_CSV}" flag should be used only with "olm" installer.`)
      }
      if (flags[OLM.CATALOG_SOURCE_YAML]) {
        this.error(`"${OLM.CATALOG_SOURCE_YAML}" flag should be used only with "olm" installer.`)
      }
      if (flags[OLM.CHANNEL]) {
        this.error(`"${OLM.CHANNEL}" flag should be used only with "olm" installer.`)
      }
      if (flags[OLM.PACKAGE_MANIFEST_NAME]) {
        this.error(`"${OLM.PACKAGE_MANIFEST_NAME}" flag should be used only with "olm" installer.`)
      }
      if (flags[OLM.CATALOG_SOURCE_NAME]) {
        this.error(`"${OLM.CATALOG_SOURCE_NAME}" flag should be used only with "olm" installer.`)
      }
      if (flags[OLM.CATALOG_SOURCE_NAMESPACE]) {
        this.error(`"${OLM.CATALOG_SOURCE_NAMESPACE}" flag should be used only with "olm" installer.`)
      }
      if (flags['cluster-monitoring'] && flags.platform !== 'openshift') {
        this.error('"cluster-monitoring" flag should be used only with "olm" installer and "openshift" platform.')
      }
    }
  }

  async run() {
    const { flags } = this.parse(Deploy)
    flags.chenamespace = flags.chenamespace || DEFAULT_CHE_NAMESPACE
    const ctx = await ChectlContext.initAndGet(flags, this)

    if (!flags.batch && ctx.isChectl) {
      await askForChectlUpdateIfNeeded()
    }

    if (flags.version) {
      cli.info(getWarnVersionFlagMsg(flags))
      this.exit(1)
    }

    await this.setPlaformDefaults(flags, ctx)
    await this.config.runHook(DEFAULT_ANALYTIC_HOOK_NAME, { command: Deploy.id, flags })

    const dexTasks = new DexTasks(flags)
    const cheTasks = new CheTasks(flags)
    const platformTasks = new PlatformTasks(flags)
    const installerTasks = new InstallerTasks()
    const apiTasks = new ApiTasks()
    const certManagerTask = new CertManagerTasks(flags)

    // Platform Checks
    const platformCheckTasks = new Listr(platformTasks.preflightCheckTasks(flags, this), ctx.listrOptions)

    // Checks if Red Hat OpenShift Dev Spaces is already deployed
    const preInstallTasks = new Listr(undefined, ctx.listrOptions)
    preInstallTasks.add(apiTasks.testApiTasks(flags))
    preInstallTasks.add({
      title: '👀  Looking for an already existing Red Hat OpenShift Dev Spaces instance',
      task: () => new Listr(cheTasks.getCheckIfCheIsInstalledTasks(flags)),
    })
    preInstallTasks.add(ensureOIDCProviderInstalled(flags))

    const installTasks = new Listr(undefined, ctx.listrOptions)
    if (!ctx[ChectlContext.IS_OPENSHIFT]) {
      installTasks.add(certManagerTask.getDeployCertManagerTasks())
    }
    installTasks.add([createNamespaceTask(flags.chenamespace, this.getNamespaceLabels(flags))])
    if (flags.platform === 'minikube') {
      installTasks.add(dexTasks.getInstallTasks())
    }
    installTasks.add(await installerTasks.installTasks(flags, this))

    // Post Install Checks
    const postInstallTasks = new Listr([
      {
        title: '✅  Post installation checklist',
        task: () => new Listr(cheTasks.getWaitCheDeployedTasks()),
      },
      retrieveCheCaCertificateTask(flags),
      ...cheTasks.getPreparePostInstallationOutputTasks(flags),
      getPrintHighlightedMessagesTask(),
    ], ctx.listrOptions)

    const logsTasks = new Listr([{
      title: 'Following Red Hat OpenShift Dev Spaces logs',
      task: () => new Listr(cheTasks.getServerLogsTasks(flags, true)),
    }], ctx.listrOptions)

    try {
      await preInstallTasks.run(ctx)

      if (ctx.isCheDeployed) {
        let message = 'Red Hat OpenShift Dev Spaces has been already deployed.'
        if (!ctx.isCheReady) {
          message += ' Use server:start command to start a stopped Red Hat OpenShift Dev Spaces instance.'
        }
        cli.warn(message)
      } else {
        this.checkCompatibility(flags)
        await platformCheckTasks.run(ctx)
        await logsTasks.run(ctx)
        await installTasks.run(ctx)
        await postInstallTasks.run(ctx)
        this.log(getCommandSuccessMessage())
      }
    } catch (err: any) {
      this.error(wrapCommandError(err))
    }

    if (!flags.batch) {
      notifyCommandCompletedSuccessfully()
    }
    this.exit(0)
  }

  private getNamespaceLabels(flags: any): any {
    // The label values must be strings
    if (flags['cluster-monitoring'] && flags.platform === 'openshift') {
      return { 'openshift.io/cluster-monitoring': 'true' }
    }
    return {}
  }
}

function ensureOIDCProviderInstalled(flags: any): Listr.ListrTask {
  return {
    title: 'Check if OIDC Provider installed',
    enabled: ctx => !flags['skip-oidc-provider-check'] && isKubernetesPlatformFamily(flags.platform) && !ctx.isCheDeployed,
    skip: () => {
      if (flags.platform === 'minikube') {
        return 'Dex will be automatically installed as OIDC Identity Provider'
      }
    },
    task: async (_ctx: any, task: any) => {
      const kube = new KubeHelper(flags)
      const apiServerPods = await kube.getPodListByLabel('kube-system', 'component=kube-apiserver')
      for (const pod of apiServerPods) {
        if (!pod.spec) {
          continue
        }
        for (const container of pod.spec.containers) {
          if (container.command) {
            if (container.command.some(value => value.includes(OIDCContextKeys.ISSUER_URL)) && container.command.some(value => value.includes(OIDCContextKeys.CLIENT_ID))) {
              task.title = `${task.title}...[OK]`
              return
            }
          }

          if (container.args) {
            if (container.args.some(value => value.includes(OIDCContextKeys.ISSUER_URL)) && container.args.some(value => value.includes(OIDCContextKeys.CLIENT_ID))) {
              task.title = `${task.title}...[OK]`
              return
            }
          }
        }
      }
      task.title = `${task.title}...[Not Found]`
      throw new Error(`API server is not configured with OIDC Identity Provider, see details ${DOC_LINK_CONFIGURE_API_SERVER}. To bypass OIDC Provider check, use \'--skip-oidc-provider-check\' flag`)
    },
  }
}

/**
 * Sets default installer which is `olm` for OpenShift 4 with stable version of dsc
 * and `operator` for other cases.
 */
export async function setDefaultInstaller(flags: any): Promise<void> {
  const kubeHelper = new KubeHelper(flags)

  const isOlmPreinstalled = await kubeHelper.isPreInstalledOLM()
  if ((flags[OLM.CATALOG_SOURCE_NAME] || flags[OLM.CATALOG_SOURCE_YAML]) && isOlmPreinstalled) {
    flags.installer = 'olm'
    return
  }

  const ctx = ChectlContext.get()
  if (flags.platform === 'openshift' && ctx[ChectlContext.IS_OPENSHIFT] && isOlmPreinstalled) {
    flags.installer = 'olm'
  } else {
    flags.installer = 'operator'
  }
}
