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

import {Command, flags} from '@oclif/command'
import {string} from '@oclif/parser/lib/flags'
import {cli} from 'cli-ux'
import * as Listr from 'listr'
import * as semver from 'semver'

import {CheHelper} from '../../api/che'
import {ChectlContext} from '../../api/context'
import {KubeHelper} from '../../api/kube'
import {
  assumeYes,
  batch,
  CHE_OPERATOR_CR_PATCH_YAML_KEY,
  CHE_TELEMETRY,
  cheDeployVersion,
  cheNamespace,
  cheOperatorCRPatchYaml,
  DEPLOY_VERSION_KEY,
  listrRenderer,
  skipKubeHealthzCheck,
} from '../../common-flags'
import {DEFAULT_ANALYTIC_HOOK_NAME, DEFAULT_CHE_OPERATOR_IMAGE_NAME, NEXT_TAG} from '../../constants'
import {getPrintHighlightedMessagesTask} from '../../tasks/installers/common-tasks'
import {InstallerTasks} from '../../tasks/installers/installer'
import {ApiTasks} from '../../tasks/platforms/api'
import {
  askForChectlUpdateIfNeeded,
  findWorkingNamespace,
  getCommandSuccessMessage,
  getProjectName,
  getProjectVersion,
  getWarnVersionFlagMsg,
  notifyCommandCompletedSuccessfully,
  wrapCommandError,
} from '../../util'

export default class Update extends Command {
  static description = 'Update Red Hat OpenShift Dev Spaces server.'

  static examples = [
    '# Update Red Hat OpenShift Dev Spaces:\n' +
    'dsc server:update',
    '\n# Update Red Hat OpenShift Dev Spaces in \'eclipse-che\' namespace:\n' +
    'dsc server:update -n eclipse-che',
    '\n# Update Red Hat OpenShift Dev Spaces and update its configuration in the custom resource:\n' +
    `dsc server:update --${CHE_OPERATOR_CR_PATCH_YAML_KEY} patch.yaml`,
  ]

  static flags: flags.Input<any> = {
    installer: string({
      char: 'a',
      description: 'Installer type. If not set, default is olm for OpenShift >= 4.2, and operator for earlier versions.',
      options: ['olm', 'operator'],
    }),
    chenamespace: cheNamespace,
    batch,
    templates: string({
      char: 't',
      description: 'Path to the templates folder',
      env: 'CHE_TEMPLATES_FOLDER',
      exclusive: [DEPLOY_VERSION_KEY],
    }),
    'che-operator-image': string({
      description: 'Container image of the operator. This parameter is used only when the installer is the operator or OLM.',
      hidden: true,
    }),
    'skip-version-check': flags.boolean({
      description: 'Skip minimal versions check.',
      default: false,
      hidden: true,
    }),
    'listr-renderer': listrRenderer,
    'skip-kubernetes-health-check': skipKubeHealthzCheck,
    yes: assumeYes,
    help: flags.help({ char: 'h' }),
    [CHE_OPERATOR_CR_PATCH_YAML_KEY]: cheOperatorCRPatchYaml,
    telemetry: CHE_TELEMETRY,
    [DEPLOY_VERSION_KEY]: cheDeployVersion,
  }

  async run() {
    const { flags } = this.parse(Update)
    flags.chenamespace = await findWorkingNamespace(flags)
    const ctx = await ChectlContext.initAndGet(flags, this)

    if (!flags.batch && ctx.isChectl) {
      await askForChectlUpdateIfNeeded()
    }

    if (flags.version) {
      cli.info(getWarnVersionFlagMsg(flags))
      this.exit(1)
    }

    await this.setDomainFlag(flags)
    if (!flags.installer) {
      await this.setDefaultInstaller(flags)
      cli.info(`› Installer type is set to: '${flags.installer}'`)
    }

    await this.config.runHook(DEFAULT_ANALYTIC_HOOK_NAME, { command: Update.id, flags })

    const installerTasks = new InstallerTasks()

    // pre update tasks
    const apiTasks = new ApiTasks()
    const preUpdateTasks = new Listr([], ctx.listrOptions)
    preUpdateTasks.add(apiTasks.testApiTasks(flags))
    preUpdateTasks.add(installerTasks.preUpdateTasks(flags, this))

    // update tasks
    const updateTasks = new Listr([], ctx.listrOptions)
    updateTasks.add({
      title: 'Updating...',
      task: () => new Listr(installerTasks.updateTasks(flags, this)),
    })

    // post update tasks
    const postUpdateTasks = new Listr([], ctx.listrOptions)
    postUpdateTasks.add(getPrintHighlightedMessagesTask())

    try {
      await preUpdateTasks.run(ctx)

      if (flags.installer === 'operator') {
        if (!await this.checkAbilityToUpdateCheOperatorAndAskUser(flags)) {
          // Exit
          return
        }
      }
      await updateTasks.run(ctx)
      await postUpdateTasks.run(ctx)

      this.log(getCommandSuccessMessage())
    } catch (err: any) {
      this.error(wrapCommandError(err))
    }

    if (!flags.batch) {
      notifyCommandCompletedSuccessfully()
    }
  }

  /**
   * Check whether dsc should proceed with update.
   * Asks user for confirmation (unless assume yes is provided).
   * Is applicable to operator installer only.
   * Returns true if dsc can/should proceed with update, false otherwise.
   */
  private async checkAbilityToUpdateCheOperatorAndAskUser(flags: any): Promise<boolean> {
    const ctx = ChectlContext.get()
    cli.info(`Existing Red Hat OpenShift Dev Spaces operator: ${ctx.deployedCheOperatorImage}`)
    cli.info(`New Red Hat OpenShift Dev Spaces operator     : ${ctx.newCheOperatorImage}`)

    if (ctx.deployedCheOperatorImageName === DEFAULT_CHE_OPERATOR_IMAGE_NAME && ctx.newCheOperatorImageName === DEFAULT_CHE_OPERATOR_IMAGE_NAME) {
      // Official images

      if (ctx.deployedCheOperatorImage === ctx.newCheOperatorImage) {
        if (ctx.newCheOperatorImageTag === NEXT_TAG) {
          cli.info(`Updating current Red Hat OpenShift Dev Spaces ${NEXT_TAG} version to a new one.`)
          return true
        }

        if (flags[CHE_OPERATOR_CR_PATCH_YAML_KEY]) {
          // Despite the operator image is the same, CR patch might contain some changes.
          cli.info('Patching existing Red Hat OpenShift Dev Spaces installation.')
          return true
        } else {
          cli.info('Red Hat OpenShift Dev Spaces is already up to date.')
          return false
        }
      }

      if (this.isUpgrade(ctx.deployedCheOperatorImageTag, ctx.newCheOperatorImageTag)) {
        // Upgrade

        const currentChectlVersion = getProjectVersion()
        if (!ctx.isDevVersion && (ctx.newCheOperatorImageTag === NEXT_TAG || semver.lt(currentChectlVersion, ctx.newCheOperatorImageTag))) {
          // Upgrade is not allowed
          if (ctx.newCheOperatorImageTag === NEXT_TAG) {
            cli.warn(`Stable ${getProjectName()} cannot update stable Red Hat OpenShift Dev Spaces to ${NEXT_TAG} version`)
          } else {
            cli.warn(`It is not possible to update Red Hat OpenShift Dev Spaces to a newer version using the current '${currentChectlVersion}' version of dsc. Please, update '${getProjectName()}' to a newer version using command '${getProjectName()} update' and then try again.`)
          }
          return false
        }

        // Upgrade allowed
        if (ctx.newCheOperatorImageTag === NEXT_TAG) {
          cli.info(`You are going to update Red Hat OpenShift Dev Spaces ${ctx.deployedCheOperatorImageTag} to ${NEXT_TAG} version.`)
        } else {
          cli.info(`You are going to update Red Hat OpenShift Dev Spaces ${ctx.deployedCheOperatorImageTag} to ${ctx.newCheOperatorImageTag}`)
        }
      } else {
        // Downgrade
        cli.error('Downgrading is not supported.')
      }
    } else {
      // At least one of the images is custom

      // Print message
      if (ctx.deployedCheOperatorImage === ctx.newCheOperatorImage) {
        // Despite the image is the same it could be updated image, replace anyway.
        cli.info(`You are going to replace Red Hat OpenShift Dev Spaces operator image ${ctx.newCheOperatorImage}.`)
      } else if (ctx.deployedCheOperatorImageName !== DEFAULT_CHE_OPERATOR_IMAGE_NAME && ctx.newCheOperatorImageName !== DEFAULT_CHE_OPERATOR_IMAGE_NAME) {
        // Both images are custom
        cli.info(`You are going to update ${ctx.deployedCheOperatorImage} to ${ctx.newCheOperatorImage}`)
      } else {
        // One of the images is offical
        if (ctx.deployedCheOperatorImageName === DEFAULT_CHE_OPERATOR_IMAGE_NAME) {
          // Update from offical to custom image
          cli.info(`You are going to update official ${ctx.deployedCheOperatorImage} image with user provided one: ${ctx.newCheOperatorImage}`)
        } else { // ctx.newCheOperatorImageName === DEFAULT_CHE_OPERATOR_IMAGE_NAME
          // Update from custom to official image
          cli.info(`You are going to update user provided image ${ctx.deployedCheOperatorImage} with official one: ${ctx.newCheOperatorImage}`)
        }
      }
    }

    if (!flags.batch && !flags.yes && !await cli.confirm('If you want to continue - press Y')) {
      cli.info('Update cancelled by user.')
      return false
    }

    return true
  }

  /**
   * Checks if official operator image is replaced with a newer one.
   * Tags are allowed in format x.y.z or NEXT_TAG.
   * NEXT_TAG is considered the most recent.
   * For example:
   *  (7.22.1, 7.23.0) -> true,
   *  (7.22.1, 7.20.2) -> false,
   *  (7.22.1, NEXT_TAG) -> true,
   *  (NEXT_TAG, 7.20.2) -> false
   * @param oldTag old official operator image tag, e.g. 7.20.1
   * @param newTag new official operator image tag e.g. 7.22.0
   * @returns true if upgrade, false if downgrade
   * @throws error if tags are equal
   */
  private isUpgrade(oldTag: string, newTag: string): boolean {
    if (oldTag === newTag) {
      throw new Error(`Tags are the same: ${newTag}`)
    }

    let isUpdate = false
    try {
      isUpdate = semver.gt(newTag, oldTag)
    } catch (error) {
      // not to fail unexpectedly
      cli.debug(`Failed to compare versions '${newTag}' and '${oldTag}': ${error}`)
    }

    // if newTag is NEXT_TAG it is upgrade
    // if oldTag is NEXT_TAG it is downgrade
    // otherwise just compare new and old tags
    // Note, that semver lib doesn't handle text tags and throws an error in case NEXT_TAG is provided for comparation.
    return newTag === NEXT_TAG || (oldTag !== NEXT_TAG && isUpdate)
  }

  /**
   * Copies Ingress domain. It is needed later for updates.
   */
  private async setDomainFlag(flags: any): Promise<void> {
    const kubeHelper = new KubeHelper(flags)
    const cheCluster = await kubeHelper.getCheClusterV1(flags.chenamespace)
    if (cheCluster?.spec?.k8s?.ingressDomain) {
      flags.domain = cheCluster.spec.k8s.ingressDomain
    }
  }

  /**
   * Sets installer type depending on the previous installation.
   */
  private async setDefaultInstaller(flags: any): Promise<void> {
    const cheHelper = new CheHelper(flags)
    if (await cheHelper.findCheOperatorSubscription(flags.chenamespace)) {
      flags.installer = 'olm'
    } else {
      flags.installer = 'operator'
    }
  }
}
